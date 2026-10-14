import { sleep, until, within, type KvFetchOptions } from './test-utils.mjs';
import type { ChelRootState, JSONType, KvMirrorEntry } from './types.mjs';
export { sleep, until, within };
export declare const CONTRACT_ID = "zKvHeightTestIdentityContract";
export declare const CTYPE = "test-identity";
export declare const UNREAD = "unreadMessages";
export declare const NS_CACHE = "namespace-cache";
export declare const TEST_TIMINGS: {
    waitMs: number;
    pendingFallbackMs: number;
    recoveryTimeoutMs: number;
};
export declare const rootState: () => ChelRootState & Record<string, any>;
type RequestEntry = {
    path: string;
    method: string;
    at: number;
};
declare const makeServer: (initialHeight: number) => {
    height: number;
    store: Map<string, {
        body: string;
        cid: string;
    }>;
    storeOf: (id: string) => Map<string, {
        body: string;
        cid: string;
    }>;
    heightOf: (id: string) => number;
    setHeight: (id: string, height: number) => void;
    put: (key: string, body: string, id?: string) => {
        body: string;
        cid: string;
    };
    log: import("./test-utils.mjs").KvLogEntry[];
    onPost: ((n: number) => void) | null;
    holdGet: Promise<void> | null;
    posts: () => import("./test-utils.mjs").KvLogEntry[];
    gets: () => import("./test-utils.mjs").KvLogEntry[];
    etagOf: (key: string, id?: string) => string;
    handleKv: (pathname: string, opts?: KvFetchOptions) => Promise<Response | undefined>;
} & {
    requests: RequestEntry[];
    catchUpOnSync: boolean;
    syncs: number;
    onSync: ((signal?: AbortSignal) => Promise<void> | void) | null;
    value: (key: string) => any;
    fetch: (url: string, opts?: KvFetchOptions) => Promise<Response>;
};
export declare let server: ReturnType<typeof makeServer>;
export declare let cskId: string;
export declare let cekId: string;
export declare let warnings: unknown[][];
export declare let errors: unknown[][];
export declare let debugs: unknown[][];
export declare const setupContract: (height: number) => void;
export declare const localHeight: () => number;
export declare const kvGetsRequested: () => number;
export declare function setLocalHeight(to: number): void;
export declare const advanceLocalHeightOnInternalLane: (to: number) => any;
export declare const writeAsDeviceB: (key: string, value: JSONType, atHeight: number) => Promise<{
    body: string;
    cid: string;
}>;
export declare const restampedBody: (key: string, stamp: string) => string;
export declare const restamp: (key: string, stamp: string) => string;
export declare const drainLanes: () => Promise<void>;
export declare const failKvGets: (n: number, status?: number, when?: () => boolean) => () => void;
export declare const holdNextSync: (ms?: number, { signal }?: {
    signal?: AbortSignal;
}) => {
    started: Promise<void>;
    release: () => void;
    fail: (error: Error) => void;
};
export declare const addTeardown: (fn: () => void) => void;
export declare const gateLane: () => {
    open: () => void;
    released: Promise<void>;
};
export declare const publicLaneQueued: () => number;
export declare const holdGets: () => {
    release: () => void;
};
export declare const later: (fn: () => void, ms: number) => void;
export declare const untilWarned: (text: string, ms?: number) => Promise<void>;
export declare const probePublicLaneOnSync: () => string[];
export declare const subscribeContract: () => Promise<void>;
export declare const activateContract: () => Promise<void>;
export declare const defineSlot: (def: Record<string, unknown>) => any;
export declare const slotStatus: (key: string) => any;
export declare const whenSettledWithin: (key: string, ms?: number) => Promise<string>;
export declare const mirror: (key: string) => KvMirrorEntry & Record<string, any>;
export declare const onEvent: (event: string, handler: (payload: any) => void) => (() => void);
export declare const collectStatusEvents: (key: string) => {
    events: any[];
    off: () => void;
};
export declare const addChatRoomUnreadMessage: (contractID: string, messageHash: string, createdHeight: number) => (prev?: any) => any;
export declare const initChatRoomUnreadMessages: (contractID: string, messageHash: string, createdHeight: number) => (prev?: any) => any;
export declare const deleteChatRoomUnreadMessages: (contractID: string) => (prev?: any) => any;
export declare const room: (hash: string, h: number, unread?: any[]) => {
    readUntil: {
        messageHash: string;
        createdHeight: number;
    };
    unreadMessages: any[];
};
export declare const V0: {
    roomA: {
        readUntil: {
            messageHash: string;
            createdHeight: number;
        };
        unreadMessages: any[];
    };
};
export declare const VB: {
    roomA: {
        readUntil: {
            messageHash: string;
            createdHeight: number;
        };
        unreadMessages: any[];
    };
    roomB: {
        readUntil: {
            messageHash: string;
            createdHeight: number;
        };
        unreadMessages: any[];
    };
};
export declare const loadV0At40: (key?: string) => Promise<void>;
export declare const setupStaleDeviceA: () => Promise<{
    e0: string | null;
}>;
export declare const installKvHeightHooks: () => void;
