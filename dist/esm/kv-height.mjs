// Height awareness for the KV layer. See KV-REVAMPED.md §3.4.
//
// Every stored KV value is stamped with the contract height it was written
// at, and a client can only verify a value once its local copy of the
// contract has reached that height (the signing key's validity window is
// checked against local contract state). The server additionally only
// accepts a write whose height stamp equals its own current contract height.
// This module holds the machinery the rest of the KV code uses to cope:
//
//   - reading a value's height stamp without verifying it;
//   - waiting, passively, for the local contract to reach a height (nothing
//     is added to any queue, so a wait never creates a lane dependency);
//   - recovering from `ChelErrorKvHeightAhead` by force-syncing the contract
//     outside any queue lane and retrying the operation.
//
// Everything here is internal: this module is deliberately not re-exported
// from `src/index.ts`.
import sbp from '@sbp/sbp';
import { ChelErrorInvalidMessageHeight, ChelErrorKvHeightAhead } from './errors.mjs';
// How long `chelonia/kv/set` (and single-key `chelonia/kv/sync`) wait for
// the local contract to reach a required height before giving up. Matches
// the upper bound of the random back-off `kv/set` already applied between
// conflict retries.
export const KV_HEIGHT_WAIT_MS = 1500;
// How long a slot load deferred on height stays pending before the library
// forces a contract sync and, failing that, settles the slot to `'error'`.
export const KV_HEIGHT_PENDING_FALLBACK_MS = 10000;
// Upper bound on how long an operation waits for the contract sync it
// started to recover from `ChelErrorKvHeightAhead`. The sync itself keeps
// running; only the waiting operation gives up.
export const KV_HEIGHT_RECOVERY_TIMEOUT_MS = 30000;
// Default number of sync-and-retry rounds for `onHeightAhead: 'sync'`.
export const KV_DEFAULT_MAX_HEIGHT_RECOVERIES = 2;
let heightWaitMs = KV_HEIGHT_WAIT_MS;
let pendingFallbackMs = KV_HEIGHT_PENDING_FALLBACK_MS;
let recoveryTimeoutMs = KV_HEIGHT_RECOVERY_TIMEOUT_MS;
export const kvHeightTimings = () => ({
    waitMs: heightWaitMs,
    pendingFallbackMs,
    recoveryTimeoutMs
});
// Test hook (exposed through `chelonia/kv/_testSetHeightTimings` outside
// production). Omitted or `null` fields reset to the defaults.
export const setKvHeightTimings = (overrides) => {
    heightWaitMs = overrides?.waitMs ?? KV_HEIGHT_WAIT_MS;
    pendingFallbackMs = overrides?.pendingFallbackMs ?? KV_HEIGHT_PENDING_FALLBACK_MS;
    recoveryTimeoutMs = overrides?.recoveryTimeoutMs ?? KV_HEIGHT_RECOVERY_TIMEOUT_MS;
    return kvHeightTimings();
};
// Name-based so it also matches errors created by another loaded copy of
// the library (dual ESM/CJS builds), where `instanceof` fails.
export function isKvHeightAhead(e) {
    return !!e && typeof e === 'object' && e.name === 'ChelErrorKvHeightAhead';
}
export function kvHeightAheadCause(e) {
    if (!isKvHeightAhead(e))
        return undefined;
    const cause = e.cause;
    return cause && typeof cause === 'object' ? cause : undefined;
}
export function localContractHeight(ctx, contractID) {
    const height = sbp(ctx.config.stateSelector)?.contracts?.[contractID]?.height;
    return typeof height === 'number' ? height : undefined;
}
export function isHeightReached(ctx, contractID, minHeight) {
    const height = localContractHeight(ctx, contractID);
    return height !== undefined && height >= minHeight;
}
// The canonical decimal form of a height stamp, as this library writes it
// (`String(height)`).
const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/;
// Reads the height stamp of a serialized KV value without verifying it.
// Throws `ChelErrorInvalidMessageHeight` for a missing or malformed stamp:
// such a value can never become verifiable, so it must not be mistaken for
// "not yet verifiable" (or, as before, for "absent").
//
// A stamp is a safe non-negative integer, or its canonical decimal string.
// Anything else ("1e1", "0x0a", "010", " 10", ...) is malformed: the
// signature covers the stamp as written and the server checks
// `Number(stamp)` against its contract height, so a stamp that parses to a
// different height elsewhere (`parseInt("1e1")` is 1) could get a value
// verified against a key window the server never checked.
export function readKvValueHeight(serializedData) {
    const raw = serializedData?.height;
    const height = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && CANONICAL_HEIGHT.test(raw)
            ? Number(raw)
            : NaN;
    if (!Number.isSafeInteger(height) || height < 0) {
        throw new ChelErrorInvalidMessageHeight(`[chelonia/kv] Invalid KV value height ${JSON.stringify(raw)}`);
    }
    return height;
}
export function kvHeightAheadError(ctx, contractID, key, { requiredHeight, exact, etag, status }) {
    const localHeight = localContractHeight(ctx, contractID);
    const cause = { requiredHeight, exact, localHeight, etag, status };
    return new ChelErrorKvHeightAhead(`[chelonia/kv] ${contractID}::${key}: the server value requires contract ` +
        `height ${exact ? '' : 'at least '}${requiredHeight}, but the local contract ` +
        `is at height ${String(localHeight)}; sync the contract and retry`, { cause });
}
// What an operation aborted by `signal` rejects with: the signal's reason
// when it is an `Error`, otherwise an `AbortError`. Shared by all the KV
// code (`src/kv.ts`, `chelonia/kv/set`).
export function abortReason(signal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortReason(signal);
}
// Registers `fire` to run (once) when the local height of `contractID`
// reaches `minHeight`. Returns a function that removes the registration.
// The caller is responsible for checking whether the height has already
// been reached; this only reacts to future advances.
export function addHeightListener(ctx, contractID, minHeight, fire) {
    if (!ctx.kvHeightListeners)
        ctx.kvHeightListeners = new Map();
    let listeners = ctx.kvHeightListeners.get(contractID);
    if (!listeners) {
        listeners = new Set();
        ctx.kvHeightListeners.set(contractID, listeners);
    }
    const listener = { minHeight, fire };
    listeners.add(listener);
    return () => {
        const current = ctx.kvHeightListeners?.get(contractID);
        if (!current)
            return;
        current.delete(listener);
        if (current.size === 0)
            ctx.kvHeightListeners.delete(contractID);
    };
}
// Called once the local height of `contractID` has been committed (from
// `handleEvent.applyProcessResult`, whether or not processing the event
// succeeded). Fires, synchronously, every listener whose target is reached.
// Listeners must not throw and must not block: they only resolve promises
// or schedule work.
export function notifyContractHeight(ctx, contractID, height) {
    const listeners = ctx.kvHeightListeners?.get(contractID);
    if (!listeners)
        return;
    for (const listener of Array.from(listeners)) {
        if (height < listener.minHeight)
            continue;
        listeners.delete(listener);
        try {
            listener.fire();
        }
        catch (e) {
            console.error(`[chelonia/kv] height listener for ${contractID} threw`, e);
        }
    }
    if (listeners.size === 0)
        ctx.kvHeightListeners.delete(contractID);
}
// Waits, without touching any queue, until the local contract reaches
// `minHeight`. Resolves `true` when it does and `false` when `timeoutMs`
// elapses first. Rejects with the abort reason if `signal` aborts.
export function waitForContractHeight(ctx, contractID, minHeight, { timeoutMs = heightWaitMs, signal } = {}) {
    if (isHeightReached(ctx, contractID, minHeight))
        return Promise.resolve(true);
    if (signal?.aborted)
        return Promise.reject(abortReason(signal));
    if (!(timeoutMs > 0))
        return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            off();
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(abortReason(signal));
        };
        const off = addHeightListener(ctx, contractID, minHeight, () => {
            cleanup();
            resolve(true);
        });
        const timer = setTimeout(() => {
            cleanup();
            resolve(isHeightReached(ctx, contractID, minHeight));
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
// Starts (or joins) a forced sync of `contractID`. Concurrent recoveries on
// the same contract share one sync. The sync runs on the contract's
// internal queue; callers MUST NOT hold the contract's public
// (`queueInvocation`) lane while awaiting it.
function startRecoverySync(ctx, contractID) {
    if (!ctx.kvRecoveries)
        ctx.kvRecoveries = new Map();
    const existing = ctx.kvRecoveries.get(contractID);
    if (existing)
        return existing;
    const sync = Promise.resolve()
        .then(() => sbp('chelonia/private/in/sync', contractID, { force: true }))
        .then(() => undefined);
    const clear = () => {
        if (ctx.kvRecoveries.get(contractID) === sync)
            ctx.kvRecoveries.delete(contractID);
    };
    sync.then(clear, clear);
    ctx.kvRecoveries.set(contractID, sync);
    return sync;
}
// Brings the local contract up to date after `error` (a
// `ChelErrorKvHeightAhead`). Resolves once the forced sync completes.
// Rejects with `error` when the contract is not subscribed (syncing it
// would re-subscribe a released contract), when the sync fails, or when it
// takes longer than the recovery timeout (the sync keeps running). Rejects
// with the abort reason if either signal, or the height session
// (`kvHeightSession`, ended by `chelonia/reset`), aborts; an already
// aborted one rejects before any sync starts, since after a reset the sync
// would run into the next session.
export function recoverContractHeight(ctx, contractID, error, { signal, abortSignal } = {}) {
    if (!ctx.subscriptionSet.has(contractID))
        return Promise.reject(error);
    const signals = [signal, abortSignal, ctx.kvHeightSession.signal]
        .filter(Boolean);
    const alreadyAborted = signals.find((s) => s.aborted);
    if (alreadyAborted)
        return Promise.reject(abortReason(alreadyAborted));
    const sync = startRecoverySync(ctx, contractID);
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            for (const s of signals)
                s.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            // Only called by an `abort` event, so one of the signals is aborted.
            reject(abortReason(signals.find((s) => s.aborted)));
        };
        const timer = setTimeout(() => {
            cleanup();
            console.warn(`[chelonia/kv] contract sync for ${contractID} did not finish within ` +
                `${recoveryTimeoutMs} ms; giving up on height recovery`);
            reject(error);
        }, recoveryTimeoutMs);
        for (const s of signals)
            s.addEventListener('abort', onAbort, { once: true });
        sync.then(() => {
            cleanup();
            resolve();
        }, (syncError) => {
            cleanup();
            console.warn(`[chelonia/kv] contract sync for ${contractID} failed during height recovery`, syncError);
            reject(error);
        });
    });
}
// Validates the height-recovery options shared by `update`, `clear` and
// `queuedSet`. Returns the error message for invalid input, or `undefined`.
export function invalidHeightRecoveryOptions({ onHeightAhead, maxHeightRecoveries }) {
    if (onHeightAhead !== undefined && onHeightAhead !== 'sync' && onHeightAhead !== 'reject') {
        return "`onHeightAhead` must be 'sync' or 'reject'";
    }
    if (maxHeightRecoveries !== undefined &&
        (!Number.isSafeInteger(maxHeightRecoveries) || maxHeightRecoveries < 0)) {
        return '`maxHeightRecoveries` must be a non-negative integer';
    }
    return undefined;
}
// Runs `attempt` and, while it rejects with `ChelErrorKvHeightAhead`, syncs
// the contract and runs it again (up to `maxHeightRecoveries` times).
// `attempt` receives the number of recoveries performed so far.
//
// `attempt` is expected to enqueue its work on the contract's lane and
// return the lane promise, so the recovery below always runs with the lane
// released. It is called synchronously right after the abort checks, so an
// operation started before `chelonia/reset` can never be re-enqueued after
// the reset aborted it.
export async function withHeightRecovery(ctx, contractID, attempt, { onHeightAhead, maxHeightRecoveries, signal } = {}) {
    const invalid = invalidHeightRecoveryOptions({ onHeightAhead, maxHeightRecoveries });
    if (invalid)
        throw new TypeError(`[chelonia/kv] ${invalid}`);
    const mode = onHeightAhead ?? 'sync';
    const maxRecoveries = maxHeightRecoveries ?? KV_DEFAULT_MAX_HEIGHT_RECOVERIES;
    // Captured once: `chelonia/reset` aborts this controller and replaces it.
    const abortSignal = ctx.abortController.signal;
    for (let recoveries = 0;; recoveries++) {
        try {
            return await attempt(recoveries);
        }
        catch (e) {
            if (!isKvHeightAhead(e) || mode === 'reject' || recoveries >= maxRecoveries)
                throw e;
            throwIfAborted(signal);
            throwIfAborted(abortSignal);
            await recoverContractHeight(ctx, contractID, e, { signal, abortSignal });
            throwIfAborted(signal);
            throwIfAborted(abortSignal);
        }
    }
}
