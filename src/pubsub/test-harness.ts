// Test-only helper (not a `*.test.ts` file; excluded from the CJS build): an
// in-process stand-in for the pubsub server, for tests of the pubsub client
// and of Chelonia's use of it. `install()` replaces the global `WebSocket`
// (the client resolves it at call time) with a fake whose other end is this
// server. Tests can then answer requests, push notifications and inject the
// network faults seen in okTurtles/group-income#3176: a half-open socket
// that still reports OPEN, a closing handshake that never completes, stalled
// connection attempts, a slow link and abruptly dropped connections.
// `createFakeRelay()` fakes the HTTP endpoints that Chelonia needs.
import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import type { Key } from '@chelonia/crypto'
import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { SPMessage } from '../SPMessage.js'
import type { ProtoSPOpActionUnencrypted, SPKey, SPOpContract, SPOpValue } from '../SPMessage.js'
import { Secret } from '../Secret.js'
import { EVENT_HANDLED } from '../events.js'
import { createCID } from '../functions.js'
import { signedOutgoingDataWithRawKey } from '../signedData.js'
import type { ChelRootState, JSONType } from '../types.js'
import {
  createClient, NOTIFICATION_TYPE, PUBSUB_RECONNECTION_SUCCEEDED, REQUEST_TYPE, RESPONSE_TYPE
} from './index.js'
import type { Options, PubSubClient } from './index.js'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

// Server-side view of a connection:
// - `connecting`: handshake in progress, opens on the next tick (+ latency)
// - `stalled`: handshake never answered (until `pass()`)
// - `open`: working in both directions
// - `zombie`: the server dropped it but the client was never told (the
//   client socket stays OPEN; nothing is delivered either way; `close()`
//   leaves it CLOSING until `killClients()`)
// - `closed`: gone
export type FakeConnectionState = 'connecting' | 'stalled' | 'open' | 'zombie' | 'closed'

export type FakeRequest = {
  type: string;
  channelID?: string;
  kvFilter?: string[];
  data?: unknown;
  [key: string]: unknown;
}

interface FakeSocket extends EventTarget {
  readonly url: string;
  readyState: number;
  // eslint-disable-next-line no-use-before-define
  readonly connection: FakeConnection;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

export type FakeConnection = {
  id: number;
  socket: FakeSocket;
  url: string;
  state: FakeConnectionState;
  subscriptions: Set<string>;
  kvFilters: Map<string, string[]>;
  // eslint-disable-next-line no-use-before-define
  frames: ClientFrame[];
}

// Every frame the client sent, recorded on the client side (also when the
// server never gets it, e.g. on a zombie connection)
export type ClientFrame = { t: number; connection: FakeConnection; msg: FakeRequest }

// `undefined`: default handling. `'ignore'`: no answer at all.
// `{ error }`: answer with an ERROR response carrying `error` as the reason.
export type RequestOverride = undefined | 'ignore' | { error: string }

export type FakePubsubServer = ReturnType<typeof createFakePubsubServer>

// `CloseEvent` is only a global from Node.js 23 on (CI runs Node 22)
export const createCloseEvent = (code: number, reason = '', wasClean = false): Event =>
  typeof CloseEvent === 'function'
    ? new CloseEvent('close', { code, reason, wasClean })
    : Object.assign(new Event('close'), { code, reason, wasClean })

// What the tests connect to (named so as not to shadow the global `URL`)
export const PUBSUB_URL = 'ws://pubsub.test'
export const RELAY_URL = 'http://relay.test'

// Conditions for `waitFor()`
export const isOpen = (client: PubSubClient) => () => client.socket?.readyState === WebSocket.OPEN
export const subscribed = (client: PubSubClient, ids: string[]) => () =>
  ids.every((id) => client.subscriptionSet.has(id))

// Pubsub clients for one test file. `setup()` creates one that reconnects
// within tens of milliseconds and records the ENTRY notifications it gets;
// `destroyAll()` destroys them (before `server.reset()`, so that they don't
// reconnect).
export function createTestClients () {
  const clients: PubSubClient[] = []
  return {
    setup (options: Partial<Options> = {}) {
      const received: { channelID: unknown; data: unknown }[] = []
      const client = createClient(PUBSUB_URL, {
        minReconnectionDelay: 20,
        ...options,
        messageHandlers: {
          [NOTIFICATION_TYPE.ENTRY] (msg) {
            received.push({ channelID: msg.channelID, data: msg.data })
          },
          ...options.messageHandlers
        }
      })
      clients.push(client)
      return { client, received }
    },
    destroyAll () {
      while (clients.length) clients.pop()!.destroy()
    }
  }
}

export function createFakePubsubServer () {
  let nextID = 1
  // How new connections behave
  let mode: 'pass' | 'stall' = 'pass'
  // Server -> client latency in ms (also delays the handshake)
  let latency = 0
  let installed = false
  let savedWebSocket: unknown
  const connections: FakeConnection[] = []
  const frames: ClientFrame[] = []

  const later = (fn: () => void) => { setTimeout(fn, latency) }

  const dispatchClose = (conn: FakeConnection, code: number, reason: string, wasClean: boolean) => {
    conn.state = 'closed'
    conn.socket.readyState = CLOSED
    conn.socket.dispatchEvent(createCloseEvent(code, reason, wasClean))
  }

  // A connection attempt that fails (or is aborted): `error`, then close 1006
  const failConnection = (conn: FakeConnection) => {
    conn.state = 'closed'
    conn.socket.readyState = CLOSED
    conn.socket.dispatchEvent(new Event('error'))
    conn.socket.dispatchEvent(createCloseEvent(1006))
  }

  const scheduleOpen = (conn: FakeConnection) => {
    conn.state = 'connecting'
    later(() => {
      if (conn.state !== 'connecting' || conn.socket.readyState !== CONNECTING) return
      conn.state = 'open'
      conn.socket.readyState = OPEN
      conn.socket.dispatchEvent(new Event('open'))
    })
  }

  // Server -> client
  const deliver = (conn: FakeConnection, message: object) => {
    if (conn.state !== 'open') return
    const data = JSON.stringify(message)
    later(() => {
      if (conn.state !== 'open' || conn.socket.readyState !== OPEN) return
      conn.socket.dispatchEvent(new MessageEvent('message', { data }))
    })
  }

  const subscribersOf = (channelID: string) => connections.filter(
    (conn) => conn.state === 'open' && conn.subscriptions.has(channelID)
  )

  // A SUB or KV_FILTER request sets the channel's KV filter, or clears it if
  // the request has none
  const setKvFilter = (conn: FakeConnection, channelID: string, kvFilter: unknown) => {
    if (Array.isArray(kvFilter)) conn.kvFilters.set(channelID, kvFilter)
    else conn.kvFilters.delete(channelID)
  }

  // Client -> server
  const receive = (conn: FakeConnection, text: string) => {
    let msg: FakeRequest
    try {
      msg = JSON.parse(text)
    } catch {
      msg = { type: '<unparseable>', data: text }
    }
    const frame = { t: Date.now(), connection: conn, msg }
    conn.frames.push(frame)
    frames.push(frame)
    if (conn.state !== 'open') return
    const override = server.onRequest?.(conn, msg)
    if (override === 'ignore') return
    const { type, channelID } = msg
    if (override && typeof override === 'object') {
      const data = { type, channelID, reason: override.error }
      deliver(conn, { type: RESPONSE_TYPE.ERROR, data })
      return
    }
    // Requests without a channel (PONG, PUSH_ACTION, ...) need nothing
    if (typeof channelID !== 'string') return
    const answer = (data: object) => deliver(conn, { type: RESPONSE_TYPE.OK, data })
    switch (type) {
      case REQUEST_TYPE.SUB:
        conn.subscriptions.add(channelID)
        setKvFilter(conn, channelID, msg.kvFilter)
        answer({ type, channelID, kvFilter: msg.kvFilter })
        break
      case REQUEST_TYPE.UNSUB:
        conn.subscriptions.delete(channelID)
        conn.kvFilters.delete(channelID)
        answer({ type, channelID })
        break
      case REQUEST_TYPE.KV_FILTER:
        setKvFilter(conn, channelID, msg.kvFilter)
        answer({ type, channelID, kvFilter: msg.kvFilter })
        break
      case REQUEST_TYPE.PUB:
        for (const other of subscribersOf(channelID)) {
          if (other === conn) continue
          deliver(other, { type: NOTIFICATION_TYPE.PUB, channelID, data: msg.data })
        }
        break
    }
  }

  class FakeWebSocket extends EventTarget implements FakeSocket {
    static readonly CONNECTING = CONNECTING
    static readonly OPEN = OPEN
    static readonly CLOSING = CLOSING
    static readonly CLOSED = CLOSED
    readonly CONNECTING = CONNECTING
    readonly OPEN = OPEN
    readonly CLOSING = CLOSING
    readonly CLOSED = CLOSED
    readonly url: string
    readonly connection: FakeConnection
    readyState = CONNECTING
    binaryType = 'blob'
    bufferedAmount = 0
    extensions = ''
    protocol = ''

    constructor (url: string | URL) {
      super()
      this.url = String(url)
      this.connection = {
        id: nextID++,
        socket: this,
        url: this.url,
        state: 'connecting',
        subscriptions: new Set(),
        kvFilters: new Map(),
        frames: []
      }
      connections.push(this.connection)
      if (mode === 'pass') {
        scheduleOpen(this.connection)
      } else {
        this.connection.state = 'stalled'
      }
    }

    send (data: unknown) {
      if (this.readyState === CONNECTING) {
        throw new DOMException('WebSocket is still connecting', 'InvalidStateError')
      }
      // Like a real socket, data sent while closing or closed is discarded
      if (this.readyState !== OPEN) return
      receive(this.connection, String(data))
    }

    close (code?: number, reason?: string) {
      // Like a real socket, whatever its state
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException(`Invalid close code ${code}`, 'InvalidAccessError')
      }
      if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
        throw new DOMException('The close reason is longer than 123 bytes', 'SyntaxError')
      }
      if (this.readyState === CLOSING || this.readyState === CLOSED) return
      const conn = this.connection
      if (this.readyState === CONNECTING) {
        // Aborting a connection attempt fails it
        failConnection(conn)
        return
      }
      this.readyState = CLOSING
      // On a dead connection the closing handshake never completes
      if (conn.state === 'zombie') return
      conn.state = 'closed'
      later(() => {
        if (this.readyState === CLOSING) dispatchClose(conn, code ?? 1005, reason ?? '', true)
      })
    }
  }

  const server = {
    connections,
    frames,
    // Inspect (and override) each request the server gets
    onRequest: undefined as
      ((conn: FakeConnection, msg: FakeRequest) => RequestOverride) | undefined,
    get openConnections () { return connections.filter((conn) => conn.state === 'open') },
    get lastConnection (): FakeConnection | undefined {
      return connections[connections.length - 1]
    },
    install () {
      if (installed) return
      installed = true
      savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
      ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    },
    uninstall () {
      if (!installed) return
      installed = false
      ;(globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket
    },
    // Restores the default behaviour and forgets every connection (between
    // tests)
    reset () {
      server.killClients()
      server.onRequest = undefined
      mode = 'pass'
      latency = 0
      connections.length = 0
      frames.length = 0
    },
    // The server silently drops every current connection (the clients still
    // see OPEN sockets) and new connection attempts stall until `pass()`
    blackhole () {
      for (const conn of connections) {
        if (conn.state === 'open') conn.state = 'zombie'
        else if (conn.state === 'connecting') conn.state = 'stalled'
      }
      mode = 'stall'
    },
    // New connection attempts stall (current connections keep working)
    stallNewConnections () {
      for (const conn of connections) {
        if (conn.state === 'connecting') conn.state = 'stalled'
      }
      mode = 'stall'
    },
    // The network works again: stalled and new connection attempts open.
    // Zombie connections stay dead.
    pass () {
      mode = 'pass'
      for (const conn of connections) {
        if (conn.state === 'stalled') scheduleOpen(conn)
      }
    },
    // Server -> client latency for everything sent from now on
    slow (ms: number) {
      latency = ms
    },
    // Every connection that the client has not seen closed yet ends
    // abruptly (close 1006, e.g. the browser giving up on a dead socket)
    killClients () {
      for (const conn of connections) {
        const { readyState } = conn.socket
        if (readyState === CLOSED) continue
        if (readyState === CONNECTING) {
          failConnection(conn)
        } else {
          dispatchClose(conn, 1006, '', false)
        }
      }
    },
    // Server-initiated clean close of the working connections
    closeClients (code = 1000, reason = '') {
      for (const conn of server.openConnections) {
        conn.state = 'closed'
        conn.socket.readyState = CLOSING
        later(() => {
          if (conn.socket.readyState === CLOSING) dispatchClose(conn, code, reason, true)
        })
      }
    },
    ping () {
      for (const conn of server.openConnections) {
        deliver(conn, { type: NOTIFICATION_TYPE.PING, data: Date.now() })
      }
    },
    // Sends `message` to every working connection subscribed to `channelID`
    notify (channelID: string, message: object) {
      for (const conn of subscribersOf(channelID)) deliver(conn, message)
    },
    entry (channelID: string, data: unknown) {
      server.notify(channelID, { type: NOTIFICATION_TYPE.ENTRY, channelID, data })
    },
    // Frames the client sent, optionally filtered by type, channel and time
    framesOf (type?: string, channelID?: string, since = -Infinity): ClientFrame[] {
      return frames.filter(({ t, msg }) =>
        t >= since &&
        (type === undefined || msg.type === type) &&
        (channelID === undefined || msg.channelID === channelID)
      )
    }
  }
  return server
}

// `status`: what the relay answered (set once the response is ready)
export type RelayRequest = {
  t: number; method: string; url: string; path: string; status?: number
}

type FetchInit = Parameters<typeof fetch>[1]

// `undefined`: default handling. Otherwise, the response to send instead.
export type RelayOverride = undefined | Response | Promise<Response>

export type FakeRelay = ReturnType<typeof createFakeRelay>

// `shelter <contractID> <UNIX ms time>.<nonce>.<signature>`; only the time is
// checked (the signature is irrelevant for these tests)
const shelterAuthTimeIsValid = (init?: FetchInit): boolean => {
  const authorization = new Headers(init?.headers).get('authorization')
  const time = /^shelter \S+ ([0-9]+)\./i.exec(authorization ?? '')?.[1]
  return time === undefined || Math.abs(Number(time) - new Date().valueOf()) <= 60e3
}

// A contract whose keys are in its OP_CONTRACT (`first`, not published yet):
// `CSK`, which signs everything, and `SAK` (`#sak`), for the shelter
// authorization header of `/kv` requests. Chelonia only has the secret keys
// after `storeSecretKeys(contract)`.
export type TestContract = {
  contractID: string; CSK: Key; CSKid: string; SAK: Key; SAKid: string; first: SPMessage
}

export function createTestContract (type = 'test/contract'): TestContract {
  const CSK = keygen(EDWARDS25519SHA512BATCH)
  const CSKid = keyId(CSK)
  const SAK = keygen(EDWARDS25519SHA512BATCH)
  const SAKid = keyId(SAK)
  const payload: SPOpContract = {
    type,
    keys: [{
      id: CSKid,
      name: '#csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      allowedActions: '*',
      data: serializeKey(CSK, false),
      _notBeforeHeight: 0,
      _notAfterHeight: undefined
    } as SPKey, {
      id: SAKid,
      name: '#sak',
      purpose: ['sak'],
      ringLevel: 0,
      permissions: [],
      data: serializeKey(SAK, false),
      _notBeforeHeight: 0,
      _notAfterHeight: undefined
    } as SPKey]
  }
  const first = SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, payload)],
    manifest: 'test-manifest'
  })
  return { contractID: first.hash(), CSK, CSKid, SAK, SAKid, first }
}

// A signed OP_ACTION_UNENCRYPTED (no contract code is needed with
// `skipActionProcessing`). Without `head`, it's for `publishEvent`, which
// sets `previousHEAD` and `height`.
export function actionMessage (
  contract: TestContract,
  data: JSONType,
  head?: { previousHEAD: string; previousKeyOp: string; height: number }
): SPMessage {
  const action: ProtoSPOpActionUnencrypted = { action: 'test/action', data, meta: {} }
  return SPMessage.createV1_0({
    contractID: contract.contractID,
    ...head,
    op: [
      SPMessage.OP_ACTION_UNENCRYPTED,
      signedOutgoingDataWithRawKey<SPOpValue, object>(contract.CSK, action)
    ],
    manifest: 'test-manifest'
  })
}

// Gives Chelonia the (transient) secret keys of `contract`, e.g. for
// `chelonia/kv/set`
export function storeSecretKeys (contract: TestContract): void {
  sbp('chelonia/storeSecretKeys', new Secret([
    { key: contract.CSK, transient: true },
    { key: contract.SAK, transient: true }
  ]))
}

// A contract that Chelonia has synced (and has the secret keys of), and that
// `pubsub` is subscribed to
export async function retainedContract (
  relay: FakeRelay, pubsub: PubSubClient
): Promise<TestContract> {
  const contract = createTestContract()
  assert.equal(relay.append(contract.first), 200)
  storeSecretKeys(contract)
  await sbp('chelonia/contract/retain', contract.contractID)
  assert.ok(await waitFor(subscribed(pubsub, [contract.contractID])), 'subscribed')
  // Let the sync that follows every new subscription finish
  await sbp('chelonia/contract/wait', contract.contractID)
  return contract
}

// A retained contract that `pubsub` then lost while Chelonia still wants it,
// and that another participant has posted to since (so Chelonia's copy is
// stale)
export async function staleContract (
  relay: FakeRelay, pubsub: PubSubClient
): Promise<{ contract: TestContract; reply: SPMessage }> {
  const contract = await retainedContract(relay, pubsub)
  const { contractID } = contract
  pubsub.unsub(contractID)
  assert.ok(
    await waitFor(() => (
      !pubsub.subscriptionSet.has(contractID) &&
      !pubsub.pendingOperations.tHas(REQUEST_TYPE.UNSUB, contractID)
    )),
    'unsubscribed in pubsub'
  )
  const reply = relay.postAction(contract, { text: 'reply from the other party' })
  return { contract, reply }
}

// Configures Chelonia (after `chelonia/_init`) to use `relay`, connects it to
// the installed fake pubsub server and waits for the connection to open.
// `config` adds to (or overrides) the defaults.
export async function connectChelonia (
  relay: FakeRelay, config: Record<string, unknown> = {}
): Promise<PubSubClient> {
  await sbp('chelonia/configure', {
    connectionURL: RELAY_URL,
    fetch: relay.fetch,
    // Reconnect within tens of milliseconds
    connectionOptions: { minReconnectionDelay: 20 },
    ...config
  })
  const pubsub: PubSubClient = sbp('chelonia/connect')
  assert.ok(await waitFor(isOpen(pubsub)), 'connected')
  return pubsub
}

// The hashes of the events that Chelonia handles from now on
export function handledEvents (): Set<string> {
  const handled = new Set<string>()
  sbp('okTurtles.events/on', EVENT_HANDLED, (_contractID: string, message: SPMessage) => {
    handled.add(message.hash())
  })
  return handled
}

// The height of Chelonia's copy of a contract
export const localHeight = (contractID: string): number | undefined =>
  (sbp('chelonia/private/state') as ChelRootState).contracts[contractID]?.height

// Stand-in for the HTTP side of the server, for Chelonia-level tests: pass
// `relay.fetch` as `config.fetch`. Answers `GET /time`, records every request
// and serves two kinds of contracts:
// - seeded ones (`relay.contracts`, which tests seed with the same
//   `{ HEAD, height }` as `rootState.contracts[id]`, so that syncing takes the
//   "already synchronized" path): only `GET /latestHEADinfo/<id>`
// - real event chains (`relay.chains`), created with `POST /event` or
//   `relay.append()`: `GET /latestHEADinfo/<id>`, `GET /eventsAfter/...` and
//   `POST /event` (409 unless the event goes right on top of the HEAD).
//   Every appended event is sent as ENTRY to the subscribers of its contract
//   on `pubsub` (if given).
// - the KV store (`relay.kv`) of either kind: `GET /kv/<id>/<key>` and
//   `POST /kv/<id>/<key>`, which, like the server, answers 412 unless
//   `if-match` has the stored value's etag (`""` if there is none), then
//   409 unless the value is signed with the contract's current height; both
//   with the stored value and its etag (`x-cid`).
// Like the server, requests with a shelter authorization header get a 401 if
// its timestamp is more than 60 s off the server's clock (`new Date()`).
// Anything else is a 404 unless `onRequest` answers it.
export function createFakeRelay ({ pubsub }: { pubsub?: FakePubsubServer } = {}) {
  const contracts = new Map<string, { HEAD: string; height: number }>()
  // Serialized events by contract ID, in height order
  const chains = new Map<string, string[]>()
  // KV store: stored (serialized) values by `<contractID>/<key>`
  const kv = new Map<string, string>()
  const requests: RelayRequest[] = []

  const headInfo = (contractID: string): { HEAD: string; height: number } | undefined => {
    const chain = chains.get(contractID)
    if (!chain) return contracts.get(contractID)
    const { hash, head } = SPMessage.deserializeHEAD(chain[chain.length - 1])
    return { HEAD: hash, height: head.height }
  }

  // Returns the HTTP status that `POST /event` answers
  const append = (serialized: string): number => {
    const { head, contractID, isFirstMessage } = SPMessage.deserializeHEAD(serialized)
    if (isFirstMessage) {
      if (chains.has(contractID)) return 409
      if (head.height !== 0) return 400
      chains.set(contractID, [serialized])
    } else {
      const chain = chains.get(contractID)
      if (!chain) return 404
      const latest = headInfo(contractID)!
      if (head.previousHEAD !== latest.HEAD || head.height !== latest.height + 1) return 409
      chain.push(serialized)
    }
    pubsub?.entry(contractID, serialized)
    return 200
  }

  const eventsAfter = (contractID: string, sinceHeight: number, limit: number) => {
    const chain = chains.get(contractID)
    if (!chain || !(sinceHeight >= 0)) return new Response('', { status: 404 })
    const events = chain.slice(sinceHeight, sinceHeight + limit).map(
      (message) => Buffer.from(JSON.stringify({ message })).toString('base64')
    )
    return new Response(JSON.stringify(events), {
      headers: { 'shelter-headinfo-height': String(chain.length - 1) }
    })
  }

  const kvEtag = (value: string | undefined) => `"${value === undefined ? '' : createCID(value)}"`

  const kvRequest = (method: string, contractID: string, key: string, init?: FetchInit) => {
    const id = `${contractID}/${key}`
    const stored = kv.get(id)
    const answer = (status: number) =>
      new Response(stored ?? '', { status, headers: { 'x-cid': kvEtag(stored) } })
    if (method === 'GET') return stored === undefined ? new Response('', { status: 404 }) : answer(200)
    if (method !== 'POST') return new Response('', { status: 405 })
    const ifMatch = new Headers(init?.headers).get('if-match')
    if (!ifMatch) return new Response('', { status: 400 })
    if (ifMatch !== '*' && !ifMatch.split(',').map((etag) => etag.trim()).includes(kvEtag(stored))) {
      return answer(412)
    }
    const value = String(init?.body)
    if (Number(JSON.parse(value).height) !== headInfo(contractID)?.height) return answer(409)
    kv.set(id, value)
    return new Response(null, { status: 204, headers: { 'x-cid': kvEtag(value) } })
  }

  const respond = ({ method, path }: RelayRequest, init?: FetchInit): Response => {
    const [, endpoint, contractID, ...args] = path.split('/').map(decodeURIComponent)
    if (!shelterAuthTimeIsValid(init)) return new Response('', { status: 401 })
    if (method === 'GET' && endpoint === 'time') {
      return new Response(new Date().toISOString())
    }
    if (method === 'GET' && endpoint === 'latestHEADinfo' && headInfo(contractID)) {
      return Response.json(headInfo(contractID))
    }
    if (method === 'GET' && endpoint === 'eventsAfter') {
      return eventsAfter(contractID, Number(args[0]), args[1] ? Number(args[1]) : Infinity)
    }
    if (method === 'POST' && endpoint === 'event' && !contractID) {
      const status = append(String(init?.body))
      return new Response(status === 200 ? '' : String(status), { status })
    }
    if (endpoint === 'kv' && contractID && args.length === 1) {
      return kvRequest(method, contractID, args[0], init)
    }
    return new Response('', { status: 404 })
  }

  const relay = {
    contracts,
    chains,
    kv,
    requests,
    headInfo,
    // Number of syncs of `contractID` among the requests from position `from`
    // (positions, unlike timestamps, can't count a request from the same ms)
    syncsOf (contractID: string, from = 0): number {
      return requests.slice(from)
        .filter(({ path }) => path === `/latestHEADinfo/${contractID}`).length
    },
    // Appends an event without going through `fetch` (e.g. for another
    // participant's events); returns the `POST /event` status
    append (message: SPMessage): number {
      return append(message.serialize())
    },
    // Another participant posts an action to `contract`
    postAction (contract: TestContract, data: JSONType): SPMessage {
      const latest = headInfo(contract.contractID)
      if (!latest) throw new Error(`Unknown contract ${contract.contractID}`)
      const message = actionMessage(contract, data, {
        previousHEAD: latest.HEAD,
        previousKeyOp: contract.contractID,
        height: latest.height + 1
      })
      const status = append(message.serialize())
      if (status !== 200) throw new Error(`postAction: ${status}`)
      return message
    },
    // Inspect (and override) each request
    onRequest: undefined as
      ((request: RelayRequest, init?: FetchInit) => RelayOverride) | undefined,
    async fetch (input: string | URL | Request, init?: FetchInit): Promise<Response> {
      const url = input instanceof Request ? input.url : String(input)
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const request: RelayRequest = { t: Date.now(), method, url, path: new URL(url).pathname }
      requests.push(request)
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError')
      }
      const response = await (relay.onRequest?.(request, init) ?? respond(request, init))
      request.status = response.status
      return response
    },
    reset () {
      contracts.clear()
      chains.clear()
      kv.clear()
      requests.length = 0
      relay.onRequest = undefined
    }
  }
  return relay
}

// The relay's answer to a KV write signed with a stale contract height, when
// no value is stored
export const kvConflict = (): Response =>
  new Response('', { status: 409, headers: { 'x-cid': '""' } })

// `SPMessage.deserializeHEAD` only needs the head's `contractID`, which is
// enough for Chelonia's ENTRY handler to dispatch a fake event
export const fakeEntryData = (contractID: string): string =>
  JSON.stringify({ head: JSON.stringify({ contractID, op: 'ae' }) })

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// The harness's own clock, which `emulateSleep()` doesn't hold back
const harnessNow = performance.now.bind(performance)

// Resolves with the (truthy) value of `condition()`, or with `undefined` once
// `timeout` ms passed (so that assertions can report what went wrong)
export async function waitFor<T> (
  condition: () => T,
  { timeout = 2000, interval = 5 }: { timeout?: number; interval?: number } = {}
): Promise<T | undefined> {
  const deadline = harnessNow() + timeout
  for (;;) {
    const value = condition()
    if (value) return value
    if (harnessNow() >= deadline) return undefined
    await sleep(interval)
  }
}

// Resolves with `Date.now()` at the next `open` of `client`. `callback` runs
// synchronously inside the client's `open` handler, before the pending SUBs
// are re-sent (e.g. to black-hole the connection right after it opens). If
// it throws, the promise rejects (the client's listener would only log it).
// Without an `open` within `timeout` ms, it rejects and `callback` never
// runs, so that a broken reconnection fails the test instead of hanging it.
export function onNextOpen (
  client: PubSubClient,
  callback?: () => void,
  { timeout = 5000 }: { timeout?: number } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      sbp('okTurtles.events/off', PUBSUB_RECONNECTION_SUCCEEDED, listener)
    }
    const listener = (target: PubSubClient) => {
      if (target !== client) return
      stop()
      try {
        callback?.()
      } catch (e) {
        reject(e)
        return
      }
      resolve(Date.now())
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`onNextOpen: no open within ${timeout} ms`))
    }, timeout)
    sbp('okTurtles.events/on', PUBSUB_RECONNECTION_SUCCEEDED, listener)
  })
}

// Emulates the browser's network status: defines `navigator.onLine` (which
// Node lacks) and delivers `offline`/`online` events to `client` directly
// (the client only listens to them on `self`, which Node lacks too). Without
// a client, only `navigator.onLine` changes.
export function emulateNavigator () {
  const nav = globalThis.navigator as { onLine?: boolean }
  const saved = Object.getOwnPropertyDescriptor(nav, 'onLine')
  let onLine = true
  Object.defineProperty(nav, 'onLine', { configurable: true, get: () => onLine })
  return {
    offline (client?: PubSubClient) {
      onLine = false
      client?.listeners.offline?.call(client, new Event('offline'))
    },
    online (client?: PubSubClient) {
      onLine = true
      client?.listeners.online?.call(client, new Event('online'))
    },
    restore () {
      if (saved) Object.defineProperty(nav, 'onLine', saved)
      else delete nav.onLine
    }
  }
}

// Emulates waking up from sleep. Timers don't run while a device sleeps and
// (if nothing ran in between) the effect on wake-up is the same as `Date.now()`
// jumping forward by the time slept, which `wake()` does. Only `Date.now()` is
// shifted, not `new Date()` nor `performance.now()`.
// With `monotonic: true`, `wake()` holds back `performance.now()` by the time
// slept instead, like browsers on macOS, whose `performance.now()` stands
// still during sleep; `Date.now()` and `new Date()` keep the real time.
export function emulateSleep ({ monotonic = false }: { monotonic?: boolean } = {}) {
  const realNow = Date.now
  const realPerformanceNow = performance.now
  const savedPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let dateOffset = 0
  let monotonicOffset = 0
  Date.now = () => realNow.call(Date) + dateOffset
  if (monotonic) {
    performance.now = () => realPerformanceNow.call(performance) + monotonicOffset
  }
  return {
    wake (ms: number) {
      if (monotonic) monotonicOffset -= ms
      else dateOffset += ms
    },
    // Emulates a change of the system clock by `ms`: only `Date.now()` moves
    // (not `new Date()`, which the fake relay uses as the server's clock)
    changeClock (ms: number) {
      dateOffset += ms
    },
    restore () {
      Date.now = realNow
      if (!monotonic) return
      if (savedPerformanceNow) Object.defineProperty(performance, 'now', savedPerformanceNow)
      else delete (performance as { now?: unknown }).now
    }
  }
}

type ConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'

// Captures (and silences, unless TEST_VERBOSE is set) console output
export function captureConsole (
  levels: ConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error']
) {
  const entries: { t: number; level: ConsoleLevel; text: string; args: unknown[] }[] = []
  const originals = levels.map((level) => [level, console[level]] as const)
  const verbose = !!process.env.TEST_VERBOSE
  const format = (arg: unknown) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  for (const [level, original] of originals) {
    console[level] = (...args: unknown[]) => {
      entries.push({ t: Date.now(), level, text: args.map(format).join(' '), args })
      if (verbose) original.apply(console, args)
    }
  }
  return {
    entries,
    grep (pattern: RegExp, since = -Infinity) {
      return entries.filter(({ t, text }) => t >= since && pattern.test(text))
    },
    // The entries logged from now on (unlike `grep(pattern, since)`, this
    // does not depend on `Date.now()`, which `emulateSleep()` shifts)
    fromNow () {
      const start = entries.length
      return {
        grep (pattern: RegExp) {
          return entries.slice(start).filter(({ text }) => pattern.test(text))
        }
      }
    },
    restore () {
      for (const [level, original] of originals) console[level] = original
    }
  }
}
