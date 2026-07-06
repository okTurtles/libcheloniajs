"use strict";
// KV slot API — see KV-REVAMPED.md for the full design.
//
// This module implements the declarative KV slot API layered on top of
// the `chelonia/kv/{set,get,setFilter}` primitives. It also hooks into
// `chelonia/reset` (via `_waitInFlight`), `chelonia/defineContract`
// (via `_registerContractSlots` / `_cleanupContractSlots`), and the
// pubsub reconnect / KV-notification paths in `chelonia.ts`.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KV_VALIDATION_REASON_REVALIDATE = exports.KV_UPDATE_REASON = exports.KV_NOOP = exports.KV_LOAD_STATUS = exports.KV_DEFAULT_SIGNING_KEY_NAME = exports.KV_DEFAULT_ENCRYPTION_KEY_NAME = exports.KV_AUTO_LOAD = void 0;
require("@sbp/okturtles.events");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const errors_js_1 = require("./errors.cjs");
const events_js_1 = require("./events.cjs");
const kv_constants_js_1 = require("./kv-constants.cjs");
// Internal sentinel thrown by the onconflict callback when the reducer
// returns KV_NOOP. The outer catch checks for the Symbol.for marker via
// `in` (not `instanceof`) so a KvNoopAbort created by another loaded
// copy of this module — e.g. the dual ESM/CJS build of @chelonia/lib in
// the same realm — is still recognised. The class is not exported and
// only this module's onconflict path attaches the marker; it is not a
// general cross-realm error-bridging mechanism.
class KvNoopAbort extends Error {
    name = kv_constants_js_1.KV_NOOP_ABORT_ERROR_NAME;
}
// Realm-safe marker: Symbol.for survives dual ESM/CJS loads.
// Checked on the catch side instead of `instanceof`.
;
KvNoopAbort.prototype[kv_constants_js_1.KV_NOOP_ABORT_SYMBOL] = true;
// Echo-CID TTL clock. Deliberately `performance.now()` (monotonic)
// rather than the spec's `Date.now()`: it is immune to wall-clock / NTP
// adjustments, so a backwards clock step can never prematurely expire a
// pending self-echo and let a write's own echo regress the mirror. The
// only tradeoff is that backgrounded/throttled tabs may advance it
// slowly, extending the effective TTL — which merely makes echo
// suppression more conservative and never drops a real frame early.
// Both record and check use this same source, so TTL accounting stays
// internally consistent.
const defaultNowMs = () => performance.now();
let nowMs = defaultNowMs;
// Backoff before retrying a transiently-failed `setFilter` flush. Held
// in a mutable module-level binding (mirroring `nowMs`) so tests can
// shrink it to 0 via `chelonia/kv/_testSetFilterRetryMs` and exercise
// the retry deterministically without a real 2 s wait.
let filterRetryMs = kv_constants_js_1.KV_FILTER_RETRY_MS;
// Maximum nesting depth accepted by `assertJsonShape`. Guards against
// pathological (e.g. circular) values that a buggy or malicious schema
// could produce from `schema.parse`, which would otherwise infinite-loop
// the recursive walker and hang the realm. 1000 is well above any
// legitimate JSON value while keeping the recursion stack bounded.
const MAX_JSON_DEPTH = 1000;
const registryKey = (contractType, key) => `${contractType}${kv_constants_js_1.KV_KEY_SEPARATOR}${key}`;
// Resolve a public `KvSlotDefinition` into its internal `SlotDefinition`
// form. `contractType` arrays are flattened by the caller; this helper
// produces one `SlotDefinition` per (already-singular) `contractType`.
//
// The `defaultValue` factory is invoked exactly once here — per the
// KV-REVAMPED §4.1 contract that factories run at registration time
// and the result is what every subsequent reader sees.
function resolveSlotDefinition(def, contractType, resolvedDefault, source) {
    return {
        contractType,
        key: def.key,
        defaultValue: def.defaultValue,
        resolvedDefault,
        schema: def.schema,
        match: def.match,
        encryptionKeyName: def.encryptionKeyName === null
            ? null
            : def.encryptionKeyName ?? kv_constants_js_1.KV_DEFAULT_ENCRYPTION_KEY_NAME,
        signingKeyName: def.signingKeyName ?? kv_constants_js_1.KV_DEFAULT_SIGNING_KEY_NAME,
        defaultUpdater: def.defaultUpdater,
        autoSubscribe: def.autoSubscribe ?? true,
        autoLoad: def.autoLoad ?? kv_constants_js_1.KV_AUTO_LOAD.ON_SYNC,
        refreshOnReconnect: def.refreshOnReconnect ?? true,
        onUpdate: def.onUpdate,
        source
    };
}
function resolveSlotKeyIds(contractID, key, slot, operation) {
    const encryptionKeyId = slot.encryptionKeyName === null
        ? null
        : (0, sbp_1.default)('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName);
    const signingKeyId = (0, sbp_1.default)('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName);
    if (slot.encryptionKeyName !== null && !encryptionKeyId) {
        throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] ${operation}: ${contractID}::${key} — encryption key ` +
            `'${slot.encryptionKeyName}' not found on contract; refusing to write plaintext`);
    }
    if (!signingKeyId) {
        throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] ${operation}: ${contractID}::${key} — signing key ` +
            `'${slot.signingKeyName}' not found on contract`);
    }
    return { encryptionKeyId, signingKeyId };
}
function assertParsedDefaultValue(slot, value, pass) {
    if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(() => { });
        throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
            'async/thenable schema parser; v1 supports synchronous parsers only');
    }
    if (value === null || value === undefined) {
        throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema.parse ` +
            `returned the reserved sentinel ${String(value)} for the defaultValue; ` +
            'null and undefined are reserved for wire/clear semantics');
    }
    try {
        assertJsonShape(value, `defineSlot defaultValue ${pass} parse ${slot.contractType}::${slot.key}`);
    }
    catch (e) {
        throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema.parse ` +
            'produced an invalid defaultValue (reserved sentinel or non-JSON value)', { cause: e });
    }
}
// KV-REVAMPED §4.1: three registration-time guards against schemas
// that collide with the wire sentinels or are async-only.
//
// 1. `schema.parse(null)` succeeds → `null` is reserved as the clear
//    sentinel, so the schema cannot disambiguate "cleared" from
//    "explicit null".
// 2. `schema.parse(undefined)` succeeds → collides with the mirror's
//    "not yet loaded" representation.
// 3. `resolvedDefault` round-trip: the first `parse` is allowed to
//    transform the default (e.g. adding derived fields), and
//    `parse(parse(x))` must produce a JSON-equal value to the first
//    parse (idempotence), catching schemas that silently drop or
//    coerce fields across repeated applications.
//
// Additionally, any `schema.parse` that returns a thenable is
// rejected — v1 supports synchronous parsers only. Thenable detection
// runs on the sentinel probes and on the resolvedDefault parse; no
// arbitrary `{}` probe is used (schemas that only reveal async
// behaviour on future valid inputs will fail at runtime with
// `ChelErrorKvValidation`).
function assertSchemaGuards(slot) {
    const schema = slot.schema;
    if (!schema)
        return;
    // Guard 1 + 2 + thenable detection in one pass per sentinel.
    for (const sentinel of [null, undefined]) {
        let parsed;
        try {
            parsed = schema.parse(sentinel);
        }
        catch {
            continue; // schema correctly rejected the sentinel
        }
        if (parsed && typeof parsed.then === 'function') {
            Promise.resolve(parsed).catch(() => { });
            throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
                'async/thenable schema parser; v1 supports synchronous parsers only');
        }
        throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema must ` +
            `reject the reserved wire sentinel ${String(sentinel)}`);
    }
    // Guard 3: round-trip of resolvedDefault.
    // Skipped when there is no resolvedDefault — nothing to round-trip.
    if (slot.resolvedDefault !== undefined) {
        let first;
        try {
            first = schema.parse(slot.resolvedDefault);
        }
        catch (e) {
            throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} resolved ` +
                'defaultValue failed schema.parse at registration', { cause: e });
        }
        assertParsedDefaultValue(slot, first, 'first');
        // Idempotence check (KV-REVAMPED §4.1 guard 3): parse(parse(x))
        // must produce the same result as parse(x). The first parse is
        // allowed to transform the default (e.g. adding normalised
        // fields); the second parse must accept that transformed output
        // unchanged.
        let second;
        try {
            second = schema.parse(first);
        }
        catch (e) {
            throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema is ` +
                'not idempotent on its own parsed output (defaultValue round-trip failed)', { cause: e });
        }
        assertParsedDefaultValue(slot, second, 'second');
        if (!(0, turtledash_1.deepEqualJSONType)(first, second)) {
            throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema ` +
                'is not idempotent on its own parsed output (defaultValue round-trip failed)');
        }
        // Normalise: store the schema-parsed output as the effective default so
        // that schema transforms (e.g. adding `normalized: true`) are reflected
        // in defaults served by `chelonia/kv/read` (KV-REVAMPED §4.1).
        ;
        slot.resolvedDefault = first;
    }
}
// Post-parse sentinel guard: rejects `null` or `undefined` from a schema
// that passed `assertSchemaGuards` at registration but now somehow
// produces a reserved sentinel at runtime (e.g. a schema whose `parse`
// strips fields until only `undefined` remains). Also rejects thenables
// that escaped the registration-time async probe.
//
// Returns the validated value cast as `JSONType`.
function parseSyncSlotValue(slot, input, where) {
    const parsed = slot.schema.parse(input);
    if (parsed && typeof parsed.then === 'function') {
        Promise.resolve(parsed).catch(() => { });
        throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
            'produced a thenable; v1 supports synchronous parsers only');
    }
    if (parsed === null || parsed === undefined) {
        throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
            `schema.parse returned the reserved sentinel ${String(parsed)}; ` +
            'null and undefined are reserved for wire/clear semantics');
    }
    return assertJsonShape(parsed, where);
}
function assertJsonShape(input, where) {
    const visit = (value, path, depth) => {
        if (depth > MAX_JSON_DEPTH) {
            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} exceeded max depth (possible circular reference)`);
        }
        if (value === null || value === undefined) {
            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} is the reserved sentinel ${String(value)}`);
        }
        const t = typeof value;
        if (t === 'string' || t === 'boolean')
            return;
        if (t === 'number') {
            if (Number.isFinite(value))
                return;
            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} has non-finite number ${String(value)}`);
        }
        if (t === 'bigint' || t === 'function' || t === 'symbol') {
            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} has non-JSON type ${t}`);
        }
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++)
                visit(value[i], `${path}[${i}]`, depth + 1);
            return;
        }
        if (value && typeof value === 'object') {
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
                throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} has non-plain object prototype`);
            }
            for (const [k, v] of Object.entries(value)) {
                visit(v, `${path}.${k}`, depth + 1);
            }
            return;
        }
        throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} is not JSON-shaped`);
    };
    visit(input, 'value', 0);
    return input;
}
// Ensure `rootState._kv[contractID]` exists as a reactive object. Returns
// the per-contract record. Idempotent.
//
// PRECONDITION: callers MUST have already verified an active slot /
// subscription for `contractID` — this helper CREATES the
// `_kv[contractID]` record if absent, so calling it for a contract with
// no active slots would leave an orphaned, never-cleaned-up empty record
// in persisted state. A read-only caller that must not create the record
// should follow `setSlotStatus`'s non-destructive pattern
// (`rootState._kv?.[contractID]?.[key]`) instead.
function ensureContractKv(ctx, rootState, contractID) {
    if (!rootState._kv) {
        ctx.config.reactiveSet(rootState, '_kv', Object.create(null));
    }
    const perContract = rootState._kv[contractID];
    if (!perContract) {
        const fresh = Object.create(null);
        ctx.config.reactiveSet(rootState._kv, contractID, fresh);
        return fresh;
    }
    return perContract;
}
// Emit a `CHELONIA_KV_STATUS_CHANGED` event after writing status / lastError
// onto the mirror entry. Skips the emit only when both status and lastError
// are unchanged.
function setSlotStatus(ctx, rootState, contractID, contractType, key, status, lastError) {
    // Check-then-create: read the entry WITHOUT forcing creation of the
    // `_kv[contractID]` record. `ensureContractKv` would create that record
    // before the existence check below, leaving an orphaned empty record in
    // prod when the per-key entry is missing. Every legitimate caller seeds
    // the entry (and thus the record) first, so reading non-destructively is
    // safe here.
    const entry = rootState._kv?.[contractID]?.[key];
    if (!entry) {
        if (process.env.NODE_ENV !== 'production') {
            throw new Error(`[chelonia/kv] setSlotStatus called for ${contractID}::${key} before ` +
                'the mirror entry was seeded');
        }
        return;
    }
    const previousStatus = entry.status;
    const statusUnchanged = previousStatus === status;
    // `lastErrorChanged` detects a structural difference (name or message)
    // between the new and old error objects. It is false when both sides
    // carry an error with identical content AND when neither side has an
    // error. Those two cases are disambiguated by the early return below:
    // when the status is also unchanged we skip the event and reactivity
    // entirely (identical-error repeat or plain no-op); only a genuine
    // change in status or error content falls through to mutate the entry.
    const lastErrorChanged = !!lastError !== !!entry.lastError ||
        (lastError && entry.lastError &&
            (lastError.name !== entry.lastError.name ||
                lastError.message !== entry.lastError.message));
    // Status unchanged AND error content unchanged → nothing to do. A
    // repeated identical validation error therefore emits no
    // CHELONIA_KV_STATUS_CHANGED; the diagnostic CHELONIA_KV_VALIDATION_ERROR
    // is emitted separately by the caller and still fires every time.
    if (statusUnchanged && !lastErrorChanged)
        return;
    if (!statusUnchanged) {
        ctx.config.reactiveSet(entry, 'status', status);
    }
    if (!lastError && entry.lastError) {
        ctx.config.reactiveDel(entry, 'lastError');
    }
    else if (lastError) {
        ctx.config.reactiveSet(entry, 'lastError', lastError);
    }
    (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_STATUS_CHANGED, {
        contractID,
        contractType,
        key,
        status,
        previousStatus,
        // Representation note: the EVENT always carries `lastError` —
        // normalized to `null` when there is no error — whereas the mirror
        // ENTRY omits the property entirely when absent (`lastError?` is
        // optional on `KvMirrorEntry`, and is `reactiveDel`'d above). This is
        // intentional and is asserted by tests: an event listener reads
        // `event.lastError === null` for "no error", while a mirror reader
        // sees `entry.lastError === undefined`. Code diffing the two
        // representations must treat `null` (event) and `undefined` (entry) as
        // equivalent "no error".
        ...(lastError ? { lastError } : { lastError: null })
    });
}
// Normalize a thrown value into `{ name, message }`, matching the
// convention used elsewhere in the library (see journal.ts).
function normalizeError(e) {
    if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
        const err = e;
        return {
            name: typeof err.name === 'string' ? err.name : 'Error',
            message: typeof err.message === 'string' ? err.message : String(e)
        };
    }
    let message;
    try {
        message = String(e);
    }
    catch {
        message = '';
    }
    return { name: 'Error', message };
}
// Realm-safe detection of the low-level conflict-exhaustion error.
// `ChelErrorGenerator` assigns `.name` from a string literal (see
// errors.ts), so it survives a dual ESM/CJS or cross-realm load of
// `@chelonia/lib` where `instanceof ChelErrorKvMaxAttempts` would fail
// against an error constructed by the other copy. This mirrors the
// `Symbol.for`-based realm safety of the `KV_NOOP` path (kv-constants.ts).
function isKvMaxAttempts(e) {
    return e instanceof Error && e.name === 'ChelErrorKvMaxAttempts';
}
// Resolve the contract type from rootState. The spec (KV-REVAMPED §4.2
// step 1) resolves via _vm.type; in the actual data model the same value
// is also stored on rootState.contracts[contractID].type. Prefer the
// registry copy and fall back to the contract state's _vm.type.
function getContractType(rootState, contractID) {
    const fromRegistry = rootState.contracts?.[contractID]?.type;
    if (fromRegistry != null)
        return fromRegistry;
    const cs = rootState[contractID];
    return cs?._vm?.type;
}
// Resolve a slot from the per-contract *active* index
// (kvSlotsByContractID), enforcing match-gating for public selectors.
// Throws ChelErrorKvSlotUnknown if the contract isn't synced, has no
// type, or the slot isn't active for that contract (match returned false
// or the slot was never registered for the contract's type).
function resolveActiveSlot(ctx, rootState, contractID, key, label) {
    const contractMeta = rootState.contracts?.[contractID];
    if (!contractMeta || !ctx.subscriptionSet.has(contractID)) {
        throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: contract ${contractID} is not synced`);
    }
    const contractType = getContractType(rootState, contractID);
    if (typeof contractType !== 'string') {
        throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: contract ${contractID} has no resolved type`);
    }
    const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key);
    if (!slot) {
        throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: no active slot for ${contractID}::${key}`);
    }
    return slot;
}
function purgeExpiredEchoCIDs(ctx, echoKey, now = nowMs()) {
    const cids = ctx.kvLocalEchoCIDs.get(echoKey);
    if (!cids)
        return;
    for (const [cid, entry] of cids) {
        if (entry.expiry <= now)
            cids.delete(cid);
    }
    if (cids.size === 0)
        ctx.kvLocalEchoCIDs.delete(echoKey);
}
// Track a server-issued data CID for self-echo suppression.
function recordEchoCID(ctx, contractID, key, cid, fromConflict) {
    if (typeof cid !== 'string' || cid.length === 0)
        return;
    const echoKey = `${contractID}${kv_constants_js_1.KV_KEY_SEPARATOR}${key}`;
    const now = nowMs();
    purgeExpiredEchoCIDs(ctx, echoKey, now);
    let cids = ctx.kvLocalEchoCIDs.get(echoKey);
    if (!cids) {
        cids = new Map();
        ctx.kvLocalEchoCIDs.set(echoKey, cids);
    }
    cids.set(cid, { expiry: now + kv_constants_js_1.KV_ECHO_TTL_MS, fromConflict });
    if (cids.size > kv_constants_js_1.KV_ECHO_CID_MAX) {
        const targets = Array.from(cids.entries())
            // Never evict the entry we just recorded: under a pathological
            // burst of conflict markers (a full bucket of `fromConflict:
            // true`), the sort below would rank this fresh non-conflict CID
            // ahead of them and slice it off immediately — so the current
            // write's own echo would arrive unsuppressed. Excluding `cid`
            // guarantees this write can always be self-echo-suppressed. The
            // eviction still brings the bucket back to the cap, but the
            // victim may be a conflict marker (the earliest-expiry one)
            // rather than the fresh CID — the right tradeoff, since an
            // unsuppressed self-echo is a definite bug while a lost conflict
            // marker only risks a self-healing last-write-wins regression
            // under a scenario the cap itself calls "not expected in normal
            // operation."
            .filter(([entryCID]) => entryCID !== cid)
            .sort((a, b) => {
            // Evict non-conflict entries before conflict markers: dropping a
            // `fromConflict` marker would let a competing frame regress the
            // mirror via last-write-wins. Within a class, evict earliest
            // expiry first.
            if (a[1].fromConflict !== b[1].fromConflict) {
                return a[1].fromConflict ? 1 : -1;
            }
            return a[1].expiry - b[1].expiry;
        })
            .slice(0, cids.size - kv_constants_js_1.KV_ECHO_CID_MAX);
        for (const [tCID] of targets)
            cids.delete(tCID);
    }
}
// Per-contract pending-write counter. `chelonia/kv/update` and
// `chelonia/kv/clear` increment this at call time (before their queued
// body runs) and decrement it from inside the body's `finally`. The
// counter is the third source for `chelonia/kv/_waitInFlight` so a
// write whose slot index entry and echo CID have both been removed
// mid-flight (contract release, match→false, defineSlot replacement)
// still settles before `chelonia/reset` tears down state. See the
// `_waitInFlight` comment for the full three-source rationale.
function incrementPending(ctx, contractID) {
    ctx.kvPendingWrites.set(contractID, (ctx.kvPendingWrites.get(contractID) ?? 0) + 1);
}
function decrementPending(ctx, contractID) {
    const n = (ctx.kvPendingWrites.get(contractID) ?? 1) - 1;
    if (n <= 0)
        ctx.kvPendingWrites.delete(contractID);
    else
        ctx.kvPendingWrites.set(contractID, n);
}
// Per-contract pending-load counter. Incremented by both `_loadSlot`
// (on schedule, to cover the queued-but-not-started window) and
// `_loadSlotNow` (on entry, to cover direct callers like `_handleRemote`
// and `update`'s silent reload). A load that flows `_loadSlot` →
// `_loadSlotNow` therefore increments twice for one logical operation;
// this is intentional — the only consumer is `defineSlot`'s `> 0` gate,
// so the inflation is harmless. Do NOT rely on the exact count for
// "exactly one load in flight" assertions or telemetry.
// `defineSlot`'s post-reconcile gate consults it so a slot replaced
// while a load is queued-but-not-started (status still `loaded`, so the
// `unloaded` check misses it) schedules a fresh load for the replacement
// rather than revalidating a value the superseded load is about to
// discard at its staleness guard.
function incrementPendingLoad(ctx, contractID) {
    ctx.kvPendingLoads.set(contractID, (ctx.kvPendingLoads.get(contractID) ?? 0) + 1);
}
function decrementPendingLoad(ctx, contractID) {
    const n = (ctx.kvPendingLoads.get(contractID) ?? 1) - 1;
    if (n <= 0)
        ctx.kvPendingLoads.delete(contractID);
    else
        ctx.kvPendingLoads.set(contractID, n);
}
function throwIfSignalAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
}
function kvConflictCause(e) {
    const cause = e?.cause;
    return cause && typeof cause === 'object' ? cause : undefined;
}
function normalizeKvConflictCurrentData(slot, contractID, key, cause) {
    if (!cause || !(0, turtledash_1.has)(cause, 'currentData'))
        return { present: false };
    const currentData = cause.currentData;
    if (currentData === undefined)
        return { present: true, currentData: undefined };
    if (currentData === null) {
        return {
            present: true,
            currentData: slot.resolvedDefault !== undefined
                ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                : undefined
        };
    }
    if (slot.schema) {
        return {
            present: true,
            currentData: parseSyncSlotValue(slot, currentData, `conflict cause ${contractID}::${key}`)
        };
    }
    return {
        present: true,
        currentData: assertJsonShape(currentData, `conflict cause ${contractID}::${key}`)
    };
}
// Invoke `onUpdate` with the dispatcher's MUST-NOT-throw contract (both
// synchronous throws and rejected promises are caught and logged — see
// KV-REVAMPED §4.1) while guarding against same-contract re-entrancy.
//
// Every `onUpdate` runs inside the per-contract `chelonia/queueInvocation`
// lane, which is held until the callback settles. A KV write selector
// (`update`/`clear`/`sync`) for the SAME contract invoked from inside the
// callback would enqueue behind the lane that is blocked awaiting the
// callback — a permanent deadlock. To turn that hang into a clear error,
// the write selectors reject with `ChelErrorKvReentrant` while
// `kvOnUpdateActive[contractID] > 0`.
//
// The flag is held ONLY for the callback's *synchronous* execution (up
// to its first `await`). During that window JS cannot interleave any
// other task, so a same-contract write observed then is provably a
// re-entrant call from inside `onUpdate` — never an independent caller.
// This catches the overwhelmingly common deadlock pattern
// (`onUpdate: () => sbp('chelonia/kv/update', …)` and
// `async () => { await sbp('chelonia/kv/update', …) }`, since the call
// expression is evaluated before the `await` suspends).
//
// The flag is deliberately NOT held across the callback's own awaits.
// Holding it there would falsely reject INDEPENDENT concurrent writes
// that merely interleave with a slow async `onUpdate` (they queue safely
// behind the lane and must succeed — head-of-line blocking, §4.1). The
// tradeoff is that a re-entrant write issued *after* an await inside
// `onUpdate` is not detected and still deadlocks — but that is exactly
// the pre-guard behaviour, so it is an unfixed rare edge, not a
// regression. The callback's returned promise is still awaited by the
// caller (inside the lane), preserving the documented blocking
// semantics. Keyed by `contractID` to match the lane granularity
// (cross-contract writes from `onUpdate` are never rejected).
async function safeOnUpdateGuarded(ctx, contractID, slot, value, uctx) {
    if (!slot.onUpdate)
        return;
    let ret;
    ctx.kvOnUpdateActive.set(contractID, (ctx.kvOnUpdateActive.get(contractID) ?? 0) + 1);
    try {
        // Synchronous portion of the callback. Any same-contract write
        // issued here is re-entrant and is rejected by `assertNotReentrant`.
        ret = slot.onUpdate(value, uctx);
    }
    catch (e) {
        console.error(`[chelonia/kv] onUpdate threw for ${uctx.contractID}::${uctx.key}`, e);
        return;
    }
    finally {
        // Clear the flag as soon as the synchronous portion returns (or
        // suspends at its first await), BEFORE awaiting the callback's
        // promise below — so independent concurrent writes are not rejected.
        const n = (ctx.kvOnUpdateActive.get(contractID) ?? 1) - 1;
        if (n <= 0)
            ctx.kvOnUpdateActive.delete(contractID);
        else
            ctx.kvOnUpdateActive.set(contractID, n);
    }
    if (ret && typeof ret.then === 'function') {
        try {
            await ret;
        }
        catch (e) {
            console.error(`[chelonia/kv] onUpdate threw for ${uctx.contractID}::${uctx.key}`, e);
        }
    }
}
// Reject a KV write selector that was invoked from within an `onUpdate`
// callback for the *same* contract — doing so would deadlock the
// contract's `chelonia/queueInvocation` lane (see `safeOnUpdateGuarded`).
// Only synchronous re-entrancy is detected (the flag is held just for the
// callback's synchronous portion), so the recommended way to trigger a
// same-contract write from `onUpdate` is to schedule it off the
// synchronous stack and NOT await it within the callback, e.g.
// `queueMicrotask(() => sbp('chelonia/kv/update', …))`. The scheduled
// write simply queues behind the lane and runs once it releases.
function assertNotReentrant(ctx, contractID, key, operation) {
    if ((ctx.kvOnUpdateActive.get(contractID) ?? 0) > 0) {
        throw new errors_js_1.ChelErrorKvReentrant(`[chelonia/kv] ${operation}: ${contractID}::${key} was called ` +
            'synchronously from within an onUpdate callback for the same ' +
            'contract; this would deadlock the contract lane. Schedule the ' +
            'write off the synchronous stack instead, e.g. ' +
            "queueMicrotask(() => sbp('chelonia/kv/" + operation + "', …)).");
    }
}
function slotIsCurrent(ctx, contractID, slot) {
    return ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) === slot;
}
// Defensive clone for values leaving the mirror via events / onUpdate.
// `chelonia/kv/read` already clones on the way out; event payloads and
// `onUpdate` arguments must too, so a listener mutating `event.value`
// (or a retained `previousValue`) cannot corrupt the live mirror or any
// reactive observer downstream. Primitives pass through untouched.
function cloneForEmit(v) {
    return (v === null || typeof v !== 'object') ? v : (0, turtledash_1.cloneDeep)(v);
}
// ---------------------------------------------------------------------------
// Filter-flush coalescing (KV-REVAMPED §11.5)
// ---------------------------------------------------------------------------
// One `setFilter` frame per (contract, microtask) — even if N slots
// reconcile in the same tick. The flush snapshots
// `kvActiveFilters[cID]` at flush time, so any subsequent in-tick
// mutation is naturally folded into the single emitted frame.
//
// Known minor: the snapshot is taken just before the `setFilter` await
// in `flushDirtyFilters`. If a slot is removed (match→false / release)
// while that await is in flight, the already-sent frame still carries
// the removed key, so the server may emit one superfluous broadcast for
// it. That frame is harmlessly dropped by `_handleRemote` (no active
// slot), and the removal re-dirties the contract so the next drain pass
// re-sends the corrected filter. Wasted bandwidth only — no corruption.
function queueFilterFlush(ctx, contractID) {
    const wasEmpty = ctx.kvFilterDirty.size === 0;
    ctx.kvFilterDirty.add(contractID);
    if (wasEmpty) {
        queueMicrotask(async () => {
            await flushDirtyFilters(ctx);
        });
    }
}
async function flushDirtyFilters(ctx) {
    // Re-entrancy guard. `flushDirtyFilters` awaits a `setFilter` per
    // contract; the microtask queue is open during each await. Without
    // this guard, a `queueFilterFlush` for an already-flushing contract
    // would see an empty dirty set and schedule a *second* concurrent
    // flush, so two `setFilter` frames for the same contract could race
    // and arrive out of order — leaving the server pinned to a stale
    // filter. A single draining loop instead picks up any contract
    // re-dirtied mid-flush and re-sends it with the latest
    // `kvActiveFilters` snapshot, so the last write always wins.
    if (ctx.kvFlushInFlight)
        return;
    ctx.kvFlushInFlight = true;
    try {
        while (ctx.kvFilterDirty.size > 0) {
            const cID = ctx.kvFilterDirty.values().next().value;
            ctx.kvFilterDirty.delete(cID);
            const active = ctx.kvActiveFilters.get(cID);
            try {
                await (0, sbp_1.default)('chelonia/kv/setFilter', cID, active ? [...active] : []);
            }
            catch (e) {
                console.warn(`[chelonia/kv] setFilter flush failed for ${cID}`, e);
                // Transient failure (e.g. server error while the socket stayed
                // up). Re-dirtying inline would hot-spin this drain loop, so
                // record the contract for a single backoff retry instead. The
                // correct filter is still cached in `kvActiveFilters`, so the
                // retry just re-sends it. Reconnect re-establishes filters
                // independently (see chelonia.ts), so this only covers failures
                // that leave the socket up.
                scheduleFilterRetry(ctx, cID);
            }
        }
    }
    finally {
        ctx.kvFlushInFlight = false;
    }
}
// Schedule a single deferred re-flush for contracts whose `setFilter`
// failed transiently. Deduped via the was-empty check on `kvFilterRetry`
// so concurrent failures share one timer. When it fires, the pending
// contracts move back into `kvFilterDirty` and a fresh flush runs; if
// that flush fails again it re-enters here, giving unbounded but
// rate-limited retries until the server accepts the filter or the slot
// set changes.
function scheduleFilterRetry(ctx, contractID) {
    const wasEmpty = ctx.kvFilterRetry.size === 0;
    ctx.kvFilterRetry.add(contractID);
    if (!wasEmpty)
        return;
    if (ctx.kvFilterRetryTimer != null)
        return;
    ctx.kvFilterRetryTimer = setTimeout(() => {
        ctx.kvFilterRetryTimer = undefined;
        if (ctx.kvFilterRetry.size === 0)
            return;
        for (const cID of ctx.kvFilterRetry)
            ctx.kvFilterDirty.add(cID);
        ctx.kvFilterRetry.clear();
        flushDirtyFilters(ctx).catch((e) => {
            console.error('[chelonia/kv] setFilter retry flush failed', e);
        });
    }, filterRetryMs);
}
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    ...(process.env.NODE_ENV !== 'production'
        ? {
            'chelonia/kv/_testSetNowMs': function (fn) {
                nowMs = typeof fn === 'function' ? fn : defaultNowMs;
                return { now: nowMs(), ttl: kv_constants_js_1.KV_ECHO_TTL_MS };
            },
            // Read the live echo-CID clock so test helpers that seed echo
            // entries derive their expiry from the SAME source production uses
            // (`nowMs`), staying consistent under `_testSetNowMs` overrides
            // instead of mixing in `Date.now()`.
            'chelonia/kv/_testNowMs': function () {
                return nowMs();
            },
            // Shrink (or restore) the transient-failure retry backoff so tests
            // can drive `scheduleFilterRetry` deterministically.
            'chelonia/kv/_testSetFilterRetryMs': function (ms) {
                filterRetryMs = typeof ms === 'number' ? ms : kv_constants_js_1.KV_FILTER_RETRY_MS;
                return filterRetryMs;
            },
            // Exercises the real `recordEchoCID` (including its eviction
            // policy) from tests without going through a full write.
            'chelonia/kv/_recordEchoCIDForTest': function (contractID, key, cid, fromConflict) {
                recordEchoCID(this, contractID, key, cid, fromConflict);
            }
        }
        : {}),
    // Dev-time invariant check. See KV-REVAMPED.md §11.2 ("Index
    // invariant"). Walks the five KV maps + `rootState._kv` and verifies:
    //
    //   kvSlotsByContractID[cID].has(key) ⇔
    //     (a) kvSlots has a registration for `${contractType}::${key}` whose
    //         contractType matches getContractType(rootState, cID)
    //         (rootState.contracts[cID].type with a `_vm.type` fallback), AND
    //     (b) cID ∈ subscriptionSet, AND
    //     (c) autoSubscribe slots are present in kvActiveFilters[cID], while
    //         autoSubscribe:false slots are absent from kvActiveFilters[cID].
    //
    // Throws a plain Error on the first inconsistency found — this is a
    // CI / test-suite assertion, not a user-facing error class. Intended
    // to be called from each KV test's `afterEach`. Cheap enough to run
    // unconditionally in tests; gate behind a build-time flag in
    // production if it ever ships there.
    'chelonia/kv/_assertIndexConsistent': function () {
        // Skip in production only. Runs in both 'development' and 'test'.
        if (process.env.NODE_ENV === 'production')
            return;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        // Forward direction: every entry in kvSlotsByContractID must be
        // mirrored in kvActiveFilters and kvSlots, and the contract must
        // be in subscriptionSet with a matching _vm.type.
        for (const [cID, perKey] of this.kvSlotsByContractID) {
            if (!this.subscriptionSet.has(cID)) {
                throw new Error(`[chelonia/kv] index invariant: kvSlotsByContractID has entry for ${cID} ` +
                    'but it is not in subscriptionSet');
            }
            const contractType = getContractType(rootState, cID);
            const activeFilter = this.kvActiveFilters.get(cID);
            if (!activeFilter) {
                throw new Error(`[chelonia/kv] index invariant: kvSlotsByContractID[${cID}] exists ` +
                    'but kvActiveFilters has no entry');
            }
            for (const [key, slot] of perKey) {
                if (slot.contractType !== contractType) {
                    throw new Error(`[chelonia/kv] index invariant: slot ${cID}::${key} has contractType ` +
                        `${slot.contractType} but rootState.contracts[${cID}].type is ${String(contractType)}`);
                }
                const rKey = registryKey(slot.contractType, key);
                const registered = this.kvSlots.get(rKey);
                if (!registered) {
                    throw new Error(`[chelonia/kv] index invariant: slot ${cID}::${key} is indexed but ` +
                        `not present in kvSlots under ${rKey}`);
                }
                if (registered !== slot) {
                    throw new Error(`[chelonia/kv] index invariant: slot ${cID}::${key} indexed entry does ` +
                        `not match kvSlots[${rKey}] (stale definition)`);
                }
                if (slot.autoSubscribe && !activeFilter.has(key)) {
                    throw new Error(`[chelonia/kv] index invariant: ${cID}::${key} indexed but not in ` +
                        'kvActiveFilters');
                }
                if (!slot.autoSubscribe && activeFilter.has(key)) {
                    throw new Error(`[chelonia/kv] index invariant: ${cID}::${key} is autoSubscribe:false ` +
                        'but is in kvActiveFilters');
                }
            }
        }
        // Reverse direction: every kvActiveFilters entry must be in the
        // per-contract slot index. (kvActiveFilters[cID] may legitimately
        // be an empty set during a microtask gap, but if it has any keys
        // they must be reflected in the slot index.)
        for (const [cID, activeFilter] of this.kvActiveFilters) {
            const perKey = this.kvSlotsByContractID.get(cID);
            if (activeFilter.size === 0)
                continue;
            if (!perKey) {
                throw new Error(`[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${activeFilter.size} ` +
                    'entries but kvSlotsByContractID has no entry');
            }
            for (const key of activeFilter) {
                if (!perKey.has(key)) {
                    throw new Error(`[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${key} but ` +
                        'kvSlotsByContractID lacks it');
                }
            }
        }
        // kvFilterDirty entries that have no corresponding kvActiveFilters or
        // kvSlotsByContractID entry are legitimate: _cleanupContractRuntime
        // queues a microtask flush and then deletes the runtime state, leaving
        // the dirty mark until the microtask fires. Skip these pending-empty-
        // flush entries. For entries that *do* have runtime state, verify the
        // keys match kvSlotsByContractID.
        for (const cID of this.kvFilterDirty) {
            const hasRuntimeState = this.kvActiveFilters.has(cID) || this.kvSlotsByContractID.has(cID);
            if (hasRuntimeState) {
                const activeFilter = this.kvActiveFilters.get(cID);
                const perKey = this.kvSlotsByContractID.get(cID);
                if (activeFilter && perKey) {
                    for (const key of activeFilter) {
                        if (!perKey.has(key)) {
                            throw new Error(`[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${key} but ` +
                                'kvSlotsByContractID lacks it');
                        }
                    }
                }
            }
        }
        // rootState._kv mirror entries must correspond to active slots. Every
        // key in rootState._kv[cID] should have a matching entry in
        // kvSlotsByContractID[cID]. Stale mirror entries after release or
        // match→false are a leak. Contracts not in subscriptionSet are
        // exempt — they may have persisted mirror entries from a previous
        // session that were re-validated by `defineSlot` but haven't been
        // synced yet (§4.1 "every persisted entry" re-validation path).
        const kvMirror = rootState._kv;
        if (kvMirror) {
            for (const cID of Object.keys(kvMirror)) {
                if (!this.subscriptionSet.has(cID))
                    continue;
                const perContract = kvMirror[cID];
                if (!perContract)
                    continue;
                const activeSlots = this.kvSlotsByContractID.get(cID);
                for (const key of Object.keys(perContract)) {
                    if (!activeSlots?.has(key)) {
                        throw new Error(`[chelonia/kv] index invariant: rootState._kv[${cID}] has key ` +
                            `${key} but no active slot in kvSlotsByContractID`);
                    }
                }
            }
        }
    },
    // Public API. See KV-REVAMPED.md §4.1. Idempotent per
    // `(contractType, key)` — last call wins, with re-validation of any
    // persisted mirror values against the new schema.
    //
    // This is a thin wrapper around the internal
    // `chelonia/kv/_defineSlotInternal` selector — it always tags the
    // resulting slot with `_source: { kind: 'defineSlot' }`. The internal
    // selector is what `chelonia/kv/_registerContractSlots` uses to tag
    // manifest-scoped slots; userland callers can never spoof a
    // `kind: 'defineContract'` source through this selector because the
    // public `KvSlotDefinition` type has no `_source` field.
    'chelonia/kv/defineSlot': function (def) {
        (0, sbp_1.default)('chelonia/kv/_defineSlotInternal', def, { kind: 'defineSlot' });
    },
    // Private. The actual `defineSlot` implementation. Accepts an
    // explicit `source` so `_registerContractSlots` can mark slots as
    // manifest-owned for `_cleanupContractSlots` to scope removals
    // correctly. Not re-exported; not callable from userland through
    // typed APIs.
    'chelonia/kv/_defineSlotInternal': function (def, source) {
        if (!def || typeof def !== 'object') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid definition');
        }
        if (typeof def.key !== 'string' || def.key.length === 0) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid key');
        }
        const types = Array.from(new Set(Array.isArray(def.contractType) ? def.contractType : [def.contractType]));
        if (types.length === 0) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: contractType required');
        }
        // Runtime validation of optional fields (SBP selectors are callable
        // from JavaScript without TypeScript enforcement).
        if (def.match != null && typeof def.match !== 'function') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: match must be a function');
        }
        if (def.schema != null && (typeof def.schema.parse !== 'function')) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: schema must have a parse method');
        }
        if (def.defaultUpdater != null && typeof def.defaultUpdater !== 'function') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultUpdater must be a function');
        }
        if (def.onUpdate != null && typeof def.onUpdate !== 'function') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: onUpdate must be a function');
        }
        if (def.autoLoad != null &&
            def.autoLoad !== kv_constants_js_1.KV_AUTO_LOAD.ON_SYNC &&
            def.autoLoad !== kv_constants_js_1.KV_AUTO_LOAD.ON_DEMAND &&
            def.autoLoad !== kv_constants_js_1.KV_AUTO_LOAD.NEVER) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: autoLoad must be one of "on-sync", "on-demand", "never"');
        }
        if (def.encryptionKeyName != null && typeof def.encryptionKeyName !== 'string') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: encryptionKeyName must be a string');
        }
        if (def.signingKeyName != null && typeof def.signingKeyName !== 'string') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: signingKeyName must be a string');
        }
        if (def.autoSubscribe != null && typeof def.autoSubscribe !== 'boolean') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: autoSubscribe must be a boolean');
        }
        if (def.refreshOnReconnect != null && typeof def.refreshOnReconnect !== 'boolean') {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: refreshOnReconnect must be a boolean');
        }
        for (const contractType of types) {
            if (typeof contractType !== 'string' || contractType.length === 0) {
                throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid contractType');
            }
        }
        // Resolve the default value once before the loop — factories must run
        // exactly once regardless of how many contract types are listed
        // (KV-REVAMPED §4.1).
        const dv = def.defaultValue;
        let rawDefault;
        try {
            rawDefault = typeof dv === 'function' ? dv() : dv;
        }
        catch (e) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultValue factory threw', { cause: e });
        }
        if (rawDefault === null) {
            throw new errors_js_1.ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultValue may not be null; ' +
                'null is the reserved wire clear sentinel');
        }
        if (rawDefault !== undefined) {
            try {
                assertJsonShape(rawDefault, `defineSlot defaultValue ${def.key}`);
            }
            catch (e) {
                throw new errors_js_1.ChelErrorKvSlotInvalid(`[chelonia/kv] defineSlot: defaultValue for key '${def.key}' is not JSON-shaped`, { cause: e });
            }
        }
        const resolvedDefault = rawDefault === undefined ? undefined : (0, turtledash_1.cloneDeep)(rawDefault);
        for (const contractType of types) {
            const perTypeDefault = resolvedDefault === undefined ? undefined : (0, turtledash_1.cloneDeep)(resolvedDefault);
            const slot = resolveSlotDefinition(def, contractType, perTypeDefault, source);
            assertSchemaGuards(slot);
            const rKey = registryKey(contractType, def.key);
            const previous = this.kvSlots.get(rKey);
            this.kvSlots.set(rKey, slot);
            // Walk every synced contract whose type matches and reconcile.
            // This both wires up newly-eligible contracts and re-validates
            // persisted mirror entries on first activation and slot replacement.
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            for (const cID of this.subscriptionSet) {
                const meta = rootState.contracts?.[cID];
                if (!meta || getContractType(rootState, cID) !== contractType)
                    continue;
                // If a previous definition existed and the contract was
                // already in the index under it, the index entry has to be
                // refreshed to point at the new slot object before
                // `_reconcileForSlot` runs (the invariant check otherwise
                // trips on `registered !== slot`). `wasPointed` records that the
                // slot was *already active* for this contract: in that case
                // `_reconcileForSlot` sees `wasActive` and deliberately skips its
                // own autoload, so the replacement load is ours to schedule.
                let wasPointed = false;
                if (previous) {
                    const perKey = this.kvSlotsByContractID.get(cID);
                    if (perKey && perKey.get(def.key) === previous) {
                        perKey.set(def.key, slot);
                        wasPointed = true;
                    }
                }
                (0, sbp_1.default)('chelonia/kv/_reconcileForSlot', slot, cID);
                // Re-validate any persisted mirror entry *after* reconcile so
                // the index invariant holds; gate on the slot still being
                // registered (reconcile may have removed it if the contract was
                // released or the match filter changed). Surface failures via
                // status/event but keep the old value (§4.1).
                if (this.kvSlotsByContractID.get(cID)?.get(def.key) === slot) {
                    // A replacement of an `on-sync` slot whose first load is still
                    // in flight has an unresolved mirror entry: reconcile saw the
                    // key already present (`wasActive`) and skipped its autoload,
                    // the superseded load discards its GET at the staleness guard,
                    // and `revalidateMirrorEntry` no-ops on the `undefined` value.
                    // Nobody would ever fetch the value. Schedule a queued load so
                    // it serialises behind any in-flight write and the replacement
                    // slot resolves. Gated on `wasPointed` so we never double-load
                    // a slot that reconcile just activated (and already scheduled
                    // a load for); first-time activation keeps reconcile's path.
                    //
                    // The same queued-load path is taken when a write is in flight
                    // for this contract (`kvPendingWrites`): the in-flight
                    // `update`/`clear` will commit a value the current mirror does
                    // not yet reflect AND its staleness guard will skip the mirror
                    // write because the slot was replaced. Re-validating the stale
                    // mirror here would re-seed it from the pre-write value and
                    // diverge from the server (#1). A queued `_loadSlot` instead
                    // serialises behind the in-flight write and fetches the
                    // committed value, so the replacement slot converges on truth.
                    //
                    // A load already pending for this contract (`kvPendingLoads`)
                    // forces the same path even when the mirror currently reads
                    // `loaded`. Such a load can be (a) a sync / reconnect / autoload
                    // fetch queued behind busy lane work but not yet started — its
                    // status is still `loaded`, so `unloaded` misses it — or (b) the
                    // authoritative GET `_handleRemote` runs for a conflict / no-cid
                    // frame. In both cases the in-flight load will discard its GET at
                    // its own staleness guard once it sees the replacement (#1/#3),
                    // so revalidating the soon-to-be-stale value would strand the
                    // mirror at the old value with a `loaded` status. Scheduling a
                    // fresh load for the replacement re-fetches the server value.
                    const e = rootState._kv?.[cID]?.[def.key];
                    const unloaded = !e || e.value === undefined ||
                        e.status === kv_constants_js_1.KV_LOAD_STATUS.NON_INIT ||
                        e.status === kv_constants_js_1.KV_LOAD_STATUS.LOADING;
                    const hasPendingWrite = (this.kvPendingWrites.get(cID) ?? 0) > 0;
                    const hasPendingLoad = (this.kvPendingLoads.get(cID) ?? 0) > 0;
                    if ((unloaded || hasPendingWrite || hasPendingLoad) && wasPointed &&
                        slot.autoLoad === kv_constants_js_1.KV_AUTO_LOAD.ON_SYNC) {
                        (0, sbp_1.default)('chelonia/kv/_loadSlot', {
                            contractID: cID, slot, reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD
                        }).catch((err) => {
                            console.error(`[chelonia/kv] _loadSlot rejected for ${cID}::${def.key}`, err);
                        });
                    }
                    else {
                        revalidateMirrorEntry(this, rootState, cID, slot);
                    }
                }
            }
            // Also re-validate persisted mirror entries for contracts not
            // currently in subscriptionSet (e.g. not yet re-synced after a
            // reload). §4.1 requires re-validating every persisted entry whose
            // contract type can be resolved, not just currently-synced
            // contracts. Skip entries whose contract type cannot be confirmed
            // to match — re-validating against the wrong slot type would
            // spuriously flip foreign entries to 'error'. Released contracts
            // are validated by `_loadSlotNow` the next time they sync.
            if (rootState._kv) {
                for (const cID of Object.keys(rootState._kv)) {
                    if (this.subscriptionSet.has(cID))
                        continue;
                    const cType = getContractType(rootState, cID);
                    if (cType !== contractType)
                        continue;
                    revalidateMirrorEntry(this, rootState, cID, slot);
                }
            }
        }
    },
    // Private. Reconciles a single (slot, contractID) pair: evaluates
    // `match`, maintains the index invariant (§11.2), updates the active
    // filter set, and schedules an `autoLoad: 'on-sync'` fetch. This is
    // the per-contract inner step of KV-REVAMPED §11.3 step 2 — callers
    // iterate synced contracts and invoke this for each relevant pair.
    'chelonia/kv/_reconcileForSlot': function (slot, contractID) {
        if (!this.subscriptionSet.has(contractID))
            return;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const meta = rootState.contracts?.[contractID];
        if (!meta || getContractType(rootState, contractID) !== slot.contractType)
            return;
        const contractState = rootState[contractID] ?? {};
        let matches;
        try {
            matches = slot.match ? !!slot.match(contractID, contractState, rootState) : true;
        }
        catch (e) {
            // A throwing `match` predicate is treated as "does not match"
            // — the slot simply stays inactive for this contract. We log
            // so a buggy predicate is at least visible during development.
            console.error(`[chelonia/kv] match() threw for ${contractID}::${slot.key}`, e);
            matches = false;
        }
        const perKey = this.kvSlotsByContractID.get(contractID);
        const wasActive = !!perKey?.has(slot.key);
        if (matches) {
            // Index in (idempotent).
            let bucket = perKey;
            if (!bucket) {
                bucket = new Map();
                this.kvSlotsByContractID.set(contractID, bucket);
            }
            bucket.set(slot.key, slot);
            let filter = this.kvActiveFilters.get(contractID);
            const createdFilterBucket = !filter;
            if (!filter) {
                filter = new Set();
                this.kvActiveFilters.set(contractID, filter);
            }
            if (slot.autoSubscribe && !filter.has(slot.key)) {
                filter.add(slot.key);
                queueFilterFlush(this, contractID);
            }
            else if (!slot.autoSubscribe) {
                if (filter.has(slot.key)) {
                    filter.delete(slot.key);
                    queueFilterFlush(this, contractID);
                }
                else if (createdFilterBucket) {
                    // Claim filter ownership for this contract even when the first
                    // attached slot is local-only; test 52 locks in the empty flush.
                    queueFilterFlush(this, contractID);
                }
            }
            // Seed the mirror entry as 'non-init' if absent so consumers
            // can observe the slot before the first load resolves.
            const perContract = ensureContractKv(this, rootState, contractID);
            if (!perContract[slot.key]) {
                this.config.reactiveSet(perContract, slot.key, {
                    value: undefined,
                    etag: null,
                    status: kv_constants_js_1.KV_LOAD_STATUS.NON_INIT
                });
            }
            // Schedule a load. The actual fetch is serialised against
            // updates via the per-contract queueInvocation lane.
            if (!wasActive && slot.autoLoad === kv_constants_js_1.KV_AUTO_LOAD.ON_SYNC) {
                // Fire-and-forget — `_loadSlot` manages its own status events and
                // may reject on GET or validation failure; the `.catch` here
                // keeps that rejection out of the reconcile dispatch path.
                (0, sbp_1.default)('chelonia/kv/_loadSlot', { contractID, slot, reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD })
                    .catch((e) => {
                    console.error(`[chelonia/kv] _loadSlot rejected for ${contractID}::${slot.key}`, e);
                });
            }
        }
        else {
            // match returned false — tear down if active, and clean up any
            // stale persisted mirror entry regardless of prior active state.
            if (wasActive) {
                perKey.delete(slot.key);
                const contractEmptied = perKey.size === 0;
                if (contractEmptied)
                    this.kvSlotsByContractID.delete(contractID);
                const filter = this.kvActiveFilters.get(contractID);
                if (filter?.has(slot.key)) {
                    filter.delete(slot.key);
                    queueFilterFlush(this, contractID);
                }
                if (contractEmptied)
                    this.kvActiveFilters.delete(contractID);
            }
            const perContract = rootState._kv?.[contractID];
            if (perContract && perContract[slot.key]) {
                this.config.reactiveDel(perContract, slot.key);
            }
            // Drop the per-contract record once its last key is gone so an
            // emptied {} doesn't linger in persisted state until contract
            // release. ensureContractKv re-creates it on demand, and the
            // load/remote paths re-acquire live entries and bail when absent.
            if (perContract && rootState._kv && Object.keys(perContract).length === 0) {
                this.config.reactiveDel(rootState._kv, contractID);
            }
            this.kvLocalEchoCIDs.delete(`${contractID}${kv_constants_js_1.KV_KEY_SEPARATOR}${slot.key}`);
        }
    },
    // Private queued wrapper. See KV-REVAMPED §11.3 step 3. Routes
    // `_loadSlotNow` through `chelonia/queueInvocation` keyed on
    // `contractID` so explicit loads serialize against in-flight
    // `chelonia/kv/update` writes.
    'chelonia/kv/_loadSlot': function ({ contractID, slot, reason }) {
        // Count the load as pending the moment it is *scheduled*, not when
        // its lane callback starts: a load queued behind busy lane work has
        // not yet flipped the slot to 'loading', so `defineSlot`'s gate
        // would otherwise miss it and revalidate a value this load is about
        // to discard at its staleness guard (#1). Balanced in `finally`,
        // including the synchronous-undefined return from a stubbed/!
        // re-entrant `queueInvocation` (mirrors `update`'s counter handling).
        incrementPendingLoad(this, contractID);
        let queued;
        try {
            queued = (0, sbp_1.default)('chelonia/queueInvocation', contractID, () => (0, sbp_1.default)('chelonia/kv/_loadSlotNow', { contractID, slot, reason }));
        }
        catch (e) {
            decrementPendingLoad(this, contractID);
            throw e;
        }
        return Promise.resolve(queued).finally(() => {
            decrementPendingLoad(this, contractID);
        });
    },
    // Private unqueued implementation. Fetches via `chelonia/kv/get`,
    // validates, and writes the mirror. Callers must already hold the per-contract lane
    // or intentionally run outside it.
    'chelonia/kv/_loadSlotNow': function ({ contractID, slot, reason, suppressLoadingStatus = false, preserveStatusOnError = false, silent = false }) {
        incrementPendingLoad(this, contractID);
        return (async () => {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            // The contract may have been released between scheduling and
            // running — bail out cleanly.
            if (!this.subscriptionSet.has(contractID))
                return;
            // Non-destructive existence check FIRST: reconcile may have dropped
            // the mirror entry (and the now-empty `_kv[contractID]` record) while
            // we were queued behind other lane work. Calling `ensureContractKv`
            // here would re-create an orphaned empty `{}` record that lingers in
            // persisted state until contract release. The subscription guard
            // above doesn't cover this — the contract is still subscribed, only
            // the slot entry was removed. Matches the non-destructive read
            // pattern `setSlotStatus` uses (see line 384).
            if (!rootState._kv?.[contractID]?.[slot.key]) {
                return;
            }
            const perContract = ensureContractKv(this, rootState, contractID);
            if (!perContract[slot.key]) {
                // Reconcile dropped the entry while we were queued.
                return;
            }
            const priorStatus = perContract[slot.key]?.status;
            // `silent` (update's data-loss-guard reload) must hide ALL of this
            // reload's status transitions from the `update` caller: the guard
            // reload runs from an `'error'` baseline, so `suppressLoadingStatus`
            // (which only skips `'loading'` from a `'loaded'` baseline) does not
            // cover it, and the consumer would otherwise observe a spurious
            // `error → loading → … → loaded` flicker from a single `update` call
            // (#2). `setStatus` is therefore a no-op under `silent` — the mirror
            // value/etag still refresh (the reload's whole point), but the
            // observable status stays at its pre-reload value so the enclosing
            // `update` can emit the single authoritative `error → loaded`
            // transition itself after the write commits. `update` derives its
            // seed precedence from whether the reload ran/failed, not from the
            // (now-frozen) status field. Non-silent loads transition normally.
            // NOTE: under `silent`, status transitions AND `lastError` updates
            // are intentionally swallowed (the no-op stub below discards both
            // args). The slot was already in `'error'` (that's what triggered
            // the reload), and the enclosing `update` will overwrite both on
            // write success or stamp a fresh error on write failure. A failed
            // silent reload therefore leaves the prior `lastError` in place —
            // acceptable because the write's own outcome reconciles it.
            const setStatus = silent
                ? () => { }
                : (status, lastError) => setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, status, lastError);
            // Staleness teardown shared by all three guards below. Re-reads
            // the LIVE mirror (`rootState._kv`) rather than the `perContract`
            // captured above: `chelonia/kv/_cleanupContractRuntime` can run
            // (outside this lane) during the GET await and `reactiveDel` the
            // whole `_kv[contractID]` record. The captured `perContract` then
            // points at a detached object whose entry still reads
            // `'loading'`, so trusting it would call `setSlotStatus` →
            // `ensureContractKv` and silently re-create the deleted record
            // (orphan leak in prod, throw in dev, `_assertIndexConsistent`
            // trip). Re-reading live means a released contract yields no
            // entry and we return without resurrecting it; a *replaced* slot
            // yields the replacement's entry, which we only touch while it is
            // still `'loading'` so we never clobber a `'loaded'`/`'error'`
            // status the replacement already set (e.g. via
            // `revalidateMirrorEntry`).
            const restorePriorStatusIfStale = () => {
                const liveEntry = rootState._kv?.[contractID]?.[slot.key];
                if (!liveEntry)
                    return;
                if (liveEntry.status === kv_constants_js_1.KV_LOAD_STATUS.LOADING && priorStatus != null) {
                    setStatus(priorStatus);
                }
            };
            const slotReplacedOrReleased = () => this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot;
            // Shared handling for a decode / schema / JSON-shape failure on an
            // otherwise-successful GET. Emits the validation event, then either
            // restores the prior status (conflict-resolution path) or stamps
            // `'error'`, and re-throws a wrapped `ChelErrorKvValidation`.
            // Honoring `preserveStatusOnError` here — not just on the GET-throw
            // path above — is essential: a conflict-resolved write already
            // committed a valid value to the mirror, so a malformed-but-200
            // authoritative GET must NOT flip the slot to `'error'` (which would
            // make `chelonia/kv/read` return the default and silently hide the
            // retained value). See the flag's definition above and §4.9.
            //
            // Event-vs-status contract: `CHELONIA_KV_VALIDATION_ERROR` is ALWAYS
            // emitted from this path, including when `preserveStatusOnError`
            // suppresses the `'error'` status transition. The event is diagnostic
            // ("the server returned something invalid") while `status` reflects
            // the mirror's actual usability. Consumers that need a "slot is in
            // trouble" signal MUST watch `CHELONIA_KV_STATUS_CHANGED` reaching a
            // terminal status, not infer health from the presence or absence of a
            // `CHELONIA_KV_VALIDATION_ERROR` event.
            const failLoadValidation = (e, wrappedMessage) => {
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_VALIDATION_ERROR, {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    error: e,
                    reason
                });
                if (preserveStatusOnError) {
                    restorePriorStatusIfStale();
                }
                else {
                    setStatus(kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
                }
                throw new errors_js_1.ChelErrorKvValidation(wrappedMessage, { cause: e });
            };
            if (!(suppressLoadingStatus && priorStatus === kv_constants_js_1.KV_LOAD_STATUS.LOADED)) {
                setStatus(kv_constants_js_1.KV_LOAD_STATUS.LOADING);
            }
            let parsed;
            try {
                parsed = await (0, sbp_1.default)('chelonia/kv/get', contractID, slot.key);
            }
            catch (e) {
                // Staleness guard (symmetric with the success paths below): if
                // `defineSlot` replaced this slot, or the contract was released,
                // while the GET was in flight, bail out before stamping an error
                // onto the (replacement or already-torn-down) mirror entry.
                if (slotReplacedOrReleased()) {
                    restorePriorStatusIfStale();
                    return;
                }
                if (preserveStatusOnError) {
                    // Conflict-resolution path: the committed value still lives in
                    // the mirror. Restore the prior status (a no-op when
                    // `suppressLoadingStatus` kept it at `'loaded'`) instead of
                    // stamping `'error'`, then re-throw so the caller can log and
                    // demote its conflict markers.
                    restorePriorStatusIfStale();
                    throw e;
                }
                const lastError = normalizeError(e);
                setStatus(kv_constants_js_1.KV_LOAD_STATUS.ERROR, lastError);
                throw e;
            }
            if (parsed === null) {
                // Staleness guard (symmetric with the non-null path below):
                // if `defineSlot` replaced this slot, or the contract was
                // released, while the GET was in flight, bail out before
                // mutating the mirror.
                if (slotReplacedOrReleased()) {
                    restorePriorStatusIfStale();
                    return;
                }
                // 404 — key not yet written (or deleted server-side). Reset
                // the mirror to the declared default state (`value: undefined`,
                // `etag: null`) and surface `'non-init'` rather than `'loaded'`
                // (§4.3). If the slot previously held a value, emit
                // `CHELONIA_KV_UPDATED` so consumers observe the transition.
                // The event payload carries `undefined`, matching the mirror;
                // `onUpdate` receives the resolved default so callbacks observe
                // the same value `read` will subsequently return.
                // Re-acquire the LIVE mirror entry (not the pre-await
                // `perContract` capture): if the contract was released and
                // re-synced during the GET await, `perContract` points at a
                // detached, dropped record. The slot-identity guard above does
                // not catch release+re-sync because the surviving slot object is
                // re-indexed unchanged. Writing the detached object would be lost
                // from the live mirror.
                const existingEntry = rootState._kv?.[contractID]?.[slot.key];
                let previousValue;
                if (existingEntry) {
                    previousValue = existingEntry.value;
                    this.config.reactiveSet(existingEntry, 'value', undefined);
                    this.config.reactiveSet(existingEntry, 'etag', null);
                    if (!silent && previousValue !== undefined) {
                        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                            contractID,
                            contractType: slot.contractType,
                            key: slot.key,
                            value: undefined,
                            previousValue: cloneForEmit(previousValue),
                            reason,
                            etag: null
                        });
                    }
                }
                // Transition to 'non-init' before onUpdate (matching the
                // success-path sequencing of setSlotStatus → safeOnUpdateGuarded).
                setStatus(kv_constants_js_1.KV_LOAD_STATUS.NON_INIT);
                if (!silent && existingEntry && previousValue !== undefined &&
                    slotIsCurrent(this, contractID, slot)) {
                    const defaultedValue = slot.resolvedDefault !== undefined
                        ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                        : undefined;
                    await safeOnUpdateGuarded(this, contractID, slot, defaultedValue, {
                        contractID,
                        contractType: slot.contractType,
                        key: slot.key,
                        reason,
                        etag: null,
                        previousValue: cloneForEmit(previousValue)
                    });
                }
                return;
            }
            // Capture the etag from the GET response before any await point.
            const getEtag = parsed.etag ?? null;
            // Staleness guard: if `defineSlot` replaced this slot, or the
            // contract was released, while the fetch was in flight, the
            // captured `slot` object is stale — its schema / defaults /
            // callbacks no longer match the registry. Restore the prior
            // status so the slot doesn't remain stuck at 'loading' (the
            // replacement slot will manage its own lifecycle). This runs
            // *before* decoding `parsed.data` so a replaced slot never pays
            // the decrypt/verify cost or stamps decode-failure side effects
            // onto the replacement's mirror entry. The decode/validation
            // branches below re-throw by design but run synchronously after
            // this guard with no intervening await, so a released contract
            // has already bailed here and they never stamp a torn-down entry.
            if (slotReplacedOrReleased()) {
                restorePriorStatusIfStale();
                return;
            }
            // `parsed.data` is a lazy accessor that can throw on decrypt/signature
            // failure, so downgrade that failure through the same status path as
            // schema validation.
            let unwrapped;
            try {
                unwrapped = parsed.data;
            }
            catch (e) {
                throw failLoadValidation(e, `[chelonia/kv] load: ${contractID}::${slot.key} decode failed`);
            }
            // Re-acquire the LIVE mirror entry (not the pre-await
            // `perContract` capture). If the contract was released and
            // re-synced during the GET await, `_cleanupContractRuntime`
            // dropped the original `_kv[contractID]` record and reconcile
            // seeded a fresh one; the slot-identity guard above passes
            // because the surviving slot object is re-indexed unchanged.
            // Writing the captured `perContract` entry would land on the
            // detached, dropped object — lost from the live mirror — while
            // `setSlotStatus` (which re-reads live) would stamp the fresh
            // entry 'loaded' with no value. Bail if no live entry exists
            // (released without re-sync, or reconcile dropped it).
            const entry = rootState._kv?.[contractID]?.[slot.key];
            if (!entry)
                return;
            const previousValue = entry?.value;
            // Wire `null` is the clear sentinel — skip schema.parse and
            // restore the deep-cloned default.
            const wasClear = unwrapped === null;
            let nextValue;
            if (wasClear) {
                nextValue = slot.resolvedDefault !== undefined
                    ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                    : undefined;
            }
            else if (slot.schema) {
                try {
                    nextValue = parseSyncSlotValue(slot, unwrapped, `load ${contractID}::${slot.key}`);
                }
                catch (e) {
                    throw failLoadValidation(e, `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`);
                }
            }
            else {
                try {
                    nextValue = assertJsonShape(unwrapped, `load ${contractID}::${slot.key}`);
                }
                catch (e) {
                    throw failLoadValidation(e, `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`);
                }
            }
            // Write mirror — entry definitely exists (we seeded it
            // upstream and bail out if reconcile dropped it). For a wire-null
            // clear the canonical 'non-init' mirror `value` is `undefined`
            // (§4.3/§4.5), matching local `clear` and the 404 branch; the
            // resolved default is still surfaced through `onUpdate` below.
            const mirrorValue = wasClear ? undefined : nextValue;
            this.config.reactiveSet(entry, 'value', mirrorValue);
            this.config.reactiveSet(entry, 'etag', getEtag);
            // Emit order: `CHELONIA_KV_UPDATED` fires BEFORE `setSlotStatus`
            // below. Since `okTurtles.events/emit` is synchronous, a handler
            // reading `chelonia/kv/status` here sees the pre-transition status
            // (e.g. still `'loading'`). Consumers needing a settled status
            // must watch `CHELONIA_KV_STATUS_CHANGED` (see AGENTS.md).
            //
            // `silent` (update's data-loss-guard reload): skip the emit + onUpdate
            // so a single `chelonia/kv/update` call doesn't produce both a 'load'
            // and a 'local' event. The mirror value/etag/status still update
            // (above + below) because seed-precedence relies on the fresh state.
            if (!silent) {
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    value: cloneForEmit(mirrorValue),
                    previousValue: cloneForEmit(previousValue),
                    reason,
                    etag: getEtag
                });
            }
            setStatus(wasClear ? kv_constants_js_1.KV_LOAD_STATUS.NON_INIT : kv_constants_js_1.KV_LOAD_STATUS.LOADED);
            if (!silent && slotIsCurrent(this, contractID, slot)) {
                await safeOnUpdateGuarded(this, contractID, slot, cloneForEmit(nextValue), {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    reason,
                    etag: getEtag,
                    previousValue: cloneForEmit(previousValue)
                });
            }
        })().finally(() => {
            decrementPendingLoad(this, contractID);
        });
    },
    // Private listener for CONTRACTS_MODIFIED. Mounted from
    // `chelonia/connect` (see chelonia.ts) so that newly-synced
    // contracts automatically wire up every matching slot, and
    // removed contracts have their per-contract KV runtime state
    // cleaned up (KV-REVAMPED §11.4). Removal cleanup is also called
    // directly from `chelonia/private/removeImmediately`; both paths are
    // intentionally idempotent.
    'chelonia/kv/_onContractsModified': function ({ added, removed }) {
        if (added && added.length > 0) {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            for (const cID of added) {
                const meta = rootState.contracts?.[cID];
                if (!meta)
                    continue;
                const contractType = getContractType(rootState, cID);
                if (!contractType)
                    continue;
                for (const slot of this.kvSlots.values()) {
                    if (slot.contractType !== contractType)
                        continue;
                    (0, sbp_1.default)('chelonia/kv/_reconcileForSlot', slot, cID);
                }
            }
        }
        if (removed && removed.length > 0) {
            for (const cID of removed) {
                // Also invoked directly from `chelonia/private/removeImmediately`
                // as an idempotent fast path; calling twice is safe.
                (0, sbp_1.default)('chelonia/kv/_cleanupContractRuntime', cID);
            }
        }
    },
    // Private. See KV-REVAMPED §11.4 (contract-release / unsubscribe path).
    // Called from both `chelonia/private/removeImmediately` and the
    // `CONTRACTS_MODIFIED` listener; all operations below are idempotent.
    // Clears per-contract KV runtime state for `contractID`: removes
    // `rootState._kv[contractID]`, `kvSlotsByContractID[contractID]`,
    // `kvActiveFilters[contractID]`, and schedules an empty-filter
    // `setFilter` flush. The `kvFilterDirty` mark is intentionally
    // retained until the microtask fires so the flush sees this
    // contract in the dirty set. Keeps long-lived sessions from
    // accumulating stale mirror entries after refcount goes to zero. This
    // selector may run outside any per-contract queue lane, so it must
    // remain synchronous and idempotent.
    'chelonia/kv/_cleanupContractRuntime': function (contractID) {
        const hadFilter = this.kvActiveFilters.has(contractID);
        // Queue a filter flush for this contract *before* dropping state so
        // the server receives the empty-filter frame (§11.5 empty
        // transitions). The flush reads kvActiveFilters at microtask time;
        // deleting the entry below is what makes the emitted filter empty.
        // We intentionally do NOT delete from kvFilterDirty here — the
        // microtask must see this contract in the dirty set to send the
        // empty-filter frame.
        if (hadFilter)
            queueFilterFlush(this, contractID);
        this.kvSlotsByContractID.delete(contractID);
        this.kvActiveFilters.delete(contractID);
        this.kvReconnectRefresh.delete(contractID);
        const prefix = `${contractID}${kv_constants_js_1.KV_KEY_SEPARATOR}`;
        this.kvLocalEchoCIDs.forEach((_cids, key) => {
            if (key.startsWith(prefix)) {
                this.kvLocalEchoCIDs.delete(key);
            }
        });
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (rootState._kv && rootState._kv[contractID]) {
            this.config.reactiveDel(rootState._kv, contractID);
        }
    },
    'chelonia/kv/_flushDirtyFilters': function () {
        return flushDirtyFilters(this);
    },
    // Private. Drain (not cancel) in-flight `chelonia/kv/update` /
    // `chelonia/kv/clear` writes before `chelonia/reset` tears down state.
    // KV writes run inside the per-contract `chelonia/queueInvocation`
    // lane, so enqueuing a noop behind them resolves only once they
    // settle — symmetric with `chelonia/contract/wait`. The contract set
    // is the union of three sources:
    //   1. contracts with an active slot index
    //      (`kvSlotsByContractID`),
    //   2. contracts that still own an echo-suppression CID
    //      (`kvLocalEchoCIDs` — an in-flight write whose slot index was
    //      already cleaned up but whose body has progressed far enough to
    //      record a CID), and
    //   3. contracts with a non-zero pending-write count
    //      (`kvPendingWrites` — a write whose body is still queued behind
    //      a prior operation and has not yet recorded a CID; the slot
    //      index and CID sources miss this window).
    // `chelonia/reset` awaits this before clearing the KV runtime maps so
    // continuations never run against a torn-down mirror or a swapped-out
    // `kvLocalEchoCIDs`. `_loadSlot` syncs are drained through source #1;
    // if the contract is released before a queued load runs, `_loadSlot`'s
    // subscription guard bails out before mutating state.
    'chelonia/kv/_waitInFlight': function () {
        const ids = new Set(this.kvSlotsByContractID.keys());
        this.kvLocalEchoCIDs.forEach((_cids, echoKey) => {
            const idx = echoKey.indexOf(kv_constants_js_1.KV_KEY_SEPARATOR);
            if (idx > 0)
                ids.add(echoKey.slice(0, idx));
        });
        this.kvPendingWrites.forEach((_n, cID) => ids.add(cID));
        return Promise.all(Array.from(ids).map((cID) => (0, sbp_1.default)('chelonia/queueInvocation', cID, ['chelonia/private/noop'])));
    },
    // Private. See KV-REVAMPED §11.4 bullet 3 (reconnect hook).
    // Called from the pubsub reconnect-open path. Clears pending local
    // echo CIDs immediately; slot reloads with `refreshOnReconnect === true`
    // are marked here and run after the per-subscription forced resync.
    'chelonia/kv/_onReconnect': function () {
        this.kvLocalEchoCIDs.clear();
        for (const [cID, perKey] of this.kvSlotsByContractID) {
            for (const [, slot] of perKey) {
                if (slot.refreshOnReconnect) {
                    this.kvReconnectRefresh.add(cID);
                    break;
                }
            }
        }
    },
    'chelonia/kv/_onContractResynced': function (contractID) {
        if (!this.kvReconnectRefresh.has(contractID))
            return;
        this.kvReconnectRefresh.delete(contractID);
        if (!this.subscriptionSet.has(contractID))
            return;
        const perKey = this.kvSlotsByContractID.get(contractID);
        if (!perKey)
            return;
        for (const [, slot] of perKey) {
            if (slot.refreshOnReconnect) {
                (0, sbp_1.default)('chelonia/kv/_loadSlot', {
                    contractID,
                    slot,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.RECONNECT
                })
                    .catch((e) => {
                    console.error(`[chelonia/kv] _loadSlot (reconnect) rejected for ${contractID}::${slot.key}`, e);
                });
            }
        }
    },
    // Private. See KV-REVAMPED §4.9, §11.3 step 4, §11.4 bullet 1.
    // Called from the existing NOTIFICATION_TYPE.KV dispatch in
    // `src/chelonia.ts` after `parseEncryptedOrUnencryptedMessage`
    // has resolved the wrapper. Runs inside the per-contract
    // `chelonia/queueInvocation` lane (set up by the caller) so it
    // serialises against `chelonia/kv/update` writes and other KV
    // operations on the same contract.
    //
    // Behaviour:
    //   - O(1) slot lookup via `kvSlotsByContractID[cID][key]`. Returns
    //     immediately on miss — `defineSlot` may not have registered yet
    //     and the raw KV API still runs through the existing
    //     callback path. No regression.
    //   - Read the frame CID; if it matches a non-expired entry in
    //     `kvLocalEchoCIDs[${cID}::${key}]`, drop the frame silently
    //     (self-echo suppression — §4.9) and remove the CID from the bucket.
    //   - Wire `null` is the clear sentinel — write the
    //     deep-cloned `resolvedDefault` without running `schema.parse`.
    //   - On schema validation failure: **keep** the previous mirror
    //     `value`, flip `status: 'error'`, set `lastError`, fire
    //     `CHELONIA_KV_VALIDATION_ERROR` and `CHELONIA_KV_STATUS_CHANGED`.
    //     Never throw out of the dispatch path.
    'chelonia/kv/_handleRemote': function (contractID, key, parsed, cid) {
        const perKey = this.kvSlotsByContractID.get(contractID);
        const slot = perKey?.get(key);
        if (!slot)
            return Promise.resolve();
        const echoKey = `${contractID}${kv_constants_js_1.KV_KEY_SEPARATOR}${key}`;
        // Treat an empty-string `cid` as "no cid", matching `recordEchoCID`
        // (which rejects empty strings). A malformed frame carrying `cid:
        // ''` must neither participate in echo suppression nor be written
        // into the mirror as an etag — an empty etag would later be sent as
        // `ifMatch: ''` and trigger a spurious 412 on the next local write.
        const hasCid = typeof cid === 'string' && cid.length > 0;
        if (hasCid) {
            const now = nowMs();
            purgeExpiredEchoCIDs(this, echoKey, now);
            const pending = this.kvLocalEchoCIDs.get(echoKey);
            const pendingEntry = pending?.get(cid);
            if (pendingEntry && pendingEntry.expiry > now) {
                if (pendingEntry.fromConflict) {
                    // Echo-first ordering: this is the conflict-resolved write's
                    // own pubsub echo arriving BEFORE a still-pending competing
                    // non-self frame. Suppress the echo (it is ours) but KEEP the
                    // marker — and keep `fromConflict` set — so that when the
                    // competing frame arrives it still enters the
                    // authoritative-GET branch below instead of regressing the
                    // mirror via last-write-wins. That GET then demotes the marker
                    // (on success AND failure), so this cannot loop. The marker
                    // otherwise self-expires via its TTL if no competing frame
                    // ever arrives. Deleting here (the non-conflict path below)
                    // would drop the marker and let a later stale frame win.
                }
                else {
                    pending.delete(cid);
                    if (pending.size === 0)
                        this.kvLocalEchoCIDs.delete(echoKey);
                }
                return Promise.resolve();
            }
            const bucket = this.kvLocalEchoCIDs.get(echoKey);
            if (bucket) {
                let hasPendingConflict = false;
                for (const entry of bucket.values()) {
                    if (entry.fromConflict) {
                        hasPendingConflict = true;
                        break;
                    }
                }
                if (hasPendingConflict) {
                    const conflictCIDs = new Set();
                    for (const [pendingCID, pendingConflict] of bucket) {
                        if (pendingConflict.fromConflict)
                            conflictCIDs.add(pendingCID);
                    }
                    // Demote — do NOT delete — the conflict markers. Once the
                    // authoritative GET below has reconciled the mirror against
                    // the server's latest value, a future *non-self* frame no
                    // longer needs to force another GET (hence clearing
                    // `fromConflict`). But the conflict write's own pubsub echo
                    // may still be in flight; deleting the CID here would let
                    // that delayed echo fall through to the last-write-wins path
                    // and regress the mirror to the older conflict-resolved
                    // value. Keeping the (demoted) entry means the echo still
                    // matches the suppressor at the top of `_handleRemote` and
                    // is dropped. The entry self-expires via its TTL.
                    //
                    // Demotion runs unconditionally — on both fulfilment AND
                    // rejection of the GET. If the GET fails (offline, decode /
                    // validation failure on server data) and we left the markers
                    // set, every subsequent non-self frame would re-enter this
                    // branch and fire another GET — a GET-per-frame loop pinned
                    // until the echo TTL expires (5 min). Demoting on failure
                    // lets the next frame take the normal last-write-wins path
                    // while the still-pending self-echo stays suppressed.
                    const demoteConflictMarkers = () => {
                        const currentBucket = this.kvLocalEchoCIDs.get(echoKey);
                        if (currentBucket) {
                            for (const pendingCID of conflictCIDs) {
                                const pendingEntry = currentBucket.get(pendingCID);
                                if (pendingEntry)
                                    pendingEntry.fromConflict = false;
                            }
                        }
                    };
                    return (0, sbp_1.default)('chelonia/kv/_loadSlotNow', {
                        contractID,
                        slot,
                        reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE,
                        // Reconciling a conflict on an already-loaded slot must not
                        // surface a cosmetic `loaded → loading → loaded` flicker.
                        suppressLoadingStatus: true,
                        // A failed authoritative GET must not flip the slot to
                        // `'error'`: the conflict-resolved write already committed,
                        // so the mirror still holds a valid value. See the flag's
                        // definition in `_loadSlotNow`.
                        preserveStatusOnError: true
                    }).then((result) => {
                        demoteConflictMarkers();
                        return result;
                    }, (e) => {
                        // Never throw out of the pubsub dispatch path (§4.9 / §6).
                        // The authoritative GET failed; demote markers regardless
                        // (see above) and resolve so the dispatcher keeps running.
                        console.error(`[chelonia/kv] conflict-resolution GET failed for ${contractID}::${key}`, e);
                        demoteConflictMarkers();
                    });
                }
            }
        }
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const perContract = ensureContractKv(this, rootState, contractID);
        const entry = perContract[key];
        if (!entry) {
            // Reconcile dropped the mirror entry — nothing to write into.
            // Resolved before decoding so the decode-failure branch never
            // calls `setSlotStatus` against a missing entry (which throws in
            // dev/test).
            return Promise.resolve();
        }
        // No-cid frame on an etag-bearing slot: we have no server CID to
        // pair with this frame, so applying it inline would write the new
        // value (or `undefined` for a clear) while keeping the OLD etag,
        // breaking the "value and etag move together" invariant and
        // guaranteeing a 412 on the next local write. Fetch authoritative
        // state instead so value + etag are re-paired from the server —
        // mirroring the conflict-reconciliation path. Only when `entry.etag`
        // is non-null is there a stale etag to protect; a never-loaded slot
        // (etag null) applies the frame inline below (its first write
        // carries no `if-match`, so no spurious 412). Per §4.9 a no-cid
        // frame is already the exceptional legacy/non-Chelonia-writer path,
        // so the extra round-trip is acceptable.
        if (!hasCid && entry.etag != null) {
            // If a conflict marker is pending for this slot, demote it on
            // completion of this GET (mirroring the conflict branch above):
            // otherwise successive no-cid frames would each re-trigger this
            // GET while the marker stays set — a GET-per-frame loop pinned
            // until the marker's TTL. Demoting lets the next no-cid frame on
            // a now-reconciled slot take the (harmless) inline path. Conflict
            // markers are only ever set alongside a cid, so a no-cid frame
            // seeing one is rare, but demoting keeps the two paths consistent.
            //
            // Scope note: this demotion clears `fromConflict` on EVERY marker
            // in the bucket, not just a single write's marker. Under burst
            // contention with two independent conflict-resolved writes for the
            // same (contractID, key), a later competing frame for the second
            // write would fall through to last-write-wins instead of forcing
            // its own GET. This is self-healing — the server is authoritative
            // and the next local write's `if-match` reconciles — so the
            // broader demotion is accepted to keep the common (single-write)
            // case loop-free.
            const demoteConflictMarkers = () => {
                const bucket = this.kvLocalEchoCIDs.get(echoKey);
                if (bucket) {
                    for (const [, m] of bucket) {
                        if (m.fromConflict)
                            m.fromConflict = false;
                    }
                }
            };
            return (0, sbp_1.default)('chelonia/kv/_loadSlotNow', {
                contractID,
                slot,
                reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE,
                // Already-loaded slot: don't flash `loaded → loading → loaded`.
                suppressLoadingStatus: true,
                // A failed authoritative GET must not flip to `'error'`: the
                // mirror still holds its prior (consistent) value + etag pair.
                preserveStatusOnError: true
            }).then((result) => {
                demoteConflictMarkers();
                return result;
            }, (e) => {
                // Never throw out of the pubsub dispatch path (§4.9 / §6).
                demoteConflictMarkers();
                console.error(`[chelonia/kv] no-cid authoritative GET failed for ${contractID}::${key}`, e);
            });
        }
        let unwrapped;
        try {
            unwrapped = parsed.data;
        }
        catch (e) {
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_VALIDATION_ERROR, {
                contractID,
                contractType: slot.contractType,
                key,
                error: e,
                reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE
            });
            setSlotStatus(this, rootState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
            return Promise.resolve();
        }
        const previousValue = entry.value;
        // Wire `null` is the clear sentinel — skip schema.parse and
        // restore the deep-cloned default.
        let nextValue;
        if (unwrapped === null) {
            nextValue = slot.resolvedDefault !== undefined
                ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                : undefined;
        }
        else if (slot.schema) {
            try {
                // `parsed` is shared with the legacy KV handler (see chelonia.ts).
                // Clone the validated result so the mirror never aliases the
                // shared object — a legacy handler that retains and later mutates
                // it must not corrupt the mirror. (parseSyncSlotValue usually
                // returns a fresh object, but a custom `.parse` may not.)
                const validated = parseSyncSlotValue(slot, unwrapped, `remote ${contractID}::${key}`);
                nextValue = (validated !== null && typeof validated === 'object')
                    ? (0, turtledash_1.cloneDeep)(validated)
                    : validated;
            }
            catch (e) {
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_VALIDATION_ERROR, {
                    contractID,
                    contractType: slot.contractType,
                    key,
                    error: e,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE
                });
                setSlotStatus(this, rootState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
                // Deliberately leave `entry.etag` alone: validation failed, so
                // the mirror `value` is unchanged from the last successful
                // load/write — the etag still describes that value. Nulling
                // it here would diverge from the "value and etag move
                // together" invariant on the success path below (and on
                // §4.9's pubsub-success branch).
                return Promise.resolve();
            }
        }
        else {
            try {
                // assertJsonShape returns its input (=== shared parsed.data)
                // unchanged; clone so the mirror does not alias it.
                const validated = assertJsonShape(unwrapped, `remote ${contractID}::${key}`);
                nextValue = (validated !== null && typeof validated === 'object')
                    ? (0, turtledash_1.cloneDeep)(validated)
                    : validated;
            }
            catch (e) {
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_VALIDATION_ERROR, {
                    contractID,
                    contractType: slot.contractType,
                    key,
                    error: e,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE
                });
                setSlotStatus(this, rootState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
                return Promise.resolve();
            }
        }
        const remoteEtag = hasCid ? cid : (entry.etag ?? null);
        if (!hasCid) {
            // Reaching here without a cid implies `entry.etag == null` (a
            // never-loaded slot): a no-cid frame on an *etag-bearing* slot was
            // already routed to the authoritative GET above. So there is no
            // stale etag to clobber — the frame applies inline with a null
            // etag, exactly as a first load would.
            console.warn(`[chelonia/kv] remote frame for ${contractID}::${key} carried no cid ` +
                'on a never-loaded slot; applying with null etag');
        }
        // A remote clear (unwrapped === null) stores `undefined` as the
        // canonical 'non-init' mirror `value` (§4.3/§4.5), matching local
        // `clear` and the 404 branch; `onUpdate` below still receives the
        // resolved default via `nextValue`.
        const mirrorValue = unwrapped === null ? undefined : nextValue;
        this.config.reactiveSet(entry, 'value', mirrorValue);
        this.config.reactiveSet(entry, 'etag', remoteEtag);
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
            contractID,
            contractType: slot.contractType,
            key,
            value: cloneForEmit(mirrorValue),
            previousValue: cloneForEmit(previousValue),
            reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE,
            etag: remoteEtag
        });
        // A remote clear (unwrapped === null) transitions to 'non-init',
        // matching local clear semantics (§4.5). A successful remote update
        // always calls setSlotStatus('loaded') so that any stale `lastError`
        // is cleared (setSlotStatus internally skips the event when both
        // status and lastError are unchanged).
        if (unwrapped === null) {
            setSlotStatus(this, rootState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.NON_INIT);
        }
        else {
            setSlotStatus(this, rootState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.LOADED);
        }
        if (!slotIsCurrent(this, contractID, slot)) {
            return Promise.resolve();
        }
        return safeOnUpdateGuarded(this, contractID, slot, cloneForEmit(nextValue), {
            contractID,
            contractType: slot.contractType,
            key,
            reason: kv_constants_js_1.KV_UPDATE_REASON.REMOTE,
            etag: remoteEtag,
            previousValue: cloneForEmit(previousValue)
        });
    },
    // Public. See KV-REVAMPED §4.2, §11.3 step 5. The ergonomic write
    // path: resolves the slot, runs the reducer, validates, and writes via
    // `chelonia/kv/set` directly inside
    // the same per-contract queueInvocation lane used by `_handleRemote`.
    //
    // Resolves with the stored value (the reducer's last accepted
    // output), or `undefined` when the reducer returned `KV_NOOP`.
    //
    // Rejection taxonomy (§4.2):
    //   - `ChelErrorKvSlotUnknown`   — contract not synced, or no slot
    //                                  registered for `(contractType, key)`.
    //   - `ChelErrorKvUpdateInvalid` — `updater`/`value` misuse; thrown
    //                                  synchronously before any I/O.
    //                                  Also covers reducer throws and
    //                                  reducer returns of `null` /
    //                                  `undefined` (use `KV_NOOP` to
    //                                  abort explicitly). The original
    //                                  thrown value is preserved on
    //                                  `.cause`.
    //   - `ChelErrorKvValidation`    — reducer output (or server
    //                                  `currentData` on retry) fails
    //                                  `schema.parse`. Original Zod
    //                                  error attached on `.cause`.
    //   - `ChelErrorKvConflict`      — `maxAttempts` exhausted on
    //                                  real 409/412 contention. Last
    //                                  observed `{ currentData, etag }`
    //                                  attached on `.cause`.
    //   - `AbortError`               — `signal` aborted. Mirror is
    //                                  unchanged; no event fires.
    //   - other errors propagated verbatim from `chelonia/kv/set` (called
    //     directly inside the per-contract queue; not via `queuedSet`) for
    //     non-409/412 HTTP failures (5xx, offline). `status` is NOT flipped
    //     to `'error'` (that state is reserved for load failures — §4.9).
    'chelonia/kv/update': async function (args) {
        const { contractID, key, updater, value, maxAttempts, signal, ifMatch } = args;
        // ----- Step 1: resolve the slot via active index. -----
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'update');
        // Reject a write re-entered from this contract's own onUpdate
        // callback before any state mutation — it would deadlock the lane.
        assertNotReentrant(this, contractID, key, 'update');
        // ----- Step 1a: normalise the write input (synchronous). -----
        // Property-presence checks per §4.2: "Exactly one of `updater` or
        // `value` must be provided" discriminates on which channel the
        // caller chose, not on the runtime value (so `value: undefined`
        // counts as "value was provided").
        const hasUpdater = (0, turtledash_1.has)(args, 'updater');
        const hasValue = (0, turtledash_1.has)(args, 'value');
        if (hasUpdater && hasValue) {
            throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
                'of `updater` or `value` (both were provided)');
        }
        if (!hasUpdater && !hasValue) {
            throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
                'of `updater` or `value` (neither was provided)');
        }
        if (hasUpdater && typeof updater !== 'function') {
            throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — \`updater\` was ` +
                'provided but is not a function');
        }
        let reducer;
        if (hasUpdater) {
            reducer = updater;
        }
        else {
            if (!slot.defaultUpdater) {
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — \`value\` was ` +
                    'provided but the slot has no `defaultUpdater`');
            }
            // Synthesise the reducer once — the same closure is re-invoked
            // on conflict retries (§4.2 step 1a).
            let factoryOut;
            try {
                factoryOut = slot.defaultUpdater(value);
            }
            catch (e) {
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
                    'factory threw', { cause: e });
            }
            if (typeof factoryOut !== 'function') {
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
                    'did not return a function');
            }
            reducer = factoryOut;
        }
        // Honour a pre-aborted signal before touching the network.
        throwIfSignalAborted(signal);
        // Track this operation on the pending-writes counter so
        // `chelonia/kv/_waitInFlight` can drain the contract even if the
        // slot index / nonce sources miss it (slot torn down mid-flight,
        // nonce not yet recorded). The increment runs at call time — before
        // the body is enqueued — so a concurrent `reset` cannot escape the
        // gate; the decrement runs in the queued body's `finally` so it
        // clears only when the body has settled.
        incrementPending(this, contractID);
        // The mirror read, reducer, and network write must all run inside the
        // per-contract serial queue so that each write sees the etag left by
        // the preceding one. Reading the mirror outside the queue means
        // concurrent calls all snapshot the same stale etag → guaranteed 412
        // → ONCONFLICT thrashing.
        const runBody = async () => {
            throwIfSignalAborted(signal);
            // Re-read rootState inside the queue for fresh mirror state.
            const liveState = (0, sbp_1.default)(this.config.stateSelector);
            if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] update: no active slot for ${contractID}::${key}`);
            }
            // ----- Step 2: read current mirror value. -----
            const perContract = ensureContractKv(this, liveState, contractID);
            let mirrorEntry = perContract[key];
            // Data-loss guard: when the slot is in 'error' but still holds a
            // retained value + etag (e.g. a transient load-network failure that
            // didn't change server state), seeding the reducer from the default
            // while the write carries `ifMatch: mirrorEtag` would silently
            // overwrite the real server value if that etag still matches. Force
            // one authoritative reload so the reducer seeds from — and the write
            // guards against — the live server state instead. `_loadSlotNow`
            // runs inline (it is the un-queued worker), so awaiting it here does
            // not deadlock the lane. If the reload itself fails we must NOT fall
            // back to the default: the write still carries `ifMatch: mirrorEtag`,
            // so a default-seeded write could match the retained etag and
            // silently overwrite the live value. Instead we seed from the
            // retained value below — it is exactly what the retained etag
            // describes, keeping the basis and the precondition paired (a server
            // value that actually changed produces a 412 → onconflict re-seed).
            let reloadRan = false;
            if (mirrorEntry &&
                mirrorEntry.status === kv_constants_js_1.KV_LOAD_STATUS.ERROR &&
                mirrorEntry.value !== undefined) {
                reloadRan = true;
                try {
                    await (0, sbp_1.default)('chelonia/kv/_loadSlotNow', {
                        contractID,
                        slot,
                        reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD,
                        suppressLoadingStatus: true,
                        silent: true
                    });
                }
                catch (e) {
                    console.warn('[chelonia/kv] update: authoritative reload failed for ' +
                        `${contractID}::${key}; seeding reducer from retained value`, e);
                }
                throwIfSignalAborted(signal);
                if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                    throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] update: no active slot for ${contractID}::${key}`);
                }
                // Re-read from live state (not the pre-reload `perContract`
                // capture): a concurrent release+resync could have replaced the
                // `_kv[contractID]` record while the reload awaited.
                mirrorEntry = liveState._kv?.[contractID]?.[key] ?? perContract[key];
            }
            // Seed precedence. NOTE: when the data-loss-guard reload ran it was
            // `silent`, so the mirror `status` is intentionally frozen at
            // `'error'` (the consumer must not see the reload's transient status
            // churn — #2). We therefore branch on `reloadRan`, NOT on `status`,
            // to know what the (refreshed or retained) mirror value represents:
            //  - reload ran: the mirror value is now either the live server
            //    value (reload success) or the retained value (reload failure).
            //    Both are correctly paired with the etag the write will send, so
            //    seed from it; fall back to the default only when it is
            //    `undefined` (a 404'd reload on a slot with no retained value).
            //    A failed reload leaves the retained value+etag untouched,
            //    keeping the reducer basis and `ifMatch` paired so a no-conflict
            //    commit cannot overwrite live data from a stale default basis.
            //  - no reload: the normal happy path — seed from a non-error live
            //    value, else the default (mirrors `read`'s error semantics for a
            //    genuinely empty / errored slot).
            const seedValue = (() => {
                // When the silent reload ran, the mirror value is now either the
                // live server value (success) or the retained value (failure) —
                // both paired with the etag the write will send — so seed from it,
                // falling back to the default only when it is `undefined`.
                if (reloadRan) {
                    if (mirrorEntry?.value !== undefined) {
                        return (0, turtledash_1.cloneDeep)(mirrorEntry.value);
                    }
                    return slot.resolvedDefault !== undefined
                        ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                        : undefined;
                }
                // No reload: normal happy path — seed from a non-error live value,
                // else the default (mirrors `read`'s error semantics).
                if (mirrorEntry &&
                    mirrorEntry.status !== kv_constants_js_1.KV_LOAD_STATUS.ERROR &&
                    mirrorEntry.value !== undefined) {
                    return (0, turtledash_1.cloneDeep)(mirrorEntry.value);
                }
                return slot.resolvedDefault !== undefined
                    ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                    : undefined;
            })();
            // ----- Step 3: run reducer and validate. -----
            let reducerOut;
            try {
                reducerOut = reducer(seedValue);
            }
            catch (e) {
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer threw`, { cause: e });
            }
            if (typeof reducerOut === 'symbol') {
                if (reducerOut === kv_constants_js_1.KV_NOOP)
                    return undefined;
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                    'an unexpected symbol; use KV_NOOP to abort');
            }
            if (reducerOut === null || reducerOut === undefined) {
                // Reducer may not produce the reserved wire sentinels; clear
                // is its own selector (§4.5). This is a caller-contract
                // violation (reducer shape), not a schema failure, so the
                // taxonomy bucket is ChelErrorKvUpdateInvalid (§4.6).
                throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                    `${String(reducerOut)}; use chelonia/kv/clear or KV_NOOP instead`);
            }
            let nextValue = reducerOut;
            if (slot.schema) {
                try {
                    nextValue = parseSyncSlotValue(slot, nextValue, `update ${contractID}::${key}`);
                }
                catch (e) {
                    throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                        'failed schema.parse', { cause: e });
                }
            }
            else {
                try {
                    nextValue = assertJsonShape(nextValue, `update ${contractID}::${key}`);
                }
                catch (e) {
                    // §4.2 rejection taxonomy: a reducer-output shape failure is a
                    // validation failure, regardless of whether the slot is
                    // schema-backed. Mirrors the `currentData` shape check in the
                    // `onconflict` callback below, which routes the same failure to
                    // ChelErrorKvValidation. Formerly ChelErrorKvUpdateInvalid.
                    throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                        'is not JSON-shaped', { cause: e });
                }
            }
            // ----- Step 5: kv/set with onconflict. -----
            throwIfSignalAborted(signal);
            let lastCurrentData;
            let lastEtag;
            let sawConflict = false;
            const onconflict = async (conflictArgs) => {
                const { etag } = conflictArgs;
                lastEtag = etag;
                sawConflict = true;
                throwIfSignalAborted(signal);
                let currentData;
                try {
                    currentData = conflictArgs.currentData;
                }
                catch (e) {
                    throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} server ` +
                        'currentData failed to decode on conflict retry', { cause: e });
                }
                let basis;
                if (currentData === undefined) {
                    basis = slot.resolvedDefault !== undefined
                        ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                        : undefined;
                }
                else {
                    if (currentData === null) {
                        basis = slot.resolvedDefault !== undefined
                            ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                            : undefined;
                    }
                    else if (slot.schema) {
                        try {
                            // Clone the parsed result before it reaches the reducer: a
                            // mutating reducer must not corrupt the server's cached
                            // decode (currentValue.data in kv/set), which is re-read for
                            // lastRecoveredValue and the conflict-exhaustion error cause.
                            // Mirrors the first-attempt seed clone (step 2).
                            basis = (0, turtledash_1.cloneDeep)(parseSyncSlotValue(slot, currentData, `update onconflict currentData ${contractID}::${key}`));
                        }
                        catch (e) {
                            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} server ` +
                                'currentData failed schema.parse on conflict retry', { cause: e });
                        }
                    }
                    else {
                        try {
                            // assertJsonShape returns its input unchanged, so clone to
                            // detach the reducer's basis from the cached server decode.
                            basis = (0, turtledash_1.cloneDeep)(assertJsonShape(currentData, `update onconflict currentData ${contractID}::${key}`));
                        }
                        catch (e) {
                            throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} server ` +
                                'currentData is not JSON-shaped on conflict retry', { cause: e });
                        }
                    }
                }
                lastCurrentData = basis;
                let retried;
                try {
                    retried = reducer(basis);
                }
                catch (e) {
                    throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer threw on retry`, { cause: e });
                }
                if (typeof retried === 'symbol') {
                    if (retried === kv_constants_js_1.KV_NOOP) {
                        throw new KvNoopAbort();
                    }
                    throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                        'an unexpected symbol on retry; use KV_NOOP to abort');
                }
                if (retried === null || retried === undefined) {
                    throw new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                        `${String(retried)} on retry; use KV_NOOP instead`);
                }
                let validated = retried;
                if (slot.schema) {
                    try {
                        validated = parseSyncSlotValue(slot, retried, `update onconflict retry ${contractID}::${key}`);
                    }
                    catch (e) {
                        throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                            'failed schema.parse on conflict retry', { cause: e });
                    }
                }
                else {
                    try {
                        validated = assertJsonShape(validated, `update onconflict retry ${contractID}::${key}`);
                    }
                    catch (e) {
                        // See the first-attempt reducer-output validation in
                        // `chelonia/kv/update` (the `assertJsonShape` rejection) for why
                        // this is ChelErrorKvValidation, not ChelErrorKvUpdateInvalid.
                        throw new errors_js_1.ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                            'is not JSON-shaped on conflict retry', { cause: e });
                    }
                }
                nextValue = validated;
                return [validated, typeof etag === 'string' ? etag : undefined];
            };
            const mirrorEtag = mirrorEntry?.etag ?? undefined;
            let setResult;
            try {
                // Call chelonia/kv/set directly (not via queuedSet) since we are
                // already inside the per-contract serial queue. Resolving key IDs
                // here (not at call-site) ensures key rotation that landed before
                // this write is seen; the IDs are fixed for kv/set's retries.
                const keyIds = resolveSlotKeyIds(contractID, key, slot, 'update');
                setResult = await (0, sbp_1.default)('chelonia/kv/set', contractID, key, nextValue, {
                    // Footgun for never-loaded slots: a `non-init` slot has
                    // `etag: null`, so `mirrorEtag` is `undefined` and the write
                    // carries no `if-match` precondition. If the server already
                    // holds a value this client never read, the write overwrites
                    // it instead of producing a 412. Harmless for the default
                    // `autoLoad: 'on-sync'` (the slot loads before any write),
                    // but for `autoLoad: 'on-demand'`/`'never'` slots, call
                    // `chelonia/kv/sync` before `update` to avoid clobbering an
                    // unread server value.
                    ifMatch: ifMatch ?? mirrorEtag,
                    encryptionKeyId: keyIds.encryptionKeyId,
                    signingKeyId: keyIds.signingKeyId,
                    onconflict,
                    maxAttempts,
                    signal
                });
            }
            catch (e) {
                // KV_NOOP abort: onconflict threw KvNoopAbort to signal that the
                // reducer chose not to write. The lower-level kv/set propagates
                // this throw, breaking the retry loop. Resolve as a no-op.
                // Use the Symbol.for marker (not instanceof) for realm safety.
                if (e && typeof e === 'object' && kv_constants_js_1.KV_NOOP_ABORT_SYMBOL in e) {
                    return undefined;
                }
                // Map the lower-level conflict-exhaustion Error to the public
                // taxonomy (§4.2 step 6 / rejection table).
                if (isKvMaxAttempts(e)) {
                    const cause = kvConflictCause(e);
                    let carriedCurrentData = { present: false };
                    try {
                        carriedCurrentData = normalizeKvConflictCurrentData(slot, contractID, key, cause);
                    }
                    catch { }
                    throw new errors_js_1.ChelErrorKvConflict(`[chelonia/kv] update: ${contractID}::${key} ran out of attempts ` +
                        'resolving conflicts', {
                        cause: {
                            currentData: carriedCurrentData.present
                                ? carriedCurrentData.currentData
                                : lastCurrentData,
                            etag: cause?.etag ?? lastEtag ?? null
                        }
                    });
                }
                throw e;
            }
            // ----- Step 6: write mirror + emit events. -----
            // Echo-suppress unconditionally, BEFORE the abort check and the
            // staleness/liveness guards below. The write already committed to
            // the server, so its pubsub echo must be dropped regardless of
            // whether the caller's `signal` aborted mid-write or the slot was
            // replaced (defineSlot/HMR) or dropped (reconcile) mid-write.
            // `kvLocalEchoCIDs` is keyed by (contractID, key), not slot
            // identity, so the suppression entry stays valid across slot
            // replacement; recording after an early `return`/throw would let
            // the committed write's echo arrive unsuppressed and be
            // re-validated as a 'remote' frame (spuriously flipping the
            // replacement slot to 'error' — staleness case — or mutating the
            // mirror and firing CHELONIA_KV_UPDATED against an AbortError the
            // contract at §4.2 promises leaves the mirror untouched — abort
            // case). The abort check therefore runs AFTER `recordEchoCID`,
            // never between `kv/set` resolving and the suppression recording.
            if (setResult.etag == null) {
                console.warn(`[chelonia/kv] update: ${contractID}::${key} successful write returned no ` +
                    'etag/x-cid header; self-echo suppression is inactive for this write');
            }
            recordEchoCID(this, contractID, key, setResult.etag, sawConflict);
            throwIfSignalAborted(signal);
            if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                // Slot replaced mid-write. The value DID commit to the server,
                // so resolve with it (not `undefined`) — `undefined` is reserved
                // for `KV_NOOP`/abort, i.e. "no write happened". Returning the
                // committed value lets callers distinguish a persisted write
                // from a genuine no-op even though no live mirror received it.
                return nextValue;
            }
            const perContractAfter = ensureContractKv(this, liveState, contractID);
            const entryAfter = perContractAfter[key];
            const previousValue = entryAfter?.value;
            if (!entryAfter) {
                // Reconcile dropped the slot mid-write — nothing to mirror into.
                // The value still committed to the server, so resolve with it
                // (same rationale as the staleness path above) rather than
                // misleading the caller with `undefined`.
                return nextValue;
            }
            this.config.reactiveSet(entryAfter, 'value', nextValue);
            this.config.reactiveSet(entryAfter, 'etag', setResult.etag);
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                contractID,
                contractType: slot.contractType,
                key,
                value: cloneForEmit(nextValue),
                previousValue: cloneForEmit(previousValue),
                reason: kv_constants_js_1.KV_UPDATE_REASON.LOCAL,
                etag: setResult.etag
            });
            if (entryAfter.status !== kv_constants_js_1.KV_LOAD_STATUS.LOADED) {
                setSlotStatus(this, liveState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.LOADED);
            }
            if (slotIsCurrent(this, contractID, slot)) {
                await safeOnUpdateGuarded(this, contractID, slot, cloneForEmit(nextValue), {
                    contractID,
                    contractType: slot.contractType,
                    key,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.LOCAL,
                    etag: setResult.etag,
                    previousValue: cloneForEmit(previousValue)
                });
            }
            return nextValue;
        };
        // Enqueue the body on the per-contract lane while keeping the
        // pending-write counter balanced no matter how `queueInvocation`
        // misbehaves. Two failure shapes are guarded:
        //   1. It throws *synchronously* (e.g. an SBP filter vetoes the
        //      underlying `queueEvent`, so `queueInvocation`'s body does
        //      `undefined.then(...)`): the `try/catch` decrements and rethrows.
        //   2. It returns a non-promise / `undefined` (e.g. a filter vetoes
        //      `queueInvocation` itself, so `sbp(...)` returns `undefined`):
        //      `Promise.resolve(queued)` normalises it so `.finally` always
        //      attaches and decrements. For a real promise `Promise.resolve`
        //      returns it unchanged, so the normal path is unaffected.
        let queued;
        try {
            queued = (0, sbp_1.default)('chelonia/queueInvocation', contractID, runBody);
        }
        catch (e) {
            decrementPending(this, contractID);
            throw e;
        }
        return Promise.resolve(queued).finally(() => {
            decrementPending(this, contractID);
        });
    },
    // Public. See KV-REVAMPED §4.3. Synchronous mirror read.
    //
    // Two-step slot resolution (same as `update`) — throws
    // `ChelErrorKvSlotUnknown` if the contract isn't synced/typed, or if
    // no slot is registered for `key` in the last-reconciled active index
    // (`kvSlotsByContractID[contractID]`). The contract type is resolved
    // only to confirm the contract is synced; the slot itself is looked up
    // by `(contractID, key)`, not by `registryKey(contractType, key)`.
    // Substitutes a deep-cloned `resolvedDefault` when the mirror entry
    // is absent, `value === undefined` (the "non-init" representation —
    // see the note in §4.3), or the slot is in `status: 'error'`. The
    // error-status fallback keeps `read` from exposing a value that failed
    // load / remote / re-validation under the current slot schema.
    // Returned value is the cloned default, or `undefined` if the slot has
    // no `defaultValue` and the mirror is empty.
    //
    // **Defensive deep-cloning.** Spec §4.1 only requires deep-cloning
    // the default, but the implementation goes further and deep-clones
    // every non-primitive mirror value on the way out. This prevents
    // the worst footgun — a caller mutating the returned object and
    // silently corrupting the mirror (and confusing every reactive
    // observer downstream). For very large slot values (e.g. namespace
    // caches) this is a non-trivial per-read cost; budget accordingly
    // or read-and-cache instead of reading-on-every-frame.
    'chelonia/kv/read': function (contractID, key) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'read');
        const entry = rootState._kv?.[contractID]?.[key];
        if (!entry || entry.value === undefined || entry.status === kv_constants_js_1.KV_LOAD_STATUS.ERROR) {
            return slot.resolvedDefault !== undefined
                ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                : undefined;
        }
        const v = entry.value;
        return (v === null || typeof v !== 'object') ? v : (0, turtledash_1.cloneDeep)(v);
    },
    // Public. See KV-REVAMPED §4.4. Force-fetch a slot (or every active
    // slot for a contract) and refresh the mirror.
    //
    // Single-slot form (with `key`) — rejects on slot failure, matching
    // the rejection semantics of `chelonia/kv/update`.
    //
    // Aggregate form (no `key`) — dispatches loads for every entry in the
    // last-reconciled active-slot index (`kvSlotsByContractID[contractID]`).
    // The loads are still serialized on the per-contract queue inside
    // `_loadSlot`, and per-slot failures surface via status/events while
    // the aggregate promise resolves after every load settles.
    'chelonia/kv/sync': async function (contractID, key) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (key !== undefined) {
            const slot = resolveActiveSlot(this, rootState, contractID, key, 'sync');
            // Reject a sync re-entered from this contract's own onUpdate
            // callback — `_loadSlot` enqueues on the same lane → deadlock.
            assertNotReentrant(this, contractID, key, 'sync');
            // _loadSlot rethrows GET failures verbatim, and wraps decode /
            // validation failures in ChelErrorKvValidation with the original
            // error on cause. Let the error propagate for the single-slot
            // rejection semantics.
            await (0, sbp_1.default)('chelonia/kv/_loadSlot', { contractID, slot, reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD });
            return;
        }
        // Aggregate form — per §4.4 the aggregate form never rejects.
        // If the contract isn't synced there are no active slots to
        // refresh, so return early silently.
        const contractMeta = rootState.contracts?.[contractID];
        if (!contractMeta || !this.subscriptionSet.has(contractID)) {
            return;
        }
        const perKey = this.kvSlotsByContractID.get(contractID);
        if (!perKey || perKey.size === 0)
            return;
        // Reject a re-entrant aggregate sync at the only point a deadlock
        // could occur (just before dispatching loads on the shared lane).
        // The early returns above can't deadlock — no load is dispatched.
        assertNotReentrant(this, contractID, '*', 'sync');
        const slots = Array.from(perKey.values());
        await Promise.all(slots.map((slot) => (0, sbp_1.default)('chelonia/kv/_loadSlot', { contractID, slot, reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD })
            .catch((e) => {
            // Aggregate form never rejects (§4.4), but log rejections so
            // failed syncs are debuggable — matching the fire-and-forget
            // loads in `_reconcileForSlot` / `_onContractResynced`.
            console.error(`[chelonia/kv] aggregate sync: _loadSlot rejected for ${contractID}::${slot.key}`, e);
        })));
    },
    // Public. See KV-REVAMPED §4.5. Resets a slot to its declared
    // default by writing `null` through the per-contract serial queue via
    // `chelonia/kv/set`. The `null` value is the wire-level clear sentinel; `_handleRemote`
    // on other clients maps it back to the declared default before
    // any `schema.parse`.
    //
    // Local-side behaviour after the network write resolves:
    //   - mirror.value ← undefined (canonical 'non-init'; §4.3/§4.5).
    //     The deep-cloned default is surfaced only via `read`/`onUpdate`,
    //     never written into the raw mirror.
    //   - mirror.etag  ← setResult.etag
    //   - status       ← 'non-init'
    //   - CHELONIA_KV_UPDATED fires with `reason: 'local'` and `value`
    //     set to `undefined` (matching the mirror); `onUpdate` receives
    //     the cloned default
    //   - safeOnUpdateGuarded dispatched
    //
    // Throws `ChelErrorKvSlotUnknown` on the same conditions as
    // `chelonia/kv/update`. Other errors from `chelonia/kv/set` (called
    // directly inside the per-contract queue; not via `queuedSet`)
    // propagate verbatim; the mirror is untouched on failure.
    'chelonia/kv/clear': async function (contractID, key, { maxAttempts, signal } = {}) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'clear');
        // Reject a clear re-entered from this contract's own onUpdate
        // callback before any state mutation — it would deadlock the lane.
        assertNotReentrant(this, contractID, key, 'clear');
        throwIfSignalAborted(signal);
        // Track on the pending-writes counter (see `update` / `_waitInFlight`).
        incrementPending(this, contractID);
        let lastEtag;
        let lastCurrentData = { present: false };
        let sawConflict = false;
        const onconflict = async (conflictArgs) => {
            // Read `etag` (a plain value) eagerly, but NEVER destructure
            // `currentData` in the parameter list: the real `chelonia/kv/set`
            // passes it as a getter that throws on decrypt/signature failure
            // (chelonia.ts), and parameter-position destructuring would invoke
            // that getter *before* the try/catch below, rejecting clear with a
            // raw decode error. Keep the getter access inside the guarded
            // `normalizeKvConflictCurrentData` call so a failure is swallowed
            // and clear still writes `null`.
            const etag = conflictArgs.etag;
            lastEtag = etag;
            sawConflict = true;
            // Capture the server's observed state so a conflict-exhaustion
            // rejection can report it (§4.2), matching `update`. Wrapped in
            // try/catch so a decode/validation failure of server data can't
            // break clear's own error path; clear still writes `null`.
            try {
                lastCurrentData = normalizeKvConflictCurrentData(slot, contractID, key, conflictArgs);
            }
            catch { }
            throwIfSignalAborted(signal);
            return [null, typeof etag === 'string' ? etag : undefined];
        };
        const runBody = async () => {
            throwIfSignalAborted(signal);
            const liveState = (0, sbp_1.default)(this.config.stateSelector);
            if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                throw new errors_js_1.ChelErrorKvSlotUnknown(`[chelonia/kv] clear: no active slot for ${contractID}::${key}`);
            }
            const mirrorEtag = liveState._kv?.[contractID]?.[key]?.etag ?? undefined;
            let setResult;
            try {
                // Resolve key IDs inside the queue so rotations that landed
                // before this clear are seen; they stay fixed for kv/set's retries.
                const keyIds = resolveSlotKeyIds(contractID, key, slot, 'clear');
                setResult = await (0, sbp_1.default)('chelonia/kv/set', contractID, key, null, {
                    ifMatch: mirrorEtag,
                    encryptionKeyId: keyIds.encryptionKeyId,
                    signingKeyId: keyIds.signingKeyId,
                    onconflict,
                    maxAttempts,
                    signal
                });
            }
            catch (e) {
                if (isKvMaxAttempts(e)) {
                    const cause = kvConflictCause(e);
                    throw new errors_js_1.ChelErrorKvConflict(`[chelonia/kv] clear: ${contractID}::${key} ran out of attempts ` +
                        'resolving conflicts', {
                        cause: {
                            // Report the server's last observed state when it
                            // surfaced one; otherwise fall back to `null` (clear's
                            // intended write value) as before.
                            currentData: lastCurrentData.present
                                ? lastCurrentData.currentData
                                : null,
                            etag: cause?.etag ?? lastEtag ?? null
                        }
                    });
                }
                throw e;
            }
            // Echo-suppress unconditionally, BEFORE the abort check and the
            // staleness/liveness guards: the clear already committed to the
            // server, so its pubsub echo must be dropped regardless of slot
            // replacement/drop or an aborting `signal`. See the matching note
            // in `chelonia/kv/update` for the full rationale (the abort check
            // must run AFTER `recordEchoCID`, never between `kv/set` resolving
            // and the suppression recording, or the committed write's echo
            // would re-validate against the §4.2 abort contract).
            if (setResult.etag == null) {
                console.warn(`[chelonia/kv] clear: ${contractID}::${key} successful write returned no ` +
                    'etag/x-cid header; self-echo suppression is inactive for this write');
            }
            recordEchoCID(this, contractID, key, setResult.etag, sawConflict);
            throwIfSignalAborted(signal);
            if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                return;
            }
            const perContract = ensureContractKv(this, liveState, contractID);
            const entry = perContract[key];
            if (!entry) {
                return;
            }
            const previousValue = entry.value;
            const defaultClone = slot.resolvedDefault !== undefined
                ? (0, turtledash_1.cloneDeep)(slot.resolvedDefault)
                : undefined;
            // §4.3/§4.5: a 'non-init' mirror `value` is always `undefined` (the
            // canonical "nothing server-confirmed" representation), matching the
            // 404 branch in `_loadSlotNow`. `read` and `onUpdate` still surface
            // the deep-cloned default; only the raw mirror + event payload carry
            // `undefined` so direct `rootState._kv` observers see one shape.
            this.config.reactiveSet(entry, 'value', undefined);
            this.config.reactiveSet(entry, 'etag', setResult.etag);
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                contractID,
                contractType: slot.contractType,
                key,
                value: undefined,
                previousValue: cloneForEmit(previousValue),
                reason: kv_constants_js_1.KV_UPDATE_REASON.LOCAL,
                etag: setResult.etag
            });
            if (entry.status !== kv_constants_js_1.KV_LOAD_STATUS.NON_INIT) {
                setSlotStatus(this, liveState, contractID, slot.contractType, key, kv_constants_js_1.KV_LOAD_STATUS.NON_INIT);
            }
            if (slotIsCurrent(this, contractID, slot)) {
                await safeOnUpdateGuarded(this, contractID, slot, defaultClone, {
                    contractID,
                    contractType: slot.contractType,
                    key,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.LOCAL,
                    etag: setResult.etag,
                    previousValue: cloneForEmit(previousValue)
                });
            }
        };
        // Enqueue on the per-contract lane, balancing the pending counter
        // under both a synchronous throw and a non-promise return from
        // `queueInvocation` (see the matching note in `chelonia/kv/update`).
        let queued;
        try {
            queued = (0, sbp_1.default)('chelonia/queueInvocation', contractID, runBody);
        }
        catch (e) {
            decrementPending(this, contractID);
            throw e;
        }
        return Promise.resolve(queued).finally(() => {
            decrementPending(this, contractID);
        });
    },
    // Public. See KV-REVAMPED §4.6. Reports the load state of a slot,
    // or the aggregate state of an entire contract.
    //
    // Aggregate form (no `key`): reduces across every slot active for
    // `contractID` with precedence `error > loading > non-init > loaded`.
    // Returns `'non-init'` if no slots are active for the contract.
    //
    // Single form: reads the slot's `status` from the mirror. Returns
    // `'non-init'` if the mirror entry hasn't been seeded yet. Unlike
    // `read`/`update`/`sync`/`clear`, `status` does NOT reject on an
    // unknown or inactive slot — it returns `'non-init'`. This matches
    // the consumer pattern of "render a status badge regardless of
    // whether the slot is actually wired" without needing try/catch
    // around the call.
    'chelonia/kv/status': function (contractID, key) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (key !== undefined) {
            // Use the active index to verify the slot is active, but fall
            // back to `'non-init'` instead of throwing — status is a query,
            // not a command.
            const active = this.kvSlotsByContractID.get(contractID)?.has(key);
            if (!active)
                return kv_constants_js_1.KV_LOAD_STATUS.NON_INIT;
            const entry = rootState._kv?.[contractID]?.[key];
            return entry?.status ?? kv_constants_js_1.KV_LOAD_STATUS.NON_INIT;
        }
        // Aggregate: precedence error > loading > non-init > loaded.
        const perKey = this.kvSlotsByContractID.get(contractID);
        if (!perKey || perKey.size === 0)
            return kv_constants_js_1.KV_LOAD_STATUS.NON_INIT;
        const perContract = rootState._kv?.[contractID];
        let sawLoading = false;
        let sawNonInit = false;
        for (const slotKey of perKey.keys()) {
            const status = perContract?.[slotKey]?.status ?? kv_constants_js_1.KV_LOAD_STATUS.NON_INIT;
            if (status === kv_constants_js_1.KV_LOAD_STATUS.ERROR)
                return kv_constants_js_1.KV_LOAD_STATUS.ERROR;
            if (status === kv_constants_js_1.KV_LOAD_STATUS.LOADING)
                sawLoading = true;
            else if (status === kv_constants_js_1.KV_LOAD_STATUS.NON_INIT)
                sawNonInit = true;
        }
        if (sawLoading)
            return kv_constants_js_1.KV_LOAD_STATUS.LOADING;
        if (sawNonInit)
            return kv_constants_js_1.KV_LOAD_STATUS.NON_INIT;
        return kv_constants_js_1.KV_LOAD_STATUS.LOADED;
    },
    // Private convenience used by `chelonia/defineContract`. Accepts the
    // `kv: { ... }` block declared inline on a contract definition and
    // registers each entry as a `defineSlot` call scoped to the contract
    // type (the contract name stored in `state.contracts[cID].type`).
    // The manifest is retained as the ownership marker used by cleanup.
    // See KV-REVAMPED.md §4.8 / §11.3 step 7.
    'chelonia/kv/_registerContractSlots': function (contractType, manifest, kv) {
        for (const key of Object.keys(kv)) {
            const entry = kv[key];
            (0, sbp_1.default)('chelonia/kv/_defineSlotInternal', {
                ...entry,
                contractType,
                key
            }, { kind: 'defineContract', manifest });
        }
    },
    // Private. See KV-REVAMPED.md §11.3 step 8. Diffs `prevKv` vs
    // `nextKv` for `manifest`; for every key present in `prevKv` but not
    // in `nextKv`, unregister the slot from `kvSlots`, scrub it from
    // every `kvSlotsByContractID[cID]` and `kvActiveFilters[cID]`,
    // queue a filter flush, and drop the corresponding
    // `rootState._kv[cID][key]` mirror entry. Two passes drop the mirror
    // entry: the index walk covers subscribed/reconciled contracts, and a
    // second `_kv` walk covers non-subscribed contracts whose persisted
    // entries were seeded by `_defineSlotInternal` and never entered the
    // index (skipping entries whose contract type can't be confirmed).
    // Keys present in both blocks are left to the normal `defineSlot`
    // re-registration path (which re-validates persisted mirror values
    // against the new schema — §4.1).
    'chelonia/kv/_cleanupContractSlots': function (contractType, manifest, prevKv, nextKv) {
        if (!prevKv)
            return;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const nextKeys = nextKv ? new Set(Object.keys(nextKv)) : new Set();
        for (const key of Object.keys(prevKv)) {
            if (nextKeys.has(key))
                continue;
            const rKey = registryKey(contractType, key);
            const slot = this.kvSlots.get(rKey);
            if (!slot)
                continue;
            // Only unregister the current registry entry if it was registered by
            // this manifest's defineContract call. A standalone defineSlot that
            // replaced the manifest entry after registration must survive; earlier
            // standalone definitions overwritten by the manifest entry are not restored.
            if (!slot.source)
                continue;
            if (slot.source.kind !== 'defineContract')
                continue;
            if (slot.source.manifest !== manifest)
                continue;
            this.kvSlots.delete(rKey);
            // Scrub every per-contract index entry pointing at this slot.
            for (const [cID, perKey] of this.kvSlotsByContractID) {
                if (perKey.get(key) !== slot)
                    continue;
                perKey.delete(key);
                const contractEmptied = perKey.size === 0;
                if (contractEmptied)
                    this.kvSlotsByContractID.delete(cID);
                const filter = this.kvActiveFilters.get(cID);
                if (filter?.has(key)) {
                    filter.delete(key);
                    queueFilterFlush(this, cID);
                }
                if (contractEmptied)
                    this.kvActiveFilters.delete(cID);
                const perContract = rootState._kv?.[cID];
                if (perContract && perContract[key]) {
                    this.config.reactiveDel(perContract, key);
                }
                this.kvLocalEchoCIDs.delete(`${cID}${kv_constants_js_1.KV_KEY_SEPARATOR}${key}`);
            }
            // The index loop above only covers contracts in `kvSlotsByContractID`
            // (subscribed/reconciled ones). `_defineSlotInternal` also persists /
            // re-validates `_kv[cID][key]` entries for contracts NOT in
            // `subscriptionSet` (e.g. carried over from a prior session, not yet
            // re-synced); those never enter the index, so the loop above leaves
            // them behind. Walk the mirror directly and drop matching entries so
            // unregistering the slot doesn't leak persisted state (and doesn't
            // trip `_assertIndexConsistent` once the contract re-syncs).
            // Entries whose contract type can't be confirmed to match are left
            // alone — re-validating/deleting against the wrong type would clobber
            // foreign data; the next sync's load/reconcile reconciles them.
            if (rootState._kv) {
                for (const cID of Object.keys(rootState._kv)) {
                    if (this.subscriptionSet.has(cID))
                        continue;
                    if (getContractType(rootState, cID) !== contractType)
                        continue;
                    const perContract = rootState._kv[cID];
                    if (!perContract || !perContract[key])
                        continue;
                    this.config.reactiveDel(perContract, key);
                    if (Object.keys(perContract).length === 0) {
                        this.config.reactiveDel(rootState._kv, cID);
                    }
                    this.kvLocalEchoCIDs.delete(`${cID}${kv_constants_js_1.KV_KEY_SEPARATOR}${key}`);
                }
            }
        }
    },
    // Public. See KV-REVAMPED §4.7. Runs a full reconcile pass: walks
    // `subscriptionSet`, re-evaluates every registered slot's `match`
    // predicate against the current root state, and drives
    // `_reconcileForSlot` to update indices and schedule loads / drops.
    //
    // With `contractID`, the pass is scoped to that single contract.
    // Without, every currently-synced contract is processed.
    //
    // Consumers call this after they mutate state the library cannot
    // observe — most notably the login transition that flips an
    // "own identity" predicate. The reconciler is idempotent: a slot
    // whose match result hasn't changed is a no-op apart from the
    // `_reconcileForSlot` walk itself.
    'chelonia/kv/refreshFilters': function (contractID) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const targets = contractID !== undefined
            ? (this.subscriptionSet.has(contractID) ? [contractID] : [])
            : Array.from(this.subscriptionSet);
        for (const cID of targets) {
            const meta = rootState.contracts?.[cID];
            if (!meta)
                continue;
            const contractType = getContractType(rootState, cID);
            if (typeof contractType !== 'string')
                continue;
            for (const slot of this.kvSlots.values()) {
                if (slot.contractType !== contractType)
                    continue;
                (0, sbp_1.default)('chelonia/kv/_reconcileForSlot', slot, cID);
            }
        }
    }
});
// ---------------------------------------------------------------------------
// Helpers that close over the `sbp` registry (declared after the register
// block so they can call back into selectors registered above).
// ---------------------------------------------------------------------------
// On `defineSlot` replacement, re-run the new `schema.parse` against
// any persisted mirror entry for this slot. KV-REVAMPED §4.1:
// the library NEVER discards data on schema mismatch — failing
// entries keep their previous `value` but transition to
// `status: 'error'` with `lastError` set, and
// `CHELONIA_KV_VALIDATION_ERROR` fires with `reason: 're-validate'`.
// Successful re-validations transition back to `'loaded'`, emit
// `CHELONIA_KV_UPDATED` with `reason: 'load'`, and fire `onUpdate`
// — so listeners observing transitions out of `'error'` can react.
//
// Concurrency note: the synchronous re-parse + status flip below run
// directly from `_defineSlotInternal` (OUTSIDE the per-contract
// `chelonia/queueInvocation` lane) so a slot transitioning out of
// `'error'` clears promptly and the dev index invariant holds. But the
// *mirror value mutation* + `CHELONIA_KV_UPDATED` + `onUpdate` for a
// coercing schema (`changed === true`) are routed THROUGH the lane:
// re-seeding the mirror inline could clobber a value an in-flight
// `update`/`_handleRemote` is about to (or just did) write, diverging
// the mirror from the server and reordering `onUpdate`. Inside the lane
// we re-read the live entry and bail unless it still holds the value we
// re-parsed, so a write that landed first wins. The common idempotent
// case (`changed === false`) stays fully synchronous and emits nothing.
function revalidateMirrorEntry(ctx, rootState, contractID, slot) {
    const entry = rootState._kv?.[contractID]?.[slot.key];
    if (!entry || entry.value === undefined)
        return;
    const previousValue = entry.value;
    // Capture before any status flip below. §4.1 requires a successful
    // re-validation to fire CHELONIA_KV_UPDATED even when the value is
    // structurally unchanged, specifically so listeners observing
    // transitions out of 'error' can react.
    const priorStatus = entry.status;
    // Clone before parse so a mutating custom `{ parse }` validator can't
    // corrupt the live mirror value in place (bypassing `reactiveSet` and
    // the "value and etag move together" invariant). Every other parse
    // call site already passes a non-mirror value; this is the lone
    // exception. The original `previousValue` reference is retained for the
    // change comparison and event payloads below.
    const parseInput = (previousValue !== null && typeof previousValue === 'object')
        ? (0, turtledash_1.cloneDeep)(previousValue)
        : previousValue;
    // Hoisted out of the `try` so the catch path can branch on it (Issue 4:
    // defer the ERROR stamp through the lane when a write is in flight,
    // symmetric with the success path's deferral of the LOADED flip).
    const hasInflight = (ctx.kvPendingWrites.get(contractID) ?? 0) > 0;
    try {
        const parsed = slot.schema
            ? parseSyncSlotValue(slot, parseInput, `re-validate ${contractID}::${slot.key}`)
            : assertJsonShape(parseInput, `re-validate ${contractID}::${slot.key}`);
        // §4.1: a successful re-validation must fire CHELONIA_KV_UPDATED with
        // reason 'load' even when the parsed value is structurally identical
        // to the previous mirror value, so listeners observing transitions
        // out of 'error' can react. `recoveredFromError` distinguishes the
        // error-recovery case (emit) from the boot-idempotent case (status
        // was already 'loaded' → suppress, avoiding spurious events on every
        // boot re-validation). A coercing schema that genuinely transforms
        // the stored value still emits via `changed`. Status is always
        // restored to 'loaded' so a slot transitioning out of 'error' clears
        // its `lastError` (setSlotStatus suppresses the no-op event).
        const changed = !(0, turtledash_1.deepEqualJSONType)(parsed, previousValue);
        const recoveredFromError = priorStatus === kv_constants_js_1.KV_LOAD_STATUS.ERROR;
        const shouldEmit = changed || recoveredFromError;
        // Status flip placement: when no write is in flight for this contract,
        // flip synchronously so a slot leaving 'error' clears its `lastError`
        // promptly (the common boot/HMR case). When a write IS in flight (paused
        // at an await inside the lane), a synchronous flip would interleave a
        // misleading 'loaded' between the in-flight op's own status transitions;
        // defer it into the lane so it serialises behind that op instead.
        //
        // Exception (Issue 5): when a coercion is pending for an INDEXED
        // contract with no in-flight write, the value mutation is routed
        // through the lane (atomicity with queued lane work, see the lane
        // branch below). Flipping status synchronously here while deferring
        // the value would open a microtask window where `read()` (keyed on
        // `status !== 'error'`) returns the pre-coercion value while `status`
        // already reports 'loaded'. `deferStatusFlip` makes the status flip
        // ride the same lane callback so the two move atomically. The
        // non-indexed inline branch applies both synchronously (atomic
        // already), and the `!changed` case has no value change to desync
        // against, so those keep the prompt sync flip.
        const isIndexed = ctx.kvSlotsByContractID.get(contractID)?.has(slot.key) === true;
        const deferStatusFlip = changed && isIndexed;
        if (!hasInflight && !deferStatusFlip) {
            setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, kv_constants_js_1.KV_LOAD_STATUS.LOADED);
        }
        // A non-subscribed contract (persisted mirror entry from a prior session,
        // re-validated by the `_defineSlotInternal` non-subscribed loop) has no
        // lane and no possible in-flight write — writes require the slot to be
        // indexed. Route the coercion INLINE instead of through `queueInvocation`,
        // whose slot-identity guard (`kvSlotsByContractID.get(cID)?.get(key)`)
        // would always bail for a non-indexed contract and silently drop the
        // coerced value. The synchronous status flip above already ran; `onUpdate`
        // is intentionally skipped here (it is lane-serialised for indexed slots)
        // and will fire on the next sync when the contract re-indexes.
        if (shouldEmit && !isIndexed && !hasInflight) {
            const live = rootState._kv?.[contractID]?.[slot.key];
            if (live && (0, turtledash_1.deepEqualJSONType)(live.value, previousValue)) {
                // Skip the reactiveSet when the value is structurally unchanged
                // (error-recovery with identical value) — avoid a spurious
                // reference swap in reactive systems while still emitting UPDATED.
                if (changed)
                    ctx.config.reactiveSet(live, 'value', parsed);
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    value: cloneForEmit(changed ? parsed : previousValue),
                    previousValue: cloneForEmit(previousValue),
                    reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD,
                    etag: live.etag
                });
            }
        }
        else if (shouldEmit || hasInflight) {
            // A coercing schema's mirror mutation + events go through the lane so
            // they serialise behind any in-flight write for this contract and
            // never clobber a newer value. Re-check slot identity and that the
            // live entry still holds `previousValue` before applying. A deferred
            // status flip (hasInflight, or deferStatusFlip for an indexed coercion)
            // also runs here, behind the in-flight op / alongside the value.
            (0, sbp_1.default)('chelonia/queueInvocation', contractID, () => {
                if (ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot)
                    return;
                if (hasInflight || deferStatusFlip) {
                    setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, kv_constants_js_1.KV_LOAD_STATUS.LOADED);
                }
                if (!shouldEmit)
                    return;
                const live = rootState._kv?.[contractID]?.[slot.key];
                if (!live || !(0, turtledash_1.deepEqualJSONType)(live.value, previousValue))
                    return;
                if (changed)
                    ctx.config.reactiveSet(live, 'value', parsed);
                const emitValue = changed ? parsed : previousValue;
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_UPDATED, {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    value: cloneForEmit(emitValue),
                    previousValue: cloneForEmit(previousValue),
                    reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD,
                    etag: live.etag
                });
                // safeOnUpdateGuarded catches its own errors, so awaiting it only
                // sequences the callback within the lane.
                return safeOnUpdateGuarded(ctx, contractID, slot, cloneForEmit(emitValue), {
                    contractID,
                    contractType: slot.contractType,
                    key: slot.key,
                    reason: kv_constants_js_1.KV_UPDATE_REASON.LOAD,
                    etag: live.etag,
                    previousValue: cloneForEmit(previousValue)
                });
            }).catch((e) => {
                console.error(`[chelonia/kv] re-validate enqueue failed for ${contractID}::${slot.key}`, e);
            });
        }
    }
    catch (e) {
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_KV_VALIDATION_ERROR, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            error: e,
            reason: kv_constants_js_1.KV_VALIDATION_REASON_REVALIDATE
        });
        // Symmetric with the success path's `hasInflight` deferral in
        // `revalidateMirrorEntry` (the `!hasInflight && !deferStatusFlip`
        // branch): when a write holds the lane, a synchronous ERROR flip
        // would interleave with the in-flight op's own status transitions.
        // Defer through the lane so the ERROR stamp serialises behind that
        // write, matching how the success path defers its LOADED flip. The
        // `VALIDATION_ERROR` event above still fires synchronously because it
        // is diagnostic and does not mutate state.
        if (hasInflight) {
            (0, sbp_1.default)('chelonia/queueInvocation', contractID, () => {
                if (ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot)
                    return;
                // Re-check the LIVE mirror value before stamping ERROR (#5),
                // mirroring the success path's `deepEqualJSONType` guard. The
                // parse failed against `previousValue`; if an interleaving op on
                // this lane (e.g. `_handleRemote` writing a fresh, valid value)
                // changed the mirror while we awaited the lane, the value we
                // judged invalid is gone and stamping ERROR would wrongly mark a
                // now-valid slot. Only stamp when the live value still matches the
                // one that failed to parse.
                const live = rootState._kv?.[contractID]?.[slot.key];
                if (!live || !(0, turtledash_1.deepEqualJSONType)(live.value, previousValue))
                    return;
                setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
            }).catch((err) => {
                console.error(`[chelonia/kv] re-validate ERROR flip enqueue failed for ${contractID}::${slot.key}`, err);
            });
        }
        else {
            setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, kv_constants_js_1.KV_LOAD_STATUS.ERROR, normalizeError(e));
        }
    }
}
// Public re-exports from kv-constants.js
var kv_constants_js_2 = require("./kv-constants.cjs");
Object.defineProperty(exports, "KV_AUTO_LOAD", { enumerable: true, get: function () { return kv_constants_js_2.KV_AUTO_LOAD; } });
Object.defineProperty(exports, "KV_DEFAULT_ENCRYPTION_KEY_NAME", { enumerable: true, get: function () { return kv_constants_js_2.KV_DEFAULT_ENCRYPTION_KEY_NAME; } });
Object.defineProperty(exports, "KV_DEFAULT_SIGNING_KEY_NAME", { enumerable: true, get: function () { return kv_constants_js_2.KV_DEFAULT_SIGNING_KEY_NAME; } });
Object.defineProperty(exports, "KV_LOAD_STATUS", { enumerable: true, get: function () { return kv_constants_js_2.KV_LOAD_STATUS; } });
Object.defineProperty(exports, "KV_NOOP", { enumerable: true, get: function () { return kv_constants_js_2.KV_NOOP; } });
Object.defineProperty(exports, "KV_UPDATE_REASON", { enumerable: true, get: function () { return kv_constants_js_2.KV_UPDATE_REASON; } });
Object.defineProperty(exports, "KV_VALIDATION_REASON_REVALIDATE", { enumerable: true, get: function () { return kv_constants_js_2.KV_VALIDATION_REASON_REVALIDATE; } });
