// A `CHELONIA_KV_UPDATED` listener runs synchronously and can drop the slot's
// entry (or drop and re-seed it, e.g. through `chelonia/kv/refreshFilters`).
// The load or the pubsub frame that emitted the event must then neither stamp
// a status on that entry nor fail.
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import {
  activate, CONTRACT_ID, connectPubsub, defineSlot, deliverFrame, drainLanes, installKvHarness,
  logs, mirror, rootState, server, sync, writeAsDeviceB
} from './kv-height-harness.js'
import type { KvMirrorEntry } from './types.js'

let matches = true
// Flips `match` to false (and back, if `reseed`) on the first update with `reason`
const dropOnUpdate = (reason: string, { reseed = false } = {}) => {
  const dropped: (KvMirrorEntry | undefined)[] = []
  const listener = (update: { key: string; reason: string }) => {
    if (update.reason !== reason || dropped.length) return
    matches = false
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    if (reseed) {
      matches = true
      sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    }
    dropped.push(mirror(update.key) && { ...mirror(update.key)! })
  }
  sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, listener)
  return { dropped, off: () => sbp('okTurtles.events/off', CHELONIA_KV_UPDATED, listener) }
}
// The entry's fields at each status change
const statusesOf = (key: string) => {
  const seen: KvMirrorEntry[] = []
  const listener = () => { seen.push({ ...mirror(key)! }) }
  sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
  return { seen, off: () => sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener) }
}
const errors = () => logs.entries.filter(({ level }) => level === 'error').map(({ text }) => text)

describe('A CHELONIA_KV_UPDATED listener that drops the entry', () => {
  installKvHarness()

  const start = async ({ pubsub = false } = {}) => {
    matches = true
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {}, match: () => matches })
    if (pubsub) connectPubsub()
    await activate()
    assert.strictEqual(mirror('prefs')?.status, 'loaded')
  }

  it('on a load that finds the key deleted', async () => {
    await start()
    server.store.delete('prefs')
    const { dropped, off } = dropOnUpdate('load')
    try {
      await sync('prefs')
    } finally { off() }
    assert.deepStrictEqual(dropped, [undefined])
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })

  it('on a pubsub frame', async () => {
    await start({ pubsub: true })
    writeAsDeviceB('prefs', { theme: 'dark' })
    const { dropped, off } = dropOnUpdate('remote')
    try {
      deliverFrame('prefs')
      await drainLanes()
    } finally { off() }
    assert.deepStrictEqual(dropped, [undefined])
    assert.deepStrictEqual(errors(), [])
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })

  for (const [what, reason] of [['a pubsub frame', 'remote'], ['a load', 'load']] as const) {
    it(`and re-seeds it, on ${what}: the fresh entry keeps its status`, async () => {
      await start({ pubsub: true })
      writeAsDeviceB('prefs', { theme: 'dark' })
      const { dropped, off } = dropOnUpdate(reason, { reseed: true })
      const statuses = statusesOf('prefs')
      try {
        if (reason === 'remote') deliverFrame('prefs')
        else await sync('prefs')
        await drainLanes()
      } finally {
        off()
        statuses.off()
      }
      assert.deepStrictEqual(dropped, [{ value: undefined, etag: null, status: 'non-init', settled: false }])
      // The stale outcome would stamp the empty entry `'loaded'`
      assert.ok(!statuses.seen.some(({ status, value }) => status === 'loaded' && value === undefined),
        JSON.stringify(statuses.seen))
      assert.deepStrictEqual(mirror('prefs')?.value, { theme: 'dark' })
      assert.strictEqual(mirror('prefs')?.status, 'loaded')
    })
  }
})
