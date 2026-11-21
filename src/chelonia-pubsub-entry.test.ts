// Nothing waits for the processing of an event that the pubsub server pushes
// (ENTRY), so Chelonia must log its failures itself: an unhandled rejection
// can stop a Node process. An event that a filter keeps from being handled at
// all is no failure, though.
//
// The pubsub server is the in-process fake from `./pubsub/test-harness.ts`,
// and the contract is seeded so that syncing it takes the "already
// synchronized" path. Its state isn't, so handling any event for it fails.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { PUBSUB_ERROR } from './pubsub/index.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, fakeEntryData,
  sleep, subscribed, waitFor
} from './pubsub/test-harness.js'
import type { ChelRootState } from './types.js'

// The queue on which `chelonia/private/queueEvent` is vetoed
let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent', (
  _domain: string, _selector: string, [queueName]: unknown[]
) => queueName !== vetoedQueue)
// Whether `chelonia/private/in/enqueueHandleEvent` itself is vetoed, and the
// contract IDs of its calls
let vetoHandling = false
const handlingCalls: string[] = []
sbp('sbp/filters/selector/add', 'chelonia/private/in/enqueueHandleEvent', (
  _domain: string, _selector: string, [contractID]: unknown[]
) => {
  handlingCalls.push(contractID as string)
  return !vetoHandling
})

const server = createFakePubsubServer()
const relay = createFakeRelay()
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
// What the pubsub client reported with PUBSUB_ERROR (e.g., a message
// handler that threw)
const pubsubErrors: unknown[] = []
sbp('okTurtles.events/on', PUBSUB_ERROR, (_client: PubSubClient, error: unknown) => {
  pubsubErrors.push(error)
})

before(() => {
  server.install()
  logs = captureConsole()
})

beforeEach(() => {
  sbp('chelonia/_init')
  unhandled.length = 0
  pubsubErrors.length = 0
  handlingCalls.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  vetoedQueue = undefined
  vetoHandling = false
  // Destroy the client first, so that it doesn't reconnect
  pubsub?.destroy()
  server.reset()
  relay.reset()
  process.off('unhandledRejection', onUnhandled)
})

after(() => {
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

// Chelonia wants `contractID` and the pubsub client subscribes to it
async function want (contractID: string) {
  const rootState = sbp('chelonia/private/state') as ChelRootState
  const head = { HEAD: `head-of-${contractID}`, height: 1 }
  rootState.contracts[contractID] = { ...head, previousKeyOp: '', type: 'test-contract' }
  relay.contracts.set(contractID, head)
  await sbp('chelonia/private/in/sync', contractID)
  assert.ok(await waitFor(subscribed(pubsub, [contractID])), `not subscribed to ${contractID}`)
}

// The server pushes an event for `contractID`; resolves once Chelonia has
// logged the failure or once it's unhandled
async function pushFailingEntry (contractID: string, error: RegExp) {
  const log = new RegExp(`Error processing entry event for ${contractID} .*${error.source}`)
  const since = logs.fromNow()
  server.entry(contractID, fakeEntryData(contractID))
  await waitFor(() => unhandled.length > 0 || since.grep(log).length > 0)
  assert.deepEqual(unhandled, [])
  assert.equal(since.grep(log).length, 1)
}

describe('ENTRY notifications', () => {
  it('logs an event whose queueing a filter vetoes', async () => {
    pubsub = await connectChelonia(relay)
    await want('contract-E1')
    vetoedQueue = 'contract-E1'
    await pushFailingEntry('contract-E1', /queueing on contract-E1 was vetoed/)
  })

  it('logs an event that handleEvent fails to process', async () => {
    pubsub = await connectChelonia(relay)
    await want('contract-E2')
    await pushFailingEntry('contract-E2', /ChelErrorUnrecoverable/)
  })

  it('drops an event quietly when a filter vetoes its handling', async () => {
    pubsub = await connectChelonia(relay)
    await want('contract-E3')
    vetoHandling = true
    const since = logs.fromNow()
    server.entry('contract-E3', fakeEntryData('contract-E3'))
    assert.ok(await waitFor(() => handlingCalls.includes('contract-E3')), 'event not received')
    await sleep(20)
    assert.deepEqual(pubsubErrors, [])
    assert.deepEqual(unhandled, [])
    assert.deepEqual(since.grep(/Error processing entry event/), [])
  })
})
