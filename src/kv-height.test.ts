// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// writes while the local contract is behind.
//
// Runs the real `chelonia/kv/*` selectors and slot loader against a
// simulated chel server; see `kv-height-harness.ts`, which also holds the
// helpers the `kv-height*.test.ts` files share. They're split by topic so
// that each file stays well within Node 22's per-file `--test-timeout`:
//
// - `kv-height.test.ts`: writes while the local contract is behind;
// - `kv-height-recovery.test.ts`: the passive height wait, height
//   recovery, and what it guarantees in place of an app-level guard;
// - `kv-height-loads.test.ts`: loads, and the height waits they leave;
// - `kv-height-reloads.test.ts`: the deferred reloads, and their
//   recovery syncs;
// - `kv-height-reset.test.ts`: `chelonia/reset`, vetoed queueing, aborts;
// - `kv-height-settled.test.ts`: `settled` and `whenSettled`;
// - `kv-height-conflicts.test.ts`: height stamps, and conflicts;
// - `kv-height-harness.test.ts`: the harness itself;
// - `kv-height-pubsub.test.ts`: the tests that need a pubsub connection.
//   `chelonia/connect` wires listeners that outlive `chelonia/_init`, so
//   connecting in another file would change how every later test in it
//   reconciles its slots.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import {
  ChelErrorKvSlotUnknown, ChelErrorKvUpdateInvalid, isKvConflict, isKvHeightAhead
} from './errors.js'
import { CHELONIA_KV_UPDATED } from './events.js'
import {
  CONTRACT_ID,
  INVALID_HEIGHT_RECOVERY_OPTIONS,
  MERGED_A2,
  NS_CACHE,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  cekId,
  cskId,
  deferFirstLoad,
  defineSlot,
  deleteChatRoomUnreadMessages,
  drainLanes,
  failFirstLoad,
  failKvGets,
  gateLane,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  isAheadAt42,
  isInvalidOptions,
  later,
  loadV0At40,
  loadedRefreshGivesUp,
  loadedWithWait,
  localHeight,
  mergeNames,
  mirror,
  namesWrittenAhead,
  onEvent,
  probePublicLaneOnSync,
  recordingUpdate,
  restamp,
  room,
  rootState,
  server,
  setLocalHeight,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  until,
  untilWarned,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { KV_NOOP } from './kv.js'
import { logged, settledOr } from './test-utils.js'
import type { KvHeightRecoveryAttempt } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

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
  // device missed (the server is at 46), one every `stepMs`. Re-signing at
  // each replayed height would only get another 409 each time, and give up
  // one event short. Resolves once the replay started.
  const catchUp = async (stepMs: number) => {
    server.height = 46
    let replaying = false
    server.onSync = async () => {
      server.onSync = null
      replaying = true
      for (let height = 41; height <= 46; height++) {
        await sleep(stepMs)
        setLocalHeight(height)
      }
    }
    const syncing = sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    await until(() => replaying, 'the catch-up sync started')
    return () => within(syncing, 'the catch-up sync')
  }
  const statusesAndStamps = () => server.posts().map((p) => [p.status, p.height])

  it('a 409 during a catch-up sync waits for the sync to end, then re-signs once', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500 })
    await loadV0At40()
    server.log.length = 0
    const synced = await catchUp(30)
    await within(sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: mirror(UNREAD).etag, signingKeyId: cskId, encryptionKeyId: cekId
    }), 'kv/set')
    await synced()
    assert.deepStrictEqual(statusesAndStamps(), [[409, '40'], [204, '46']])
  })

  // The replay (360 ms) outlasts `heightWaitMs`: the call gives up after its
  // one 409 rather than re-sign at each replayed height.
  // `withHeightRecovery` retries it once the sync ends.
  it('a 409 during a catch-up sync that outlasts heightWaitMs rejects as ahead', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500 })
    await loadV0At40()
    server.log.length = 0
    const synced = await catchUp(60)
    await assert.rejects(within(sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: mirror(UNREAD).etag, signingKeyId: cskId, encryptionKeyId: cekId, heightWaitMs: 100
    }), 'kv/set'), isKvHeightAhead)
    await synced()
    assert.deepStrictEqual(statusesAndStamps(), [[409, '40']])
  })

  // The sync starts while the update's first POST (stamped 40) is in
  // flight, and POSTs take 70 ms to answer: the 409 arrives mid-replay. The
  // update's non-final attempts don't wait (`heightWaitMs: 0`); its
  // recovery queues behind the sync instead, and signs once.
  it('an update whose POST is in flight when a catch-up sync starts re-signs once', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500 })
    await loadV0At40()
    server.log.length = 0
    const real = server.handleKv
    server.handleKv = async (pathname, opts = {}) => {
      const response = await real(pathname, opts)
      if (opts.method === 'POST') await sleep(70)
      return response
    }
    addTeardown(() => { server.handleKv = real })
    let synced: Promise<() => Promise<unknown>> | undefined
    server.onPost = (n) => {
      if (n !== 1) return
      synced = catchUp(60)
    }
    addTeardown(() => { server.onPost = null })
    const syncsBefore = server.syncs
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    }), 'the update')
    assert.ok(synced, 'the catch-up sync never started')
    await (await synced)()
    assert.deepStrictEqual(statusesAndStamps(), [[409, '40'], [204, '46']])
    // The catch-up sync only: the recovery waited for it.
    assert.strictEqual(server.syncs - syncsBefore, 1)
  })

  // Control: started mid-replay, the update's lane work queues behind the
  // sync, which runs on the contract's internal lane. It can't POST during
  // the replay.
  it('an update started during a catch-up sync POSTs once, after it', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500 })
    await loadV0At40()
    server.log.length = 0
    const synced = await catchUp(60)
    await sleep(130)
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    }), 'the update')
    await synced()
    assert.deepStrictEqual(statusesAndStamps(), [[204, '46']])
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
    await assert.rejects(recordingUpdate(bases, { onHeightAhead: 'reject' }), isAheadAt42)
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

  it("an 'error' slot whose server value is ahead recovers instead of seeding from its retained value", async () => {
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

  it("an 'error' slot whose server value is ahead rejects, then reloads at the height", async () => {
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

  it("an 'error' slot whose server value is ahead: a writing reducer neither 412s nor waits", async () => {
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
    await failFirstLoad(40)
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
    await loadedWithWait()
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
    await untilWarned(`contract sync for ${CONTRACT_ID} failed; retrying, since the contract reached height 42`)
    assert.ok(!logged(warnings, 'giving up'))
  })

  it('a failed recovery sync rejects when the contract is still behind', async () => {
    await setupStaleDeviceA()
    server.onSync = () => { throw new Error('sync failed') }
    await assert.rejects(recordingUpdate([]), isAheadAt42)
    assert.strictEqual(localHeight(), 40)
    assert.deepStrictEqual(server.value(UNREAD), VB)
    await untilWarned(`contract sync for ${CONTRACT_ID} failed; giving up on height recovery`)
  })

  it('a timed-out recovery sync is retried when the contract reached the height anyway', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const updating = recordingUpdate([])
    await held.started
    later(() => setLocalHeight(42), 100)
    // The retry waits behind the sync, which still holds the contract's
    // lane after the 300 ms timeout.
    let released = false
    later(() => { released = true; held.release() }, 600)
    assert.deepStrictEqual(await within(updating, 'the update'), MERGED_A2)
    assert.ok(released, 'the update settled before the sync was released')
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
      if (marked) {
        // The aggregate refresh finds VB ahead: the slot gets the marker.
        await loadedWithWait({ waitMs: 1000 })
      } else {
        sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000, pendingFallbackMs: 60000 })
        await setupStaleDeviceA()
        server.log.length = 0
      }
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

  // The data-loss guard's reload finds VB ahead, and waits for the height
  // (no recoveries left); the reload after the wait fails. The retained V0
  // is then known to be stale: the reducer may run on it only as on a failed
  // 'basis' reload, where a KV_NOOP rejects and the retained etag guards the
  // write, and never under the caller's own `ifMatch` (KV-REVAMPED.md §3.3).
  const guardReloadFailsAfterWait = async (
    reducer: (prev: any) => unknown, ifMatch?: string
  ) => {
    await errorSlotWithStaleValue()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000, pendingFallbackMs: 10000 })
    later(() => setLocalHeight(42), 150)
    const restore = failKvGets(1, 500, () => localHeight() >= 42)
    addTeardown(restore)
    const bases: unknown[] = []
    const syncsBefore = server.syncs
    const updating = within(recordingUpdate(bases, {
      reducer, maxHeightRecoveries: 0, ...(ifMatch !== undefined ? { ifMatch } : {})
    }), 'the update')
    return { bases, syncsBefore, updating }
  }

  it('a guard reload that fails after finding the value ahead: a KV_NOOP rejects, and writes nothing', async () => {
    const { bases, syncsBefore, updating } =
      await guardReloadFailsAfterWait(deleteChatRoomUnreadMessages('roomB'))
    await assert.rejects(updating, { name: 'ChelErrorUnexpectedHttpResponseCode' })
    assert.deepStrictEqual(bases, [V0])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    assert.strictEqual(server.syncs, syncsBefore)
    assert.ok(!logged(warnings, 'seeding reducer from retained value'))
  })

  it("a guard reload that fails after finding the value ahead rejects under ifMatch: '*'", async () => {
    const { bases, updating } =
      await guardReloadFailsAfterWait(addChatRoomUnreadMessage('roomA', 'a2', 5), '*')
    await assert.rejects(updating, { name: 'ChelErrorUnexpectedHttpResponseCode' })
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a guard reload that fails after finding the value ahead: a write merges on the 412 (control)', async () => {
    const { bases, updating } =
      await guardReloadFailsAfterWait(addChatRoomUnreadMessage('roomA', 'a2', 5))
    assert.deepStrictEqual(await updating, MERGED_A2)
    assert.deepStrictEqual(bases, [V0, VB])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.deepStrictEqual(server.value(UNREAD), MERGED_A2)
    assert.ok(logged(warnings, 'running the reducer on the current mirror value'))
  })

  // The data-loss guard's reload fails (500) on an 'error' slot holding V0,
  // while the server holds VB, verifiable at this height. The retained etag
  // guards a write from V0 (a 412 brings VB to the merge); the caller's own
  // `ifMatch: '*'` guards nothing, so the call rejects.
  for (const ifMatch of ['*', undefined]) {
    it(ifMatch
      ? "a guard reload that fails rejects under the caller's own ifMatch, writing nothing"
      : 'a guard reload that fails seeds from the retained value, and the 412 merges (control)', async () => {
      await loadV0At40()
      const restoreLoad = failKvGets(1)
      await assert.rejects(
        within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'kv/sync'),
        { name: 'ChelErrorUnexpectedHttpResponseCode' }
      )
      restoreLoad()
      assert.strictEqual(slotStatus(UNREAD), 'error')
      await writeAsDeviceB(UNREAD, VB, 40)
      server.log.length = 0
      addTeardown(failKvGets(1))
      const bases: unknown[] = []
      const updating = within(recordingUpdate(bases, {
        reducer: initChatRoomUnreadMessages('roomC', 'c1', 3),
        ...(ifMatch !== undefined ? { ifMatch } : {})
      }), 'the update')
      const requests = () => server.log.map((e) => [e.method, e.status])
      if (ifMatch) {
        await assert.rejects(updating, { name: 'ChelErrorUnexpectedHttpResponseCode' })
        assert.deepStrictEqual(bases, [])
        assert.deepStrictEqual(requests(), [['GET', 500]])
        assert.deepStrictEqual(server.value(UNREAD), VB)
        return
      }
      await updating
      assert.deepStrictEqual(bases, [V0, VB])
      assert.deepStrictEqual(requests(), [['GET', 500], ['POST', 412], ['POST', 204]])
      assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
      assert.ok(logged(warnings, 'seeding reducer from retained value'))
    })
  }

  it('a slot replaced during the guard reload\'s passive wait rejects, without reporting a failed reload', async () => {
    await errorSlotWithStaleValue()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000, pendingFallbackMs: 10000 })
    later(() => {
      // Defining the slot again replaces it; then the height arrives.
      defineSlot({ key: UNREAD })
      setLocalHeight(42)
    }, 150)
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxHeightRecoveries: 0,
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update'), ChelErrorKvSlotUnknown)
    assert.deepStrictEqual(server.posts(), [])
    // Neither the retained value's warning nor a failed `'basis'` reload's
    // (the reload found the value ahead): the reducer never runs.
    assert.ok(!logged(warnings, '[chelonia/kv] update:'), JSON.stringify(warnings.map((w) => w[0])))
  })

  it("a slot marked stale with onHeightAhead: 'reject' still rejects at once", async () => {
    await loadedWithWait({ waitMs: 1000 })
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

  // As slot writes do: only `encryptionKeyName: null` stores plaintext.
  it("queuedSet refuses to write plaintext when the contract has no 'cek'", async () => {
    delete rootState()[CONTRACT_ID]._vm.authorizedKeys[cekId]
    const data = { note: 'plain-secret' }
    await assert.rejects(
      within(sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID, key: NS_CACHE, data, ifMatch: '*'
      }), 'queuedSet'),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
        e.message.endsWith("'cek' not found on contract; refusing to write plaintext")
    )
    assert.deepStrictEqual(server.posts(), [])
    assert.ok(!server.store.has(NS_CACHE))
    await within(sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: NS_CACHE, data, ifMatch: '*', encryptionKeyName: null
    }), 'the plaintext queuedSet')
    assert.ok(server.store.get(NS_CACHE)!.body.includes('plain-secret'))
  })

  // Nor does it send a write it can't sign, as slot writes don't.
  it('queuedSet refuses to write when the contract has no key of its signingKeyName', async () => {
    await assert.rejects(
      within(sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID, key: NS_CACHE, data: ['alice'], ifMatch: '*', signingKeyName: 'nope'
      }), 'queuedSet'),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
        e.message === `[chelonia/kv] queuedSet: ${CONTRACT_ID}::${NS_CACHE}: signing key ` +
          "'nope' not found on contract"
    )
    assert.deepStrictEqual(server.posts(), [])
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
    for (const options of INVALID_HEIGHT_RECOVERY_OPTIONS) {
      await assert.rejects(
        sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: () => ({}), ...options
        }),
        isInvalidOptions(`update: ${CONTRACT_ID}::${UNREAD}`)
      )
      await assert.rejects(
        sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, options),
        isInvalidOptions(`clear: ${CONTRACT_ID}::${UNREAD}`)
      )
      await assert.rejects(
        sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, key: UNREAD, data: {}, ...options }),
        isInvalidOptions(`queuedSet: ${CONTRACT_ID}::${UNREAD}`)
      )
    }
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  // As for `maxAttempts` and `heightWaitMs`. Each call starts with the
  // server one height ahead, so that only a recovery sync (the default
  // `'sync'`, with recoveries left) lets it succeed: the writes' stamps are
  // stale (`409`), and the load finds a value written ahead.
  it('takes null height-recovery options as the defaults', async () => {
    await loadV0At40()
    server.catchUpOnSync = true
    server.log.length = 0
    let height = 40
    for (const option of ['onHeightAhead', 'maxHeightRecoveries']) {
      const options = { [option]: null }
      const afterOneSync = async (selector: string, call: () => Promise<unknown>) => {
        const what = `${selector} with ${option}: null`
        const syncsBefore = server.syncs
        const result = await within(call(), what)
        assert.strictEqual(server.syncs - syncsBefore, 1, what)
        return result
      }
      server.height = ++height
      await afterOneSync('update', () => sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: initChatRoomUnreadMessages(`room-${option}`, 'm1', 1),
        ...options
      }))
      server.height = ++height
      await afterOneSync('clear', () => sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, options))
      server.height = ++height
      await afterOneSync('queuedSet', () => sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID, key: UNREAD, data: VB, ifMatch: '*', ...options
      }))
      server.height = ++height
      const raw = await afterOneSync('withHeightRecovery', () => sbp(
        'chelonia/kv/withHeightRecovery', CONTRACT_ID,
        ({ heightWaitMs, queue }: KvHeightRecoveryAttempt) => queue(() =>
          sbp('chelonia/kv/set', CONTRACT_ID, 'raw', V0, {
            ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId, heightWaitMs
          })
        ),
        options
      ))
      assert.strictEqual(typeof (raw as { etag?: unknown }).etag, 'string')
      await writeAsDeviceB(UNREAD, V0, ++height)
      await afterOneSync('sync', () => sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, options))
      assert.deepStrictEqual(mirror(UNREAD).value, V0)
    }
    // Each write: a stale stamp, then the retry; device B's write last.
    const iteration = [409, 204, 409, 204, 409, 204, 409, 204, 204]
    assert.deepStrictEqual(server.posts().map((p) => p.status), [...iteration, ...iteration])
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

  // The slot is resolved before `signal` is checked, by all three.
  it('an unknown slot with an aborted signal rejects with ChelErrorKvSlotUnknown', async () => {
    await loadV0At40()
    const signal = AbortSignal.abort()
    for (const call of [
      () => sbp('chelonia/kv/sync', CONTRACT_ID, 'no-such-key', { signal }),
      () => sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: 'no-such-key', updater: () => ({}), signal
      }),
      () => sbp('chelonia/kv/clear', CONTRACT_ID, 'no-such-key', { signal })
    ]) {
      await assert.rejects(within(call(), 'the call'), ChelErrorKvSlotUnknown)
    }
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
  // running out of attempts is plain contention, reported at once. The slot
  // still records the value as ahead, as a load that found it would (and as
  // "an update that gives up on a value that is ahead" does).
  it('a clear that runs out of attempts on a value that is ahead marks the slot, and the next update reloads first', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, waitMs: 3000 })
    await setupStaleDeviceA()
    const syncsBefore = server.syncs
    server.log.length = 0
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }), 'the clear'),
      (e: any) => {
        assert.strictEqual(isKvConflict(e), true)
        assert.strictEqual(isKvHeightAhead(e), false)
        // The last 412's etag: what the server still holds.
        assert.strictEqual(e.cause.etag, server.etagOf(UNREAD))
        assert.strictEqual(e.cause.currentStatus, 'ahead')
        assert.strictEqual(e.cause.requiredHeight, 42)
        return true
      }
    )
    // No passive wait for the value's height either.
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    // The slot keeps V0, but no longer as the basis of a reducer.
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    // So the next update reloads first, and deletes roomB, which only VB
    // has (on V0, its reducer would have nothing to do).
    server.log.length = 0
    server.catchUpOnSync = true
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), 'the update')
    assert.strictEqual(server.log[0]?.method, 'GET')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it("a clear that runs out of attempts on a value that is ahead turns a settled 'non-init' slot 'loading' until the value loads", async () => {
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
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 2 }), 'the clear'),
      (e: any) => {
        assert.strictEqual(isKvConflict(e), true)
        assert.strictEqual(e.cause.etag, `"${entries[1].cid}"`)
        assert.strictEqual(e.cause.requiredHeight, 42)
        return true
      }
    )
    server.onPost = null
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412])
    assert.strictEqual(server.syncs, syncsBefore)
    // The server holds a value, so the slot no longer reports none.
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD) ?? null, null)
    const settling = whenSettledWithin(UNREAD)
    assert.strictEqual(await settledOr(settling, 200, 'pending'), 'pending')
    // Once the height arrives, the slot loads the value.
    setLocalHeight(42)
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), { roomA: room('x1', 1) })
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
