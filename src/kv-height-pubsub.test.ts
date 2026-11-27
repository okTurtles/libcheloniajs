import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, CONTRACT_ID, connectPubsub, defineSlot, drainLanes, holdResetAfterAbort, holdSyncs,
  installKvHarness, logs, rootState, setupContract, sleep, subscriptionSucceeded, syncs
} from './kv-height-harness.js'
import { until } from './test-utils.js'

describe('chelonia/reset with the pubsub client connected', () => {
  installKvHarness()

  it('ends although a confirmed subscription starts a sync while it waits after its abort', async () => {
    connectPubsub()
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const ends = await holdResetAfterAbort()
    const before = syncs.count
    const openSyncs = holdSyncs()
    // Queues a contract sync that captures no signal
    subscriptionSucceeded()
    await ends(openSyncs)
    assert.strictEqual(syncs.count, before)
  })

  // Logged by the pubsub client's sync after a confirmed subscription
  const syncFailures = () => logs.entries.filter(({ level, args }) =>
    level === 'warn' && String(args[0]).includes(`Syncing contract ${CONTRACT_ID} failed`))

  it("leaves a dirty contract's state to its callback when a confirmed subscription starts a sync while it waits after its abort", async () => {
    connectPubsub()
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // To be synced again from its start (e.g. it got an older encryption key)
      rootState()[CONTRACT_ID]._volatile = { dirty: true }
      const snapshot = () => JSON.parse(JSON.stringify({
        meta: rootState().contracts[CONTRACT_ID], state: rootState()[CONTRACT_ID]
      }))
      const cached = snapshot()
      let seen: unknown
      const ends = await holdResetAfterAbort(() => { seen = snapshot() })
      // Queues a contract sync that captures no signal
      subscriptionSucceeded()
      await ends(() => {})
      assert.deepStrictEqual(seen, cached)
      await sleep(0)
      assert.deepStrictEqual(unhandled, [])
      assert.strictEqual(syncFailures().length, 1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('lets a confirmed subscription sync the contract before a reset and once it ended', async () => {
    connectPubsub()
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const confirmed = async (label: string) => {
      const before = syncs.count
      subscriptionSucceeded()
      await until(() => syncs.count > before, label)
      await drainLanes()
    }
    await confirmed('the sync before the reset')
    const ends = await holdResetAfterAbort()
    subscriptionSucceeded()
    await ends(() => {})
    setupContract()
    await activate()
    await confirmed('the sync once the reset ended')
    // Only the one during the reset failed
    assert.strictEqual(syncFailures().length, 1)
  })
})
