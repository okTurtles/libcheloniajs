/* eslint-disable @typescript-eslint/no-this-alias */
import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import { randomIntFromRange } from 'turtledash'
import type { JSONObject, JSONType } from '../types.js'
import { timerDelay, unrefTimer } from '../timer-utils.js'

// ====== Enums ====== //

export const NOTIFICATION_TYPE = Object.freeze({
  ENTRY: 'entry',
  DELETION: 'deletion',
  KV: 'kv',
  KV_FILTER: 'kv_filter',
  PING: 'ping',
  PONG: 'pong',
  PUB: 'pub',
  SUB: 'sub',
  UNSUB: 'unsub',
  VERSION_INFO: 'version_info'
})

export const REQUEST_TYPE = Object.freeze({
  PUB: 'pub',
  SUB: 'sub',
  UNSUB: 'unsub',
  PUSH_ACTION: 'push_action',
  KV_FILTER: 'kv_filter'
})

export const RESPONSE_TYPE = Object.freeze({
  ERROR: 'error',
  OK: 'ok'
})

export const PUSH_SERVER_ACTION_TYPE = Object.freeze({
  SEND_PUBLIC_KEY: 'send-public-key',
  STORE_SUBSCRIPTION: 'store-subscription',
  DELETE_SUBSCRIPTION: 'delete-subscription',
  SEND_PUSH_NOTIFICATION: 'send-push-notification'
})

export type NotificationTypeEnum = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];
export type RequestTypeEnum = (typeof REQUEST_TYPE)[keyof typeof REQUEST_TYPE];
export type ResponseTypeEnum = (typeof RESPONSE_TYPE)[keyof typeof RESPONSE_TYPE];

// ====== Types ====== //

type TimeoutID = ReturnType<typeof setTimeout>;
type IntervalID = ReturnType<typeof setInterval>;

// Connection state of a client (`client.state`, `client.getStatus()` and the
// PUBSUB_STATE_CHANGED event):
// - `connecting`: a connection attempt is in progress;
// - `open`: connected;
// - `reconnecting`: disconnected, and a new connection attempt is scheduled
//   (or the previous socket is still closing);
// - `offline`: disconnected while the browser is offline; the client
//   reconnects once it is back online;
// - `closed`: not connected and not about to reconnect (destroyed, gave up
//   reconnecting, or `connect()` not called yet).
export type PubSubState = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed'

// Snapshot returned by `client.getStatus()`. Plain data, so that it can be
// sent across a service worker boundary.
export type PubSubStatus = {
  state: PubSubState;
  // `Date.now()` when the client entered `state`
  since: number;
  // Channels whose subscription the server confirmed
  subscribed: string[];
  // Channels with a SUB request that awaits a response or a connection
  pending: string[];
  // `Date.now()` when the oldest of the pending SUB requests was sent on
  // the current connection (requests waiting for a connection don't count),
  // or `null` if there is none
  oldestPendingSince: number | null;
};

// A request that awaits a response. `runWithRetry` uses reference equality
// with the current entry to determine freshness. `since` is `Date.now()` when
// it was sent on the current connection; the entries that `close` re-arms
// for the next connection don't have it.
type PendingOperation = { since?: number };

export type Options = {
  logPingMessages: boolean;
  // How long to wait for the next message (the server pings regularly)
  // before replacing the connection, in ms. Also checked against the wall
  // clock, so that a connection that died while the device slept is noticed
  // right after waking up. `0` or `Infinity` disables it.
  pingTimeout: number;
  maxReconnectionDelay: number;
  maxRetries: number;
  minReconnectionDelay: number;
  reconnectOnDisconnection: boolean;
  reconnectOnOnline: boolean;
  reconnectOnTimeout: boolean;
  reconnectionDelayGrowFactor: number;
  timeout: number;
  // Maximum retry attempts after initial send (maxOpRetries + 1 total attempts).
  // A request that gets no response to any of them is not dropped: the
  // connection is considered broken and replaced, and the request is sent
  // again on the new connection. With `reconnectOnDisconnection: false`,
  // nothing would replace it, so the request is dropped instead.
  maxOpRetries: number;
  // Base interval between retries (linear backoff): retry k waits
  // (k - 1) * opRetryInterval plus up to opRetryInterval of jitter, so the
  // whole budget is about 10 to 15 * opRetryInterval with the default
  // maxOpRetries.
  opRetryInterval: number;
  manual?: boolean;
  // eslint-disable-next-line no-use-before-define
  handlers?: Partial<ClientEventHandlers>;
  // eslint-disable-next-line no-use-before-define
  messageHandlers?: Partial<MessageHandlers>;
};

export type Message = {
  [key: string]: JSONType;
  type: string;
};

export type PubSubClient = {
  connectionTimeoutID: TimeoutID | undefined;
  connectionTimeUsed?: number;
  // eslint-disable-next-line no-use-before-define
  customEventHandlers: Partial<ClientEventHandlers>;
  failedConnectionAttempts: number;
  isLocal: boolean;
  isNew: boolean;
  // `Date.now()` when the current socket opened or last received a message
  lastMessageAt: number | undefined;
  // eslint-disable-next-line no-use-before-define
  listeners: ClientEventHandlers;
  // eslint-disable-next-line no-use-before-define
  messageHandlers: MessageHandlers;
  nextConnectionAttemptDelayID: TimeoutID | undefined;
  options: Options;
  // eslint-disable-next-line no-use-before-define
  pendingOperations: TieredMap<RequestTypeEnum, string, PendingOperation>;
  pingTimeoutID: TimeoutID | undefined;
  shouldReconnect: boolean;
  socket: WebSocket | null;
  // Current connection state, and `Date.now()` when the client entered it
  state: PubSubState;
  stateSince: number;
  subscriptionSet: Set<string>;
  kvFilter: Map<string, string[]>;
  // Connections replaced in a row because a request went unanswered
  unansweredReplacements: number;
  url: string;
  wallClockWatchdogID: IntervalID | undefined;
  // Methods
  clearAllTimers(this: PubSubClient): void;
  connect(this: PubSubClient): void;
  destroy(this: PubSubClient): void;
  getStatus(this: PubSubClient): PubSubStatus;
  pub(this: PubSubClient, channelID: string, data: JSONType): void;
  scheduleConnectionAttempt(this: PubSubClient): void;
  sub(this: PubSubClient, channelID: string): void;
  unsub(this: PubSubClient, channelID: string): void;
  getNextRandomDelay(this: PubSubClient): number;
  setKvFilter(this: PubSubClient, channelID: string, kvFilter?: string[]): void;
};

type ClientEventHandlers = {
  close(this: PubSubClient, event: CloseEvent): void;
  error(this: PubSubClient, event: Event): void;
  message(this: PubSubClient, event: MessageEvent): void;
  offline(this: PubSubClient, event: Event): void;
  online(this: PubSubClient, event: Event): void;
  open(this: PubSubClient, event: Event): void;
  'reconnection-attempt'(this: PubSubClient, event: CustomEvent): void;
  'reconnection-succeeded'(this: PubSubClient, event: CustomEvent): void;
  'reconnection-failed'(this: PubSubClient, event: CustomEvent): void;
  'reconnection-scheduled'(this: PubSubClient, event: CustomEvent): void;
  'subscription-succeeded'(this: PubSubClient, event: CustomEvent): void;
};

type MessageHandlers = {
  [NOTIFICATION_TYPE.ENTRY](
    this: PubSubClient,
    msg: { data: JSONType; type: string; [x: string]: unknown },
  ): void;
  [NOTIFICATION_TYPE.PING](this: PubSubClient, msg: { data: JSONType }): void;
  [NOTIFICATION_TYPE.PUB](this: PubSubClient, msg: { channelID: string; data: JSONType }): void;
  [NOTIFICATION_TYPE.KV](
    this: PubSubClient,
    msg: { channelID: string; key: string; data: JSONType; cid?: string },
  ): void;
  [NOTIFICATION_TYPE.SUB](
    this: PubSubClient,
    msg: { channelID: string; type: string; data: JSONType },
  ): void;
  [NOTIFICATION_TYPE.UNSUB](
    this: PubSubClient,
    msg: { channelID: string; type: string; data: JSONType },
  ): void;
  [RESPONSE_TYPE.ERROR](
    this: PubSubClient,
    msg: {
      data: {
        type: string;
        channelID: string;
        data: JSONType;
        reason: string;
        actionType?: string;
        message?: string;
      };
    },
  ): void;
  [RESPONSE_TYPE.OK](this: PubSubClient, msg: { data:
    { type: string; channelID: string; kvFilter?: string[] }
  }): void;
};

export type PubMessage = {
  type: 'pub';
  channelID: string;
  data: JSONType;
};

export type SubMessage = {
  [key: string]: JSONType;
  type: 'sub';
  channelID: string;
} & { kvFilter?: Array<string> };

export type UnsubMessage = {
  [key: string]: JSONType;
  type: 'unsub';
  channelID: string;
};

// TODO: verify these are good defaults
const defaultOptions: Options = {
  logPingMessages: process.env.NODE_ENV === 'development' && !process.env.CI,
  pingTimeout: 45000,
  maxReconnectionDelay: 60000,
  maxRetries: 10,
  minReconnectionDelay: 500,
  reconnectOnDisconnection: true,
  reconnectOnOnline: true,
  // Defaults to false to avoid reconnection attempts in case the server doesn't
  // respond because of a failed authentication.
  reconnectOnTimeout: false,
  reconnectionDelayGrowFactor: 2,
  timeout: 60000,
  maxOpRetries: 4,
  opRetryInterval: 2000
}

// ====== Event name constants ====== //

export const PUBSUB_ERROR = 'pubsub-error'
export const PUBSUB_RECONNECTION_ATTEMPT = 'pubsub-reconnection-attempt'
export const PUBSUB_RECONNECTION_FAILED = 'pubsub-reconnection-failed'
export const PUBSUB_RECONNECTION_SCHEDULED = 'pubsub-reconnection-scheduled'
export const PUBSUB_RECONNECTION_SUCCEEDED = 'pubsub-reconnection-succeeded'
export const PUBSUB_SUBSCRIPTION_SUCCEEDED = 'pubsub-subscription-succeeded'
// Emitted as `(client, { state, previous })` whenever `client.state` changes.
// The first one (`closed -> connecting`) is emitted by `createClient`, before
// it returns the client. `getStatus()` can emit it too, if the socket changed
// state without an event (e.g., it started closing).
export const PUBSUB_STATE_CHANGED = 'pubsub-state-changed'
// Emitted as `(client, { channelID, reason })` when the server rejects a SUB
// request. The subscription is no longer pending; Chelonia requests it again
// the next time it reconciles its subscriptions.
export const PUBSUB_SUBSCRIPTION_FAILED = 'pubsub-subscription-failed'

// ====== Helpers ====== //

class TieredMap <K, L, V> extends Map<K, Map<L, V>> {
  tGet (k1: K, k2: L): V | undefined {
    return this.get(k1)?.get(k2)
  }

  tHas (k1: K, k2: L): boolean {
    return !!this.get(k1)?.has(k2)
  }

  tSet (k1: K, k2: L, v: V): Map<L, V> {
    let submap = this.get(k1)
    if (!submap) {
      submap = new Map<L, V>()
      this.set(k1, submap)
    }
    return submap.set(k2, v)
  }

  tDelete (k1: K, k2: L): boolean {
    const submap = this.get(k1)
    if (submap) {
      const result = submap.delete(k2)
      if (submap.size === 0) {
        this.delete(k1)
      }
      return result
    }
    return false
  }

  tClear (k1: K) {
    this.delete(k1)
  }
}

// `PubSubStatus.oldestPendingSince`, for the pending SUBs of `channelIDs`
// (by default, of every channel)
export function oldestPendingSubSince (
  client: PubSubClient,
  channelIDs?: Iterable<string>
): number | null {
  const pending = client.pendingOperations.get(REQUEST_TYPE.SUB)
  if (!pending) return null
  let oldest: number | null = null
  for (const id of channelIDs ?? pending.keys()) {
    const since = pending.get(id)?.since
    if (since !== undefined && (oldest === null || since < oldest)) oldest = since
  }
  return oldest
}

// A connection works once every pending SUB and KV filter is answered (an
// ERROR is an answer too), or if it has none to send: only then may
// replacements over unanswered requests stop backing off
const noteAnsweredRequests = (client: PubSubClient) => {
  if (
    !client.pendingOperations.get(REQUEST_TYPE.SUB)?.size &&
    !client.pendingOperations.get(REQUEST_TYPE.KV_FILTER)?.size
  ) {
    client.unansweredReplacements = 0
  }
}

const isKvFilterFresh = (
  ourKvFilter: Readonly<string[]> | null | undefined,
  theirKvFilter: Readonly<string[]> | null | undefined
): boolean => {
  // If we don't have a KV filter and the server does, or vice versa,
  // the filter isn't fresh
  if (!ourKvFilter !== !theirKvFilter) {
    return false
  } else if (ourKvFilter && theirKvFilter) {
    // If both have a KV filter, set the KV filter if they differ
    //   (XOR: return false if exactly one of them is truthy)
    if (ourKvFilter.length !== theirKvFilter.length) {
      // Fast path: different length must mean the filter is different
      return false
    } else {
      const sortedA = [...ourKvFilter].sort()
      const sortedB = [...theirKvFilter].sort()
      for (let i = 0; i < sortedA.length; i++) {
        if (sortedA[i] !== sortedB[i]) {
          return false
        }
      }
    }
  }

  return true
}

const pubPayloadFactory = (client: PubSubClient, channelID: string) => () => {
  const kvFilter = client.kvFilter.get(channelID)
  return kvFilter ? { kvFilter, channelID } : { channelID } as JSONObject
}

// Close code for sockets that we stopped trusting
const ABANDONED_SOCKET_CLOSE_CODE = 4001

// When each socket was created and opened, for the `close` log line
const socketTimes = new WeakMap<WebSocket, { createdAt: number; openedAt?: number }>()

// How long the closing socket was open and how long ago it last got a
// message, e.g. to tell a dead connection from a server-side close
const describeClosingSocket = (client: PubSubClient): string => {
  const times = client.socket ? socketTimes.get(client.socket) : undefined
  if (!times) return 'unknown socket'
  const now = Date.now()
  if (times.openedAt === undefined) {
    return `never opened (connecting for ${now - times.createdAt} ms)`
  }
  const { lastMessageAt } = client
  const lastMessage = lastMessageAt === undefined
    ? ''
    : `, last message ${now - lastMessageAt} ms ago`
  return `open for ${now - times.openedAt} ms${lastMessage}`
}

const createCloseEvent = (code: number, reason: string): CloseEvent => {
  if (typeof CloseEvent === 'function') {
    return new CloseEvent('close', { code, reason, wasClean: false })
  }
  return Object.assign(new Event('close'), { code, reason, wasClean: false }) as CloseEvent
}

// Throws away a socket that we no longer trust, e.g., one on which requests
// go unanswered, one that stopped receiving pings or one whose network went
// away. A dead connection (such as a half-open one after the device
// slept) can still report OPEN, and closing it may not fire `close` for
// minutes, so instead of waiting for that event, this runs the regular
// `close` logic right away: it detaches the listeners from the socket,
// re-arms every wanted subscription, clears the subscription set and
// schedules a reconnection (unless we are offline).
function abandonSocket (
  client: PubSubClient,
  socket: WebSocket | null | undefined,
  reason: string
) {
  if (!socket || client.socket !== socket) return
  console.warn(`[pubsub] Abandoning socket: ${reason}`)
  client.listeners.close?.call(client, createCloseEvent(ABANDONED_SOCKET_CLOSE_CODE, reason))
  try {
    // The reason can be at most 123 bytes long
    socket.close(ABANDONED_SOCKET_CLOSE_CODE, reason.slice(0, 120))
  } catch {
    try {
      socket.close(ABANDONED_SOCKET_CLOSE_CODE)
    } catch {}
  }
}

// (Re)starts the ping timer of the current socket: no message from the
// server within `pingTimeout` ms means that the connection is dead.
function armPingTimeout (client: PubSubClient) {
  const { socket } = client
  const pingTimeout = timerDelay(client.options.pingTimeout)
  clearTimeout(client.pingTimeoutID)
  client.pingTimeoutID = undefined
  if (!socket || pingTimeout === undefined) return
  client.pingTimeoutID = setTimeout(() => {
    abandonSocket(client, socket, 'ping timeout')
  }, pingTimeout)
}

// Timers don't run while the device sleeps, so after waking up the ping timer
// needs up to `pingTimeout` ms of awake time to notice that the connection
// died in the meantime. `Date.now()` jumps forward on wake-up, so comparing
// it with the time of the last message notices the silence within seconds.
function startWallClockWatchdog (client: PubSubClient) {
  const { socket } = client
  const pingTimeout = timerDelay(client.options.pingTimeout)
  clearInterval(client.wallClockWatchdogID)
  client.wallClockWatchdogID = undefined
  if (!socket || pingTimeout === undefined) return
  const watchdogID = setInterval(() => {
    // `clearAllTimers()` normally stops it before the socket changes
    if (client.socket !== socket) {
      clearInterval(watchdogID)
      return
    }
    const { lastMessageAt } = client
    if (lastMessageAt !== undefined && Date.now() - lastMessageAt > pingTimeout) {
      abandonSocket(client, socket, 'ping timeout (wall clock)')
    }
  }, Math.min(5000, Math.max(1000, pingTimeout / 3)))
  client.wallClockWatchdogID = watchdogID
}

function runWithRetry (
  client: PubSubClient,
  channelID: string,
  type: RequestTypeEnum,
  getPayload: () => JSONObject
) {
  let attemptNo = 0
  const { socket, options } = client
  // `runWithRetry` will use reference equality to determine freshness.
  const instance: PendingOperation = {}

  client.pendingOperations.tSet(type, channelID, instance)

  const send = () => {
    // 1. Closure check: ensure socket instance hasn't been replaced
    if (client.socket !== socket || socket?.readyState !== WebSocket.OPEN) return

    // 2a. Cancellation check
    const currentInstance = client.pendingOperations.tGet(type, channelID)
    if (currentInstance !== instance) return

    // 2b. Retries check
    if (attemptNo++ > options.maxOpRetries) {
      if (!options.reconnectOnDisconnection) {
        // Nothing would replace the connection, so keep it (and every other
        // subscription) and drop only this request
        console.warn(`[pubsub] Giving up ${type} for channel`, channelID)
        client.pendingOperations.tDelete(type, channelID)
        return
      }
      // The request is still wanted, so it stays pending. No response within
      // the whole retry budget means that this connection doesn't work:
      // replace it. The `close` logic settles every pending request (SUBs
      // are sent again on the next connection; UNSUBs are done, since the
      // server drops the subscriptions of a closed connection; KV filters
      // are sent along with the SUBs).
      client.unansweredReplacements++
      abandonSocket(client, socket, `no response to ${type} for ${channelID}`)
      return
    }

    // 3. Send logic
    const payload = getPayload()

    socket.send(createRequest(type, payload))
    // When it was first sent on this connection, not when it was queued
    instance.since ??= Date.now()

    // 4. Schedule retry
    // Randomness / jitter to prevent bursts
    const minDelay = (attemptNo - 1) * options.opRetryInterval
    const jitter = randomIntFromRange(0, options.opRetryInterval)
    const delay = minDelay + jitter
    // Without a connection, `send` does nothing: this mustn't keep a Node.js
    // process alive after `destroy()`
    unrefTimer(setTimeout(send, delay))
  }

  send()
}

// ====== API ====== //

/**
 * Creates a pubsub client instance.
 *
 * @param {string} url - A WebSocket URL to connect to.
 * @param {Object?} options
 * {object?} handlers - Custom handlers for WebSocket events.
 * {boolean?} logPingMessages - Whether to log received pings.
 * {boolean?} manual - Whether the factory should call 'connect()' automatically.
 *   Also named 'autoConnect' or 'startClosed' in other libraries.
 * {object?} messageHandlers - Custom handlers for different message types.
 * {number?} pingTimeout=45_000 - How long to wait for a message from the server (it pings
 *   regularly) before replacing the connection, in milliseconds. 0 or Infinity disables it.
 * {boolean?} reconnectOnDisconnection=true - Whether to reconnect after a server-side disconnection.
 * {boolean?} reconnectOnOnline=true - Whether to reconnect after coming back online.
 * {boolean?} reconnectOnTimeout=false - Whether to reconnect after a connection timeout.
 * {number?} timeout=5_000 - Connection timeout duration in milliseconds.
 * @returns {PubSubClient}
 */
export function createClient (url: string, options: Partial<Options> = {}): PubSubClient {
  const client: PubSubClient = {
    customEventHandlers: options.handlers || {},
    // The current number of connection attempts that failed.
    // Reset to 0 upon successful connection.
    // Used to compute how long to wait before the next reconnection attempt.
    failedConnectionAttempts: 0,
    isLocal: /\/\/(localhost|127\.0\.0\.1)([:?/]|$)/.test(url),
    // True if this client has never been connected yet.
    isNew: true,
    lastMessageAt: undefined,
    listeners: Object.create(null),
    messageHandlers: { ...defaultMessageHandlers, ...options.messageHandlers },
    nextConnectionAttemptDelayID: undefined,
    options: { ...defaultOptions, ...options },
    pendingOperations: new TieredMap(),
    pingTimeoutID: undefined,
    shouldReconnect: true,
    // The underlying WebSocket object.
    // A new one is necessary for every connection or reconnection attempt.
    socket: null,
    state: 'closed',
    stateSince: Date.now(),
    subscriptionSet: new Set(),
    kvFilter: new Map(),
    connectionTimeoutID: undefined,
    unansweredReplacements: 0,
    url: url.replace(/^http/, 'ws'),
    wallClockWatchdogID: undefined,
    ...publicMethods
  }
  // Create and save references to reusable event listeners.
  // Every time a new underlying WebSocket object will be created for this
  // client instance, these event listeners will be detached from the older
  // socket then attached to the new one, hereby avoiding both unnecessary
  // allocations and garbage collections of a bunch of functions every time.
  // Another benefit is the ability to patch the client protocol at runtime by
  // updating the client's custom event handler map.
  for (const name of Object.keys(
    defaultClientEventHandlers
  ) as (keyof typeof defaultClientEventHandlers)[]) {
    client.listeners[name] = (event) => {
      try {
        // Use `.call()` to pass the client via the 'this' binding.
        (defaultClientEventHandlers[name] as (this: PubSubClient, ev: typeof event) => void).call(
          client,
          event
        );
        (client.customEventHandlers[name] as (this: PubSubClient, ev: typeof event) => void)?.call(
          client,
          event
        )
      } catch (error) {
        // Do not throw any error but emit an `error` event instead.
        sbp('okTurtles.events/emit', PUBSUB_ERROR, client, (error as Error)?.message)
      }
    }
  }
  // Add global event listeners before the first connection.
  if (typeof self === 'object' && self instanceof EventTarget) {
    for (const name of globalEventNames) {
      globalEventMap.set(name, client.listeners[name])
    }
  }
  // The initial state (no event)
  client.state = computeState(client)
  if (!client.options.manual) {
    client.connect()
  }
  return client
}

export function createMessage (
  type: string,
  data: JSONType,
  meta?: object | null | undefined
): { type: string; data: JSONType; [x: string]: JSONType } {
  const message = { ...meta, type, data }
  let string: string
  const stringify = function (this: typeof message) {
    if (!string) string = JSON.stringify(this)
    return string
  }
  Object.defineProperties(message, {
    [Symbol.toPrimitive]: {
      value: stringify
    }
  })
  return message
}

export function createKvMessage (
  channelID: string, key: string, data: JSONType, cid?: string
): string {
  return JSON.stringify({ type: NOTIFICATION_TYPE.KV, channelID, key, data, cid })
}

export function createPubMessage (channelID: string, data: JSONType): string {
  return JSON.stringify({ type: NOTIFICATION_TYPE.PUB, channelID, data })
}

export function createRequest (type: RequestTypeEnum, data: JSONObject): string {
  // Had to use Object.assign() instead of object spreading to make Flow happy.
  return JSON.stringify(Object.assign({ type }, data))
}

// These handlers receive the PubSubClient instance through the `this` binding.
const defaultClientEventHandlers: ClientEventHandlers = {
  // Emitted when the connection is closed.
  close (event) {
    const client = this

    console.info(
      `[pubsub] Event: close (code ${event.code}, reason ${JSON.stringify(event.reason)}), ` +
        describeClosingSocket(client)
    )
    client.failedConnectionAttempts++

    if (client.socket) {
      // Remove event listeners to avoid memory leaks.
      for (const name of socketEventNames) {
        client.socket.removeEventListener(name, client.listeners[name] as () => void)
      }
    }
    client.socket = null
    client.clearAllTimers()

    // This has been commented out to make the client always try to reconnect.
    // See https://github.com/okTurtles/group-income/issues/1246
    /*
    // See "Status Codes" https://tools.ietf.org/html/rfc6455#section-7.4
    switch (event.code) {
      // TODO: verify that this list of codes is correct.
      case 1000: case 1002: case 1003: case 1007: case 1008: {
        client.shouldReconnect = false
        break
      }
      default: break
    }
    */
    // If we should reconnect then consider our current subscriptions as pending again,
    // waiting to be restored upon reconnection.
    if (client.shouldReconnect) {
      // `runWithRetry` will (later) use reference equality to determine freshness.
      // In order to abort current send attempts, but still being able to restore
      // existing subscriptions upon reconnection, we set pendingSubscriptionMap
      // to a different instance value. Deleting values from
      // `pendingSubscriptionMap` could also work, but then we'd need to save
      // the list of existing keys somewhere else.
      const pendingSubscriptionMap = client.pendingOperations.get(REQUEST_TYPE.SUB)
      if (pendingSubscriptionMap) {
        for (const [channelID] of pendingSubscriptionMap) {
          pendingSubscriptionMap.set(channelID, {})
        }
      }
      client.subscriptionSet.forEach((channelID) => {
        // Skip contracts from which we had to unsubscribe anyway.
        if (!client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, channelID)) {
          client.pendingOperations.tSet(REQUEST_TYPE.SUB, channelID, {})
        }
      })
    }
    // We are no longer subscribed to any contracts since we are now disconnected.
    client.subscriptionSet.clear()
    client.pendingOperations.tClear(REQUEST_TYPE.UNSUB)
    client.pendingOperations.tClear(REQUEST_TYPE.KV_FILTER)

    if (client.shouldReconnect && client.options.reconnectOnDisconnection) {
      if (client.failedConnectionAttempts > client.options.maxRetries) {
        sbp('okTurtles.events/emit', PUBSUB_RECONNECTION_FAILED, client)
      } else {
        // If we are definetely offline then do not try to reconnect now,
        // unless the server is local.
        if (!isDefinetelyOffline() || client.isLocal) {
          client.scheduleConnectionAttempt()
        }
      }
    }
    updateState(client)
  },

  // Emitted when an error has occured.
  // The socket will be closed automatically by the engine if necessary.
  // PUBSUB_ERROR (e.g., a message handler threw) also reaches it, on a socket
  // that may still work, so it leaves the ping timer alone.
  error (event) {
    // Not all error events should be logged with console.error, for example every
    // failed connection attempt generates one such event.
    console.warn('[pubsub] Event: error', event)
  },

  // Emitted when a message is received.
  // The connection will be terminated if the message is malformed or has an
  // unexpected data type (e.g. binary instead of text).
  message (event: MessageEvent) {
    const client = this
    const { data } = event

    client.lastMessageAt = Date.now()
    // Any message shows that the connection works, like the wall-clock
    // watchdog assumes
    armPingTimeout(client)
    if (typeof data !== 'string') {
      sbp('okTurtles.events/emit', PUBSUB_ERROR, client, {
        message: `Wrong data type: ${typeof data}`
      })
      return client.destroy()
    }
    let msg: Message = { type: '' }

    try {
      msg = messageParser(data)
    } catch (error) {
      sbp('okTurtles.events/emit', PUBSUB_ERROR, client, {
        message: `Malformed message: ${(error as Error)?.message}`
      })
      return client.destroy()
    }
    const handler = client.messageHandlers[msg.type as keyof typeof client.messageHandlers]

    if (handler) {
      (handler as (msg: Message) => void).call(client, msg)
    } else {
      throw new Error(`Unhandled message type: ${msg.type}`)
    }
  },

  offline () {
    console.info('[pubsub] Event: offline')
    const client = this

    client.clearAllTimers()
    // Reset the connection attempt counter so that we'll start a new
    // reconnection loop when we are back online.
    client.failedConnectionAttempts = 0
    // Without a network, the closing handshake may not complete for a long
    // time; don't wait for it. No reconnection is scheduled while offline.
    abandonSocket(client, client.socket, 'offline')
    updateState(client)
  },

  online () {
    console.info('[pubsub] Event: online')
    const client = this

    if (client.options.reconnectOnOnline && client.shouldReconnect) {
      // A socket that is neither OPEN nor CONNECTING when the network comes
      // back is closing, which never finishes if its connection is dead:
      // replace it now.
      const readyState = client.socket?.readyState
      if (
        readyState !== undefined &&
        readyState !== WebSocket.OPEN &&
        readyState !== WebSocket.CONNECTING
      ) {
        abandonSocket(client, client.socket, 'online, socket not open')
      }
      // Abandoning the socket may also have given up reconnecting (and
      // destroyed the client)
      if (!client.socket && client.shouldReconnect) {
        // The network changed, so both back-offs start over
        client.failedConnectionAttempts = 0
        client.unansweredReplacements = 0
        // Abandoning the socket may have scheduled the attempt already
        if (!client.nextConnectionAttemptDelayID) client.scheduleConnectionAttempt()
      }
    }
    updateState(client)
  },

  // Emitted when the connection is established.
  open () {
    console.debug('[pubsub] Event: open')
    const client = this

    const times = client.socket ? socketTimes.get(client.socket) : undefined
    if (times) times.openedAt = Date.now()
    client.connectionTimeUsed = undefined
    client.clearAllTimers()
    sbp('okTurtles.events/emit', PUBSUB_RECONNECTION_SUCCEEDED, client)

    // Set it to -1 so that it becomes 0 on the next `close` event.
    client.failedConnectionAttempts = -1
    client.isNew = false
    // Setup a ping timeout if required.
    // It will replace the connection if we don't get any message from the server.
    client.lastMessageAt = Date.now()
    armPingTimeout(client)
    startWallClockWatchdog(client)
    // Send any pending subscription request.
    for (const [channelID] of client.pendingOperations.get(REQUEST_TYPE.SUB) || []) {
      runWithRetry(client, channelID, REQUEST_TYPE.SUB, pubPayloadFactory(client, channelID))
    }
    // E.g. replaced over an UNSUB, which the close settled
    noteAnsweredRequests(client)
    // There should be no pending unsubscription since we just got connected.
    updateState(client)
  },

  'reconnection-attempt' () {
    console.info('[pubsub] Trying to reconnect...')
  },

  'reconnection-succeeded' () {
    console.info('[pubsub] Connection re-established')
  },

  'reconnection-failed' () {
    console.warn('[pubsub] Reconnection failed')
    const client = this

    client.destroy()
  },

  'reconnection-scheduled' (event) {
    const { delay, nth } = event.detail
    console.info(`[pubsub] Scheduled connection attempt ${nth} in ~${delay} ms`)
  },

  'subscription-succeeded' (event) {
    const { channelID } = event.detail
    console.debug(`[pubsub] Subscribed to channel ${channelID}`)
  }
}

// These handlers receive the PubSubClient instance through the `this` binding.
const defaultMessageHandlers: MessageHandlers = {
  [NOTIFICATION_TYPE.ENTRY] (msg) {
    console.debug('[pubsub] Received ENTRY:', msg)
  },

  [NOTIFICATION_TYPE.PING] ({ data }) {
    const client = this

    if (client.options.logPingMessages) {
      console.debug(`[pubsub] Ping received in ${Date.now() - Number(data)} ms`)
    }
    // Reply with a pong message using the same data.
    // TODO: Type coercion to string because we actually support passing this
    // object type, but the correct TypeScript type hasn't been written.
    client.socket?.send(createMessage(NOTIFICATION_TYPE.PONG, data) as unknown as string)
  },

  [NOTIFICATION_TYPE.PUB] ({ channelID, data }) {
    console.log(`[pubsub] Received data from channel ${channelID}:`, data)
    // No need to reply.
  },

  [NOTIFICATION_TYPE.KV] ({ channelID, key, data }) {
    console.log(`[pubsub] Received KV update from channel ${channelID} ${key}:`, data)
    // No need to reply.
  },

  [NOTIFICATION_TYPE.SUB] (msg) {
    console.debug(`[pubsub] Ignoring ${msg.type} message:`, msg.data)
  },

  [NOTIFICATION_TYPE.UNSUB] (msg) {
    console.debug(`[pubsub] Ignoring ${msg.type} message:`, msg.data)
  },

  [RESPONSE_TYPE.ERROR] ({ data }) {
    const { type, channelID, reason } = data
    console.warn(`[pubsub] Received ERROR response for ${type} request to ${channelID}`)
    const client = this

    switch (type) {
      case REQUEST_TYPE.SUB: {
        console.warn(`[pubsub] Could not subscribe to ${channelID}: ${reason}`)
        if (client.pendingOperations.tDelete(REQUEST_TYPE.SUB, channelID)) {
          sbp('okTurtles.events/emit', PUBSUB_SUBSCRIPTION_FAILED, client, { channelID, reason })
          noteAnsweredRequests(client)
        }
        break
      }
      case REQUEST_TYPE.UNSUB: {
        console.warn(`[pubsub] Could not unsubscribe from ${channelID}: ${reason}`)
        client.pendingOperations.tDelete(REQUEST_TYPE.UNSUB, channelID)
        break
      }
      case REQUEST_TYPE.PUSH_ACTION: {
        const { actionType, message } = data
        console.warn(
          `[pubsub] Received ERROR for PUSH_ACTION request with the action type '${actionType}' and the following message: ${message}`
        )
        break
      }
      case REQUEST_TYPE.KV_FILTER: {
        console.warn(`[pubsub] Could not set KV filter for ${channelID}: ${reason}`)
        if (client.pendingOperations.tDelete(REQUEST_TYPE.KV_FILTER, channelID)) {
          noteAnsweredRequests(client)
        }
        break
      }
      default: {
        console.error(`[pubsub] Malformed response: invalid request type ${type}`)
      }
    }
  },

  [RESPONSE_TYPE.OK] ({ data: { type, channelID, kvFilter } }) {
    const client = this

    switch (type) {
      case REQUEST_TYPE.SUB: {
        const pending = client.pendingOperations.tGet(REQUEST_TYPE.SUB, channelID)
        if (pending) {
          const elapsed = pending.since === undefined ? 0 : Date.now() - pending.since
          if (elapsed > client.options.opRetryInterval) {
            console.info(`[pubsub] Late ACK: subscribed to ${channelID} ${elapsed} ms after the request`)
          }
          client.pendingOperations.tDelete(REQUEST_TYPE.SUB, channelID)
          client.subscriptionSet.add(channelID)
          sbp('okTurtles.events/emit', PUBSUB_SUBSCRIPTION_SUCCEEDED, client, { channelID })
          const ourKvFilter = client.kvFilter.get(channelID)
          if (!isKvFilterFresh(ourKvFilter, kvFilter)) {
            console.debug(`[pubsub] Subscribed to ${channelID}, need to set new KV filter`)
            this.setKvFilter(channelID, ourKvFilter)
          }
          noteAnsweredRequests(client)
        } else if (client.subscriptionSet.has(channelID)) {
          // The answer to one of our retries; `Late ACK` reported the delay
          console.debug(`[pubsub] Received duplicate sub ACK for ${channelID}`)
        } else {
          console.info(`[pubsub] Received unexpected sub for ${channelID} (not requested)`)
        }
        break
      }
      case REQUEST_TYPE.UNSUB: {
        if (client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, channelID)) {
          console.debug(`[pubsub] Unsubscribed from ${channelID}`)
          client.pendingOperations.tDelete(REQUEST_TYPE.UNSUB, channelID)
          client.subscriptionSet.delete(channelID)
        } else {
          console.debug(`[pubsub] Received unexpected unsub for ${channelID}`)
        }
        break
      }
      case REQUEST_TYPE.KV_FILTER: {
        if (client.pendingOperations.tHas(REQUEST_TYPE.KV_FILTER, channelID)) {
          const ourKvFilter = client.kvFilter.get(channelID)
          if (isKvFilterFresh(ourKvFilter, kvFilter)) {
            console.debug(`[pubsub] Set KV filter for ${channelID}`, kvFilter)
            client.pendingOperations.tDelete(REQUEST_TYPE.KV_FILTER, channelID)
            noteAnsweredRequests(client)
          } else {
            console.debug(`[pubsub] Received stale KV filter ack for ${channelID}`, kvFilter, ourKvFilter)
          }
        } else {
          console.debug(`[pubsub] Received unexpected kv-filter for ${channelID}`)
        }
        break
      }
      default: {
        console.error(`[pubsub] Malformed response: invalid request type ${type}`)
      }
    }
  }
}

const globalEventNames = ['offline', 'online'] as const
const socketEventNames = ['close', 'error', 'message', 'open'] as const
// eslint-disable-next-line func-call-spacing
const globalEventMap = new Map<string, (ev: Event) => void>()

if (typeof self === 'object' && self instanceof EventTarget) {
  // We need to do things in this roundabout way because Chrome doesn't like
  // these events handlers not being top-level.
  // `Event handler of 'online' event must be added on the initial evaluation of worker script.`
  for (const name of globalEventNames) {
    const handler = (ev: Event) => {
      const h = globalEventMap.get(name)
      return h?.(ev)
    }
    self.addEventListener(name, handler, false)
  }
}

// `navigator.onLine` can give confusing false positives when `true`,
// so we'll define `isDefinetelyOffline()` rather than `isOnline()` or `isOffline()`.
// See https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
const isDefinetelyOffline = () => typeof navigator === 'object' && navigator.onLine === false

const computeState = (client: PubSubClient): PubSubState => {
  // The socket's own constants: `createClient` and `destroy()` call this
  // without a socket, and then a global `WebSocket` isn't needed
  const { socket } = client
  if (socket) {
    if (socket.readyState === socket.OPEN) return 'open'
    if (socket.readyState === socket.CONNECTING) return 'connecting'
  }
  if (!client.shouldReconnect) return 'closed'
  if (isDefinetelyOffline()) return 'offline'
  if (client.nextConnectionAttemptDelayID !== undefined || client.socket) return 'reconnecting'
  return 'closed'
}

// Called at the end of every handler and method that can change the state
const updateState = (client: PubSubClient) => {
  const state = computeState(client)
  if (state === client.state) return
  const previous = client.state
  client.state = state
  client.stateSince = Date.now()
  console.debug(`[pubsub] State: ${previous} -> ${state}`)
  sbp('okTurtles.events/emit', PUBSUB_STATE_CHANGED, client, { state, previous })
}

// Parses and validates a received message.
export const messageParser = (data: string): Message => {
  const msg = JSON.parse(data)

  if (typeof msg !== 'object' || msg === null) {
    throw new TypeError('Message is null or not an object')
  }
  const { type } = msg

  if (typeof type !== 'string' || type === '') {
    throw new TypeError('Message type must be a non-empty string')
  }
  return msg
}

const publicMethods: {
  clearAllTimers(this: PubSubClient): void;
  connect(this: PubSubClient): void;
  destroy(this: PubSubClient): void;
  getStatus(this: PubSubClient): PubSubStatus;
  pub(this: PubSubClient, channelID: string, data: JSONType): void;
  scheduleConnectionAttempt(this: PubSubClient): void;
  sub(this: PubSubClient, channelID: string): void;
  setKvFilter(this: PubSubClient, channelID: string, kvFilter?: string[]): void;
  unsub(this: PubSubClient, channelID: string): void;
  getNextRandomDelay(this: PubSubClient): number;
} = {
  clearAllTimers () {
    const client = this

    clearTimeout(client.connectionTimeoutID)
    clearTimeout(client.nextConnectionAttemptDelayID)
    clearTimeout(client.pingTimeoutID)
    clearInterval(client.wallClockWatchdogID)
    client.connectionTimeoutID = undefined
    client.nextConnectionAttemptDelayID = undefined
    client.pingTimeoutID = undefined
    client.wallClockWatchdogID = undefined
  },

  // Performs a connection or reconnection attempt.
  connect () {
    const client = this

    if (client.socket !== null) {
      throw new Error('connect() can only be called if there is no current socket.')
    }
    if (client.nextConnectionAttemptDelayID) {
      throw new Error('connect() must not be called during a reconnection delay.')
    }
    if (!client.shouldReconnect) {
      throw new Error('connect() should no longer be called on this instance.')
    }
    client.socket = new WebSocket(client.url)
    socketTimes.set(client.socket, { createdAt: Date.now() })
    // Sometimes (like when using `createMessage`), we want to send objects that
    // are serialized as strings. Native web sockets don't support objects, so
    // we use this workaround.
    client.socket.send = function (data) {
      const send = WebSocket.prototype.send.bind(this)
      if (
        typeof data === 'object' &&
        typeof (data as object as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive] ===
          'function'
      ) {
        return send(
          (data as object as { [Symbol.toPrimitive]: () => string })[Symbol.toPrimitive]()
        )
      }
      return send(data)
    }

    const timeout = timerDelay(client.options.timeout)
    if (timeout !== undefined) {
      const start = performance.now()
      const { socket } = client
      client.connectionTimeoutID = setTimeout(() => {
        client.connectionTimeoutID = undefined
        if (client.options.reconnectOnTimeout) {
          client.connectionTimeUsed = performance.now() - start
        }
        // Aborting a stuck connection attempt may not fire `close` soon either
        abandonSocket(client, socket, 'connection timeout')
      }, timeout)
    }
    // Attach WebSocket event listeners.
    for (const name of socketEventNames) {
      client.socket.addEventListener(name, client.listeners[name] as () => void)
    }
    updateState(client)
  },

  /**
   * Immediately close the socket, stop listening for events and clear any cache.
   *
   * This method is used in unit tests.
   * - In particular, no 'close' event handler will be called.
   * - Any incoming or outgoing buffered data will be discarded.
   * - Any pending messages will be discarded.
   */
  destroy () {
    const client = this

    client.clearAllTimers()
    // Update property values.
    // Note: do not clear 'client.options'.
    client.pendingOperations.clear()
    client.subscriptionSet.clear()
    // Remove global event listeners.
    if (typeof self === 'object' && self instanceof EventTarget) {
      for (const name of globalEventNames) {
        globalEventMap.delete(name)
      }
    }
    // Remove WebSocket event listeners.
    if (client.socket) {
      for (const name of socketEventNames) {
        client.socket.removeEventListener(name, client.listeners[name] as () => void)
      }
      client.socket.close()
    }
    client.listeners = Object.create(null)
    client.socket = null
    client.shouldReconnect = false
    updateState(client)
  },

  // Snapshot of the connection state and of the subscriptions
  getStatus () {
    const client = this

    // In case the state changed without an event that we handle (e.g., a
    // socket that started closing)
    updateState(client)
    const pending = client.pendingOperations.get(REQUEST_TYPE.SUB)
    return {
      state: client.state,
      since: client.stateSince,
      subscribed: [...client.subscriptionSet],
      pending: pending ? [...pending.keys()] : [],
      oldestPendingSince: oldestPendingSubSince(client)
    }
  },

  getNextRandomDelay (): number {
    const client = this

    const { maxReconnectionDelay, minReconnectionDelay, reconnectionDelayGrowFactor } =
      client.options

    const attempts = Math.max(client.failedConnectionAttempts, client.unansweredReplacements)
    // Both counters are unbounded (e.g., `maxRetries: Infinity`), and with the
    // defaults the uncapped value overflows from 1016 attempts on (a `NaN` delay)
    const minDelay = Math.min(
      maxReconnectionDelay,
      minReconnectionDelay * reconnectionDelayGrowFactor ** attempts
    )
    const maxDelay = minDelay * reconnectionDelayGrowFactor
    const connectionTimeUsed = client.connectionTimeUsed
    client.connectionTimeUsed = undefined

    return Math.min(
      // See issue #1943: Have the connection time used 'eat into' the
      // reconnection time used
      Math.max(
        minReconnectionDelay,
        connectionTimeUsed ? maxReconnectionDelay - connectionTimeUsed : maxReconnectionDelay
      ),
      Math.round(minDelay + (0, Math.random)() * (maxDelay - minDelay))
    )
  },

  // Schedules a connection attempt to happen after a delay computed according to
  // a randomized exponential backoff algorithm variant.
  scheduleConnectionAttempt () {
    const client = this

    if (!client.shouldReconnect) {
      throw new Error('Cannot call `scheduleConnectionAttempt()` when `shouldReconnect` is false.')
    }
    if (client.nextConnectionAttemptDelayID) {
      return console.warn('[pubsub] A reconnection attempt is already scheduled.')
    }
    const delay = client.getNextRandomDelay()
    const nth = client.failedConnectionAttempts + 1

    client.nextConnectionAttemptDelayID = setTimeout(() => {
      sbp('okTurtles.events/emit', PUBSUB_RECONNECTION_ATTEMPT, client)
      client.nextConnectionAttemptDelayID = undefined
      client.connect()
    }, delay)
    sbp('okTurtles.events/emit', PUBSUB_RECONNECTION_SCHEDULED, client, { delay, nth })
    updateState(client)
  },

  // Can be used to send ephemeral messages outside of any contract log.
  // Does nothing if the socket is not in the OPEN state.
  pub (channelID: string, data: JSONType) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(createPubMessage(channelID, data))
    }
  },
  /**
   * Sends a SUB request to the server as soon as possible.
   *
   * - The given channel ID will be cached until we get a relevant server
   * response, allowing us to resend the same request if necessary.
   * - Any identical UNSUB request that has not been sent yet will be cancelled.
   * - Calling this method again before the server has responded has no effect.
   * @param channelID - The ID of the channel whose updates we want to subscribe to.
   */
  sub (channelID: string) {
    const client = this

    // Wanted again while being left: cancel the UNSUB (the channel is still in
    // `subscriptionSet`) and send a SUB. The server gets it after the UNSUB, on
    // the same socket, so it ends up subscribed.
    if (client.pendingOperations.tDelete(REQUEST_TYPE.UNSUB, channelID)) {
      client.subscriptionSet.delete(channelID)
    }
    // In order to send subscribe to the server, we need to not be already
    // subscribed (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it
    // either being a pending operation or having it in `subscriptionSet`).
    if (
      !client.pendingOperations.tHas(REQUEST_TYPE.SUB, channelID) &&
      !client.subscriptionSet.has(channelID)
    ) {
      runWithRetry(client, channelID, REQUEST_TYPE.SUB, pubPayloadFactory(client, channelID))
    }
  },

  /**
   * Sends a KV_FILTER request to the server as soon as possible.
   */
  setKvFilter (channelID: string, kvFilter?: string[]) {
    const client = this

    if (kvFilter) {
      client.kvFilter.set(channelID, kvFilter)
    } else {
      client.kvFilter.delete(channelID)
    }

    // In order to send KV filter to the server, we need to first be subscribed
    // (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it either being
    // a pending operation or having it in `subscriptionSet`), and we also want
    // to ensure that we've not already sent REQUEST_TYPE.UNSUB.
    // Note that KV filter requires that a subscription exists for it to work,
    // and therefore we don't send anything if the subscription is pending
    // (unconfirmed). Instead, setting the KV filter in these cases will
    // be done in the `RESPONSE_TYPE.OK` function for REQUEST_TYPE.SUB.
    if (
      client.subscriptionSet.has(channelID) &&
      !client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, channelID)
    ) {
      runWithRetry(client, channelID, REQUEST_TYPE.KV_FILTER, pubPayloadFactory(client, channelID))
    }
  },

  /**
   * Sends an UNSUB request to the server as soon as possible.
   *
   * - The given channel ID will be cached until we get a relevant server
   * response, allowing us to resend the same request if necessary.
   * - Any identical SUB request that has not been sent yet will be cancelled.
   * - Calling this method again before the server has responded has no effect.
   * @param channelID - The ID of the channel whose updates we want to unsubscribe from.
   */
  unsub (channelID: string) {
    const client = this

    // In order to send unsubscribe to the server, we need to first be subscribed
    // (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it either being
    // a pending operation or having it in `subscriptionSet`), and we also want
    // to ensure that we've not already sent REQUEST_TYPE.UNSUB.
    if (
      !client.pendingOperations.tHas(REQUEST_TYPE.UNSUB, channelID) &&
      (
        client.subscriptionSet.has(channelID) ||
        client.pendingOperations.tHas(REQUEST_TYPE.SUB, channelID)
      )
    ) {
      client.pendingOperations.tDelete(REQUEST_TYPE.SUB, channelID)
      client.kvFilter.delete(channelID)

      runWithRetry(client, channelID, REQUEST_TYPE.UNSUB, () => ({ channelID }))
    }
  }
}

// Register custom SBP event listeners before the first connection.
for (const name of Object.keys(defaultClientEventHandlers)) {
  if (name === 'error' || !(socketEventNames as readonly string[]).includes(name)) {
    sbp('okTurtles.events/on', `pubsub-${name}`, (target: PubSubClient, detail?: object) => {
      const ev = new CustomEvent(name, { detail });
      (
        target.listeners[name as keyof ClientEventHandlers] as (
          this: typeof target,
          e: typeof ev,
        ) => void
      ).call(target, ev)
    })
  }
}

export default {
  NOTIFICATION_TYPE,
  REQUEST_TYPE,
  RESPONSE_TYPE,
  createClient,
  createMessage,
  createRequest
}
