// node --import ./scripts/ts-node-register.mjs --test src/pubsub/index.test.ts
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PUBSUB_RECONNECTION_SUCCEEDED, createClient } from './index.js'
import type { JsonSbpInvocation, PubSubClient, RsiMessage } from './index.js'

class FakeWebSocket extends EventTarget {
  readyState: WebSocket['readyState'] = WebSocket.CONNECTING
  sentMessages: RsiMessage[] = []

  constructor () {
    super()
  }

  _open () {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close (code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    // A real socket fires 'close' asynchronously.
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code, reason })))
  }

  send (s: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('not open')
    this.sentMessages.push(JSON.parse(s))
  }
}

class FakeServer {
  client
  get socket () { return this.client.socket as (FakeWebSocket | null) }

  constructor (client: PubSubClient) {
    this.client = client
  }

  acceptConnection () {
    assert.equal(this.socket?.readyState, WebSocket.CONNECTING)
    this.socket._open()
  }

  reply (msg: object) {
    this.socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }))
  }
}

const testOptions = {
  WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  manual: true,
  pingTimeout: 0,
  reconnectOnDisconnection: false,
  reconnectOnOnline: false,
  reconnectOnTimeout: false,
  rsiTimeout: 50
}

const createNewClient = () => createClient('ws://localhost:8080', testOptions)

describe('Test getNextRandomDelay()', function () {
  const client = createNewClient()

  const { maxReconnectionDelay, minReconnectionDelay } = client.options

  const createRandomDelays = (number: number) => {
    return [...new Array(number)].map((_, i) => {
      client.failedConnectionAttempts = i
      return client.getNextRandomDelay()
    })
  }
  const delays1 = createRandomDelays(10)
  const delays2 = createRandomDelays(10)

  it('every delay should be longer than the previous one', function () {
    // In other words, the delays should be sorted in ascending numerical order.
    assert.deepEqual(
      delays1,
      [...delays1].sort((a, b) => a - b)
    )
    assert.deepEqual(
      delays2,
      [...delays2].sort((a, b) => a - b)
    )
  })

  it('no delay should be shorter than the minimal reconnection delay', function () {
    delays1.forEach((delay) => {
      assert.ok(delay >= minReconnectionDelay)
    })
    delays2.forEach((delay) => {
      assert.ok(delay >= minReconnectionDelay)
    })
  })

  it('no delay should be longer than the maximal reconnection delay', function () {
    delays1.forEach((delay) => {
      assert.ok(delay <= maxReconnectionDelay)
    })
    delays2.forEach((delay) => {
      assert.ok(delay <= maxReconnectionDelay)
    })
  })
})

describe('rsi()', function () {
  it('sends a request and resolves with a payload', async function () {
    const client = createNewClient()
    // A connect() call is necessary for the client to create a socket.
    client.connect()

    let sbpInvocation: JsonSbpInvocation = ['foo/bar', 1, 'x']

    /* Starts a request while the server has not accepted the connection yet. */
    let promise = client.rsi(sbpInvocation)
    let expectedMessage = { id: `${client.id}-0`, type: 'rsi', data: sbpInvocation }
    assert.equal(client.pendingRsiOperations.size, 1, 'Operation should be marked as pending.')
    assert.equal(client.promiseTimeoutsByMessageID.size, 0, 'Timer should not have started yet.')
    assert.deepEqual(client.pendingRsiOperations.get(expectedMessage.id), expectedMessage, 'Pending operation should match the request.')

    const server = new FakeServer(client)
    server.acceptConnection()

    assert.equal(client.promiseTimeoutsByMessageID.size, 1, 'Timer should have started by now.')

    let payload: unknown = { answer: 42 }
    server.reply({ to: expectedMessage.id, type: 'rsi-ok', data: payload })
    assert.deepEqual(await promise, payload, '4')

    assert.equal(client.pendingRsiOperations.size, 0, '5')
    assert.equal(client.promiseTimeoutsByMessageID.size, 0, '6')

    /* Sends another request now that the server has accepted the connection. */
    sbpInvocation = ['test/case', 100, 'abc']
    promise = client.rsi(sbpInvocation)
    expectedMessage = { id: `${client.id}-1`, type: 'rsi', data: sbpInvocation }
    assert.equal(client.pendingRsiOperations.size, 1)
    assert.equal(client.promiseTimeoutsByMessageID.size, 1)
    assert.deepEqual(client.pendingRsiOperations.get(expectedMessage.id), expectedMessage)

    payload = 'random payload'
    server.reply({ to: expectedMessage.id, type: 'rsi-ok', data: payload })
    assert.deepEqual(await promise, payload)

    client.destroy()
  })

  it('rejects with an Error on rsi-error, copying only safe fields', async function () {
    const client = createNewClient()
    const server = new FakeServer(client)
    client.connect()
    server.acceptConnection()
    const promise = client.rsi(['foo/placeholder'])
    const id = `${client.id}-0`

    server.reply({ to: id, type: 'rsi-error', data: { message: 'boom', name: 'X', stack: 'evil' } })
    await assert.rejects(promise, (e: Error) => {
      assert.ok(e instanceof Error)
      assert.equal(e.message, 'boom')
      assert.equal(e.name, 'X')
      assert.notEqual(e.stack, 'evil')
      return true
    })
    client.destroy()
  })

  it('times out when the server never replies', async function () {
    const client = createNewClient()
    const server = new FakeServer(client)
    client.connect()
    server.acceptConnection()

    await assert.rejects(client.rsi(['foo/bar']), /timed out/)

    assert.equal(client.pendingRsiOperations.size, 0)
    assert.equal(client.promiseTimeoutsByMessageID.size, 0)
    client.destroy()
  })
})

describe('open()', function () {
  it('emits reconnection-succeeded with isNew true only on the first open', function () {
    const client = createNewClient()
    const server = new FakeServer(client)
    let actual // For isNew

    const handler = (c: PubSubClient) => {
      if (client !== c) return
      actual = client.isNew
      hasRun = true
    }
    let hasRun = false

    sbp('okTurtles.events/on', PUBSUB_RECONNECTION_SUCCEEDED, handler)

    try {
      client.connect()
      server.acceptConnection()
      assert.ok(hasRun)
      assert.equal(actual, true)

      client.socket?.close()
      // Reset 'hasRun' for the next assertion.
      hasRun = false
    } finally {
      sbp('okTurtles.events/off', PUBSUB_RECONNECTION_SUCCEEDED, handler)
    }
    client.destroy()
  })
})
