// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// slot loads while the local contract is behind, the key's height wait
// and `heightAhead` marker they leave, and height-wait races.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import { isKvHeightAhead } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import {
  CONTRACT_ID,
  INVALID_HEIGHT_RECOVERY_OPTIONS,
  UNREAD,
  V0,
  VB,
  activateContract,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  collectStatusEvents,
  deferFirstLoad,
  defineSlot,
  deleteChatRoomUnreadMessages,
  drainLanes,
  failFirstLoad,
  failKvGets,
  gateLane,
  heightWait,
  holdGets,
  holdNextSync,
  installKvHeightHooks,
  isInvalidOptions,
  kvGetsRequested,
  loadV0At40,
  loadedRefreshGivesUp,
  loadedWithWait,
  mirror,
  onEvent,
  persistLoadedV0,
  publicLaneQueued,
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
import { addHeightListener, notifyContractHeight } from './kv-height.js'
import type { CheloniaContext } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

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
    // Its load registers the key's height wait, which marks the slot, right
    // before the call waits.
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
    // Its load registers the key's height wait, which marks the slot, right
    // before the call waits.
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
      // Its load registers the key's height wait, which marks the slot, right
      // before the call waits.
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
    for (const options of INVALID_HEIGHT_RECOVERY_OPTIONS) {
      await assert.rejects(
        sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, options),
        isInvalidOptions(`sync: ${CONTRACT_ID}::${UNREAD}`)
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

  // Single-key `kv/sync` parks the key's height wait, and its recovery sync
  // fails. While it then waits passively for the height, `meanwhile` runs.
  // When the call gives up, a newer outcome that `meanwhile` produced must
  // stand. Returns the number of syncs before the recovery sync failed.
  const syncGivesUpAfter = async (meanwhile: () => Promise<void>) => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 300, pendingFallbackMs: 600 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const held = holdNextSync()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    syncing.catch(() => {})
    await held.started
    assert.strictEqual(heightWait(UNREAD)?.parked, true)
    const syncsBefore = server.syncs
    held.fail(new Error('the recovery sync failed'))
    await meanwhile()
    await assert.rejects(within(syncing, 'kv/sync'), (e: unknown) => isKvHeightAhead(e))
    return syncsBefore
  }

  it('single-key kv/sync that gives up leaves a slot that a load verified meanwhile as it is', async () => {
    await syncGivesUpAfter(async () => {
      // Another device deletes the key; another sync verifies that.
      server.store.delete(UNREAD)
      await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the other kv/sync')
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
    })
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
    assert.strictEqual(heightWait(UNREAD), undefined)
  })

  it("single-key kv/sync that gives up leaves a newer frame's height wait its fallback", async () => {
    const syncsBefore = await syncGivesUpAfter(async () => {
      await writeAsDeviceB(UNREAD, { ...VB, roomC: room('c1', 1) }, 44)
      // What the pubsub handler does for a frame whose value is ahead.
      sbp('chelonia/kv/_registerHeightWait', {
        contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 44, reason: 'remote'
      })
    })
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 44 })
    assert.strictEqual(heightWait(UNREAD)?.parked, false)
    // The frame's fallback syncs (as without the call), and gives up, at
    // the frame's height.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    assert.strictEqual(server.syncs - syncsBefore, 1)
    assert.match(String(mirror(UNREAD).lastError?.message), /height 44/)
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
    await loadedWithWait()
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
    await failFirstLoad(42)
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
    // The previous session knew the server held a value it couldn't verify.
    await persistLoadedV0({ heightAhead: { requiredHeight: 42 } })
    setLocalHeight(42)
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
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
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
