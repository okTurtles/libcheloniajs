import { createCID } from './functions.js'

// Shared test helpers. This is a plain module, not a `*.test.ts` file: the
// `test` script never runs it directly, and it registers no SBP selectors,
// so any test file may import it without contaminating registrations.
export const waitMicrotasks = async (): Promise<void> => {
  // The code under test queues work onto okTurtles.eventQueue/queueEvent;
  // await a couple of macrotask boundaries so that it settles.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

// Bound when this module loads, so that the harness's `emulateSleep()` can't
// move it: its `changeClock()` and default `wake()` shift `Date.now()`, and
// with `monotonic: true` it replaces `performance.now` later, when called
const now = performance.now.bind(performance)

// `until` and `within` make a regression fail the test instead of hanging
// the whole file.
export const until = async (
  cond: () => unknown,
  label: string,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = now() + timeoutMs
  while (!cond()) {
    if (now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

export const within = <T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Whether `promise` is still pending once queued work has run
export const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
  let pending = true
  promise.then(() => { pending = false }, () => { pending = false })
  await waitMicrotasks()
  return pending
}

type ConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'

// Captures (and silences, unless TEST_VERBOSE is set) console output
export function captureConsole (
  levels: ConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error']
) {
  const entries: { t: number; level: ConsoleLevel; text: string; args: unknown[] }[] = []
  const originals = levels.map((level) => [level, console[level]] as const)
  const verbose = !!process.env.TEST_VERBOSE
  const format = (arg: unknown) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  for (const [level, original] of originals) {
    console[level] = (...args: unknown[]) => {
      entries.push({ t: Date.now(), level, text: args.map(format).join(' '), args })
      if (verbose) original.apply(console, args)
    }
  }
  return {
    entries,
    grep (pattern: RegExp, since = -Infinity) {
      return entries.filter(({ t, text }) => t >= since && pattern.test(text))
    },
    // The entries logged from now on (unlike `grep(pattern, since)`, this
    // does not depend on `Date.now()`, which `emulateSleep()` shifts)
    fromNow () {
      const start = entries.length
      return {
        grep (pattern: RegExp) {
          return entries.slice(start).filter(({ text }) => pattern.test(text))
        }
      }
    },
    restore () {
      for (const [level, original] of originals) console[level] = original
    }
  }
}

export type KvServerRequest = {
  method: 'GET' | 'POST';
  key: string;
  status: number;
  ifMatch?: string | null;
  height?: unknown;
}

export type FetchInit = Parameters<typeof fetch>[1]

// One contract's KV store: a POST needs `if-match` (400), matching the stored
// value (412), stamped with the server's height (409). Etag = quoted body CID.
export const makeKvServer = (contractID: string, { height = 0 } = {}) => {
  const store = new Map<string, { body: string; etag: string }>()
  const prefix = `/kv/${encodeURIComponent(contractID)}/`
  const respond = (status: number, body: string | null, etag: string) =>
    new Response(body, { status, headers: { etag, 'x-cid': etag } })
  const server = {
    height,
    store,
    log: [] as KvServerRequest[],
    // Runs when a POST arrives, before it's checked (e.g. another device wins the race)
    onPost: undefined as ((key: string) => unknown) | undefined,
    // Runs when a GET arrives, before it's answered
    onGet: undefined as ((key: string) => unknown) | undefined,
    etagOf: (key: string) => store.get(key)?.etag ?? '""',
    // Stores `body` as is, bypassing every check
    put (key: string, body: unknown): string {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      const etag = `"${createCID(text)}"`
      store.set(key, { body: text, etag })
      return etag
    },
    posts: () => server.log.filter(({ method }) => method === 'POST'),
    // Answers a request for this contract's KV store, `undefined` for any other URL
    async handle (url: string, init?: FetchInit): Promise<Response | undefined> {
      const { pathname } = new URL(url)
      if (!pathname.startsWith(prefix)) return undefined
      const key = decodeURIComponent(pathname.slice(prefix.length))
      if (init?.method !== 'POST') {
        await server.onGet?.(key)
        const stored = store.get(key)
        server.log.push({ method: 'GET', key, status: stored ? 200 : 404 })
        return stored ? respond(200, stored.body, stored.etag) : new Response(null, { status: 404 })
      }
      const body = String(init.body)
      const ifMatch = new Headers(init.headers).get('if-match')
      let stamp: unknown
      try { stamp = JSON.parse(body).height } catch {}
      const request: KvServerRequest = { method: 'POST', key, status: 0, ifMatch, height: stamp }
      server.log.push(request)
      await server.onPost?.(key)
      const stored = store.get(key)
      const current = server.etagOf(key)
      const reject = (status: number) => {
        request.status = status
        return respond(status, status === 400 ? null : stored?.body ?? '', current)
      }
      if (!ifMatch) return reject(400)
      const accepted = ifMatch.split(',').map((tag) => tag.trim())
      if (!accepted.includes('*') && !accepted.includes(current)) return reject(412)
      if (Number(stamp) !== server.height) return reject(409)
      request.status = 204
      return respond(204, null, server.put(key, body))
    }
  }
  return server
}

export type KvServer = ReturnType<typeof makeKvServer>
