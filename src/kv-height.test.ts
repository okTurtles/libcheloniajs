// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4).
//
// Runs the real `chelonia/kv/*` selectors, slot loader and pubsub KV
// dispatch against a simulated chel server. The simulation follows the
// server's `/kv/:contractID/:key` routes: `if-match` is checked first (412
// with the stored value), then the height stamp must equal the server's
// contract height (409 with the stored value), then the value is stored and
// a 204 carries the quoted CID as ETag.
//
// "Device B" is a second device of the same user: it signs with the same
// keys while the local contract height is temporarily set to B's height.
// The local contract "processes events" by bumping its height on the
// internal queue lane; a forced contract sync catches it up to the server
// when `server.catchUpOnSync` is set.

import { CURVE25519XSALSA20POLY1305, EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { ChelErrorInvalidMessageHeight, ChelErrorKvHeightAhead, ChelErrorKvUpdateInvalid, ChelErrorSignatureKeyUnauthorized } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import { createCID, multicodes } from './functions.js'
import { KV_NOOP } from './kv.js'
import { readKvValueHeight } from './kv-height.js'
import { NOTIFICATION_TYPE } from './pubsub/index.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import type { ChelRootState, CheloniaConfig, JSONType, KvMirrorEntry } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CID = 'zKvHeightTestIdentityContract'
const CTYPE = 'test-identity'
const UNREAD = 'unreadMessages'
const NS_CACHE = 'namespace-cache'

const rootState = (): ChelRootState & Record<string, any> => sbp('chelonia/private/state')
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Simulated chel server
// ---------------------------------------------------------------------------

type LogEntry = {
  method: string; key: string; status: number; ifMatch?: string | null; height?: string
}
// Every request, including contract syncs (`/latestHEADinfo`,
// `/eventsAfter`), with the time it was made.
type RequestEntry = { path: string; at: number }
type FetchOpts = {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  body?: string;
  signal?: AbortSignal;
}

const makeServer = (initialHeight: number) => {
  const store = new Map<string, { body: string; cid: string }>()
  const log: LogEntry[] = []
  const quote = (cid: string) => `"${cid}"`
  const server = {
    height: initialHeight,
    store,
    log,
    requests: [] as RequestEntry[],
    // When set, a forced contract sync brings the local contract up to the
    // server height (as processing the missing events would).
    catchUpOnSync: false,
    syncs: 0,
    onSync: null as (() => Promise<void> | void) | null,
    holdGet: null as Promise<void> | null,
    onPost: null as ((n: number) => void) | null,
    posts: () => log.filter((e) => e.method === 'POST'),
    gets: () => log.filter((e) => e.method === 'GET'),
    etagOf: (key: string) => quote(store.get(key)?.cid ?? ''),
    // Test oracle: what a fully-synced device reads from the server.
    value: (key: string): any => {
      const stored = store.get(key)
      if (!stored) return undefined
      const serializedData = JSON.parse(stored.body)
      const c = rootState().contracts[CID]
      const saved = c.height
      c.height = Math.max(saved, Number(serializedData.height))
      try {
        return sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
          contractID: CID, serializedData, meta: key
        }).data
      } finally {
        c.height = saved
      }
    },
    fetch: async (url: string, opts: FetchOpts = {}) => {
      const { pathname } = new URL(url)
      server.requests.push({ path: pathname, at: Date.now() })
      opts.signal?.throwIfAborted()
      const method = opts.method ?? 'GET'
      if (pathname.startsWith('/latestHEADinfo/')) {
        server.syncs++
        await server.onSync?.()
        opts.signal?.throwIfAborted()
        if (server.catchUpOnSync) setLocalHeight(server.height)
        // After `chelonia/reset` the contract has no local state.
        const c = rootState().contracts?.[CID] ?? { HEAD: `h${server.height}`, height: server.height }
        return new Response(JSON.stringify({ HEAD: c.HEAD, height: c.height }), { status: 200 })
      }
      if (pathname === '/time') return new Response(String(Date.now()), { status: 200 })
      const m = /^\/kv\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (!m) return new Response('', { status: 404 })
      const key = decodeURIComponent(m[2])
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
      const entry: LogEntry = { method, key, status: 0, ifMatch, height: postHeight }
      log.push(entry)
      // Called before the stored value is read, so a hook that writes to
      // `store` models another device's write that won the race.
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

// ---------------------------------------------------------------------------
// Contract / device helpers
// ---------------------------------------------------------------------------

let server: ReturnType<typeof makeServer>
let cskId: string
let cekId: string
let warnings: unknown[][]
const originalWarn = console.warn
const originalDebug = console.debug
const originalInfo = console.info
const originalError = console.error
const originalRandom = Math.random

const setupContract = (height: number) => {
  const csk = keygen(EDWARDS25519SHA512BATCH)
  const cek = keygen(CURVE25519XSALSA20POLY1305)
  const sak = keygen(EDWARDS25519SHA512BATCH)
  cskId = keyId(csk)
  cekId = keyId(cek)
  const sakId = keyId(sak)
  const rs = rootState()
  rs.contracts[CID] = { HEAD: `h${height}`, height, previousKeyOp: '', type: CTYPE } as any
  const k = (id: string, name: string, purpose: string[], key: any) => ({
    id, name, purpose, ringLevel: 0, permissions: '*', data: serializeKey(key, false), _notBeforeHeight: 0
  })
  rs[CID] = {
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

const localHeight = () => rootState().contracts[CID].height

function setLocalHeight (to: number) {
  const c = rootState().contracts[CID]
  if (!c) return
  c.height = to
  c.HEAD = `h${to}`
  sbp('chelonia/kv/_testNotifyHeight', CID)
}

// Contract events are processed on the internal `<contractID>` lane.
const advanceLocalHeightOnInternalLane = (to: number) =>
  sbp('chelonia/private/queueEvent', CID, () => setLocalHeight(to))

// A second device of the same user writes `value` at contract height
// `atHeight` (which becomes the server's contract height).
const writeAsDeviceB = async (key: string, value: JSONType, atHeight: number) => {
  server.height = atHeight
  const rs = rootState()
  const saved = rs.contracts[CID].height
  rs.contracts[CID].height = atHeight
  try {
    await sbp('chelonia/kv/set', CID, key, value, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
    })
  } finally {
    rs.contracts[CID].height = saved
  }
  return server.store.get(key)!
}

// Wait for the internal lane and then the public lane to drain.
const drainLanes = async () => {
  for (let i = 0; i < 3; i++) {
    await sbp('chelonia/queueInvocation', CID, () => {})
    await sleep(5)
  }
}

// `chelonia/private/in/sync` adds an up-to-date contract to the subscription
// set; the CONTRACTS_MODIFIED listener is only wired by `chelonia/connect`,
// so reconcile slots explicitly afterwards.
const activateContract = async () => {
  await sbp('chelonia/private/in/sync', CID, { force: true })
  sbp('chelonia/kv/_onContractsModified', { added: [CID], removed: [] })
  await drainLanes()
}

const defineSlot = (def: Record<string, unknown>) =>
  sbp('chelonia/kv/defineSlot', { contractType: CTYPE, defaultValue: {}, ...def })

const status = (key: string) => sbp('chelonia/kv/status', CID, key)
const mirror = (key: string): KvMirrorEntry & Record<string, any> =>
  rootState()._kv?.[CID]?.[key] as KvMirrorEntry

const collectStatusEvents = (key: string) => {
  const events: any[] = []
  const off = sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, (p: any) => {
    if (p.contractID === CID && p.key === key) events.push(p)
  })
  return { events, off }
}

// Group Income's reducers (frontend/controller/actions/identity-kv.js)
const addChatRoomUnreadMessage = (contractID: string, messageHash: string, createdHeight: number) =>
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
const initChatRoomUnreadMessages = (
  contractID: string, messageHash: string, createdHeight: number
) =>
  (prev: any = {}) => {
    if (prev[contractID]) return KV_NOOP
    return {
      ...prev,
      [contractID]: { readUntil: { messageHash, createdHeight }, unreadMessages: [] }
    }
  }

const room = (hash: string, h: number, unread: any[] = []) => ({
  readUntil: { messageHash: hash, createdHeight: h }, unreadMessages: unread
})
const V0 = { roomA: room('a1', 1) }
const VB = { roomA: room('a1', 1), roomB: room('b1', 1) }

// Common starting point: this device (A) and the server are at height 40
// and A has loaded V0 (mirror etag E0). Then device B advances the contract
// to 42 and writes VB. A's local contract is still at 40: its mirror etag
// is stale and the server value is ahead of it.
const setupStaleDeviceA = async () => {
  await writeAsDeviceB(UNREAD, V0, 40)
  defineSlot({ key: UNREAD })
  await activateContract()
  assert.strictEqual(status(UNREAD), 'loaded')
  assert.deepStrictEqual(mirror(UNREAD).value, V0)
  const e0 = mirror(UNREAD).etag
  await writeAsDeviceB(UNREAD, VB, 42)
  assert.strictEqual(localHeight(), 40)
  server.log.length = 0
  return { e0 }
}

beforeEach(() => {
  sbp('chelonia/_init')
  server = makeServer(40)
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    connectionOptions: { manual: true, reconnectOnDisconnection: false },
    fetch: server.fetch
  } as unknown as Partial<CheloniaConfig>)
  sbp('chelonia/kv/_testSetHeightTimings', {
    waitMs: 50, pendingFallbackMs: 300, recoveryTimeoutMs: 2000
  })
  setupContract(40)
  warnings = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  console.debug = () => {}
  console.info = () => {}
  console.error = () => {}
  // `kv/set` backs off randomIntFromRange(0, 1500) ms between 412 retries.
  Math.random = () => 0
})

afterEach(() => {
  sbp('chelonia/kv/_assertIndexConsistent')
  sbp('chelonia/kv/_clearHeightWaits')
  sbp('chelonia/kv/_testSetHeightTimings')
  console.warn = originalWarn
  console.debug = originalDebug
  console.info = originalInfo
  console.error = originalError
  Math.random = originalRandom
  sbp('chelonia/private/stopClockSync')
})

// ---------------------------------------------------------------------------

describe('writes while the local contract is behind', () => {
  it('a 409 is re-signed with the same data once the contract catches up', async () => {
    const { cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.height = 41
    server.log.length = 0
    server.onPost = (n) => {
      if (n === 1) advanceLocalHeightOnInternalLane(41)
    }
    await sbp('chelonia/kv/set', CID, UNREAD, VB, {
      ifMatch: `"${cid}"`, signingKeyId: cskId, encryptionKeyId: cekId
    })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height, p.ifMatch]), [
      [409, '40', `"${cid}"`], [204, '41', `"${cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a KV_NOOP reducer is merged against the server value instead of dropped', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const bases: any[] = []
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    const result = await sbp('chelonia/kv/update', {
      contractID: CID,
      key: UNREAD,
      updater: (prev: any) => { bases.push(prev); return reducer(prev) }
    })
    const merged = { ...VB, roomA: room('a1', 1, [{ messageHash: 'a2', createdHeight: 5 }]) }
    assert.deepStrictEqual(result, merged)
    assert.deepStrictEqual(server.value(UNREAD), merged)
    // First attempt against the (stale) mirror, then against the server
    // value once it became verifiable; never against the default.
    assert.deepStrictEqual(bases, [V0, VB])
    assert.strictEqual(server.syncs, 2) // activation + one recovery
    assert.deepStrictEqual(mirror(UNREAD).value, merged)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
  })

  it("onHeightAhead: 'reject' rejects instead of recovering, and writes nothing", async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const bases: any[] = []
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: (prev: any) => { bases.push(prev); return reducer(prev) }
      }),
      (e: any) => e instanceof ChelErrorKvHeightAhead &&
        (e.cause as { requiredHeight: number }).requiredHeight === 42
    )
    assert.deepStrictEqual(bases, [V0])
    assert.strictEqual(server.syncs, 1)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a writing reducer never overwrites the server value with the default', async () => {
    await setupStaleDeviceA()
    // Keep the deferred-reload fallback out of the sync count below.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 50, pendingFallbackMs: 10000 })
    // The server keeps a value this device can never verify.
    const bases: any[] = []
    const reducer = initChatRoomUnreadMessages('roomC', 'c1', 3)
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CID,
        key: UNREAD,
        updater: (prev: any) => { bases.push(prev); return reducer(prev) }
      }),
      (e: any) => e instanceof ChelErrorKvHeightAhead
    )
    assert.ok(bases.every((b) => Object.keys(b).length > 0), 'reducer saw the default')
    assert.ok(server.posts().every((p) => p.status === 412))
    assert.strictEqual(server.syncs, 3) // activation + maxHeightRecoveries (2)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a value that becomes verifiable during the wait is merged, not overwritten', async () => {
    await setupStaleDeviceA()
    server.onPost = (n) => {
      if (n === 1) setTimeout(() => advanceLocalHeightOnInternalLane(42), 10)
    }
    const result = await sbp('chelonia/kv/update', {
      contractID: CID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [412, '40'], [204, '42']
    ])
    assert.strictEqual(server.syncs, 1) // no recovery needed
  })

  it("queuedSet + async onconflict (saveCachedNames) keeps the other device's names", async () => {
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    server.log.length = 0
    server.onPost = (n) => {
      if (n === 1) {
        // Events 41, 42 arrive while the KV write is in flight.
        sbp('chelonia/private/queueEvent', CID, async () => {
          await sleep(10)
          setLocalHeight(42)
        })
      }
    }
    const seen: unknown[] = []
    // Same shape as GI's saveCachedNames onconflict: default [] and an
    // awaited network lookup before returning.
    const onconflict = async ({ currentData = [], etag }: any = {}) => {
      seen.push(currentData)
      await sleep(20)
      return [[...new Set([...currentData, 'alice', 'carol'])].sort(), etag]
    }
    await sbp('chelonia/kv/queuedSet', {
      contractID: CID, key: NS_CACHE, data: ['alice', 'carol'], onconflict
    })
    assert.deepStrictEqual(seen, [['alice', 'bob']])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('queuedSet recovers by syncing the contract when it does not catch up', async () => {
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    // Recovery only syncs subscribed contracts (syncing an unsubscribed one
    // would subscribe it).
    await sbp('chelonia/private/in/sync', CID, { force: true })
    assert.strictEqual(localHeight(), 40)
    server.catchUpOnSync = true
    const seen: unknown[] = []
    await sbp('chelonia/kv/queuedSet', {
      contractID: CID,
      key: NS_CACHE,
      data: ['alice', 'carol'],
      onconflict: async ({ currentData = [], etag }: any = {}) => {
        seen.push(currentData)
        return [[...new Set([...currentData, 'alice', 'carol'])].sort(), etag]
      }
    })
    assert.deepStrictEqual(seen, [['alice', 'bob']])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('queuedSet rejects with ChelErrorKvHeightAhead when recovery cannot help', async () => {
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    await sbp('chelonia/private/in/sync', CID, { force: true })
    let conflicts = 0
    await assert.rejects(
      sbp('chelonia/kv/queuedSet', {
        contractID: CID,
        key: NS_CACHE,
        data: ['alice', 'carol'],
        onconflict: async ({ currentData = [], etag }: any = {}) => {
          conflicts++
          return [[...currentData, 'carol'], etag]
        }
      }),
      (e: any) => e instanceof ChelErrorKvHeightAhead && e.name === 'ChelErrorKvHeightAhead'
    )
    assert.strictEqual(conflicts, 0)
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob'])
  })

  it('clear succeeds against a value that is ahead', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    await sbp('chelonia/kv/clear', CID, UNREAD)
    assert.strictEqual(server.value(UNREAD), null)
    assert.strictEqual(status(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
  })

  it("a clear retried after a recovery doesn't carry the first attempt's conflict", async () => {
    await setupStaleDeviceA()
    const client = sbp('chelonia/connect', {}) as any
    const deliverFrame = () => {
      const stored = server.store.get(UNREAD)!
      client.messageHandlers[NOTIFICATION_TYPE.KV].call(client, {
        type: NOTIFICATION_TYPE.KV, channelID: CID, key: UNREAD, data: stored.body, cid: `"${stored.cid}"`
      })
    }
    try {
      // B's frame for VB (height 42) arrives while A is at 40: deferred.
      deliverFrame()
      await drainLanes()
      server.catchUpOnSync = true
      await sbp('chelonia/kv/clear', CID, UNREAD)
      // Attempt 1 conflicts (412), then its height stamp is stale (409);
      // after the recovery sync, attempt 2 commits without a conflict.
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
        [412, '40'], [409, '40'], [204, '42']
      ])
      // So another device's next write is applied as is, without the
      // authoritative GET a conflict-resolved write's echo marker forces.
      const V2 = { ...VB, roomC: room('c1', 3) }
      await writeAsDeviceB(UNREAD, V2, 42)
      const getsBefore = server.gets().length
      deliverFrame()
      await drainLanes()
      assert.deepStrictEqual(mirror(UNREAD).value, V2)
      assert.strictEqual(server.gets().length, getsBefore)
    } finally {
      client.destroy()
    }
  })

  it("a clear's conflict error reports its last attempt, not an earlier one", async () => {
    // The schema rejects `{ bad }`, so a conflict on such a value has no
    // current data to report.
    const schema = {
      parse: (v: any) => {
        if (v == null || (typeof v === 'object' && 'bad' in v)) throw new Error('invalid')
        return v
      }
    }
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, schema })
    await activateContract()
    const bad1 = await writeAsDeviceB(UNREAD, { bad: 1 }, 41)
    const bad2 = await writeAsDeviceB(UNREAD, { bad: 2 }, 41)
    // The server holds VB (written at 40) and is at height 41.
    await writeAsDeviceB(UNREAD, VB, 40)
    server.height = 41
    server.catchUpOnSync = true
    server.log.length = 0
    // Attempt 2's two POSTs each lose to a write by another device.
    server.onPost = (n) => {
      if (n === 3) server.store.set(UNREAD, bad1)
      if (n === 4) server.store.set(UNREAD, bad2)
    }
    await assert.rejects(
      sbp('chelonia/kv/clear', CID, UNREAD, { maxAttempts: 2 }),
      (e: any) => {
        assert.strictEqual(e.name, 'ChelErrorKvConflict')
        // Not VB, which only attempt 1 saw.
        assert.strictEqual(e.cause.currentData, null)
        assert.strictEqual(e.cause.etag, server.etagOf(UNREAD))
        return true
      }
    )
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [412, '40'], [409, '40'], [412, '41'], [412, '41']
    ])
  })

  it('recovery syncs the contract with the queue lane released', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const laneState: string[] = []
    server.onSync = async () => {
      laneState.push(await Promise.race([
        sbp('chelonia/private/queueEvent', `public:${CID}`, () => 'free'),
        sleep(300).then(() => 'busy')
      ]))
    }
    await sbp('chelonia/kv/update', {
      contractID: CID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    assert.deepStrictEqual(laneState, ['free'])
  })

  it("the caller's signal aborts a write that is waiting for recovery", async () => {
    await setupStaleDeviceA()
    let releaseSync: (() => void) | undefined
    let signalSyncStarted!: () => void
    const syncStarted = new Promise<void>((resolve) => { signalSyncStarted = resolve })
    server.onSync = () => new Promise<void>((resolve) => {
      releaseSync = resolve
      signalSyncStarted()
    })
    const controller = new AbortController()
    const write = sbp('chelonia/kv/update', {
      contractID: CID,
      key: UNREAD,
      signal: controller.signal,
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    await syncStarted
    // `_waitInFlight` (used by `chelonia/reset`) waits for the recovery sync.
    let drained = false
    const waiting = sbp('chelonia/kv/_waitInFlight').then(() => { drained = true })
    controller.abort(new Error('user navigated away'))
    await assert.rejects(write, (e: any) => e.message === 'user navigated away')
    await sleep(20)
    assert.strictEqual(drained, false)
    releaseSync!()
    await waiting
    assert.strictEqual(server.posts().length, 1)
  })

  it('rejects invalid height-recovery options before touching the network', async () => {
    await setupStaleDeviceA()
    for (const options of [
      { onHeightAhead: 'retry' }, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 }
    ]) {
      await assert.rejects(
        sbp('chelonia/kv/update', {
          contractID: CID, key: UNREAD, updater: () => ({}), ...options
        }),
        ChelErrorKvUpdateInvalid
      )
      await assert.rejects(sbp('chelonia/kv/clear', CID, UNREAD, options), ChelErrorKvUpdateInvalid)
    }
    assert.strictEqual(server.log.length, 0)
  })
})

describe('loads and pubsub frames while the local contract is behind', () => {
  it('a first load that is ahead stays pending, then loads once the contract catches up', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    server.log.length = 0
    // A settled-based gate, as Group Income's unread-messages gate becomes.
    const flushed: unknown[] = []
    const { events, off } = collectStatusEvents(UNREAD)
    const offGate = sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, (p: any) => {
      if (p.key === UNREAD && p.settled) flushed.push(sbp('chelonia/kv/read', CID, UNREAD))
    })
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(status(UNREAD), 'loading')
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.deepStrictEqual(flushed, [])

    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    off()
    offGate()
    assert.strictEqual(status(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), VB)
    assert.deepStrictEqual(flushed, [VB])
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'loaded', true]
    ])
  })

  it('a pending load settles to error when the contract never catches up', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(status(UNREAD), 'loading')
    const settledAs = sbp('chelonia/kv/whenSettled', CID, UNREAD)
    const syncsBefore = server.syncs
    assert.strictEqual(await settledAs, 'error')
    assert.strictEqual(server.syncs, syncsBefore + 1) // the fallback sync
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    assert.strictEqual(mirror(UNREAD).settled, true)
  })

  it('the fallback sync reloads the slot when it brings the contract up to date', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    server.catchUpOnSync = true
    assert.strictEqual(await sbp('chelonia/kv/whenSettled', CID, UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), VB)
  })

  it('single-key kv/sync recovers from a value that is ahead', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    server.catchUpOnSync = true
    await sbp('chelonia/kv/sync', CID, UNREAD)
    assert.strictEqual(status(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), VB)
  })

  it('single-key kv/sync keeps a loaded value when it cannot catch up', async () => {
    const { e0 } = await setupStaleDeviceA()
    await assert.rejects(sbp('chelonia/kv/sync', CID, UNREAD), ChelErrorKvHeightAhead)
    assert.strictEqual(status(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, e0)
  })

  it('a pubsub frame that is ahead reloads the key once the contract catches up', async () => {
    await setupStaleDeviceA()
    const client = sbp('chelonia/connect', {}) as any
    try {
      const stored = server.store.get(UNREAD)!
      client.messageHandlers[NOTIFICATION_TYPE.KV].call(client, {
        type: NOTIFICATION_TYPE.KV, channelID: CID, key: UNREAD, data: stored.body, cid: `"${stored.cid}"`
      })
      await drainLanes()
      assert.deepStrictEqual(mirror(UNREAD).value, V0)
      const updates: any[] = []
      const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, (p: any) => updates.push(p))
      await advanceLocalHeightOnInternalLane(42)
      await drainLanes()
      off()
      assert.deepStrictEqual(mirror(UNREAD).value, VB)
      assert.strictEqual(mirror(UNREAD).etag, `"${stored.cid}"`)
      assert.deepStrictEqual(updates.map((u) => u.reason), ['remote'])
      // With the etag current, the next write needs no conflict round trip.
      server.log.length = 0
      await sbp('chelonia/kv/update', {
        contractID: CID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      })
      assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    } finally {
      client.destroy()
    }
  })

  it('releasing the contract cancels deferred reloads', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(status(UNREAD), 'loading')
    sbp('chelonia/kv/_cleanupContractRuntime', CID)
    const getsBefore = server.gets().length
    await advanceLocalHeightOnInternalLane(42)
    await sleep(400)
    assert.strictEqual(server.gets().length, getsBefore)
  })
})

describe('settled / whenSettled', () => {
  it('seeding does not settle; a first-load 404 settles without onUpdate', async () => {
    const onUpdateCalls: unknown[] = []
    const { events, off } = collectStatusEvents('absent')
    defineSlot({ key: 'seedOnly', autoLoad: 'never' })
    defineSlot({ key: 'absent', onUpdate: (v: unknown) => { onUpdateCalls.push(v) } })
    await activateContract()
    off()
    assert.strictEqual(mirror('seedOnly').settled, false)
    assert.strictEqual(status('absent'), 'non-init')
    assert.strictEqual(mirror('absent').settled, true)
    assert.deepStrictEqual(events.map((e) => [e.status, e.settled, e.previousSettled]), [
      ['loading', false, false], ['non-init', true, false]
    ])
    assert.deepStrictEqual(onUpdateCalls, [])
    assert.strictEqual(await sbp('chelonia/kv/whenSettled', CID, 'absent'), 'non-init')
  })

  it('an abandoned load does not settle the slot', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    let release!: () => void
    server.holdGet = new Promise<void>((resolve) => { release = resolve })
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD })
    const settledAs = sbp('chelonia/kv/whenSettled', CID, UNREAD)
    await sbp('chelonia/private/in/sync', CID, { force: true })
    sbp('chelonia/kv/_onContractsModified', { added: [CID], removed: [] })
    await sleep(20)
    // Slot replaced (HMR / re-registration) while its first GET is in flight.
    defineSlot({ key: UNREAD })
    server.holdGet = null
    release()
    assert.strictEqual(await settledAs, 'loaded')
    await drainLanes()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'non-init', false],
      ['non-init', 'loading', false],
      ['loading', 'loaded', true]
    ])
  })

  it('re-activating a persisted entry resets settled until the next load', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    rootState()._kv![CID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    let release!: () => void
    server.holdGet = new Promise<void>((resolve) => { release = resolve })
    defineSlot({ key: UNREAD })
    await sbp('chelonia/private/in/sync', CID, { force: true })
    sbp('chelonia/kv/_onContractsModified', { added: [CID], removed: [] })
    await sleep(20)
    assert.strictEqual(mirror(UNREAD).settled, false)
    server.holdGet = null
    release()
    assert.strictEqual(await sbp('chelonia/kv/whenSettled', CID, UNREAD), 'loaded')
  })

  // An entry persisted as `{ status: 'loaded', settled: true }` holding V0,
  // while the server holds VB written at height 42 and the local contract
  // stays at 40 (a sync doesn't catch it up).
  const seedPersistedLoadedEntry = async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const persistedEtag = server.etagOf(UNREAD)
    await writeAsDeviceB(UNREAD, VB, 42)
    rootState()._kv![CID] = {
      [UNREAD]: { value: V0, etag: persistedEtag, status: 'loaded', settled: true }
    }
    return { persistedEtag }
  }
  // Fails, instead of hanging the suite, if the slot never settles.
  const whenSettledWithin = (ms: number) =>
    sbp('chelonia/kv/whenSettled', CID, UNREAD, { signal: AbortSignal.timeout(ms) })

  it('a re-activated loaded entry settles when its deferred load gives up', async () => {
    const { persistedEtag } = await seedPersistedLoadedEntry()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    const { events, off } = collectStatusEvents(UNREAD)
    const syncsBefore = server.syncs
    assert.strictEqual(await whenSettledWithin(3000), 'loaded')
    off()
    assert.strictEqual(server.syncs, syncsBefore + 1) // the fallback sync
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.previousSettled, e.settled]),
      [['loaded', 'loaded', false, true]]
    )
  })

  it('single-key kv/sync that gives up settles a re-activated loaded entry', async () => {
    const { persistedEtag } = await seedPersistedLoadedEntry()
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    await assert.rejects(sbp('chelonia/kv/sync', CID, UNREAD), ChelErrorKvHeightAhead)
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(await whenSettledWithin(100), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
  })

  it('a committed local write settles the slot', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    await sbp('chelonia/kv/update', {
      contractID: CID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    })
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loaded', true]
    ])
  })

  it('whenSettled waits for activation and rejects on abort and on reset', async () => {
    const early = sbp('chelonia/kv/whenSettled', CID, 'absent')
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(await early, 'non-init')

    defineSlot({ key: 'never', autoLoad: 'never' })
    await drainLanes()
    const controller = new AbortController()
    const aborted = sbp('chelonia/kv/whenSettled', CID, 'never', { signal: controller.signal })
    controller.abort(new Error('stop waiting'))
    await assert.rejects(aborted, (e: any) => e.message === 'stop waiting')

    const pending = sbp('chelonia/kv/whenSettled', CID, 'never')
    await sbp('chelonia/reset')
    await assert.rejects(pending, (e: any) => e.name === 'AbortError')
  })
})

describe('height stamps', () => {
  it('only canonical stamps are read', () => {
    for (const [stamp, height] of [['0', 0], ['40', 40], [0, 0], [40, 40]] as const) {
      assert.strictEqual(readKvValueHeight({ height: stamp }), height)
    }
    for (const stamp of [
      '1e1', '0.1e2', '0x0a', '010', ' 10', '10 ', '10.0', '+10', '-1', '',
      '9007199254740993', -1, 1.5, NaN, Infinity, null, undefined, {}
    ]) {
      assert.throws(
        () => readKvValueHeight({ height: stamp }), ChelErrorInvalidMessageHeight, String(stamp)
      )
    }
    assert.throws(() => readKvValueHeight(null), ChelErrorInvalidMessageHeight)
  })

  // A value signed by a key revoked at height 5 (e.g. a removed device's),
  // stamped with the current height (40) written in different ways. The
  // server accepts each of them: it compares `Number(stamp)` with its
  // contract height.
  it("a revoked key's value can't pass the key-window check with a non-canonical stamp", async () => {
    const KEY = 'profile'
    const revoked = keygen(EDWARDS25519SHA512BATCH)
    const revokedId = keyId(revoked)
    rootState()[CID]._vm.authorizedKeys[revokedId] = {
      id: revokedId,
      name: 'old-device-csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      data: serializeKey(revoked, false),
      _notBeforeHeight: 0,
      _notAfterHeight: 5
    }
    const signedAt = (height: string) => ({
      ...signedOutgoingDataWithRawKey(revoked, { displayName: 'mallory' }).serialize(KEY + height),
      height
    })
    const parse = (serializedData: unknown) =>
      sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
        contractID: CID, serializedData, meta: KEY
      })
    assert.throws(() => parse(signedAt('40')).data, ChelErrorSignatureKeyUnauthorized)
    // `parseInt` reads these as 4 and 0, inside the key's window.
    for (const stamp of ['4e1', '0.4e2']) {
      assert.throws(() => parse(signedAt(stamp)), ChelErrorInvalidMessageHeight, stamp)
    }
    // End to end: the server stores such a value, but the slot doesn't
    // load it.
    const posted = await server.fetch(`https://example.test/kv/${CID}/${KEY}`, {
      method: 'POST', headers: { 'if-match': '""' }, body: JSON.stringify(signedAt('4e1'))
    })
    assert.strictEqual(posted.status, 204)
    defineSlot({ key: KEY })
    await activateContract()
    assert.strictEqual(status(KEY), 'error')
    assert.strictEqual(mirror(KEY).lastError?.name, 'ChelErrorInvalidMessageHeight')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, KEY), {})
  })
})

describe('chelonia/reset', () => {
  const contractSyncsSince = (at: number) => server.requests
    .filter((r) => r.at >= at && /^\/(latestHEADinfo|eventsAfter)\//.test(r.path))
    .map((r) => r.path)

  it('a deferred-load fallback due while reset drains starts no contract sync', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    // Deferred: the 300 ms fallback is armed.
    assert.strictEqual(status(UNREAD), 'loading')
    const resetStartedAt = Date.now()
    // The fallback falls due while the persistence hook runs.
    await sbp('chelonia/reset', () => sleep(500))
    await sleep(400)
    assert.deepStrictEqual(contractSyncsSince(resetStartedAt), [])
    // The next session doesn't expect events for the torn-down contract
    // (a sync started for it would have put it back in `pending`).
    warnings.length = 0
    await sbp('chelonia/private/in/handleEvent', CID, 'not-a-message')
    assert.ok(warnings.some((w) => String(w[0]).includes('ignoring unexpected event')))
  })

  it('work started while reset drains registers no height wait and starts no sync', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const resetStartedAt = Date.now()
    let updateError: unknown
    await sbp('chelonia/reset', async () => {
      // Outside a reset, this load would defer the key (with a 300 ms
      // fallback sync) and the update would sync the contract to recover.
      await sbp('chelonia/kv/sync', CID)
      updateError = await sbp('chelonia/kv/update', {
        contractID: CID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }).then(() => undefined, (e: unknown) => e)
      await sleep(500)
    })
    assert.strictEqual((updateError as Error | undefined)?.name, 'AbortError')
    assert.deepStrictEqual(contractSyncsSince(resetStartedAt), [])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it('the next session defers and recovers again', async () => {
    await sbp('chelonia/reset')
    setupContract(40)
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(status(UNREAD), 'loading')
    server.catchUpOnSync = true
    assert.strictEqual(await sbp('chelonia/kv/whenSettled', CID, UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CID, UNREAD), VB)
  })
})

describe('unchanged behaviour', () => {
  it('a never-loaded slot sends if-match "" and merges on the 412', async () => {
    const { cid: v0cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(status(UNREAD), 'non-init')
    assert.strictEqual(server.gets().length, 0)
    await sbp('chelonia/kv/update', {
      contractID: CID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.ifMatch]), [
      [412, '""'], [204, `"${v0cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })
})
