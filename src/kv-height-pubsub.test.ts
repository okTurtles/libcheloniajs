// Height-aware KV handling of pubsub KV frames (KV-REVAMPED.md §3.4).
//
// Same harness as `kv-height.test.ts` (see `kv-height-harness.ts`), in its
// own file because these tests call `chelonia/connect`, whose listeners
// outlive `chelonia/_init`: in a shared file they would change how every
// later test reconciles its slots.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { ChelErrorKvHeightAhead, isKvHeightAhead, isKvHeightMalformed } from './errors.js'
import { CHELONIA_KV_UPDATED } from './events.js'
import { createCID, multicodes } from './functions.js'
import {
  CONTRACT_ID,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  assertAwaitsValueAhead,
  cekId,
  cskId,
  debugs,
  defineSlot,
  drainLanes,
  errors,
  installKvHeightHooks,
  loadV0At40,
  mirror,
  onEvent,
  restamp,
  restampedBody,
  room,
  server,
  setLocalHeight,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  subscribeContract,
  until,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { NOTIFICATION_TYPE } from './pubsub/index.js'
import { logged } from './test-utils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

// Vetoes `chelonia/kv/_loadSlot` while set. Filters can't be removed, so
// this one is registered once, and a test's teardown clears the flag.
let vetoLoads = false
sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlot', () => {
  if (vetoLoads) return false
})

let client: any
// Messages passed to the raw KV callback, when `connect` installs one.
let rawFrames: unknown[]

// The client is destroyed by the harness's cleanup, which also runs when
// its index check fails (a separate `afterEach` would then be skipped).
const connect = ({ rawHandler = false } = {}) => {
  rawFrames = []
  client = sbp('chelonia/connect', rawHandler
    ? { messageHandlers: { [NOTIFICATION_TYPE.KV]: (msg: unknown) => { rawFrames.push(msg) } } }
    : {})
  addTeardown(() => {
    client?.destroy()
    client = undefined
  })
}

// Delivers the value stored for `key` as a pubsub KV frame.
const deliverKvFrame = (key = UNREAD) => {
  const stored = server.store.get(key)!
  deliverBody(key, stored.body)
  return stored
}

const deliverBody = (key: string, body: string) => {
  client.messageHandlers[NOTIFICATION_TYPE.KV].call(client, {
    type: NOTIFICATION_TYPE.KV,
    channelID: CONTRACT_ID,
    key,
    data: body,
    cid: `"${createCID(body, multicodes.RAW)}"`
  })
}

describe('pubsub frames with a malformed height stamp', () => {
  it("reload the slot, which goes 'error' when the stored value is malformed", async () => {
    await loadV0At40()
    connect()
    await writeAsDeviceB(UNREAD, VB, 40)
    const body = restamp(UNREAD, '040')
    server.log.length = 0
    deliverBody(UNREAD, body)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.strictEqual(slotStatus(UNREAD), 'error')
    assert.strictEqual(isKvHeightMalformed(mirror(UNREAD).lastError), true)
    assert.strictEqual(mirror(UNREAD).settled, true)
    // The frame's own error is logged too.
    const logs = errors.filter((args) => String(args[0]).includes('Error processing kv event'))
    assert.strictEqual(logs.length, 1)
    assert.ok(isKvHeightMalformed(logs[0][2]))
  })

  it('reload the slot, which loads the stored value when the frame was a stale one', async () => {
    await loadV0At40()
    connect()
    const malformed = restampedBody(UNREAD, '1e1')
    await writeAsDeviceB(UNREAD, VB, 40)
    server.log.length = 0
    deliverBody(UNREAD, malformed)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    // The stale frame's error is still logged.
    const logs = errors.filter((args) => String(args[0]).includes('Error processing kv event'))
    assert.strictEqual(logs.length, 1)
    assert.ok(isKvHeightMalformed(logs[0][2]))
  })

  it('settle the slot when a filter vetoes the reload, and log it', async () => {
    connect()
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    vetoLoads = true
    addTeardown(() => { vetoLoads = false })
    deliverBody(UNREAD, restampedBody(UNREAD, 'not-a-height'))
    await drainLanes()
    vetoLoads = false
    assert.strictEqual(await whenSettledWithin(UNREAD, 300), 'error')
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorUnexpected')
    const vetoed = errors.find((args) => String(args[0]).includes('after a malformed frame failed'))
    assert.match(String((vetoed?.[1] as Error | undefined)?.message), /was vetoed/)
    assert.ok(!errors.some((args) => args.some((arg) => arg instanceof TypeError)))
    assert.strictEqual(server.gets().length, 0)
  })
})

describe('pubsub frames while the local contract is behind', () => {
  it('a frame that is ahead reloads the key once the contract catches up', async () => {
    await setupStaleDeviceA()
    connect()
    const stored = deliverKvFrame()
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    // Loaded, but known to be stale.
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    const updates: any[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => updates.push(p))
    await within(advanceLocalHeightOnInternalLane(42), 'the height move')
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
    assert.strictEqual(mirror(UNREAD).etag, `"${stored.cid}"`)
    assert.deepStrictEqual(updates.map((u) => u.reason), ['remote'])
    assert.ok(logged(debugs, 'reloading the slot'))
    // With the etag current, the next write needs no conflict round trip.
    server.log.length = 0
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it("a frame that is ahead makes a settled 'non-init' slot 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
    connect()
    await writeAsDeviceB(UNREAD, VB, 42)
    // The frame shows that the server value isn't absent after all.
    deliverKvFrame()
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    await assert.rejects(whenSettledWithin(UNREAD, 100), (e: any) => e.name === 'TimeoutError')
    const settling = whenSettledWithin(UNREAD)
    await within(advanceLocalHeightOnInternalLane(42), 'the height move')
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
  })

  // Device B cleared the key at 40, then wrote VB at 42. The clear's frame
  // arrives after a load found VB ahead: it doesn't settle the slot "no
  // value", since the server is known to hold VB.
  it("a stale clear frame doesn't settle 'non-init' while the slot waits for a value ahead", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    connect()
    defineSlot({ key: UNREAD })
    await activateContract()
    const clearFrame = { ...await writeAsDeviceB(UNREAD, null, 40) }
    await writeAsDeviceB(UNREAD, VB, 42)
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the sync')
    await drainLanes()
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    deliverBody(UNREAD, clearFrame.body)
    await drainLanes()
    await assertAwaitsValueAhead(UNREAD, 42)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), {})
    const settling = whenSettledWithin(UNREAD)
    await within(advanceLocalHeightOnInternalLane(42), 'the height move')
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
  })

  it("a clear retried after a recovery doesn't carry the first attempt's conflict", async () => {
    await setupStaleDeviceA()
    connect()
    // B's frame for VB (height 42) arrives while A is at 40: deferred.
    deliverKvFrame()
    await drainLanes()
    server.catchUpOnSync = true
    await within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD), 'the clear')
    // Attempt 1 conflicts (412), then its height stamp is stale (409);
    // after the recovery sync, attempt 2 commits without a conflict.
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [412, '40'], [409, '40'], [204, '42']
    ])
    // So another device's next write is applied as is, without the
    // authoritative GET a conflict-resolved write's echo marker forces.
    const V2 = { ...VB, roomC: room('c1', 3) }
    await within(writeAsDeviceB(UNREAD, V2, 42), "device B's write")
    const getsBefore = server.gets().length
    deliverKvFrame()
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, V2)
    assert.strictEqual(server.gets().length, getsBefore)
  })
})

// `connect` uses the harness's manual connection options, so the client's
// socket never opens: no contract event can arrive, and `kv/set` doesn't
// wait for one. (A stale stamp written with recoveries left skips the wait
// by itself; `kv-height.test.ts` checks that without a pubsub client.)
describe('writes and loads while the pubsub socket is closed', () => {
  // Time of the first contract sync requested at or after `started`.
  const firstSyncAfter = (started: number): number | undefined => server.requests.find((r) =>
    r.at >= started && r.path.startsWith('/latestHEADinfo/')
  )?.at

  // With no recovery left, `update`'s only attempt is its last, which
  // takes `kv/set`'s default wait: only the closed socket skips it.
  it('update with maxHeightRecoveries: 0 rejects a stale stamp (409) without waiting', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500 })
    await loadV0At40()
    connect()
    server.height = 41
    server.log.length = 0
    const syncsBefore = server.syncs
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5),
        maxHeightRecoveries: 0
      }), 'the update'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 500, `rejected after ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
    assert.strictEqual(server.syncs, syncsBefore)
  })

  // Raw `kv/set` takes the default wait, which the closed socket skips.
  it('raw kv/set rejects a stale stamp (409) without waiting', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500 })
    await loadV0At40()
    connect()
    server.height = 41
    server.log.length = 0
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, VB, {
        ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
      }), 'the write'),
      (e: any) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 500, `rejected after ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
  })

  it('raw kv/set rejects a conflicting value that is ahead without waiting', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500 })
    const { e0 } = await setupStaleDeviceA()
    connect()
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
        ifMatch: e0,
        signingKeyId: cskId,
        encryptionKeyId: cekId,
        onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
      }), 'the write'),
      (e: any) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 500)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it('single-key kv/sync goes straight to the recovery sync', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500, pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    connect()
    const started = Date.now()
    const syncsBefore = server.syncs
    await assert.rejects(
      within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.strictEqual(server.syncs - syncsBefore, 2)
    const firstSync = firstSyncAfter(started)
    assert.ok(firstSync !== undefined, 'no recovery sync')
    assert.ok(firstSync - started < 500, `first sync after ${firstSync - started} ms`)
    // Two rounds, neither waiting 1.5 s first.
    assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
  })

  it('single-key kv/sync loads as soon as its recovery sync catches up', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500, pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    connect()
    server.catchUpOnSync = true
    const started = Date.now()
    await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync')
    assert.ok(Date.now() - started < 500, `loaded after ${Date.now() - started} ms`)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })
})

describe('the raw KV callback', () => {
  it('gets the frames written at a height the local contract has reached', async () => {
    connect({ rawHandler: true })
    await subscribeContract()
    await writeAsDeviceB('other', V0, 40)
    deliverKvFrame('other')
    await drainLanes()
    assert.strictEqual(rawFrames.length, 1)
    const [key, parsed] = rawFrames[0] as [string, any]
    assert.strictEqual(key, 'other')
    assert.deepStrictEqual(parsed.data, V0)
  })

  it("isn't called for a frame that is ahead, and without a slot a warning says it was dropped", async () => {
    connect({ rawHandler: true })
    await subscribeContract()
    await writeAsDeviceB('other', V0, 42)
    server.log.length = 0
    deliverKvFrame('other')
    await drainLanes()
    assert.strictEqual(rawFrames.length, 0)
    const dropped = warnings.filter((w) => String(w[0]).includes('dropping kv pubsub frame'))
    assert.strictEqual(dropped.length, 1)
    assert.ok(String(dropped[0][0]).includes('define a slot for the key to have it reloaded'))
    // Nothing reloads it once the contract catches up.
    setLocalHeight(42)
    await drainLanes()
    await sleep(50)
    assert.strictEqual(rawFrames.length, 0)
    assert.strictEqual(server.gets().length, 0)
  })

  it("isn't called for a frame that is ahead even when a slot reloads its key, and says so", async () => {
    await setupStaleDeviceA()
    connect({ rawHandler: true })
    deliverKvFrame()
    await drainLanes()
    setLocalHeight(42)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.strictEqual(rawFrames.length, 0)
    const dropped = warnings.filter((w) => String(w[0]).includes('dropping kv pubsub frame'))
    assert.strictEqual(dropped.length, 1)
    assert.ok(String(dropped[0][0]).includes('the slot reloads the key once the contract catches up'))
  })
})

// `chelonia/connect` starts clock sync, which `chelonia/reset` stops while
// it drains.
// Whether clock sync is running: starting it again throws then.
const clockSyncRunning = (): boolean => {
  try {
    sbp('chelonia/private/startClockSync')
  } catch {
    return true
  }
  sbp('chelonia/private/stopClockSync')
  return false
}

describe('chelonia/reset failing in its persistence hook', () => {
  it("rejects with the hook's error even when resuming fails, and restarts clock sync", async () => {
    // A settled 'non-init' slot. While the reset drains, a wait is
    // registered for it, which is only remembered (the height session is
    // ended): resuming registers it, and moves the slot to 'loading'
    // through `reactiveSet`, which then fails.
    defineSlot({ key: 'absent' })
    await activateContract()
    connect()
    assert.strictEqual(clockSyncRunning(), true)
    let failSets = false
    // Also when an assertion below fails first.
    addTeardown(() => { failSets = false })
    sbp('chelonia/configure', {
      reactiveSet: (obj: any, key: string, value: unknown) => {
        if (failSets) throw new Error('reactiveSet failed')
        obj[key] = value
        return value
      }
    })
    await assert.rejects(within(sbp('chelonia/reset', () => {
      sbp('chelonia/kv/_registerHeightWait', {
        contractID: CONTRACT_ID, key: 'absent', requiredHeight: 42, reason: 'remote'
      })
      failSets = true
      throw new Error('persistence hook failed')
    }), 'the reset'), /persistence hook failed/)
    failSets = false
    assert.ok(logged(errors, 'failed to resume the KV height session'))
    assert.strictEqual(clockSyncRunning(), true)
  })

  it('restarts clock sync when resuming succeeds', async () => {
    await loadV0At40()
    connect()
    // `chelonia/reset` stops clock sync while it drains, and restarts it.
    let runningInHook: boolean | undefined
    await assert.rejects(
      within(sbp('chelonia/reset', () => {
        runningInHook = clockSyncRunning()
        throw new Error('persistence hook failed')
      }), 'the reset'),
      /persistence hook failed/
    )
    assert.strictEqual(runningInHook, false)
    assert.strictEqual(clockSyncRunning(), true)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
  })

  // Whichever of two overlapping resets restarts clock sync first, the
  // other one's restart must neither throw (clock sync is running again)
  // nor replace its outcome.
  for (const aFailsFirst of [true, false]) {
    it(`overlapping resets keep their outcomes, and clock sync runs (${aFailsFirst ? 'the failing one' : 'the succeeding one'} ends first)`, async () => {
      await loadV0At40()
      connect()
      let failA: ((e: Error) => void) | undefined
      const resetA = sbp('chelonia/reset', () => new Promise<void>((_resolve, reject) => {
        failA = reject
      }))
      let finishB: (() => void) | undefined
      const resetB = sbp('chelonia/reset', () => new Promise<void>((resolve) => {
        finishB = resolve
      }))
      addTeardown(() => {
        resetA.catch(() => {})
        resetB.catch(() => {})
        failA?.(new Error('released after the test'))
        finishB?.()
      })
      await until(() => !!failA && !!finishB, 'both persistence hooks run')
      if (aFailsFirst) {
        failA!(new Error('A failed'))
        await assert.rejects(within(resetA, 'reset A'), /A failed/)
        finishB!()
        await within(resetB, 'reset B')
      } else {
        finishB!()
        await within(resetB, 'reset B')
        failA!(new Error('A failed'))
        await assert.rejects(within(resetA, 'reset A'), /A failed/)
      }
      assert.strictEqual(clockSyncRunning(), true)
      assert.ok(!logged(errors, 'failed to restart clock sync'))
    })
  }
})

// A teardown step that throws (e.g. an app's `reactiveDel`) leaves the
// state partly torn down, so the old session can't go on. The reset still
// starts a new KV session and restarts clock sync; the app should reset
// again.
describe('chelonia/reset failing in its teardown', () => {
  const failDeletes = () => {
    let failing = true
    addTeardown(() => { failing = false })
    sbp('chelonia/configure', {
      reactiveDel: (obj: any, key: string) => {
        if (failing) throw new Error('reactiveDel failed')
        delete obj[key]
      }
    })
    return () => { failing = false }
  }

  it('starts a new KV session, and restarts clock sync', async () => {
    await setupStaleDeviceA()
    connect()
    const stopFailing = failDeletes()
    await assert.rejects(within(sbp('chelonia/reset'), 'the reset'), /reactiveDel failed/)
    stopFailing()
    assert.strictEqual(clockSyncRunning(), true)
    // Height recovery runs, rather than ending at once as aborted: the
    // contract is still subscribed (the teardown stopped before the
    // subscriptions), and both recoveries sync it.
    const syncsBefore = server.syncs
    const thrown = new ChelErrorKvHeightAhead('[test] ahead', {
      cause: { requiredHeight: 42, exact: true, localHeight: 40, etag: null, httpStatus: 412 }
    })
    await assert.rejects(
      within(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, () => Promise.reject(thrown)), 'the recovery'),
      (e: unknown) => e === thrown
    )
    assert.strictEqual(server.syncs - syncsBefore, 2)
    // As the app should: the state left behind is partly torn down.
    await within(sbp('chelonia/reset'), 'the second reset')
  })

  it('lets the next reset succeed', async () => {
    await setupStaleDeviceA()
    connect()
    const stopFailing = failDeletes()
    await assert.rejects(within(sbp('chelonia/reset'), 'the reset'), /reactiveDel failed/)
    stopFailing()
    await within(sbp('chelonia/reset'), 'the second reset')
    assert.strictEqual(clockSyncRunning(), true)
    assert.ok(!logged(errors, 'failed to restart clock sync'))
  })
})
