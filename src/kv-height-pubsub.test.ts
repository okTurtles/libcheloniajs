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
import { isKvHeightAhead, isKvHeightMalformed } from './errors.js'
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
  deliverBody(key, stored.body, stored.cid)
  return stored
}

const deliverBody = (key: string, body: string, cid = createCID(body, multicodes.RAW)) => {
  client.messageHandlers[NOTIFICATION_TYPE.KV].call(client, {
    type: NOTIFICATION_TYPE.KV,
    channelID: CONTRACT_ID,
    key,
    data: body,
    cid: `"${cid}"`
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
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
    assert.strictEqual(mirror(UNREAD).etag, `"${stored.cid}"`)
    assert.deepStrictEqual(updates.map((u) => u.reason), ['remote'])
    assert.ok(debugs.some((d) => String(d[0]).includes('reloading the slot')))
    // With the etag current, the next write needs no conflict round trip.
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
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
    await advanceLocalHeightOnInternalLane(42)
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.ok(!('heightAhead' in mirror(UNREAD)))
  })

  it("a clear retried after a recovery doesn't carry the first attempt's conflict", async () => {
    await setupStaleDeviceA()
    connect()
    // B's frame for VB (height 42) arrives while A is at 40: deferred.
    deliverKvFrame()
    await drainLanes()
    server.catchUpOnSync = true
    await sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD)
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
    deliverKvFrame()
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, V2)
    assert.strictEqual(server.gets().length, getsBefore)
  })
})

// `connect` uses the harness's manual connection options, so the client's
// socket never opens: no contract event can arrive, and `kv/set` doesn't
// wait for one.
describe('writes and loads while the pubsub socket is closed', () => {
  // Time of the first contract sync requested at or after `started`.
  const firstSyncAfter = (started: number): number | undefined => server.requests.find((r) =>
    r.at >= started && r.path.startsWith('/latestHEADinfo/')
  )?.at

  it('a stale stamp (409) goes straight to the recovery sync', async () => {
    await loadV0At40()
    connect()
    // The server moved on without changing the key (e.g. a contract event
    // this device missed while its socket was down).
    server.height = 41
    server.catchUpOnSync = true
    server.log.length = 0
    const started = Date.now()
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    const firstSync = firstSyncAfter(started)
    assert.ok(firstSync !== undefined, 'no recovery sync')
    assert.ok(firstSync - started < 500, `first sync after ${firstSync - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
  })

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
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5),
        maxHeightRecoveries: 0
      }),
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
      sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, VB, {
        ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
      }),
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
      sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
        ifMatch: e0,
        signingKeyId: cskId,
        encryptionKeyId: cekId,
        onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
      }),
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
    await assert.rejects(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), (e: unknown) => isKvHeightAhead(e))
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
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
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
    assert.ok(logged(warnings, 'dropping kv pubsub frame'))
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
describe('chelonia/reset failing in its persistence hook', () => {
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
    await assert.rejects(sbp('chelonia/reset', () => {
      sbp('chelonia/kv/_registerHeightWait', {
        contractID: CONTRACT_ID, key: 'absent', requiredHeight: 42, reason: 'remote'
      })
      failSets = true
      throw new Error('persistence hook failed')
    }), /persistence hook failed/)
    failSets = false
    assert.ok(logged(errors, 'failed to resume the KV height session'))
    assert.strictEqual(clockSyncRunning(), true)
  })

  it('restarts clock sync when resuming succeeds', async () => {
    await loadV0At40()
    connect()
    await assert.rejects(
      sbp('chelonia/reset', () => { throw new Error('persistence hook failed') }),
      /persistence hook failed/
    )
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
