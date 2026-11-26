import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, CONTRACT_ID, defineSlot, filterCalls, gateLane, holdSyncs, installKvHarness, mirror,
  server, serverValue, syncs, update, writeAsDeviceB
} from './kv-height-harness.js'
import { until, within } from './test-utils.js'

describe('KV slot writes against the server', () => {
  installKvHarness()

  it('loads a value another device wrote and writes over it under its etag', async () => {
    const etag = writeAsDeviceB('prefs', { theme: 'dark' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'prefs'), { theme: 'dark' })
    assert.strictEqual(mirror('prefs')?.etag, etag)

    await update('prefs', (prefs) => ({ ...(prefs as object), lang: 'en' }))
    assert.deepStrictEqual(
      server.posts().map(({ ifMatch, status, height }) => ({ ifMatch, status, height })),
      [{ ifMatch: etag, status: 204, height: String(server.height) }]
    )
    assert.deepStrictEqual(serverValue('prefs'), { theme: 'dark', lang: 'en' })
    assert.strictEqual(mirror('prefs')?.etag, server.etagOf('prefs'))
  })

  it('merges a value another device wrote just before the write (412)', async () => {
    writeAsDeviceB('names', ['a'])
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    server.onPost = () => {
      server.onPost = undefined
      writeAsDeviceB('names', ['a', 'b'])
    }

    const merged = await update('names', (names) => [...(names as string[]), 'c'])
    assert.deepStrictEqual(merged, ['a', 'b', 'c'])
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [412, 204])
    assert.deepStrictEqual(serverValue('names'), ['a', 'b', 'c'])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'names'), ['a', 'b', 'c'])
  })
})

describe('chelonia/kv/withHeightRecovery', () => {
  installKvHarness()

  // Queues `start()`'s sync behind a contract sync that hangs (a dead link), in
  // the window before `chelonia/reset` aborts: the reset's second
  // `chelonia/contract/wait` holds its public noop meanwhile. The abort ends the
  // hung sync, and the queued one must not start with the new controller.
  const queueBeforeResetAbort = async (start: () => Promise<unknown>, what: string) => {
    await activate()
    holdSyncs()
    const before = syncs.count
    let calls = 0
    let openPublic!: () => void
    // Each `chelonia/contract/wait` calls this before it queues its noops
    const draining = new Promise<void>((resolve) => {
      const lift = filterCalls('chelonia/contract/wait', () => {
        if (++calls !== 2) return
        lift()
        openPublic = gateLane('public')
        resolve()
      })
    })
    const reset = sbp('chelonia/reset') as Promise<void>
    await within(draining, "the reset's last drain before its abort")
    const queued = () => sbp('okTurtles.eventQueue/queuedInvocations', CONTRACT_ID).length
    await until(() => queued() === 0, 'its internal noop')
    const other = (sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }) as Promise<void>)
      .catch(() => {})
    await until(() => syncs.count === before + 1, 'the other sync')
    const work = start()
    await until(() => queued() === 2, `${what} to be queued`)
    openPublic()
    await assert.rejects(within(work, what), { name: 'AbortError' })
    await within(reset, 'the reset')
    await within(other, 'the other sync')
    assert.strictEqual(syncs.count, before + 1)
  }

  // Not specific to KV, but this harness can hold the lanes
  it('skips a contract sync that a reset aborted while it was queued', () =>
    queueBeforeResetAbort(
      () => sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the contract sync'
    ))
})
