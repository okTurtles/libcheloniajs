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
  ChelErrorKvConflict,
  ChelErrorKvHeightAhead,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorSignatureKeyUnauthorized,
  isKvConflict,
  isKvHeightAhead,
  kvHeightAheadCause
} from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED, EVENT_HANDLED } from './events.js'
import { createCID, multicodes } from './functions.js'
import {
  CONTRACT_ID,
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
  failKvGets,
  gateLane,
  holdGets,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  kvGetsRequested,
  later,
  localHeight,
  mirror,
  onEvent,
  probePublicLaneOnSync,
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
import { readHeightStamp } from './kv-height.js'
import { KV_NOOP } from './kv.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { settledOr, withLocalHeight } from './test-utils.js'
import type { JSONType } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

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
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    // The server keeps a value this device can never verify.
    const bases: any[] = []
    await assert.rejects(
      recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) }),
      (e: any) => e instanceof ChelErrorKvHeightAhead
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
    await assert.rejects(recordingUpdate(bases), ChelErrorKvHeightAhead)
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("onHeightAhead: 'reject' rejects at once during a deferred first load", async () => {
    await deferFirstLoad()
    const syncsBefore = server.syncs
    const bases: any[] = []
    await assert.rejects(recordingUpdate(bases, { onHeightAhead: 'reject' }), ChelErrorKvHeightAhead)
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
    await lane.held
    assert.deepStrictEqual(await updating, MERGED_A2)
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
    await assert.rejects(recordingUpdate(bases), ChelErrorKvHeightAhead)
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
    await assert.rejects(recordingUpdate(bases, { reducer }), ChelErrorKvHeightAhead)
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
      ChelErrorKvHeightAhead
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
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 500, pendingFallbackMs: 10000 })
    server.catchUpOnSync = true
    const started = Date.now()
    const result = await recordingUpdate([])
    assert.deepStrictEqual(result, MERGED_A2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.ok(Date.now() - started < 500)
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

  it("an 'error' slot without a value reloads before a KV_NOOP reducer runs", async () => {
    await failedFirstLoad()
    const bases: any[] = []
    const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    assert.deepStrictEqual(bases, [VB])
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
    assert.deepStrictEqual(bases, [VB])
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
      // The reducer ran on the default, and returned KV_NOOP.
      assert.deepStrictEqual(bases, [{}])
    }
    assert.strictEqual(server.gets().length, 2)
    assert.deepStrictEqual(server.posts(), [])
    assert.ok('roomB' in server.value(UNREAD))
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
  })

  it("an 'error' slot without a value whose reload fails: a write still merges on the 412", async () => {
    await failedFirstLoad()
    failKvGets(1)
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
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
    assert.ok(!warnings.some((w) => String(w[0]).includes('giving up')))
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
    assert.deepStrictEqual(await updating, MERGED_A2)
    assert.ok(Date.now() - started >= 600)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    await untilWarned('did not finish within 300 ms; retrying, since the contract reached height 42')
    assert.ok(!warnings.some((w) => String(w[0]).includes('giving up')))
  })

  it('a value that becomes verifiable during the wait is merged, not overwritten', async () => {
    // The height arrives 10 ms into the wait: leave the wait ample room.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
    await setupStaleDeviceA()
    server.onPost = (n) => {
      if (n === 1) later(() => advanceLocalHeightOnInternalLane(42), 10)
    }
    // With 'reject', `update` doesn't recover, so `kv/set` waits passively.
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      onHeightAhead: 'reject',
      updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
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
    // Recovery only syncs subscribed contracts.
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
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
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    // Recovery only syncs subscribed contracts (syncing an unsubscribed one
    // would subscribe it).
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    assert.strictEqual(localHeight(), 40)
    server.catchUpOnSync = true
    const seen: unknown[] = []
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
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
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    const syncsBefore = server.syncs
    let conflicts = 0
    await assert.rejects(
      sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
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
    assert.strictEqual(server.syncs, syncsBefore + 2) // maxHeightRecoveries (2)
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob'])
  })

  it('queuedSet passes allowUnverifiedConflict on to kv/set', async () => {
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
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
        assert.strictEqual(e instanceof ChelErrorKvConflict, true)
        assert.strictEqual(isKvConflict(e), true)
        // Neither bad value passes the schema, so the fallback pair is
        // reported, value and etag together: `null` (clear's intended
        // write value) with the etag `onconflict` saw last, at attempt 2's
        // first conflict. Not VB, which only attempt 1 saw.
        assert.strictEqual(e.cause.currentData, null)
        assert.strictEqual(e.cause.etag, `"${bad1.cid}"`)
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
        assert.strictEqual(e instanceof ChelErrorKvConflict, true)
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

  it('a clear that gives up on a value that is ahead defers a reload, as update does', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1, onHeightAhead: 'reject' }),
      (e: any) => isKvHeightAhead(e) && kvHeightAheadCause(e)!.exact === true
    )
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    assert.strictEqual(server.gets().length, 0)
    // Reaching the height reloads the slot.
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
  })

  it('a committed clear ends the height wait the key had, and its marker', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    // A stored value stamped above any height the contract reaches here.
    const body = restampedBody(UNREAD, '100')
    server.store.set(UNREAD, { body, cid: createCID(body, multicodes.RAW) })
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
// wait passively for it first (with the contract's lane held).
describe('the passive height wait, with production timings', () => {
  // The slot is loaded at 40, and the server has processed contract events
  // (no KV change) up to 42, which a recovery sync delivers.
  const loadedThenServerMovesOn = async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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

  for (const [name, write] of [
    ['update', () => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })],
    ['clear', () => sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD)],
    ['queuedSet', () => sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: UNREAD, data: V0, ifMatch: '*'
    })]
  ] as const) {
    it(`${name} on a client that is behind syncs at once, without holding the lane`, async () => {
      await loadedThenServerMovesOn()
      const started = Date.now()
      const lane = probeLane(started)
      await write()
      assert.ok(Date.now() - started < 300, `took ${Date.now() - started} ms`)
      await until(() => lane.ranAt !== undefined, 'the lane probe never ran')
      assert.ok(lane.ranAt! < 300, `the lane probe ran after ${lane.ranAt} ms`)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
      assert.strictEqual(server.syncs, 2) // activation + one recovery
    })
  }

  it('a server that keeps moving costs one sync per stale stamp, not a wait', async () => {
    await loadedThenServerMovesOn()
    // The server moves one event further with the first two POSTs.
    server.onPost = (n) => { if (n <= 2) server.height = 41 + n }
    const started = Date.now()
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    assert.ok(Date.now() - started < 300, `took ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '40'], [409, '42'], [204, '43']
    ])
    assert.strictEqual(server.syncs, 3) // activation + two recoveries
  })

  it("with onHeightAhead: 'reject', update still waits passively", async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 200 })
    const started = Date.now()
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }),
      ChelErrorKvHeightAhead
    )
    assert.ok(Date.now() - started >= 200)
    assert.strictEqual(server.syncs, 1)
  })

  it('raw kv/set waits passively, unless given heightWaitMs: 0', async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 200 })
    const set = (options: Record<string, unknown> = {}) => sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId, ...options
    })
    let started = Date.now()
    await assert.rejects(set(), ChelErrorKvHeightAhead)
    assert.ok(Date.now() - started >= 200)
    started = Date.now()
    await assert.rejects(set({ heightWaitMs: 0 }), ChelErrorKvHeightAhead)
    assert.ok(Date.now() - started < 100)
    // A height already reached needs no wait.
    setLocalHeight(42)
    await set({ heightWaitMs: 0 })
    for (const heightWaitMs of [-1, NaN, Infinity, '0']) {
      await assert.rejects(set({ heightWaitMs }), TypeError)
    }
  })
})

// The loop docs/kv.md suggests to raw `kv/set` callers, verbatim.
describe('the raw kv/set recovery loop of docs/kv.md', () => {
  const docsLoop = async (
    contractID: string, key: string, data: JSONType, options: Record<string, unknown>
  ) => {
    for (let recoveries = 0; ; recoveries++) {
      try {
        return await sbp('chelonia/queueInvocation', contractID, () =>
          sbp('chelonia/kv/set', contractID, key, data, { ...options, heightWaitMs: 0 }))
      } catch (e) {
        if (!isKvHeightAhead(e) || recoveries >= 2) throw e
        // Outside the queue. A failed sync must not replace the write's error.
        await sbp('chelonia/contract/sync', contractID).catch((syncError: unknown) => {
          console.warn('[app] height-recovery sync failed', syncError)
          throw e
        })
      }
    }
  }
  // The server has processed contract events (no KV change) that this
  // client hasn't: its next write gets a 409.
  const write = async ({ retain, failSync = false }: { retain: boolean; failSync?: boolean }) => {
    await writeAsDeviceB(UNREAD, V0, 40)
    await subscribeContract()
    if (retain) await sbp('chelonia/contract/retain', CONTRACT_ID)
    server.height = 42
    if (failSync) server.onSync = () => { throw new Error('sync failed (503)') }
    server.log.length = 0
    return docsLoop(CONTRACT_ID, UNREAD, VB, {
      ifMatch: server.etagOf(UNREAD), signingKeyId: cskId, encryptionKeyId: cekId
    })
  }

  it('recovers once the sync brings the contract up to date', async () => {
    server.catchUpOnSync = true
    await write({ retain: true })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("rejects with the write's error when the sync fails", async () => {
    await assert.rejects(
      write({ retain: true, failSync: true }), (e: unknown) => isKvHeightAhead(e)
    )
    assert.ok(warnings.some((w) => String(w[0]).includes('[app] height-recovery sync failed')))
  })

  it("rejects with the write's error for a released contract", async () => {
    await assert.rejects(write({ retain: false }), (e: unknown) => isKvHeightAhead(e))
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
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
})

// What an app-level height guard (e.g. Group Income's `kv-guard.js`) did,
// and which the library now does instead: these must keep holding for such
// a guard to stay deleted.
describe('guarantees that replace an app-level height guard', () => {
  it('queuedSet recovers with the queue lane released', async () => {
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    await sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
    server.catchUpOnSync = true
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['carol'],
      onconflict: async ({ currentData = [], etag }: any) => [[...currentData, 'carol'], etag]
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

  it("a recovering write awaited on another contract's lane completes", async () => {
    // E.g. a chatroom contract's side effect that updates an identity slot.
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const writing = sbp('chelonia/private/queueEvent', 'zKvHeightTestChatroomContract', () =>
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
      })
    )
    const outcome = await within(writing, 'the write awaited on the other lane')
    assert.deepStrictEqual(outcome, { ...VB, roomC: room('c1', 3) })
  })

  it('a KV_NOOP on a verified, loaded slot makes no request', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    const before = server.requests.length
    assert.strictEqual(await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), undefined)
    assert.strictEqual(server.requests.length, before)
  })

  it('a write while the contract is up to date runs no contract sync', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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
    // Slower than the 50 ms passive wait: every write fails before the
    // first recovery sync ends, so their recoveries overlap.
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
    // A settled-based gate, as Group Income's unread-messages gate becomes.
    const flushed: unknown[] = []
    const { events, off } = collectStatusEvents(UNREAD)
    const offGate = onEvent(CHELONIA_KV_STATUS_CHANGED, (p: any) => {
      if (p.contractID === CONTRACT_ID && p.key === UNREAD && p.settled) {
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
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), ChelErrorKvHeightAhead)
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
      ChelErrorKvHeightAhead
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
    await lane.held
    await syncing
    await drainLanes()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status]), [['loading', 'loaded']])
  })

  it("a slot reloading the value it holds settles 'loaded' when its deferred load gives up", async () => {
    await setupStaleDeviceA()
    await sbp('chelonia/kv/sync', CONTRACT_ID) // deferred, with a 300 ms fallback
    await drainLanes()
    const gets = holdGets()
    // A refresh that shows 'loading' while its GET is held.
    const reloading = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => slotStatus(UNREAD) === 'loading', 'the refresh never started')
    await until(() => slotStatus(UNREAD) !== 'loading', 'the fallback never gave up')
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.strictEqual(mirror(UNREAD).lastError, undefined)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    gets.release()
    await reloading
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })
})

describe("a verified load ends the key's height wait", () => {
  const V2 = { roomA: room('v2', 1) }

  // Replaces the stored value's height stamp, keeping the rest.
  const restamp = (key: string, stamp: string) => {
    const body = restampedBody(key, stamp)
    server.store.set(key, { body, cid: createCID(body, multicodes.RAW) })
  }

  // A loaded slot (V0) finds a value no contract height reaches, so a
  // height wait is registered. Then the server holds a verifiable value
  // again (V2), or none, and a refresh loads it.
  const waitThenVerifiedLoad = async (deleteValue: boolean) => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => slotStatus(UNREAD) === 'loading', 'the refresh never started')
    // E.g. a frame for a newer write, at a height not reached yet.
    sbp('chelonia/kv/_registerHeightWait', {
      contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
    })
    gets.release()
    await syncing
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
    await lane.held
    assert.deepStrictEqual(await writing, V0)
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
    await sleep(50) // kv/sync waits for the height, outside the lane
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: deleteChatRoomUnreadMessages('roomB')
      }),
      ChelErrorKvHeightAhead
    )
    assert.deepStrictEqual(server.posts(), [])
    await assert.rejects(syncing, ChelErrorKvHeightAhead)
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
    assert.deepStrictEqual(await writing, V0)
    await syncing
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
    await syncing
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
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), ChelErrorKvHeightAhead)
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(await whenSettledWithin(UNREAD, 100), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
  })

  it('the first update of a never-loaded slot loads it first, which settles it', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    })
    off()
    // The pre-reducer GET reports 'loading', and its 404 settles the slot.
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'non-init', true],
      ['non-init', 'loaded', true]
    ])
  })

  it('a committed local write settles the slot', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    // The pre-reducer GET fails: only the write settles the slot.
    const restore = failKvGets(1)
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    })
    restore()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'non-init', false],
      ['non-init', 'loaded', true]
    ])
  })

  it('whenSettled waits for activation and rejects on abort and on reset', async () => {
    const early = whenSettledWithin('absent')
    defineSlot({ key: 'absent' })
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
    await syncing
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
    await assert.rejects(recordingUpdate(bases, { reducer }), ChelErrorKvHeightAhead)
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("a persisted entry's revalidation doesn't resolve whenSettled before the slot is active", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
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
    // Revalidates the persisted entry ('error' -> 'loaded'): the contract
    // hasn't synced, so nothing is settled in this session yet.
    defineSlot({ key: UNREAD })
    await until(() => mirror(UNREAD).status === 'loaded', 'the persisted entry was never revalidated')
    assert.strictEqual(settledAs, undefined)
    await activateContract()
    await settling
    assert.strictEqual(settledAs, 'loaded')
    assert.strictEqual(server.gets().length, 1)
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
    sbp('chelonia/kv/_clearHeightWaits')
    server.log.length = 0
    const bases: unknown[] = []
    await assert.rejects(
      recordingUpdate(bases, {
        reducer: deleteChatRoomUnreadMessages('roomB'), maxHeightRecoveries: 0
      }),
      ChelErrorKvHeightAhead
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
    // `parseInt` reads these as 4 and 0, inside the key's window.
    for (const stamp of ['4e1', '0.4e2']) {
      assert.throws(() => parse(signedAt(stamp)), ChelErrorInvalidMessageHeight, stamp)
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
    assert.strictEqual(mirror(KEY).lastError?.name, 'ChelErrorInvalidMessageHeight')
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
  const invalidHeight = (e: any) =>
    e instanceof ChelErrorInvalidMessageHeight && !(e instanceof ChelErrorKvHeightAhead)

  for (const stamp of ['040', '40.0']) {
    it(`a value stamped ${JSON.stringify(stamp)} can be cleared, but not updated`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await writeStamped(stamp)
      assert.strictEqual(server.posts().at(-1)?.status, 204)
      defineSlot({ key: UNREAD })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'error')
      assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorInvalidMessageHeight')
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
      assert.ok(e.message.includes(`${CONTRACT_ID}::${UNREAD}`), e.message)
      assert.ok(e.message.includes('Invalid height stamp "040"'), e.message)
      assert.ok(e.cause instanceof ChelErrorInvalidMessageHeight)
      assert.strictEqual(e.cause.message, '[chelonia] Invalid height stamp "040"')
      return true
    })
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
    const errors = await Promise.all([
      sbp('chelonia/kv/get', CONTRACT_ID, UNREAD),
      sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
        ifMatch: '"stale"', signingKeyId: cskId, onconflict: () => false
      })
    ].map((p: Promise<unknown>) => within(
      p.then(() => assert.fail('resolved'), (e: unknown) => e), 'the KV call settles'
    )))
    for (const e of errors) {
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
      await writeAsDeviceB(UNREAD, V0, 40)
      defineSlot({ key: UNREAD })
      await activateContract()
      let failA: ((e: Error) => void) | undefined
      const resetA = sbp('chelonia/reset', () => new Promise<void>((_resolve, reject) => {
        failA = reject
      }))
      let finishB: (() => void) | undefined
      const resetB = sbp('chelonia/reset', () => new Promise<void>((resolve, reject) => {
        finishB = bFails ? () => reject(new Error('B failed')) : resolve
      }))
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
    await sleep(20) // inside kv/sync's passive wait
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
      onconflict: async ({ currentData = [], etag }: any = {}) =>
        [[...new Set([...currentData, 'alice', 'carol'])].sort(), etag]
    })
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })
})

describe('writes to a slot that has not loaded', () => {
  it('a never-loaded slot loads before its first update', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(server.gets().length, 0)
    const bases: unknown[] = []
    await recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) })
    assert.deepStrictEqual(bases, [V0])
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })

  it('when that load fails, the write sends if-match "" and merges on the 412', async () => {
    const { cid: v0cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const restore = failKvGets(1)
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    restore()
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.ifMatch]), [
      [412, '""'], [204, `"${v0cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })

  it("when that load fails, a KV_NOOP rejects with the load's error", async () => {
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
      assert.deepStrictEqual(bases, [VB])
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

  it('an entry persisted by an earlier session reloads before the first update', async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    server.log.length = 0
    const bases: unknown[] = []
    const result = await recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') })
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
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
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    // Another device deletes the key: the mirror etag is stale.
    server.store.delete(UNREAD)
    await assert.rejects(
      sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }),
      (e: any) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        assert.deepStrictEqual(e.cause, { currentData: undefined, etag: '""' })
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
      assert.ok(e instanceof ChelErrorKvConflict)
      // Not `{ n: 1 }` (the first 412's value) with the second's etag.
      assert.deepStrictEqual(e.cause, { currentData: undefined, etag: '""' })
      return true
    })
    assert.strictEqual(server.store.has(UNREAD), false)
  })

  it("a server value that fails the slot's schema reports the fallback pair", async () => {
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
        assert.ok(e instanceof ChelErrorKvConflict)
        // `null`, clear's intended write value, and no etag (no
        // `onconflict` ran): not the server's etag with a value that
        // isn't the server's.
        assert.deepStrictEqual(e.cause, { currentData: null, etag: null })
        return true
      }
    )
  })
})

describe('height recovery', () => {
  const warned = (text: string) => warnings.filter((w) => String(w[0]).includes(text)).length

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
    assert.strictEqual(warned('giving up on height recovery'), 0)
  })

  it('a recovery sync that fails after its waiters were aborted logs nothing', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    await writeAsDeviceB(NS_CACHE, { a: 0 }, 42)
    let failSync!: (e: Error) => void
    let started = false
    server.onSync = () => new Promise<void>((_resolve, reject) => {
      started = true
      failSync = reject
    })
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
    await until(() => started, 'the recovery sync started')
    // Let every operation reach the one sync (or the lane behind it).
    await sleep(100)
    controller.abort()
    assert.deepStrictEqual(
      await within(Promise.all(ops), 'the aborted writes'),
      ['AbortError', 'AbortError', 'AbortError']
    )
    failSync(new Error('sync failed (503)'))
    await sleep(50)
    assert.strictEqual(warned('failed during height recovery'), 0)
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
    await sleep(20)
    controller.abort()
    assert.strictEqual(await within(syncing, 'kv/sync'), 'AbortError')
    const syncsBefore = server.syncs
    // The first fallback's sync ends below the height, and it concludes.
    held.release()
    // The newer deadline still fires, with its own sync, and then gives up.
    await until(() => server.syncs > syncsBefore, 'the newer fallback syncs', 2000)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
  })

  // UNREAD needs height 42 and NS_CACHE 43. A sync that started for UNREAD
  // read the server's HEAD at 42.
  const twoKeysAhead = async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await writeAsDeviceB(UNREAD, V0, 40)
    await writeAsDeviceB(NS_CACHE, { a: 0 }, 40)
    defineSlot({ key: UNREAD })
    defineSlot({ key: NS_CACHE })
    await activateContract()
    await writeAsDeviceB(UNREAD, VB, 42)
    await writeAsDeviceB(NS_CACHE, { a: 1 }, 43)
    server.log.length = 0
  }
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
      // It joins the held sync, a few microtasks after its 412.
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

  it('a recovery that started its own sync needs no second one (control)', async () => {
    await twoKeysAhead()
    server.catchUpOnSync = true
    await updateNsCache()
    assert.strictEqual(server.syncs, 2) // activation + one recovery
    assert.deepStrictEqual(server.value(NS_CACHE), { a: 1, b: 1 })
  })
})

describe("a deferred reload that can't start", () => {
  let veto = false
  sbp('sbp/filters/selector/add', 'chelonia/queueInvocation', () => {
    if (veto) throw new Error('queueInvocation vetoed')
  })

  for (const vetoed of [true, false]) {
    it(vetoed
      ? 'settles the slot and leaves nothing behind'
      : 'reloads the slot (control)', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
      await deferFirstLoad()
      const errors: unknown[][] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => { errors.push(args) }
      veto = vetoed
      try {
        setLocalHeight(42)
      } finally {
        veto = false
      }
      try {
        await drainLanes()
      } finally {
        console.error = originalError
      }
      if (vetoed) {
        assert.strictEqual(slotStatus(UNREAD), 'error')
        assert.strictEqual(mirror(UNREAD).lastError?.message, 'queueInvocation vetoed')
        assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
        assert.ok(errors.some((args) => String(args[0]).includes('deferred reload rejected')))
        assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
        await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
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
})

describe('the conflict backoff', () => {
  it("an update's caller abort ends the backoff at once", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
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
    assert.ok(Date.now() - abortedAt < 300, `rejected ${Date.now() - abortedAt} ms after the abort`)
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
