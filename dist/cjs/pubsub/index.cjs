"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageParser = exports.PUBSUB_SUBSCRIPTION_SUCCEEDED = exports.PUBSUB_RECONNECTION_SUCCEEDED = exports.PUBSUB_RECONNECTION_SCHEDULED = exports.PUBSUB_RECONNECTION_FAILED = exports.PUBSUB_RECONNECTION_ATTEMPT = exports.PUBSUB_ERROR = exports.PUSH_SERVER_ACTION_TYPE = exports.RESPONSE_TYPE = exports.REQUEST_TYPE = exports.NOTIFICATION_TYPE = void 0;
exports.createClient = createClient;
exports.createMessage = createMessage;
exports.createKvMessage = createKvMessage;
exports.createPubMessage = createPubMessage;
exports.createRequest = createRequest;
/* eslint-disable @typescript-eslint/no-this-alias */
require("@sbp/okturtles.events");
const sbp_1 = __importDefault(require("@sbp/sbp"));
// ====== Enums ====== //
exports.NOTIFICATION_TYPE = Object.freeze({
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
});
exports.REQUEST_TYPE = Object.freeze({
    PUB: 'pub',
    SUB: 'sub',
    UNSUB: 'unsub',
    PUSH_ACTION: 'push_action',
    KV_FILTER: 'kv_filter'
});
exports.RESPONSE_TYPE = Object.freeze({
    ERROR: 'error',
    OK: 'ok'
});
exports.PUSH_SERVER_ACTION_TYPE = Object.freeze({
    SEND_PUBLIC_KEY: 'send-public-key',
    STORE_SUBSCRIPTION: 'store-subscription',
    DELETE_SUBSCRIPTION: 'delete-subscription',
    SEND_PUSH_NOTIFICATION: 'send-push-notification'
});
// TODO: verify these are good defaults
const defaultOptions = {
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
};
// ====== Event name constants ====== //
exports.PUBSUB_ERROR = 'pubsub-error';
exports.PUBSUB_RECONNECTION_ATTEMPT = 'pubsub-reconnection-attempt';
exports.PUBSUB_RECONNECTION_FAILED = 'pubsub-reconnection-failed';
exports.PUBSUB_RECONNECTION_SCHEDULED = 'pubsub-reconnection-scheduled';
exports.PUBSUB_RECONNECTION_SUCCEEDED = 'pubsub-reconnection-succeeded';
exports.PUBSUB_SUBSCRIPTION_SUCCEEDED = 'pubsub-subscription-succeeded';
// ====== Helpers ====== //
function runWithRetry(client, channelID, type, instance) {
    let attemptNo = 0;
    const { socket, options } = client;
    const send = () => {
        // 1. Closure check: ensure socket instance hasn't been replaced
        if (client.socket !== socket || socket?.readyState !== WebSocket.OPEN)
            return;
        // 2. Cancellation check
        const currentInstance = type === exports.REQUEST_TYPE.SUB
            ? client.pendingSubscriptionMap.get(channelID)
            : client.pendingUnsubscriptionMap.get(channelID);
        if (currentInstance !== instance)
            return;
        // 3. Send logic
        const kvFilter = client.kvFilter.get(channelID);
        const payload = (type === exports.REQUEST_TYPE.SUB && kvFilter)
            ? { channelID, kvFilter }
            : { channelID };
        socket.send(createRequest(type, payload));
        // 4. Schedule retry
        setTimeout(() => {
            if (++attemptNo > options.maxOpRetries) {
                console.warn(`Giving up ${type} for channel`, channelID);
                return;
            }
            send();
        }, options.opRetryInterval * attemptNo);
    };
    send();
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
 * {number?} pingTimeout=45_000 - How long to wait for the server to send a ping, in milliseconds.
 * {boolean?} reconnectOnDisconnection=true - Whether to reconnect after a server-side disconnection.
 * {boolean?} reconnectOnOnline=true - Whether to reconnect after coming back online.
 * {boolean?} reconnectOnTimeout=false - Whether to reconnect after a connection timeout.
 * {number?} timeout=5_000 - Connection timeout duration in milliseconds.
 * @returns {PubSubClient}
 */
function createClient(url, options = {}) {
    const client = {
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
        pendingSubscriptionMap: new Map(),
        pendingUnsubscriptionMap: new Map(),
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
    };
    // Create and save references to reusable event listeners.
    // Every time a new underlying WebSocket object will be created for this
    // client instance, these event listeners will be detached from the older
    // socket then attached to the new one, hereby avoiding both unnecessary
    // allocations and garbage collections of a bunch of functions every time.
    // Another benefit is the ability to patch the client protocol at runtime by
    // updating the client's custom event handler map.
    for (const name of Object.keys(defaultClientEventHandlers)) {
        client.listeners[name] = (event) => {
            try {
                // Use `.call()` to pass the client via the 'this' binding.
                defaultClientEventHandlers[name].call(client, event);
                client.customEventHandlers[name]?.call(client, event);
            }
            catch (error) {
                // Do not throw any error but emit an `error` event instead.
                (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_ERROR, client, error?.message);
            }
        };
    }
    // Add global event listeners before the first connection.
    if (typeof self === 'object' && self instanceof EventTarget) {
        for (const name of globalEventNames) {
            globalEventMap.set(name, client.listeners[name]);
        }
    }
    if (!client.options.manual) {
        client.connect();
    }
    return client;
}
function createMessage(type, data, meta) {
    const message = { ...meta, type, data };
    let string;
    const stringify = function () {
        if (!string)
            string = JSON.stringify(this);
        return string;
    };
    Object.defineProperties(message, {
        [Symbol.toPrimitive]: {
            value: stringify
        }
    });
    return message;
}
function createKvMessage(channelID, key, data) {
    return JSON.stringify({ type: exports.NOTIFICATION_TYPE.KV, channelID, key, data });
}
function createPubMessage(channelID, data) {
    return JSON.stringify({ type: exports.NOTIFICATION_TYPE.PUB, channelID, data });
}
function createRequest(type, data) {
    // Had to use Object.assign() instead of object spreading to make Flow happy.
    return JSON.stringify(Object.assign({ type }, data));
}
// These handlers receive the PubSubClient instance through the `this` binding.
const defaultClientEventHandlers = {
    // Emitted when the connection is closed.
    close(event) {
        const client = this;
        console.debug('[pubsub] Event: close', event.code, event.reason);
        client.failedConnectionAttempts++;
        if (client.socket) {
            // Remove event listeners to avoid memory leaks.
            for (const name of socketEventNames) {
                client.socket.removeEventListener(name, client.listeners[name]);
            }
        }
        client.socket = null;
        client.clearAllTimers();
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
            const instance = {};
            client.subscriptionSet.forEach((channelID) => {
                // Skip contracts from which we had to unsubscribe anyway.
                if (!client.pendingUnsubscriptionMap.has(channelID)) {
                    client.pendingSubscriptionMap.set(channelID, instance);
                }
            });
            for (const [channelID] of client.pendingSubscriptionMap) {
                client.pendingSubscriptionMap.set(channelID, instance);
            }
        }
        // We are no longer subscribed to any contracts since we are now disconnected.
        client.subscriptionSet.clear();
        client.pendingUnsubscriptionMap.clear();
        if (client.shouldReconnect && client.options.reconnectOnDisconnection) {
            if (client.failedConnectionAttempts > client.options.maxRetries) {
                (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_RECONNECTION_FAILED, client);
            }
            else {
                // If we are definetely offline then do not try to reconnect now,
                // unless the server is local.
                if (!isDefinetelyOffline() || client.isLocal) {
                    client.scheduleConnectionAttempt();
                }
            }
        }
    },
    // Emitted when an error has occured.
    // The socket will be closed automatically by the engine if necessary.
    error(event) {
        const client = this;
        // Not all error events should be logged with console.error, for example every
        // failed connection attempt generates one such event.
        console.warn('[pubsub] Event: error', event);
        clearTimeout(client.pingTimeoutID);
    },
    // Emitted when a message is received.
    // The connection will be terminated if the message is malformed or has an
    // unexpected data type (e.g. binary instead of text).
    message(event) {
        const client = this;
        const { data } = event;
        if (typeof data !== 'string') {
            (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_ERROR, client, {
                message: `Wrong data type: ${typeof data}`
            });
            return client.destroy();
        }
        let msg = { type: '' };
        try {
            msg = (0, exports.messageParser)(data);
        }
        catch (error) {
            (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_ERROR, client, {
                message: `Malformed message: ${error?.message}`
            });
            return client.destroy();
        }
        const handler = client.messageHandlers[msg.type];
        if (handler) {
            handler.call(client, msg);
        }
        else {
            throw new Error(`Unhandled message type: ${msg.type}`);
        }
    },
    offline() {
        console.info('[pubsub] Event: offline');
        const client = this;
        client.clearAllTimers();
        // Reset the connection attempt counter so that we'll start a new
        // reconnection loop when we are back online.
        client.failedConnectionAttempts = 0;
        client.socket?.close();
    },
    online() {
        console.info('[pubsub] Event: online');
        const client = this;
        if (client.options.reconnectOnOnline && client.shouldReconnect) {
            if (!client.socket) {
                client.failedConnectionAttempts = 0;
                client.scheduleConnectionAttempt();
            }
        }
    },
    // Emitted when the connection is established.
    open() {
        console.debug('[pubsub] Event: open');
        const client = this;
        const { options } = this;
        client.connectionTimeUsed = undefined;
        client.clearAllTimers();
        (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_RECONNECTION_SUCCEEDED, client);
        // Set it to -1 so that it becomes 0 on the next `close` event.
        client.failedConnectionAttempts = -1;
        client.isNew = false;
        // Setup a ping timeout if required.
        // It will close the connection if we don't get any message from the server.
        if (options.pingTimeout > 0 && options.pingTimeout < Infinity) {
            client.pingTimeoutID = setTimeout(() => {
                client.socket?.close();
            }, options.pingTimeout);
        }
        // Send any pending subscription request.
        for (const [channelID, instance] of client.pendingSubscriptionMap) {
            runWithRetry(client, channelID, exports.REQUEST_TYPE.SUB, instance);
        }
        // There should be no pending unsubscription since we just got connected.
    },
    'reconnection-attempt'() {
        console.info('[pubsub] Trying to reconnect...');
    },
    'reconnection-succeeded'() {
        console.info('[pubsub] Connection re-established');
    },
    'reconnection-failed'() {
        console.warn('[pubsub] Reconnection failed');
        const client = this;
        client.destroy();
    },
    'reconnection-scheduled'(event) {
        const { delay, nth } = event.detail;
        console.info(`[pubsub] Scheduled connection attempt ${nth} in ~${delay} ms`);
    },
    'subscription-succeeded'(event) {
        const { channelID } = event.detail;
        console.debug(`[pubsub] Subscribed to channel ${channelID}`);
    }
};
// These handlers receive the PubSubClient instance through the `this` binding.
const defaultMessageHandlers = {
    [exports.NOTIFICATION_TYPE.ENTRY](msg) {
        console.debug('[pubsub] Received ENTRY:', msg);
    },
    [exports.NOTIFICATION_TYPE.PING]({ data }) {
        const client = this;
        if (client.options.logPingMessages) {
            console.debug(`[pubsub] Ping received in ${Date.now() - Number(data)} ms`);
        }
        // Reply with a pong message using the same data.
        // TODO: Type coercion to string because we actually support passing this
        // object type, but the correct TypeScript type hasn't been written.
        client.socket?.send(createMessage(exports.NOTIFICATION_TYPE.PONG, data));
        // Refresh the ping timer, waiting for the next ping.
        clearTimeout(client.pingTimeoutID);
        client.pingTimeoutID = setTimeout(() => {
            client.socket?.close();
        }, client.options.pingTimeout);
    },
    [exports.NOTIFICATION_TYPE.PUB]({ channelID, data }) {
        console.log(`[pubsub] Received data from channel ${channelID}:`, data);
        // No need to reply.
    },
    [exports.NOTIFICATION_TYPE.KV]({ channelID, key, data }) {
        console.log(`[pubsub] Received KV update from channel ${channelID} ${key}:`, data);
        // No need to reply.
    },
    [exports.NOTIFICATION_TYPE.SUB](msg) {
        console.debug(`[pubsub] Ignoring ${msg.type} message:`, msg.data);
    },
    [exports.NOTIFICATION_TYPE.UNSUB](msg) {
        console.debug(`[pubsub] Ignoring ${msg.type} message:`, msg.data);
    },
    [exports.RESPONSE_TYPE.ERROR]({ data }) {
        const { type, channelID, reason } = data;
        console.warn(`[pubsub] Received ERROR response for ${type} request to ${channelID}`);
        const client = this;
        switch (type) {
            case exports.REQUEST_TYPE.SUB: {
                console.warn(`[pubsub] Could not subscribe to ${channelID}: ${reason}`);
                client.pendingSubscriptionMap.delete(channelID);
                break;
            }
            case exports.REQUEST_TYPE.UNSUB: {
                console.warn(`[pubsub] Could not unsubscribe from ${channelID}: ${reason}`);
                client.pendingUnsubscriptionMap.delete(channelID);
                break;
            }
            case exports.REQUEST_TYPE.PUSH_ACTION: {
                const { actionType, message } = data;
                console.warn(`[pubsub] Received ERROR for PUSH_ACTION request with the action type '${actionType}' and the following message: ${message}`);
                break;
            }
            default: {
                console.error(`[pubsub] Malformed response: invalid request type ${type}`);
            }
        }
    },
    [exports.RESPONSE_TYPE.OK]({ data: { type, channelID } }) {
        const client = this;
        switch (type) {
            case exports.REQUEST_TYPE.SUB: {
                client.pendingSubscriptionMap.delete(channelID);
                client.subscriptionSet.add(channelID);
                (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_SUBSCRIPTION_SUCCEEDED, client, { channelID });
                break;
            }
            case exports.REQUEST_TYPE.UNSUB: {
                console.debug(`[pubsub] Unsubscribed from ${channelID}`);
                client.pendingUnsubscriptionMap.delete(channelID);
                client.subscriptionSet.delete(channelID);
                client.kvFilter.delete(channelID);
                break;
            }
            case exports.REQUEST_TYPE.KV_FILTER: {
                console.debug(`[pubsub] Set KV filter for ${channelID}`);
                break;
            }
            default: {
                console.error(`[pubsub] Malformed response: invalid request type ${type}`);
            }
        }
    }
};
const globalEventNames = ['offline', 'online'];
const socketEventNames = ['close', 'error', 'message', 'open'];
// eslint-disable-next-line func-call-spacing
const globalEventMap = new Map();
if (typeof self === 'object' && self instanceof EventTarget) {
    // We need to do things in this roundabout way because Chrome doesn't like
    // these events handlers not being top-level.
    // `Event handler of 'online' event must be added on the initial evaluation of worker script.`
    for (const name of globalEventNames) {
        const handler = (ev) => {
            const h = globalEventMap.get(name);
            return h?.(ev);
        };
        self.addEventListener(name, handler, false);
    }
}
// `navigator.onLine` can give confusing false positives when `true`,
// so we'll define `isDefinetelyOffline()` rather than `isOnline()` or `isOffline()`.
// See https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
const isDefinetelyOffline = () => typeof navigator === 'object' && navigator.onLine === false;
// Parses and validates a received message.
const messageParser = (data) => {
    const msg = JSON.parse(data);
    if (typeof msg !== 'object' || msg === null) {
        throw new TypeError('Message is null or not an object');
    }
    const { type } = msg;
    if (typeof type !== 'string' || type === '') {
        throw new TypeError('Message type must be a non-empty string');
    }
    return msg;
};
exports.messageParser = messageParser;
const publicMethods = {
    clearAllTimers() {
        const client = this;
        clearTimeout(client.connectionTimeoutID);
        clearTimeout(client.nextConnectionAttemptDelayID);
        clearTimeout(client.pingTimeoutID);
        client.connectionTimeoutID = undefined;
        client.nextConnectionAttemptDelayID = undefined;
        client.pingTimeoutID = undefined;
    },
    // Performs a connection or reconnection attempt.
    connect() {
        const client = this;
        if (client.socket !== null) {
            throw new Error('connect() can only be called if there is no current socket.');
        }
        if (client.nextConnectionAttemptDelayID) {
            throw new Error('connect() must not be called during a reconnection delay.');
        }
        if (!client.shouldReconnect) {
            throw new Error('connect() should no longer be called on this instance.');
        }
        client.socket = new WebSocket(client.url);
        // Sometimes (like when using `createMessage`), we want to send objects that
        // are serialized as strings. Native web sockets don't support objects, so
        // we use this workaround.
        client.socket.send = function (data) {
            const send = WebSocket.prototype.send.bind(this);
            if (typeof data === 'object' &&
                typeof data[Symbol.toPrimitive] ===
                    'function') {
                return send(data[Symbol.toPrimitive]());
            }
            return send(data);
        };
        if (client.options.timeout) {
            const start = performance.now();
            client.connectionTimeoutID = setTimeout(() => {
                client.connectionTimeoutID = undefined;
                if (client.options.reconnectOnTimeout) {
                    client.connectionTimeUsed = performance.now() - start;
                }
                client.socket?.close(4000, 'timeout');
            }, client.options.timeout);
        }
        // Attach WebSocket event listeners.
        for (const name of socketEventNames) {
            client.socket.addEventListener(name, client.listeners[name]);
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
    destroy() {
        const client = this;
        client.clearAllTimers();
        // Update property values.
        // Note: do not clear 'client.options'.
        client.pendingSubscriptionMap.clear();
        client.pendingUnsubscriptionMap.clear();
        client.subscriptionSet.clear();
        // Remove global event listeners.
        if (typeof self === 'object' && self instanceof EventTarget) {
            for (const name of globalEventNames) {
                globalEventMap.delete(name);
            }
        }
        // Remove WebSocket event listeners.
        if (client.socket) {
            for (const name of socketEventNames) {
                client.socket.removeEventListener(name, client.listeners[name]);
            }
            client.socket.close();
        }
        client.listeners = Object.create(null);
        client.socket = null;
        client.shouldReconnect = false;
    },
    getNextRandomDelay() {
        const client = this;
        const { maxReconnectionDelay, minReconnectionDelay, reconnectionDelayGrowFactor } = client.options;
        const minDelay = minReconnectionDelay * reconnectionDelayGrowFactor ** client.failedConnectionAttempts;
        const maxDelay = minDelay * reconnectionDelayGrowFactor;
        const connectionTimeUsed = client.connectionTimeUsed;
        client.connectionTimeUsed = undefined;
        return Math.min(
        // See issue #1943: Have the connection time used 'eat into' the
        // reconnection time used
        Math.max(minReconnectionDelay, connectionTimeUsed ? maxReconnectionDelay - connectionTimeUsed : maxReconnectionDelay), Math.round(minDelay + (0, Math.random)() * (maxDelay - minDelay)));
    },
    // Schedules a connection attempt to happen after a delay computed according to
    // a randomized exponential backoff algorithm variant.
    scheduleConnectionAttempt() {
        const client = this;
        if (!client.shouldReconnect) {
            throw new Error('Cannot call `scheduleConnectionAttempt()` when `shouldReconnect` is false.');
        }
        if (client.nextConnectionAttemptDelayID) {
            return console.warn('[pubsub] A reconnection attempt is already scheduled.');
        }
        const delay = client.getNextRandomDelay();
        const nth = client.failedConnectionAttempts + 1;
        client.nextConnectionAttemptDelayID = setTimeout(() => {
            (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_RECONNECTION_ATTEMPT, client);
            client.nextConnectionAttemptDelayID = undefined;
            client.connect();
        }, delay);
        (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_RECONNECTION_SCHEDULED, client, { delay, nth });
    },
    // Can be used to send ephemeral messages outside of any contract log.
    // Does nothing if the socket is not in the OPEN state.
    pub(channelID, data) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(createPubMessage(channelID, data));
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
    sub(channelID) {
        const client = this;
        if (!client.pendingSubscriptionMap.has(channelID) && !client.subscriptionSet.has(channelID)) {
            const instance = {};
            client.pendingSubscriptionMap.set(channelID, instance);
            client.pendingUnsubscriptionMap.delete(channelID);
            runWithRetry(client, channelID, exports.REQUEST_TYPE.SUB, instance);
        }
    },
    /**
     * Sends a KV_FILTER request to the server as soon as possible.
     */
    setKvFilter(channelID, kvFilter) {
        const client = this;
        const { socket } = this;
        if (kvFilter) {
            client.kvFilter.set(channelID, kvFilter);
        }
        else {
            client.kvFilter.delete(channelID);
        }
        if (client.subscriptionSet.has(channelID)) {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(createRequest(exports.REQUEST_TYPE.KV_FILTER, kvFilter ? { channelID, kvFilter } : { channelID }));
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
    unsub(channelID) {
        const client = this;
        if (!client.pendingUnsubscriptionMap.has(channelID)) {
            const instance = {};
            client.pendingSubscriptionMap.delete(channelID);
            client.pendingUnsubscriptionMap.set(channelID, instance);
            client.kvFilter.delete(channelID);
            runWithRetry(client, channelID, exports.REQUEST_TYPE.UNSUB, instance);
        }
    }
};
// Register custom SBP event listeners before the first connection.
for (const name of Object.keys(defaultClientEventHandlers)) {
    if (name === 'error' || !socketEventNames.includes(name)) {
        (0, sbp_1.default)('okTurtles.events/on', `pubsub-${name}`, (target, detail) => {
            const ev = new CustomEvent(name, { detail });
            target.listeners[name].call(target, ev);
        });
    }
}
exports.default = {
    NOTIFICATION_TYPE: exports.NOTIFICATION_TYPE,
    REQUEST_TYPE: exports.REQUEST_TYPE,
    RESPONSE_TYPE: exports.RESPONSE_TYPE,
    createClient,
    createMessage,
    createRequest
};
