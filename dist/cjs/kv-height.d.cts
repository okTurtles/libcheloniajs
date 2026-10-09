import type { CheloniaContext, KvHeightAheadCause, KvHeightAheadMode } from './types.cjs';
export declare const KV_HEIGHT_WAIT_MS = 1500;
export declare const KV_HEIGHT_PENDING_FALLBACK_MS = 10000;
export declare const KV_HEIGHT_RECOVERY_TIMEOUT_MS = 30000;
export declare const KV_DEFAULT_MAX_HEIGHT_RECOVERIES = 2;
export type KvHeightTimings = {
    waitMs: number;
    pendingFallbackMs: number;
    recoveryTimeoutMs: number;
};
export declare const kvHeightTimings: () => KvHeightTimings;
export declare const setKvHeightTimings: (overrides?: Partial<KvHeightTimings> | null) => KvHeightTimings;
export declare function isKvHeightAhead(e: unknown): e is Error & {
    cause: KvHeightAheadCause;
};
export declare function kvHeightAheadCause(e: unknown): KvHeightAheadCause | undefined;
export declare function localContractHeight(ctx: CheloniaContext, contractID: string): number | undefined;
export declare function isHeightReached(ctx: CheloniaContext, contractID: string, minHeight: number): boolean;
export declare function readKvValueHeight(serializedData: unknown): number;
export declare function kvHeightAheadError(ctx: CheloniaContext, contractID: string, key: string, { requiredHeight, exact, etag, status }: Omit<KvHeightAheadCause, 'localHeight'>): Error & {
    cause: KvHeightAheadCause;
};
export declare function abortReason(signal: AbortSignal): unknown;
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function addHeightListener(ctx: CheloniaContext, contractID: string, minHeight: number, fire: () => void): () => void;
export declare function notifyContractHeight(ctx: CheloniaContext, contractID: string, height: number): void;
export declare function waitForContractHeight(ctx: CheloniaContext, contractID: string, minHeight: number, { timeoutMs, signal }?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<boolean>;
export declare function recoverContractHeight(ctx: CheloniaContext, contractID: string, error: unknown, { signal, abortSignal }?: {
    signal?: AbortSignal;
    abortSignal?: AbortSignal;
}): Promise<void>;
export type KvHeightRecoveryOptions = {
    onHeightAhead?: KvHeightAheadMode;
    maxHeightRecoveries?: number;
    signal?: AbortSignal;
};
export declare function invalidHeightRecoveryOptions({ onHeightAhead, maxHeightRecoveries }: KvHeightRecoveryOptions): string | undefined;
export declare function withHeightRecovery<T>(ctx: CheloniaContext, contractID: string, attempt: (recoveries: number) => Promise<T>, { onHeightAhead, maxHeightRecoveries, signal }?: KvHeightRecoveryOptions): Promise<T>;
