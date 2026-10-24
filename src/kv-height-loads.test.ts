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
import type { CheloniaContext, KvHeightRecoveryOptions, KvLoadStatus } from './types.js'

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
const sync = (key: string, options?: KvHeightRecoveryOptions) =>
  within(sbp('chelonia/kv/sync', CONTRACT_ID, key, options) as Promise<void>, `kv/sync of ${key}`)
const settledStatus = (key: string) => sbp('chelonia/kv/settledStatus', CONTRACT_ID, key)
const whenSettled = (key: string) =>
  within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, key) as Promise<string>, `${key} to settle`)
const aheadAt = (height: number) => (e: unknown) =>
  kvHeightAheadCause(e)?.requiredHeight === height
// A load that finds the value ahead, without recovering
const findAhead = (key: string, height = AHEAD) =>
  assert.rejects(sync(key, { onHeightAhead: 'reject' }), aheadAt(height))
// What a pubsub frame for `prefs` from contract height `height` does
const frameAhead = (height: number) =>
  sbp('chelonia/kv/_onUnverifiableFrame', CONTRACT_ID, 'prefs', height)

// Defines `prefs`, loads it empty, then has another device write a value
// from a newer height and makes a load find it
const deferEmptySlot = async (match?: () => boolean) => {
  defineSlot({ key: 'prefs', defaultValue: {}, match })
  await activate()
  writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
  await findAhead('prefs')
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
    await findAhead('prefs')
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
    await findAhead('prefs')
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
    await findAhead('prefs')
    // No longer known to be empty
    assert.strictEqual(mirror('prefs')?.status, 'loading')

    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightAhead')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    assert.strictEqual(syncs.count, before + 1)
    // The next finding arms a new fallback
    await findAhead('prefs')
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

  it("doesn't postpone the fallback for findings before or during its sync", async () => {
    kvHeightTimings.pendingFallbackMs = 20
    await deferEmptySlot()
    const release = holdSyncs()
    const before = syncs.count
    kvHeightTimings.pendingFallbackMs = 60_000
    frameAhead(AHEAD + 1)
    await until(() => syncs.count > before, 'the fallback sync armed first')
    frameAhead(AHEAD + 2)
    release()
    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD + 2 })
  })

  it('gives up with a height error on a slot that failed to load before', async () => {
    const { handle } = server
    server.handle = async (url, init) => init?.method !== 'POST' && url.endsWith('/prefs')
      ? new Response(null, { status: 500 })
      : handle(url, init)
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    assert.strictEqual(await whenSettled('prefs'), 'error')
    server.handle = handle
    assert.notStrictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightAhead')
    kvHeightTimings.pendingFallbackMs = 20
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await findAhead('prefs')
    await until(() => mirror('prefs')?.lastError?.name === 'ChelErrorKvHeightAhead', 'the give-up')
    assert.strictEqual(settledStatus('prefs'), 'error')
  })

  it('reloads at once, unmarked, a value whose height arrived before it registered', async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' })
    const markers: unknown[] = []
    const listener = ({ heightAhead }: { heightAhead: unknown }) => { markers.push(heightAhead) }
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
    try {
      frameAhead(START_HEIGHT)
      await until(() => read('prefs')?.theme === 'dark', 'the reload')
    } finally {
      sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener)
    }
    assert.deepStrictEqual(markers.filter((marker) => marker !== null), [])
  })

  it('re-arms the fallback when one ran during a reload that ends up empty', async () => {
    kvHeightTimings.pendingFallbackMs = 60_000
    await deferEmptySlot()
    let answer!: () => void
    const answered = new Promise<void>((resolve) => { answer = resolve })
    let held = false
    server.onGet = () => { held = true; return answered }
    try {
      setLocalHeight(AHEAD)
      await until(() => held, 'the reload')
      server.store.delete('prefs')
      kvHeightTimings.pendingFallbackMs = 20
      const before = syncs.count
      frameAhead(AHEAD + 1)
      await until(() => syncs.count > before && !sbp('chelonia/contract/isSyncing', CONTRACT_ID),
        'the fallback sync during the reload')
      await sleep(20)
    } finally {
      answer()
    }
    assert.strictEqual(await whenSettled('prefs'), 'error')
  })

  it('reloads nothing more once a load queued earlier verified the value', async () => {
    const reasons: string[] = []
    defineSlot({ key: 'prefs', defaultValue: {}, onUpdate: (_value, { reason }) => { reasons.push(reason) } })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await findAhead('prefs')
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

describe('Single-key kv/sync of a value from a newer contract height', () => {
  installKvHarness()

  const statusesOf = async (key: string, body: () => Promise<void>) => {
    const statuses: KvLoadStatus[] = []
    const listener = (event: { key: string; status: KvLoadStatus }) => {
      if (event.key === key) statuses.push(event.status)
    }
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
    try {
      await body()
    } finally {
      sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener)
    }
    return statuses
  }

  it('waits, syncs the contract, then loads the value with one reload', async () => {
    kvHeightTimings.waitMs = 10
    const reasons: string[] = []
    defineSlot({ key: 'prefs', defaultValue: {}, onUpdate: (_value, { reason }) => { reasons.push(reason) } })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    syncs.catchUp = true
    const [syncsBefore, getsBefore] = [syncs.count, gets('prefs')]
    await sync('prefs')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(settledStatus('prefs'), 'loaded')
    assert.strictEqual(mirror('prefs')?.heightAhead, undefined)
    assert.strictEqual(syncs.count, syncsBefore + 1)
    await drainLanes()
    // The load that found the value, and the reload once the sync brought its height
    assert.strictEqual(gets('prefs'), getsBefore + 2)
    assert.deepStrictEqual(reasons, ['load'])
  })

  it('loads once, without syncing, when the height arrives during its wait', async () => {
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const before = syncs.count
    const rounds = [[AHEAD, {}], [AHEAD + 1, { maxHeightRecoveries: 0 }]] as const
    for (const [height, options] of rounds) {
      writeAsDeviceB('prefs', { height }, height)
      const getsBefore = gets('prefs')
      const explicit = sync('prefs', options)
      await until(() => mirror('prefs')?.heightAhead?.requiredHeight === height, `a finding at ${height}`)
      setLocalHeight(height)
      await explicit
      assert.deepStrictEqual(read('prefs'), { height })
      await drainLanes()
      assert.strictEqual(gets('prefs'), getsBefore + 2)
    }
    assert.strictEqual(syncs.count, before)
  })

  it("settles the slot once its recoveries don't bring the height, and reloads it later", async () => {
    kvHeightTimings.waitMs = 10
    writeAsDeviceB('kept', ['v0'])
    defineSlot({ key: 'kept', defaultValue: [] })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('kept', ['v1'], AHEAD)
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const before = syncs.count
    const statuses = await statusesOf('kept', () => assert.rejects(sync('kept'), aheadAt(AHEAD)))
    assert.strictEqual(syncs.count, before + 2)
    // Only the first of its loads shows `loading`
    assert.strictEqual(statuses.filter((status) => status === 'loading').length, 1)
    assert.deepStrictEqual([settledStatus('kept'), read('kept')], ['loaded', ['v0']])

    await assert.rejects(sync('prefs', { maxHeightRecoveries: 1 }), aheadAt(AHEAD))
    assert.strictEqual(syncs.count, before + 3)
    assert.strictEqual(settledStatus('prefs'), 'error')
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightAhead')

    setLocalHeight(AHEAD)
    await until(() => !mirror('prefs')?.heightAhead && !mirror('kept')?.heightAhead, 'the reloads')
    assert.deepStrictEqual([read('kept'), read('prefs')], [['v1'], { theme: 'dark' }])
    assert.deepStrictEqual([settledStatus('kept'), settledStatus('prefs')], ['loaded', 'loaded'])
  })

  it("with 'reject', or no recoveries, leaves the slot to its fallback", async () => {
    kvHeightTimings.pendingFallbackMs = 1000
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const before = syncs.count
    await findAhead('prefs')
    kvHeightTimings.waitMs = 10
    await assert.rejects(sync('prefs', { maxHeightRecoveries: 0 }), aheadAt(AHEAD))
    assert.strictEqual(syncs.count, before)
    assert.strictEqual(settledStatus('prefs'), undefined)
    // The fallback syncs once, then gives up
    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.strictEqual(syncs.count, before + 1)
    setLocalHeight(AHEAD)
    await until(() => settledStatus('prefs') === 'loaded', 'the reload at the height')
  })

  it('rejects at once when aborted, and the key still reloads at the height', async () => {
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const stop = (e: unknown) => e === 'stop'
    // While it waits for the height
    const waiting = new AbortController()
    const waited = assert.rejects(sync('prefs', { signal: waiting.signal }), stop)
    await until(() => mirror('prefs')?.heightAhead, 'the finding')
    waiting.abort('stop')
    await waited
    // While its load waits for the lane; the load still runs
    const openLane = gateLane()
    const queued = new AbortController()
    const before = gets('prefs')
    const aborted = assert.rejects(sync('prefs', { signal: queued.signal }), stop)
    queued.abort('stop')
    await aborted
    openLane()
    await until(() => gets('prefs') === before + 1, 'the load')

    setLocalHeight(AHEAD)
    assert.strictEqual(await whenSettled('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  it('rejects with an AbortError on reset', async () => {
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const waiting = assert.rejects(sync('prefs'), { name: 'AbortError' })
    await until(() => mirror('prefs')?.heightAhead, 'the finding')
    await within(sbp('chelonia/reset') as Promise<void>, 'the reset')
    await waiting
  })

  it('joins a running recovery sync without waiting for the height first', async () => {
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const openLane = gateLane()
    const explicit = assert.rejects(sync('prefs', { maxHeightRecoveries: 1 }), aheadAt(AHEAD))
    // Another caller's recovery sync
    const releaseSyncs = holdSyncs()
    const before = syncs.count
    const other = assert.rejects(within(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID,
      () => sbp('chelonia/kv/get', CONTRACT_ID, 'prefs'), { maxHeightRecoveries: 1 }
    ), 'the other recovery'), aheadAt(AHEAD))
    await until(() => syncs.count === before + 1, 'the recovery sync')
    openLane()
    await until(() => mirror('prefs')?.heightAhead, 'the finding')
    releaseSyncs()
    await explicit
    await other
    // The joined sync ended short of the height, so it synced once more
    assert.strictEqual(syncs.count, before + 2)
  })

  it('validates its options before any request', async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const before = server.log.length
    const invalid = { onHeightAhead: 'never' } as unknown as KvHeightRecoveryOptions
    await assert.rejects(sync('nope', invalid), { name: 'ChelErrorKvSlotUnknown' })
    for (const options of [invalid, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 }]) {
      await assert.rejects(sync('prefs', options), { name: 'ChelErrorKvUpdateInvalid' })
    }
    assert.strictEqual(server.log.length, before)
  })
})
