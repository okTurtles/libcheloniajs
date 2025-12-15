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
const turtledash_1 = require("turtledash");
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
class TieredMap extends Map {
    tGet(k1, k2) {
        return this.get(k1)?.get(k2);
    }
    tHas(k1, k2) {
        return !!this.get(k1)?.has(k2);
    }
    tSet(k1, k2, v) {
        let submap = this.get(k1);
        if (!submap) {
            submap = new Map();
            this.set(k1, submap);
        }
        return submap.set(k2, v);
    }
    tDelete(k1, k2) {
        const submap = this.get(k1);
        if (submap) {
            const result = submap.delete(k2);
            if (submap.size === 0) {
                this.delete(k1);
            }
            return result;
        }
        return false;
    }
    tClear(k1) {
        this.delete(k1);
    }
}
const isKvFilterFresh = (ourKvFilter, theirKvFilter) => {
    // If we don't have a KV filter and the server does, or vice versa,
    // the filter isn't fresh
    if (!ourKvFilter !== !theirKvFilter) {
        return false;
    }
    else if (ourKvFilter && theirKvFilter) {
        // If both have a KV filter, set the KV filter if they differ
        //   (XOR: return false if exactly one of them is truthy)
        if (ourKvFilter.length !== theirKvFilter.length) {
            // Fast path: different length must mean the filter is different
            return false;
        }
        else {
            const sortedA = [...ourKvFilter].sort();
            const sortedB = [...theirKvFilter].sort();
            for (let i = 0; i < sortedA.length; i++) {
                if (sortedA[i] !== sortedB[i]) {
                    return false;
                }
            }
        }
    }
    return true;
};
const pubPayloadFactory = (client, channelID) => () => {
    const kvFilter = client.kvFilter.get(channelID);
    return kvFilter ? { kvFilter, channelID } : { channelID };
};
function runWithRetry(client, channelID, type, getPayload) {
    let attemptNo = 0;
    const { socket, options } = client;
    // `runWithRetry` will use reference equality to determine freshness.
    // An empty object serves this purpose.
    const instance = {};
    client.pendingOperations.tSet(type, channelID, instance);
    const send = () => {
        // 1. Closure check: ensure socket instance hasn't been replaced
        if (client.socket !== socket || socket?.readyState !== WebSocket.OPEN)
            return;
        // 2a. Cancellation check
        const currentInstance = client.pendingOperations.tGet(type, channelID);
        if (currentInstance !== instance)
            return;
        // 2b. Retries check
        if (attemptNo++ > options.maxOpRetries) {
            console.warn(`[pubsub] Giving up ${type} for channel`, channelID);
            client.pendingOperations.tDelete(type, channelID);
            return;
        }
        // 3. Send logic
        const payload = getPayload();
        socket.send(createRequest(type, payload));
        // 4. Schedule retry
        // Randomness / jitter to prevent bursts
        const minDelay = (attemptNo - 1) * options.opRetryInterval;
        const jitter = (0, turtledash_1.randomIntFromRange)(0, options.opRetryInterval);
        const delay = Math.min(200, minDelay) + jitter;
        setTimeout(send, delay);
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
        pendingOperations: new TieredMap(),
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
            // `runWithRetry` will (later) use reference equality to determine freshness.
            // In order to abort current send attempts, but still being able to restore
            // existing subscriptions upon reconnection, we set pendingSubscriptionMap
            // to a different instance value. Deleting values from
            // `pendingSubscriptionMap` could also work, but then we'd need to save
            // the list of existing keys somewhere else.
            const pendingSubscriptionMap = client.pendingOperations.get(exports.REQUEST_TYPE.SUB);
            if (pendingSubscriptionMap) {
                for (const [channelID] of pendingSubscriptionMap) {
                    pendingSubscriptionMap.set(channelID, {});
                }
            }
            client.subscriptionSet.forEach((channelID) => {
                // Skip contracts from which we had to unsubscribe anyway.
                if (!client.pendingOperations.tHas(exports.REQUEST_TYPE.UNSUB, channelID)) {
                    client.pendingOperations.tSet(exports.REQUEST_TYPE.SUB, channelID, {});
                }
            });
        }
        // We are no longer subscribed to any contracts since we are now disconnected.
        client.subscriptionSet.clear();
        client.pendingOperations.tClear(exports.REQUEST_TYPE.UNSUB);
        client.pendingOperations.tClear(exports.REQUEST_TYPE.KV_FILTER);
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
        for (const [channelID] of client.pendingOperations.get(exports.REQUEST_TYPE.SUB) || []) {
            runWithRetry(client, channelID, exports.REQUEST_TYPE.SUB, pubPayloadFactory(client, channelID));
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
                client.pendingOperations.tDelete(exports.REQUEST_TYPE.SUB, channelID);
                break;
            }
            case exports.REQUEST_TYPE.UNSUB: {
                console.warn(`[pubsub] Could not unsubscribe from ${channelID}: ${reason}`);
                client.pendingOperations.tDelete(exports.REQUEST_TYPE.UNSUB, channelID);
                break;
            }
            case exports.REQUEST_TYPE.PUSH_ACTION: {
                const { actionType, message } = data;
                console.warn(`[pubsub] Received ERROR for PUSH_ACTION request with the action type '${actionType}' and the following message: ${message}`);
                break;
            }
            case exports.REQUEST_TYPE.KV_FILTER: {
                console.warn(`[pubsub] Could not set KV filter for ${channelID}: ${reason}`);
                client.pendingOperations.tDelete(exports.REQUEST_TYPE.KV_FILTER, channelID);
                break;
            }
            default: {
                console.error(`[pubsub] Malformed response: invalid request type ${type}`);
            }
        }
    },
    [exports.RESPONSE_TYPE.OK]({ data: { type, channelID, kvFilter } }) {
        const client = this;
        switch (type) {
            case exports.REQUEST_TYPE.SUB: {
                if (client.pendingOperations.tHas(exports.REQUEST_TYPE.SUB, channelID)) {
                    client.pendingOperations.tDelete(exports.REQUEST_TYPE.SUB, channelID);
                    client.subscriptionSet.add(channelID);
                    (0, sbp_1.default)('okTurtles.events/emit', exports.PUBSUB_SUBSCRIPTION_SUCCEEDED, client, { channelID });
                    const ourKvFilter = client.kvFilter.get(channelID);
                    if (!isKvFilterFresh(ourKvFilter, kvFilter)) {
                        console.debug(`[pubsub] Subscribed to ${channelID}, need to set new KV filter`);
                        this.setKvFilter(channelID, ourKvFilter);
                    }
                }
                else {
                    console.debug(`[pubsub] Received unexpected sub for ${channelID}`);
                }
                break;
            }
            case exports.REQUEST_TYPE.UNSUB: {
                if (client.pendingOperations.tHas(exports.REQUEST_TYPE.UNSUB, channelID)) {
                    console.debug(`[pubsub] Unsubscribed from ${channelID}`);
                    client.pendingOperations.tDelete(exports.REQUEST_TYPE.UNSUB, channelID);
                    client.subscriptionSet.delete(channelID);
                }
                else {
                    console.debug(`[pubsub] Received unexpected unsub for ${channelID}`);
                }
                break;
            }
            case exports.REQUEST_TYPE.KV_FILTER: {
                if (client.pendingOperations.tHas(exports.REQUEST_TYPE.KV_FILTER, channelID)) {
                    const ourKvFilter = client.kvFilter.get(channelID);
                    if (isKvFilterFresh(ourKvFilter, kvFilter)) {
                        console.debug(`[pubsub] Set KV filter for ${channelID}`, kvFilter);
                        client.pendingOperations.tDelete(exports.REQUEST_TYPE.KV_FILTER, channelID);
                    }
                    else {
                        console.debug(`[pubsub] Received stale KV filter ack for ${channelID}`, kvFilter, ourKvFilter);
                    }
                }
                else {
                    console.debug(`[pubsub] Received unexpected kv-filter for ${channelID}`);
                }
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
        client.pendingOperations.clear();
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
        // In order to send subscribe to the server, we need to not be already
        // subscribed (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it
        // either being a pending operation or having it in `subscriptionSet`).
        // Whether we've sent an unsubscription request and whether it's been
        // confirmed isn't relevant.
        if (!client.pendingOperations.tHas(exports.REQUEST_TYPE.SUB, channelID) &&
            !client.subscriptionSet.has(channelID)) {
            client.pendingOperations.tDelete(exports.REQUEST_TYPE.UNSUB, channelID);
            runWithRetry(client, channelID, exports.REQUEST_TYPE.SUB, pubPayloadFactory(client, channelID));
        }
    },
    /**
     * Sends a KV_FILTER request to the server as soon as possible.
     */
    setKvFilter(channelID, kvFilter) {
        const client = this;
        if (kvFilter) {
            client.kvFilter.set(channelID, kvFilter);
        }
        else {
            client.kvFilter.delete(channelID);
        }
        // In order to send KV filter to the server, we need to first be subscribed
        // (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it either being
        // a pending operation or having it in `subscriptionSet`), and we also want
        // to ensure that we've not already sent REQUEST_TYPE.UNSUB.
        // Note that KV filter requires that a subscription exists for it to work,
        // and therefore we don't send anything if the subscription is pending
        // (unconfirmed). Instead, setting the KV filter in these cases will
        // be done in the `RESPONSE_TYPE.OK` function for REQUEST_TYPE.SUB.
        if (client.subscriptionSet.has(channelID) &&
            !client.pendingOperations.tHas(exports.REQUEST_TYPE.UNSUB, channelID)) {
            runWithRetry(client, channelID, exports.REQUEST_TYPE.KV_FILTER, pubPayloadFactory(client, channelID));
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
        // In order to send unsubscribe to the server, we need to first be subscribed
        // (meaning that we've sent REQUEST_TYPE.SUB, confirmed by it either being
        // a pending operation or having it in `subscriptionSet`), and we also want
        // to ensure that we've not already sent REQUEST_TYPE.UNSUB.
        if (!client.pendingOperations.tHas(exports.REQUEST_TYPE.UNSUB, channelID) &&
            (client.subscriptionSet.has(channelID) ||
                client.pendingOperations.tHas(exports.REQUEST_TYPE.SUB, channelID))) {
            client.pendingOperations.tDelete(exports.REQUEST_TYPE.SUB, channelID);
            client.kvFilter.delete(channelID);
            runWithRetry(client, channelID, exports.REQUEST_TYPE.UNSUB, () => ({ channelID }));
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
