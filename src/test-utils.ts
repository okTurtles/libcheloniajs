// Shared test helpers. This is a plain module, not a `*.test.ts` file: the
// `test` script never runs it directly, and it registers no SBP selectors,
// so any test file may import it without contaminating registrations.
import sbp from '@sbp/sbp'
import { createCID, multicodes } from './functions.js'

export const waitMicrotasks = async (): Promise<void> => {
  // The code under test queues work onto okTurtles.eventQueue/queueEvent;
  // await a couple of macrotask boundaries so that it settles.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

type ContractMeta = { height?: number; HEAD?: string }
const contractMeta = (contractID: string): ContractMeta | undefined =>
  (sbp('chelonia/private/state') as { contracts?: Record<string, ContractMeta> })
    .contracts?.[contractID]

// Runs `fn` with the local height of `contractID` temporarily set to
// `height` (restored once `fn`, or the promise it returns, settles). Used to
// sign a value as another device at another height would, or to decode one
// regardless of the local height.
export const withLocalHeight = <T>(contractID: string, height: number, fn: () => T): T => {
  const meta = contractMeta(contractID)
  if (!meta) throw new Error(`withLocalHeight: no contract ${contractID}`)
  const saved = meta.height
  meta.height = height
  let result: T
  try {
    result = fn()
  } catch (e) {
    meta.height = saved
    throw e
  }
  if (result instanceof Promise) {
    return result.finally(() => { meta.height = saved }) as T
  }
  meta.height = saved
  return result
}

// Moves the local contract to `height` and wakes up height waits, as
// processing contract events does. A no-op when the contract is gone.
export const setLocalHeight = (contractID: string, height: number): void => {
  const meta = contractMeta(contractID)
  if (!meta) return
  meta.height = height
  sbp('chelonia/kv/_testNotifyHeight', contractID)
}

// `setLocalHeight` after `ms`, unless the test that scheduled it has ended
// by then (`chelonia/_init` replaces the root state object). Tests usually
// share contract IDs, so a stray timer would otherwise move the next test's
// contract.
export const setLocalHeightLater = (contractID: string, height: number, ms: number): void => {
  const state = sbp('chelonia/private/state')
  setTimeout(() => {
    if (sbp('chelonia/private/state') === state) setLocalHeight(contractID, height)
  }, ms)
}

// `chelonia/kv/whenSettled` that fails after `ms`, instead of hanging the
// test file, if the slot never settles.
//
// The deadline is a plain (ref'd) timer rather than `AbortSignal.timeout`,
// whose timer doesn't keep the event loop alive: neither do the library's
// deferred-load fallback timers (deliberately unref'd), so a test waiting
// only on those would leave the loop empty, and Node 22's test runner then
// cancels the test ("Promise resolution is still pending but the event
// loop has already resolved").
export const whenSettledWithin = (contractID: string, key: string, ms = 3000): Promise<string> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(
      `${contractID}::${key} did not settle within ${ms} ms`, 'TimeoutError'
    ))
  }, ms)
  return (sbp('chelonia/kv/whenSettled', contractID, key, {
    signal: controller.signal
  }) as Promise<string>).finally(() => clearTimeout(timer))
}

export type KvFetchOptions = {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  body?: string;
  signal?: AbortSignal;
}

export type KvLogEntry = {
  method: string;
  key: string;
  status: number;
  ifMatch?: string | null;
  height?: string;
}

// A simulated chel server, KV routes only (`handleKv`), with the same
// checks, in the same order, as chel's `/kv/:contractID/:key`: a `POST`
// without `if-match` is a 400; then `if-match` is checked against the stored
// value's CID (412 with the stored value as the body, empty when there is
// none); then the height stamp must equal the server's contract height (409,
// again with the stored value); then the value is stored and a 204 carries
// the quoted CID as ETag. A `GET` returns the stored value (404 without).
export const makeKvServer = (initialHeight = 0) => {
  const store = new Map<string, { body: string; cid: string }>()
  const log: KvLogEntry[] = []
  const quote = (cid: string) => `"${cid}"`
  const server = {
    height: initialHeight,
    store,
    log,
    // Called before the stored value is read, so a hook that writes to
    // `store` models another device's write that won the race.
    onPost: null as ((n: number) => void) | null,
    // While set, GETs wait for it before answering.
    holdGet: null as Promise<void> | null,
    posts: () => log.filter((e) => e.method === 'POST'),
    gets: () => log.filter((e) => e.method === 'GET'),
    etagOf: (key: string) => quote(store.get(key)?.cid ?? ''),
    // Answers a KV route, or resolves `undefined` for any other path.
    handleKv: async (
      pathname: string,
      opts: KvFetchOptions = {}
    ): Promise<Response | undefined> => {
      const m = /^\/kv\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (!m) return undefined
      opts.signal?.throwIfAborted()
      const key = decodeURIComponent(m[2])
      const method = opts.method ?? 'GET'
      if (method === 'GET') {
        const existing = store.get(key)
        if (server.holdGet) await server.holdGet
        const status = existing ? 200 : 404
        log.push({ method, key, status })
        return existing
          ? new Response(existing.body, {
            status, headers: { ETag: quote(existing.cid), 'x-cid': quote(existing.cid) }
          })
          : new Response(null, { status })
      }
      const ifMatch = new Headers(opts.headers).get('if-match')
      const postHeight = JSON.parse(opts.body!).height as string
      const entry: KvLogEntry = { method, key, status: 0, ifMatch, height: postHeight }
      log.push(entry)
      server.onPost?.(server.posts().length)
      const existing = store.get(key)
      const etag = quote(existing ? existing.cid : '')
      if (!ifMatch) {
        entry.status = 400
        return new Response('', { status: 400 })
      }
      if (ifMatch !== '*' && !ifMatch.split(',').map((v) => v.trim()).includes(etag)) {
        entry.status = 412
        return new Response(existing?.body ?? '', {
          status: 412, headers: { ETag: etag, 'x-cid': etag }
        })
      }
      if (server.height !== Number(postHeight)) {
        entry.status = 409
        return new Response(existing?.body ?? '', {
          status: 409, headers: { ETag: etag, 'x-cid': etag }
        })
      }
      const cid = createCID(opts.body!, multicodes.RAW)
      store.set(key, { body: opts.body!, cid })
      entry.status = 204
      return new Response(null, { status: 204, headers: { ETag: quote(cid), 'x-cid': quote(cid) } })
    }
  }
  return server
}
