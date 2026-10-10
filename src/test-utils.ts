// Shared test helpers. This is a plain module, not a `*.test.ts` file: the
// `test` script never runs it directly, and it registers no SBP selectors,
// so any test file may import it without contaminating registrations.
import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach } from 'node:test'
import { createCID, multicodes } from './functions.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'

export const waitMicrotasks = async (): Promise<void> => {
  // The code under test queues work onto okTurtles.eventQueue/queueEvent;
  // await a couple of macrotask boundaries so that it settles.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

// Polls `cond` every 5 ms until it holds. Fails with `label` after `ms`
// instead of looping forever when a regression means it never holds.
export const until = async (cond: () => boolean, label: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`${label} (within ${ms} ms)`)
    await sleep(5)
  }
}

// Settles like `promise`, or rejects with `label` after `ms`, so that a
// regression that leaves it pending fails the test instead of hanging it.
export const within = <T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} (within ${ms} ms)`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Settles like `promise` if it settles within `ms`, and otherwise resolves
// with `pending`: for tests that check whether a promise is still pending.
// Unlike a race against `sleep`, it leaves no timer behind.
export const settledOr = <T, P>(promise: Promise<T>, ms: number, pending: P): Promise<T | P> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<P>((resolve) => {
    timer = setTimeout(() => resolve(pending), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Silences the console for a test, recording the arguments of each
// `console.warn`, `console.error` and `console.debug` call (`info` and `log`
// are dropped). `restore` puts the original functions back.
export const captureConsole = () => {
  const { warn, error, debug, info, log } = console
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const debugs: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  console.error = (...args: unknown[]) => { errors.push(args) }
  console.debug = (...args: unknown[]) => { debugs.push(args) }
  console.info = () => {}
  console.log = () => {}
  const restore = (): void => {
    Object.assign(console, { warn, error, debug, info, log })
  }
  return { warnings, errors, debugs, restore }
}

// Whether one of the recorded console calls (`captureConsole`) has a first
// argument containing `text`.
export const logged = (calls: unknown[][], text: string): boolean =>
  calls.some((args) => String(args[0]).includes(text))

// ---------------------------------------------------------------------------
// Contract fixtures
// ---------------------------------------------------------------------------

// A key entry of an `OP_CONTRACT`. `'*'` permissions also allow every
// action.
export const contractKey = (
  key: ReturnType<typeof keygen>,
  name: string,
  purpose: string[],
  permissions: '*' | string[]
) => ({
  id: keyId(key),
  name,
  purpose,
  ringLevel: 0,
  permissions,
  ...(permissions === '*' && { allowedActions: '*' }),
  data: serializeKey(key, false)
}) as SPKey

// The first message of a new contract of type `type`: a self-signed
// `OP_CONTRACT` with a `#csk` (signing, all permissions) and a `#sak` (a
// server accounting key, which may not have permissions). Returns the keys,
// to sign later messages and to fill `rootState.secretKeys`.
export const makeSelfSignedContract = (
  { type, manifest = 'test-manifest' }: { type: string; manifest?: string }
) => {
  const csk = keygen(EDWARDS25519SHA512BATCH)
  const sak = keygen(EDWARDS25519SHA512BATCH)
  const payload: SPOpContract = {
    type,
    keys: [contractKey(csk, '#csk', ['sig'], '*'), contractKey(sak, '#sak', ['sak'], [])]
  }
  const message = SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(csk, payload)],
    manifest
  })
  return { message, csk, sak }
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

const originalRandom = Math.random

// `kv/set` backs off randomIntFromRange(0, 1500) ms between 412 retries;
// with this stub the backoff is 0 ms. Undone by `restoreKvTestStubs`.
export const stubKvBackoff = (): void => {
  Math.random = () => 0
}

// Undoes `stubKvBackoff` (and any other `Math.random` stub) and resets the
// height timings to the production defaults.
export const restoreKvTestStubs = (): void => {
  Math.random = originalRandom
  sbp('chelonia/kv/_testSetHeightTimings')
}

// Registers the `beforeEach` / `afterEach` pair of a `describe` that calls
// `chelonia/kv/set` directly: a fresh `chelonia/_init` before each test, and
// one after it so that a stubbed `fetch` doesn't leak past the suite (`_init`
// rebuilds the default config).
export const useKvSetHooks = (): void => {
  beforeEach(() => {
    sbp('chelonia/_init')
    stubKvBackoff()
  })
  afterEach(() => {
    restoreKvTestStubs()
    sbp('chelonia/_init')
  })
}

type ContractMeta = { height?: number; HEAD?: string }
const contractMeta = (contractID: string): ContractMeta | undefined =>
  (sbp('chelonia/private/state') as { contracts?: Record<string, ContractMeta> })
    .contracts?.[contractID]

// Runs `fn` with the local height of `contractID` temporarily set to
// `height` (restored once `fn`, or the promise it returns, settles). Used to
// sign a value as another device at another height would, or to decode one
// regardless of the local height.
//
// The height is only restored if it is still `height`: when the contract
// moved on meanwhile (e.g. it processed events while `fn` was awaiting),
// restoring would move it back.
export const withLocalHeight = <T>(contractID: string, height: number, fn: () => T): T => {
  const meta = contractMeta(contractID)
  if (!meta) throw new Error(`withLocalHeight: no contract ${contractID}`)
  const saved = meta.height
  meta.height = height
  const restore = () => {
    if (meta.height === height) meta.height = saved
  }
  let result: T
  try {
    result = fn()
  } catch (e) {
    restore()
    throw e
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T
  }
  restore()
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
  contractID?: string;
  key: string;
  status: number;
  ifMatch?: string | null;
  height?: string;
}

type KvStored = { body: string; cid: string }

// Resolves with `held`, or rejects with the signal's reason if `signal` is
// aborted first (as `fetch` does).
const unlessAborted = (held: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (!signal) return held
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    held.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

// A simulated chel server, KV routes only (`handleKv`), with the same
// checks, in the same order, as chel's `/kv/:contractID/:key`: a `POST`
// without `if-match` is a 400; then `if-match` is checked against the stored
// value's CID (412 with the stored value as the body, empty when there is
// none); then the height stamp must equal the server's contract height (409,
// again with the stored value); then the value is stored and a 204 carries
// the quoted CID as ETag. A `GET` returns the stored value (404 without).
//
// Like chel, it keeps keys and heights per contract when `contractID` is
// given: `store`, `height` and `etagOf` address that contract, and
// `storeOf` / `heightOf` / `setHeight` any other one (which starts empty, at
// `initialHeight`). Without `contractID`, every contract shares one key space
// and one height, for tests that create their contract after the server.
export const makeKvServer = (initialHeight = 0, contractID?: string) => {
  const SHARED = '*'
  const scope = (id: string) => contractID === undefined ? SHARED : id
  const stores = new Map<string, Map<string, KvStored>>()
  const heights = new Map<string, number>()
  const storeOf = (id: string): Map<string, KvStored> => {
    let kvStore = stores.get(scope(id))
    if (!kvStore) {
      kvStore = new Map()
      stores.set(scope(id), kvStore)
    }
    return kvStore
  }
  const heightOf = (id: string): number => heights.get(scope(id)) ?? initialHeight
  const setHeight = (id: string, height: number): void => { heights.set(scope(id), height) }
  const primary = contractID ?? SHARED
  const store = storeOf(primary)
  const log: KvLogEntry[] = []
  const quote = (cid: string) => `"${cid}"`
  const server = {
    get height (): number { return heightOf(primary) },
    set height (height: number) { setHeight(primary, height) },
    store,
    storeOf,
    heightOf,
    setHeight,
    log,
    // Called before the stored value is read, so a hook that writes to
    // `store` models another device's write that won the race.
    onPost: null as ((n: number) => void) | null,
    // While set, GETs wait for it before answering, with the value stored
    // when the request arrived. An abort meanwhile rejects the GET.
    holdGet: null as Promise<void> | null,
    posts: () => log.filter((e) => e.method === 'POST'),
    gets: () => log.filter((e) => e.method === 'GET'),
    etagOf: (key: string, id: string = primary) => quote(storeOf(id).get(key)?.cid ?? ''),
    // Answers a KV route, or resolves `undefined` for any other path.
    handleKv: async (
      pathname: string,
      opts: KvFetchOptions = {}
    ): Promise<Response | undefined> => {
      const m = /^\/kv\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (!m) return undefined
      opts.signal?.throwIfAborted()
      const id = decodeURIComponent(m[1])
      const key = decodeURIComponent(m[2])
      const kvStore = storeOf(id)
      const method = opts.method ?? 'GET'
      if (method === 'GET') {
        const existing = kvStore.get(key)
        if (server.holdGet) await unlessAborted(server.holdGet, opts.signal)
        const status = existing ? 200 : 404
        log.push({ method, contractID: id, key, status })
        return existing
          ? new Response(existing.body, {
            status, headers: { ETag: quote(existing.cid), 'x-cid': quote(existing.cid) }
          })
          : new Response(null, { status })
      }
      const ifMatch = new Headers(opts.headers).get('if-match')
      const postHeight = JSON.parse(opts.body!).height as string
      const entry: KvLogEntry = {
        method, contractID: id, key, status: 0, ifMatch, height: postHeight
      }
      log.push(entry)
      server.onPost?.(server.posts().length)
      const existing = kvStore.get(key)
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
      if (heightOf(id) !== Number(postHeight)) {
        entry.status = 409
        return new Response(existing?.body ?? '', {
          status: 409, headers: { ETag: etag, 'x-cid': etag }
        })
      }
      const cid = createCID(opts.body!, multicodes.RAW)
      kvStore.set(key, { body: opts.body!, cid })
      entry.status = 204
      return new Response(null, { status: 204, headers: { ETag: quote(cid), 'x-cid': quote(cid) } })
    }
  }
  return server
}
