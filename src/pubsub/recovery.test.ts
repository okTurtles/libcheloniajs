// Tests of how the pubsub client keeps (and recovers) its subscriptions,
// against the in-process fake server from `./test-harness.ts`.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { NOTIFICATION_TYPE, PUBSUB_RECONNECTION_SCHEDULED, REQUEST_TYPE } from './index.js'
import type { PubSubClient } from './index.js'
import {
  captureConsole, createCloseEvent, createFakePubsubServer, createTestClients, emulateSleep,
  isOpen, onNextOpen, sleep, subscribed, waitFor
} from './test-harness.js'
import type { FakeConnection } from './test-harness.js'

const server = createFakePubsubServer()
const { setup, destroyAll } = createTestClients()
let logs: ReturnType<typeof captureConsole>

before(() => {
  server.install()
  logs = captureConsole()
})

afterEach(() => {
  destroyAll()
  server.reset()
})

after(() => {
  logs.restore()
  server.uninstall()
})

describe('fake pubsub server (harness self-checks)', () => {
  it('answers SUB requests and records the frames', async () => {
    const since = Date.now()
    const { client } = setup()
    client.sub('c1')
    assert.ok(await waitFor(subscribed(client, ['c1'])))
    assert.deepEqual([...server.lastConnection!.subscriptions], ['c1'])
    assert.equal(server.framesOf(REQUEST_TYPE.SUB, 'c1', since).length, 1)
  })

  it('keeps black-holed sockets OPEN and unanswered, and stuck in CLOSING after close()', async () => {
    const since = Date.now()
    // Keep retrying for the whole test
    const { client } = setup({ maxOpRetries: 1000 })
    assert.ok(await waitFor(isOpen(client)))
    const socket = client.socket!
    server.blackhole()
    client.sub('c2')
    await sleep(100)
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.ok(server.framesOf(REQUEST_TYPE.SUB, 'c2', since).length >= 1, 'SUB sent')
    assert.ok(!client.subscriptionSet.has('c2'), 'SUB unanswered')

    socket.close()
    await sleep(100)
    assert.equal(socket.readyState, WebSocket.CLOSING)
    assert.equal(client.socket, socket, 'no close event yet')

    server.pass()
    server.killClients()
    assert.equal(socket.readyState, WebSocket.CLOSED)
    assert.notEqual(client.socket, socket, 'the close event was handled')
    assert.ok(await waitFor(subscribed(client, ['c2'])), 'subscribed on the next connection')
  })

  it('stalls new connection attempts until pass()', async () => {
    server.stallNewConnections()
    const { client } = setup()
    await sleep(50)
    assert.equal(client.socket?.readyState, WebSocket.CONNECTING)
    server.pass()
    assert.ok(await waitFor(isOpen(client)))
  })

  it('delays server -> client messages with slow()', async () => {
    const { client } = setup()
    assert.ok(await waitFor(isOpen(client)))
    server.slow(200)
    const start = performance.now()
    client.sub('c3')
    assert.ok(await waitFor(subscribed(client, ['c3']), { timeout: 1000 }))
    assert.ok(performance.now() - start >= 180, 'the OK was delayed')
  })

  it('closes connections abruptly with killClients()', async () => {
    const { client } = setup()
    assert.ok(await waitFor(isOpen(client)))
    const socket = client.socket!
    let closeCode: number | undefined
    socket.addEventListener('close', (event) => { closeCode = (event as CloseEvent).code })
    server.killClients()
    assert.equal(closeCode, 1006)
  })

  it('rejects the close codes and reasons that a real socket rejects', async () => {
    const { client } = setup()
    assert.ok(await waitFor(isOpen(client)))
    const socket = client.socket!
    assert.throws(() => socket.close(1006), { name: 'InvalidAccessError' })
    // 62 characters, 124 bytes
    assert.throws(() => socket.close(4001, 'ñ'.repeat(62)), { name: 'SyntaxError' })
    assert.equal(socket.readyState, WebSocket.OPEN)
  })

  it('rejects onNextOpen() if its callback throws', async () => {
    const { client } = setup()
    const opened = onNextOpen(client, () => { throw new Error('callback failed') })
    await assert.rejects(opened, /callback failed/)
  })

  it('keeps the timeout of waitFor() when an emulated sleep holds back performance.now()', async () => {
    const clock = emulateSleep({ monotonic: true })
    try {
      const start = Date.now()
      const waiting = waitFor(() => false, { timeout: 200 })
      setTimeout(() => clock.wake(2000), 50)
      assert.equal(await waiting, undefined)
      assert.ok(Date.now() - start < 1000, `waited ${Date.now() - start} ms`)
    } finally {
      clock.restore()
    }
  })
})

describe('pubsub client baseline', () => {
  it('receives ENTRY notifications for subscribed channels only', async () => {
    const { client, received } = setup()
    client.sub('a')
    assert.ok(await waitFor(subscribed(client, ['a'])))
    server.entry('a', 'one')
    server.entry('b', 'two')
    assert.ok(await waitFor(() => received.length >= 1))
    await sleep(20)
    assert.deepEqual(received, [{ channelID: 'a', data: 'one' }])
  })

  it('re-subscribes every channel after the connection drops', async () => {
    const { client, received } = setup()
    client.sub('a')
    client.sub('b')
    assert.ok(await waitFor(subscribed(client, ['a', 'b'])))
    const first = server.lastConnection
    const reopened = onNextOpen(client)
    server.killClients()
    await reopened
    assert.ok(await waitFor(subscribed(client, ['a', 'b'])))
    assert.notEqual(server.lastConnection, first)
    assert.deepEqual([...server.lastConnection!.subscriptions].sort(), ['a', 'b'])
    server.entry('b', 'again')
    assert.ok(await waitFor(() => received.some(({ data }) => data === 'again')))
  })

  it('unsubscribes', async () => {
    const { client } = setup()
    client.sub('a')
    assert.ok(await waitFor(subscribed(client, ['a'])))
    client.unsub('a')
    assert.ok(await waitFor(() =>
      !client.subscriptionSet.has('a') && !client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, 'a')
    ))
    assert.equal(server.lastConnection!.subscriptions.size, 0)
  })

  it('forgets a SUB that the server refuses', async () => {
    server.onRequest = (_conn, msg) =>
      msg.type === REQUEST_TYPE.SUB && msg.channelID === 'refused'
        ? { error: 'not allowed' }
        : undefined
    const { client } = setup()
    client.sub('refused')
    client.sub('allowed')
    assert.ok(await waitFor(subscribed(client, ['allowed'])))
    assert.ok(await waitFor(() => !client.pendingOperations.tHas(REQUEST_TYPE.SUB, 'refused')))
    assert.ok(!client.subscriptionSet.has('refused'))
    assert.equal(logs.grep(/Could not subscribe to refused: not allowed/).length, 1)
  })

  it('sends the KV filter along with the SUB request', async () => {
    const since = Date.now()
    const { client } = setup()
    client.setKvFilter('k', ['x'])
    client.sub('k')
    assert.ok(await waitFor(subscribed(client, ['k'])))
    assert.deepEqual(server.lastConnection!.kvFilters.get('k'), ['x'])
    await sleep(20)
    assert.equal(server.framesOf(REQUEST_TYPE.KV_FILTER, 'k', since).length, 0)
  })

  it('answers pings', async () => {
    const since = Date.now()
    const { client } = setup()
    assert.ok(await waitFor(isOpen(client)))
    server.ping()
    assert.ok(await waitFor(() => server.framesOf('pong', undefined, since).length === 1))
  })
})

// Port of `01-subscription-recovery.test.mjs`, from the regression suite of
// the okTurtles/group-income#3176 report (okTurtles/libcheloniajs#121). The
// trigger seen there: a reconnect completes, then the device sleeps; after
// waking up the socket is still OPEN but dead and the network is not usable
// yet. Each SUB goes unanswered.
describe('SUBs unanswered right after a reconnect (half-open socket after sleep/wake)', () => {
  // Retry budget: 10 * I plus up to 5 * I of jitter (2.5 to 3.75 s)
  const I = 250
  const OUTAGE = 5000
  const ids = ['h1', 'h2', 'h3', 'h4']
  const obs = {} as {
    pendingDuringOutage: boolean;
    abandoned: number;
    gaps: number[][];
    restored: boolean;
    missing: string[];
    delivered: boolean;
  }

  before(async () => {
    const { client, received } = setup({ opRetryInterval: I })
    ids.forEach((id) => client.sub(id))
    assert.ok(await waitFor(subscribed(client, ids)), 'baseline: all channels subscribed')
    let zombie: FakeConnection | undefined
    const opened = onNextOpen(client, () => {
      zombie = server.lastConnection
      server.blackhole()
    })
    server.killClients()
    const tOpen = await opened
    await sleep(OUTAGE)
    obs.pendingDuringOutage = ids.every((id) => client.pendingOperations.tHas(REQUEST_TYPE.SUB, id))
    obs.abandoned = logs.grep(/Abandoning socket/, tOpen).length
    obs.gaps = ids.map((id) => {
      const sends = server.framesOf(REQUEST_TYPE.SUB, id, tOpen)
        .filter(({ connection }) => connection === zombie)
      return sends.slice(1).map((frame, i) => frame.t - sends[i].t)
    })
    // The network is back
    server.pass()
    obs.restored = !!(await waitFor(subscribed(client, ids), { timeout: 3000 }))
    obs.missing = ids.filter((id) => !client.subscriptionSet.has(id))
    const start = received.length
    ids.forEach((id) => server.entry(id, 'from the other party'))
    obs.delivered = !!(await waitFor(() => ids.every(
      (id) => received.slice(start).some(({ channelID }) => channelID === id)
    )))
  })

  it('restores every wanted subscription once the network is back (CL-1)', () => {
    assert.ok(obs.restored,
      `${obs.missing.length}/${ids.length} channels still not subscribed 3 s after the ` +
      'network came back')
  })

  it('delivers events for those channels again (CL-1)', () => {
    assert.ok(obs.delivered, 'events posted by another participant were not delivered')
  })

  it('replaces the dead connection instead of giving up on the channels (CL-1)', () => {
    assert.ok(obs.pendingDuringOutage, 'a SUB was dropped during the outage')
    assert.ok(obs.abandoned >= 1, 'the dead socket was not abandoned')
  })

  it('backs off between SUB retries: gap k >= k * opRetryInterval (CL-2)', () => {
    assert.ok(obs.gaps.every((gaps) => gaps.length >= 4),
      `expected 5 sends per channel, got ${obs.gaps.map((gaps) => gaps.length + 1)}`)
    const violations = obs.gaps.flatMap(
      (gaps) => gaps.slice(0, 4).filter((gap, k) => gap < k * I - 25)
    )
    assert.equal(violations.length, 0,
      `gaps (ms) per channel: ${JSON.stringify(obs.gaps)}; ` +
      `expected >= [0, ${I}, ${2 * I}, ${3 * I}]`)
  })
})

describe('SUB ACKs delayed by a slow link', () => {
  // The retry budget (10 to 15 * I = 5 to 7.5 s here, 20 to 30 s with the
  // defaults) must outlast a slow but working server, e.g. right after a
  // restart when every client re-subscribes at once.
  const I = 500
  const SLOW = 4000
  const ids = ['s1', 's2', 's3', 's4']
  const obs = {} as {
    subscribed: boolean;
    unexpected: number;
    abandoned: number;
    subscribedAfterReconnect: boolean;
    delivered: boolean;
  }

  before(async () => {
    const { client, received } = setup({ opRetryInterval: I })
    ids.forEach((id) => client.sub(id))
    assert.ok(await waitFor(subscribed(client, ids)), 'baseline: all channels subscribed')
    const opened = onNextOpen(client, () => server.slow(SLOW))
    server.killClients()
    const tOpen = await opened
    obs.subscribed = !!(await waitFor(subscribed(client, ids), { timeout: SLOW + 3000 }))
    obs.unexpected = logs.grep(/Received unexpected sub/, tOpen).length
    obs.abandoned = logs.grep(/Abandoning socket/, tOpen).length
    server.slow(0)
    const reopened = onNextOpen(client)
    server.killClients()
    await reopened
    obs.subscribedAfterReconnect = !!(await waitFor(subscribed(client, ids)))
    const start = received.length
    ids.forEach((id) => server.entry(id, 'from the other party'))
    obs.delivered = !!(await waitFor(() => ids.every(
      (id) => received.slice(start).some(({ channelID }) => channelID === id)
    )))
  })

  it('accepts ACKs that arrive within the retry budget, so client and server agree (CL-1, CL-2)', () => {
    assert.ok(obs.subscribed,
      `not subscribed ${SLOW + 3000} ms after open; ` +
      `${obs.unexpected} late ACKs ignored as "Received unexpected sub"`)
    assert.equal(obs.abandoned, 0, 'a slow but working connection was replaced')
  })

  it('still has the subscriptions after the next reconnect (CL-1)', () => {
    assert.ok(obs.subscribedAfterReconnect && obs.delivered,
      `subscribed after reconnect: ${obs.subscribedAfterReconnect}, ` +
      `events delivered: ${obs.delivered}`)
  })
})

describe('requests that exhaust the retry budget (CL-1)', () => {
  // Retry budget: 200 to 300 ms
  const I = 20
  // Ignores the requests of type `type` on the connection that is open now
  const ignoreOnCurrentConnection = (type: string) => {
    const connection = server.lastConnection
    server.onRequest = (conn, msg) =>
      conn === connection && msg.type === type ? 'ignore' : undefined
    return connection!
  }
  const connectionOf = (client: PubSubClient) =>
    server.connections.find(({ socket }) => (socket as unknown) === client.socket)

  it('keeps an unanswered SUB pending and sends it again on a new connection', async () => {
    const since = Date.now()
    const { client } = setup({ opRetryInterval: I })
    assert.ok(await waitFor(isOpen(client)))
    const first = ignoreOnCurrentConnection(REQUEST_TYPE.SUB)
    let pendingOnReconnect = false
    const reopened = onNextOpen(client, () => {
      pendingOnReconnect = client.pendingOperations.tHas(REQUEST_TYPE.SUB, 'u')
    })
    client.sub('u')
    await reopened
    assert.ok(pendingOnReconnect, 'the SUB was dropped with the connection')
    assert.ok(await waitFor(subscribed(client, ['u'])), 'subscribed on a later connection')
    assert.notEqual(connectionOf(client), first)
    assert.equal(server.framesOf(REQUEST_TYPE.SUB, 'u', since)
      .filter(({ connection }) => connection === first).length, 5)
    assert.ok(first.socket.readyState >= WebSocket.CLOSING, 'the abandoned socket was closed')
    assert.equal(logs.grep(/Abandoning socket: no response to sub for u/, since).length, 1)
  })

  it('detaches the abandoned socket', async () => {
    const { client, received } = setup({ opRetryInterval: I })
    client.sub('d')
    assert.ok(await waitFor(subscribed(client, ['d'])))
    const first = ignoreOnCurrentConnection(REQUEST_TYPE.SUB)
    client.sub('u')
    assert.ok(await waitFor(subscribed(client, ['d', 'u'])), 'subscribed on a later connection')
    const current = client.socket
    const attempts = client.failedConnectionAttempts
    // Anything the old socket might still emit must be ignored
    first.socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: NOTIFICATION_TYPE.ENTRY, channelID: 'd', data: 'stale' })
    }))
    first.socket.dispatchEvent(createCloseEvent(1006))
    await sleep(50)
    assert.equal(client.socket, current)
    assert.equal(client.failedConnectionAttempts, attempts)
    assert.ok(subscribed(client, ['d', 'u'])())
    assert.deepEqual(received, [])
  })

  it('closes the abandoned socket when the reason is too long for close()', async () => {
    // The reason has 92 characters, but 162 bytes
    const channelID = 'ñ'.repeat(70)
    const { client } = setup({ opRetryInterval: I })
    assert.ok(await waitFor(isOpen(client)))
    const first = ignoreOnCurrentConnection(REQUEST_TYPE.SUB)
    client.sub(channelID)
    assert.ok(await waitFor(subscribed(client, [channelID])), 'subscribed on a later connection')
    assert.ok(first.socket.readyState >= WebSocket.CLOSING, 'the abandoned socket was closed')
  })

  it('settles an unanswered UNSUB by replacing the connection', async () => {
    const { client } = setup({ opRetryInterval: I })
    client.sub('w')
    client.sub('keep')
    assert.ok(await waitFor(subscribed(client, ['w', 'keep'])))
    const first = ignoreOnCurrentConnection(REQUEST_TYPE.UNSUB)
    client.unsub('w')
    assert.ok(await waitFor(() => {
      const current = connectionOf(client)
      return current && current !== first && current.subscriptions.has('keep') &&
        client.subscriptionSet.has('keep')
    }), 'reconnected and re-subscribed')
    assert.ok(!client.subscriptionSet.has('w'))
    assert.ok(!client.pendingOperations.tHas(REQUEST_TYPE.SUB, 'w'))
    assert.ok(!client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, 'w'))
    assert.ok(!connectionOf(client)!.subscriptions.has('w'))
  })

  it('settles an unanswered KV_FILTER by replacing the connection', async () => {
    const { client } = setup({ opRetryInterval: I })
    client.sub('k')
    assert.ok(await waitFor(subscribed(client, ['k'])))
    const first = ignoreOnCurrentConnection(REQUEST_TYPE.KV_FILTER)
    client.setKvFilter('k', ['a'])
    assert.ok(await waitFor(() => {
      const current = connectionOf(client)
      return current && current !== first && client.subscriptionSet.has('k')
    }), 'reconnected and re-subscribed')
    assert.deepEqual(connectionOf(client)!.kvFilters.get('k'), ['a'])
    assert.ok(!client.pendingOperations.tHas(REQUEST_TYPE.KV_FILTER, 'k'))
  })

  // Reconnection delays start at 20 to 40 ms and double with every attempt
  const BACKOFF = { opRetryInterval: I, minReconnectionDelay: 20, reconnectionDelayGrowFactor: 2 }
  const scheduledDelays = (client: PubSubClient) => {
    const delays: number[] = []
    const listener = (target: PubSubClient, { delay }: { delay: number }) => {
      if (target === client) delays.push(delay)
    }
    sbp('okTurtles.events/on', PUBSUB_RECONNECTION_SCHEDULED, listener)
    return {
      delays,
      stop: () => sbp('okTurtles.events/off', PUBSUB_RECONNECTION_SCHEDULED, listener)
    }
  }

  it('backs off while it keeps replacing connections over an unanswered SUB', async () => {
    server.onRequest = (_conn, msg) =>
      msg.type === REQUEST_TYPE.SUB && msg.channelID === 'never' ? 'ignore' : undefined
    const { client } = setup(BACKOFF)
    client.sub('ok')
    assert.ok(await waitFor(subscribed(client, ['ok'])))
    const scheduled = scheduledDelays(client)
    try {
      client.sub('never')
      assert.ok(await waitFor(() => scheduled.delays.length >= 3, { timeout: 5000 }))
      // The third replacement in a row waits for 160 to 320 ms
      assert.ok(scheduled.delays[2] >= 160, JSON.stringify(scheduled.delays))
    } finally {
      scheduled.stop()
    }
  })

  it('backs off while it keeps replacing connections over a KV filter whose ACK never matches', async () => {
    // A server that de-duplicates the KV filter in its ACKs
    server.onRequest = (conn, msg) => {
      if (msg.channelID !== 'k') return
      if (msg.type !== REQUEST_TYPE.SUB && msg.type !== REQUEST_TYPE.KV_FILTER) return
      if (msg.type === REQUEST_TYPE.SUB) conn.subscriptions.add('k')
      const kvFilter = Array.isArray(msg.kvFilter) ? [...new Set(msg.kvFilter)] : undefined
      setTimeout(() => {
        if (conn.state !== 'open') return
        conn.socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'ok', data: { type: msg.type, channelID: 'k', kvFilter } })
        }))
      }, 0)
      return 'ignore'
    }
    const { client } = setup(BACKOFF)
    client.sub('k')
    assert.ok(await waitFor(subscribed(client, ['k'])))
    const scheduled = scheduledDelays(client)
    try {
      client.setKvFilter('k', ['a', 'a'])
      assert.ok(await waitFor(() => scheduled.delays.length >= 3, { timeout: 5000 }))
      assert.ok(scheduled.delays[2] >= 160, JSON.stringify(scheduled.delays))
    } finally {
      scheduled.stop()
    }
  })
})

describe('diagnostic logs (CL-10)', () => {
  it('logs a close at info level, with the code, the reason and how long the socket was open', async () => {
    const { client } = setup()
    client.sub('c')
    assert.ok(await waitFor(subscribed(client, ['c'])))
    await sleep(30)
    const newLogs = logs.fromNow()
    const reopened = onNextOpen(client)
    server.closeClients(1001, 'going away')
    await reopened
    const closes = newLogs.grep(/\[pubsub\] Event: close/)
    assert.equal(closes.length, 1)
    assert.equal(closes[0].level, 'info')
    const { text } = closes[0]
    assert.ok(text.includes('(code 1001, reason "going away"), open for '), text)
    const match = /open for (\d+) ms, last message (\d+) ms ago$/.exec(text)
    assert.ok(match, text)
    assert.ok(Number(match[1]) >= 30 && Number(match[2]) >= 30, text)
  })

  it('logs a connection attempt that never opened, and the abandoned socket', async () => {
    server.stallNewConnections()
    const newLogs = logs.fromNow()
    setup({ timeout: 100 })
    assert.ok(await waitFor(() => newLogs.grep(/\[pubsub\] Event: close/).length > 0))
    const abandoned = newLogs.grep(/\[pubsub\] Abandoning socket: connection timeout/)
    assert.equal(abandoned.length, 1)
    assert.equal(abandoned[0].level, 'warn')
    const [close] = newLogs.grep(/\[pubsub\] Event: close/)
    assert.equal(close.level, 'info')
    assert.ok(close.text.includes('(code 4001, reason "connection timeout"), never opened'), close.text)
    assert.match(close.text, /never opened \(connecting for \d+ ms\)$/)
  })

  it('logs late SUB ACKs at info level, and the answers to the retries at debug level', async () => {
    const SLOW = 300
    const { client } = setup({ opRetryInterval: 50 })
    assert.ok(await waitFor(isOpen(client)))
    server.slow(SLOW)
    const newLogs = logs.fromNow()
    client.sub('late')
    assert.ok(await waitFor(subscribed(client, ['late']), { timeout: SLOW + 1000 }))
    const late = newLogs.grep(/\[pubsub\] Late ACK: subscribed to late (\d+) ms after the request/)
    assert.equal(late.length, 1)
    assert.equal(late[0].level, 'info')
    assert.ok(Number(/(\d+) ms/.exec(late[0].text)![1]) >= SLOW - 5, late[0].text)
    // The retries sent before the first ACK arrived are answered too
    assert.ok(await waitFor(() => newLogs.grep(/Received duplicate sub ACK for late/).length > 0))
    const duplicates = newLogs.grep(/Received duplicate sub ACK for late/)
    assert.ok(duplicates.every(({ level }) => level === 'debug'),
      JSON.stringify(duplicates.map(({ level, text }) => `${level}: ${text}`)))
    assert.equal(newLogs.grep(/Received unexpected sub/).length, 0)
    assert.equal(newLogs.grep(/Abandoning socket/).length, 0)
  })

  it('does not log fast SUB ACKs as late', async () => {
    const { client } = setup({ opRetryInterval: 200 })
    const newLogs = logs.fromNow()
    client.sub('fast')
    assert.ok(await waitFor(subscribed(client, ['fast'])))
    await sleep(50)
    assert.equal(newLogs.grep(/Late ACK/).length, 0)
  })
})
