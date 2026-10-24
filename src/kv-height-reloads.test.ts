// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// the deferred reloads that height waits leave, the recovery syncs that
// end them, and a deferred reload that can't start.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import { ChelErrorKvHeightAhead, ChelErrorUnexpected, isKvHeightAhead } from './errors.js'
import { CHELONIA_KV_UPDATED } from './events.js'
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
  collectStatusEvents,
  deferFirstLoad,
  defineSlot,
  deleteChatRoomUnreadMessages,
  drainLanes,
  errors,
  failFirstLoad,
  failKvGets,
  gateLane,
  heightWait,
  holdGets,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  kvGetsRequested,
  later,
  loadV0At40,
  loadedWithWait,
  localHeight,
  mirror,
  onEvent,
  persistLoadedV0,
  recordingUpdate,
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
import { logged } from './test-utils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

// The windows in which `update` used to run its reducer on a mirror value
// the library knew to be stale (a KV_NOOP then dropped the write).
describe('update while a deferred reload is in progress', () => {
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
    // Its load registers the key's height wait, which marks the slot, right
    // before the call waits.
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
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 1 })
    await held.started
    setLocalHeight(42) // e.g. pubsub delivered the missing events
    // The reload is queued behind the recovery sync, which is still
    // running on the contract's lane after the 300 ms timeout.
    let released = false
    later(() => { released = true; held.release() }, 600)
    await within(syncing, 'the sync')
    assert.ok(released, 'the sync settled before the recovery sync was released')
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'loaded')
    await drainLanes()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    assert.deepStrictEqual(events.map((e) => [e.status, e.heightAhead?.requiredHeight ?? null]), [
      ['loading', null], ['loading', 42], ['loaded', null]
    ])
  })
})

// A height recovery reloads each recovered value once (KV-REVAMPED.md §4.2
// step 5a): the reload that the key's height wait queued, or `update`'s own
// reload after the recovery, not both.
describe('one reload per recovered value', () => {
  // This device loaded V0 at 40; device B then wrote VB at 42.
  const setup = async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const onUpdates: string[] = []
    defineSlot({ key: UNREAD, onUpdate: (_v: unknown, c: any) => { onUpdates.push(c.reason) } })
    await activateContract()
    await writeAsDeviceB(UNREAD, VB, 42)
    const reasons: string[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => { if (p.key === UNREAD) reasons.push(p.reason) })
    return {
      reasons,
      onUpdates,
      forget: () => {
        reasons.length = 0
        onUpdates.length = 0
        server.log.length = 0
      }
    }
  }
  const update = (options: Record<string, unknown> = {}) => within(sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3), ...options
  }), 'the update')
  const kvRequests = () => server.log.map((e) => `${e.method} ${e.status}`)

  it('after an earlier load found the value ahead', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    const { reasons, onUpdates, forget } = await setup()
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the sync')
    await drainLanes()
    forget()
    server.catchUpOnSync = true
    await update()
    await drainLanes()
    assert.deepStrictEqual(kvRequests(), ['GET 200', 'GET 200', 'POST 204'])
    assert.deepStrictEqual(reasons, ['load', 'local'])
    assert.deepStrictEqual(onUpdates, ['load', 'local'])
    assert.deepStrictEqual(Object.keys(server.value(UNREAD)).sort(), ['roomA', 'roomB', 'roomC'])
  })

  it('control: when no earlier load found it, the conflict finds it', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    const { reasons, onUpdates, forget } = await setup()
    forget()
    server.catchUpOnSync = true
    await update()
    await drainLanes()
    assert.deepStrictEqual(kvRequests(), ['POST 412', 'GET 200', 'POST 204'])
    assert.deepStrictEqual(reasons, ['load', 'local'])
    assert.deepStrictEqual(onUpdates, ['load', 'local'])
  })

  it('with maxHeightRecoveries: 0, the height arriving during the passive wait', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, waitMs: 300 })
    const { reasons, onUpdates, forget } = await setup()
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the sync')
    await drainLanes()
    forget()
    later(() => setLocalHeight(42), 60)
    await update({ maxHeightRecoveries: 0 })
    await drainLanes()
    assert.deepStrictEqual(reasons, ['load', 'local'])
    assert.deepStrictEqual(onUpdates, ['load', 'local'])
    assert.deepStrictEqual(Object.keys(server.value(UNREAD)).sort(), ['roomA', 'roomB', 'roomC'])
  })

  // A load whose GET started before the height wait fired read the value
  // from before it: it must not cancel the reload the wait queued.
  it("a load that started before the wait fired doesn't cancel its reload", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await loadV0At40()
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => kvGetsRequested() === 2, 'the load started')
    // Device B writes VB at 42, and this device learns of it off the lane
    // (as `runSlotWrite`'s catch would), then reaches 42.
    await writeAsDeviceB(UNREAD, VB, 42)
    sbp('chelonia/kv/_registerHeightWait', {
      contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
    })
    setLocalHeight(42)
    assert.strictEqual(heightWait(UNREAD), undefined)
    gets.release()
    await within(syncing, 'the sync')
    await drainLanes()
    assert.deepStrictEqual(server.gets().map((g) => g.status), [200, 200, 200])
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
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
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
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

  it('a given-up slot whose height wait is gone is reloaded before update', async () => {
    await gaveUp()
    const syncsBefore = server.syncs
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    await until(() => server.syncs === syncsBefore + 1, 'the new fallback sync never ran')
    await drainLanes()
    // No waits, as when the next session starts with the persisted entry.
    sbp('chelonia/kv/_testClearHeightWaits')
    server.log.length = 0
    const bases: unknown[] = []
    await assert.rejects(
      within(recordingUpdate(bases, {
        reducer: deleteChatRoomUnreadMessages('roomB'), maxHeightRecoveries: 0
      }), 'the update'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(bases, [])
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(server.posts(), [])
  })

  it("a refresh deferred on height keeps a failed load's lastError", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await failFirstLoad(42)
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
  })

  it("an 'error' slot without a value that gives up reports ChelErrorKvHeightAhead", async () => {
    await failFirstLoad(42)
    const syncsBefore = server.syncs
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
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
      within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'kv/sync'),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    restore()
    sbp('chelonia/kv/_testSetHeightTimings', TEST_TIMINGS)
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    await untilWarned('keeping the current mirror value')
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpectedHttpResponseCode')
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
    assert.ok(!logged(warnings, `contract sync for ${CONTRACT_ID} failed`))
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
    // UNREAD's fallback must not run before the gate below is in place: a
    // longer delay than the default 300 ms, so that a slow machine can't
    // reach it first.
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 1000 })
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

  // A second recovery joins the first one's sync, which is held, and ends
  // with the contract still short of the height. Once both callers have
  // timed out, nobody waits for a fresh sync; control: the joined caller
  // still waits, and gets its fresh sync.
  for (const callersTimeOut of [true, false]) {
    it(callersTimeOut
      ? 'a joined recovery starts no fresh sync once its caller has timed out'
      : 'a joined recovery whose caller still waits starts a fresh sync (control)', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: callersTimeOut ? 300 : 5000 })
      await activateContract()
      const ahead = () => new ChelErrorKvHeightAhead('[test] ahead', {
        cause: { requiredHeight: 42, exact: true, localHeight: 40, etag: null, httpStatus: 412 }
      })
      const held = holdNextSync()
      const syncsBefore = server.syncs
      const recover = () => sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, async () => {
        throw ahead()
      }, { maxHeightRecoveries: 1 })
      const first = recover()
      first.catch(() => {})
      await held.started
      const second = recover()
      second.catch(() => {})
      if (callersTimeOut) {
        await assert.rejects(within(first, 'the first recovery'), isKvHeightAhead)
        await assert.rejects(within(second, 'the second recovery'), isKvHeightAhead)
        assert.strictEqual(server.syncs - syncsBefore, 1)
      }
      // The held sync ends with the contract still at 40.
      held.release()
      if (!callersTimeOut) {
        await assert.rejects(within(first, 'the first recovery'), isKvHeightAhead)
        await assert.rejects(within(second, 'the second recovery'), isKvHeightAhead)
      }
      await sleep(200)
      await drainLanes()
      assert.strictEqual(server.syncs - syncsBefore, callersTimeOut ? 1 : 2)
    })
  }
})

describe("a deferred reload that can't start", () => {
  // How the reload is vetoed: a filter that throws from the
  // `queueInvocation` it goes through or returns `false` for it, one that
  // returns `false` for `_loadSlot` itself, which then returns nothing, or
  // one that returns `false` for the queueing on the contract's internal
  // lane (`queueInvocation` then rejects). Or the queued reload never runs:
  // a filter returns `false` for its queueing on the contract's public lane,
  // or for `_loadSlotNow`. Each names the selector or lane it acts on.
  type Veto =
    'throws in queueInvocation' | 'vetoes queueInvocation' | 'vetoes _loadSlot' |
    'vetoes the internal lane' | 'vetoes the public lane' | 'vetoes _loadSlotNow'
  let veto: Veto | undefined
  // Set: the next `_loadSlot` call has its queueing on the internal lane
  // vetoed, and only that call (it queues synchronously).
  let vetoNextLoadOnTheInternalLane = false
  sbp('sbp/filters/selector/add', 'chelonia/queueInvocation', () => {
    if (veto === 'throws in queueInvocation') throw new Error('queueInvocation vetoed')
    if (veto === 'vetoes queueInvocation') return false
  })
  sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlot', () => {
    if (veto === 'vetoes _loadSlot') return false
    if (vetoNextLoadOnTheInternalLane) {
      vetoNextLoadOnTheInternalLane = false
      veto = 'vetoes the internal lane'
      queueMicrotask(() => { veto = undefined })
    }
  })
  sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent', (
    _domain: string, _selector: string, data: unknown[]
  ) => {
    if (veto === 'vetoes the internal lane' && data[0] === CONTRACT_ID) return false
    if (veto === 'vetoes the public lane' && data[0] === `public:${CONTRACT_ID}`) return false
  })
  sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlotNow', () => {
    if (veto === 'vetoes _loadSlotNow') return false
  })
  // Unlike the others, these act after `setLocalHeight` returned: when the
  // reload is queued on the public lane (once the internal lane's turn has
  // run), or when it runs there. They veto until the test clears them.
  const actsLater = (how: Veto) => how === 'vetoes the public lane' || how === 'vetoes _loadSlotNow'
  const vetoed = (how: Veto, fn: () => void) => {
    veto = how
    addTeardown(() => {
      veto = undefined
      vetoNextLoadOnTheInternalLane = false
    })
    try {
      fn()
    } finally {
      if (!actsLater(how)) veto = undefined
    }
  }
  const internalLaneVetoed = {
    name: 'ChelErrorUnexpected',
    message: `[chelonia] queueInvocation: queueing on ${CONTRACT_ID} was vetoed`
  }
  const neverRan = {
    name: 'ChelErrorUnexpected',
    message: `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed (the queued load never ran)`
  }

  for (const [how, lastError] of [
    ['throws in queueInvocation', { name: 'Error', message: 'queueInvocation vetoed' }],
    ['vetoes _loadSlot', {
      name: 'ChelErrorUnexpected',
      message: `[chelonia/kv] the deferred reload of ${CONTRACT_ID}::${UNREAD} was vetoed`
    }],
    ['vetoes queueInvocation', {
      name: 'ChelErrorUnexpected',
      message: `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed (queueInvocation returned nothing)`
    }],
    ['vetoes the internal lane', internalLaneVetoed],
    ['vetoes the public lane', neverRan],
    ['vetoes _loadSlotNow', neverRan],
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
      veto = undefined
      if (lastError) {
        assert.strictEqual(slotStatus(UNREAD), 'error')
        assert.strictEqual(mirror(UNREAD).lastError?.name, lastError.name)
        assert.strictEqual(mirror(UNREAD).lastError?.message, lastError.message)
        // Nothing verified the key: the marker stays until a load does.
        assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
        assert.ok(logged(errors, 'deferred reload rejected'))
        assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
        await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync')
        assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      }
      assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
      server.log.length = 0
      // No reload is left marked as queued: the mirror is a basis again.
      for (let i = 0; i < 3; i++) {
        await within(sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: () => KV_NOOP
        }), 'the update')
      }
      assert.strictEqual(server.gets().length, 0)
    })
  }

  for (const how of [
    'vetoes queueInvocation', 'vetoes _loadSlotNow', 'throws in queueInvocation',
    'vetoes the internal lane', 'vetoes the public lane'
  ] as const) {
    it(`keeps the marker of a slot holding a value, so that update reloads first (a filter ${how})`, async () => {
      await loadedWithWait()
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
    // A persisted entry: re-activating the slot unsettles it, and its load
    // finds the server value ahead.
    await persistLoadedV0()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    vetoed('throws in queueInvocation', () => setLocalHeight(42))
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
  })

  it("settles a re-activated 'error' slot without a value when its reload can't start", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    // Persisted by an earlier session: an 'error' entry without a value.
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: {
        value: undefined,
        etag: null,
        status: 'error',
        settled: true,
        lastError: { name: 'Error', message: 'earlier' }
      }
    }
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(mirror(UNREAD).settled, false)
    vetoed('vetoes _loadSlot', () => setLocalHeight(42))
    await drainLanes()
    assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'error')
    assert.strictEqual(
      mirror(UNREAD).lastError?.message,
      `[chelonia/kv] the deferred reload of ${CONTRACT_ID}::${UNREAD} was vetoed`
    )
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    assert.ok(logged(errors, 'deferred reload rejected'))
  })

  // The same for a background load: the autoload of a slot that activates.
  for (const [how, message] of [
    ['vetoes _loadSlot', `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed`],
    ['throws in queueInvocation', 'queueInvocation vetoed'],
    ['vetoes the internal lane', internalLaneVetoed.message],
    ['vetoes the public lane', neverRan.message],
    ['vetoes _loadSlotNow', neverRan.message]
  ] as const) {
    it(`settles an autoloaded slot whose load can't start, and logs it (a filter ${how})`, async () => {
      await writeAsDeviceB(UNREAD, V0, 40)
      defineSlot({ key: UNREAD })
      await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
      vetoed(how, () => {
        sbp('chelonia/kv/_onContractsModified', { added: [CONTRACT_ID], removed: [] })
      })
      await drainLanes()
      veto = undefined
      assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'error')
      assert.strictEqual(mirror(UNREAD).lastError?.message, message)
      assert.ok(logged(errors, '_loadSlot rejected'))
      // A load that can start loads it.
      await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync')
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    })
  }

  it("single-key sync rejects as vetoed when its load can't start", async () => {
    await loadV0At40()
    veto = 'vetoes _loadSlot'
    addTeardown(() => { veto = undefined })
    await assert.rejects(
      within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync'),
      (e: unknown) => e instanceof ChelErrorUnexpected &&
        e.message === `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed`
    )
    veto = undefined
  })

  // The load is queued, but never runs: the call rejects rather than
  // resolve as if the key had loaded.
  for (const how of ['vetoes the public lane', 'vetoes _loadSlotNow'] as const) {
    it(`single-key sync rejects as vetoed when its queued load never runs, and keeps the value (a filter ${how})`, async () => {
      await loadV0At40()
      server.log.length = 0
      veto = how
      addTeardown(() => { veto = undefined })
      await assert.rejects(
        within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync'),
        (e: unknown) => e instanceof ChelErrorUnexpected && e.message === neverRan.message
      )
      veto = undefined
      assert.strictEqual(server.gets().length, 0)
      assert.strictEqual(slotStatus(UNREAD), 'loaded')
      assert.deepStrictEqual(mirror(UNREAD).value, V0)
      assert.strictEqual(mirror(UNREAD).settled, true)
    })

    it(`single-key sync of a slot that never loaded settles it when its queued load never runs (a filter ${how})`, async () => {
      await writeAsDeviceB(UNREAD, V0, 40)
      defineSlot({ key: UNREAD, autoLoad: 'never' })
      await activateContract()
      assert.strictEqual(mirror(UNREAD).settled, false)
      veto = how
      addTeardown(() => { veto = undefined })
      await assert.rejects(
        within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync'),
        (e: unknown) => e instanceof ChelErrorUnexpected && e.message === neverRan.message
      )
      veto = undefined
      assert.strictEqual(await whenSettledWithin(UNREAD, 1000), 'error')
      assert.deepStrictEqual(mirror(UNREAD).lastError, neverRan)
    })
  }

  // The recovery sync ends short of the height, and the next round's load
  // is vetoed (control: it finds the value ahead again). The slot settles,
  // and the wait the call parked gets its fallback back, which runs, as
  // `fireHeightWait` and background loads do.
  for (const secondRound of ['vetoes _loadSlot', 'vetoes the internal lane', undefined] as const) {
    it(secondRound === 'vetoes _loadSlot'
      ? "single-key sync whose later load can't start settles the slot, and re-arms the wait's fallback"
      : secondRound
        ? "single-key sync whose later load can't be queued on the internal lane settles the slot, and re-arms the wait's fallback"
        : 'single-key sync whose later load finds the value ahead again settles the slot (control)', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 300 })
      await writeAsDeviceB(UNREAD, VB, 42)
      defineSlot({ key: UNREAD, autoLoad: 'never' })
      await activateContract()
      addTeardown(() => {
        veto = undefined
        vetoNextLoadOnTheInternalLane = false
      })
      server.onSync = () => {
        server.onSync = null
        if (secondRound === 'vetoes _loadSlot') veto = secondRound
        if (secondRound === 'vetoes the internal lane') vetoNextLoadOnTheInternalLane = true
      }
      const syncsBefore = server.syncs
      await assert.rejects(
        within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD, { maxHeightRecoveries: 1 }), 'the key sync'),
        (e: unknown) => secondRound === 'vetoes _loadSlot'
          ? e instanceof ChelErrorUnexpected &&
            e.message === `[chelonia/kv] loading ${CONTRACT_ID}::${UNREAD} was vetoed`
          : secondRound
            ? e instanceof ChelErrorUnexpected && e.message === internalLaneVetoed.message
            : isKvHeightAhead(e)
      )
      veto = undefined
      assert.strictEqual(vetoNextLoadOnTheInternalLane, false)
      assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'error')
      assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
      assert.strictEqual(heightWait(UNREAD)?.parked, !secondRound)
      if (!secondRound) {
        assert.strictEqual(server.syncs, syncsBefore + 1)
        return
      }
      assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpected')
      // The fallback syncs once more, and gives up (the contract stays at 40).
      await until(() => heightWait(UNREAD)?.parked === true, 'the fallback never gave up')
      assert.strictEqual(server.syncs, syncsBefore + 2)
      assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    })
  }
})
