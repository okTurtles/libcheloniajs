import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, connectPubsub, defineSlot, holdResetAfterAbort, holdSyncs, installKvHarness,
  subscriptionSucceeded, syncs
} from './kv-height-harness.js'

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
})
