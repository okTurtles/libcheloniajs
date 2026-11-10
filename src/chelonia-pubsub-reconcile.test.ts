// Chelonia must keep its pubsub client subscribed to every contract that it
// wants (okTurtles/group-income#3176), whatever made the client lose
// one (an unanswered or rejected SUB, a bug, ...): it reconciles the two sets
// after every (re)connection and every `pubsubReconcileInterval` ms, and
// `chelonia/pubsub/status` reports any mismatch.
//
// The loss is produced with `pubsub.unsub(id)` (or a SUB ERROR) while
// Chelonia still wants the contract. The pubsub server is the in-process fake
// from `./pubsub/test-harness.ts` and contracts are seeded so that syncing
// them takes the "already synchronized" path.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { createClient, PUBSUB_RECONNECTION_FAILED, REQUEST_TYPE } from './pubsub/index.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, fakeEntryData, isOpen,
  onNextOpen, RELAY_URL, sleep, subscribed, waitFor
} from './pubsub/test-harness.js'
import type { ChelPubSubStatus, ChelRootState } from './types.js'

const server = createFakePubsubServer()
const relay = createFakeRelay()
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient
// Contract IDs of the ENTRY notifications that Chelonia got (and dropped)
const received: string[] = []
// Number of `chelonia/pubsub/update` calls
let updates = 0

sbp('sbp/filters/selector/add', 'chelonia/private/in/enqueueHandleEvent', (
  _domain: string, _selector: string, data: unknown[]
) => {
  received.push(data[0] as string)
  // The fake events can't be processed
  return false
})
sbp('sbp/filters/selector/add', 'chelonia/pubsub/update', () => { updates++ })

before(() => {
  server.install()
  logs = captureConsole()
})

beforeEach(() => {
  sbp('chelonia/_init')
  received.length = 0
  updates = 0
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

async function connect (pubsubReconcileInterval: number) {
  pubsub = await connectChelonia(relay, { pubsubReconcileInterval })
}

// Chelonia starts wanting `contractID` (the sync finds it up to date and
// adds it to Chelonia's subscription set)
async function seed (contractID: string) {
  const rootState = sbp('chelonia/private/state') as ChelRootState
  const head = { HEAD: `head-of-${contractID}`, height: 1 }
  rootState.contracts[contractID] = { ...head, previousKeyOp: '', type: 'test-contract' }
  relay.contracts.set(contractID, head)
  await sbp('chelonia/private/in/sync', contractID)
}

// Chelonia wants `contractID` and the pubsub client subscribes to it
async function want (contractID: string) {
  await seed(contractID)
  assert.ok(await waitFor(subscribed(pubsub, [contractID])), `subscribed to ${contractID}`)
}

// The pubsub client loses `contractID` while Chelonia still wants it.
// Resolves with the time at which the UNSUB was sent.
async function loseInPubsub (contractID: string): Promise<number> {
  const since = Date.now()
  pubsub.unsub(contractID)
  assert.ok(
    await waitFor(() =>
      server.framesOf(REQUEST_TYPE.UNSUB, contractID, since).length > 0 &&
      !pubsub.pendingOperations.tHas(REQUEST_TYPE.UNSUB, contractID)
    ),
    'UNSUB acknowledged'
  )
  return since
}

// Whether an event for `contractID` gets through to Chelonia
async function eventIsReceived (contractID: string, timeout = 1000) {
  const count = received.filter((id) => id === contractID).length
  server.entry(contractID, fakeEntryData(contractID))
  return !!(await waitFor(
    () => received.filter((id) => id === contractID).length > count,
    { timeout }
  ))
}

const subsOnConnection = (contractID: string) => server.lastConnection!.frames.filter(
  ({ msg }) => msg.type === REQUEST_TYPE.SUB && msg.channelID === contractID
).length

const status = () => sbp('chelonia/pubsub/status') as ChelPubSubStatus

describe('chelonia/pubsub/status', () => {
  // Must run before the first `chelonia/connect` of this file
  it('reports "closed" and every wanted contract as missing without a pubsub client', async () => {
    await sbp('chelonia/configure', { connectionURL: RELAY_URL, fetch: relay.fetch })
    await seed('contract-S0')
    assert.deepEqual(status(), {
      state: 'closed',
      since: null,
      wanted: 1,
      missing: ['contract-S0'],
      pending: [],
      oldestPendingSince: null
    })
  })

  it('reports a healthy connection, and a lost contract as missing until the reconnect', async () => {
    await connect(0)
    await want('contract-S1')
    await want('contract-S2')
    const healthy = status()
    assert.equal(healthy.state, 'open')
    assert.equal(healthy.since, pubsub.stateSince)
    assert.equal(healthy.wanted, 2)
    assert.deepEqual(healthy.missing, [])
    assert.deepEqual(healthy.pending, [])
    assert.equal(healthy.oldestPendingSince, null)
    // Plain data
    assert.deepEqual(JSON.parse(JSON.stringify(healthy)), healthy)

    await loseInPubsub('contract-S1')
    const lost = status()
    assert.equal(lost.state, 'open')
    assert.deepEqual(lost.missing, ['contract-S1'], `status: ${JSON.stringify(lost)}`)
    assert.deepEqual(lost.pending, [])

    const reopened = onNextOpen(pubsub)
    server.killClients()
    await reopened
    assert.ok(await waitFor(subscribed(pubsub, ['contract-S1', 'contract-S2'])), 're-subscribed')
    const healed = status()
    assert.equal(healed.state, 'open')
    assert.equal(healed.wanted, 2)
    assert.deepEqual(healed.missing, [])
    assert.deepEqual(healed.pending, [])
  })

  it('lists the contracts whose SUB awaits a response or a connection as pending', async () => {
    server.onRequest = (_conn, msg) => (
      msg.type === REQUEST_TYPE.SUB && msg.channelID === 'contract-S4' ? 'ignore' : undefined
    )
    await connect(0)
    await want('contract-S3')
    const t0 = Date.now()
    await seed('contract-S4')
    assert.ok(
      await waitFor(() => server.framesOf(REQUEST_TYPE.SUB, 'contract-S4').length > 0),
      'SUB sent'
    )
    let current = status()
    assert.equal(current.state, 'open')
    assert.equal(current.wanted, 2)
    assert.deepEqual(current.pending, ['contract-S4'])
    assert.deepEqual(current.missing, [])
    assert.ok(
      current.oldestPendingSince !== null && current.oldestPendingSince >= t0,
      `oldestPendingSince: ${current.oldestPendingSince} (sent after ${t0})`
    )

    // While reconnecting, every wanted contract is pending (none is missing)
    server.stallNewConnections()
    server.killClients()
    current = status()
    assert.equal(current.state, 'reconnecting')
    assert.deepEqual([...current.pending].sort(), ['contract-S3', 'contract-S4'])
    assert.deepEqual(current.missing, [])
    assert.equal(current.oldestPendingSince, null)
  })

  it('leaves the pending SUBs of channels that Chelonia does not want out of oldestPendingSince', async () => {
    server.onRequest = (_conn, msg) => (
      msg.type === REQUEST_TYPE.SUB && msg.channelID === 'app-channel' ? 'ignore' : undefined
    )
    await connect(0)
    await want('contract-S5')
    pubsub.sub('app-channel')
    assert.ok(
      await waitFor(() => server.framesOf(REQUEST_TYPE.SUB, 'app-channel').length > 0),
      'SUB sent'
    )
    assert.notEqual(pubsub.getStatus().oldestPendingSince, null, 'precondition')
    const current = status()
    assert.deepEqual(current.pending, [])
    assert.equal(current.oldestPendingSince, null)
  })
})

describe('Chelonia reconciles its subscriptions with the pubsub client', () => {
  it('re-subscribes a contract that the pubsub client lost on the next reconnect', async () => {
    await connect(0)
    await want('contract-A')
    await want('contract-B')
    await loseInPubsub('contract-A')
    assert.ok(
      !(await eventIsReceived('contract-A', 200)),
      'precondition: events are not received while the contract is lost'
    )

    const newLogs = logs.fromNow()
    const reopened = onNextOpen(pubsub)
    server.killClients()
    await reopened
    assert.ok(
      await waitFor(subscribed(pubsub, ['contract-A']), { timeout: 5000 }),
      'not subscribed in the pubsub client 5 s after the reconnect'
    )
    assert.ok(await eventIsReceived('contract-A'), 'events are received again')
    assert.ok(await eventIsReceived('contract-B'))
    await sleep(50)
    // `open` re-sent the SUB for B; reconciling adds the missing one only
    assert.equal(subsOnConnection('contract-A'), 1)
    assert.equal(subsOnConnection('contract-B'), 1)
    // ...and logs it
    const reconciled = newLogs.grep(
      /\[chelonia\] pubsub reconcile \(reconnected\): subscribing again to 1 contract/
    )
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].level, 'info')
    assert.deepEqual(reconciled[0].args[1], ['contract-A'])
  })

  it('subscribes a new client to every contract without reporting them as lost', async () => {
    await connect(0)
    await want('contract-N')
    const newLogs = logs.fromNow()
    // A second `chelonia/connect` replaces the client
    await connect(0)
    assert.ok(await waitFor(subscribed(pubsub, ['contract-N'])), 'not subscribed')
    assert.equal(newLogs.grep(/pubsub reconcile/).length, 0)
  })

  it('subscribes again to a contract that it wants while its UNSUB is pending', async () => {
    // E.g., the contract was released and then retained again right away
    await connect(0)
    await want('contract-U')
    server.slow(100)
    pubsub.unsub('contract-U')
    sbp('chelonia/pubsub/update')
    await sleep(300)
    assert.ok(pubsub.subscriptionSet.has('contract-U'), 'lost in the pubsub client')
    assert.deepEqual(status().missing, [])
  })

  it('re-subscribes a lost contract within pubsubReconcileInterval, without a reconnect', async () => {
    const INTERVAL = 200
    await connect(INTERVAL)
    await want('contract-C')
    const socket = pubsub.socket
    const newLogs = logs.fromNow()
    const lostAt = await loseInPubsub('contract-C')
    assert.ok(
      await waitFor(() => (
        server.framesOf(REQUEST_TYPE.SUB, 'contract-C', lostAt).length > 0 &&
        pubsub.subscriptionSet.has('contract-C')
      ), { timeout: INTERVAL + 1000 }),
      `still not subscribed ${INTERVAL + 1000} ms later`
    )
    assert.equal(pubsub.socket, socket, 'no reconnection')
    assert.ok(await eventIsReceived('contract-C'))
    // ...and logs it
    const reconciled = newLogs.grep(
      /\[chelonia\] pubsub reconcile \(periodic\): subscribing again to 1 contract/
    )
    assert.ok(reconciled.length >= 1)
    assert.ok(reconciled.every(({ level }) => level === 'info'))
  })

  it('retries a subscription that the server rejected', async () => {
    const INTERVAL = 200
    await connect(INTERVAL)
    let rejected = 0
    server.onRequest = (_conn, msg) => {
      if (msg.type === REQUEST_TYPE.SUB && msg.channelID === 'contract-D' && !rejected++) {
        return { error: 'try again later' }
      }
    }
    await seed('contract-D')
    assert.ok(await waitFor(() => rejected === 1), 'first SUB rejected')
    assert.ok(
      await waitFor(subscribed(pubsub, ['contract-D']), { timeout: INTERVAL + 1000 }),
      `still not subscribed ${INTERVAL + 1000} ms later`
    )
    assert.equal(subsOnConnection('contract-D'), 2)
    assert.ok(await eventIsReceived('contract-D'))
  })

  it('does not reconcile periodically when pubsubReconcileInterval is 0, negative or not finite', async (t) => {
    for (const interval of [0, -1, Infinity, NaN]) {
      // Treating the value as unset would arm the default 60000 ms timer,
      // which the sleep below can't wait for
      const timers = t.mock.method(globalThis, 'setInterval')
      await connect(interval)
      timers.mock.restore()
      assert.ok(
        !timers.mock.calls.some(({ arguments: args }) => args[1] === 60000),
        `pubsubReconcileInterval: ${interval} armed the default interval`
      )
      await sleep(20)
      updates = 0
      await sleep(250)
      assert.equal(updates, 0, `pubsubReconcileInterval: ${interval}`)
    }
  })

  it('treats a pubsubReconcileInterval above the longest timer delay as practically never', async () => {
    await connect(2 ** 31)
    await sleep(20)
    updates = 0
    await sleep(250)
    assert.equal(updates, 0)
  })

  it('does not reconcile while disconnected', async () => {
    await connect(50)
    await want('contract-E')
    server.stallNewConnections()
    server.killClients()
    assert.ok(!isOpen(pubsub)())
    updates = 0
    await sleep(300)
    assert.equal(updates, 0)
    assert.equal(pubsub.socket?.readyState, WebSocket.CONNECTING, 'still connecting')

    server.pass()
    assert.ok(await waitFor(subscribed(pubsub, ['contract-E'])), 're-subscribed')
    // Not the reconcile that follows every reconnection: the next periodic one
    await sleep(20)
    updates = 0
    assert.ok(await waitFor(() => updates > 0, { timeout: 500 }), 'reconciling again')
  })

  it('replaces the periodic reconcile on chelonia/connect, and stops it once the client is destroyed', async (t) => {
    const INTERVAL = 100
    const timers = t.mock.method(globalThis, 'setInterval')
    const cleared = t.mock.method(globalThis, 'clearInterval')
    const armed = () => timers.mock.calls
      .filter(({ arguments: args }) => args[1] === INTERVAL)
      .map(({ result }) => result)
    const wasCleared = (id: unknown) =>
      cleared.mock.calls.some(({ arguments: args }) => args[0] === id)
    await connect(INTERVAL)
    // A second connection replaces the first client (and its timer)
    pubsub = sbp('chelonia/connect')
    assert.equal(armed().length, 2)
    assert.ok(wasCleared(armed()[0]), 'the first timer is still running')
    assert.ok(await waitFor(isOpen(pubsub)), 'connected')
    // Not the reconcile that follows the connection: the periodic ones
    await sleep(20)
    updates = 0
    await sleep(4.5 * INTERVAL)
    assert.ok(updates >= 1 && updates <= 6, `${updates} reconciliations in ${4.5 * INTERVAL} ms`)
    pubsub.destroy()
    assert.ok(
      await waitFor(() => wasCleared(armed()[1]), { timeout: 3 * INTERVAL }),
      'the timer is still running after destroy()'
    )
  })

  it('ignores the connections of other pubsub clients', async () => {
    await connect(0)
    await sleep(20)
    updates = 0
    const other = createClient(RELAY_URL, { minReconnectionDelay: 20 })
    try {
      assert.ok(await waitFor(isOpen(other)))
      await sleep(20)
      assert.equal(updates, 0)
    } finally {
      other.destroy()
    }
  })

  it('keeps reconciling after chelonia/reset (which keeps the pubsub client)', async () => {
    const INTERVAL = 200
    await connect(INTERVAL)
    await want('contract-F')
    const socket = pubsub.socket
    await sbp('chelonia/reset')
    assert.equal(pubsub.socket, socket, 'same connection')
    assert.ok(
      await waitFor(() => !pubsub.subscriptionSet.has('contract-F')),
      'unsubscribed after the reset'
    )

    await want('contract-G')
    const lostAt = await loseInPubsub('contract-G')
    assert.ok(
      await waitFor(() => (
        server.framesOf(REQUEST_TYPE.SUB, 'contract-G', lostAt).length > 0 &&
        pubsub.subscriptionSet.has('contract-G')
      ), { timeout: INTERVAL + 1000 }),
      `still not subscribed ${INTERVAL + 1000} ms later`
    )
    assert.ok(!pubsub.subscriptionSet.has('contract-F'))
  })
})

describe('connectionOptions given to chelonia/configure', () => {
  it('reach the pubsub client as given, so maxRetries: Infinity keeps reconnecting', async () => {
    pubsub = await connectChelonia(relay, {
      connectionOptions: { minReconnectionDelay: 20, maxRetries: Infinity }
    })
    assert.equal(pubsub.options.maxRetries, Infinity)
    let failures = 0
    const listener = (target: PubSubClient) => { if (target === pubsub) failures++ }
    sbp('okTurtles.events/on', PUBSUB_RECONNECTION_FAILED, listener)
    try {
      // The connection drops, then the first attempt to reconnect fails
      server.stallNewConnections()
      server.killClients()
      assert.ok(
        await waitFor(() => pubsub.socket?.readyState === WebSocket.CONNECTING),
        'reconnecting'
      )
      server.killClients()
      server.pass()
      assert.ok(await waitFor(isOpen(pubsub)), 'not reconnected')
      assert.equal(failures, 0)
    } finally {
      sbp('okTurtles.events/off', PUBSUB_RECONNECTION_FAILED, listener)
    }
  })

  it('keep the client\'s default for a field set to undefined', async () => {
    // E.g. built with `{ reconnectOnDisconnection: cfg.reconnect }`
    pubsub = await connectChelonia(relay, {
      connectionOptions: { minReconnectionDelay: 20, reconnectOnDisconnection: undefined }
    })
    assert.equal(pubsub.options.reconnectOnDisconnection, true)
    const reopened = onNextOpen(pubsub)
    server.killClients()
    await reopened
  })

  it('survive a round trip through chelonia/config, maxRetries: Infinity included', async () => {
    await sbp('chelonia/configure', { connectionURL: RELAY_URL, fetch: relay.fetch })
    await sbp('chelonia/configure', sbp('chelonia/config'))
    assert.equal(sbp('chelonia/config').connectionOptions.maxRetries, Infinity)
  })
})
