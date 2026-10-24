import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { kvHeightAheadCause } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import {
  activate, CONTRACT_ID, CONTRACT_TYPE, defineSlot, drainLanes, holdSyncs, installKvHarness,
  mirror, resync, rootState, server, setLocalHeight, START_HEIGHT, syncs, writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { isPending, until, within } from './test-utils.js'
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
