import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import { isKvHeightAhead, kvHeightAheadCause } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CONTRACT_IS_SYNCING, CONTRACTS_MODIFIED } from './events.js'
import {
  activate, CONTRACT_ID, defineSlot, drainLanes, gateLane, holdSyncs, installKvHarness, logs,
  mirror, rootState, server, setLocalHeight, START_HEIGHT, syncs, writeAsDeviceB
} from './kv-height-harness.js'
import {
  kvHeightTimings, notifyContractHeight, onHeight, waitForHeight, waitForHeightAfterSync
} from './kv-height.js'
import { captureConsole, until, within } from './test-utils.js'
import type { CheloniaContext, KvLoadStatus } from './types.js'

const CID = 'zHeightContract'
const contracts: Record<string, { height: number }> = {}
sbp('sbp/selectors/register', { 'test.kvHeight/state': () => ({ contracts }) })

const PENDING = Symbol('pending')
const settledSoon = (promise: Promise<unknown>) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(PENDING), 20))])

describe('waitForHeight', () => {
  let ctx: CheloniaContext
  // What committing an event does
  const commit = (height: number, contractID = CID) => {
    contracts[contractID] = { height }
    notifyContractHeight(ctx, contractID, height)
  }
  const pubsubWith = (readyState: number | null) =>
    ({ socket: readyState === null ? null : { readyState } }) as CheloniaContext['pubsub']

  beforeEach(() => {
    contracts[CID] = { height: 10 }
    ctx = {
      config: { stateSelector: 'test.kvHeight/state' },
      currentSyncs: {},
      kvHeightListeners: new Map()
    } as unknown as CheloniaContext
  })

  it('resolves at once when the height is already committed', async () => {
    ctx.pubsub = pubsubWith(WebSocket.CLOSED)
    assert.strictEqual(await waitForHeight(ctx, CID, 10, { timeoutMs: 0 }), true)
  })

  it('wakes when the contract commits the height, not before', async () => {
    const wait = waitForHeight(ctx, CID, 12, { timeoutMs: 60_000 })
    commit(11)
    commit(12, 'zOtherContract')
    assert.strictEqual(await settledSoon(wait), PENDING)
    commit(13)
    assert.strictEqual(await within(wait, 'the wait'), true)
  })

  it('resolves false when the height does not arrive in time', async () => {
    assert.strictEqual(await within(waitForHeight(ctx, CID, 11, { timeoutMs: 20 }), 'wait'), false)
    assert.strictEqual(ctx.kvHeightListeners.size, 0)
  })

  it('rejects with the abort reason, whatever it is', async () => {
    const controller = new AbortController()
    const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: controller.signal })
    controller.abort('stop')
    await assert.rejects(within(wait, 'the wait'), (e) => e === 'stop')
    await assert.rejects(waitForHeight(ctx, CID, 10, { signal: controller.signal }), (e) => e === 'stop')
    assert.strictEqual(ctx.kvHeightListeners.size, 0)
  })

  it("doesn't wait while the pubsub socket isn't open", async () => {
    for (const readyState of [null, WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
      ctx.pubsub = pubsubWith(readyState)
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000 })
      assert.strictEqual(await within(wait, `wait (socket ${readyState})`), false)
    }
  })

  it('waits with an open socket, and without a pubsub client', async () => {
    for (const pubsub of [pubsubWith(WebSocket.OPEN), undefined]) {
      ctx.pubsub = pubsub as CheloniaContext['pubsub']
      const height = contracts[CID].height + 1
      const wait = waitForHeight(ctx, CID, height, { timeoutMs: 60_000 })
      assert.strictEqual(await settledSoon(wait), PENDING)
      commit(height)
      assert.strictEqual(await within(wait, 'the wait'), true)
    }
  })

  it("doesn't time out at once when asked to wait 2^31 ms or more", async () => {
    const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 2 ** 31 })
    assert.strictEqual(await settledSoon(wait), PENDING)
    commit(11)
    assert.strictEqual(await within(wait, 'the wait'), true)
  })

  it('still wakes the other waits when a height listener throws', async () => {
    const logs = captureConsole(['error'])
    try {
      onHeight(ctx, CID, 11, () => { throw new Error('listener failed') })
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000 })
      commit(11)
      assert.strictEqual(await within(wait, 'the wait'), true)
      assert.strictEqual(logs.logged.length, 1)
    } finally {
      logs.restore()
    }
  })

  describe('after a running sync', () => {
    const endSync = (contractID = CID) => {
      delete ctx.currentSyncs[contractID]
      sbp('okTurtles.events/emit', CONTRACT_IS_SYNCING, contractID, false)
    }

    beforeEach(() => {
      ctx.currentSyncs[CID] = { firstSync: false }
      ctx.currentSyncs.zOtherContract = { firstSync: false }
      ctx.pubsub = pubsubWith(WebSocket.CLOSED)
    })

    it('waits for the sync to end first, even with the socket closed', async () => {
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000 })
      commit(11)
      endSync('zOtherContract')
      assert.strictEqual(await settledSoon(wait), PENDING)
      endSync()
      assert.strictEqual(await within(wait, 'the wait'), true)
    })

    it("gives up if the sync doesn't end in time, even with the height reached", async () => {
      for (const timeoutMs of [0, 20]) {
        const wait = waitForHeightAfterSync(ctx, CID, 10, { timeoutMs })
        assert.strictEqual(await within(wait, `wait (${timeoutMs} ms)`), false)
      }
    })

    it("doesn't wait for the height once the sync ended while the socket is closed", async () => {
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000 })
      endSync()
      assert.strictEqual(await within(wait, 'the wait'), false)
    })
  })
})

let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedQueue
)

const AHEAD = START_HEIGHT + 2
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const gets = (key: string) =>
  server.log.filter((request) => request.method === 'GET' && request.key === key).length
const read = (key: string) => sbp('chelonia/kv/read', CONTRACT_ID, key)
const sync = (key: string) =>
  within(sbp('chelonia/kv/sync', CONTRACT_ID, key) as Promise<void>, `kv/sync of ${key}`)
const settledStatus = (key: string) => sbp('chelonia/kv/settledStatus', CONTRACT_ID, key)
const whenSettled = (key: string) =>
  within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, key) as Promise<string>, `${key} to settle`)
const aheadAt = (height: number) => (e: unknown) =>
  kvHeightAheadCause(e)?.requiredHeight === height

// Defines `prefs`, loads it empty, then has another device write a value
// from a newer height and makes a load find it
const deferEmptySlot = async (match?: () => boolean) => {
  defineSlot({ key: 'prefs', defaultValue: {}, match })
  await activate()
  writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
  await assert.rejects(sync('prefs'), aheadAt(AHEAD))
}

describe('Slot loads of values from a newer contract height', () => {
  installKvHarness()

  it('defers a background load and reloads the key once the height arrives', async () => {
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const updates: unknown[] = []
    defineSlot({
      key: 'prefs', defaultValue: {}, onUpdate: (value, { reason }) => { updates.push([value, reason]) }
    })
    await activate()
    assert.strictEqual(mirror('prefs')?.status, 'loading')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    assert.strictEqual(settledStatus('prefs'), undefined)
    const logged = (method: string) =>
      logs.logged.some((entry) => entry.method === method && isKvHeightAhead(entry.args[1]))
    assert.ok(logged('debug') && !logged('error'), 'a deferral is logged at debug level')
    // Another finding of the same value doesn't add a reload
    await assert.rejects(sync('prefs'), aheadAt(AHEAD))
    const before = gets('prefs')

    setLocalHeight(AHEAD)
    await until(() => settledStatus('prefs') === 'loaded', 'the reload')
    await drainLanes()
    assert.strictEqual(gets('prefs'), before + 1)
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(mirror('prefs')?.heightAhead, undefined)
    assert.deepStrictEqual(updates, [[{ theme: 'dark' }, 'load']])
  })

  it('keeps a loaded value and its status, and reloads without a loading flicker', async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await assert.rejects(sync('prefs'), aheadAt(AHEAD))
    assert.strictEqual(settledStatus('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })

    const statuses: KvLoadStatus[] = []
    const listener = ({ status }: { status: KvLoadStatus }) => { statuses.push(status) }
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
    try {
      setLocalHeight(AHEAD)
      await until(() => mirror('prefs')?.heightAhead === undefined, 'the reload')
    } finally {
      sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener)
    }
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.deepStrictEqual(statuses, ['loaded'])
  })

  it('syncs once after the fallback period, then settles an empty slot as an error', async () => {
    kvHeightTimings.pendingFallbackMs = 20
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    assert.strictEqual(settledStatus('prefs'), 'non-init')
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const before = syncs.count
    await assert.rejects(sync('prefs'), aheadAt(AHEAD))
    // No longer known to be empty
    assert.strictEqual(mirror('prefs')?.status, 'loading')

    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightAhead')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    assert.strictEqual(syncs.count, before + 1)
    // The next finding arms a new fallback
    await assert.rejects(sync('prefs'), aheadAt(AHEAD))
    await until(() => syncs.count === before + 2, 'the second fallback sync')
    // Catching up later still reloads the key
    setLocalHeight(AHEAD)
    await until(() => settledStatus('prefs') === 'loaded', 'the late reload')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  it('keeps a held value usable but unsettled until the fallback gives up', async () => {
    kvHeightTimings.pendingFallbackMs = 20
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    rootState()._kv = {
      [CONTRACT_ID]: { prefs: { value: { theme: 'light' }, etag: '"old"', status: 'loaded' } }
    }
    defineSlot({ key: 'prefs', defaultValue: {} })
    const openLane = gateLane()
    await within(sbp('chelonia/private/in/sync', CONTRACT_ID), 'the activating sync')
    const releaseSyncs = holdSyncs()
    const before = syncs.count
    openLane()
    await until(() => syncs.count > before, 'the fallback sync')
    assert.strictEqual(mirror('prefs')?.status, 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
    assert.strictEqual(settledStatus('prefs'), undefined)

    releaseSyncs()
    assert.strictEqual(await whenSettled('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
  })

  it('reloads the key when the fallback sync brings the height', async () => {
    kvHeightTimings.pendingFallbackMs = 20
    await deferEmptySlot()
    syncs.catchUp = true
    assert.strictEqual(await whenSettled('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  it('reloads nothing more once a load queued earlier verified the value', async () => {
    const reasons: string[] = []
    defineSlot({ key: 'prefs', defaultValue: {}, onUpdate: (_value, { reason }) => { reasons.push(reason) } })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await assert.rejects(sync('prefs'), aheadAt(AHEAD))
    const before = gets('prefs')
    const openLane = gateLane()
    const explicit = sync('prefs')
    // Its reload queues behind the explicit sync
    setLocalHeight(AHEAD)
    openLane()
    await explicit
    await drainLanes()
    assert.strictEqual(gets('prefs'), before + 1)
    assert.deepStrictEqual(reasons, ['load'])
    assert.strictEqual(mirror('prefs')?.heightAhead, undefined)
  })

  it('cancels the wait when the slot deactivates or its contract is removed', async () => {
    kvHeightTimings.pendingFallbackMs = 50
    let active = true
    await deferEmptySlot(() => active)
    const cancellations = {
      deactivation: () => {
        active = false
        sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
      },
      removal: () => {
        sbp('okTurtles.events/emit', CONTRACTS_MODIFIED, [], { added: [], removed: [CONTRACT_ID] })
      }
    }
    for (const [label, cancel] of Object.entries(cancellations)) {
      active = true
      sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
      await until(() => mirror('prefs')?.heightAhead, `${label}: a deferred load`)
      cancel()
      const before = syncs.count
      await sleep(150)
      assert.strictEqual(syncs.count, before, `${label}: no fallback sync`)
    }
  })

  it("settles the slot and keeps the marker when the reload can't start", async () => {
    await deferEmptySlot()
    vetoedQueue = `public:${CONTRACT_ID}`
    try {
      setLocalHeight(AHEAD)
      await until(() => settledStatus('prefs') === 'error', 'the vetoed reload to settle')
    } finally {
      vetoedQueue = undefined
    }
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorUnexpected')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    assert.ok(logs.logged.some(({ method, args }) =>
      method === 'error' && String(args[0]).includes('deferred reload')))
  })
})
