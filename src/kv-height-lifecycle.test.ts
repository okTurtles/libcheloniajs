import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { kvHeightAheadCause } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import {
  activate, CONTRACT_ID, CONTRACT_TYPE, defineSlot, drainLanes, gateLane, holdSyncs,
  installKvHarness, mirror, resync, rootState, server, setLocalHeight, setupContract, START_HEIGHT,
  syncs, writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { isPending, until, waitMicrotasks, within } from './test-utils.js'
import type { JSONType, KvHeightRecoveryOptions } from './types.js'

const AHEAD = START_HEIGHT + 1
const slotUnknown = { name: 'ChelErrorKvSlotUnknown' }
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

// Starts a resync and holds it once its teardown has removed the contract;
// the returned function lets it finish
const startResync = async (): Promise<() => Promise<void>> => {
  const release = holdSyncs()
  const done = within(resync(), 'the resync')
  await until(() => !rootState().contracts[CONTRACT_ID]?.HEAD, 'the resync teardown')
  return async () => {
    release()
    await done
    await drainLanes()
  }
}

describe('A contract resync', () => {
  installKvHarness()
  type Payload = Record<string, unknown>
  const updated: Payload[] = []
  const statuses: Payload[] = []
  const onUpdated = (payload: Payload) => { updated.push(payload) }
  const onStatus = (payload: Payload) => { statuses.push(payload) }
  beforeEach(() => {
    updated.length = 0
    statuses.length = 0
    sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, onUpdated)
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, onStatus)
  })
  afterEach(() => {
    sbp('okTurtles.events/off', CHELONIA_KV_UPDATED, onUpdated)
    sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, onStatus)
  })

  it('keeps the values; the slots are unknown meanwhile, then unsettled', async () => {
    writeAsDeviceB('prefs', { theme: 'dark' })
    defineSlot({ key: 'prefs', defaultValue: {}, autoLoad: 'never' })
    await activate()
    await sync('prefs')
    assert.strictEqual(settledStatus('prefs'), 'loaded')
    const loads = gets('prefs')

    const finish = await startResync()
    assert.throws(() => read('prefs'), slotUnknown)
    assert.deepStrictEqual(mirror('prefs')?.value, { theme: 'dark' })
    const settled = whenSettled('prefs')
    await finish()
    assert.ok(await isPending(settled))
    assert.strictEqual(settledStatus('prefs'), undefined)
    assert.strictEqual(mirror('prefs')?.status, 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(gets('prefs'), loads)

    await sync('prefs')
    assert.strictEqual(await settled, 'loaded')
  })

  it('reports a value removed meanwhile once its slot reloads', async () => {
    writeAsDeviceB('prefs', { theme: 'dark' })
    const updates: unknown[] = []
    defineSlot({
      key: 'prefs',
      defaultValue: {},
      onUpdate: (value, { reason, previousValue }) => {
        updates.push([reason, value, previousValue])
      }
    })
    await activate()
    updates.length = 0
    updated.length = 0
    server.store.delete('prefs')

    await within(resync(), 'the resync')
    await drainLanes()
    assert.deepStrictEqual(
      updated.map(({ reason, value, previousValue }) => [reason, value, previousValue]),
      [['load', undefined, { theme: 'dark' }]]
    )
    assert.deepStrictEqual(updates, [['load', {}, { theme: 'dark' }]])
    assert.strictEqual(settledStatus('prefs'), 'non-init')
    assert.deepStrictEqual(read('prefs'), {})
  })

  it('clears heightAhead markers with an event naming the contract type', async () => {
    defineSlot({ key: 'prefs', defaultValue: {}, autoLoad: 'never' })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await assert.rejects(sync('prefs', { onHeightAhead: 'reject' }), aheadAt(AHEAD))
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    statuses.length = 0

    await within(resync(), 'the resync')
    await drainLanes()
    assert.deepStrictEqual(
      statuses.map(({ contractType, status, heightAhead }) => [contractType, status, heightAhead]),
      [[CONTRACT_TYPE, 'loading', null], [CONTRACT_TYPE, 'non-init', null]]
    )
    assert.strictEqual(mirror('prefs')?.heightAhead, undefined)
    // Nor does the wait reload the key at the height any more
    const loads = gets('prefs')
    setLocalHeight(AHEAD)
    await drainLanes()
    assert.strictEqual(gets('prefs'), loads)
    assert.strictEqual(settledStatus('prefs'), undefined)
  })

  it('drops the entries of slots unregistered meanwhile', async () => {
    writeAsDeviceB('kept', 1)
    writeAsDeviceB('gone', 2)
    const manifestKv = { gone: { defaultValue: 0 } }
    defineSlot({ key: 'kept', defaultValue: 0 })
    sbp('chelonia/kv/_registerContractSlots', CONTRACT_TYPE, 'manifest-1', manifestKv)
    await activate()

    const finish = await startResync()
    sbp('chelonia/kv/_cleanupContractSlots', CONTRACT_TYPE, 'manifest-1', manifestKv, {})
    assert.strictEqual(mirror('gone')?.value, 2)
    await finish()
    assert.deepStrictEqual(Object.keys(rootState()._kv?.[CONTRACT_ID] ?? {}), ['kept'])
    assert.strictEqual(read('kept'), 1)
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  it('keeps the entries through a failed resync until the contract is removed', async () => {
    writeAsDeviceB('prefs', { theme: 'dark' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    syncs.fail = true
    await assert.rejects(within(resync(), 'the resync'))
    assert.deepStrictEqual(mirror('prefs')?.value, { theme: 'dark' })
    const settled = assert.rejects(whenSettled('prefs'), slotUnknown)
    assert.ok(await isPending(settled))

    sbp('chelonia/private/removeImmediately', CONTRACT_ID)
    await settled
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })

  it('leaves update to reload a slot that gave up on its value before writing', async () => {
    kvHeightTimings.waitMs = 10
    writeAsDeviceB('count', { n: 1 }, AHEAD)
    defineSlot({ key: 'count', defaultValue: { n: 0 }, autoLoad: 'never' })
    await activate()
    await assert.rejects(sync('count', { maxHeightRecoveries: 1 }), aheadAt(AHEAD))
    assert.strictEqual(mirror('count')?.lastError?.name, 'ChelErrorKvHeightAhead')
    await within(resync(), 'the resync')
    assert.strictEqual(mirror('count')?.heightAhead, undefined)
    setLocalHeight(AHEAD)

    const requests = server.log.length
    const seen: unknown[] = []
    const updater = (value: JSONType) => {
      seen.push(value)
      return { n: (value as { n: number }).n + 1 }
    }
    await within(sbp('chelonia/kv/update', { contractID: CONTRACT_ID, key: 'count', updater }),
      'the update')
    assert.deepStrictEqual(seen, [{ n: 1 }])
    assert.deepStrictEqual(
      server.log.slice(requests).map(({ method, status }) => [method, status]),
      [['GET', 200], ['POST', 204]]
    )
    assert.deepStrictEqual(read('count'), { n: 2 })
  })
})

const OTHER_ID = 'zKvOtherContract'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const increment = (value: JSONType) => ({ n: (value as { n: number }).n + 1 })
const update = (key: string, updater: (value: JSONType) => JSONType, options = {}) => within(
  sbp('chelonia/kv/update', { contractID: CONTRACT_ID, key, updater, ...options }) as
    Promise<JSONType | undefined>,
  `update of ${key}`
)
const findAhead = (key: string) =>
  assert.rejects(sync(key, { onHeightAhead: 'reject' }), aheadAt(AHEAD))

// `chelonia/reset` drains the lanes twice, then aborts and calls
// `chelonia/kv/_waitInFlight`
const resetProbe = { waits: 0, aborted: false, atLastDrain: undefined as (() => void) | undefined }
sbp('sbp/filters/selector/add', 'chelonia/contract/wait', () => {
  if (++resetProbe.waits === 2) resetProbe.atLastDrain?.()
})
sbp('sbp/filters/selector/add', 'chelonia/kv/_waitInFlight', () => { resetProbe.aborted = true })

// Starts a reset and holds it in its last drain before the abort, on the lane
// of another contract it drains, so that this contract's lanes are free
const startHeldReset = () => {
  rootState().contracts[OTHER_ID] = { HEAD: 'other', height: 0, previousKeyOp: '', type: 'other' }
  let open: (() => void) | undefined
  Object.assign(resetProbe, {
    waits: 0, aborted: false, atLastDrain: () => { open = gateLane('public', OTHER_ID) }
  })
  return {
    reset: within(sbp('chelonia/reset') as Promise<unknown>, 'the reset'),
    held: async () => {
      await until(() => open, 'the last drain')
      await drainLanes()
    },
    abort: async () => {
      open!()
      await until(() => resetProbe.aborted, 'the abort')
    }
  }
}

describe('chelonia/reset', () => {
  installKvHarness()

  it('finishes the writes its drain runs, and rejects later ones without posting', async () => {
    writeAsDeviceB('count', { n: 1 })
    defineSlot({ key: 'count', defaultValue: { n: 0 } })
    await activate()
    const openLane = gateLane()
    const drained = update('count', increment)
    const { reset, held, abort } = startHeldReset()
    openLane()
    assert.deepStrictEqual(await drained, { n: 2 })

    await held()
    const openAgain = gateLane()
    const queued = [
      update('count', increment),
      sbp('chelonia/kv/clear', CONTRACT_ID, 'count'),
      sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, key: 'count', data: { n: 9 } })
    ].map((write) => assert.rejects(within(write, 'a queued write'), { name: 'AbortError' }))
    await waitMicrotasks()
    await abort()
    await Promise.all(queued)
    openAgain()
    await reset
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204])
  })

  it('rejects an update whose reload is running when it aborts, before its updater runs', async () => {
    writeAsDeviceB('count', { n: 1 })
    defineSlot({ key: 'count', defaultValue: { n: 0 }, autoLoad: 'never' })
    await activate()
    const { reset, held, abort } = startHeldReset()
    await held()
    let releaseGet: (() => void) | undefined
    server.onGet = () => new Promise<void>((resolve) => { releaseGet = resolve })
    let calls = 0
    const write = assert.rejects(
      update('count', (value) => { calls++; return increment(value) }, { ifMatch: '*' }),
      { name: 'AbortError' }
    )
    await until(() => releaseGet, 'the reload')
    await abort()
    releaseGet!()
    await write
    await reset
    assert.strictEqual(calls, 0)
    assert.deepStrictEqual(server.posts(), [])
  })

  it('keeps deferred loads working when it fails before its teardown', async () => {
    kvHeightTimings.pendingFallbackMs = 20
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const before = syncs.count
    const persist = async () => {
      await findAhead('prefs')
      // Its fallback falls due meanwhile
      await sleep(100)
      throw new Error('persist failed')
    }
    await assert.rejects(within(sbp('chelonia/reset', persist), 'the reset'), /persist failed/)
    assert.strictEqual(syncs.count, before)
    assert.strictEqual(settledStatus('prefs'), undefined)

    // The fallback syncs, then settles the slot without the value
    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.strictEqual(syncs.count, before + 1)
    setLocalHeight(AHEAD)
    await until(() => mirror('prefs')?.status === 'loaded', 'the reload')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  it('lets later sessions recover after a reset whose teardown throws', async () => {
    await activate()
    const failing = () => { throw new Error('teardown failed') }
    await sbp('chelonia/configure', { reactiveDel: failing })
    await assert.rejects(within(sbp('chelonia/reset'), 'the reset'), /teardown failed/)
    const reactiveDel = (obj: Record<string, unknown>, key: string) => { delete obj[key] }
    await sbp('chelonia/configure', { reactiveDel })
    await within(sbp('chelonia/reset'), 'the next reset')

    kvHeightTimings.pendingFallbackMs = 20
    setupContract()
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    syncs.catchUp = true
    await findAhead('prefs')
    // The fallback syncs and reloads
    assert.strictEqual(await whenSettled('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })

    writeAsDeviceB('prefs', { theme: 'light' }, AHEAD + 1)
    const synced = syncs.count
    const written = await update('prefs', (value) => ({ ...(value as object), lang: 'en' }))
    assert.deepStrictEqual(written, { theme: 'light', lang: 'en' })
    assert.strictEqual(syncs.count, synced + 1)
  })

  it('cancels the deferred loads of the session it ends', async () => {
    kvHeightTimings.pendingFallbackMs = 50
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    await findAhead('prefs')
    await within(sbp('chelonia/reset'), 'the reset')

    server.store.delete('prefs')
    setupContract()
    await activate()
    const synced = syncs.count
    // Past the old fallback
    await sleep(100)
    assert.strictEqual(syncs.count, synced)
    const loads = gets('prefs')
    setLocalHeight(AHEAD)
    await drainLanes()
    assert.strictEqual(gets('prefs'), loads)
  })
})
