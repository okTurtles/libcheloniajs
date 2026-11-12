// A contract that the pubsub client lost has also missed its KV pushes. When
// Chelonia subscribes the client to it again without a reconnection (the
// periodic reconcile, publishing or `kv/set`), the slots that a reconnection
// reloads (`refreshOnReconnect`, the default) must reload too, after the sync
// that follows the new subscription (okTurtles/group-income#3176).
//
// Another device's write is a raw `chelonia/kv/set`, which doesn't touch the
// local mirror, and the fake relay pushes no KV notifications, as if they
// were missed. The relay and the pubsub server are the fakes from
// `./pubsub/test-harness.ts`.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  actionMessage, captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay,
  loseInPubsub, retainedContract, sleep, subscribed, waitFor
} from './pubsub/test-harness.js'
import type { TestContract } from './pubsub/test-harness.js'
import type { JSONType } from './types.js'

const KEY = 'marker'
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient

before(() => {
  server.install()
  logs = captureConsole()
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

async function setUp (pubsubReconcileInterval: number) {
  sbp('chelonia/_init')
  pubsub = await connectChelonia(relay, { skipActionProcessing: true, pubsubReconcileInterval })
  sbp('chelonia/kv/defineSlot', {
    contractType: 'test/contract',
    key: KEY,
    encryptionKeyName: null,
    signingKeyName: '#csk'
  })
}

// The number of `GET /kv` requests for the slot from position `from`
const slotLoads = (contractID: string, from = 0) => relay.requests.slice(from)
  .filter(({ method, path }) => method === 'GET' && path === `/kv/${contractID}/${KEY}`).length

const mirror = (contractID: string) => sbp('chelonia/kv/read', contractID, KEY)

// A retained contract whose slot has been loaded, then lost by the pubsub
// client; another device then writes `data` to the slot
async function lostWithNewValue (data: JSONType): Promise<TestContract> {
  const contract = await retainedContract(relay, pubsub)
  const { contractID } = contract
  assert.ok(await waitFor(() => slotLoads(contractID) > 0), 'slot not loaded')
  await sbp('chelonia/kv/_waitInFlight')
  loseInPubsub(pubsub, contractID)
  await sbp('chelonia/kv/set', contractID, KEY, data, { signingKeyId: contract.CSKid })
  return contract
}

// Whether the slot of `contractID` reloads with `data` once the pubsub client
// is subscribed to the contract again
async function reloads (contractID: string, data: JSONType, from: number) {
  assert.ok(await waitFor(subscribed(pubsub, [contractID]), { timeout: 2000 }), 'not re-subscribed')
  const reloaded = () => slotLoads(contractID, from) > 0 &&
    JSON.stringify(mirror(contractID)) === JSON.stringify(data)
  return !!(await waitFor(reloaded, { timeout: 1000 }))
}

describe('KV slots of a contract that the pubsub client lost', () => {
  it('reload when the periodic reconcile subscribes to it again', async () => {
    await setUp(200)
    const data = { n: 1 }
    const { contractID } = await lostWithNewValue(data)
    const from = relay.requests.length
    const socket = pubsub.socket
    assert.ok(await reloads(contractID, data, from), 'the slot did not reload')
    assert.equal(pubsub.socket, socket, 'reconnected')
  })

  it('reload when publishing subscribes to it again', async () => {
    await setUp(0)
    const data = { n: 2 }
    const contract = await lostWithNewValue(data)
    const from = relay.requests.length
    await sbp('chelonia/private/out/publishEvent', actionMessage(contract, { text: 'hello' }))
    assert.ok(await reloads(contract.contractID, data, from), 'the slot did not reload')
  })

  it('reload when kv/set syncs after a 409 and subscribes to it again', async (t) => {
    await setUp(0)
    const data = { n: 3 }
    const contract = await lostWithNewValue(data)
    const { contractID } = contract
    // Another participant posted meanwhile, so the next write gets a 409
    relay.postAction(contract, { text: 'missed' })
    // No back-off before the sync
    t.mock.method(Math, 'random', () => 0)
    const from = relay.requests.length
    await sbp('chelonia/kv/set', contractID, 'other', { x: 1 }, {
      signingKeyId: contract.CSKid,
      onconflict: async ({ etag }: { etag?: string | null }) => [{ x: 1 }, etag ?? undefined]
    })
    assert.ok(relay.requests.slice(from).some(({ status }) => status === 409), 'precondition: 409')
    assert.ok(await reloads(contractID, data, from), 'the slot did not reload')
  })
})

describe('KV slots when chelonia/connect replaces the pubsub client', () => {
  it('reload once (the old client may have missed KV pushes)', async () => {
    await setUp(0)
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    assert.ok(await waitFor(() => slotLoads(contractID) > 0), 'slot not loaded')
    await sbp('chelonia/kv/_waitInFlight')
    const from = relay.requests.length
    // A second `chelonia/connect` replaces the client
    pubsub = sbp('chelonia/connect')
    assert.ok(await waitFor(subscribed(pubsub, [contractID])), 'not subscribed')
    await sbp('chelonia/contract/wait', contractID)
    await sbp('chelonia/kv/_waitInFlight')
    assert.equal(slotLoads(contractID, from), 1)
  })

  it('reload once when publishing before the new client opens (nothing is missing)', async () => {
    await setUp(0)
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    assert.ok(await waitFor(() => slotLoads(contractID) > 0), 'slot not loaded')
    await sbp('chelonia/kv/_waitInFlight')
    const from = relay.requests.length
    server.stallNewConnections()
    pubsub = sbp('chelonia/connect')
    const logged = logs.fromNow()
    await sbp('chelonia/private/out/publishEvent', actionMessage(contract, { text: 'hello' }))
    await sbp('chelonia/contract/wait', contractID)
    assert.deepEqual(logged.grep(/pubsub reconcile/), [])
    server.pass()
    assert.ok(await waitFor(subscribed(pubsub, [contractID])), 'not subscribed')
    assert.ok(await waitFor(() => slotLoads(contractID, from) > 0), 'the slot did not reload')
    await sleep(100)
    await sbp('chelonia/kv/_waitInFlight')
    assert.equal(slotLoads(contractID, from), 1)
  })
})
