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
import { CHELONIA_KV_STATUS_CHANGED } from './events.js'
import {
  CONTRACT_ID,
  NS_CACHE,
  TEST_TIMINGS,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  advanceLocalHeightOnInternalLane,
  cekId,
  collectStatusEvents,
  cskId,
  defineSlot,
  deleteChatRoomUnreadMessages,
  drainLanes,
  failKvGets,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  localHeight,
  mirror,
  onEvent,
  room,
  rootState,
  server,
  setLocalHeight,
  setupContract,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  subscribeContract,
  warnings,
  whenSettledWithin,
  writeAsDeviceB
} from './kv-height-harness.js'
import { readHeightStamp } from './kv-height.js'
import { KV_NOOP } from './kv.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { withLocalHeight } from './test-utils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

// Resolves once a `console.warn` containing `text` was logged.
const untilWarned = async (text: string, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!warnings.some((w) => String(w[0]).includes(text))) {
    if (Date.now() > deadline) assert.fail(`no warning containing "${text}" within ${ms} ms`)
    await sleep(10)
  }
}

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
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
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
        contractID: CONTRACT_ID,
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
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
    // The server keeps a value this device can never verify.
    const bases: any[] = []
    const reducer = initChatRoomUnreadMessages('roomC', 'c1', 3)
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: (prev: any) => { bases.push(prev); return reducer(prev) }
      }),
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
  const deferFirstLoad = async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.strictEqual(mirror(UNREAD).value, undefined)
    server.log.length = 0
  }
  const recordingUpdate = (bases: any[], options: Record<string, unknown> = {}) => {
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    return sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      updater: (prev: any) => { bases.push(prev); return reducer(prev) },
      ...options
    })
  }
  const mergedA2 = { ...VB, roomA: room('a1', 1, [{ messageHash: 'a2', createdHeight: 5 }]) }

  it('an update during a deferred first load merges against the server value', async () => {
    await deferFirstLoad()
    server.catchUpOnSync = true
    const bases: any[] = []
    assert.deepStrictEqual(await recordingUpdate(bases), mergedA2)
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.value(UNREAD), mergedA2)
    assert.strictEqual(server.syncs, 2) // activation + one recovery
  })

  it('an update during a deferred first load rejects when the contract cannot catch up', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const hold = sbp('chelonia/queueInvocation', CONTRACT_ID, () => gate)
    const bases: any[] = []
    const updating = recordingUpdate(bases)
    await sleep(5)
    // The height is reached: the deferred reload is queued behind the update,
    // so the update still finds the slot 'loading', with no height wait.
    setLocalHeight(42)
    open()
    await hold
    assert.deepStrictEqual(await updating, mergedA2)
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.value(UNREAD), mergedA2)
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
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: (prev: any) => { bases.push(prev); return reducer(prev) }
      }),
      ChelErrorKvHeightAhead
    )
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
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    const reducer = deleteChatRoomUnreadMessages('roomB')
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      updater: (prev: any) => { bases.push(prev); return reducer(prev) }
    })
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
    sbp('chelonia/kv/_testSetHeightTimings', {
      ...TEST_TIMINGS, waitMs: 500, pendingFallbackMs: 10000
    })
    server.catchUpOnSync = true
    const started = Date.now()
    const result = await recordingUpdate([])
    assert.deepStrictEqual(result, mergedA2)
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
  const updateRecording = (bases: any[], reducer: (prev: any) => unknown) =>
    sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      updater: (prev: any) => { bases.push(prev); return reducer(prev) }
    })

  it("an 'error' slot without a value reloads before a KV_NOOP reducer runs", async () => {
    await failedFirstLoad()
    const bases: any[] = []
    const result = await updateRecording(bases, deleteChatRoomUnreadMessages('roomB'))
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
    const result = await updateRecording(bases, addChatRoomUnreadMessage('roomA', 'a2', 5))
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(result, mergedA2)
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
        updateRecording(bases, reducer),
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
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    assert.deepStrictEqual(await recordingUpdate([]), mergedA2)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.deepStrictEqual(server.value(UNREAD), mergedA2)
    await untilWarned('failed during height recovery')
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
    await untilWarned('failed during height recovery')
  })

  it('a timed-out recovery sync is retried when the contract reached the height anyway', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const started = Date.now()
    const updating = recordingUpdate([])
    await held.started
    setTimeout(() => setLocalHeight(42), 100)
    // The retry waits behind the sync, which still holds the contract's
    // lane after the 300 ms timeout.
    setTimeout(held.release, 600)
    assert.deepStrictEqual(await updating, mergedA2)
    assert.ok(Date.now() - started >= 600)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    await untilWarned('did not finish within 300 ms')
  })

  it('a value that becomes verifiable during the wait is merged, not overwritten', async () => {
    await setupStaleDeviceA()
    server.onPost = (n) => {
      if (n === 1) setTimeout(() => advanceLocalHeightOnInternalLane(42), 10)
    }
    const result = await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
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
        sbp('chelonia/private/queueEvent', `public:${CONTRACT_ID}`, () => 'free'),
        sleep(300).then(() => 'busy')
      ]))
    }
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
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
      contractID: CONTRACT_ID,
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
})

describe('loads and pubsub frames while the local contract is behind', () => {
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
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'loaded', true]
    ])
  })

  it('a pending load settles to error when the contract never catches up', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    const settledAs = whenSettledWithin(UNREAD)
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
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), ChelErrorKvHeightAhead)
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
    sbp('chelonia/kv/_testSetHeightTimings', {
      ...TEST_TIMINGS, waitMs: 5000, pendingFallbackMs: 10000
    })
    await onDemandSlotAhead()
    const controller = new AbortController()
    const started = Date.now()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { signal: controller.signal })
    await sleep(50)
    controller.abort(new Error('user navigated away'))
    await assert.rejects(syncing, (e: any) => e.message === 'user navigated away')
    assert.ok(Date.now() - started < 1000)
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    // The deferred reload is still registered: reaching the height loads it.
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it("single-key kv/sync with onHeightAhead: 'reject' neither waits nor syncs", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
    await onDemandSlotAhead()
    const syncsBefore = server.syncs
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { onHeightAhead: 'reject' }),
      ChelErrorKvHeightAhead
    )
    assert.strictEqual(server.syncs, syncsBefore)
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
  })

  it('single-key kv/sync with maxHeightRecoveries: 0 gives up after one load', async () => {
    await onDemandSlotAhead()
    const syncsBefore = server.syncs
    await assert.rejects(
      sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 0 }),
      ChelErrorKvHeightAhead
    )
    assert.strictEqual(server.syncs, syncsBefore)
    assert.strictEqual(server.gets().length, 1)
    assert.strictEqual(await whenSettledWithin(UNREAD, 100), 'error')
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
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
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
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const hold = sbp('chelonia/queueInvocation', CONTRACT_ID, () => gate)
    // A load queued before the height is reached; reaching it then queues
    // the deferred reload behind that load.
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    setLocalHeight(42)
    const { events, off } = collectStatusEvents(UNREAD)
    open()
    await hold
    await syncing
    await drainLanes()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status]), [['loading', 'loaded']])
  })
})

// The windows in which `update` used to run its reducer on a mirror value
// the library knew to be stale (a KV_NOOP then dropped the write).
describe('update while a deferred reload is in progress', () => {
  // Loaded V0; an aggregate refresh found VB ahead, so a height wait is
  // registered and the slot keeps presenting V0.
  const loadedWithWait = async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const hold = sbp('chelonia/queueInvocation', CONTRACT_ID, () => gate)
    const writing = deleteRoomB()
    await sleep(10)
    // Fires the wait: its reload is queued behind the update.
    setLocalHeight(42)
    open()
    await hold
    assert.deepStrictEqual(await writing, V0)
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it("an update during single-key kv/sync's passive wait doesn't seed from the stale value", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', {
      ...TEST_TIMINGS, waitMs: 500, pendingFallbackMs: 10000
    })
    await setupStaleDeviceA()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 1 })
    while (server.gets().length < 1) await sleep(5)
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
    await sleep(20)
    held.release()
    assert.deepStrictEqual(await writing, V0)
    await syncing
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), V0)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it('single-key kv/sync failing with another error still reloads at the height', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 400 })
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
    sbp('chelonia/kv/_testSetHeightTimings', {
      waitMs: 50, pendingFallbackMs: 10000, recoveryTimeoutMs: 300
    })
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
    setTimeout(held.release, 600)
    await syncing
    assert.ok(Date.now() - started >= 600)
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'loaded')
    await drainLanes()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.deepStrictEqual(events.map((e) => e.status), ['loading', 'loaded'])
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
    let release!: () => void
    server.holdGet = new Promise<void>((resolve) => { release = resolve })
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD })
    const settledAs = whenSettledWithin(UNREAD)
    await subscribeContract()
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
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    let release!: () => void
    server.holdGet = new Promise<void>((resolve) => { release = resolve })
    defineSlot({ key: UNREAD })
    await subscribeContract()
    await sleep(20)
    assert.strictEqual(mirror(UNREAD).settled, false)
    server.holdGet = null
    release()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
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

  it('a committed local write settles the slot', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    })
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
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
    await assert.rejects(aborted, (e: any) => e.message === 'stop waiting')

    const pending = sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'never')
    await sbp('chelonia/reset')
    await assert.rejects(pending, (e: any) => e.name === 'AbortError')
  })

  it("waits for a settled slot's reload instead of resolving with 'loading'", async () => {
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(slotStatus('absent'), 'non-init')
    let release!: () => void
    server.holdGet = new Promise<void>((resolve) => { release = resolve })
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, 'absent')
    await sleep(20)
    assert.strictEqual(slotStatus('absent'), 'loading')
    let settledAs: unknown
    const settling = whenSettledWithin('absent').then((s: unknown) => { settledAs = s })
    await sleep(20)
    assert.strictEqual(settledAs, undefined)
    server.holdGet = null
    release()
    await syncing
    await settling
    assert.strictEqual(settledAs, 'non-init')
  })

  it("a settled 'non-init' slot whose server value turns out to be ahead is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status]), [
      ['non-init', 'loading'], ['loading', 'loaded']
    ])
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
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: (prev: any) => { bases.push(prev); return reducer(prev) }
      }),
      ChelErrorKvHeightAhead
    )
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
    await sleep(20)
    assert.strictEqual(mirror(UNREAD).status, 'loaded')
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
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    await drainLanes()
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
  }

  it('a refresh that is deferred again, then gives up again, keeps lastError', async () => {
    await gaveUp()
    const { events } = collectStatusEvents(UNREAD)
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    await sleep(400) // the new 300 ms fallback gives up again
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
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await sleep(400)
    await drainLanes()
    // What the next session starts with: the persisted entry, no waits.
    sbp('chelonia/kv/_clearHeightWaits')
    server.log.length = 0
    const bases: unknown[] = []
    const reducer = deleteChatRoomUnreadMessages('roomB')
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        maxHeightRecoveries: 0,
        updater: (prev: unknown) => { bases.push(prev); return reducer(prev) }
      }),
      ChelErrorKvHeightAhead
    )
    assert.deepStrictEqual(bases, [])
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(server.posts(), [])
  })

  it("a refresh deferred on height keeps a failed load's lastError", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
    await sbp('chelonia/kv/sync', CONTRACT_ID)
    await sleep(400) // past the 300 ms fallback, which doesn't catch up
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
  })

  it("an 'error' slot holding a value that gives up keeps its lastError", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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
      sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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

describe('chelonia/reset', () => {
  const contractSyncsSince = (at: number) => server.requests
    .filter((r) => r.at >= at && /^\/(latestHEADinfo|eventsAfter)\//.test(r.path))
    .map((r) => r.path)

  it('a deferred-load fallback due while reset drains starts no contract sync', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    // Deferred: the 300 ms fallback is armed.
    assert.strictEqual(slotStatus(UNREAD), 'loading')
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
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
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
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    server.catchUpOnSync = true
    // The fallback sync (after 300 ms) brings the contract up to date.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps the deferred loads it found', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    await failedReset()
    // Only the height notification can reload the slot within the test.
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

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
    sbp('chelonia/kv/_testSetHeightTimings', {
      waitMs: 2000, pendingFallbackMs: 10000, recoveryTimeoutMs: 2000
    })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    while (server.gets().length < 1) await sleep(5)
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
    sbp('chelonia/kv/_testSetHeightTimings', { ...TEST_TIMINGS, pendingFallbackMs: 10000 })
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

describe('unchanged behaviour', () => {
  it('a never-loaded slot sends if-match "" and merges on the 412', async () => {
    const { cid: v0cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(server.gets().length, 0)
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.ifMatch]), [
      [412, '""'], [204, `"${v0cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })
})
