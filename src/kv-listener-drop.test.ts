// A `CHELONIA_KV_UPDATED` or `CHELONIA_KV_VALIDATION_ERROR` listener runs
// synchronously and can drop the slot's entry (or drop and re-seed it, e.g.
// through `chelonia/kv/refreshFilters`).
// The load or the pubsub frame that emitted the event must then neither stamp
// a status on that entry nor fail.
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED, CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
import {
  activate, CONTRACT_ID, connectPubsub, defineSlot, deliverFrame, drainLanes, gets,
  installKvHarness, logs, mirror, rootState, server, sync, update, whenSettled, writeAsDeviceB
} from './kv-height-harness.js'
import { until } from './test-utils.js'
import type { JSONType, KvMirrorEntry } from './types.js'

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

  // Every test connects: a pubsub client outlives `chelonia/_init`
  const start = async () => {
    matches = true
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {}, match: () => matches })
    connectPubsub()
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
    await start()
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

  it('and re-seeds it, on a load that finds the key deleted: the fresh entry settles on its own GET', async () => {
    await start()
    server.store.delete('prefs')
    const { dropped, off } = dropOnUpdate('load', { reseed: true })
    const getsBefore = gets('prefs')
    // The fresh entry's settled statuses, with the GETs sent by then
    const settles: [string, number][] = []
    const onStatus = () => {
      const entry = mirror('prefs')
      if (dropped.length && entry?.settled) settles.push([entry.status, gets('prefs') - getsBefore])
    }
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, onStatus)
    try {
      await sync('prefs')
      await drainLanes()
    } finally {
      off()
      sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, onStatus)
    }
    assert.deepStrictEqual(dropped, [{ value: undefined, etag: null, status: 'non-init', settled: false }])
    // The stale 404 would settle it `'non-init'` before its own GET
    assert.deepStrictEqual(settles, [['non-init', 2]], 'the fresh entry settles once, on its own GET')
  })

  it('and re-seeds it, on a local write: the fresh entry keeps its status', async () => {
    await start()
    const { dropped, off } = dropOnUpdate('local', { reseed: true })
    const statuses = statusesOf('prefs')
    try {
      assert.deepStrictEqual(await update('prefs', () => ({ theme: 'dark' })), { theme: 'dark' })
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

  for (const [what, reason] of [['a pubsub frame', 'remote'], ['a load', 'load']] as const) {
    it(`and re-seeds it, on ${what}: the fresh entry keeps its status`, async () => {
      await start()
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

describe('A CHELONIA_KV_VALIDATION_ERROR listener that drops the entry', () => {
  installKvHarness()

  // Rejects `{ theme: 'bad' }`, and the wire's `null`
  const schema = {
    parse: (value: unknown) => {
      if (value == null || (value as { theme?: string }).theme === 'bad') {
        throw new Error('bad theme')
      }
      return value as JSONType
    }
  }
  // Flips `match` to false (and back, if `reseed`) on the first validation error
  const dropOnError = ({ reseed = false } = {}) => {
    let reseeded: Promise<string> | undefined
    const listener = () => {
      if (reseeded) return
      matches = false
      sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
      if (reseed) {
        matches = true
        sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
        // The fresh entry's own load finds a valid value
        writeAsDeviceB('prefs', { theme: 'dark' })
      }
      reseeded = reseed ? whenSettled('prefs') : Promise.resolve('dropped')
    }
    sbp('okTurtles.events/on', CHELONIA_KV_VALIDATION_ERROR, listener)
    return {
      settled: () => reseeded,
      off: () => sbp('okTurtles.events/off', CHELONIA_KV_VALIDATION_ERROR, listener)
    }
  }
  const start = async () => {
    matches = true
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {}, match: () => matches, schema })
    connectPubsub()
    await activate()
    assert.strictEqual(mirror('prefs')?.status, 'loaded')
    writeAsDeviceB('prefs', { theme: 'bad' })
  }

  it('on a load: the load still rejects with the validation error', async () => {
    await start()
    const { off } = dropOnError()
    try {
      await assert.rejects(sync('prefs'), { name: 'ChelErrorKvValidation' })
    } finally { off() }
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })

  it('on a pubsub frame', async () => {
    await start()
    const { off } = dropOnError()
    try {
      deliverFrame('prefs')
      await drainLanes()
    } finally { off() }
    assert.deepStrictEqual(errors(), [])
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })

  for (const what of ['a load', 'a pubsub frame']) {
    it(`and re-seeds it, on ${what}: the fresh entry settles with its own load`, async () => {
      await start()
      const { settled, off } = dropOnError({ reseed: true })
      try {
        if (what === 'a load') {
          await assert.rejects(sync('prefs'), { name: 'ChelErrorKvValidation' })
        } else deliverFrame('prefs')
        await until(() => settled(), 'the validation error')
        assert.strictEqual(await settled(), 'loaded')
      } finally { off() }
      assert.deepStrictEqual(mirror('prefs')?.value, { theme: 'dark' })
    })
  }

  it('on a re-validation by defineSlot', async () => {
    await start()
    const { off } = dropOnError()
    try {
      // The loaded value fails the new schema
      const noLight = {
        parse: (value: unknown) => schema.parse(
          (value as { theme?: string } | null)?.theme === 'light' ? null : value
        )
      }
      defineSlot({ key: 'prefs', defaultValue: {}, match: () => matches, schema: noLight })
      await drainLanes()
    } finally { off() }
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
  })
})
