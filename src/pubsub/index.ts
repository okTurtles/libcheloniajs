/* eslint-disable @typescript-eslint/no-this-alias */
import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import type { JSONObject, JSONType } from '../types.js'

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

export type NotificationTypeEnum = typeof NOTIFICATION_TYPE[keyof typeof NOTIFICATION_TYPE]
export type RequestTypeEnum = typeof REQUEST_TYPE[keyof typeof REQUEST_TYPE]
export type ResponseTypeEnum = typeof RESPONSE_TYPE[keyof typeof RESPONSE_TYPE]

// ====== Types ====== //

type TimeoutID = ReturnType<typeof setTimeout>

export type Options = {
  logPingMessages: boolean;
  pingTimeout: number;
  maxReconnectionDelay: number;
  maxRetries: number;
  minReconnectionDelay: number;
  reconnectOnDisconnection: boolean;
  reconnectOnOnline: boolean;
  reconnectOnTimeout: boolean;
  reconnectionDelayGrowFactor: number;
  timeout: number;
  manual?: boolean;
  // eslint-disable-next-line no-use-before-define
  handlers?: Partial<ClientEventHandlers>;
  // eslint-disable-next-line no-use-before-define
  messageHandlers?: Partial<MessageHandlers>;
}

export type Message = {
  [key: string]: JSONType,
  type: string
}

export type PubSubClient = {
  connectionTimeoutID: TimeoutID | undefined,
  connectionTimeUsed?: number,
  // eslint-disable-next-line no-use-before-define
  customEventHandlers: Partial<ClientEventHandlers>,
  failedConnectionAttempts: number,
  isLocal: boolean,
  isNew: boolean,
  // eslint-disable-next-line no-use-before-define
  listeners: ClientEventHandlers,
  // eslint-disable-next-line no-use-before-define
  messageHandlers: MessageHandlers,
  nextConnectionAttemptDelayID: TimeoutID | undefined,
  options: Options,
  pendingSubscriptionSet: Set<string>,
  pendingUnsubscriptionSet: Set<string>,
  pingTimeoutID: TimeoutID | undefined,
  shouldReconnect: boolean,
  socket: WebSocket | null,
  subscriptionSet: Set<string>,
  kvFilter: Map<string, string[]>,
  url: string,
  // Methods
  clearAllTimers(this: PubSubClient): void,
  connect(this: PubSubClient): void,
  destroy(this: PubSubClient): void,
  pub(this: PubSubClient, channelID: string, data: JSONType): void,
  scheduleConnectionAttempt(this: PubSubClient): void,
  sub(this: PubSubClient, channelID: string): void,
  unsub(this: PubSubClient, channelID: string): void,
  getNextRandomDelay(this: PubSubClient): number,
  setKvFilter(this: PubSubClient, channelID: string, kvFilter?: string[]): void
}

type ClientEventHandlers = {
  close (this: PubSubClient, event: CloseEvent): void,
  error (this: PubSubClient, event: Event): void,
  message (this: PubSubClient, event: MessageEvent): void,
  offline (this: PubSubClient, event: Event): void,
  online (this: PubSubClient, event: Event): void,
  open (this: PubSubClient, event: Event): void,
  'reconnection-attempt' (this: PubSubClient, event: CustomEvent): void,
  'reconnection-succeeded' (this: PubSubClient, event: CustomEvent): void,
  'reconnection-failed' (this: PubSubClient, event: CustomEvent): void,
  'reconnection-scheduled' (this: PubSubClient, event: CustomEvent): void,
  'subscription-succeeded' (this: PubSubClient, event: CustomEvent): void
}

type MessageHandlers = {
  [NOTIFICATION_TYPE.ENTRY](this: PubSubClient, msg: { data: JSONType, type: string, [x: string]: unknown }): void,
  [NOTIFICATION_TYPE.PING](this: PubSubClient, msg: { data: JSONType }): void,
  [NOTIFICATION_TYPE.PUB](this: PubSubClient, msg: { channelID: string, data: JSONType }): void,
  [NOTIFICATION_TYPE.KV](this: PubSubClient, msg: { channelID: string, key: string, data: JSONType }): void,
  [NOTIFICATION_TYPE.SUB](this: PubSubClient, msg: { channelID: string, type: string, data: JSONType }): void,
  [NOTIFICATION_TYPE.UNSUB](this: PubSubClient, msg: { channelID: string, type: string, data: JSONType }): void,
  [RESPONSE_TYPE.ERROR](this: PubSubClient, msg: { data: { type: string, channelID: string, data: JSONType, reason: string, actionType?: string, message?: string } }): void,
  [RESPONSE_TYPE.OK](this: PubSubClient, msg: { data: { type: string, channelID: string } }): void
}

export type PubMessage = {
  type: 'pub',
  channelID: string,
  data: JSONType
}

export type SubMessage = {
  [key: string]: JSONType,
  type: 'sub',
  channelID: string
} & { kvFilter?: Array<string> }

export type UnsubMessage = {
  [key: string]: JSONType,
  type: 'unsub',
  channelID: string
}

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
  timeout: 60000
}

// ====== Event name constants ====== //

export const PUBSUB_ERROR = 'pubsub-error'
export const PUBSUB_RECONNECTION_ATTEMPT = 'pubsub-reconnection-attempt'
export const PUBSUB_RECONNECTION_FAILED = 'pubsub-reconnection-failed'
export const PUBSUB_RECONNECTION_SCHEDULED = 'pubsub-reconnection-scheduled'
export const PUBSUB_RECONNECTION_SUCCEEDED = 'pubsub-reconnection-succeeded'
export const PUBSUB_SUBSCRIPTION_SUCCEEDED = 'pubsub-subscription-succeeded'

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
 * {number?} pingTimeout=45_000 - How long to wait for the server to send a ping, in milliseconds.
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
    listeners: Object.create(null),
    messageHandlers: { ...defaultMessageHandlers, ...options.messageHandlers },
    nextConnectionAttemptDelayID: undefined,
    options: { ...defaultOptions, ...options },
    // Requested subscriptions for which we didn't receive a response yet.
    pendingSubscriptionSet: new Set(),
    pendingUnsubscriptionSet: new Set(),
    pingTimeoutID: undefined,
    shouldReconnect: true,
    // The underlying WebSocket object.
    // A new one is necessary for every connection or reconnection attempt.
    socket: null,
    subscriptionSet: new Set(),
    kvFilter: new Map(),
    connectionTimeoutID: undefined,
    url: url.replace(/^http/, 'ws'),
    ...publicMethods
  }
  // Create and save references to reusable event listeners.
  // Every time a new underlying WebSocket object will be created for this
  // client instance, these event listeners will be detached from the older
  // socket then attached to the new one, hereby avoiding both unnecessary
  // allocations and garbage collections of a bunch of functions every time.
  // Another benefit is the ability to patch the client protocol at runtime by
  // updating the client's custom event handler map.
  for (const name of Object.keys(defaultClientEventHandlers) as (keyof typeof defaultClientEventHandlers)[]) {
    client.listeners[name] = (event) => {
      try {
        // Use `.call()` to pass the client via the 'this' binding.
        ;(defaultClientEventHandlers[name] as (this: PubSubClient, ev: typeof event) => void).call(client, event)
        ;(client.customEventHandlers[name] as (this: PubSubClient, ev: typeof event) => void)?.call(client, event)
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
  if (!client.options.manual) {
    client.connect()
  }
  return client
}

export function createMessage (type: string, data: JSONType, meta?: object | null | undefined): { type: string, data: JSONType, [x: string]: unknown } {
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

export function createKvMessage (channelID: string, key: string, data: JSONType): string {
  return JSON.stringify({ type: NOTIFICATION_TYPE.KV, channelID, key, data })
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

    console.debug('[pubsub] Event: close', event.code, event.reason)
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
      client.subscriptionSet.forEach((channelID) => {
        // Skip contracts from which we had to unsubscribe anyway.
        if (!client.pendingUnsubscriptionSet.has(channelID)) {
          client.pendingSubscriptionSet.add(channelID)
        }
      })
    }
    // We are no longer subscribed to any contracts since we are now disconnected.
    client.subscriptionSet.clear()
    client.pendingUnsubscriptionSet.clear()

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
  },

  // Emitted when an error has occured.
  // The socket will be closed automatically by the engine if necessary.
  error (event) {
    const client = this
    // Not all error events should be logged with console.error, for example every
    // failed connection attempt generates one such event.
    console.warn('[pubsub] Event: error', event)
    clearTimeout(client.pingTimeoutID)
  },

  // Emitted when a message is received.
  // The connection will be terminated if the message is malformed or has an
  // unexpected data type (e.g. binary instead of text).
  message (event: MessageEvent) {
    const client = this
    const { data } = event

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
    client.socket?.close()
  },

  online () {
    console.info('[pubsub] Event: online')
    const client = this

    if (client.options.reconnectOnOnline && client.shouldReconnect) {
      if (!client.socket) {
        client.failedConnectionAttempts = 0
        client.scheduleConnectionAttempt()
      }
    }
  },

  // Emitted when the connection is established.
  open () {
    console.debug('[pubsub] Event: open')
    const client = this
    const { options } = this

    client.connectionTimeUsed = undefined
    client.clearAllTimers()
    sbp('okTurtles.events/emit', PUBSUB_RECONNECTION_SUCCEEDED, client)

    // Set it to -1 so that it becomes 0 on the next `close` event.
    client.failedConnectionAttempts = -1
    client.isNew = false
    // Setup a ping timeout if required.
    // It will close the connection if we don't get any message from the server.
    if (options.pingTimeout > 0 && options.pingTimeout < Infinity) {
      client.pingTimeoutID = setTimeout(() => {
        client.socket?.close()
      }, options.pingTimeout)
    }
    // Send any pending subscription request.
    client.pendingSubscriptionSet.forEach((channelID) => {
      const kvFilter = this.kvFilter.get(channelID)
      client.socket?.send(createRequest(REQUEST_TYPE.SUB, kvFilter ? { channelID, kvFilter } : { channelID }))
    })
    // There should be no pending unsubscription since we just got connected.
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
    // Refresh the ping timer, waiting for the next ping.
    clearTimeout(client.pingTimeoutID)
    client.pingTimeoutID = setTimeout(() => {
      client.socket?.close()
    }, client.options.pingTimeout)
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
        client.pendingSubscriptionSet.delete(channelID)
        break
      }
      case REQUEST_TYPE.UNSUB: {
        console.warn(`[pubsub] Could not unsubscribe from ${channelID}: ${reason}`)
        client.pendingUnsubscriptionSet.delete(channelID)
        break
      }
      case REQUEST_TYPE.PUSH_ACTION: {
        const { actionType, message } = data
        console.warn(`[pubsub] Received ERROR for PUSH_ACTION request with the action type '${actionType}' and the following message: ${message}`)
        break
      }
      default: {
        console.error(`[pubsub] Malformed response: invalid request type ${type}`)
      }
    }
  },

  [RESPONSE_TYPE.OK] ({ data: { type, channelID } }) {
    const client = this

    switch (type) {
      case REQUEST_TYPE.SUB: {
        client.pendingSubscriptionSet.delete(channelID)
        client.subscriptionSet.add(channelID)
        sbp('okTurtles.events/emit', PUBSUB_SUBSCRIPTION_SUCCEEDED, client, { channelID })
        break
      }
      case REQUEST_TYPE.UNSUB: {
        console.debug(`[pubsub] Unsubscribed from ${channelID}`)
        client.pendingUnsubscriptionSet.delete(channelID)
        client.subscriptionSet.delete(channelID)
        client.kvFilter.delete(channelID)
        break
      }
      case REQUEST_TYPE.KV_FILTER: {
        console.debug(`[pubsub] Set KV filter for ${channelID}`)
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
  clearAllTimers(this: PubSubClient): void,
  connect(this: PubSubClient): void,
  destroy(this: PubSubClient): void,
  pub(this: PubSubClient, channelID: string, data: JSONType): void,
  scheduleConnectionAttempt(this: PubSubClient): void,
  sub(this: PubSubClient, channelID: string): void,
  setKvFilter(this: PubSubClient, channelID: string, kvFilter?: string[]): void,
  unsub(this: PubSubClient, channelID: string): void,
  getNextRandomDelay(this: PubSubClient): number
} = {
  clearAllTimers () {
    const client = this

    clearTimeout(client.connectionTimeoutID)
    clearTimeout(client.nextConnectionAttemptDelayID)
    clearTimeout(client.pingTimeoutID)
    client.connectionTimeoutID = undefined
    client.nextConnectionAttemptDelayID = undefined
    client.pingTimeoutID = undefined
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
    // Sometimes (like when using `createMessage`), we want to send objects that
    // are serialized as strings. Native web sockets don't support objects, so
    // we use this workaround.
    client.socket.send = function (data) {
      const send = WebSocket.prototype.send.bind(this)
      if (
        typeof data === 'object' &&
        typeof (data as object as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive] === 'function'
      ) {
        return send(
          (data as object as { [Symbol.toPrimitive]: () => string })[Symbol.toPrimitive]()
        )
      }
      return send(data)
    }

    if (client.options.timeout) {
      const start = performance.now()
      client.connectionTimeoutID = setTimeout(() => {
        client.connectionTimeoutID = undefined
        if (client.options.reconnectOnTimeout) {
          client.connectionTimeUsed = performance.now() - start
        }
        client.socket?.close(4000, 'timeout')
      }, client.options.timeout)
    }
    // Attach WebSocket event listeners.
    for (const name of socketEventNames) {
      client.socket.addEventListener(name, client.listeners[name] as () => void)
    }
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
    client.pendingSubscriptionSet.clear()
    client.pendingUnsubscriptionSet.clear()
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
  },

  getNextRandomDelay (): number {
    const client = this

    const {
      maxReconnectionDelay,
      minReconnectionDelay,
      reconnectionDelayGrowFactor
    } = client.options

    const minDelay = minReconnectionDelay * reconnectionDelayGrowFactor ** client.failedConnectionAttempts
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
    const { socket } = this

    if (!client.pendingSubscriptionSet.has(channelID)) {
      client.pendingSubscriptionSet.add(channelID)
      client.pendingUnsubscriptionSet.delete(channelID)

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(createRequest(REQUEST_TYPE.SUB, { channelID }))
      }
    }
  },

  /**
   * Sends a KV_FILTER request to the server as soon as possible.
   */
  setKvFilter (channelID: string, kvFilter?: string[]) {
    const client = this
    const { socket } = this

    if (kvFilter) {
      client.kvFilter.set(channelID, kvFilter)
    } else {
      client.kvFilter.delete(channelID)
    }

    if (client.subscriptionSet.has(channelID)) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(createRequest(REQUEST_TYPE.KV_FILTER, kvFilter ? { channelID, kvFilter } : { channelID }))
      }
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
    const { socket } = this

    if (!client.pendingUnsubscriptionSet.has(channelID)) {
      client.pendingSubscriptionSet.delete(channelID)
      client.pendingUnsubscriptionSet.add(channelID)

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(createRequest(REQUEST_TYPE.UNSUB, { channelID }))
      }
    }
  }
}

// Register custom SBP event listeners before the first connection.
for (const name of Object.keys(defaultClientEventHandlers)) {
  if (name === 'error' || !(socketEventNames as readonly string[]).includes(name)) {
    sbp('okTurtles.events/on', `pubsub-${name}`, (target: PubSubClient, detail?: object) => {
      const ev = new CustomEvent(name, { detail })
      ;(target.listeners[name as keyof ClientEventHandlers] as (this: typeof target, e: typeof ev) => void).call(target, ev)
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
