// Height-aware KV handling of pubsub KV frames (KV-REVAMPED.md §3.4).
//
// Same harness as `kv-height.test.ts` (see `kv-height-harness.ts`), in its
// own file because these tests call `chelonia/connect`, whose listeners
// outlive `chelonia/_init`: in a shared file they would change how every
// later test reconciles its slots.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { CHELONIA_KV_UPDATED } from './events.js'
import {
  CONTRACT_ID,
  UNREAD,
  V0,
  VB,
  addChatRoomUnreadMessage,
  advanceLocalHeightOnInternalLane,
  debugs,
  drainLanes,
  installKvHeightHooks,
  mirror,
  onEvent,
  room,
  server,
  setLocalHeight,
  setupStaleDeviceA,
  sleep,
  subscribeContract,
  warnings,
  writeAsDeviceB
} from './kv-height-harness.js'
import { NOTIFICATION_TYPE } from './pubsub/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

let client: any
// Messages passed to the raw KV callback, when `connect` installs one.
let rawFrames: unknown[]

const connect = ({ rawHandler = false } = {}) => {
  rawFrames = []
  client = sbp('chelonia/connect', rawHandler
    ? { messageHandlers: { [NOTIFICATION_TYPE.KV]: (msg: unknown) => { rawFrames.push(msg) } } }
    : {})
}

afterEach(() => {
  client?.destroy()
  client = undefined
})

// Delivers the value stored for `key` as a pubsub KV frame.
const deliverKvFrame = (key = UNREAD) => {
  const stored = server.store.get(key)!
  client.messageHandlers[NOTIFICATION_TYPE.KV].call(client, {
    type: NOTIFICATION_TYPE.KV,
    channelID: CONTRACT_ID,
    key,
    data: stored.body,
    cid: `"${stored.cid}"`
  })
  return stored
}

describe('pubsub frames while the local contract is behind', () => {
  it('a frame that is ahead reloads the key once the contract catches up', async () => {
    await setupStaleDeviceA()
    connect()
    const stored = deliverKvFrame()
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    const updates: any[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => updates.push(p))
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
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

describe('the raw KV callback', () => {
  it('gets the frames written at a height the local contract has reached', async () => {
    connect({ rawHandler: true })
    await subscribeContract()
    await writeAsDeviceB('other', V0, 40)
    deliverKvFrame('other')
    await drainLanes()
    assert.strictEqual(rawFrames.length, 1)
  })

  it("isn't called for a frame that is ahead, and without a slot a warning says it was dropped", async () => {
    connect({ rawHandler: true })
    await subscribeContract()
    await writeAsDeviceB('other', V0, 42)
    server.log.length = 0
    deliverKvFrame('other')
    await drainLanes()
    assert.strictEqual(rawFrames.length, 0)
    assert.ok(warnings.some((w) => String(w[0]).includes('dropping kv pubsub frame')))
    // Nothing reloads it once the contract catches up.
    setLocalHeight(42)
    await drainLanes()
    await sleep(50)
    assert.strictEqual(rawFrames.length, 0)
    assert.strictEqual(server.gets().length, 0)
  })

  it("isn't called for a frame that is ahead even when a slot reloads its key", async () => {
    await setupStaleDeviceA()
    connect({ rawHandler: true })
    deliverKvFrame()
    await drainLanes()
    setLocalHeight(42)
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.strictEqual(rawFrames.length, 0)
    assert.ok(!warnings.some((w) => String(w[0]).includes('dropping kv pubsub frame')))
  })
})
