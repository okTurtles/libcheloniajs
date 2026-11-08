// Publishing must not depend on pubsub delivering the published event back
// (okTurtles/group-income#3176). When the pubsub client has lost a
// contract (or its socket is half-open) and another participant has posted
// in the meantime, `publishEvent` must sync on the first 409 (not only on the
// second), and the published event must be processed (`onprocessed`) even
// though pubsub never delivers it.
//
// The relay is the fake from `./pubsub/test-harness.ts` with real `SPMessage`
// chains (OP_CONTRACT plus signed actions; `skipActionProcessing` means that
// no contract code is needed), wired to the fake pubsub server, which
// broadcasts every appended event to the subscribers of its contract.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { SPMessage } from './SPMessage.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  actionMessage, captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay,
  handledEvents, localHeight, retainedContract, sleep, staleContract, waitFor
} from './pubsub/test-harness.js'
import type { TestContract } from './pubsub/test-harness.js'

const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient
const handled = handledEvents()

before(() => {
  server.install()
  logs = captureConsole()
})

after(() => {
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

// A fresh Chelonia, connected to the fake server, for the current `describe`
function setUp (config: Record<string, unknown> = {}) {
  before(async () => {
    sbp('chelonia/_init')
    pubsub = await connectChelonia(relay, {
      skipActionProcessing: true,
      // No periodic reconcile: a lost subscription stays lost until publishing
      // heals it or the next `chelonia/pubsub/update` (e.g. the next retain)
      pubsubReconcileInterval: 0,
      ...config
    })
  })
  after(() => {
    // Destroy the client first, so that it doesn't reconnect
    pubsub?.destroy()
    server.reset()
    relay.reset()
  })
}

// Publishes an action like a Group Income chat message
// (`chelonia/out/actionEncrypted` -> `publishEvent`)
async function publish (contract: TestContract, text: string) {
  const logged = logs.fromNow()
  const from = relay.requests.length
  const start = performance.now()
  let processedAt: number | undefined
  let requests = 0
  const sent: SPMessage = await sbp(
    'chelonia/private/out/publishEvent', actionMessage(contract, { text }), {}, {
      beforeRequest: () => { requests++ },
      onprocessed: () => { processedAt = performance.now() - start }
    }
  )
  return {
    from,
    hash: sent.hash(),
    height: sent.height(),
    requests,
    conflicts: logged.grep(/\[chelonia\] publish attempt \d+ of \d+ failed/).length,
    // ms from the start of `publish` until `onprocessed`
    processedAt: () => processedAt,
    logged
  }
}

// The statuses of the `POST /event` requests from position `from`
const postsOf = (from: number) => relay.requests.slice(from)
  .filter(({ method, path }) => method === 'POST' && path === '/event')
  .map(({ status }) => status)

describe('publishing to a contract whose pubsub subscription was lost', () => {
  setUp()
  let contractID: string
  let published: Awaited<ReturnType<typeof publish>>
  let reply: SPMessage
  let processed: boolean

  before(async () => {
    const stale = await staleContract(relay, pubsub)
    contractID = stale.contract.contractID
    reply = stale.reply
    published = await publish(stale.contract, 'own message')
    processed = !!(await waitFor(
      () => published.processedAt() !== undefined && handled.has(published.hash),
      { timeout: 3000 }
    ))
  })

  it('syncs on the first 409 instead of the second', () => {
    assert.equal(
      published.conflicts, 1, `${published.conflicts} x 409 in ${published.requests} requests`
    )
    assert.equal(published.requests, 2)
  })

  it('processes the published event (onprocessed fires) although pubsub will not deliver it', () => {
    assert.ok(processed,
      `not processed 3 s after publishing; local height ${localHeight(contractID)}, published at height ${published.height}`)
    assert.ok(localHeight(contractID)! >= published.height)
  })

  it('has also processed the event that it missed', () => {
    assert.ok(handled.has(reply.hash()))
  })

  it('re-subscribes the contract in the pubsub client', async () => {
    assert.ok(await waitFor(() => pubsub.subscriptionSet.has(contractID)), 'not re-subscribed')
  })

  it('explains in the log why it synced', () => {
    assert.equal(published.logged.grep(/Published .* but did not receive it/).length, 1)
  })
})

describe('publishing while the socket is half-open (subscribed, but nothing arrives)', () => {
  const TIMEOUT = 300
  setUp({ publishReceiptTimeout: TIMEOUT })
  let contractID: string
  let published: Awaited<ReturnType<typeof publish>>

  before(async () => {
    const contract = await retainedContract(relay, pubsub)
    contractID = contract.contractID
    // The WebSocket is dead (the server dropped it while we slept) but still
    // OPEN; HTTP works
    server.blackhole()
    server.pass()
    published = await publish(contract, 'own message on a dead socket')
    await waitFor(() => published.processedAt() !== undefined, { timeout: TIMEOUT + 2000 })
  })

  it('processes the published event within a few seconds', () => {
    assert.ok(
      published.processedAt() !== undefined, `not processed ${TIMEOUT + 2000} ms after publishing`
    )
    assert.ok(handled.has(published.hash))
    assert.equal(published.conflicts, 0)
  })

  it('waits for publishReceiptTimeout before syncing', () => {
    assert.ok(
      published.processedAt()! >= TIMEOUT - 5,
      `processed ${published.processedAt()} ms after publishing`
    )
    assert.equal(relay.syncsOf(contractID, published.from), 1)
  })
})

describe('publishing on a healthy connection', () => {
  setUp({ publishReceiptTimeout: 200 })

  it('does not sync when pubsub delivers the published event', async () => {
    const contract = await retainedContract(relay, pubsub)
    const published = await publish(contract, 'hello')
    assert.ok(await waitFor(() => published.processedAt() !== undefined), 'processed')
    await sleep(400)
    assert.equal(relay.syncsOf(contract.contractID, published.from), 0)
    assert.equal(published.logged.grep(/did not receive/).length, 0)
    assert.equal(published.conflicts, 0)
  })
})

describe('publishReceiptTimeout: 0', () => {
  setUp({ publishReceiptTimeout: 0 })

  it('disables the timed check for a subscribed contract', async (t) => {
    const contract = await retainedContract(relay, pubsub)
    server.blackhole()
    server.pass()
    // Treating 0 as unset would arm the check for the default 5000 ms, which
    // the sleep below can't wait for
    const timers = t.mock.method(globalThis, 'setTimeout')
    const published = await publish(contract, 'not checked')
    timers.mock.restore()
    const delays = timers.mock.calls.map(({ arguments: args }) => args[1])
    assert.ok(!delays.includes(5000), `timers armed while publishing: ${delays}`)
    await sleep(500)
    assert.equal(published.processedAt(), undefined)
    assert.equal(relay.syncsOf(contract.contractID, published.from), 0)
  })
})

describe('publishReceiptTimeout above the longest timer delay', () => {
  setUp({ publishReceiptTimeout: 2 ** 31 })

  it('does not check before that delay', async () => {
    const contract = await retainedContract(relay, pubsub)
    server.blackhole()
    server.pass()
    const published = await publish(contract, 'checked much later')
    await sleep(300)
    assert.equal(relay.syncsOf(contract.contractID, published.from), 0)
  })
})

describe('chelonia/reset after publishing', () => {
  setUp({ publishReceiptTimeout: 200 })

  it('cancels the pending check', async () => {
    const contract = await retainedContract(relay, pubsub)
    server.blackhole()
    server.pass()
    const published = await publish(contract, 'before the reset')
    await sbp('chelonia/reset')
    const from = relay.requests.length
    await sleep(400)
    assert.equal(relay.syncsOf(contract.contractID, from), 0)
    assert.equal(published.logged.grep(/did not receive/).length, 0)
  })
})

describe('chelonia/reset after publishing, then retaining the contract again', () => {
  setUp({ publishReceiptTimeout: 200 })

  it('cancels the pending check of the previous session', async () => {
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    server.blackhole()
    server.pass()
    const published = await publish(contract, 'before the reset')
    await sbp('chelonia/reset')
    // The new session gets the contract as it was before the publish (e.g.,
    // restored from an older saved state), so it is behind the event
    relay.chains.set(contractID, relay.chains.get(contractID)!.slice(0, -1))
    await sbp('chelonia/contract/retain', contractID)
    assert.equal(localHeight(contractID), published.height - 1, 'precondition: behind the event')
    const from = relay.requests.length
    await sleep(400)
    assert.equal(relay.syncsOf(contractID, from), 0)
    assert.equal(published.logged.grep(/did not receive/).length, 0)
  })
})

describe('a 409 for a contract that is released or deleted in the meantime', () => {
  setUp()

  // The relay holds the first POST /event while `during` runs, then answers 409
  async function publishWithConflict (contract: TestContract, during: () => Promise<unknown>) {
    const from = relay.requests.length
    let first = true
    relay.onRequest = ({ method, path }) => {
      if (!first || method !== 'POST' || path !== '/event') return
      first = false
      return during().then(() => new Response('', { status: 409 }))
    }
    try {
      const sent = await sbp(
        'chelonia/private/out/publishEvent', actionMessage(contract, { text: 'conflict' })
      )
      return { sent, from }
    } finally {
      relay.onRequest = undefined
    }
  }

  it('stops without syncing (which would subscribe to it again) once it is released', async () => {
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    const { sent, from } = await publishWithConflict(
      contract, () => sbp('chelonia/contract/release', contractID)
    )
    assert.equal(sent, undefined)
    assert.deepEqual(postsOf(from), [409])
    assert.equal(relay.syncsOf(contractID, from), 0)
    await sleep(50)
    assert.ok(!pubsub.subscriptionSet.has(contractID), 'subscribed again')
  })

  it('stops without an error once it is deleted', async () => {
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    const { sent, from } = await publishWithConflict(
      contract, () => sbp('chelonia/contract/remove', contractID, { permanent: true })
    )
    assert.equal(sent, undefined)
    assert.deepEqual(postsOf(from), [409])
  })
})

describe('a 409 whose sync fails', () => {
  setUp()

  it('logs the error and tries again (the next 409 syncs again)', async () => {
    const { contract } = await staleContract(relay, pubsub)
    const { contractID } = contract
    // Only the first sync fails, as with a short network outage
    let failed = false
    relay.onRequest = ({ path }) => {
      if (failed || path !== `/latestHEADinfo/${contractID}`) return
      failed = true
      return new Response('', { status: 500 })
    }
    try {
      const published = await publish(contract, 'after a failed sync')
      assert.deepEqual(postsOf(published.from), [409, 409, 200])
      assert.equal(published.logged.grep(
        new RegExp(`Error syncing ${contractID} after a publish conflict; retrying anyway`)
      ).length, 1)
    } finally {
      relay.onRequest = undefined
    }
  })
})
