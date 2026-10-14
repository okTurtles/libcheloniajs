import { keygen } from '@chelonia/crypto';
import { SPMessage } from './SPMessage.mjs';
import type { SPKey } from './SPMessage.mjs';
export declare const waitMicrotasks: () => Promise<void>;
export declare const sleep: (ms: number) => Promise<void>;
export declare const until: (cond: () => boolean, label: string, ms?: number) => Promise<void>;
export declare const within: <T>(promise: Promise<T>, label: string, ms?: number) => Promise<T>;
export declare const settledOr: <T, P>(promise: Promise<T>, ms: number, pending: P) => Promise<T | P>;
export declare const captureConsole: () => {
    warnings: unknown[][];
    errors: unknown[][];
    debugs: unknown[][];
    restore: () => void;
};
export declare const logged: (calls: unknown[][], text: string) => boolean;
export declare const contractKey: (key: ReturnType<typeof keygen>, name: string, purpose: string[], permissions: "*" | string[]) => SPKey;
export declare const makeSelfSignedContract: ({ type, manifest }: {
    type: string;
    manifest?: string;
}) => {
    message: SPMessage;
    csk: import("@chelonia/crypto").Key;
    sak: import("@chelonia/crypto").Key;
};
export declare const stubKvBackoff: () => void;
export declare const restoreKvTestStubs: () => void;
export declare const useKvSetHooks: () => void;
export declare const withLocalHeight: <T>(contractID: string, height: number, fn: () => T) => T;
export declare const setContractHeight: (contractID: string, height: number) => void;
export declare const setContractHeightLater: (contractID: string, height: number, ms: number) => void;
export declare const whenContractSlotSettledWithin: (contractID: string, key: string, ms?: number) => Promise<string>;
export type KvFetchOptions = {
    method?: string;
    headers?: ConstructorParameters<typeof Headers>[0];
    body?: string;
    signal?: AbortSignal;
};
export type KvLogEntry = {
    method: string;
    contractID?: string;
    key: string;
    status: number;
    ifMatch?: string | null;
    height?: string;
};
type KvStored = {
    body: string;
    cid: string;
};
export declare const makeKvServer: (initialHeight?: number, contractID?: string) => {
    height: number;
    store: Map<string, KvStored>;
    storeOf: (id: string) => Map<string, KvStored>;
    heightOf: (id: string) => number;
    setHeight: (id: string, height: number) => void;
    put: (key: string, body: string, id?: string) => KvStored;
    log: KvLogEntry[];
    onPost: ((n: number) => void) | null;
    holdGet: Promise<void> | null;
    posts: () => KvLogEntry[];
    gets: () => KvLogEntry[];
    etagOf: (key: string, id?: string) => string;
    handleKv: (pathname: string, opts?: KvFetchOptions) => Promise<Response | undefined>;
};
export {};
