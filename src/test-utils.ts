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

// `until` and `within` make a regression fail the test instead of hanging
// the whole file.
export const until = async (
  cond: () => unknown,
  label: string,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
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

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error'

export const captureConsole = (
  methods: ConsoleMethod[] = ['debug', 'info', 'log', 'warn', 'error']
) => {
  const logged: { method: ConsoleMethod; args: unknown[] }[] = []
  const originals = methods.map((method) => [method, console[method]] as const)
  for (const method of methods) {
    console[method] = (...args: unknown[]) => { logged.push({ method, args }) }
  }
  return {
    logged,
    restore: () => { for (const [method, fn] of originals) console[method] = fn }
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

// One contract's KV store as the server keeps it. A POST needs `if-match`
// (400) matching the stored value (412) and a stamp equal to the server's
// contract height (409). Etags are the quoted CID of the stored body.
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
