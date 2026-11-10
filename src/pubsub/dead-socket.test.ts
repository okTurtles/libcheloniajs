// Tests of how the pubsub client replaces dead sockets, notices them right
// after waking up from sleep and reports its connection state, against the
// in-process fake server from `./test-harness.ts`.
// Port of `02-dead-socket.test.mjs`, from the regression suite of the
// okTurtles/group-income#3176 report (okTurtles/libcheloniajs#121).
//
// On a dead connection (e.g., after the device slept) the closing handshake
// never completes, so a socket that is only `close()`d stays CLOSING until
// the browser gives up, and the client must not wait for that. Timers don't
// run during sleep, so the ping timer alone notices a dead socket only
// `pingTimeout` ms of awake time after waking up.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import {
  NOTIFICATION_TYPE, PUBSUB_ERROR, PUBSUB_STATE_CHANGED, PUBSUB_SUBSCRIPTION_FAILED, REQUEST_TYPE
} from './index.js'
import type { PubSubClient, PubSubState } from './index.js'
import {
  captureConsole, createFakePubsubServer, createTestClients, emulateNavigator, emulateSleep,
  isOpen, onNextOpen, sleep, subscribed, waitFor
} from './test-harness.js'

const server = createFakePubsubServer()
const { setup, destroyAll } = createTestClients()
const pingers: ReturnType<typeof setInterval>[] = []
const nav = emulateNavigator()
let logs: ReturnType<typeof captureConsole>

// Every PUBSUB_STATE_CHANGED event (position-based, since `emulateSleep()`
// shifts `Date.now()`)
const stateEvents: { client: PubSubClient; state: PubSubState; previous: PubSubState }[] = []
sbp('okTurtles.events/on', PUBSUB_STATE_CHANGED, (
  client: PubSubClient, { state, previous }: { state: PubSubState; previous: PubSubState }
) => {
  stateEvents.push({ client, state, previous })
})
// The states that `client` entered since `stateEvents` had `from` entries
const statesOf = (client: PubSubClient, from = 0) => stateEvents.slice(from)
  .filter((event) => event.client === client)
  .map(({ state }) => state)

before(() => {
  server.install()
  logs = captureConsole()
})

afterEach(() => {
  while (pingers.length) clearInterval(pingers.pop())
  destroyAll()
  server.reset()
  nav.online()
})

after(() => {
  logs.restore()
  nav.restore()
  server.uninstall()
})

// The server pings every working connection every `interval` ms
const keepPinging = (interval: number) => {
  pingers.push(setInterval(() => server.ping(), interval))
}

// Resolves with the ms from `since` until the next `open` of `client`, or
// with `null` after `timeout` ms
const reopenedWithin = (client: PubSubClient, timeout: number, since = performance.now()) =>
  onNextOpen(client, undefined, { timeout }).then(() => performance.now() - since, () => null)

describe('ping timeout on a dead socket', () => {
  const PING = 300
  const obs = {} as {
    reopenedAfter: number | null;
    resubscribed: boolean;
    oldSocketState: number;
    abandoned: number;
    stable: boolean;
    states: PubSubState[];
  }

  before(async () => {
    const newLogs = logs.fromNow()
    keepPinging(PING / 3)
    const { client } = setup({ pingTimeout: PING })
    client.sub('p')
    assert.ok(await waitFor(subscribed(client, ['p'])), 'baseline: subscribed')
    const oldSocket = client.socket!
    const t0 = performance.now()
    const mark = stateEvents.length
    // The server dropped the connection without telling us; the network works
    server.blackhole()
    server.pass()
    obs.reopenedAfter = await reopenedWithin(client, PING + 500, t0)
    obs.resubscribed = !!(await waitFor(
      () => client.socket !== oldSocket && subscribed(client, ['p'])()
    ))
    obs.states = statesOf(client, mark)
    obs.oldSocketState = oldSocket.readyState
    obs.abandoned = newLogs.grep(/Abandoning socket: ping timeout/).length
    const current = client.socket
    await sleep(2 * PING)
    obs.stable = client.socket === current && subscribed(client, ['p'])()
  })

  it('replaces the socket when the ping timeout fires, without waiting for the closing handshake', () => {
    assert.ok(obs.reopenedAfter !== null,
      `no new connection within ${PING + 500} ms (old socket readyState ${obs.oldSocketState}, ` +
      '2 = CLOSING)')
    assert.equal(obs.abandoned, 1)
  })

  it('closes the old socket', () => {
    assert.ok(obs.oldSocketState >= WebSocket.CLOSING, `readyState ${obs.oldSocketState}`)
  })

  it('re-subscribes on the new socket, which then stays up', () => {
    assert.ok(obs.resubscribed, 'not re-subscribed on a new socket')
    assert.ok(obs.stable, 'the new socket was replaced too')
  })

  it('emits PUBSUB_STATE_CHANGED for the transition', () => {
    assert.deepEqual(obs.states, ['reconnecting', 'connecting', 'open'])
  })
})

describe('offline -> online while the old socket is dead', () => {
  const obs = {} as {
    detached: boolean;
    pending: boolean;
    attemptsWhileOffline: number;
    reopenedAfter: number | null;
    resubscribed: boolean;
    delivered: boolean;
    statusOffline: ReturnType<PubSubClient['getStatus']>;
    statesOffline: PubSubState[];
    states: PubSubState[];
  }

  before(async () => {
    const { client, received } = setup()
    client.sub('o')
    assert.ok(await waitFor(subscribed(client, ['o'])), 'baseline: subscribed')
    const connections = server.connections.length
    server.blackhole()
    const mark0 = stateEvents.length
    nav.offline(client)
    obs.statusOffline = client.getStatus()
    obs.statesOffline = statesOf(client, mark0)
    obs.detached = client.socket === null
    obs.pending = client.pendingOperations.tHas(REQUEST_TYPE.SUB, 'o')
    await sleep(125)
    obs.attemptsWhileOffline = server.connections.length - connections
    server.pass()
    const t1 = performance.now()
    const mark1 = stateEvents.length
    nav.online(client)
    obs.reopenedAfter = await reopenedWithin(client, 1000, t1)
    obs.resubscribed = !!(await waitFor(subscribed(client, ['o'])))
    obs.states = statesOf(client, mark1)
    server.entry('o', 'from the other party')
    obs.delivered = !!(await waitFor(() => received.some(({ channelID }) => channelID === 'o')))
  })

  it('lets go of the socket right away when going offline, keeping the subscription wanted', () => {
    assert.ok(obs.detached, 'still attached to the old socket')
    assert.ok(obs.pending, 'the subscription is not pending')
  })

  it('does not try to reconnect while offline', () => {
    assert.equal(obs.attemptsWhileOffline, 0)
  })

  it('reconnects right after `online` instead of waiting for the dead socket to close', () => {
    assert.ok(obs.reopenedAfter !== null, 'no new connection within 1 s of `online`')
    assert.ok(obs.resubscribed, 'not re-subscribed')
    assert.ok(obs.delivered, 'events are not delivered')
  })

  it('reports the state "offline" while the browser is offline', () => {
    assert.equal(obs.statusOffline.state, 'offline', `getStatus(): ${JSON.stringify(obs.statusOffline)}`)
    assert.deepEqual(obs.statusOffline.subscribed, [])
    assert.deepEqual(obs.statusOffline.pending, ['o'])
    assert.deepEqual(obs.statesOffline, ['offline'])
  })

  it('emits reconnecting -> connecting -> open', () => {
    assert.deepEqual(obs.states, ['reconnecting', 'connecting', 'open'])
  })
})

describe('waking up from sleep with a dead socket', () => {
  // With this ping timeout the watchdog checks the wall clock every second
  // (every 5 s with the default of 45 s). The ping timer alone would need
  // 3 s of awake time.
  const PING = 3000
  const obs = {} as { reopenedAfter: number | null; resubscribed: boolean; abandoned: number }

  before(async () => {
    const newLogs = logs.fromNow()
    const { client } = setup({ pingTimeout: PING })
    client.sub('w')
    assert.ok(await waitFor(subscribed(client, ['w'])), 'baseline: subscribed')
    const oldSocket = client.socket
    // The connection died during the sleep; the network works again
    server.blackhole()
    server.pass()
    const clock = emulateSleep()
    try {
      clock.wake(5 * 60 * 1000)
      obs.reopenedAfter = await reopenedWithin(client, 2000)
    } finally {
      clock.restore()
    }
    obs.resubscribed = !!(await waitFor(
      () => client.socket !== oldSocket && subscribed(client, ['w'])()
    ))
    obs.abandoned = newLogs.grep(/Abandoning socket: ping timeout \(wall clock\)/).length
  })

  it('detects the dead socket within seconds of waking up', () => {
    assert.ok(obs.reopenedAfter !== null,
      `no new connection within 2 s of waking up (the ping timer needs ${PING} ms)`)
    assert.equal(obs.abandoned, 1)
  })

  it('re-subscribes on the new socket', () => {
    assert.ok(obs.resubscribed)
  })
})

describe('replacing dead sockets', () => {
  it('abandons a connection attempt that times out, without waiting for it to close', async () => {
    const newLogs = logs.fromNow()
    server.stallNewConnections()
    const { client } = setup({ timeout: 100 })
    const stuck = client.socket!
    // Aborting the attempt doesn't fire `close` either
    stuck.close = () => {}
    assert.ok(await waitFor(() => client.socket !== stuck, { timeout: 1000 }),
      'still waiting for the stuck connection attempt')
    server.pass()
    assert.ok(await waitFor(isOpen(client)))
    assert.equal(newLogs.grep(/Abandoning socket: connection timeout/).length, 1)
  })

  it('`online` replaces a socket that is stuck closing', async () => {
    const { client } = setup()
    client.sub('c')
    assert.ok(await waitFor(subscribed(client, ['c'])))
    const stuck = client.socket!
    server.blackhole()
    // The closing handshake never completes
    stuck.close()
    await sleep(50)
    assert.equal(client.socket, stuck, 'baseline: no `close` event')
    server.pass()
    nav.online(client)
    assert.ok(await waitFor(
      () => client.socket !== stuck && subscribed(client, ['c'])(), { timeout: 1000 }
    ), 'not reconnected and re-subscribed')
  })

  it('`online` leaves a working socket alone', async () => {
    const { client } = setup()
    client.sub('k')
    assert.ok(await waitFor(subscribed(client, ['k'])))
    const socket = client.socket
    const connections = server.connections.length
    nav.online(client)
    await sleep(100)
    assert.equal(client.socket, socket)
    assert.equal(server.connections.length, connections)
    assert.ok(subscribed(client, ['k'])())
  })

  it('`online` leaves a client alone that its last allowed attempt just destroyed', async () => {
    server.stallNewConnections()
    const { client } = setup({
      maxRetries: 2, timeout: 150, minReconnectionDelay: 10, maxReconnectionDelay: 20
    })
    assert.ok(await waitFor(() => (
      client.failedConnectionAttempts === 2 && client.socket?.readyState === WebSocket.CONNECTING
    ), { timeout: 3000 }), 'third attempt in progress')
    const errors: unknown[] = []
    const onError = (target: PubSubClient, error: unknown) => {
      if (target === client) errors.push(error)
    }
    sbp('okTurtles.events/on', PUBSUB_ERROR, onError)
    try {
      // The attempt fails: a browser sets CLOSED and queues the `close` event,
      // and `online` runs first
      ;(client.socket as { readyState: number }).readyState = WebSocket.CLOSED
      nav.online(client)
    } finally {
      sbp('okTurtles.events/off', PUBSUB_ERROR, onError)
    }
    assert.equal(client.shouldReconnect, false, 'precondition: destroyed')
    assert.deepEqual(errors, [])
    assert.equal(client.state, 'closed')
  })

  it('does not close the socket on PING when the ping timeout is disabled', async () => {
    for (const pingTimeout of [0, Infinity]) {
      const { client } = setup({ pingTimeout })
      assert.ok(await waitFor(isOpen(client)))
      const socket = client.socket!
      server.ping()
      await sleep(50)
      assert.equal(client.socket, socket, `pingTimeout: ${pingTimeout}`)
      assert.equal(socket.readyState, WebSocket.OPEN, `pingTimeout: ${pingTimeout}`)
    }
  })

  it('keeps the ping timer running when a message handler throws', async () => {
    const newLogs = logs.fromNow()
    const { client } = setup({
      pingTimeout: 300,
      messageHandlers: {
        [NOTIFICATION_TYPE.ENTRY] () { throw new Error('handler failed') }
      }
    })
    client.sub('t')
    assert.ok(await waitFor(subscribed(client, ['t'])))
    const socket = client.socket
    server.entry('t', 'data')
    // By the ping timer, not a second later by the wall-clock watchdog
    assert.ok(await waitFor(() => client.socket !== socket, { timeout: 700 }), 'not replaced')
    assert.equal(newLogs.grep(/Abandoning socket: ping timeout$/).length, 1)
  })

  it('treats a pingTimeout or timeout above the longest timer delay as practically never', async () => {
    const newLogs = logs.fromNow()
    const { client } = setup({ pingTimeout: 2 ** 31 })
    assert.ok(await waitFor(isOpen(client)))
    const socket = client.socket
    server.stallNewConnections()
    const { client: connecting } = setup({ timeout: 2 ** 31 })
    await sleep(200)
    assert.equal(client.socket, socket)
    assert.equal(connecting.socket?.readyState, WebSocket.CONNECTING)
    assert.equal(newLogs.grep(/Abandoning socket/).length, 0)
  })
})

describe('wall-clock ping watchdog', () => {
  it('leaves a socket that keeps receiving messages alone', async () => {
    const newLogs = logs.fromNow()
    keepPinging(100)
    const { client } = setup({ pingTimeout: 300 })
    assert.ok(await waitFor(isOpen(client)))
    const socket = client.socket
    // Past the first check (every second with this ping timeout)
    await sleep(1300)
    assert.equal(client.socket, socket)
    assert.equal(newLogs.grep(/Abandoning socket/).length, 0)
  })

  it('agrees with the ping timer that any message (not only a PING) shows the socket works', async () => {
    const newLogs = logs.fromNow()
    const { client } = setup({ pingTimeout: 300 })
    client.sub('e')
    assert.ok(await waitFor(subscribed(client, ['e'])))
    const socket = client.socket
    pingers.push(setInterval(() => server.entry('e', 'data'), 50))
    await sleep(1300)
    assert.equal(client.socket, socket)
    assert.equal(newLogs.grep(/Abandoning socket/).length, 0)
  })

  it('is stopped with the other timers', async () => {
    const { client } = setup({ pingTimeout: 300 })
    assert.ok(await waitFor(isOpen(client)))
    assert.notEqual(client.wallClockWatchdogID, undefined, 'not started on open')
    server.stallNewConnections()
    server.killClients()
    assert.equal(client.wallClockWatchdogID, undefined, 'still running after close')
    server.pass()
    assert.ok(await waitFor(isOpen(client)))
    assert.notEqual(client.wallClockWatchdogID, undefined, 'not started on the next open')
    client.destroy()
    assert.equal(client.wallClockWatchdogID, undefined, 'still running after destroy()')
  })
})

describe('connection state', () => {
  it('getStatus() reports the state and the subscriptions', async () => {
    const start = Date.now()
    const { client } = setup()
    client.sub('s')
    assert.ok(await waitFor(subscribed(client, ['s'])))
    const status = client.getStatus()
    assert.equal(status.state, 'open')
    assert.deepEqual(status.subscribed, ['s'])
    assert.deepEqual(status.pending, [])
    assert.equal(status.oldestPendingSince, null)
    assert.equal(status.since, client.stateSince)
    assert.ok(status.since >= start && status.since <= Date.now(), `since: ${status.since}`)
    // Plain data
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
  })

  it('starts connecting, coming from closed', () => {
    const mark = stateEvents.length
    const { client } = setup()
    assert.equal(client.state, 'connecting')
    assert.deepEqual(
      stateEvents.slice(mark)
        .filter((event) => event.client === client)
        .map(({ previous, state }) => [previous, state]),
      [['closed', 'connecting']]
    )
  })

  it('stays closed with `manual` until connect()', async () => {
    const { client } = setup({ manual: true })
    assert.equal(client.state, 'closed')
    assert.equal(client.getStatus().state, 'closed')
    const mark = stateEvents.length
    client.connect()
    assert.equal(client.state, 'connecting')
    assert.ok(await waitFor(isOpen(client)))
    assert.deepEqual(statesOf(client, mark), ['connecting', 'open'])
  })

  it('needs no global WebSocket with `manual` before connect(), and to be destroyed', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')!
    delete (globalThis as { WebSocket?: unknown }).WebSocket
    try {
      const { client } = setup({ manual: true })
      assert.equal(client.state, 'closed')
      client.destroy()
      assert.equal(client.state, 'closed')
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', saved)
    }
  })

  it('is closed after destroy()', async () => {
    const { client } = setup()
    client.sub('d')
    assert.ok(await waitFor(subscribed(client, ['d'])))
    const mark = stateEvents.length
    client.destroy()
    assert.deepEqual(statesOf(client, mark), ['closed'])
    const status = client.getStatus()
    assert.equal(status.state, 'closed')
    assert.deepEqual(status.subscribed, [])
    assert.deepEqual(status.pending, [])
  })

  it('is closed after giving up reconnecting', async () => {
    const { client } = setup({ maxRetries: 0 })
    assert.ok(await waitFor(isOpen(client)))
    const mark = stateEvents.length
    server.stallNewConnections()
    server.killClients()
    assert.ok(await waitFor(() => client.socket?.readyState === WebSocket.CONNECTING), 'reconnecting')
    // The connection attempt fails too
    server.killClients()
    assert.equal(client.shouldReconnect, false, 'baseline: gave up')
    assert.equal(client.state, 'closed')
    assert.deepEqual(statesOf(client, mark), ['reconnecting', 'connecting', 'closed'])
  })

  it('reports a socket that started closing as reconnecting', async () => {
    const { client } = setup()
    assert.ok(await waitFor(isOpen(client)))
    server.stallNewConnections()
    // `close` fires on the next tick
    server.closeClients()
    assert.equal(client.state, 'open', 'baseline: no event yet')
    assert.equal(client.getStatus().state, 'reconnecting')
    assert.equal(client.state, 'reconnecting')
    assert.ok(await waitFor(() => client.state === 'connecting'), 'next connection attempt')
  })

  it('goes offline while waiting to reconnect, and back to reconnecting when online', async () => {
    // The reconnection stays scheduled during the test
    const { client } = setup({ minReconnectionDelay: 5000 })
    assert.ok(await waitFor(isOpen(client)))
    const mark = stateEvents.length
    server.killClients()
    assert.equal(client.state, 'reconnecting')
    nav.offline(client)
    assert.equal(client.state, 'offline')
    assert.equal(client.nextConnectionAttemptDelayID, undefined, 'reconnecting while offline')
    nav.online(client)
    assert.equal(client.state, 'reconnecting')
    assert.notEqual(client.nextConnectionAttemptDelayID, undefined, 'no reconnection scheduled')
    assert.deepEqual(statesOf(client, mark), ['reconnecting', 'offline', 'reconnecting'])
  })

  it('reports pending SUBs and when the oldest one was sent', async () => {
    server.onRequest = (_conn, msg) => msg.type === REQUEST_TYPE.SUB ? 'ignore' : undefined
    // Retries don't change anything (the server ignores them too), and this
    // budget lasts the whole test
    const { client } = setup({ opRetryInterval: 1000 })
    assert.ok(await waitFor(isOpen(client)))
    const t0 = Date.now()
    client.sub('x')
    await sleep(20)
    const t1 = Date.now()
    client.sub('y')
    let status = client.getStatus()
    assert.deepEqual(status.pending, ['x', 'y'])
    assert.deepEqual(status.subscribed, [])
    assert.ok(
      status.oldestPendingSince !== null &&
      status.oldestPendingSince >= t0 && status.oldestPendingSince < t1,
      `oldestPendingSince: ${status.oldestPendingSince} (x: ${t0}, y: ${t1})`
    )

    server.killClients()
    status = client.getStatus()
    assert.equal(status.state, 'reconnecting')
    assert.deepEqual(status.pending, ['x', 'y'])
    assert.equal(status.oldestPendingSince, null, 'not sent on any connection')

    const t2 = Date.now()
    assert.ok(await waitFor(isOpen(client)))
    status = client.getStatus()
    assert.deepEqual(status.pending, ['x', 'y'])
    assert.ok(
      status.oldestPendingSince !== null && status.oldestPendingSince >= t2,
      `oldestPendingSince: ${status.oldestPendingSince} (reconnected after ${t2})`
    )
  })

  it('does not count a SUB that waits for a connection in oldestPendingSince', async () => {
    server.stallNewConnections()
    const { client } = setup()
    client.sub('a')
    await sleep(50)
    let status = client.getStatus()
    assert.equal(status.state, 'connecting')
    assert.deepEqual(status.pending, ['a'])
    assert.equal(status.oldestPendingSince, null, 'while connecting')

    server.pass()
    assert.ok(await waitFor(subscribed(client, ['a'])))
    server.killClients()
    client.sub('b')
    status = client.getStatus()
    assert.equal(client.socket, null)
    assert.deepEqual(status.pending, ['a', 'b'])
    assert.equal(status.oldestPendingSince, null, 'while waiting to reconnect')
  })

  it('emits PUBSUB_SUBSCRIPTION_FAILED when the server rejects a SUB', async () => {
    server.onRequest = (_conn, msg) => (
      msg.type === REQUEST_TYPE.SUB && msg.channelID === 'refused'
        ? { error: 'not allowed' }
        : undefined
    )
    const { client } = setup()
    const failures: unknown[] = []
    const listener = (target: PubSubClient, detail: unknown) => {
      if (target === client) failures.push(detail)
    }
    sbp('okTurtles.events/on', PUBSUB_SUBSCRIPTION_FAILED, listener)
    try {
      assert.ok(await waitFor(isOpen(client)))
      client.sub('refused')
      client.sub('allowed')
      assert.ok(await waitFor(() => failures.length > 0 && client.subscriptionSet.has('allowed')))
      assert.deepEqual(failures, [{ channelID: 'refused', reason: 'not allowed' }])
      assert.deepEqual(client.getStatus().pending, [])
    } finally {
      sbp('okTurtles.events/off', PUBSUB_SUBSCRIPTION_FAILED, listener)
    }
  })
})
