// Shared harness for the height-aware KV tests (`kv-height.test.ts`,
// `kv-height-pubsub.test.ts`). A plain module, not a `*.test.ts` file: it
// registers no SBP selectors. Call `installKvHeightHooks()` once at the top
// level of a test file.
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
import { KV_NOOP } from './kv.js'
import {
  makeKvServer,
  restoreKvTestStubs,
  setLocalHeight as setContractHeight,
  sleep,
  stubKvBackoff,
  whenSettledWithin as whenContractSlotSettledWithin,
  withLocalHeight,
  type KvFetchOptions
} from './test-utils.js'
import type { ChelRootState, CheloniaConfig, JSONType, KvMirrorEntry } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export { sleep }

export const CONTRACT_ID = 'zKvHeightTestIdentityContract'
export const CTYPE = 'test-identity'
export const UNREAD = 'unreadMessages'
export const NS_CACHE = 'namespace-cache'

// Height timings for every test (see `chelonia/kv/_testSetHeightTimings`;
// omitted fields reset to the production defaults, so spread this object
// when overriding one field).
export const TEST_TIMINGS = { waitMs: 50, pendingFallbackMs: 300, recoveryTimeoutMs: 2000 }

export const rootState = (): ChelRootState & Record<string, any> => sbp('chelonia/private/state')

// ---------------------------------------------------------------------------
// Simulated chel server
// ---------------------------------------------------------------------------

type RequestEntry = { path: string; at: number }

const makeServer = (initialHeight: number) => {
  const kv = makeKvServer(initialHeight)
  const server = Object.assign(kv, {
    // Every request, including contract syncs (`/latestHEADinfo`,
    // `/eventsAfter`), with the time it was made.
    requests: [] as RequestEntry[],
    // When set, a forced contract sync brings the local contract up to the
    // server height (as processing the missing events would).
    catchUpOnSync: false,
    syncs: 0,
    onSync: null as (() => Promise<void> | void) | null,
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
      server.requests.push({ path: pathname, at: Date.now() })
      opts.signal?.throwIfAborted()
      if (pathname.startsWith('/latestHEADinfo/')) {
        server.syncs++
        await server.onSync?.()
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
export let debugs: unknown[][]
const offs: Array<() => void> = []
const originalWarn = console.warn
const originalDebug = console.debug
const originalInfo = console.info
const originalError = console.error

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
      const key = decodeURIComponent(pathname.split('/').pop()!)
      server.log.push({ method: 'GET', key, status })
      return new Response('', { status })
    }
    return real(pathname, opts)
  }
  return () => { server.handleKv = real }
}

// Holds the next contract sync (`/latestHEADinfo`) until `release` is
// called; `started` resolves once it has begun. Later syncs aren't held.
export const holdNextSync = () => {
  let resolveSync: (() => void) | undefined
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  server.onSync = () => new Promise<void>((resolve) => {
    server.onSync = null
    resolveSync = resolve
    signalStarted()
  })
  return { started, release: () => resolveSync?.() }
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

// Common starting point: this device (A) and the server are at height 40
// and A has loaded V0 (mirror etag E0). Then device B advances the contract
// to 42 and writes VB. A's local contract is still at 40: its mirror etag
// is stale and the server value is ahead of it.
export const setupStaleDeviceA = async () => {
  await writeAsDeviceB(UNREAD, V0, 40)
  defineSlot({ key: UNREAD })
  await activateContract()
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
    warnings = []
    debugs = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    console.debug = (...args: unknown[]) => { debugs.push(args) }
    console.info = () => {}
    console.error = () => {}
    stubKvBackoff()
  })

  // Restores everything even when the index check fails, so one failure
  // doesn't leave timers, listeners or stubs behind for the next tests.
  // Unlike `useKvSetHooks` (`test-utils.ts`), no `chelonia/_init` here: run
  // before the index check and `_clearHeightWaits`, it would empty the maps
  // they inspect and leak the old timers.
  afterEach(() => {
    try {
      sbp('chelonia/kv/_assertIndexConsistent')
    } finally {
      for (const off of offs.splice(0)) off()
      sbp('chelonia/kv/_clearHeightWaits')
      restoreKvTestStubs()
      console.warn = originalWarn
      console.debug = originalDebug
      console.info = originalInfo
      console.error = originalError
      sbp('chelonia/private/stopClockSync')
    }
  })
}
