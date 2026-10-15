import type { CheloniaContext, KvHeightAheadCause, KvHeightAheadMode, KvHeightRecoveryAttempt, KvHeightRecoveryOptions, KvHeightWait } from './types.cjs';
export declare const KV_HEIGHT_WAIT_MS = 1500;
export declare const KV_HEIGHT_PENDING_FALLBACK_MS = 10000;
export declare const KV_HEIGHT_RECOVERY_TIMEOUT_MS = 30000;
export declare const KV_DEFAULT_MAX_HEIGHT_RECOVERIES = 2;
export declare const KV_MAX_STALE_STAMP_RETRIES = 5;
export type KvHeightTimings = {
    waitMs: number;
    pendingFallbackMs: number;
    recoveryTimeoutMs: number;
};
export declare const kvHeightTimings: () => KvHeightTimings;
export type KvHeightTimingOverrides = Partial<Record<keyof KvHeightTimings, number | null>>;
export declare const setKvHeightTimings: (overrides?: KvHeightTimingOverrides | null) => KvHeightTimings;
export declare function localContractHeight(ctx: CheloniaContext, contractID: string): number | undefined;
export declare function isHeightReached(ctx: CheloniaContext, contractID: string, minHeight: number): boolean;
export declare function pubsubSocketNotOpen(ctx: CheloniaContext): boolean;
export declare function readHeightStamp(serializedData: unknown, ErrorClass?: new (message: string) => Error): number;
export declare function kvHeightAheadMessage(ctx: CheloniaContext, contractID: string, key: string, { requiredHeight, exact }: Pick<KvHeightAheadCause, 'requiredHeight' | 'exact'>): string;
export declare function kvHeightAheadError(ctx: CheloniaContext, contractID: string, key: string, { requiredHeight, exact, etag, httpStatus }: Omit<KvHeightAheadCause, 'localHeight'>): Error & {
    cause: KvHeightAheadCause;
};
export declare function abortReason(signal: AbortSignal): unknown;
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function raceAbort<T>(promise: Promise<T>, signals: Array<AbortSignal | undefined>): Promise<T>;
export declare function queueAbortable<T>(contractID: string, signals: Array<AbortSignal | undefined>, body: () => Promise<T>): {
    result: Promise<T>;
    queued: Promise<void>;
};
export declare function addHeightListener(ctx: CheloniaContext, contractID: string, minHeight: number, fire: () => void): () => void;
export declare function notifyContractHeight(ctx: CheloniaContext, contractID: string, height: number): void;
export declare function clearWaitTimer(wait: KvHeightWait): void;
export declare function dropHeightWait(ctx: CheloniaContext, waitKey: string, wait: KvHeightWait): void;
export declare function clearHeightWaits(ctx: CheloniaContext): void;
export declare function delayUnlessAborted(ms: number, signals: AbortSignal[]): Promise<void>;
export declare function waitForContractHeight(ctx: CheloniaContext, contractID: string, minHeight: number, { timeoutMs, signals }?: {
    timeoutMs?: number;
    signals?: Array<AbortSignal | undefined>;
}): Promise<boolean>;
export declare function waitForSyncEnd(ctx: CheloniaContext, contractID: string, { timeoutMs, signals }?: {
    timeoutMs?: number;
    signals?: Array<AbortSignal | undefined>;
}): Promise<boolean>;
export declare function recoverContractHeight(ctx: CheloniaContext, contractID: string, error: unknown, { callerSignal, sessionSignal, requiredHeight }?: {
    callerSignal?: AbortSignal;
    sessionSignal?: AbortSignal;
    requiredHeight?: number;
}): Promise<void>;
export declare function resolveHeightRecoveryOptions(label: string, { onHeightAhead, maxHeightRecoveries }: KvHeightRecoveryOptions): {
    mode: KvHeightAheadMode;
    maxRecoveries: number;
};
export declare function isValidMaxAttempts(maxAttempts: unknown): boolean;
export declare function assertValidMaxAttempts(label: string, maxAttempts: unknown): void;
export declare function withHeightRecovery<T>(ctx: CheloniaContext, contractID: string, attempt: (info: KvHeightRecoveryAttempt) => Promise<T>, { onHeightAhead, maxHeightRecoveries, signal }?: KvHeightRecoveryOptions, label?: string): Promise<T>;
