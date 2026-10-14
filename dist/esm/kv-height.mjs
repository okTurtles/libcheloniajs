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
//     (on its internal lane; the operation waits for that sync holding no
//     lane) and retrying the operation.
//
// Everything here is internal: this module is deliberately not re-exported
// from `src/index.ts` (the recovery is public as the
// `chelonia/kv/withHeightRecovery` selector, in `src/kv.ts`).
import sbp from '@sbp/sbp';
import { ChelErrorInvalidMessageHeight, ChelErrorKvHeightAhead, ChelErrorKvUpdateInvalid, ChelErrorUnexpected, isKvHeightAhead, kvHeightAheadCause } from './errors.mjs';
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
// How many times one `chelonia/kv/set` call re-signs its data after a `409`
// (stale height stamp). Each retry already waits for the local contract to
// move past the rejected stamp, so this only stops a server that keeps
// moving ahead faster than this client processes events. Counted
// separately from `maxAttempts`, which bounds `412` conflict resolution.
export const KV_MAX_STALE_STAMP_RETRIES = 5;
let heightWaitMs = KV_HEIGHT_WAIT_MS;
let pendingFallbackMs = KV_HEIGHT_PENDING_FALLBACK_MS;
let recoveryTimeoutMs = KV_HEIGHT_RECOVERY_TIMEOUT_MS;
export const kvHeightTimings = () => ({
    waitMs: heightWaitMs,
    pendingFallbackMs,
    recoveryTimeoutMs
});
// Test hook (exposed through `chelonia/kv/_testSetHeightTimings` outside
// production). Merges `overrides` into the current timings: an omitted
// field keeps its current value and a `null` one resets to its default.
// No argument (or `null`) resets all three.
export const setKvHeightTimings = (overrides) => {
    const { waitMs, pendingFallbackMs: fallbackMs, recoveryTimeoutMs: recoveryMs } = overrides ?? { waitMs: null, pendingFallbackMs: null, recoveryTimeoutMs: null };
    if (waitMs !== undefined)
        heightWaitMs = waitMs ?? KV_HEIGHT_WAIT_MS;
    if (fallbackMs !== undefined)
        pendingFallbackMs = fallbackMs ?? KV_HEIGHT_PENDING_FALLBACK_MS;
    if (recoveryMs !== undefined)
        recoveryTimeoutMs = recoveryMs ?? KV_HEIGHT_RECOVERY_TIMEOUT_MS;
    return kvHeightTimings();
};
export function localContractHeight(ctx, contractID) {
    const height = sbp(ctx.config.stateSelector)?.contracts?.[contractID]?.height;
    return typeof height === 'number' ? height : undefined;
}
export function isHeightReached(ctx, contractID, minHeight) {
    const height = localContractHeight(ctx, contractID);
    return height !== undefined && height >= minHeight;
}
// Whether there is a pubsub client whose socket isn't open (closed, or
// still connecting or closing), so that no contract event can arrive
// through it: a passive wait for the local contract to reach a height can't
// help then. `false` without a pubsub client (e.g. server-side use, or
// before `chelonia/connect`).
export function pubsubSocketNotOpen(ctx) {
    const client = ctx.pubsub;
    return !!client && client.socket?.readyState !== WebSocket.OPEN;
}
// The canonical decimal form of a height stamp, as this library writes it
// (`String(height)`).
const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/;
// Reads the height stamp of a serialized message (a KV value, or any other
// message parsed by `parseEncryptedOrUnencryptedMessage`) without verifying
// it. Throws `ErrorClass` (`ChelErrorInvalidMessageHeight` by default; the
// KV paths pass `ChelErrorKvHeightMalformed`) for a missing or malformed
// stamp: such a value can never become verifiable, so it must not be
// mistaken for "not yet verifiable" (or, as before, for "absent").
//
// A stamp is a safe non-negative integer, or its canonical decimal string.
// Anything else ("1e1", "0x0a", "010", " 10", ...) is malformed: the
// signature covers the stamp as written and the server checks
// `Number(stamp)` against its contract height, so a stamp that parses to a
// different height elsewhere (`parseInt("1e1")` is 1) could get a value
// verified against a key window the server never checked.
export function readHeightStamp(serializedData, ErrorClass = ChelErrorInvalidMessageHeight) {
    const raw = serializedData?.height;
    const height = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && CANONICAL_HEIGHT.test(raw)
            ? Number(raw)
            : NaN;
    if (!Number.isSafeInteger(height) || height < 0) {
        throw new ErrorClass(`[chelonia] Invalid height stamp ${JSON.stringify(raw)}`);
    }
    return height;
}
// What a `ChelErrorKvHeightAhead` for `(contractID, key)` says: the
// height the server requires, and the local contract's. Also the message
// of a slot's `lastError` when its deferred load gives up.
export function kvHeightAheadMessage(ctx, contractID, key, { requiredHeight, exact }) {
    const localHeight = localContractHeight(ctx, contractID);
    // `exact: false` comes from a 409, which may carry no stored value at all:
    // the height is then only a lower bound for the server's contract height.
    const required = exact
        ? `the server value was written at contract height ${requiredHeight}`
        : `the server requires a contract height of at least ${requiredHeight}`;
    const local = localHeight === undefined
        ? 'is not loaded'
        : `is at height ${localHeight}`;
    return `[chelonia/kv] ${contractID}::${key}: ${required}, but the local contract ${local}`;
}
export function kvHeightAheadError(ctx, contractID, key, { requiredHeight, exact, etag, httpStatus }) {
    const localHeight = localContractHeight(ctx, contractID);
    const cause = { requiredHeight, exact, localHeight, etag, httpStatus };
    return new ChelErrorKvHeightAhead(`${kvHeightAheadMessage(ctx, contractID, key, { requiredHeight, exact })}; ` +
        'sync the contract and retry', { cause });
}
// What an operation aborted by `signal` rejects with: the signal's reason
// when it is an `Error`, otherwise an `AbortError`. Used by all the KV code
// (`src/kv.ts`, `chelonia/kv/set`), directly or through `throwIfAborted`.
export function abortReason(signal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortReason(signal);
}
// Settles as `promise` does, unless one of `signals` aborts first (or
// already has): it then rejects with the abort reason. `promise` keeps
// running (e.g. a slot load, which records its outcome on the slot); its
// rejection is handled here, and reaches the caller only while it hasn't
// been abandoned.
export function raceAbort(promise, signals) {
    if (!signals.some(Boolean))
        return promise;
    promise.catch(() => { });
    return withDeadline({ signals }, ({ resolve, reject }) => {
        promise.then(resolve, reject);
    });
}
// Registers `fire` to run (once) when the local height of `contractID`
// reaches `minHeight`. Returns a function that removes the registration.
// The caller is responsible for checking whether the height has already
// been reached; this only reacts to future advances.
export function addHeightListener(ctx, contractID, minHeight, fire) {
    let listeners = ctx.kvHeightListeners.get(contractID);
    if (!listeners) {
        listeners = new Set();
        ctx.kvHeightListeners.set(contractID, listeners);
    }
    const listener = { minHeight, fire };
    listeners.add(listener);
    return () => {
        const current = ctx.kvHeightListeners.get(contractID);
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
// or schedule work. A listener may remove another (or replace the set):
// one removed while this runs is skipped, and the map entry is only
// dropped while it is still this set.
export function notifyContractHeight(ctx, contractID, height) {
    const listeners = ctx.kvHeightListeners.get(contractID);
    if (!listeners)
        return;
    for (const listener of Array.from(listeners)) {
        if (height < listener.minHeight || !listeners.has(listener))
            continue;
        listeners.delete(listener);
        try {
            listener.fire();
        }
        catch (e) {
            console.error(`[chelonia/kv] height listener for ${contractID} threw`, e);
        }
    }
    if (listeners.size === 0 && ctx.kvHeightListeners.get(contractID) === listeners) {
        ctx.kvHeightListeners.delete(contractID);
    }
}
// Stops the fallback timer of a height-deferred load (see `src/kv.ts`,
// "Height-deferred loads").
export function clearWaitTimer(wait) {
    if (wait.timer !== undefined)
        clearTimeout(wait.timer);
    wait.timer = undefined;
}
// Drops a height-deferred load: its fallback timer, its height listener,
// and its registry entry, unless a newer wait replaced it there.
export function dropHeightWait(ctx, waitKey, wait) {
    clearWaitTimer(wait);
    wait.off();
    if (ctx.kvHeightWaits.get(waitKey) === wait)
        ctx.kvHeightWaits.delete(waitKey);
}
// Drops every height-deferred load and height listener of `ctx`. Used by
// `chelonia/kv/_endHeightSession`, the test-only
// `chelonia/kv/_testClearHeightWaits`, and `clearKvRuntime` (`kv-runtime.ts`),
// which must clear the context it is given rather than the one the
// selectors are registered with.
export function clearHeightWaits(ctx) {
    for (const [waitKey, wait] of Array.from(ctx.kvHeightWaits)) {
        dropHeightWait(ctx, waitKey, wait);
    }
    ctx.kvHeightListeners.clear();
    ctx.kvHeightReloadsQueued.clear();
}
// A promise that `start` settles through the `resolve` / `reject` it
// receives, unless `timeoutMs` (when given) elapses first (`onTimeout`
// settles it then) or one of `signals` aborts first (it rejects with the
// abort reason). When one has already aborted, it rejects at once, without
// calling `start`. Whichever settles it first wins; the timer, the abort
// listeners and the cleanup function `start` returns are released at that
// point. A `start` that throws rejects it.
function withDeadline({ signals, timeoutMs, onTimeout }, start) {
    const active = signals.filter((s) => !!s);
    const alreadyAborted = active.find((s) => s.aborted);
    if (alreadyAborted)
        return Promise.reject(abortReason(alreadyAborted));
    return new Promise((resolve, reject) => {
        let settled = false;
        // Replaced by the cleanup function `start` returns.
        let stop = () => { };
        let timer;
        const release = () => {
            if (settled)
                return false;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            for (const s of active)
                s.removeEventListener('abort', onAbort);
            stop?.();
            return true;
        };
        const settle = {
            resolve: (value) => { if (release())
                resolve(value); },
            reject: (reason) => { if (release())
                reject(reason); }
        };
        // Only called by an `abort` event, so one of the signals is aborted.
        const onAbort = () => settle.reject(abortReason(active.find((s) => s.aborted)));
        if (timeoutMs !== undefined)
            timer = setTimeout(() => onTimeout(settle), timeoutMs);
        for (const s of active)
            s.addEventListener('abort', onAbort, { once: true });
        try {
            stop = start(settle);
        }
        catch (e) {
            settle.reject(e);
        }
        // `start` settled it synchronously, before `stop` was known.
        if (settled)
            stop?.();
    });
}
// Resolves after `ms`, unless one of `signals` aborts first: it then
// rejects with the abort reason (at once when one already has).
export function delayUnlessAborted(ms, signals) {
    return withDeadline({ signals, timeoutMs: ms, onTimeout: ({ resolve }) => resolve() }, () => { });
}
// Waits, without touching any queue, until the local contract reaches
// `minHeight`. Resolves `true` when it does (at once when it already has)
// and `false` when `timeoutMs` elapses first (at once when it isn't
// positive). Rejects with the abort reason if any of `signals` aborts
// (at once when one already has and the height isn't reached).
export function waitForContractHeight(ctx, contractID, minHeight, { timeoutMs = heightWaitMs, signals = [] } = {}) {
    if (isHeightReached(ctx, contractID, minHeight))
        return Promise.resolve(true);
    if (!(timeoutMs > 0)) {
        return withDeadline({ signals }, ({ resolve }) => resolve(false));
    }
    return withDeadline({
        signals,
        timeoutMs,
        onTimeout: ({ resolve }) => resolve(isHeightReached(ctx, contractID, minHeight))
    }, ({ resolve }) => addHeightListener(ctx, contractID, minHeight, () => resolve(true)));
}
// Starts (or joins) a sync of `contractID`. Concurrent recoveries on the
// same contract share one sync. The sync runs on the contract's internal
// queue; callers MUST NOT hold the contract's public (`queueInvocation`)
// lane, nor its internal lane (e.g. by awaiting from one of the
// contract's `sideEffect`s), while awaiting it. The internal lane stalls
// the sync until the recovery timeout (`recoveryTimeoutMs`), and the
// retried attempt, which queues on that lane too, then never runs.
//
// The subscription is checked again on the lane, right before syncing.
// `chelonia/contract/release` only queues the removal on that same lane,
// so a removal queued ahead of this sync has unsubscribed the contract by
// the time it runs; syncing it anyway would subscribe it again, with no
// reference left to ever release it.
function startRecoverySync(ctx, contractID) {
    const existing = ctx.kvRecoveries.get(contractID);
    if (existing)
        return existing;
    const sync = Promise.resolve()
        .then(() => sbp('chelonia/private/queueEvent', contractID, () => {
        if (!ctx.subscriptionSet.has(contractID)) {
            throw new ChelErrorUnexpected(`[chelonia/kv] ${contractID} was removed before its height-recovery sync ran`);
        }
        return sbp('chelonia/private/in/syncContract', contractID);
    }))
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
// `ChelErrorKvHeightAhead`). Resolves once the forced sync completes, and
// at once, without a sync, when the local contract has already reached the
// required height (e.g. pubsub delivered the missing events after `error`
// was raised). Rejects with `error` when the contract is not subscribed
// (syncing it would re-subscribe a released contract; checked here as a
// fast path, unless the contract is re-syncing, and again on the
// contract's lane by `startRecoverySync`, behind any re-sync),
// when the sync fails, or when it takes longer than the recovery timeout
// (the sync keeps running), unless the local contract has reached the
// required height by then (e.g. pubsub delivered the missing events
// meanwhile): the operation can then succeed, so this resolves. A sync
// that fails first gets a short passive wait for that height
// (`waitForContractHeight`'s default, none while the pubsub socket is
// closed). The required height is `requiredHeight`, or else `error`'s.
// Note that after a timeout the retried operation's lane work still waits
// behind the sync, which runs on the contract's lane. Rejects with the
// abort reason if the caller's signal, the session's
// (`ctx.abortController`'s, captured when the operation started) or the
// height session (`kvHeightSession`, ended by `chelonia/reset`) aborts; an
// already aborted one rejects before any sync starts, since after a reset
// the sync would run into the next session. Once settled, it logs nothing
// more: a sync that fails after the timeout or an abort is the outcome of
// whoever still waits for it.
export function recoverContractHeight(ctx, contractID, error, { callerSignal, sessionSignal, requiredHeight } = {}) {
    // A re-sync (`currentSyncs`) unsubscribes the contract until its first
    // event is applied again, though it is still wanted: leave the decision
    // to the check on its lane (`startRecoverySync`), which runs after that
    // sync.
    if (!ctx.subscriptionSet.has(contractID) && !ctx.currentSyncs[contractID]) {
        return Promise.reject(error);
    }
    const signals = [callerSignal, sessionSignal, ctx.kvHeightSession.signal];
    const required = requiredHeight ?? kvHeightAheadCause(error)?.requiredHeight;
    // The sync failed or timed out: retrying can still succeed if the height
    // was reached some other way. The warning says which way it went.
    const fail = ({ resolve, reject }, why, cause) => {
        const reached = required !== undefined && isHeightReached(ctx, contractID, required);
        const message = reached
            ? `${why}; retrying, since the contract reached height ${required} anyway`
            : `${why}; giving up on height recovery`;
        if (cause === undefined)
            console.warn(message);
        else
            console.warn(message, cause);
        if (reached)
            resolve();
        else
            reject(error);
    };
    // An already aborted signal rejects before this callback runs, so before
    // any sync starts.
    return withDeadline({
        signals,
        timeoutMs: recoveryTimeoutMs,
        onTimeout: (settle) => fail(settle, `[chelonia/kv] contract sync for ${contractID} did not finish within ${recoveryTimeoutMs} ms`)
    }, (settle) => {
        // Pubsub may have brought the contract there since `error` was raised:
        // the operation can be retried without a sync.
        if (required !== undefined && isHeightReached(ctx, contractID, required)) {
            settle.resolve();
            return;
        }
        const joined = ctx.kvRecoveries.has(contractID);
        let sync = startRecoverySync(ctx, contractID);
        // A sync this call joined may have read the server's HEAD before the
        // server reached `required`: when it ends short of it, start one fresh
        // sync (or join one started since). Both run within this deadline.
        if (joined && required !== undefined) {
            sync = sync.then(() => {
                if (isHeightReached(ctx, contractID, required) || signals.some((s) => s?.aborted))
                    return;
                return startRecoverySync(ctx, contractID);
            });
        }
        let done = false;
        sync.then(() => settle.resolve(), (syncError) => {
            if (done)
                return;
            // Before deciding, give the height a short passive wait outside every
            // lane (none while the pubsub socket is closed, when no event can
            // arrive): pubsub may still deliver the missing events. A timeout
            // needs none, having waited for `recoveryTimeoutMs` already.
            const reached = required === undefined
                ? Promise.resolve(false)
                : waitForContractHeight(ctx, contractID, required, {
                    timeoutMs: pubsubSocketNotOpen(ctx) ? 0 : undefined,
                    signals
                }).catch(() => false);
            reached.then(() => {
                if (done)
                    return;
                fail(settle, `[chelonia/kv] contract sync for ${contractID} failed during height recovery`, syncError);
            });
        });
        return () => { done = true; };
    });
}
// Validates the height-recovery options shared by `update`, `clear`,
// `queuedSet` (through `withHeightRecovery`) and single-key `sync`, and
// fills in the defaults. Invalid input throws `ChelErrorKvUpdateInvalid`,
// whose message starts with `[chelonia/kv] ${label}: ` (e.g. `label` is
// `'update: cID::key'`).
export function resolveHeightRecoveryOptions(label, { onHeightAhead, maxHeightRecoveries }) {
    const invalid = (message) => new ChelErrorKvUpdateInvalid(`[chelonia/kv] ${label}: ${message}`);
    if (onHeightAhead !== undefined && onHeightAhead !== 'sync' && onHeightAhead !== 'reject') {
        throw invalid("`onHeightAhead` must be 'sync' or 'reject'");
    }
    if (maxHeightRecoveries !== undefined &&
        (!Number.isSafeInteger(maxHeightRecoveries) || maxHeightRecoveries < 0)) {
        throw invalid('`maxHeightRecoveries` must be a non-negative integer');
    }
    return {
        mode: onHeightAhead ?? 'sync',
        maxRecoveries: maxHeightRecoveries ?? KV_DEFAULT_MAX_HEIGHT_RECOVERIES
    };
}
// Runs `attempt` and, while it rejects with `ChelErrorKvHeightAhead`, syncs
// the contract and runs it again (up to `maxHeightRecoveries` times).
// `attempt` receives a `KvHeightRecoveryAttempt`. Invalid options reject
// with `ChelErrorKvUpdateInvalid` before `attempt` runs; `label` (e.g.
// `'update: cID::key'`) prefixes that error's message.
//
// `attempt` is expected to enqueue its work on the contract's lane and
// return the lane promise, so the recovery below always runs with the lane
// released. It is called synchronously right after the abort checks, so an
// operation started before `chelonia/reset` can never be re-enqueued after
// the reset aborted it (and one whose signal had already aborted never
// starts).
export async function withHeightRecovery(ctx, contractID, attempt, { onHeightAhead, maxHeightRecoveries, signal } = {}, label = contractID) {
    const { mode, maxRecoveries } = resolveHeightRecoveryOptions(label, { onHeightAhead, maxHeightRecoveries });
    // Captured once: `chelonia/reset` aborts this controller and replaces it.
    const sessionSignal = ctx.abortController.signal;
    for (let recoveries = 0;; recoveries++) {
        throwIfAborted(signal);
        throwIfAborted(sessionSignal);
        const heightWaitMs = mode === 'reject' || recoveries < maxRecoveries ? 0 : undefined;
        try {
            return await attempt({ recoveries, heightWaitMs });
        }
        catch (e) {
            if (!isKvHeightAhead(e) || mode === 'reject' || recoveries >= maxRecoveries)
                throw e;
            throwIfAborted(signal);
            throwIfAborted(sessionSignal);
            await recoverContractHeight(ctx, contractID, e, { callerSignal: signal, sessionSignal });
        }
    }
}
