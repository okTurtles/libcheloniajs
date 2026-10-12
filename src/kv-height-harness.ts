// Shared harness for the height-aware KV tests (`kv-height.test.ts`,
// `kv-height-pubsub.test.ts`). A plain module, not a `*.test.ts` file: it
// registers no SBP selectors. Import `./chelonia.js` (which registers the
// selectors under test) before calling `installKvHeightHooks()`, once at the
// top level of a test file.
//
// The tests run the real `chelonia/kv/*` selectors, slot loader and pubsub
// KV dispatch against a simulated chel server (`makeKvServer`, plus the
// contract-sync routes below).
//
// "Device B" is a second device of the same user: it signs with the same
// keys while the local contract height is temporarily set to B's height.
// The local contract "processes events" by bumping its height on the
// internal queue lane; a forced contract sync catches it up to the server
// when `server.catchUpOnSync` is set.

import { CURVE25519XSALSA20POLY1305, EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach } from 'node:test'

import { CHELONIA_KV_STATUS_CHANGED } from './events.js'
import { KV_NOOP } from './kv-constants.js'
import {
  captureConsole,
  logged,
  makeKvServer,
  restoreKvTestStubs,
  setContractHeight,
  sleep,
  stubKvBackoff,
  until,
  whenContractSlotSettledWithin,
  withLocalHeight,
  within,
  type KvFetchOptions
} from './test-utils.js'
import type { ChelRootState, CheloniaConfig, JSONType, KvMirrorEntry } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export { sleep, until, within }

export const CONTRACT_ID = 'zKvHeightTestIdentityContract'
export const CTYPE = 'test-identity'
export const UNREAD = 'unreadMessages'
export const NS_CACHE = 'namespace-cache'

// Height timings for every test (see `chelonia/kv/_testSetHeightTimings`,
// which merges the fields it is given into the current timings).
export const TEST_TIMINGS = { waitMs: 50, pendingFallbackMs: 300, recoveryTimeoutMs: 2000 }

export const rootState = (): ChelRootState & Record<string, any> => sbp('chelonia/private/state')

// ---------------------------------------------------------------------------
// Simulated chel server
// ---------------------------------------------------------------------------

type RequestEntry = { path: string; method: string; at: number }

const makeServer = (initialHeight: number) => {
  const kv = makeKvServer(initialHeight, CONTRACT_ID)
  const server = Object.assign(kv, {
    // Every request, including contract syncs (`/latestHEADinfo`,
    // `/eventsAfter`), with the time it was made.
    requests: [] as RequestEntry[],
    // When set, a forced contract sync brings the local contract up to the
    // server height (as processing the missing events would).
    catchUpOnSync: false,
    syncs: 0,
    // Called with the sync request's abort signal.
    onSync: null as ((signal?: AbortSignal) => Promise<void> | void) | null,
    // Test oracle: what a fully-synced device reads from the server.
    value: (key: string): any => {
      const stored = kv.store.get(key)
      if (!stored) return undefined
      const serializedData = JSON.parse(stored.body)
      const height = Math.max(localHeight(), Number(serializedData.height))
      return withLocalHeight(CONTRACT_ID, height, () =>
        sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
          contractID: CONTRACT_ID, serializedData, meta: key
        }).data
      )
    },
    fetch: async (url: string, opts: KvFetchOptions = {}): Promise<Response> => {
      const { pathname } = new URL(url)
      server.requests.push({ path: pathname, method: opts.method ?? 'GET', at: Date.now() })
      opts.signal?.throwIfAborted()
      if (pathname.startsWith('/latestHEADinfo/')) {
        server.syncs++
        await server.onSync?.(opts.signal)
        opts.signal?.throwIfAborted()
        if (server.catchUpOnSync) setLocalHeight(server.height)
        // After `chelonia/reset` the contract has no local state.
        const c = rootState().contracts?.[CONTRACT_ID] ??
          { HEAD: `h${server.height}`, height: server.height }
        return new Response(JSON.stringify({ HEAD: c.HEAD, height: c.height }), { status: 200 })
      }
      // Clock sync, started by `chelonia/connect`.
      if (pathname === '/time') return new Response(String(Date.now()), { status: 200 })
      return await server.handleKv(pathname, opts) ?? new Response('', { status: 404 })
    }
  })
  return server
}

// ---------------------------------------------------------------------------
// Contract / device helpers
// ---------------------------------------------------------------------------

// Reassigned for every test by the hooks; ES module bindings are live.
export let server: ReturnType<typeof makeServer>
export let cskId: string
export let cekId: string
export let warnings: unknown[][]
export let errors: unknown[][]
export let debugs: unknown[][]
const offs: Array<() => void> = []
let restoreConsole: () => void = () => {}

export const setupContract = (height: number) => {
  const csk = keygen(EDWARDS25519SHA512BATCH)
  const cek = keygen(CURVE25519XSALSA20POLY1305)
  const sak = keygen(EDWARDS25519SHA512BATCH)
  cskId = keyId(csk)
  cekId = keyId(cek)
  const sakId = keyId(sak)
  const rs = rootState()
  rs.contracts[CONTRACT_ID] = { HEAD: `h${height}`, height, previousKeyOp: '', type: CTYPE } as any
  const k = (id: string, name: string, purpose: string[], key: any) => ({
    id, name, purpose, ringLevel: 0, permissions: '*', data: serializeKey(key, false), _notBeforeHeight: 0
  })
  rs[CONTRACT_ID] = {
    _vm: {
      type: CTYPE,
      authorizedKeys: {
        [cskId]: k(cskId, 'csk', ['sig'], csk),
        [cekId]: k(cekId, 'cek', ['enc'], cek),
        [sakId]: k(sakId, '#sak', ['sak'], sak)
      }
    }
  }
  rs.secretKeys = {
    [cskId]: serializeKey(csk, true),
    [cekId]: serializeKey(cek, true),
    [sakId]: serializeKey(sak, true)
  }
}

export const localHeight = (): number => rootState().contracts[CONTRACT_ID].height

// KV GETs requested so far. Unlike `server.gets()`, which logs a GET when it
// is answered, this counts a GET held by `holdGets` too.
export const kvGetsRequested = (): number => server.requests.filter((r) =>
  r.method === 'GET' && r.path.startsWith('/kv/')
).length

export function setLocalHeight (to: number) {
  const c = rootState().contracts[CONTRACT_ID]
  if (!c) return
  c.HEAD = `h${to}`
  setContractHeight(CONTRACT_ID, to)
}

// Contract events are processed on the internal `<contractID>` lane.
export const advanceLocalHeightOnInternalLane = (to: number) =>
  sbp('chelonia/private/queueEvent', CONTRACT_ID, () => setLocalHeight(to))

// A second device of the same user writes `value` at contract height
// `atHeight` (which becomes the server's contract height).
export const writeAsDeviceB = async (key: string, value: JSONType, atHeight: number) => {
  server.height = atHeight
  await withLocalHeight(CONTRACT_ID, atHeight, () =>
    sbp('chelonia/kv/set', CONTRACT_ID, key, value, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
    })
  )
  return server.store.get(key)!
}

// The value stored for `key`, with its height stamp replaced by `stamp`
// (the rest, signature included, unchanged).
export const restampedBody = (key: string, stamp: string): string =>
  JSON.stringify({ ...JSON.parse(server.store.get(key)!.body), height: stamp })

// Replaces the stored value's height stamp (see `restampedBody`), and
// returns the new body.
export const restamp = (key: string, stamp: string): string =>
  server.put(key, restampedBody(key, stamp)).body

// Wait for the internal lane and then the public lane to drain.
export const drainLanes = async () => {
  for (let i = 0; i < 3; i++) {
    await sbp('chelonia/queueInvocation', CONTRACT_ID, () => {})
    await sleep(5)
  }
}

// Makes the next `n` KV GETs answer `status` (default 500), only counting
// those made while `when()` holds. Returns a function that restores the
// server's handler.
export const failKvGets = (n: number, status = 500, when: () => boolean = () => true) => {
  const real = server.handleKv
  let left = n
  server.handleKv = async (pathname: string, opts: KvFetchOptions = {}) => {
    if ((opts.method ?? 'GET') === 'GET' && pathname.startsWith('/kv/') && left > 0 && when()) {
      left--
      const [contractID, key] = pathname.split('/').slice(2).map(decodeURIComponent)
      server.log.push({ method: 'GET', contractID, key, status })
      return new Response('', { status })
    }
    return real(pathname, opts)
  }
  return () => { server.handleKv = real }
}

// Holds the next contract sync (`/latestHEADinfo`) until `release` is
// called. `started` resolves once that sync has begun, and rejects if none
// begins within `ms`. Later syncs aren't held. `release` before the sync
// starts cancels the hold and rejects `started`; a hold the test leaves is
// released after it, so it can't block the contract's lane for the next
// tests. Like a real request, the held sync rejects with the abort reason
// as soon as its request's signal (the session's, which `chelonia/reset`
// aborts) or `signal` aborts. `fail(error)` ends the held sync with
// `error` instead of letting it succeed.
export const holdNextSync = (ms = 3000, { signal }: { signal?: AbortSignal } = {}) => {
  let resolveSync: (() => void) | undefined
  let rejectSync: ((e: Error) => void) | undefined
  let signalStarted!: () => void
  let rejectStarted!: (e: Error) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = new Promise<void>((resolve, reject) => {
    signalStarted = resolve
    rejectStarted = reject
    timer = setTimeout(() => reject(new Error(`no contract sync started within ${ms} ms`)), ms)
  })
  // Only a test that awaits `started` sees its rejection.
  started.catch(() => {})
  const hold = (requestSignal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    server.onSync = null
    clearTimeout(timer)
    const signals = [requestSignal, signal].filter((s): s is AbortSignal => !!s)
    const onAbort = function (this: AbortSignal) {
      unlisten()
      reject(this.reason)
    }
    const unlisten = () => {
      for (const s of signals) s.removeEventListener('abort', onAbort)
    }
    resolveSync = () => {
      unlisten()
      resolve()
    }
    rejectSync = (e: Error) => {
      unlisten()
      reject(e)
    }
    signalStarted()
    const aborted = signals.find((s) => s.aborted)
    if (aborted) {
      reject(aborted.reason)
      return
    }
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true })
  })
  server.onSync = hold
  const release = () => {
    clearTimeout(timer)
    if (server.onSync === hold) server.onSync = null
    if (resolveSync) resolveSync()
    else rejectStarted(new Error('holdNextSync released before any sync started'))
  }
  const fail = (error: Error) => {
    clearTimeout(timer)
    if (server.onSync === hold) server.onSync = null
    if (rejectSync) rejectSync(error)
    else rejectStarted(new Error('holdNextSync failed before any sync started'))
  }
  offs.push(release)
  return { started, release, fail }
}

// Runs `fn` after the test, with the harness's own cleanup (also when the
// test or the index check fails).
export const addTeardown = (fn: () => void): void => {
  offs.push(fn)
}

// Holds the contract's public lane (`chelonia/queueInvocation`) until
// `open` is called; `released` settles once the holding task has run, so
// only after `open`. Opened after the test if the test doesn't.
export const gateLane = () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const released = sbp('chelonia/queueInvocation', CONTRACT_ID, () => gate) as Promise<void>
  offs.push(open)
  return { open, released }
}

// The number of tasks queued on the contract's public lane
// (`chelonia/queueInvocation`), the running one included.
export const publicLaneQueued = (): number =>
  (sbp('okTurtles.eventQueue/queuedInvocations', `public:${CONTRACT_ID}`) as unknown[]).length

// Makes KV GETs wait (answering with the value stored when they arrived)
// until `release` is called. Released after the test if the test doesn't.
export const holdGets = () => {
  let resolveHold!: () => void
  server.holdGet = new Promise<void>((resolve) => { resolveHold = resolve })
  const release = () => {
    server.holdGet = null
    resolveHold()
  }
  offs.push(release)
  return { release }
}

// `setTimeout` that is cleared after the test, so that a timer the test no
// longer waits for (it failed, or returned early) can't fire into the next.
export const later = (fn: () => void, ms: number): void => {
  const timer = setTimeout(fn, ms)
  offs.push(() => clearTimeout(timer))
}

// Resolves once a `console.warn` containing `text` was logged.
export const untilWarned = (text: string, ms = 3000) => until(
  () => logged(warnings, text),
  `no warning containing "${text}"`,
  ms
)

// From now on, each contract sync records whether the contract's public
// lane (`chelonia/queueInvocation`) is free (`'free'`) or held (`'busy'`)
// while it runs: a recovery must never sync with the lane held, or a
// caller that holds it waits for itself.
export const probePublicLaneOnSync = (): string[] => {
  const laneState: string[] = []
  server.onSync = async () => {
    laneState.push(await Promise.race([
      sbp('chelonia/private/queueEvent', `public:${CONTRACT_ID}`, () => 'free'),
      sleep(300).then(() => 'busy')
    ]))
  }
  return laneState
}

// `chelonia/private/in/sync` adds an up-to-date contract to the subscription
// set. The CONTRACTS_MODIFIED listener that reconciles slots is only wired
// by `chelonia/connect` (and then outlives `chelonia/_init`), which only
// `kv-height-pubsub.test.ts` calls, so reconcile explicitly (a repeated
// reconcile is a no-op).
export const subscribeContract = async () => {
  await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
  sbp('chelonia/kv/_onContractsModified', { added: [CONTRACT_ID], removed: [] })
}

export const activateContract = async () => {
  await subscribeContract()
  await drainLanes()
}

export const defineSlot = (def: Record<string, unknown>) =>
  sbp('chelonia/kv/defineSlot', { contractType: CTYPE, defaultValue: {}, ...def })

export const slotStatus = (key: string) => sbp('chelonia/kv/status', CONTRACT_ID, key)
export const whenSettledWithin = (key: string, ms = 3000) =>
  whenContractSlotSettledWithin(CONTRACT_ID, key, ms)
export const mirror = (key: string): KvMirrorEntry & Record<string, any> =>
  rootState()._kv?.[CONTRACT_ID]?.[key] as KvMirrorEntry

// `okTurtles.events/on` whose listener is also removed after the test, even
// when the test fails before calling the returned `off`.
export const onEvent = (event: string, handler: (payload: any) => void): (() => void) => {
  const remove = sbp('okTurtles.events/on', event, handler) as () => void
  let removed = false
  const off = () => {
    if (removed) return
    removed = true
    remove()
  }
  offs.push(off)
  return off
}

export const collectStatusEvents = (key: string) => {
  const events: any[] = []
  const off = onEvent(CHELONIA_KV_STATUS_CHANGED, (p: any) => {
    if (p.contractID === CONTRACT_ID && p.key === key) events.push(p)
  })
  return { events, off }
}

// Group Income's reducers (frontend/controller/actions/identity-kv.js)
export const addChatRoomUnreadMessage = (
  contractID: string, messageHash: string, createdHeight: number
) =>
  (prev: any = {}) => {
    const entry = prev[contractID]
    if (!(entry?.readUntil.createdHeight < createdHeight)) return KV_NOOP
    if (entry.unreadMessages.some((msg: any) => msg.messageHash === messageHash)) return KV_NOOP
    return {
      ...prev,
      [contractID]: {
        ...entry,
        unreadMessages: [...entry.unreadMessages, { messageHash, createdHeight }]
      }
    }
  }
export const initChatRoomUnreadMessages = (
  contractID: string, messageHash: string, createdHeight: number
) =>
  (prev: any = {}) => {
    if (prev[contractID]) return KV_NOOP
    return {
      ...prev,
      [contractID]: { readUntil: { messageHash, createdHeight }, unreadMessages: [] }
    }
  }
// A KV_NOOP when the room isn't in the value, otherwise removes it.
export const deleteChatRoomUnreadMessages = (contractID: string) =>
  (prev: any = {}) => {
    if (!(contractID in prev)) return KV_NOOP
    const next = { ...prev }
    delete next[contractID]
    return next
  }

export const room = (hash: string, h: number, unread: any[] = []) => ({
  readUntil: { messageHash: hash, createdHeight: h }, unreadMessages: unread
})
export const V0 = { roomA: room('a1', 1) }
export const VB = { roomA: room('a1', 1), roomB: room('b1', 1) }

// This device and the server are at height 40, and the slot for `key` has
// loaded V0.
export const loadV0At40 = async (key = UNREAD) => {
  await writeAsDeviceB(key, V0, 40)
  defineSlot({ key })
  await activateContract()
}

// Common starting point: this device (A) and the server are at height 40
// and A has loaded V0 (mirror etag E0). Then device B advances the contract
// to 42 and writes VB. A's local contract is still at 40: its mirror etag
// is stale and the server value is ahead of it.
export const setupStaleDeviceA = async () => {
  await loadV0At40()
  assert.strictEqual(slotStatus(UNREAD), 'loaded')
  assert.deepStrictEqual(mirror(UNREAD).value, V0)
  const e0 = mirror(UNREAD).etag
  await writeAsDeviceB(UNREAD, VB, 42)
  assert.strictEqual(localHeight(), 40)
  server.log.length = 0
  return { e0 }
}

export const installKvHeightHooks = () => {
  beforeEach(() => {
    sbp('chelonia/_init')
    server = makeServer(40)
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      connectionOptions: { manual: true, reconnectOnDisconnection: false },
      fetch: server.fetch
    } as unknown as Partial<CheloniaConfig>)
    sbp('chelonia/kv/_testSetHeightTimings', TEST_TIMINGS)
    setupContract(40)
    ;({ warnings, errors, debugs, restore: restoreConsole } = captureConsole())
    stubKvBackoff()
  })

  // Restores everything even when the index check fails, so one failure
  // doesn't leave timers, listeners or stubs behind for the next tests.
  // Unlike `useKvSetHooks` (`test-utils.ts`), no `chelonia/_init` here: run
  // before the index check and `_testClearHeightWaits`, it would empty the maps
  // they inspect and leak the old timers.
  //
  // The work that the cleanup released (held syncs, gates, GETs) still reads
  // the live `server` and the shared `CONTRACT_ID`: wait for the lanes to
  // drain, so that it can't run into the next test. A test that leaves work
  // stuck on a lane fails here.
  afterEach(async () => {
    // Every step runs, even after one throws (the index check, a teardown
    // callback, the drain); their errors are reported once the cleanup is
    // done. Height waits are cleared before the drain, so that no fallback
    // fires during it, and again after it, for a wait that the work the
    // cleanup released registered meanwhile.
    const failures: unknown[] = []
    const step = async (fn: () => unknown) => {
      try {
        await fn()
      } catch (e) {
        failures.push(e)
      }
    }
    await step(() => sbp('chelonia/kv/_assertIndexConsistent'))
    for (const off of offs.splice(0)) await step(off)
    await step(() => sbp('chelonia/kv/_testClearHeightWaits'))
    await step(() => within(drainLanes(), 'lanes drained after the test', 2000))
    await step(() => sbp('chelonia/kv/_testClearHeightWaits'))
    restoreKvTestStubs()
    restoreConsole()
    sbp('chelonia/private/stopClockSync')
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'the cleanup after the test failed')
  })
}
