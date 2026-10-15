// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4).
//
// Runs the real `chelonia/kv/*` selectors and slot loader against a
// simulated chel server; see `kv-height-harness.ts`. The tests that need a
// pubsub connection are in `kv-height-pubsub.test.ts`: `chelonia/connect`
// wires listeners that outlive `chelonia/_init`, so connecting here would
// change how every later test in the file reconciles its slots.

import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvHeightAhead,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorSignatureKeyUnauthorized,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED, CHELONIA_RESET, EVENT_HANDLED } from './events.js'
import { createCID, multicodes } from './functions.js'
import {
  CONTRACT_ID,
  CTYPE,
  NS_CACHE,
  TEST_TIMINGS,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  cekId,
  collectStatusEvents,
  cskId,
  defineSlot,
  deleteChatRoomUnreadMessages,
  drainLanes,
  errors,
  failKvGets,
  gateLane,
  holdGets,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  kvGetsRequested,
  later,
  loadV0At40,
  localHeight,
  mirror,
  onEvent,
  probePublicLaneOnSync,
  publicLaneQueued,
  restamp,
  restampedBody,
  room,
  rootState,
  server,
  setLocalHeight,
  setupContract,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  subscribeContract,
  until,
  untilWarned,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { addHeightListener, notifyContractHeight, readHeightStamp } from './kv-height.js'
import { KV_NOOP } from './kv.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { logged, settledOr, withLocalHeight } from './test-utils.js'
import type { CheloniaConfig, CheloniaContext, JSONType } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

// A snapshot of the height wait of `key`, if any.
const heightWait = (key: string): { requiredHeight: number; parked: boolean } | undefined =>
  sbp('chelonia/kv/_testHeightWait', CONTRACT_ID, key)

// Device A's loaded slot (V0) is refreshed by an aggregate `kv/sync`, which
// finds VB written at height 42. The contract stays at 40 (the 300 ms
// fallback sync doesn't catch it up), so the deferred reload gives up and
// the slot keeps presenting V0.
const loadedRefreshGivesUp = async () => {
  await setupStaleDeviceA()
  await sbp('chelonia/kv/sync', CONTRACT_ID)
  await untilWarned('keeping the current mirror value')
  await drainLanes()
  assert.strictEqual(slotStatus(UNREAD), 'loaded')
  assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  server.log.length = 0
}

// A slot whose first load was deferred on height: device B wrote VB at
// height 42, and the local contract is at 40. `def` is merged into the slot
// definition (an auto-loaded one). Leaves the request log empty.
const deferFirstLoad = async (def: Record<string, unknown> = {}) => {
  await writeAsDeviceB(UNREAD, VB, 42)
  defineSlot({ key: UNREAD, ...def })
  await activateContract()
  assert.strictEqual(slotStatus(UNREAD), 'loading')
  assert.strictEqual(mirror(UNREAD).value, undefined)
  server.log.length = 0
}

// An `update` of UNREAD that records the basis of each reducer run in
// `bases`. The reducer defaults to adding a2 to roomA.
const recordingUpdate = (
  bases: unknown[],
  {
    reducer = addChatRoomUnreadMessage('roomA', 'a2', 5),
    ...options
  }: { reducer?: (prev: any) => unknown } & Record<string, unknown> = {}
) => sbp('chelonia/kv/update', {
  contractID: CONTRACT_ID,
  key: UNREAD,
  updater: (prev: any) => { bases.push(prev); return reducer(prev) },
  ...options
})

// VB with a2 added to roomA (`recordingUpdate`'s default reducer on VB).
const MERGED_A2 = { ...VB, roomA: room('a1', 1, [{ messageHash: 'a2', createdHeight: 5 }]) }

// The writes that recover from a height error themselves, as `[name,
// write]` pairs, each write of UNREAD taking the options in `extra`.
const heightWrites = (extra: Record<string, unknown> = {}) => [
  ['update', () => sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5), ...extra
  })],
  ['clear', () => sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, extra)],
  ['queuedSet', () => sbp('chelonia/kv/queuedSet', {
    contractID: CONTRACT_ID, key: UNREAD, data: V0, ifMatch: '*', ...extra
  })]
] as const

// Device B wrote ['alice', 'bob'] to NS_CACHE at height 42, and this device
// subscribed to the contract at 40: a height recovery only syncs subscribed
// contracts (syncing an unsubscribed one would subscribe it).
const namesWrittenAhead = async () => {
  await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
  await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
}

// A `queuedSet` `onconflict` for NS_CACHE that adds `names` to the current
// list (sorted, without duplicates). Records each list it merges into in
// `seen`.
const mergeNames = (names: string[], seen: unknown[] = []) =>
  async ({ currentData = [], etag }: any = {}) => {
    seen.push(currentData)
    return [[...new Set([...currentData, ...names])].sort(), etag]
  }

// ---------------------------------------------------------------------------

describe('writes while the local contract is behind', () => {
  it('a 409 is re-signed with the same data once the contract catches up', async () => {
    const { cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.height = 41
    server.log.length = 0
    server.onPost = (n) => {
      if (n === 1) advanceLocalHeightOnInternalLane(41)
    }
    await sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, VB, {
      ifMatch: `"${cid}"`, signingKeyId: cskId, encryptionKeyId: cekId
    })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height, p.ifMatch]), [
      [409, '40', `"${cid}"`], [204, '41', `"${cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  // A catch-up sync (e.g. after a reconnect) replays the 6 events this
  // device missed, one every 30 ms. Re-signing at each replayed height would
  // only get another 409 each time, and give up one event short.
  it('a 409 during a catch-up sync waits for the sync to end, then re-signs once', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500 })
    await loadV0At40()
    server.height = 46
    server.log.length = 0
    let replaying = false
    server.onSync = async () => {
      server.onSync = null
      replaying = true
      for (let height = 41; height <= 46; height++) {
        await sleep(30)
        setLocalHeight(height)
      }
    }
    const syncing = sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    await until(() => replaying, 'the catch-up sync started')
    await within(sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: mirror(UNREAD).etag, signingKeyId: cskId, encryptionKeyId: cekId
    }), 'kv/set')
    await within(syncing, 'the catch-up sync')
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '46']])
  })

  // The 409's if-match held: the mirror still matches the server, so the
  // retry after the recovery sync doesn't reload it first.
  it("update's retry after a clean 409 doesn't reload the slot", async () => {
    await loadV0At40()
    server.height = 41
    server.catchUpOnSync = true
    const reasons: string[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => { if (p.key === UNREAD) reasons.push(p.reason) })
    server.log.length = 0
    const bases: any[] = []
    await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) })
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 409], ['POST', 204]])
    assert.deepStrictEqual(bases, [V0, V0])
    assert.deepStrictEqual(reasons, ['local'])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })

  it("update's retry after a 409 that followed a 412 reloads the slot", async () => {
    await loadV0At40()
    // VB, written at 40, makes the mirror etag stale; then the server moves
    // on to 41 without changing the key.
    await writeAsDeviceB(UNREAD, VB, 40)
    server.height = 41
    server.catchUpOnSync = true
    server.log.length = 0
    const bases: any[] = []
    await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) })
    // The 412's merge was never written, so nothing tells that the mirror
    // matches the server once a recovery ran: the retry reloads.
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [
      ['POST', 412], ['POST', 409], ['GET', 200], ['POST', 204]
    ])
    assert.deepStrictEqual(bases, [V0, VB, VB])
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it('a reducer that is a KV_NOOP only on the default is merged against the server value instead of dropped', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const bases: any[] = []
    const result = await recordingUpdate(bases)
    assert.deepStrictEqual(result, MERGED_A2)
    assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
    // First attempt against the (stale) mirror, then against the server
    // value once it became verifiable; never against the default.
    assert.deepStrictEqual(bases, [V0, VB])
    assert.strictEqual(server.syncs, 2) // activation + one recovery
    assert.deepStrictEqual(mirror(UNREAD).value, MERGED_A2)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
  })

  it("onHeightAhead: 'reject' rejects instead of recovering, and writes nothing", async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const bases: any[] = []
    await assert.rejects(
      recordingUpdate(bases, { onHeightAhead: 'reject' }),
      (e: any) => isKvHeightAhead(e) &&
        (e.cause as { requiredHeight: number }).requiredHeight === 42
    )
    assert.deepStrictEqual(bases, [V0])
    assert.strictEqual(server.syncs, 1)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a writing reducer never overwrites the server value with the default', async () => {
    await setupStaleDeviceA()
    // Keep the deferred-reload fallback out of the sync count below.
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    // The server keeps a value this device can never verify.
    const bases: any[] = []
    await assert.rejects(
      recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) }),
      (e: any) => isKvHeightAhead(e)
    )
    // Only the first attempt runs the reducer, against the (stale, but
    // verified) mirror. The attempts after each recovery reload the mirror
    // first, find the server value still unverifiable and fail over to the
    // next recovery without writing.
    assert.deepStrictEqual(bases, [V0])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    assert.strictEqual(server.syncs, 3) // activation + maxHeightRecoveries (2)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  // A slot whose first load was deferred on height has no verified value:
  // its mirror (and the slot default) must not be the reducer's basis.
  // `addChatRoomUnreadMessage` returns KV_NOOP on the default, which would
  // otherwise drop the write without an error.
  it('an update during a deferred first load merges against the server value', async () => {
    await deferFirstLoad()
    server.catchUpOnSync = true
    const bases: any[] = []
    assert.deepStrictEqual(await recordingUpdate(bases), MERGED_A2)
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
    assert.strictEqual(server.syncs, 2) // activation + one recovery
  })

  it('an update during a deferred first load rejects when the contract cannot catch up', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("onHeightAhead: 'reject' rejects at once during a deferred first load", async () => {
    await deferFirstLoad()
    const syncsBefore = server.syncs
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases, { onHeightAhead: 'reject' }), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(bases, [])
    assert.strictEqual(server.syncs, syncsBefore)
  })

  it('an update queued before the deferred reload reloads the slot itself', async () => {
    await deferFirstLoad()
    const lane = gateLane()
    const bases: any[] = []
    const updating = recordingUpdate(bases)
    // The height is reached: the deferred reload is queued behind the update,
    // so the update still finds the slot 'loading', with no height wait.
    setLocalHeight(42)
    lane.open()
    await lane.released
    assert.deepStrictEqual(await within(updating, 'the update queued before the reload'), MERGED_A2)
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
  })

  it('an update after a deferred first load gave up does not seed from the default', async () => {
    await deferFirstLoad()
    // The fallback sync doesn't help: the slot settles to 'error'.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    server.log.length = 0
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
  })

  it("an update after a loaded slot's refresh gave up does not seed from the stale value", async () => {
    await loadedRefreshGivesUp()
    // KV_NOOP on V0 (no roomB entry), but writes on VB.
    const reducer = addChatRoomUnreadMessage('roomB', 'b2', 5)
    assert.strictEqual(reducer(V0), KV_NOOP)
    assert.notStrictEqual(reducer(VB), KV_NOOP)
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases, { reducer }), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  // Device A loaded V0; a refresh then failed with a 500, so the slot is
  // 'error' and still holds V0, while the server holds VB, written at 42.
  // `update`'s data-loss-guard reload finds VB ahead.
  const errorSlotWithStaleValue = async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    const restore = failKvGets(1)
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    restore()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    server.log.length = 0
  }

  it("an 'error' slot whose retained value is ahead recovers instead of seeding from it", async () => {
    await errorSlotWithStaleValue()
    server.catchUpOnSync = true
    const syncsBefore = server.syncs
    const bases: any[] = []
    // A KV_NOOP on V0 (no roomB), which would drop the write.
    const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.strictEqual(server.syncs, syncsBefore + 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
  })

  it("an 'error' slot whose retained value is ahead rejects, then reloads at the height", async () => {
    await errorSlotWithStaleValue()
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
      }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(server.posts(), [])
    const getsBefore = server.gets().length
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore + 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it("an 'error' slot whose retained value is ahead: a writing reducer neither 412s nor waits", async () => {
    await errorSlotWithStaleValue()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000, pendingFallbackMs: 10000 })
    server.catchUpOnSync = true
    const started = Date.now()
    const result = await recordingUpdate([])
    assert.deepStrictEqual(result, MERGED_A2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.ok(Date.now() - started < 1000)
  })

  // The first load failed (500): the slot is 'error' without a value, and
  // the server holds VB, which this device can verify.
  const failedFirstLoad = async () => {
    await writeAsDeviceB(UNREAD, VB, 40)
    const restore = failKvGets(1)
    defineSlot({ key: UNREAD })
    await activateContract()
    restore()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).value, undefined)
    server.log.length = 0
  }

  it("an 'error' slot without a value reloads when the reducer is a KV_NOOP on the default", async () => {
    await failedFirstLoad()
    const bases: any[] = []
    const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    // The default first; the KV_NOOP then reloads, and the reducer runs on
    // the server value.
    assert.deepStrictEqual(bases, [{}, VB])
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
  })

  it("an 'error' slot without a value: a reducer that is a KV_NOOP on the default writes", async () => {
    await failedFirstLoad()
    const bases: any[] = []
    const result = await recordingUpdate(bases)
    assert.deepStrictEqual(bases, [{}, VB])
    assert.deepStrictEqual(result, MERGED_A2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it("an 'error' slot without a value whose reload fails: a KV_NOOP rejects with the error", async () => {
    await failedFirstLoad()
    for (const reducer of [
      deleteChatRoomUnreadMessages('roomB'), addChatRoomUnreadMessage('roomA', 'a2', 5)
    ]) {
      const restore = failKvGets(1)
      const bases: any[] = []
      await assert.rejects(
        recordingUpdate(bases, { reducer }),
        { name: 'ChelErrorUnexpectedHttpResponseCode' }
      )
      restore()
      // The reducer ran on the default, returned KV_NOOP, and ran on it
      // again once the reload failed.
      assert.deepStrictEqual(bases, [{}, {}])
    }
    assert.strictEqual(server.gets().length, 2)
    assert.deepStrictEqual(server.posts(), [])
    assert.ok('roomB' in server.value(UNREAD))
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
  })

  it("an 'error' slot without a value: a writing reducer merges on the 412 without reloading", async () => {
    await failedFirstLoad()
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
    assert.strictEqual(server.gets().length, 0)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.strictEqual(server.posts()[0].ifMatch, '""')
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it('a KV_NOOP rejects when the reload after a height recovery fails', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    // The refresh finds VB ahead: a height wait is registered.
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    server.log.length = 0
    server.catchUpOnSync = true
    const syncsAtStart = server.syncs
    // Every reload after the recovery sync fails.
    failKvGets(3, 500, () => server.syncs > syncsAtStart)
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
      }),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    assert.deepStrictEqual(server.posts(), [])
    assert.ok('roomB' in server.value(UNREAD))
  })

  it('a failed recovery sync is retried when the contract reached the height anyway', async () => {
    await setupStaleDeviceA()
    server.onSync = () => {
      // Pubsub delivered the missing events while the sync failed.
      setLocalHeight(42)
      throw new Error('sync failed')
    }
    assert.deepStrictEqual(await recordingUpdate([]), MERGED_A2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
    await untilWarned('failed during height recovery; retrying, since the contract reached height 42')
    assert.ok(!logged(warnings, 'giving up'))
  })

  it('a failed recovery sync rejects when the contract is still behind', async () => {
    await setupStaleDeviceA()
    server.onSync = () => { throw new Error('sync failed') }
    await assert.rejects(
      recordingUpdate([]),
      (e: any) => isKvHeightAhead(e) && kvHeightAheadCause(e)?.requiredHeight === 42
    )
    assert.strictEqual(localHeight(), 40)
    assert.deepStrictEqual(server.value(UNREAD), VB)
    await untilWarned('failed during height recovery; giving up on height recovery')
  })

  it('a timed-out recovery sync is retried when the contract reached the height anyway', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const started = Date.now()
    const updating = recordingUpdate([])
    await held.started
    later(() => setLocalHeight(42), 100)
    // The retry waits behind the sync, which still holds the contract's
    // lane after the 300 ms timeout.
    later(held.release, 600)
    assert.deepStrictEqual(await within(updating, 'the update'), MERGED_A2)
    assert.ok(Date.now() - started >= 600)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    await untilWarned('did not finish within 300 ms; retrying, since the contract reached height 42')
    assert.ok(!logged(warnings, 'giving up'))
  })

  it('a value that becomes verifiable during the wait is merged, not overwritten', async () => {
    // The height arrives 10 ms into the wait: leave the wait ample room.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
    await setupStaleDeviceA()
    server.onPost = (n) => {
      if (n === 1) later(() => advanceLocalHeightOnInternalLane(42), 10)
    }
    // With no recoveries left, `kv/set` waits passively (the write's only
    // chance).
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxHeightRecoveries: 0,
      updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [412, '40'], [204, '42']
    ])
    assert.strictEqual(server.syncs, 1) // no recovery needed
  })

  // A slot known to be stale reloads before its reducer runs. With no
  // recoveries left, that reload waits passively for the height too, as
  // `kv/set` would on the same attempt: `maxHeightRecoveries: 0` means
  // "wait, never sync" for a marked slot as for any other.
  for (const marked of [true, false]) {
    it(`maxHeightRecoveries: 0 waits for a height that arrives, without a sync (${marked ? 'a slot marked stale' : 'control: an unmarked slot'})`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000, pendingFallbackMs: 60000 })
      await setupStaleDeviceA()
      if (marked) {
        // The aggregate refresh finds VB ahead: the slot gets the marker.
        await sbp('chelonia/kv/sync', CONTRACT_ID)
        await drainLanes()
        assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
      }
      server.log.length = 0
      const syncsBefore = server.syncs
      const started = Date.now()
      later(() => setLocalHeight(42), 300)
      const result = await within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        maxHeightRecoveries: 0,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }), 'the update')
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 250 && elapsed < 1000, `resolved after ${elapsed} ms`)
      assert.deepStrictEqual(result, MERGED_A2)
      assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
      assert.strictEqual(server.syncs, syncsBefore)
    })
  }

  it("a slot marked stale with onHeightAhead: 'reject' still rejects at once", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000, pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    const started = Date.now()
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      onHeightAhead: 'reject',
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update'), (e: unknown) => isKvHeightAhead(e))
    assert.ok(Date.now() - started < 500, `rejected after ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts(), [])
  })

  it("queuedSet + async onconflict (saveCachedNames) keeps the other device's names", async () => {
    await namesWrittenAhead()
    server.log.length = 0
    server.onPost = (n) => {
      if (n === 1) {
        // Events 41, 42 arrive while the KV write is in flight. The
        // recovery sync, queued behind them, finds the contract at 42.
        sbp('chelonia/private/queueEvent', CONTRACT_ID, async () => {
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
      contractID: CONTRACT_ID, key: NS_CACHE, data: ['alice', 'carol'], onconflict
    })
    assert.deepStrictEqual(seen, [['alice', 'bob']])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('queuedSet recovers by syncing the contract when it does not catch up', async () => {
    await namesWrittenAhead()
    assert.strictEqual(localHeight(), 40)
    server.catchUpOnSync = true
    const seen: unknown[] = []
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['alice', 'carol'],
      onconflict: mergeNames(['alice', 'carol'], seen)
    })
    assert.deepStrictEqual(seen, [['alice', 'bob']])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('queuedSet rejects with ChelErrorKvHeightAhead when recovery cannot help', async () => {
    await namesWrittenAhead()
    const syncsBefore = server.syncs
    const seen: unknown[] = []
    await assert.rejects(
      sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
        key: NS_CACHE,
        data: ['alice', 'carol'],
        onconflict: mergeNames(['carol'], seen)
      }),
      (e: any) => isKvHeightAhead(e)
    )
    assert.strictEqual(seen.length, 0)
    assert.strictEqual(server.syncs, syncsBefore + 2) // maxHeightRecoveries (2)
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob'])
  })

  it('queuedSet passes allowUnverifiedConflict on to kv/set', async () => {
    await namesWrittenAhead()
    const seen: unknown[] = []
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['carol'],
      allowUnverifiedConflict: true,
      onHeightAhead: 'reject',
      onconflict: async (args: any) => {
        seen.push([args.currentStatus, args.requiredHeight])
        return false
      }
    })
    assert.deepStrictEqual(seen, [['ahead', 42]])
  })

  it('clear succeeds against a value that is ahead', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    await sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD)
    assert.strictEqual(server.value(UNREAD), null)
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
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
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 2 }),
      (e: any) => {
        // (`assert.ok` would narrow `e`, hiding `cause`.)
        assert.strictEqual(e.name, 'ChelErrorKvConflict')
        assert.strictEqual(isKvConflict(e), true)
        // The last response `kv/set` read, attempt 2's second 412: its
        // value fails the schema, so only its status and etag are
        // reported. Not VB, which only attempt 1 saw, nor bad1.
        assert.deepStrictEqual(e.cause, { currentStatus: 'present', etag: `"${bad2.cid}"` })
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
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    assert.deepStrictEqual(laneState, ['free'])
  })

  it("the caller's signal aborts a write that is waiting for recovery", async () => {
    await setupStaleDeviceA()
    const held = holdNextSync()
    const controller = new AbortController()
    const write = sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      signal: controller.signal,
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    await held.started
    // `_waitInFlight` (used by `chelonia/reset`) waits for the recovery sync.
    let drained = false
    const waiting = sbp('chelonia/kv/_waitInFlight').then(() => { drained = true })
    controller.abort(new Error('user navigated away'))
    await assert.rejects(write, (e: any) => e.message === 'user navigated away')
    await sleep(20)
    assert.strictEqual(drained, false)
    held.release()
    await within(waiting, '_waitInFlight once the recovery sync is released')
    assert.strictEqual(server.posts().length, 1)
  })

  it('rejects invalid height-recovery options before touching the network', async () => {
    await setupStaleDeviceA()
    const requestsBefore = server.requests.length
    // The message names the operation and the key.
    const invalid = (label: string) => (e: any) =>
      e instanceof ChelErrorKvUpdateInvalid && e.message.startsWith(`[chelonia/kv] ${label}: `)
    for (const options of [
      { onHeightAhead: 'retry' }, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 }
    ]) {
      await assert.rejects(
        sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: () => ({}), ...options
        }),
        invalid(`update: ${CONTRACT_ID}::${UNREAD}`)
      )
      await assert.rejects(
        sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, options),
        invalid(`clear: ${CONTRACT_ID}::${UNREAD}`)
      )
      await assert.rejects(
        sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, key: UNREAD, data: {}, ...options }),
        invalid(`queuedSet: ${CONTRACT_ID}::${UNREAD}`)
      )
    }
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  // Not a bound at all otherwise: `NaN` would retry a contended key forever.
  it('rejects an invalid maxAttempts before touching the network', async () => {
    await setupStaleDeviceA()
    const requestsBefore = server.requests.length
    const invalid = (label: string) => (e: any) =>
      e instanceof ChelErrorKvUpdateInvalid &&
      e.message === `[chelonia/kv] ${label}: \`maxAttempts\` must be an integer >= 1`
    for (const maxAttempts of [NaN, 0, -1, 1.5, Infinity, '3']) {
      await assert.rejects(
        sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: () => ({}), maxAttempts
        }),
        invalid(`update: ${CONTRACT_ID}::${UNREAD}`),
        String(maxAttempts)
      )
      await assert.rejects(
        sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts }),
        invalid(`clear: ${CONTRACT_ID}::${UNREAD}`),
        String(maxAttempts)
      )
      await assert.rejects(
        sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, key: UNREAD, data: {}, maxAttempts }),
        invalid(`queuedSet: ${CONTRACT_ID}::${UNREAD}`),
        String(maxAttempts)
      )
    }
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  it('an unknown slot with invalid options rejects with ChelErrorKvSlotUnknown', async () => {
    await setupStaleDeviceA()
    const options = { maxHeightRecoveries: -1 }
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, 'no-such-key', options),
      ChelErrorKvSlotUnknown
    )
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: 'no-such-key', updater: () => ({}), ...options
      }),
      ChelErrorKvSlotUnknown
    )
  })

  it('queuedSet running out of attempts rejects with ChelErrorKvConflict', async () => {
    const a = await writeAsDeviceB(NS_CACHE, ['alice'], 40)
    const b = await writeAsDeviceB(NS_CACHE, ['bob'], 40)
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    server.log.length = 0
    // Another device wins every race.
    server.onPost = () => {
      server.store.set(NS_CACHE, server.store.get(NS_CACHE) === a ? b : a)
    }
    let conflicts = 0
    await assert.rejects(
      sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
        key: NS_CACHE,
        data: ['carol'],
        onconflict: async ({ currentData = [], etag }: any) => {
          conflicts++
          return [[...currentData, 'carol'], etag]
        }
      }),
      (e: any) => {
        // (`assert.ok` would narrow `e`, hiding `cause`.)
        assert.strictEqual(e.name, 'ChelErrorKvConflict')
        assert.strictEqual(isKvConflict(e), true)
        assert.ok(e.message.startsWith(`[chelonia/kv] queuedSet: ${CONTRACT_ID}::${NS_CACHE} `))
        // The server value and etag the last 412 carried (what the server
        // still holds).
        const last = server.store.get(NS_CACHE)!
        assert.deepStrictEqual(e.cause.currentData, last === a ? ['alice'] : ['bob'])
        assert.strictEqual(e.cause.etag, `"${last.cid}"`)
        return true
      }
    )
    assert.strictEqual(conflicts, 2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412, 412])
  })

  // A blind write doesn't depend on the value, so no recovery can help it:
  // running out of attempts is plain contention. (`update` still defers a
  // reload; see "a write that gives up on a value that is ahead".)
  it('a clear that runs out of attempts on a value that is ahead rejects with a conflict, and defers no reload', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, waitMs: 3000 })
    await setupStaleDeviceA()
    const syncsBefore = server.syncs
    server.log.length = 0
    const started = Date.now()
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }),
      (e: any) => {
        assert.strictEqual(isKvConflict(e), true)
        assert.strictEqual(isKvHeightAhead(e), false)
        // The last 412's etag: what the server still holds.
        assert.strictEqual(e.cause.etag, server.etagOf(UNREAD))
        return true
      }
    )
    // No passive wait for the value's height either.
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("a clear that runs out of attempts on a settled 'non-init' slot leaves it 'non-init'", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    // Values written at 42 by other devices; one of them lands before
    // every POST (the server checks if-match before the height stamp).
    const entries: Array<{ body: string; cid: string }> = []
    for (let i = 0; i < 3; i++) entries.push(await writeAsDeviceB(UNREAD, { roomA: room(`x${i}`, i) }, 42))
    server.store.delete(UNREAD)
    server.onPost = (n) => { server.store.set(UNREAD, entries[(n - 1) % entries.length]) }
    const syncsBefore = server.syncs
    server.log.length = 0
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 2 }),
      (e: any) => {
        assert.strictEqual(isKvConflict(e), true)
        assert.strictEqual(e.cause.etag, `"${entries[1].cid}"`)
        return true
      }
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412])
    assert.strictEqual(server.syncs, syncsBefore)
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
  })

  it('a committed clear ends the height wait the key had, and its marker', async () => {
    await loadV0At40()
    // A stored value stamped above any height the contract reaches here.
    restamp(UNREAD, '100')
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await untilWarned('keeping the current mirror value')
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 100 })
    server.log.length = 0
    await sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
    // No wait is left: reaching the height reloads nothing, and the next
    // update uses the mirror as its basis.
    setLocalHeight(100)
    await drainLanes()
    assert.strictEqual(server.gets().length, 0)
    assert.strictEqual(await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomZ')
    }), undefined)
    assert.strictEqual(server.gets().length, 0)
  })
})

// `update`, `clear` and `queuedSet` sync and retry when the server requires
// a height the local contract hasn't reached, so they don't let `kv/set`
// wait passively for it first (with the contract's lane held), except on
// their last attempt; with `onHeightAhead: 'reject'` they never wait.
describe('the passive height wait, with production timings', () => {
  // The slot is loaded at 40, and the server has processed contract events
  // (no KV change) up to 42, which a recovery sync delivers.
  const loadedThenServerMovesOn = async () => {
    await loadV0At40()
    server.height = 42
    server.catchUpOnSync = true
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: null })
    server.log.length = 0
  }
  // Queues a task on the contract's public lane 50 ms after `started`, and
  // records when (relative to `started`) it ran.
  const probeLane = (started: number) => {
    const probe: { ranAt?: number } = {}
    later(() => {
      sbp('chelonia/queueInvocation', CONTRACT_ID, () => { probe.ranAt = Date.now() - started })
    }, 50)
    return probe
  }

  for (const [name, write] of heightWrites()) {
    it(`${name} on a client that is behind syncs at once, without holding the lane`, async () => {
      await loadedThenServerMovesOn()
      // A passive wait would take 2 s.
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
      const started = Date.now()
      const lane = probeLane(started)
      await write()
      assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
      await until(() => lane.ranAt !== undefined, 'the lane probe never ran')
      assert.ok(lane.ranAt! < 1000, `the lane probe ran after ${lane.ranAt} ms`)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
      assert.strictEqual(server.syncs, 2) // activation + one recovery
    })
  }

  it('a server that keeps moving costs one sync per stale stamp, not a wait', async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
    // The server moves one event further with the first two POSTs.
    server.onPost = (n) => { if (n <= 2) server.height = 41 + n }
    const started = Date.now()
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '40'], [409, '42'], [204, '43']
    ])
    assert.strictEqual(server.syncs, 3) // activation + two recoveries
  })

  // Each of the first three POSTs finds the server one event further on (a
  // 409), and pubsub brings that event 20 ms later: the recoveries keep
  // falling one event short, and only the last attempt's passive wait lets
  // the write through.
  for (const [name, write] of heightWrites()) {
    it(`${name}'s last attempt waits passively for a height that is about to arrive`, async () => {
      await loadedThenServerMovesOn()
      server.height = 40
      server.onPost = (n) => {
        if (n > 3) return
        const height = ++server.height
        later(() => { if (localHeight() < height) setLocalHeight(height) }, 20)
      }
      await within(write(), `${name} settles`, 5000)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
        [409, '40'], [409, '41'], [409, '42'], [204, '43']
      ])
      assert.strictEqual(server.syncs, 3) // activation + two recoveries
    })
  }

  for (const [name, write] of heightWrites({ onHeightAhead: 'reject' })) {
    it(`${name} with onHeightAhead: 'reject' rejects without waiting, and frees the lane`, async () => {
      await loadedThenServerMovesOn()
      // A passive wait would take 3 s.
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
      const started = Date.now()
      const lane = probeLane(started)
      await assert.rejects(within(write(), `${name} settles`, 5000), (e: unknown) => isKvHeightAhead(e))
      assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
      await until(() => lane.ranAt !== undefined, 'the lane probe never ran')
      assert.ok(lane.ranAt! < 1000, `the lane probe ran after ${lane.ranAt} ms`)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40']])
      assert.strictEqual(server.syncs, 1) // activation only
    })
  }

  it('raw kv/set waits passively, unless given heightWaitMs: 0', async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000 })
    const set = (options: Record<string, unknown> = {}) => sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId, ...options
    })
    let started = Date.now()
    await assert.rejects(set(), (e: unknown) => isKvHeightAhead(e))
    assert.ok(Date.now() - started >= 1000)
    started = Date.now()
    await assert.rejects(set({ heightWaitMs: 0 }), (e: unknown) => isKvHeightAhead(e))
    assert.ok(Date.now() - started < 500)
    // A height already reached needs no wait.
    setLocalHeight(42)
    await set({ heightWaitMs: 0 })
    for (const heightWaitMs of [-1, NaN, Infinity, '0']) {
      await assert.rejects(set({ heightWaitMs }), TypeError)
    }
  })
})

// This file never connects, so `kv/set`'s passive wait isn't skipped for a
// closed socket: only `update`'s own choice (no wait while recoveries are
// left) skips it.
describe('writes without a pubsub client', () => {
  it('a stale stamp (409) goes straight to the recovery sync, without the passive wait', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500 })
    await loadV0At40()
    // The server moved on without changing the key (e.g. a contract event
    // this device missed while its socket was down).
    server.height = 41
    server.catchUpOnSync = true
    server.log.length = 0
    const started = Date.now()
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'kv/update')
    const firstSync = server.requests.find((r) =>
      r.at >= started && r.path.startsWith('/latestHEADinfo/')
    )?.at
    assert.ok(firstSync !== undefined, 'no recovery sync')
    assert.ok(firstSync - started < 500, `first sync after ${firstSync - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
  })
})

// The height recovery docs/kv.md suggests to raw `kv/set` callers.
describe('chelonia/kv/withHeightRecovery', () => {
  type AttemptInfo = { recoveries: number; heightWaitMs: 0 | undefined }
  // A raw `kv/set` of `data` under `key`, wrapped as docs/kv.md shows. Each
  // attempt's info is pushed to `seen`.
  const recoveredSet = (
    key: string,
    data: JSONType,
    options: Record<string, unknown> = {},
    seen: AttemptInfo[] = []
  ): Promise<{ etag: string | null }> => {
    const ifMatch = server.etagOf(key)
    return sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (info: AttemptInfo) => {
      seen.push(info)
      return sbp('chelonia/queueInvocation', CONTRACT_ID, () =>
        sbp('chelonia/kv/set', CONTRACT_ID, key, data, {
          ifMatch, signingKeyId: cskId, encryptionKeyId: cekId, heightWaitMs: info.heightWaitMs
        }))
    }, options)
  }
  // The server has processed contract events (no KV change) that this
  // client hasn't: its next write of each of `keys` gets a 409. (A
  // recovery racing a release is in `sync-contract.test.ts`.)
  const behind = async ({ keys = [UNREAD] } = {}) => {
    for (const key of keys) await writeAsDeviceB(key, V0, 40)
    await subscribeContract()
    await sbp('chelonia/contract/retain', CONTRACT_ID)
    server.height = 42
    server.log.length = 0
  }

  it('recovers once the sync brings the contract up to date', async () => {
    await behind()
    server.catchUpOnSync = true
    const seen: AttemptInfo[] = []
    await within(recoveredSet(UNREAD, VB, {}, seen), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    assert.deepStrictEqual(seen, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: 0 }
    ])
  })

  it('retries when its sync fails but the contract reached the height anyway', async () => {
    await behind()
    server.onSync = () => {
      setLocalHeight(42)
      throw new Error('sync failed (503)')
    }
    await within(recoveredSet(UNREAD, VB), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    assert.ok(logged(warnings, 'retrying, since the contract reached height'))
  })

  it("rejects with the write's error when the sync fails", async () => {
    await behind()
    server.onSync = () => { throw new Error('sync failed (503)') }
    await assert.rejects(
      within(recoveredSet(UNREAD, VB), 'the write settles'), (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
    assert.ok(logged(warnings, 'giving up on height recovery'))
  })

  it('retries when its sync fails but the height arrives within the passive wait after it', async () => {
    await behind()
    server.onSync = () => {
      // E.g. pubsub delivers the missing events shortly after the sync
      // failed (within the 50 ms test wait).
      later(() => setLocalHeight(42), 20)
      throw new Error('sync failed (503)')
    }
    await within(recoveredSet(UNREAD, VB), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    // (A 409's required height is a lower bound: 41.)
    assert.ok(logged(warnings, 'retrying, since the contract reached height 41 anyway'))
  })

  it('runs no sync when the contract reached the height after the attempt failed', async () => {
    await behind()
    const syncsBefore = server.syncs
    let attempts = 0
    const result = await within(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, () => {
      if (++attempts > 1) return Promise.resolve('done')
      // E.g. pubsub brought the contract there after the server rejected
      // the write.
      setLocalHeight(42)
      return Promise.reject(new ChelErrorKvHeightAhead('ahead', {
        cause: { requiredHeight: 42, exact: true }
      }))
    }), 'the recovery')
    assert.strictEqual(result, 'done')
    assert.strictEqual(attempts, 2)
    assert.strictEqual(server.syncs, syncsBefore)
  })

  it('an already-aborted signal rejects before the first attempt', async () => {
    await behind()
    const controller = new AbortController()
    controller.abort()
    const requestsBefore = server.requests.length
    const seen: AttemptInfo[] = []
    await assert.rejects(
      within(recoveredSet(UNREAD, VB, { signal: controller.signal }, seen), 'the write settles'),
      { name: 'AbortError' }
    )
    assert.deepStrictEqual(seen, [])
    // queuedSet, which passes its signal on to `kv/set` too, sends nothing.
    await assert.rejects(
      within(sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID, key: UNREAD, data: VB, signal: controller.signal
      }), 'queuedSet'),
      { name: 'AbortError' }
    )
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  it('concurrent writes share one sync', async () => {
    const keys = ['k1', 'k2', 'k3']
    await behind({ keys })
    server.catchUpOnSync = true
    server.onSync = () => sleep(200)
    const syncsBefore = server.syncs
    await within(
      Promise.all(keys.map((key) => recoveredSet(key, VB))), 'the writes settle', 5000
    )
    assert.strictEqual(server.syncs - syncsBefore, 1)
    for (const key of keys) assert.deepStrictEqual(server.value(key), VB)
  })

  it('passes heightWaitMs: 0 until the last attempt, which waits passively', async () => {
    await behind()
    // The recovery sync doesn't bring the contract up to date; the height
    // arrives (e.g. through pubsub) during the last attempt's passive wait.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const seen: AttemptInfo[] = []
    server.onPost = (n) => {
      if (n === 2) later(() => setLocalHeight(42), 50)
    }
    await within(
      recoveredSet(UNREAD, VB, { maxHeightRecoveries: 1 }, seen), 'the write settles', 2000
    )
    assert.deepStrictEqual(seen, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: undefined }
    ])
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '40'], [409, '40'], [204, '42']
    ])
  })

  it("with onHeightAhead: 'reject', runs one attempt, without waiting or syncing", async () => {
    await behind()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const seen: AttemptInfo[] = []
    const syncsBefore = server.syncs
    const started = Date.now()
    await assert.rejects(
      within(recoveredSet(UNREAD, VB, { onHeightAhead: 'reject' }, seen), 'the write settles'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
    assert.deepStrictEqual(seen, [{ recoveries: 0, heightWaitMs: 0 }])
    assert.strictEqual(server.syncs, syncsBefore)
  })

  it('rejects invalid options, and an attempt that is not a function, before running it', async () => {
    let attempts = 0
    const attempt = () => { attempts++; return Promise.resolve() }
    for (const options of [
      { onHeightAhead: 'never' }, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 }
    ]) {
      await assert.rejects(
        sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, attempt, options),
        (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
          e.message.startsWith(`[chelonia/kv] withHeightRecovery: ${CONTRACT_ID}: `)
      )
    }
    await assert.rejects(
      sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, attempt, {
        maxHeightRecoveries: -1, label: 'myWrite'
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
        e.message.startsWith('[chelonia/kv] myWrite: ')
    )
    await assert.rejects(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, null), TypeError)
    assert.strictEqual(attempts, 0)
  })

  it('takes null options as the defaults', async () => {
    const seen: AttemptInfo[] = []
    const recovering = sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (info: AttemptInfo) => {
      seen.push(info)
      return Promise.resolve('done')
    }, null)
    assert.ok(recovering instanceof Promise)
    assert.strictEqual(await within(recovering, 'the recovery'), 'done')
    assert.deepStrictEqual(seen, [{ recoveries: 0, heightWaitMs: 0 }])
  })

  // Awaited there, they would deadlock the contract's lanes (the update that
  // ran the callback holds the public lane), as `update` and `clear` would.
  describe('called synchronously from an onUpdate of the same contract', () => {
    // `call` runs from the onUpdate of UNREAD's next local update, and its
    // outcome is pushed to `seen`. With `awaited`, the callback waits for
    // it, as an app awaiting it would (but only until the end of the test).
    const fromOnUpdate = async (call: () => Promise<unknown>, { awaited = true } = {}) => {
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      addTeardown(release)
      let armed = false
      const seen: unknown[] = []
      defineSlot({
        key: UNREAD,
        onUpdate: (_value: unknown, uctx: any) => {
          if (!armed || uctx.reason !== 'local') return
          armed = false
          const p = call()
          p.then(() => seen.push('resolved'), (e: any) => seen.push(e?.name))
          if (awaited) return Promise.race([p, released])
        }
      })
      await writeAsDeviceB(UNREAD, V0, 40)
      await activateContract()
      server.log.length = 0
      armed = true
      const updating = sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      })
      return { seen, updating }
    }
    const queuedSet = () => sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: NS_CACHE, data: ['x'], ifMatch: '*'
    })

    for (const [name, call] of [
      ['queuedSet', queuedSet],
      ['withHeightRecovery', () => recoveredSet(NS_CACHE, ['x'])]
    ] as const) {
      it(`${name} rejects with ChelErrorKvReentrant`, async () => {
        const { seen, updating } = await fromOnUpdate(call)
        await within(updating, 'the outer update')
        await until(() => seen.length > 0, `${name} settled`)
        assert.deepStrictEqual(seen, ['ChelErrorKvReentrant'])
        assert.deepStrictEqual(server.posts().map((p) => p.key), [UNREAD])
      })
    }

    it('queuedSet scheduled with queueMicrotask, and not awaited there, succeeds', async () => {
      const { seen, updating } = await fromOnUpdate(() => new Promise((resolve, reject) => {
        queueMicrotask(() => { queuedSet().then(resolve, reject) })
      }), { awaited: false })
      await within(updating, 'the outer update')
      await until(() => seen.length > 0, 'queuedSet settled')
      assert.deepStrictEqual(seen, ['resolved'])
      assert.deepStrictEqual(server.value(NS_CACHE), ['x'])
    })
  })
})

// An `update` that gives up on a server value it can't verify records it as
// a load that found it would: the slot stops presenting "no value", a
// `KV_NOOP` can't resolve against the stale mirror, and the slot reloads
// once the contract reaches the height.
describe('an update that gives up on a value that is ahead', () => {
  // A slot whose first load found no value (settled 'non-init'); then
  // device B writes VB at height 42 while this device stays at 40.
  const settledEmptySlotThenBWrites = async () => {
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
    await writeAsDeviceB(UNREAD, VB, 42)
    assert.strictEqual(localHeight(), 40)
    server.log.length = 0
  }

  const settledWithin100ms = async () => {
    const controller = new AbortController()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD, {
      signal: controller.signal
    }) as Promise<string>
    settling.catch(() => {})
    const outcome = await settledOr(settling, 100, 'pending')
    controller.abort()
    return outcome
  }

  const assertRecorded = async (status: 'loading' | 'loaded') => {
    assert.strictEqual(slotStatus(UNREAD), status)
    assert.strictEqual(await settledWithin100ms(), status === 'loading' ? 'pending' : 'loaded')
    // Deleting roomB is a KV_NOOP on the stale mirror: the update reloads
    // first, finds VB still ahead, and rejects instead of resolving.
    const requestsBefore = server.requests.length
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: deleteChatRoomUnreadMessages('roomB')
      }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.strictEqual(server.requests.length - requestsBefore, 1)
    const getsBefore = server.gets().length
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length - getsBefore, 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  }

  const write = (options: Record<string, unknown> = {}) => within(sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID,
    key: UNREAD,
    updater: initChatRoomUnreadMessages('roomC', 'c1', 1),
    ...options
  }), 'the update never settled', 5000)

  const isAheadAt42 = (e: unknown) =>
    isKvHeightAhead(e) && kvHeightAheadCause(e)?.requiredHeight === 42

  const failures: Array<[string, () => Promise<void>]> = [
    ["onHeightAhead: 'reject'", async () => {
      await assert.rejects(write({ onHeightAhead: 'reject' }), isAheadAt42)
    }],
    ['maxHeightRecoveries: 0', async () => {
      await assert.rejects(write({ maxHeightRecoveries: 0 }), isAheadAt42)
      assert.strictEqual(server.syncs, 1) // activation only
    }],
    ['a recovery sync that fails', async () => {
      server.onSync = () => { throw new Error('sync failed') }
      await assert.rejects(write(), isAheadAt42)
      server.onSync = null
    }],
    ['a recovery sync that times out', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 200 })
      const held = holdNextSync()
      await assert.rejects(write(), isAheadAt42)
      held.release()
      await drainLanes()
    }]
  ]

  for (const [name, giveUp] of failures) {
    it(`after ${name}, a settled 'non-init' slot is 'loading' until it loads`, async () => {
      // Keep the deferred-reload fallback out of the way.
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await settledEmptySlotThenBWrites()
      await giveUp()
      assert.deepStrictEqual(server.value(UNREAD), VB)
      await assertRecorded('loading')
    })
  }

  it("after onHeightAhead: 'reject', a loaded slot stays 'loaded' and the next update reloads first", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await assert.rejects(write({ onHeightAhead: 'reject' }), isAheadAt42)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    await assertRecorded('loaded')
  })

  // An abort ends the recovery of a write whose value was ahead: that value
  // is recorded all the same.
  it("after an abort during the recovery, a settled 'non-init' slot is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await settledEmptySlotThenBWrites()
    const held = holdNextSync()
    const controller = new AbortController()
    const writing = write({ signal: controller.signal })
    await held.started
    controller.abort()
    await assert.rejects(writing, { name: 'AbortError' })
    assert.strictEqual(heightWait(UNREAD)?.requiredHeight, 42)
    held.release()
    await drainLanes()
    assert.deepStrictEqual(server.value(UNREAD), VB)
    await assertRecorded('loading')
  })

  // While the reset runs, the wait is only remembered; the failed reset
  // registers it again, as the session goes on. (The reset first waits for
  // the contract's lanes, so it aborts the recovery in the passive wait
  // that follows a failed sync, outside the lanes.)
  it("after a failed reset during the recovery, a settled 'non-init' slot is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, waitMs: 10000 })
    await settledEmptySlotThenBWrites()
    const syncsBefore = server.syncs
    server.onSync = () => { throw new Error('sync failed (503)') }
    const writing = write()
    await until(() => server.syncs === syncsBefore + 1, 'the recovery sync')
    let outcome: string | undefined
    await assert.rejects(within(sbp('chelonia/reset', async () => {
      outcome = await writing.then(() => 'resolved', (e: any) => e.name)
      assert.strictEqual(heightWait(UNREAD), undefined)
      throw new Error('persist failed')
    }), 'the reset'), /persist failed/)
    server.onSync = null
    assert.strictEqual(outcome, 'AbortError')
    assert.strictEqual(heightWait(UNREAD)?.requiredHeight, 42)
    await drainLanes()
    await assertRecorded('loading')
  })
})

// What an app-level height guard (e.g. Group Income's `kv-guard.js`) did,
// and which the library now does instead: these must keep holding for such
// a guard to stay deleted.
describe('guarantees that replace an app-level height guard', () => {
  it('queuedSet recovers with the queue lane released', async () => {
    await namesWrittenAhead()
    server.catchUpOnSync = true
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['carol'],
      onconflict: mergeNames(['carol'])
    })
    assert.deepStrictEqual(laneState, ['free'])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('single-key kv/sync recovers with the queue lane released', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(laneState, ['free'])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  // E.g. a chatroom contract's side effect (internal lane), or a pubsub
  // handler such as `MESSAGE_RECEIVE_RAW`'s (public lane), that updates an
  // identity slot.
  for (const [lane, selector] of [
    ['internal', 'chelonia/private/queueEvent'],
    ['public', 'chelonia/queueInvocation']
  ] as const) {
    it(`a recovering write awaited on another contract's ${lane} lane completes`, async () => {
      await setupStaleDeviceA()
      server.catchUpOnSync = true
      const writing = sbp(selector, 'zKvHeightTestChatroomContract', () =>
        sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
        })
      )
      const outcome = await within(writing, `the write awaited on the other ${lane} lane`)
      assert.deepStrictEqual(outcome, { ...VB, roomC: room('c1', 3) })
      // The value that is ahead (412), then the write after the recovery.
      assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    })
  }

  it('a KV_NOOP on a verified, loaded slot makes no request', async () => {
    await loadV0At40()
    const before = server.requests.length
    assert.strictEqual(await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), undefined)
    assert.strictEqual(server.requests.length, before)
  })

  it('a write while the contract is up to date runs no contract sync', async () => {
    await loadV0At40()
    const syncsBefore = server.syncs
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it('concurrent recovering writes share one contract sync', async () => {
    const keys = ['a', 'b', 'c']
    for (const key of keys) await writeAsDeviceB(key, { v: 0 }, 40)
    for (const key of keys) defineSlot({ key })
    await activateContract()
    for (const key of keys) await writeAsDeviceB(key, { v: 1 }, 42)
    server.catchUpOnSync = true
    // Slow enough that all three writes (serialized on the lane, each
    // rejecting at once, with no passive wait) fail before the first
    // recovery sync ends, so their recoveries overlap.
    server.onSync = () => sleep(200)
    const syncsBefore = server.syncs
    await Promise.all(keys.map((key) => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key, updater: (prev: any) => ({ ...prev, w: key })
    })))
    assert.strictEqual(server.syncs, syncsBefore + 1)
    for (const key of keys) assert.deepStrictEqual(server.value(key), { v: 1, w: key })
  })

  it('a recovery that times out while still behind rejects with the original error', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
      }), 'the update never settled', 2000),
      (e: any) => isKvHeightAhead(e) && kvHeightAheadCause(e)?.requiredHeight === 42
    )
    assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
    held.release()
    await drainLanes()
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a deferred first load calls onUpdate once, with the server value', async () => {
    const calls: unknown[] = []
    await deferFirstLoad({ onUpdate: (value: unknown) => { calls.push(value) } })
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.deepStrictEqual(calls, [VB])
  })

  it('a deferred first load that gives up never calls onUpdate', async () => {
    const calls: unknown[] = []
    await deferFirstLoad({ onUpdate: (value: unknown) => { calls.push(value) } })
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    await drainLanes()
    assert.deepStrictEqual(calls, [])
  })
})

describe('loads while the local contract is behind', () => {
  it('a first load that is ahead stays pending, then loads once the contract catches up', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    server.log.length = 0
    // A settled-based gate, as Group Income's unread-messages gate becomes:
    // the slot has settled when `settled && status !== 'loading'`.
    const flushed: unknown[] = []
    const { events, off } = collectStatusEvents(UNREAD)
    const offGate = onEvent(CHELONIA_KV_STATUS_CHANGED, (p: any) => {
      if (
        p.contractID === CONTRACT_ID && p.key === UNREAD && p.settled && p.status !== 'loading'
      ) {
        flushed.push(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD))
      }
    })
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.deepStrictEqual(flushed, [])

    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    off()
    offGate()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.deepStrictEqual(flushed, [VB])
    // The status event in between announces `heightAhead` (status unchanged).
    assert.deepStrictEqual(events.map((e) => [
      e.previousStatus, e.status, e.settled, e.heightAhead?.requiredHeight ?? null
    ]), [
      ['non-init', 'loading', false, null],
      ['loading', 'loading', false, 42],
      ['loading', 'loaded', true, null]
    ])
  })

  it('a pending load settles to error when the contract never catches up', async () => {
    await deferFirstLoad()
    const settledAs = whenSettledWithin(UNREAD)
    const syncsBefore = server.syncs
    assert.strictEqual(await settledAs, 'error')
    assert.strictEqual(server.syncs, syncsBefore + 1) // the fallback sync
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    assert.strictEqual(mirror(UNREAD).settled, true)
  })

  it('the fallback sync reloads the slot when it brings the contract up to date', async () => {
    await deferFirstLoad()
    server.catchUpOnSync = true
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('single-key kv/sync recovers from a value that is ahead', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    server.catchUpOnSync = true
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('single-key kv/sync loads when its recovery sync fails but the height is reached', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    server.onSync = () => {
      setLocalHeight(42)
      throw new Error('sync failed')
    }
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('single-key kv/sync keeps a loaded value when it cannot catch up', async () => {
    const { e0 } = await setupStaleDeviceA()
    const syncsBefore = server.syncs
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), (e: unknown) => isKvHeightAhead(e))
    assert.strictEqual(server.syncs, syncsBefore + 2) // maxHeightRecoveries (2)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, e0)
  })

  // A slot that hasn't loaded yet (on-demand), whose server value is ahead.
  const onDemandSlotAhead = async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    server.log.length = 0
  }

  it("single-key kv/sync honours the caller's signal and keeps the slot deferred", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 5000, pendingFallbackMs: 10000 })
    await onDemandSlotAhead()
    const controller = new AbortController()
    const started = Date.now()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
    // Parking its deferred reload marks the slot, right before the wait.
    await until(() => mirror(UNREAD)?.heightAhead !== undefined, 'kv/sync never waited')
    controller.abort(new Error('user navigated away'))
    await assert.rejects(syncing, (e: any) => e.message === 'user navigated away')
    assert.ok(Date.now() - started < 1000)
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    // The deferred reload is still registered: reaching the height loads it.
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('single-key kv/sync rejects with an abort that lands as its passive wait succeeds', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000, pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    const controller = new AbortController()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
    // Parking its deferred reload marks the slot, right before the wait.
    await until(() => mirror(UNREAD)?.heightAhead !== undefined, 'kv/sync never waited')
    // Wakes the wait synchronously, and the caller aborts in the same tick.
    setLocalHeight(42)
    controller.abort(new Error('caller gave up'))
    await assert.rejects(syncing, /caller gave up/)
    // The slot's own deferred reload still loads it.
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.strictEqual(server.gets().length, 2)
  })

  // The load goes on after the abort, and records its outcome on the slot.
  for (const [where, hold] of [
    ['while its GET is in flight', async () => {
      const gets = holdGets()
      return {
        started: () => until(() => kvGetsRequested() >= 1, 'kv/sync never issued its GET'),
        release: gets.release
      }
    }],
    ['while its load waits behind a busy lane', async () => {
      const lane = gateLane()
      return {
        // The gate, and the load queued behind it.
        started: () => until(() => publicLaneQueued() >= 2, "kv/sync's load never queued"),
        release: lane.open
      }
    }]
  ] as const) {
    it(`single-key kv/sync rejects at once at an abort ${where}`, async () => {
      await loadV0At40()
      await writeAsDeviceB(UNREAD, VB, 40)
      const { started, release } = await hold()
      const controller = new AbortController()
      const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
      await started()
      const abortedAt = Date.now()
      controller.abort(new Error('caller gave up'))
      await assert.rejects(within(syncing, 'kv/sync settles'), /caller gave up/)
      assert.ok(Date.now() - abortedAt < 1000, `rejected ${Date.now() - abortedAt} ms after the abort`)
      release()
      await drainLanes()
      assert.strictEqual(slotStatus(UNREAD), 'loaded')
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    })
  }

  // The slot is loaded with V0, and the server value (VB) is ahead.
  for (const [how, arrange] of [
    ['by the recovery sync', async () => { server.catchUpOnSync = true }],
    ['during the passive wait', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000 })
      // Parking its deferred reload marks the slot, right before the wait.
      await until(() => mirror(UNREAD)?.heightAhead !== undefined, 'kv/sync never waited')
      setLocalHeight(42)
    }]
  ] as const) {
    it(`single-key kv/sync loads once when the height is reached ${how}`, async () => {
      const onUpdates: string[] = []
      await writeAsDeviceB(UNREAD, V0, 40)
      defineSlot({
        key: UNREAD, onUpdate: (_v: unknown, ctx: any) => { onUpdates.push(ctx.reason) }
      })
      await activateContract()
      onUpdates.length = 0
      await writeAsDeviceB(UNREAD, VB, 42)
      server.log.length = 0
      const events: string[] = []
      onEvent(CHELONIA_KV_UPDATED, (p: any) => { if (p.key === UNREAD) events.push(p.reason) })
      const arranged = arrange()
      await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
      await arranged
      await drainLanes()
      // The first GET finds VB ahead; the reload that reaching the height
      // fires is the only other one.
      assert.strictEqual(server.gets().length, 2)
      assert.deepStrictEqual(events, ['load'])
      assert.deepStrictEqual(onUpdates, ['load'])
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    })
  }

  it("single-key kv/sync with onHeightAhead: 'reject' neither waits nor syncs", async () => {
    // A passive wait would take the full 5 s.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 5000, pendingFallbackMs: 10000 })
    await onDemandSlotAhead()
    const syncsBefore = server.syncs
    const started = Date.now()
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { onHeightAhead: 'reject' }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 1000, `waited ${Date.now() - started} ms`)
    assert.strictEqual(server.syncs, syncsBefore)
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
  })

  // Like `onHeightAhead: 'reject'`: no recovery from this call, so the
  // deferred reload keeps its fallback.
  for (const catchUp of [false, true]) {
    it(`single-key kv/sync with maxHeightRecoveries: 0 leaves the slot to its fallback${catchUp ? ', which catches up' : ''}`, async () => {
      await onDemandSlotAhead()
      server.catchUpOnSync = catchUp
      const syncsBefore = server.syncs
      await assert.rejects(
        sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 0 }),
        (e: unknown) => isKvHeightAhead(e)
      )
      assert.strictEqual(server.syncs, syncsBefore)
      assert.strictEqual(server.gets().length, 1)
      assert.strictEqual(slotStatus(UNREAD), 'loading')
      // The 300 ms fallback syncs once, then gives up or reloads.
      assert.strictEqual(await whenSettledWithin(UNREAD, 2000), catchUp ? 'loaded' : 'error')
      assert.strictEqual(server.syncs, syncsBefore + 1)
    })
  }

  it('a deferred load that gives up without a local height says the contract is not loaded', async () => {
    await onDemandSlotAhead()
    delete (rootState().contracts[CONTRACT_ID] as any).height
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { onHeightAhead: 'reject' }),
      (e: unknown) => isKvHeightAhead(e)
    )
    // The 300 ms fallback gives up.
    assert.strictEqual(await whenSettledWithin(UNREAD, 2000), 'error')
    assert.ok(
      mirror(UNREAD).lastError?.message.endsWith(
        'was written at contract height 42, but the local contract is not loaded'
      ),
      mirror(UNREAD).lastError?.message
    )
  })

  it('single-key kv/sync rejects invalid height options before any request', async () => {
    await onDemandSlotAhead()
    const requestsBefore = server.requests.length
    for (const options of [
      { onHeightAhead: 'retry' }, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 }
    ]) {
      await assert.rejects(
        sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, options),
        (e: any) => e instanceof ChelErrorKvUpdateInvalid &&
          e.message.startsWith(`[chelonia/kv] sync: ${CONTRACT_ID}::${UNREAD}: `)
      )
    }
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  it("cleaning up the contract's KV runtime cancels deferred reloads", async () => {
    await deferFirstLoad()
    sbp('chelonia/kv/_cleanupContractRuntime', CONTRACT_ID)
    // Before the height is reached: a wait left behind would still be in
    // the index (reaching the height would remove it, hiding the leak).
    sbp('chelonia/kv/_assertIndexConsistent')
    const getsBefore = server.gets().length
    const syncsBefore = server.syncs
    await sleep(400) // past the 300 ms fallback
    assert.strictEqual(server.gets().length, getsBefore)
    assert.strictEqual(server.syncs, syncsBefore)
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore)
  })

  it('a deferred reload that gave up still reloads once the contract catches up', async () => {
    await loadedRefreshGivesUp()
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
  })

  it('a new load that finds the value still ahead falls back again', async () => {
    await loadedRefreshGivesUp()
    warnings.length = 0
    const syncsBefore = server.syncs
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await untilWarned('keeping the current mirror value')
    assert.strictEqual(server.syncs, syncsBefore + 1) // the new fallback sync
    assert.strictEqual(server.gets().length, 1)
    // Gave up again, and still reloads at the height.
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 2)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it("cleaning up the contract's KV runtime cancels a deferred reload that gave up", async () => {
    await loadedRefreshGivesUp()
    sbp('chelonia/kv/_cleanupContractRuntime', CONTRACT_ID)
    sbp('chelonia/kv/_assertIndexConsistent')
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 0)
  })

  it('deactivating the slot cancels a deferred reload that gave up', async () => {
    await loadedRefreshGivesUp()
    // Replacing the slot with one that doesn't match the contract
    // deactivates it.
    defineSlot({ key: UNREAD, match: () => false })
    await drainLanes()
    assert.strictEqual(mirror(UNREAD), undefined)
    sbp('chelonia/kv/_assertIndexConsistent')
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 0)
  })

  it("a deferred reload doesn't flicker a slot that another load has loaded", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    const lane = gateLane()
    // A load queued before the height is reached; reaching it then queues
    // the deferred reload behind that load.
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    setLocalHeight(42)
    const { events, off } = collectStatusEvents(UNREAD)
    lane.open()
    await lane.released
    await within(syncing, 'the sync')
    await drainLanes()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status]), [['loading', 'loaded']])
  })

  // The fallback gives up while the reload's GET is held: the slot only
  // settles, and the reload decides its status.
  it("a slot reloading the value it holds stays 'loading', settled, when its deferred load gives up", async () => {
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID) // deferred, with a 300 ms fallback
    await drainLanes()
    const gets = holdGets()
    // A refresh that shows 'loading' while its GET is held.
    const reloading = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => slotStatus(UNREAD) === 'loading', 'the refresh never started')
    await untilWarned('keeping the current mirror value')
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    gets.release()
    await reloading
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.strictEqual(mirror(UNREAD).lastError, undefined)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it("an 'error' slot reloading the value it holds stays 'error' when its deferred load gives up meanwhile", async () => {
    await loadV0At40()
    failKvGets(1, 500)
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD).catch(() => {})
    assert.strictEqual(slotStatus(UNREAD), 'error')
    const errorName = mirror(UNREAD).lastError?.name
    await writeAsDeviceB(UNREAD, VB, 42)
    sbp('chelonia/kv/_registerHeightWait', {
      contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
    })
    const gets = holdGets()
    const reloading = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => slotStatus(UNREAD) === 'loading', 'the refresh never started')
    await untilWarned('keeping the current mirror value')
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    gets.release()
    await reloading
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, errorName)
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
  })
})

describe("a verified load ends the key's height wait", () => {
  const V2 = { roomA: room('v2', 1) }

  // A loaded slot (V0) finds a value no contract height reaches, so a
  // height wait is registered. Then the server holds a verifiable value
  // again (V2), or none, and a refresh loads it.
  const waitThenVerifiedLoad = async (deleteValue: boolean) => {
    await loadV0At40()
    restamp(UNREAD, String(Number.MAX_SAFE_INTEGER))
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    if (deleteValue) server.store.delete(UNREAD)
    else await writeAsDeviceB(UNREAD, V2, 40)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), deleteValue ? 'non-init' : 'loaded')
    server.log.length = 0
  }

  it('a KV_NOOP update then makes no request', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await waitThenVerifiedLoad(false)
    const noop = () => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomZ')
    })
    const before = server.requests.length
    for (let i = 0; i < 3; i++) assert.strictEqual(await noop(), undefined)
    assert.strictEqual(server.requests.length, before)
    // So a GET that would fail doesn't get in its way either.
    const restore = failKvGets(1)
    assert.strictEqual(await noop(), undefined)
    restore()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V2)
  })

  it("a verified 404 isn't settled as a height failure later", async () => {
    await waitThenVerifiedLoad(true)
    const syncsBefore = server.syncs
    await sleep(450) // past the 300 ms fallback of the wait
    await drainLanes()
    assert.strictEqual(server.syncs, syncsBefore)
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).lastError, undefined)
  })

  it('a wait registered while the GET is in flight survives it', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await loadV0At40()
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => slotStatus(UNREAD) === 'loading', 'the refresh never started')
    // E.g. a frame for a newer write, at a height not reached yet.
    sbp('chelonia/kv/_registerHeightWait', {
      contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
    })
    gets.release()
    await within(syncing, 'the sync')
    await drainLanes()
    const getsBefore = server.gets().length
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore + 1)
  })
})

describe("the mirror's heightAhead marker", () => {
  const marker = (key = UNREAD) => mirror(key).heightAhead
  const announced = (events: any[]) => events.map((e) => [
    e.previousStatus, e.status, e.heightAhead?.requiredHeight ?? null
  ])

  it('a loaded slot whose refresh gives up has it until the value loads', async () => {
    const { events } = collectStatusEvents(UNREAD)
    await loadedRefreshGivesUp()
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    // Set with the status unchanged, then kept when the refresh gives up.
    assert.deepStrictEqual(announced(events), [
      ['non-init', 'loading', null],
      ['loading', 'loaded', null],
      ['loaded', 'loading', null],
      ['loading', 'loading', 42],
      ['loading', 'loaded', 42]
    ])
    events.length = 0
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(marker(), undefined)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.deepStrictEqual(announced(events), [['loaded', 'loaded', null]])
  })

  // The library still doesn't know the server value: a `KV_NOOP` must not
  // resolve on V0, the value the deferred reload was to replace.
  it('a deferred reload that fails keeps it until a load verifies the key', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    failKvGets(1)
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(heightWait(UNREAD), undefined)
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    // The update reloads first, and that reload fails too.
    failKvGets(1)
    server.log.length = 0
    const bases: unknown[] = []
    await assert.rejects(
      recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') }),
      (e: any) => e.name === 'ChelErrorUnexpectedHttpResponseCode'
    )
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    // A load that verifies the key clears it; the KV_NOOP then has a basis.
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.strictEqual(marker(), undefined)
    assert.deepStrictEqual(
      await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') }),
      V0
    )
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it("an 'error' slot without a value has it while its reload is deferred", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    const restore = failKvGets(1)
    defineSlot({ key: UNREAD })
    await activateContract()
    restore()
    assert.strictEqual(marker(), undefined)
    const { events } = collectStatusEvents(UNREAD)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.strictEqual(marker(), undefined)
    // The marker is announced with the status unchanged, then kept by the
    // restored 'error' status and the reload at the height.
    assert.deepStrictEqual(announced(events), [
      ['error', 'loading', null],
      ['loading', 'loading', 42],
      ['loading', 'error', 42],
      ['error', 'loading', 42],
      ['loading', 'loaded', null]
    ])
  })

  it("a frame-less wait on a 'non-init' slot sets it with the status change", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    const { events } = collectStatusEvents(UNREAD)
    sbp('chelonia/kv/_registerHeightWait', {
      contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
    })
    assert.deepStrictEqual(announced(events), [['non-init', 'loading', 42]])
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
  })

  it('a persisted entry with it makes the first update of the next session reload first', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const persistedEtag = server.etagOf(UNREAD)
    await writeAsDeviceB(UNREAD, VB, 42)
    setLocalHeight(42)
    // The previous session knew the server held a value it couldn't verify.
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: {
        value: V0,
        etag: persistedEtag,
        status: 'loaded',
        settled: true,
        heightAhead: { requiredHeight: 42 }
      }
    }
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    assert.deepStrictEqual(marker(), { requiredHeight: 42 })
    server.log.length = 0
    const bases: unknown[] = []
    await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    // On V0 the reducer is a KV_NOOP, and the write would be lost.
    assert.deepStrictEqual(bases, [VB])
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.strictEqual(marker(), undefined)
  })
})

// The windows in which `update` used to run its reducer on a mirror value
// the library knew to be stale (a KV_NOOP then dropped the write).
describe('update while a deferred reload is in progress', () => {
  // Loaded V0; an aggregate refresh found VB ahead, so a height wait is
  // registered and the slot keeps presenting V0.
  const loadedWithWait = async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    server.log.length = 0
  }
  const deleteRoomB = () => sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
  })

  it('an update queued before a fired reload reloads first', async () => {
    await loadedWithWait()
    const lane = gateLane()
    const writing = deleteRoomB()
    // Fires the wait: its reload is queued behind the update.
    setLocalHeight(42)
    lane.open()
    await lane.released
    assert.deepStrictEqual(await within(writing, 'the write queued before the reload'), V0)
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it("an update during single-key kv/sync's passive wait doesn't seed from the stale value", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500, pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 1 })
    await until(() => server.gets().length >= 1, 'kv/sync never issued its GET')
    // Parking its deferred reload marks the slot, right before the wait.
    await until(() => mirror(UNREAD).heightAhead !== undefined, 'kv/sync never waited')
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: deleteChatRoomUnreadMessages('roomB')
      }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(server.posts(), [])
    await assert.rejects(syncing, (e: unknown) => isKvHeightAhead(e))
    assert.ok('roomB' in server.value(UNREAD))
  })

  it("an update queued behind single-key kv/sync's recovery sync reloads first", async () => {
    await setupStaleDeviceA()
    const held = holdNextSync()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    await held.started
    server.catchUpOnSync = true
    const writing = deleteRoomB()
    held.release()
    assert.deepStrictEqual(await within(writing, 'the write queued before the reload'), V0)
    await within(syncing, 'the sync')
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it('single-key kv/sync failing with another error still reloads at the height', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 400 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    await held.started
    const restore = failKvGets(1)
    held.release()
    await assert.rejects(syncing, { name: 'ChelErrorUnexpectedHttpResponseCode' })
    restore()
    const getsBefore = server.gets().length
    const syncsBefore = server.syncs
    await sleep(500) // past the fallback of an unparked wait
    assert.strictEqual(server.syncs, syncsBefore)
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore + 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('single-key kv/sync whose recovery times out after the height was reached loads', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, recoveryTimeoutMs: 300 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    const { events } = collectStatusEvents(UNREAD)
    const held = holdNextSync()
    const started = Date.now()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 1 })
    await held.started
    setLocalHeight(42) // e.g. pubsub delivered the missing events
    // The reload is queued behind the recovery sync, which is still
    // running on the contract's lane after the 300 ms timeout.
    later(held.release, 600)
    await within(syncing, 'the sync')
    assert.ok(Date.now() - started >= 600)
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'loaded')
    await drainLanes()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.deepStrictEqual(events.map((e) => [e.status, e.heightAhead?.requiredHeight ?? null]), [
      ['loading', null], ['loading', 42], ['loaded', null]
    ])
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
    assert.strictEqual(slotStatus('absent'), 'non-init')
    assert.strictEqual(mirror('absent').settled, true)
    assert.deepStrictEqual(events.map((e) => [e.status, e.settled, e.previousSettled]), [
      ['loading', false, false], ['non-init', true, false]
    ])
    assert.deepStrictEqual(onUpdateCalls, [])
    assert.strictEqual(await whenSettledWithin('absent'), 'non-init')
  })

  it('an abandoned load does not settle the slot', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const gets = holdGets()
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD })
    const settledAs = whenSettledWithin(UNREAD)
    await subscribeContract()
    await until(() => kvGetsRequested() === 1, 'the first GET never started')
    // Slot replaced (HMR / re-registration) while its first GET is in flight.
    defineSlot({ key: UNREAD })
    gets.release()
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

  it('whenSettled rejects a signal that has already aborted, even for a settled slot', async () => {
    await loadV0At40()
    assert.strictEqual(mirror(UNREAD).settled, true)
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    controller.abort(reason)
    await assert.rejects(
      sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD, { signal: controller.signal }),
      (e: unknown) => e === reason
    )
  })

  it('whenSettled called from inside onUpdate rejects instead of hanging', async () => {
    const OTHER = 'otherKey'
    await writeAsDeviceB(UNREAD, V0, 40)
    await writeAsDeviceB(OTHER, V0, 40)
    const inner: unknown[] = []
    const outcome = (p: Promise<unknown>) => p.then((v) => v, (e: unknown) => e)
    defineSlot({ key: OTHER, autoLoad: 'on-demand' })
    defineSlot({
      key: UNREAD,
      onUpdate: () => {
        // The settled slot resolves; the pending one would wait for a load
        // queued behind this callback.
        inner.push(outcome(sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)))
        inner.push(outcome(sbp('chelonia/kv/whenSettled', CONTRACT_ID, OTHER)))
      }
    })
    await activateContract()
    const [settled, pending] = await within(Promise.all(inner), 'the whenSettled calls settle')
    assert.strictEqual(settled, 'loaded')
    assert.strictEqual((pending as Error | undefined)?.name, 'ChelErrorKvReentrant')
  })

  it('re-activating a persisted entry resets settled until the next load', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    const gets = holdGets()
    defineSlot({ key: UNREAD })
    await subscribeContract()
    await until(() => kvGetsRequested() === 1, 'the reload never started')
    assert.strictEqual(mirror(UNREAD).settled, false)
    gets.release()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
  })

  it('re-activation announces settled: false, and an external store follows', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    const external: any = {}
    sbp('sbp/selectors/register', { 'test/kvHeight/externalState': () => external })
    addTeardown(sbp('chelonia/externalStateSetup', {
      stateSelector: 'test/kvHeight/externalState'
    }))
    const projected = () => within(
      sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, () => {}),
      'the external store projection'
    )
    await activateContract()
    await projected()
    assert.strictEqual(external._kv?.[CONTRACT_ID]?.[UNREAD]?.settled, true)
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await drainLanes()
    await projected()
    off()
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.previousSettled, e.settled]),
      [['loaded', 'loaded', true, false]]
    )
    assert.strictEqual(external._kv[CONTRACT_ID][UNREAD].settled, false)
  })

  // An entry persisted as `{ status: 'loaded', settled: true }` holding V0,
  // while the server holds VB written at height 42 and the local contract
  // stays at 40 (a sync doesn't catch it up).
  const seedPersistedLoadedEntry = async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const persistedEtag = server.etagOf(UNREAD)
    await writeAsDeviceB(UNREAD, VB, 42)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: persistedEtag, status: 'loaded', settled: true }
    }
    return { persistedEtag }
  }

  it('a re-activated loaded entry settles when its deferred load gives up', async () => {
    const { persistedEtag } = await seedPersistedLoadedEntry()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    const { events, off } = collectStatusEvents(UNREAD)
    const syncsBefore = server.syncs
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    off()
    assert.strictEqual(server.syncs, syncsBefore + 1) // the fallback sync
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
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
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), (e: unknown) => isKvHeightAhead(e))
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(await whenSettledWithin(UNREAD, 100), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
  })

  it('the first update of a never-loaded slot writes without loading it, and settles it', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    })
    off()
    // No GET: the write carries `if-match: ""`, and its commit settles the
    // slot.
    assert.strictEqual(server.gets().length, 0)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.ifMatch]), [[204, '""']])
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loaded', true]
    ])
  })

  it('a committed local write settles the slot, also after merging a value it never read', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    server.log.length = 0
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    off()
    assert.deepStrictEqual(result, { ...V0, roomC: room('c1', 3) })
    assert.strictEqual(server.gets().length, 0)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loaded', true]
    ])
  })

  it('whenSettled waits for activation and rejects on abort and on reset', async () => {
    defineSlot({ key: 'absent' })
    const early = whenSettledWithin('absent')
    await activateContract()
    assert.strictEqual(await early, 'non-init')

    defineSlot({ key: 'never', autoLoad: 'never' })
    await drainLanes()
    const controller = new AbortController()
    const aborted = sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'never', { signal: controller.signal })
    controller.abort(new Error('stop waiting'))
    await assert.rejects(within(aborted, 'the aborted whenSettled'), (e: any) => e.message === 'stop waiting')

    const pending = sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'never')
    await sbp('chelonia/reset')
    await assert.rejects(within(pending, 'whenSettled across reset'), (e: any) => e.name === 'AbortError')
  })

  it("waits for a settled slot's reload instead of resolving with 'loading'", async () => {
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(slotStatus('absent'), 'non-init')
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, 'absent')
    await until(() => slotStatus('absent') === 'loading', "the refresh never went 'loading'")
    let settledAs: unknown
    const settling = whenSettledWithin('absent').then((s: unknown) => { settledAs = s })
    // Only for the negative check below.
    await sleep(20)
    assert.strictEqual(settledAs, undefined)
    gets.release()
    await within(syncing, 'the sync')
    await settling
    assert.strictEqual(settledAs, 'non-init')
  })

  it("a settled 'non-init' slot whose server value turns out to be ahead is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(slotStatus('absent'), 'non-init')
    await writeAsDeviceB('absent', V0, 42)
    const { events, off } = collectStatusEvents('absent')
    // An aggregate refresh finds a value written at a height not reached:
    // the server value isn't absent after all.
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.strictEqual(slotStatus('absent'), 'loading')
    assert.strictEqual(mirror('absent').settled, true)
    await assert.rejects(whenSettledWithin('absent', 100), (e: any) => e.name === 'TimeoutError')
    const settling = whenSettledWithin('absent')
    await advanceLocalHeightOnInternalLane(42)
    assert.strictEqual(await settling, 'loaded')
    off()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'absent'), V0)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.heightAhead?.requiredHeight ?? null]),
      [['non-init', 'loading', null], ['loading', 'loading', 42], ['loading', 'loaded', null]]
    )
  })

  it("a settled 'non-init' slot whose deferred refresh gives up settles to 'error'", async () => {
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    await writeAsDeviceB(UNREAD, VB, 42)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    const syncsBefore = server.syncs
    // The 300 ms fallback sync doesn't catch the contract up.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    assert.strictEqual(server.syncs, syncsBefore + 1)
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), {})
    // KV_NOOP on the default, but writes on VB: the reducer must not run
    // on the default.
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    assert.strictEqual(reducer({}), KV_NOOP)
    assert.notStrictEqual(reducer(VB), KV_NOOP)
    server.log.length = 0
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases, { reducer }), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("a persisted entry's revalidation doesn't resolve whenSettled before the slot is active", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: {
        value: V0,
        etag: server.etagOf(UNREAD),
        status: 'error',
        settled: true,
        lastError: { name: 'Error', message: 'previous session' }
      }
    }
    let settledAs: unknown
    const settling = whenSettledWithin(UNREAD).then((s: unknown) => { settledAs = s })
    // Defining the slot again revalidates the persisted entry ('error' ->
    // 'loaded'): the contract hasn't synced, so nothing is settled in this
    // session yet.
    defineSlot({ key: UNREAD })
    await until(() => mirror(UNREAD).status === 'loaded', 'the persisted entry was never revalidated')
    assert.strictEqual(settledAs, undefined)
    await activateContract()
    await settling
    assert.strictEqual(settledAs, 'loaded')
    assert.strictEqual(server.gets().length, 1)
  })

  it("settledStatus and a gate that checks status don't take a reloading slot's default for its value", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: 'absent' })
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), undefined)
    await activateContract()
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), 'non-init')
    await writeAsDeviceB('absent', V0, 42)
    const flushed: unknown[] = []
    onEvent(CHELONIA_KV_STATUS_CHANGED, (p: any) => {
      if (
        p.contractID === CONTRACT_ID && p.key === 'absent' && p.settled && p.status !== 'loading'
      ) {
        flushed.push(sbp('chelonia/kv/read', CONTRACT_ID, 'absent'))
      }
    })
    // An aggregate refresh finds a value written at a height not reached.
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.strictEqual(slotStatus('absent'), 'loading')
    assert.strictEqual(mirror('absent').settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), undefined)
    assert.deepStrictEqual(flushed, [])
    await advanceLocalHeightOnInternalLane(42)
    await until(() => slotStatus('absent') === 'loaded', 'the slot never loaded')
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), 'loaded')
    assert.deepStrictEqual(flushed, [V0])
  })

  it('chelonia/reset(newState) restores KV entries unsettled, until their slots load again', async () => {
    await loadV0At40()
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'loaded')
    const persisted = JSON.parse(JSON.stringify(rootState()))
    assert.strictEqual(persisted._kv[CONTRACT_ID][UNREAD].settled, true)
    await sbp('chelonia/reset', persisted)
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.strictEqual(mirror(UNREAD).status, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), undefined)
    await activateContract()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'loaded')
  })
})

describe('whenSettled and slot deactivation', () => {
  const listeners = (event: string): number =>
    (sbp('okTurtles.data/get', `events/${event}/listeners`) ?? []).length
  const listenerCounts = () => [listeners(CHELONIA_KV_STATUS_CHANGED), listeners(CHELONIA_RESET)]
  // The slot's first load is held, so that it hasn't settled.
  const definedAndLoading = async (def: Record<string, unknown> = {}) => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, ...def })
    const gets = holdGets()
    addTeardown(() => gets.release())
    await subscribeContract()
    await until(() => kvGetsRequested() >= 1, 'the first load never sent its GET')
    return gets
  }

  it('rejects at once for a key that no slot defines', async () => {
    await loadV0At40()
    const before = listenerCounts()
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'unreadMesages'), 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes('unreadMesages')
    )
    // Also for a contract that hasn't synced (its type isn't known yet).
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', 'zOtherContract', 'unreadMesages'), 'whenSettled'),
      ChelErrorKvSlotUnknown
    )
    assert.deepStrictEqual(listenerCounts(), before)
  })

  it('rejects when the contract is released while it waits, leaving no listener', async () => {
    const gets = await definedAndLoading()
    await sbp('chelonia/contract/retain', CONTRACT_ID)
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(listenerCounts(), [before[0] + 1, before[1] + 1])
    await sbp('chelonia/contract/release', CONTRACT_ID)
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.deepStrictEqual(listenerCounts(), before)
    gets.release()
  })

  it('rejects when its match turns false while it waits', async () => {
    let matches = true
    const gets = await definedAndLoading({ match: () => matches })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    matches = false
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.deepStrictEqual(listenerCounts(), before)
    gets.release()
  })

  it('rejects when a manifest cleanup unregisters its slot, which leaves no empty record', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    sbp('chelonia/kv/_registerContractSlots', CTYPE, 'manifest-1', {
      [UNREAD]: { defaultValue: {} }
    })
    const gets = holdGets()
    addTeardown(() => gets.release())
    await subscribeContract()
    await until(() => kvGetsRequested() >= 1, 'the first load never sent its GET')
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    sbp('chelonia/kv/_cleanupContractSlots', CTYPE, 'manifest-1', { [UNREAD]: {} }, {})
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
    gets.release()
  })

  it('still waits for a defined slot that only activates later', async () => {
    defineSlot({ key: UNREAD })
    const settling = whenSettledWithin(UNREAD)
    await activateContract()
    assert.strictEqual(await settling, 'non-init')
  })

  it("rejects when its match is false once the contract's slots are reconciled, then at once", async () => {
    let matches = false
    defineSlot({ key: UNREAD, match: () => matches })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    const rejected = assert.rejects(
      within(settling, 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes("isn't active")
    )
    await activateContract()
    await rejected
    assert.deepStrictEqual(listenerCounts(), before)
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD), 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes('`match` is false')
    )
    assert.deepStrictEqual(listenerCounts(), before)
    // Its match turns true: refreshFilters activates it, and it loads.
    matches = true
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'non-init')
  })

  it('rejects when a manifest cleanup unregisters its slot before it activated', async () => {
    sbp('chelonia/kv/_registerContractSlots', CTYPE, 'manifest-1', {
      [UNREAD]: { defaultValue: {} }
    })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    sbp('chelonia/kv/_cleanupContractSlots', CTYPE, 'manifest-1', { [UNREAD]: {} }, {})
    await assert.rejects(
      within(settling, 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes("isn't defined")
    )
    assert.deepStrictEqual(listenerCounts(), before)
  })
})

describe("an 'error' slot's lastError across deferred reloads", () => {
  // A first load that finds the value ahead, and whose fallback sync gives
  // up: 'error', no value, a ChelErrorKvHeightAhead lastError.
  const gaveUp = async () => {
    await deferFirstLoad()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    await drainLanes()
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
  }

  it('a refresh that is deferred again, then gives up again, keeps lastError', async () => {
    await gaveUp()
    const { events } = collectStatusEvents(UNREAD)
    const syncsBefore = server.syncs
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    // The new 300 ms fallback syncs, and gives up again.
    await until(() => server.syncs === syncsBefore + 1, 'the new fallback sync never ran')
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    // Only the reload's own 'loading' has no lastError.
    assert.deepStrictEqual(events.map((e) => [e.status, e.lastError?.name ?? null]), [
      ['loading', null], ['error', 'ChelErrorKvHeightAhead']
    ])
  })

  it('a given-up slot persisted into the next session is reloaded before update', async () => {
    await gaveUp()
    const syncsBefore = server.syncs
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => server.syncs === syncsBefore + 1, 'the new fallback sync never ran')
    await drainLanes()
    // What the next session starts with: the persisted entry, no waits.
    sbp('chelonia/kv/_testClearHeightWaits')
    server.log.length = 0
    const bases: unknown[] = []
    await assert.rejects(
      recordingUpdate(bases, {
        reducer: deleteChatRoomUnreadMessages('roomB'), maxHeightRecoveries: 0
      }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(bases, [])
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(server.posts(), [])
  })

  it("a refresh deferred on height keeps a failed load's lastError", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    const restore = failKvGets(1)
    defineSlot({ key: UNREAD })
    await activateContract()
    restore()
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
  })

  it("an 'error' slot without a value that gives up reports ChelErrorKvHeightAhead", async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    const restore = failKvGets(1)
    defineSlot({ key: UNREAD })
    await activateContract()
    restore()
    const syncsBefore = server.syncs
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    // The 300 ms fallback syncs, which doesn't catch up.
    await until(() => server.syncs === syncsBefore + 1, 'the fallback sync never ran')
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
  })

  it("an 'error' slot holding a value that gives up keeps its lastError", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    const restore = failKvGets(1)
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    restore()
    sbp('chelonia/kv/_testSetHeightTimings', TEST_TIMINGS)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await untilWarned('keeping the current mirror value')
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
  })
})

describe('height stamps', () => {
  it('only canonical stamps are read', () => {
    for (const [stamp, height] of [['0', 0], ['40', 40], [0, 0], [40, 40]] as const) {
      assert.strictEqual(readHeightStamp({ height: stamp }), height)
    }
    for (const stamp of [
      '1e1', '0.1e2', '0x0a', '010', ' 10', '10 ', '10.0', '+10', '-1', '',
      '9007199254740993', -1, 1.5, NaN, Infinity, null, undefined, {}
    ]) {
      assert.throws(
        () => readHeightStamp({ height: stamp }), ChelErrorInvalidMessageHeight, String(stamp)
      )
    }
    assert.throws(() => readHeightStamp(null), ChelErrorInvalidMessageHeight)
    // Not KV-specific: every message parsed by
    // `parseEncryptedOrUnencryptedMessage` has its stamp read this way.
    assert.throws(
      () => readHeightStamp({ height: 'x' }),
      (e: any) => e.message === '[chelonia] Invalid height stamp "x"'
    )
  })

  // A value signed by a key revoked at height 5 (e.g. a removed device's),
  // stamped with the current height (40) written in different ways. The
  // server accepts each of them: it compares `Number(stamp)` with its
  // contract height.
  it("a revoked key's value can't pass the key-window check with a non-canonical stamp", async () => {
    const KEY = 'profile'
    const revoked = keygen(EDWARDS25519SHA512BATCH)
    const revokedId = keyId(revoked)
    rootState()[CONTRACT_ID]._vm.authorizedKeys[revokedId] = {
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
        contractID: CONTRACT_ID, serializedData, meta: KEY
      })
    assert.throws(() => parse(signedAt('40')).data, ChelErrorSignatureKeyUnauthorized)
    // `parseInt` reads these as 4 and 0, inside the key's window. The
    // detached-message parser also parses non-KV messages: it keeps the
    // generic name.
    for (const stamp of ['4e1', '0.4e2']) {
      assert.throws(
        () => parse(signedAt(stamp)),
        (e: any) => e.name === 'ChelErrorInvalidMessageHeight' && !isKvHeightMalformed(e),
        stamp
      )
    }
    // End to end: the server stores such a value, but the slot doesn't
    // load it.
    const posted = await server.fetch(`https://example.test/kv/${CONTRACT_ID}/${KEY}`, {
      method: 'POST', headers: { 'if-match': '""' }, body: JSON.stringify(signedAt('4e1'))
    })
    assert.strictEqual(posted.status, 204)
    defineSlot({ key: KEY })
    await activateContract()
    assert.strictEqual(slotStatus(KEY), 'error')
    assert.strictEqual(mirror(KEY).lastError?.name, 'ChelErrorKvHeightMalformed')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, KEY), {})
  })

  // A value whose stamp is malformed, but which the server accepted (it
  // compares `Number(stamp)` with its contract height), can never be
  // verified. Writes that depend on it keep rejecting; blind writes
  // (`clear`, or `allowUnverifiedConflict`) overwrite it.
  const writeStamped = (stamp: string) => withLocalHeight(CONTRACT_ID, stamp as any, () =>
    sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
    })
  )
  const invalidHeight = (e: any) => isKvHeightMalformed(e) && !isKvHeightAhead(e)

  for (const stamp of ['040', '40.0']) {
    it(`a value stamped ${JSON.stringify(stamp)} can be cleared, but not updated`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await writeStamped(stamp)
      assert.strictEqual(server.posts().at(-1)?.status, 204)
      defineSlot({ key: UNREAD })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'error')
      assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightMalformed')
      const stored = server.store.get(UNREAD)
      await assert.rejects(
        sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
        }),
        invalidHeight
      )
      await assert.rejects(
        sbp('chelonia/kv/queuedSet', {
          contractID: CONTRACT_ID,
          key: UNREAD,
          data: { x: 1 },
          onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
        }),
        invalidHeight
      )
      await assert.rejects(sbp('chelonia/kv/get', CONTRACT_ID, UNREAD), invalidHeight)
      assert.strictEqual(server.store.get(UNREAD), stored)
      await sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD)
      assert.notStrictEqual(server.store.get(UNREAD), stored)
      assert.strictEqual(server.value(UNREAD), null)
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
      assert.strictEqual(mirror(UNREAD).value, undefined)
    })
  }

  it('a malformed stamp error names the key, with the stamp error as its cause', async () => {
    await writeStamped('040')
    await assert.rejects(sbp('chelonia/kv/get', CONTRACT_ID, UNREAD), (e: any) => {
      // (`assert.ok` would narrow `e`.)
      assert.strictEqual(invalidHeight(e), true)
      // Still the class it was before, for `instanceof`.
      assert.strictEqual(e instanceof ChelErrorInvalidMessageHeight, true)
      // One prefix, not the stamp error's too.
      assert.strictEqual(
        e.message, `[chelonia/kv] ${CONTRACT_ID}::${UNREAD}: Invalid height stamp "040"`
      )
      assert.strictEqual(isKvHeightMalformed(e.cause), true)
      assert.strictEqual(e.cause.message, '[chelonia] Invalid height stamp "040"')
      // A guard that matches the old name finds it nowhere in the chain.
      for (let c = e, depth = 0; c && depth < 10; c = c.cause, depth++) {
        assert.notStrictEqual(c.name, 'ChelErrorInvalidMessageHeight')
      }
      return true
    })
  })

  it('a malformed stamp makes a write reject without a sync or a retry', async () => {
    await writeStamped('040')
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    const syncsBefore = server.syncs
    server.log.length = 0
    await assert.rejects(
      sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        data: { x: 1 },
        ifMatch: '"stale"',
        onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
      }),
      invalidHeight
    )
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it('queuedSet with allowUnverifiedConflict overwrites a value with a malformed stamp', async () => {
    await writeStamped('040')
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    const seen: unknown[] = []
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      data: { x: 1 },
      allowUnverifiedConflict: true,
      onconflict: async ({ currentStatus, etag }: any) => {
        seen.push(currentStatus)
        return [{ x: 1 }, etag]
      }
    })
    assert.deepStrictEqual(seen, ['malformed'])
    assert.deepStrictEqual(server.value(UNREAD), { x: 1 })
  })
})

// The names docs/api.md and AGENTS.md document for a value that is ahead.
describe('error names for a value that is ahead', () => {
  it('lower-level parsing still throws a plain ChelErrorInvalidMessageHeight', async () => {
    const { body } = await writeAsDeviceB(UNREAD, VB, 42)
    let error: unknown
    try {
      sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
        contractID: CONTRACT_ID, serializedData: JSON.parse(body), meta: UNREAD
      })
    } catch (e) {
      error = e
    }
    assert.strictEqual((error as Error | undefined)?.name, 'ChelErrorInvalidMessageHeight')
    assert.strictEqual(isKvHeightAhead(error), false)
  })

  it('raw kv/get and kv/set reject ChelErrorKvHeightAhead, still instanceof the old class', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    const rejections = await Promise.all([
      sbp('chelonia/kv/get', CONTRACT_ID, UNREAD),
      sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
        ifMatch: '"stale"', signingKeyId: cskId, onconflict: () => false
      })
    ].map((p: Promise<unknown>) => within(
      p.then(() => assert.fail('resolved'), (e: unknown) => e), 'the KV call settles'
    )))
    for (const e of rejections) {
      assert.strictEqual((e as Error).name, 'ChelErrorKvHeightAhead')
      assert.ok(e instanceof ChelErrorInvalidMessageHeight)
      assert.strictEqual(isKvHeightAhead(e), true)
    }
  })
})

describe('chelonia/reset', () => {
  const contractSyncsSince = (at: number) => server.requests
    .filter((r) => r.at >= at && /^\/(latestHEADinfo|eventsAfter)\//.test(r.path))
    .map((r) => r.path)

  it('a deferred-load fallback due while reset drains starts no contract sync', async () => {
    // Deferred: the 300 ms fallback is armed.
    await deferFirstLoad()
    const resetStartedAt = Date.now()
    // The fallback falls due while the persistence hook runs.
    await sbp('chelonia/reset', () => sleep(500))
    await sleep(400)
    assert.deepStrictEqual(contractSyncsSince(resetStartedAt), [])
    // The next session doesn't expect events for the torn-down contract
    // (a sync started for it would have put it back in `pending`).
    warnings.length = 0
    await sbp('chelonia/private/in/handleEvent', CONTRACT_ID, 'not-a-message')
    assert.ok(logged(warnings, 'ignoring unexpected event'))
  })

  it('work started while reset drains registers no height wait and starts no sync', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const resetStartedAt = Date.now()
    let updateError: unknown
    await sbp('chelonia/reset', async () => {
      // Outside a reset, this load would defer the key (with a 300 ms
      // fallback sync) and the update would sync the contract to recover.
      await sbp('chelonia/kv/sync', CONTRACT_ID)
      // No height wait: it would mark the slot.
      assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      updateError = await sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
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
    await deferFirstLoad()
    server.catchUpOnSync = true
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  // A reset whose persistence hook throws doesn't tear the session down, so
  // the session goes on and its height machinery must keep working.
  const failedReset = () => assert.rejects(
    sbp('chelonia/reset', () => { throw new Error('persist failed') }),
    /persist failed/
  )

  it('after a failed reset, a new deferred load still falls back and loads', async () => {
    await failedReset()
    await deferFirstLoad()
    server.catchUpOnSync = true
    // The fallback sync (after 300 ms) brings the contract up to date.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps the deferred loads it found', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    await failedReset()
    // Only the height notification can reload the slot within the test.
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('two overlapping failed resets keep the deferred loads the first found', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    server.log.length = 0
    const failingReset = (ms: number) => sbp('chelonia/reset', async () => {
      await sleep(ms)
      throw new Error('persistence hook failed')
    })
    const outcomes = await Promise.allSettled([failingReset(50), failingReset(10)])
    assert.deepStrictEqual(outcomes.map((o) => o.status), ['rejected', 'rejected'])
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
  })

  // Reset A fails while reset B still drains: the height session must stay
  // ended until B is done, or a fallback could sync a contract that B is
  // about to tear down.
  for (const bFails of [false, true]) {
    it(`a reset that fails while another drains doesn't resume the height session (B ${bFails ? 'fails' : 'succeeds'})`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 100 })
      await loadV0At40()
      let failA: ((e: Error) => void) | undefined
      const resetA = sbp('chelonia/reset', () => new Promise<void>((_resolve, reject) => {
        failA = reject
      }))
      let finishB: (() => void) | undefined
      const resetB = sbp('chelonia/reset', () => new Promise<void>((resolve, reject) => {
        finishB = bFails ? () => reject(new Error('B failed')) : resolve
      }))
      // A failing assertion below must not leave either persistence hook
      // pending after the test, nor either reset's rejection unhandled.
      addTeardown(() => {
        resetA.catch(() => {})
        resetB.catch(() => {})
        failA?.(new Error('released after the test'))
        finishB?.()
      })
      await until(() => !!failA && !!finishB, 'both persistence hooks run')
      failA!(new Error('A failed'))
      await assert.rejects(within(resetA, 'reset A'), /A failed/)
      // A value that is ahead turns up while B still drains (e.g. a frame).
      const syncsBefore = server.syncs
      sbp('chelonia/kv/_registerHeightWait', {
        contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'load'
      })
      // Only remembered, in case B fails too: no marker, no fallback.
      assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      await sleep(300) // a 100 ms fallback would have synced by now
      assert.strictEqual(server.syncs, syncsBefore)
      finishB!()
      if (!bFails) {
        await within(resetB, 'reset B')
        assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
        await sleep(300)
        assert.strictEqual(server.syncs, syncsBefore)
        return
      }
      await assert.rejects(within(resetB, 'reset B'), /B failed/)
      // B failed too: the session goes on, with the wait registered again.
      assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
      await until(() => server.syncs === syncsBefore + 1, 'the fallback syncs', 2000)
      await sleep(300)
      assert.strictEqual(server.syncs, syncsBefore + 1)
    })
  }

  it('a failed reset keeps a deferred load that gave up, without a new fallback', async () => {
    await loadedRefreshGivesUp()
    const syncsBefore = server.syncs
    await failedReset()
    await sleep(400) // a new 300 ms fallback would have synced by now
    assert.strictEqual(server.syncs, syncsBefore)
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps the deferred reload of a single-key kv/sync it aborted', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000, pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    await until(() => server.gets().length >= 1, 'kv/sync never issued its GET')
    // Parking its deferred reload marks the slot, right before the wait.
    await until(() => mirror(UNREAD)?.heightAhead !== undefined, 'kv/sync never waited')
    await failedReset()
    await assert.rejects(syncing, { name: 'AbortError' })
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    const getsBefore = server.gets().length
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore + 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps a deferred reload registered while it ran', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await assert.rejects(
      sbp('chelonia/reset', async () => {
        // The refresh finds VB ahead, so the key's reload is deferred.
        await sbp('chelonia/kv/sync', CONTRACT_ID)
        throw new Error('persist failed')
      }),
      /persist failed/
    )
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 2)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('after a failed reset, writes still recover from a value that is ahead', async () => {
    await failedReset()
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    server.catchUpOnSync = true
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['alice', 'carol'],
      onconflict: mergeNames(['alice', 'carol'])
    })
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('a reset whose teardown throws still lets later sessions recover', async () => {
    let throwOnce = true
    sbp('chelonia/configure', {
      reactiveDel: (obj: Record<string, unknown>, key: string) => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('reactiveDel threw')
        }
        delete obj[key]
      }
    } as unknown as Partial<CheloniaConfig>)
    await assert.rejects(within(sbp('chelonia/reset'), 'the failing reset'), /reactiveDel threw/)
    await within(sbp('chelonia/reset'), 'the next reset')
    setupContract(40)
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'update')
    assert.deepStrictEqual(
      Object.keys(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD) as object).sort(), ['roomA', 'roomB']
    )
  })
})

describe('writes to a slot that has not loaded', () => {
  it('a never-loaded slot\'s first update writes against if-match "" and merges on the 412', async () => {
    const { cid: v0cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(server.gets().length, 0)
    const bases: unknown[] = []
    await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) })
    // The default first, then the server value the 412 carried.
    assert.deepStrictEqual(bases, [{}, V0])
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status, e.ifMatch]), [
      ['POST', 412, '""'], ['POST', 204, `"${v0cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })

  it('a new key costs a single POST', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 204]])
  })

  it("when the reload a KV_NOOP needs fails, it rejects with the load's error", async () => {
    await writeAsDeviceB(UNREAD, VB, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const restore = failKvGets(1)
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
      }),
      (e: any) => e.name === 'ChelErrorUnexpectedHttpResponseCode'
    )
    restore()
    assert.deepStrictEqual(server.posts(), [])
    assert.ok('roomB' in server.value(UNREAD))
  })

  // A KV_NOOP on the default (no roomB) would drop the write.
  for (const autoLoad of ['never', 'on-demand']) {
    it(`a KV_NOOP on the default doesn't drop a write (autoLoad: '${autoLoad}')`, async () => {
      await writeAsDeviceB(UNREAD, VB, 40)
      defineSlot({ key: UNREAD, autoLoad })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
      assert.strictEqual(mirror(UNREAD).settled, false)
      server.log.length = 0
      const bases: unknown[] = []
      const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
      // The default first: its KV_NOOP reloads, and the reducer runs again
      // on the server value.
      assert.deepStrictEqual(bases, [{}, VB])
      assert.deepStrictEqual(result, V0)
      assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
      assert.deepStrictEqual(server.value(UNREAD), V0)
      assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    })
  }

  // The previous session loaded V0; device B has since written VB.
  const persistedV0 = async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const e0 = server.etagOf(UNREAD)
    await writeAsDeviceB(UNREAD, VB, 40)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: e0, status: 'loaded', settled: true }
    }
  }

  it('an entry persisted by an earlier session writes against its etag, and merges on a 412', async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    server.log.length = 0
    const bases: unknown[] = []
    const result = await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) })
    assert.deepStrictEqual(bases, [V0, VB])
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 412], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it('an entry persisted by an earlier session reloads when the reducer is a KV_NOOP on it', async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const bases: unknown[] = []
    const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    assert.deepStrictEqual(bases, [V0, VB])
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it("a caller's ifMatch reloads an entry persisted by an earlier session first", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const bases: unknown[] = []
    await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3), ifMatch: '*' })
    // `if-match: *` wouldn't catch a value this client never read.
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it("a caller's ifMatch rejects with the reload's error when that reload fails", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    failKvGets(1)
    const bases: unknown[] = []
    await assert.rejects(
      recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3), ifMatch: '*' }),
      (e: any) => e.name === 'ChelErrorUnexpectedHttpResponseCode'
    )
    // No reducer ran on V0, and `if-match: *` overwrote nothing.
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("an 'on-sync' slot's persisted entry is reloaded on activation, before an update", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, true)
    server.log.length = 0
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    })
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it('a slot that a sync settled is not loaded again by update', async () => {
    await writeAsDeviceB(UNREAD, VB, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    })
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })
})

// Once `kv/set` resolved, an abort can't cancel anything: the write is
// applied and the call resolves (KV-REVAMPED.md §4.2).
describe('abort after the write committed', () => {
  // A loaded slot, whose next POST aborts `controller` while the server
  // handles it (after the request's own abort check).
  const loadedThenAbortOnPost = async (value: JSONType) => {
    await writeAsDeviceB(UNREAD, value, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    const controller = new AbortController()
    server.log.length = 0
    server.onPost = (n) => { if (n === 1) controller.abort() }
    return controller
  }

  it('update resolves with the stored value, and the mirror has it', async () => {
    const controller = await loadedThenAbortOnPost(V0)
    const reasons: string[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => { if (p.key === UNREAD) reasons.push(p.reason) })
    const result = await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      signal: controller.signal,
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update')
    const written = { roomA: room('a1', 1, [{ messageHash: 'a2', createdHeight: 5 }]) }
    assert.deepStrictEqual(result, written)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), written)
    assert.deepStrictEqual(mirror(UNREAD).value, written)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
    assert.deepStrictEqual(reasons, ['local'])
  })

  it("a caller that retries after it doesn't apply a non-idempotent reducer twice", async () => {
    const controller = await loadedThenAbortOnPost({ n: 0 })
    const increment = (prev: any) => ({ n: prev.n + 1 })
    const update = (signal?: AbortSignal) => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, signal, updater: increment
    })
    // A caller that retries what rejects.
    await update(controller.signal).catch(() => update())
    assert.deepStrictEqual(server.value(UNREAD), { n: 1 })
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it("clear resolves, and the mirror is 'non-init'", async () => {
    const controller = await loadedThenAbortOnPost(V0)
    assert.strictEqual(
      await within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { signal: controller.signal }), 'the clear'),
      undefined
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).value, undefined)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
  })

  it('queuedSet resolves with the etag of the stored value', async () => {
    const controller = await loadedThenAbortOnPost(V0)
    const result = await within(sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: UNREAD, data: VB, ifMatch: '*', signal: controller.signal
    }), 'the queuedSet')
    assert.deepStrictEqual(result, { etag: server.etagOf(UNREAD) })
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })
})

// The caller's signal ends a write whose work is still queued on the
// contract's lanes (behind a busy lane, or a recovery sync), rather than
// when that work finally runs. The work then writes nothing.
describe('abortable writes', () => {
  const OTHER = 'zKvHeightTestOtherContract'
  // Holds the internal lane of `contractID` until `open` is called (after
  // the test at the latest).
  const holdInternalLane = (contractID: string) => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const released = sbp('chelonia/private/queueEvent', contractID, () => gate) as Promise<void>
    addTeardown(open)
    return { open, released }
  }
  const update = (signal: AbortSignal) => sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5), signal
  })

  it('a retry queued behind a recovery sync that timed out rejects at the abort', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const controller = new AbortController()
    const started = Date.now()
    const updating = update(controller.signal)
    await within(held.started, 'the recovery sync')
    // The height arrives some other way: the recovery's timeout then
    // queues the retry, behind the held sync.
    later(() => setLocalHeight(42), 100)
    later(() => controller.abort(), 1000)
    await assert.rejects(within(updating, 'the update'), { name: 'AbortError' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `rejected after ${elapsed} ms`)
    held.release()
    await drainLanes()
    // The retry's work ran once the sync ended, and wrote nothing.
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it("a write awaited on another contract's lane ends at its abort, and writes nothing later", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    let escape!: () => void
    const escaped = new Promise<void>((resolve) => { escape = resolve })
    addTeardown(escape)
    let syncEnded = false
    // The recovery sync needs OTHER's lane (e.g. it processes an event
    // whose handling waits for OTHER), whose side effect awaits the write:
    // a lane cycle, with or without a height error.
    server.onSync = async () => {
      server.onSync = null
      setLocalHeight(42)
      await Promise.race([sbp('chelonia/private/queueEvent', OTHER, () => {}), escaped])
      syncEnded = true
    }
    const controller = new AbortController()
    later(() => controller.abort(), 1000)
    const started = Date.now()
    const sideEffect = sbp('chelonia/private/queueEvent', OTHER, () => update(controller.signal))
    await assert.rejects(within(sideEffect, "OTHER's side effect"), { name: 'AbortError' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `rejected after ${elapsed} ms`)
    // With the side effect done, the cycle is broken: the sync ends, and
    // the retry's work runs without writing.
    await until(() => syncEnded, 'the recovery sync ended')
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    assert.strictEqual(localHeight(), 42)
  })

  for (const [index, [name]] of heightWrites().entries()) {
    it(`${name} queued behind a busy lane rejects at the abort, and writes nothing`, async () => {
      await loadV0At40()
      server.log.length = 0
      const busy = holdInternalLane(CONTRACT_ID)
      const controller = new AbortController()
      const started = Date.now()
      const writing = heightWrites({ signal: controller.signal })[index][1]()
      later(() => controller.abort(), 100)
      await assert.rejects(within(writing, name), { name: 'AbortError' })
      const elapsed = Date.now() - started
      assert.ok(elapsed < 600, `rejected after ${elapsed} ms`)
      busy.open()
      await drainLanes()
      assert.deepStrictEqual(server.posts(), [])
    })
  }

  it('chelonia/reset still waits for the work of a write aborted while queued', async () => {
    await loadV0At40()
    server.log.length = 0
    const busy = holdInternalLane(CONTRACT_ID)
    const controller = new AbortController()
    const updating = update(controller.signal)
    controller.abort()
    await assert.rejects(within(updating, 'the update'), { name: 'AbortError' })
    const resetting = sbp('chelonia/reset')
    resetting.catch(() => {})
    assert.strictEqual(await settledOr(resetting, 200, 'pending'), 'pending')
    busy.open()
    await within(resetting, 'chelonia/reset')
    assert.deepStrictEqual(server.posts(), [])
  })
})

describe('conflicts that run out of attempts', () => {
  const blindSet = (maxAttempts?: number) => sbp('chelonia/kv/set', CONTRACT_ID, NS_CACHE, ['bob'], {
    ifMatch: '""', signingKeyId: cskId, encryptionKeyId: cekId, maxAttempts
  })
  const blindQueuedSet = (maxAttempts?: number) => sbp('chelonia/kv/queuedSet', {
    contractID: CONTRACT_ID, key: NS_CACHE, data: ['bob'], ifMatch: '""', maxAttempts
  })
  const isHandlerlessConflict = (name: string) => (e: any) =>
    e.name === name && isKvConflict(e) && /no onconflict handler was provided/.test(e.message)

  for (const maxAttempts of [undefined, 1]) {
    it(`a 412 without onconflict is a conflict for raw kv/set (maxAttempts: ${maxAttempts})`, async () => {
      await writeAsDeviceB(NS_CACHE, ['alice'], 40)
      await subscribeContract()
      server.log.length = 0
      await assert.rejects(blindSet(maxAttempts), isHandlerlessConflict('ChelErrorKvMaxAttempts'))
      assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    })

    it(`a 412 without onconflict is a conflict for queuedSet (maxAttempts: ${maxAttempts})`, async () => {
      await writeAsDeviceB(NS_CACHE, ['alice'], 40)
      await subscribeContract()
      server.log.length = 0
      await assert.rejects(blindQueuedSet(maxAttempts), isHandlerlessConflict('ChelErrorKvConflict'))
      assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    })
  }

  it('a 412 without onconflict on a value that is ahead syncs nothing', async () => {
    await subscribeContract()
    await writeAsDeviceB(NS_CACHE, ['alice'], 42)
    server.log.length = 0
    const syncsBefore = server.syncs
    await assert.rejects(blindQueuedSet(), isHandlerlessConflict('ChelErrorKvConflict'))
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it("clear's conflict error reports the last server value, like update's", async () => {
    await loadV0At40()
    const V1 = { roomA: room('v1', 1) }
    const V2 = { roomA: room('v2', 1) }
    // Two other devices win both POSTs of a two-attempt write: the first
    // 412 carries V1 (`onconflict` sees it), the last one V2 (which only
    // `kv/set` reads, when it runs out of attempts).
    const raceTwice = async () => {
      const v1 = await writeAsDeviceB(UNREAD, V1, 40)
      const v2 = await writeAsDeviceB(UNREAD, V2, 40)
      await writeAsDeviceB(UNREAD, V0, 40)
      server.onPost = (n) => {
        if (n === 1) server.store.set(UNREAD, v1)
        if (n === 2) server.store.set(UNREAD, v2)
      }
      server.log.length = 0
    }
    const reportsV2 = (e: any) => {
      const cause = e?.cause
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(cause.currentData, V2)
      return true
    }
    await raceTwice()
    await assert.rejects(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 2 }), reportsV2)
    await raceTwice()
    await assert.rejects(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ ...prev, roomZ: room('z', 1) })
    }), reportsV2)
    server.onPost = null
  })

  // The cause reports what the last response said about the server value,
  // with that response's etag: never an older round's value.
  const rawSet = (options: Record<string, unknown> = {}) =>
    sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
      ifMatch: '"stale"', signingKeyId: cskId, encryptionKeyId: cekId, ...options
    })

  it("raw kv/set reports the last 412's absent value, not an earlier one", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    // Another device deletes the key before the second POST.
    server.onPost = (n) => { if (n === 2) server.store.delete(UNREAD) }
    const seen: unknown[] = []
    await assert.rejects(rawSet({
      maxAttempts: 2,
      onconflict: ({ currentStatus, etag }: any) => {
        seen.push(currentStatus)
        return [{ x: 1 }, etag]
      }
    }), (e: any) => {
      assert.strictEqual(e.name, 'ChelErrorKvMaxAttempts')
      assert.deepStrictEqual(e.cause, { currentData: undefined, currentStatus: 'absent', etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    assert.deepStrictEqual(seen, ['present'])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412])
  })

  it('raw kv/set tells an absent value from one that is ahead', async () => {
    server.log.length = 0
    await assert.rejects(rawSet(), (e: any) => {
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, { currentData: undefined, currentStatus: 'absent', etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    await writeAsDeviceB(UNREAD, VB, 42)
    await assert.rejects(rawSet(), (e: any) => {
      // Without `onconflict`, a value that is ahead is still a conflict
      // (no height recovery could resolve it), but an unknown value.
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, { currentStatus: 'ahead', etag: server.etagOf(UNREAD) })
      assert.ok(!('currentData' in e.cause))
      return true
    })
    assert.strictEqual(localHeight(), 40)
  })

  it("an abort during kv/set's last read rejects with the abort, not a conflict", async () => {
    const controller = new AbortController()
    sbp('chelonia/configure', {
      fetch: async (url: string, opts: any = {}) => {
        if ((opts.method ?? 'GET') === 'GET' && new URL(url).pathname.startsWith('/kv/')) {
          controller.abort()
        }
        const response = await server.fetch(url, opts)
        if (response.status !== 412) return response
        // An intermediary that strips the 412's headers (no etag, empty
        // body), so that `kv/set` reads the value with a GET.
        return new Response(await response.text(), { status: 412 })
      }
    })
    await assert.rejects(
      rawSet({ signal: controller.signal }),
      (e: any) => e.name === 'AbortError' && !isKvConflict(e)
    )
    assert.strictEqual(controller.signal.aborted, true)
  })

  it("clear reports a deleted key as absent, with the last 412's etag", async () => {
    await loadV0At40()
    // Another device deletes the key: the mirror etag is stale.
    server.store.delete(UNREAD)
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }),
      (e: any) => {
        assert.ok(isKvConflict(e))
        assert.deepStrictEqual(e.cause, { currentStatus: 'absent', currentData: undefined, etag: '""' })
        return true
      }
    )
  })

  it("update reports the last 412's absent value, not the one onconflict saw", async () => {
    await writeAsDeviceB(UNREAD, { n: 0 }, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    await writeAsDeviceB(UNREAD, { n: 1 }, 40)
    server.log.length = 0
    server.onPost = (n) => { if (n === 2) server.store.delete(UNREAD) }
    await assert.rejects(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ n: prev.n + 10 })
    }), (e: any) => {
      assert.ok(isKvConflict(e))
      // Not `{ n: 1 }` (the first 412's value) with the second's etag, and
      // an absent value (`currentStatus: 'absent'`), not an unknown one.
      assert.deepStrictEqual(e.cause, { currentStatus: 'absent', currentData: undefined, etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    assert.strictEqual(server.store.has(UNREAD), false)
  })

  it('update tells an unknown value from an absent one', async () => {
    await writeAsDeviceB(UNREAD, { n: 0 }, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    await writeAsDeviceB(UNREAD, { n: 1 }, 40)
    // Signed at 40 but stamped 39: it can't be decoded.
    const tampered = restampedBody(UNREAD, '39')
    const tamperedEntry = { body: tampered, cid: createCID(tampered, multicodes.RAW) }
    server.log.length = 0
    // Another device stores it before the second POST.
    server.onPost = (n) => {
      if (n === 2) server.store.set(UNREAD, tamperedEntry)
    }
    await assert.rejects(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ n: prev.n + 10 })
    }), (e: any) => {
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, { etag: server.etagOf(UNREAD) })
      return true
    })
  })

  it('clear with a present value, then two malformed 412s, reports the last one', async () => {
    await loadV0At40()
    const keep = server.store.get(UNREAD)!
    const malformedAt = async (value: JSONType, stamp: string) => {
      await writeAsDeviceB(UNREAD, value, 40)
      const body = restampedBody(UNREAD, stamp)
      return { body, cid: createCID(body, multicodes.RAW) }
    }
    const m2 = await malformedAt({ roomA: room('m2', 2) }, '040')
    const m3 = await malformedAt({ roomA: room('m3', 3) }, '0040')
    server.store.set(UNREAD, keep)
    const p1 = await writeAsDeviceB(UNREAD, { roomA: room('p1', 1) }, 40)
    server.store.set(UNREAD, keep)
    const sequence = [p1, m2, m3]
    server.onPost = (n) => { if (sequence[n - 1]) server.store.set(UNREAD, sequence[n - 1]) }
    server.log.length = 0
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 3 }),
      (e: any) => {
        assert.ok(isKvConflict(e))
        // Not the first 412's value paired with a later etag.
        assert.deepStrictEqual(e.cause, { currentStatus: 'malformed', etag: `"${m3.cid}"` })
        return true
      }
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412, 412])
  })

  it("a server value that fails the slot's schema reports only its status and etag", async () => {
    await writeAsDeviceB(UNREAD, { x: 1 }, 40)
    const schema = {
      parse (v: any) {
        if (!v || typeof v !== 'object' || typeof v.x !== 'number') throw new Error('schema rejected')
        return v
      }
    }
    defineSlot({ key: UNREAD, schema, defaultValue: { x: 0 } })
    await activateContract()
    await writeAsDeviceB(UNREAD, { y: 'not an x' }, 40)
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }),
      (e: any) => {
        assert.ok(isKvConflict(e))
        // The last response's status and etag, without a value that isn't
        // valid for the slot (nor a made-up one).
        assert.deepStrictEqual(e.cause, { currentStatus: 'present', etag: server.etagOf(UNREAD) })
        return true
      }
    )
  })
})

describe('height recovery', () => {
  it("a deferred load's failed fallback sync retries when the height arrived anyway", async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    server.onSync = async () => {
      server.onSync = null
      setLocalHeight(42) // the events arrived some other way
      throw new Error('sync failed (503)')
    }
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    await untilWarned('retrying, since the contract reached height 42 anyway')
    assert.ok(!logged(warnings, 'giving up on height recovery'))
  })

  it('a recovery sync that fails after its waiters were aborted logs nothing', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    await writeAsDeviceB(NS_CACHE, { a: 0 }, 42)
    // Released after the test even if an assertion below fails, so that it
    // can't hold the contract's lane for the next tests.
    const held = holdNextSync()
    const controller = new AbortController()
    const onconflict = ({ etag }: any) => [{ x: 1 }, etag]
    const ops = [
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        signal: controller.signal,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }),
      ...[UNREAD, NS_CACHE].map((key) => sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
        key,
        data: { x: 1 },
        ifMatch: '"stale"',
        onconflict,
        signal: controller.signal
      }))
    ].map((p: Promise<unknown>) => p.then(() => 'resolved', (e: any) => e.name))
    await held.started
    // Every operation's write was rejected: each one is recovering (or is
    // about to), behind the one sync.
    await until(() => server.posts().length >= 3, 'the three writes were rejected')
    controller.abort()
    assert.deepStrictEqual(
      await within(Promise.all(ops), 'the aborted writes'),
      ['AbortError', 'AbortError', 'AbortError']
    )
    held.fail(new Error('sync failed (503)'))
    await sleep(50)
    assert.ok(!logged(warnings, 'failed during height recovery'))
    assert.strictEqual(server.syncs, 2) // activation + the one recovery
  })

  it("a fallback that concludes late doesn't cancel a newer deadline", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 300 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    server.log.length = 0
    // A single-key sync whose GET is answered after the first fallback
    // started its sync. It finds the value ahead and parks the deferred
    // reload (it drives the recovery itself, joining that sync); its abort
    // hands the slot back, with a new fallback deadline.
    const gets = holdGets()
    const controller = new AbortController()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
      .then(() => 'resolved', (e: any) => e.name)
    const held = holdNextSync()
    await within(held.started, "the first fallback's sync")
    gets.release()
    await until(() => server.gets().length === 1, "kv/sync's GET")
    // No passive wait while a recovery sync runs: it parks the wait at once.
    await until(() => heightWait(UNREAD)?.parked === true, 'kv/sync parked the wait')
    controller.abort()
    assert.strictEqual(await within(syncing, 'kv/sync'), 'AbortError')
    const syncsBefore = server.syncs
    // The first fallback's sync ends below the height, and it concludes.
    held.release()
    // The newer deadline still fires, with its own sync, and then gives up.
    await until(() => server.syncs > syncsBefore, 'the newer fallback syncs', 2000)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
  })

  const updateNsCache = () => sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID,
    key: NS_CACHE,
    maxHeightRecoveries: 1,
    updater: (prev: any) => ({ ...prev, b: 1 })
  })

  it('a recovery that joined a sync ending below its height syncs again', async () => {
    // UNREAD's first load is deferred on height 42; NS_CACHE is loaded,
    // and then device B writes it at 43.
    await writeAsDeviceB(NS_CACHE, { a: 0 }, 40)
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    defineSlot({ key: NS_CACHE })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    await writeAsDeviceB(NS_CACHE, { a: 1 }, 43)
    server.log.length = 0
    const syncsBefore = server.syncs
    // UNREAD's fallback starts a recovery sync, which reads the server's
    // HEAD at 42 and is held there; a fresh sync reads the current HEAD.
    let openSync!: () => void
    const syncGate = new Promise<void>((resolve) => { openSync = resolve })
    let syncStarted = false
    server.onSync = async () => {
      syncStarted = true
      await syncGate
      setLocalHeight(42)
      server.onSync = () => {
        server.onSync = null
        setLocalHeight(server.height)
      }
    }
    // The write's POST is in flight (holding the public lane) when that
    // sync starts, and gets its 412 after: the write's recovery joins it.
    let releasePost!: () => void
    const postGate = new Promise<void>((resolve) => { releasePost = resolve })
    let posting = false
    sbp('chelonia/configure', {
      fetch: async (url: string, opts: any = {}) => {
        if (opts.method === 'POST' && !posting) {
          posting = true
          await postGate
        }
        return server.fetch(url, opts)
      }
    })
    try {
      const writing = updateNsCache()
      await until(() => posting, "the write's POST")
      await until(() => syncStarted, "UNREAD's fallback sync", 2000)
      releasePost()
      await until(() => server.posts().length === 1, 'the write hit the value that is ahead')
      // It joins the held sync, a few microtasks after its 412. (Nothing
      // observable marks the join; the 412 needs no I/O to be handled.)
      await sleep(20)
      assert.strictEqual(server.syncs - syncsBefore, 1)
      openSync()
      await within(writing, 'update')
      assert.strictEqual(server.syncs - syncsBefore, 2)
      assert.strictEqual(localHeight(), 43)
      assert.deepStrictEqual(server.value(NS_CACHE), { a: 1, b: 1 })
      assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    } finally {
      releasePost()
      openSync()
    }
  })

  // The control for the test above. A sync the recovery started itself reads
  // the server's HEAD after the write's error, so it can't end below the
  // height that error requires: one sync is enough, and a second one would
  // be a regression.
  it("a recovery whose own sync reached the height doesn't sync again", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await writeAsDeviceB(UNREAD, V0, 40)
    await writeAsDeviceB(NS_CACHE, { a: 0 }, 40)
    defineSlot({ key: UNREAD })
    defineSlot({ key: NS_CACHE })
    await activateContract()
    // UNREAD now needs height 42 and NS_CACHE 43.
    await writeAsDeviceB(UNREAD, VB, 42)
    await writeAsDeviceB(NS_CACHE, { a: 1 }, 43)
    server.log.length = 0
    server.catchUpOnSync = true
    await within(updateNsCache(), 'update')
    assert.strictEqual(server.syncs, 2) // activation + one recovery
    assert.deepStrictEqual(server.value(NS_CACHE), { a: 1, b: 1 })
  })
})

describe("a deferred reload that can't start", () => {
  // How the reload is vetoed: a filter that throws from the
  // `queueInvocation` it goes through or returns `false` for it, one that
  // returns `false` for `_loadSlot` itself, which then returns nothing, or
  // one that returns `false` for `_loadSlotNow`, so that the queued reload
  // resolves without loading.
  type Veto = 'throws' | 'returns false' | 'vetoes queueInvocation' | 'vetoes _loadSlotNow'
  let veto: Veto | undefined
  sbp('sbp/filters/selector/add', 'chelonia/queueInvocation', () => {
    if (veto === 'throws') throw new Error('queueInvocation vetoed')
    if (veto === 'vetoes queueInvocation') return false
  })
  sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlot', () => {
    if (veto === 'returns false') return false
  })
  // Unlike the others, this one acts when the reload runs (on the lane),
  // after `setLocalHeight` returned: it vetoes until the test clears it.
  sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlotNow', () => {
    if (veto === 'vetoes _loadSlotNow') return false
  })
  const vetoed = (how: Veto, fn: () => void) => {
    veto = how
    addTeardown(() => { veto = undefined })
    try {
      fn()
    } finally {
      if (how !== 'vetoes _loadSlotNow') veto = undefined
    }
  }
  // The slot holds V0, and knows that the server holds a newer value (VB,
  // at 42).
  const markStale = async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
  }

  for (const [how, lastError] of [
    ['throws', { name: 'Error', message: 'queueInvocation vetoed' }],
    ['returns false', {
      name: 'ChelErrorUnexpected',
      message: `[chelonia/kv] the deferred reload of ${CONTRACT_ID}::${UNREAD} was vetoed`
    }],
    ['vetoes queueInvocation', {
      name: 'ChelErrorUnexpected',
      message: `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed (queueInvocation returned nothing)`
    }],
    [undefined, undefined]
  ] as const) {
    it(how
      ? `settles the slot and leaves nothing behind (a filter ${how})`
      : 'reloads the slot (control)', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
      await deferFirstLoad()
      if (how) vetoed(how, () => setLocalHeight(42))
      else setLocalHeight(42)
      await drainLanes()
      if (lastError) {
        assert.strictEqual(slotStatus(UNREAD), 'error')
        assert.strictEqual(mirror(UNREAD).lastError?.name, lastError.name)
        assert.strictEqual(mirror(UNREAD).lastError?.message, lastError.message)
        // Nothing verified the key: the marker stays until a load does.
        assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
        assert.ok(logged(errors, 'deferred reload rejected'))
        assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
        await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
        assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      }
      assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
      server.log.length = 0
      // No reload is left marked as queued: the mirror is a basis again.
      for (let i = 0; i < 3; i++) {
        await sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: () => KV_NOOP
        })
      }
      assert.strictEqual(server.gets().length, 0)
    })
  }

  for (const how of ['vetoes queueInvocation', 'vetoes _loadSlotNow', 'throws'] as const) {
    it(`keeps the marker of a slot holding a value, so that update reloads first (a filter ${how})`, async () => {
      await markStale()
      vetoed(how, () => setLocalHeight(42))
      await drainLanes()
      veto = undefined
      // Nothing verified the key: the mirror still holds V0, and still
      // knows it is stale.
      assert.deepStrictEqual(mirror(UNREAD).value, V0)
      assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
      server.log.length = 0
      // A reducer that is a KV_NOOP on V0 (it has no roomB): run on the
      // stale mirror, it would drop the write.
      await within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
      }), 'the update')
      assert.strictEqual(server.gets().length, 1)
      assert.ok(!('roomB' in server.value(UNREAD)))
      assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
    })
  }

  it("settles a re-activated slot that holds a value, keeping it, when its reload can't start", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await writeAsDeviceB(UNREAD, V0, 40)
    const etag = server.etagOf(UNREAD)
    await writeAsDeviceB(UNREAD, VB, 42)
    setLocalHeight(40)
    // A persisted entry: re-activating the slot unsettles it, and its load
    // finds the server value ahead.
    rootState()._kv = { [CONTRACT_ID]: { [UNREAD]: { status: 'loaded', value: V0, etag, settled: true } } }
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    vetoed('throws', () => setLocalHeight(42))
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
  })
})

describe('height-wait races', () => {
  it("the fallback doesn't settle a slot that single-key kv/sync is still recovering", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 300, recoveryTimeoutMs: 5000 })
    await deferFirstLoad()
    const { events } = collectStatusEvents(UNREAD)
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    addTeardown(() => releaseFirst())
    // The first sync (the fallback's) is held, and ends short of 42; the
    // next one (kv/sync's own) reaches it, after the fallback concluded.
    let syncs = 0
    server.onSync = async () => {
      if (++syncs === 1) {
        await firstHeld
        return
      }
      await sleep(150)
      setLocalHeight(42)
    }
    const gets = holdGets()
    const getsBefore = kvGetsRequested()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    await until(() => kvGetsRequested() > getsBefore, 'kv/sync never issued its GET')
    await until(() => syncs === 1, 'the fallback sync never started')
    gets.release()
    // kv/sync parks the wait and joins the fallback's sync.
    await until(() => heightWait(UNREAD)?.parked === true, 'kv/sync never parked the wait')
    releaseFirst()
    await within(syncing, 'kv/sync settles')
    await drainLanes()
    assert.ok(
      !events.some((e) => e.status === 'error'),
      `settled as a failure while kv/sync recovered: ${JSON.stringify(events.map((e) => e.status))}`
    )
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it("aborting single-key kv/sync doesn't bring back a wait that a verified load dropped", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000, pendingFallbackMs: 300 })
    await setupStaleDeviceA()
    const controller = new AbortController()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
    syncing.catch(() => {})
    await until(() => heightWait(UNREAD)?.parked === true, 'kv/sync never parked the wait')
    // The key is deleted; another load verifies that it is absent.
    server.store.delete(UNREAD)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(heightWait(UNREAD), undefined)
    const { events } = collectStatusEvents(UNREAD)
    controller.abort(new Error('caller gave up'))
    await assert.rejects(within(syncing, 'kv/sync settles'), /caller gave up/)
    assert.strictEqual(heightWait(UNREAD), undefined)
    assert.deepStrictEqual(events, [])
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
  })

  // `notifyContractHeight` fires listeners from a snapshot of the set.
  const listenerContext = () => ({ kvHeightListeners: new Map() }) as unknown as CheloniaContext

  it("a height listener removed by another one that fires first doesn't fire", () => {
    const ctx = listenerContext()
    const fired: string[] = []
    const removeB: Array<() => void> = []
    addHeightListener(ctx, CONTRACT_ID, 5, () => {
      fired.push('a')
      removeB[0]()
    })
    removeB.push(addHeightListener(ctx, CONTRACT_ID, 5, () => { fired.push('b') }))
    notifyContractHeight(ctx, CONTRACT_ID, 5)
    assert.deepStrictEqual(fired, ['a'])
    assert.strictEqual(ctx.kvHeightListeners.has(CONTRACT_ID), false)
  })

  it('a height listener that replaces the set keeps the new one', () => {
    const ctx = listenerContext()
    const fired: string[] = []
    const removeB: Array<() => void> = []
    addHeightListener(ctx, CONTRACT_ID, 5, () => {
      fired.push('a')
      // The set is empty then, so it leaves the map, and the next
      // registration creates a new one.
      removeB[0]()
      addHeightListener(ctx, CONTRACT_ID, 6, () => { fired.push('c') })
    })
    removeB.push(addHeightListener(ctx, CONTRACT_ID, 9, () => { fired.push('b') }))
    notifyContractHeight(ctx, CONTRACT_ID, 5)
    notifyContractHeight(ctx, CONTRACT_ID, 6)
    assert.deepStrictEqual(fired, ['a', 'c'])
  })
})

describe('the conflict backoff', () => {
  it("an update's caller abort ends the backoff at once", async () => {
    await loadV0At40()
    await writeAsDeviceB(UNREAD, VB, 40) // A's mirror etag is now stale
    Math.random = () => 0.9999 // a ~1500 ms backoff before the merge
    server.log.length = 0
    const controller = new AbortController()
    let abortedAt: number | undefined
    server.onPost = (n) => {
      if (n === 1) later(() => { abortedAt = Date.now(); controller.abort() }, 100)
    }
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        signal: controller.signal,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }), 'update'),
      { name: 'AbortError' }
    )
    assert.ok(abortedAt !== undefined)
    assert.ok(Date.now() - abortedAt < 1000, `rejected ${Date.now() - abortedAt} ms after the abort`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })
})

describe('the test harness', () => {
  it("holdNextSync's started rejects when no sync begins", async () => {
    const held = holdNextSync(50)
    await assert.rejects(held.started, /no contract sync started within 50 ms/)
  })

  it('holdNextSync released before the sync starts holds nothing', async () => {
    holdNextSync().release()
    await within(
      sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }),
      'a sync after the hold was released', 1000
    )
  })

  it("holdNextSync's started rejects when released before any sync", async () => {
    const held = holdNextSync()
    held.release()
    await assert.rejects(
      within(held.started, 'started settles'),
      /holdNextSync released before any sync started/
    )
  })

  it('the simulated server keeps keys and heights per contract', async () => {
    const OTHER = 'zKvHeightTestGroupContract'
    await writeAsDeviceB(UNREAD, V0, 40)
    const url = (contractID: string) => `https://example.test/kv/${contractID}/${UNREAD}`
    assert.strictEqual((await server.fetch(url(OTHER))).status, 404)
    server.setHeight(OTHER, 7)
    const body = restampedBody(UNREAD, '7')
    // `""` matches only an absent value, and 7 only the other contract.
    const posted = await server.fetch(url(OTHER), {
      method: 'POST', headers: { 'if-match': '""' }, body
    })
    assert.strictEqual(posted.status, 204)
    assert.strictEqual(server.storeOf(OTHER).get(UNREAD)?.body, body)
    assert.notStrictEqual(server.store.get(UNREAD)?.body, body)
    assert.strictEqual(server.height, 40)
  })

  it("an abort rejects the simulated server's held GET", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    holdGets()
    const controller = new AbortController()
    const getting = server.fetch(`https://example.test/kv/${CONTRACT_ID}/${UNREAD}`, {
      signal: controller.signal
    })
    controller.abort(new Error('stop waiting'))
    await assert.rejects(getting, /stop waiting/)
  })
})
