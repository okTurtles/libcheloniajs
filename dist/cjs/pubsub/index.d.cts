import '@sbp/okturtles.events';
import type { JSONObject, JSONType } from '../types.cjs';
export declare const NOTIFICATION_TYPE: Readonly<{
    ENTRY: "entry";
    DELETION: "deletion";
    KV: "kv";
    KV_FILTER: "kv_filter";
    PING: "ping";
    PONG: "pong";
    PUB: "pub";
    SUB: "sub";
    UNSUB: "unsub";
    VERSION_INFO: "version_info";
}>;
export declare const REQUEST_TYPE: Readonly<{
    PUB: "pub";
    SUB: "sub";
    UNSUB: "unsub";
    PUSH_ACTION: "push_action";
    KV_FILTER: "kv_filter";
}>;
export declare const RESPONSE_TYPE: Readonly<{
    ERROR: "error";
    OK: "ok";
}>;
export declare const PUSH_SERVER_ACTION_TYPE: Readonly<{
    SEND_PUBLIC_KEY: "send-public-key";
    STORE_SUBSCRIPTION: "store-subscription";
    DELETE_SUBSCRIPTION: "delete-subscription";
    SEND_PUSH_NOTIFICATION: "send-push-notification";
}>;
export type NotificationTypeEnum = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];
export type RequestTypeEnum = (typeof REQUEST_TYPE)[keyof typeof REQUEST_TYPE];
export type ResponseTypeEnum = (typeof RESPONSE_TYPE)[keyof typeof RESPONSE_TYPE];
type TimeoutID = ReturnType<typeof setTimeout>;
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
    maxOpRetries: number;
    opRetryInterval: number;
    manual?: boolean;
    handlers?: Partial<ClientEventHandlers>;
    messageHandlers?: Partial<MessageHandlers>;
};
export type Message = {
    [key: string]: JSONType;
    type: string;
};
export type PubSubClient = {
    connectionTimeoutID: TimeoutID | undefined;
    connectionTimeUsed?: number;
    customEventHandlers: Partial<ClientEventHandlers>;
    failedConnectionAttempts: number;
    isLocal: boolean;
    isNew: boolean;
    listeners: ClientEventHandlers;
    messageHandlers: MessageHandlers;
    nextConnectionAttemptDelayID: TimeoutID | undefined;
    options: Options;
    pendingOperations: TieredMap<RequestTypeEnum, string, object>;
    pingTimeoutID: TimeoutID | undefined;
    shouldReconnect: boolean;
    socket: WebSocket | null;
    subscriptionSet: Set<string>;
    kvFilter: Map<string, string[]>;
    url: string;
    clearAllTimers(this: PubSubClient): void;
    connect(this: PubSubClient): void;
    destroy(this: PubSubClient): void;
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
    [NOTIFICATION_TYPE.ENTRY](this: PubSubClient, msg: {
        data: JSONType;
        type: string;
        [x: string]: unknown;
    }): void;
    [NOTIFICATION_TYPE.PING](this: PubSubClient, msg: {
        data: JSONType;
    }): void;
    [NOTIFICATION_TYPE.PUB](this: PubSubClient, msg: {
        channelID: string;
        data: JSONType;
    }): void;
    [NOTIFICATION_TYPE.KV](this: PubSubClient, msg: {
        channelID: string;
        key: string;
        data: JSONType;
    }): void;
    [NOTIFICATION_TYPE.SUB](this: PubSubClient, msg: {
        channelID: string;
        type: string;
        data: JSONType;
    }): void;
    [NOTIFICATION_TYPE.UNSUB](this: PubSubClient, msg: {
        channelID: string;
        type: string;
        data: JSONType;
    }): void;
    [RESPONSE_TYPE.ERROR](this: PubSubClient, msg: {
        data: {
            type: string;
            channelID: string;
            data: JSONType;
            reason: string;
            actionType?: string;
            message?: string;
        };
    }): void;
    [RESPONSE_TYPE.OK](this: PubSubClient, msg: {
        data: {
            type: string;
            channelID: string;
            kvFilter?: string[];
        };
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
} & {
    kvFilter?: Array<string>;
};
export type UnsubMessage = {
    [key: string]: JSONType;
    type: 'unsub';
    channelID: string;
};
export declare const PUBSUB_ERROR = "pubsub-error";
export declare const PUBSUB_RECONNECTION_ATTEMPT = "pubsub-reconnection-attempt";
export declare const PUBSUB_RECONNECTION_FAILED = "pubsub-reconnection-failed";
export declare const PUBSUB_RECONNECTION_SCHEDULED = "pubsub-reconnection-scheduled";
export declare const PUBSUB_RECONNECTION_SUCCEEDED = "pubsub-reconnection-succeeded";
export declare const PUBSUB_SUBSCRIPTION_SUCCEEDED = "pubsub-subscription-succeeded";
declare class TieredMap<K, L, V> extends Map<K, Map<L, V>> {
    tGet(k1: K, k2: L): V | undefined;
    tHas(k1: K, k2: L): boolean;
    tSet(k1: K, k2: L, v: V): Map<L, V>;
    tDelete(k1: K, k2: L): boolean;
    tClear(k1: K): void;
}
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
export declare function createClient(url: string, options?: Partial<Options>): PubSubClient;
export declare function createMessage(type: string, data: JSONType, meta?: object | null | undefined): {
    type: string;
    data: JSONType;
    [x: string]: JSONType;
};
export declare function createKvMessage(channelID: string, key: string, data: JSONType): string;
export declare function createPubMessage(channelID: string, data: JSONType): string;
export declare function createRequest(type: RequestTypeEnum, data: JSONObject): string;
export declare const messageParser: (data: string) => Message;
declare const _default: {
    NOTIFICATION_TYPE: Readonly<{
        ENTRY: "entry";
        DELETION: "deletion";
        KV: "kv";
        KV_FILTER: "kv_filter";
        PING: "ping";
        PONG: "pong";
        PUB: "pub";
        SUB: "sub";
        UNSUB: "unsub";
        VERSION_INFO: "version_info";
    }>;
    REQUEST_TYPE: Readonly<{
        PUB: "pub";
        SUB: "sub";
        UNSUB: "unsub";
        PUSH_ACTION: "push_action";
        KV_FILTER: "kv_filter";
    }>;
    RESPONSE_TYPE: Readonly<{
        ERROR: "error";
        OK: "ok";
    }>;
    createClient: typeof createClient;
    createMessage: typeof createMessage;
    createRequest: typeof createRequest;
};
export default _default;
