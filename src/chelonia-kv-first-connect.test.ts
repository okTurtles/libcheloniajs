// The first `chelonia/connect` of an app that synced contracts before it
// (e.g. from saved state) must load their KV slots once: the new client
// lost nothing, also while its handshake is slow. This needs a file of its
// own: `chelonia/_init` keeps the pubsub client of an earlier
// `chelonia/connect`, so a connection in a second test would replace it.
//
// The relay and the pubsub server are the fakes from `./pubsub/test-harness.ts`.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  actionMessage, captureConsole, createFakePubsubServer, createFakeRelay, createTestContract,
  RELAY_URL, sleep, storeSecretKeys, subscribed, waitFor
} from './pubsub/test-harness.js'

const KEY = 'marker'
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient | undefined

before(() => {
  server.install()
  logs = captureConsole()
})

after(() => {
  // Destroy the client first, so that it doesn't reconnect
  pubsub?.destroy()
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

// The number of `GET /kv` requests for the slot
const slotLoads = (contractID: string) => relay.requests
  .filter(({ method, path }) => method === 'GET' && path === `/kv/${contractID}/${KEY}`).length

describe('KV slots on the first chelonia/connect, with contracts synced before it', () => {
  it('load once, also with a publish and a second chelonia/connect before it opens', async () => {
    sbp('chelonia/_init')
    await sbp('chelonia/configure', {
      connectionURL: RELAY_URL,
      fetch: relay.fetch,
      connectionOptions: { minReconnectionDelay: 20 },
      skipActionProcessing: true,
      pubsubReconcileInterval: 0
    })
    sbp('chelonia/kv/defineSlot', {
      contractType: 'test/contract',
      key: KEY,
      encryptionKeyName: null,
      signingKeyName: '#csk'
    })
    const contract = createTestContract()
    const { contractID } = contract
    assert.equal(relay.append(contract.first), 200)
    storeSecretKeys(contract)
    await sbp('chelonia/contract/retain', contractID)
    await sbp('chelonia/contract/wait', contractID)

    server.stallNewConnections()
    pubsub = sbp('chelonia/connect')
    assert.ok(await waitFor(() => slotLoads(contractID) > 0), 'slot not loaded')
    await sbp('chelonia/kv/_waitInFlight')
    const logged = logs.fromNow()
    // A publish needs no sync: the new client is subscribing to the contract
    await sbp('chelonia/private/out/publishEvent', actionMessage(contract, { text: 'hello' }))
    await sbp('chelonia/contract/wait', contractID)
    // The first client never opened, so it missed no KV pushes
    pubsub = sbp('chelonia/connect')
    server.pass()
    assert.ok(await waitFor(subscribed(pubsub!, [contractID])), 'not subscribed')
    await sbp('chelonia/contract/wait', contractID)
    await sleep(150)
    await sbp('chelonia/kv/_waitInFlight')
    assert.deepEqual(logged.grep(/pubsub reconcile/), [])
    assert.equal(slotLoads(contractID), 1)
  })
})
