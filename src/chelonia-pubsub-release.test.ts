// A contract that Chelonia releases while the pubsub client's SUB for it is
// still pending must stay released once the relay answers that SUB: the
// answer's forced sync would otherwise bring the contract back, with no
// references, until `chelonia/reset`. The SUB is pending after a retain and
// after every reconnection, until the new connection's answers arrive.
//
// The relay and the pubsub server are the fakes from `./pubsub/test-harness.ts`,
// with real `SPMessage` chains (`skipActionProcessing`: no contract code).
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { REQUEST_TYPE } from './pubsub/index.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, createTestContract,
  isOpen, keepQueueBusy, localHeight, retainedContract, sleep, storeSecretKeys, subscribed, waitFor
} from './pubsub/test-harness.js'

// One way of the relay, per message
const LATENCY = 150
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient

before(() => {
  server.install()
  logs = captureConsole()
})

beforeEach(async () => {
  sbp('chelonia/_init')
  pubsub = await connectChelonia(relay, { skipActionProcessing: true, pubsubReconcileInterval: 0 })
})

afterEach(() => {
  // Destroy the client first, so that it doesn't reconnect
  pubsub?.destroy()
  server.reset()
  relay.reset()
})

after(() => {
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

// Waits until the client is connected and the SUB of `contractID` is no
// longer pending (answered, or cancelled), then for what its answer starts
async function settle (contractID: string) {
  assert.ok(await waitFor(isOpen(pubsub), { timeout: 5000 }), 'not reconnected')
  assert.ok(await waitFor(
    () => !pubsub.pendingOperations.tHas(REQUEST_TYPE.SUB, contractID), { timeout: 5000 }
  ), 'SUB still pending')
  await sleep(LATENCY + 250)
  await sbp('chelonia/contract/wait', contractID)
}

// Chelonia neither has the contract nor syncs it, and the pubsub client
// doesn't stay subscribed to it
async function assertReleased (contractID: string, from: number) {
  assert.equal(relay.syncsOf(contractID, from), 0, 'synced again')
  assert.equal(localHeight(contractID), undefined, 'the released contract is back')
  assert.ok(
    await waitFor(() => !pubsub.subscriptionSet.has(contractID)), 'still subscribed in pubsub'
  )
}

describe('a contract released while its SUB is pending', () => {
  it('stays released when the release comes during a reconnection', async () => {
    const { contractID } = await retainedContract(relay, pubsub)
    server.slow(LATENCY)
    server.killClients() // re-arms the SUB as pending
    assert.ok(pubsub.pendingOperations.tHas(REQUEST_TYPE.SUB, contractID), 'precondition')
    const from = relay.requests.length
    await sbp('chelonia/contract/release', contractID)
    await settle(contractID)
    await assertReleased(contractID, from)
  })

  it('stays released when the release comes right after the retain', async () => {
    const contract = createTestContract()
    const { contractID } = contract
    assert.equal(relay.append(contract.first), 200)
    storeSecretKeys(contract)
    server.slow(LATENCY)
    await sbp('chelonia/contract/retain', contractID)
    assert.ok(pubsub.pendingOperations.tHas(REQUEST_TYPE.SUB, contractID), 'precondition')
    const from = relay.requests.length
    await sbp('chelonia/contract/release', contractID)
    await settle(contractID)
    await assertReleased(contractID, from)
  })

  it('stays released when its removal waits in a busy queue until the SUB is answered', async () => {
    const { contractID } = await retainedContract(relay, pubsub)
    server.slow(LATENCY)
    server.killClients()
    // Like a slow event handler: the removal waits in the contract's queue
    keepQueueBusy(contractID, 1500)
    const from = relay.requests.length
    const released = sbp('chelonia/contract/release', contractID)
    assert.ok(await waitFor(subscribed(pubsub, [contractID]), { timeout: 3000 }), 'not subscribed')
    assert.notEqual(localHeight(contractID), undefined, 'precondition: still there at the answer')
    await released
    await settle(contractID)
    await assertReleased(contractID, from)
  })

  it('is not carried into the next session by chelonia/reset', async () => {
    const { contractID } = await retainedContract(relay, pubsub)
    server.slow(LATENCY)
    server.killClients()
    const from = relay.requests.length
    await sbp('chelonia/reset')
    await settle(contractID)
    await assertReleased(contractID, from)
  })
})
