// KV slot API — see KV-REVAMPED.md for the full design.
//
// This module implements the declarative KV slot API layered on top of the
// existing `chelonia/kv/*` primitives (`chelonia/kv/set`,
// `chelonia/kv/get`, `chelonia/kv/setFilter`, `chelonia/kv/queuedSet`).
// Behaviour lands incrementally — see the kv-revamped task plan.
import '@sbp/okturtles.events';
import sbp from '@sbp/sbp';
import { cloneDeep, has } from 'turtledash';
import { ChelErrorKvConflict, ChelErrorKvSlotInvalid, ChelErrorKvSlotUnknown, ChelErrorKvUpdateInvalid, ChelErrorKvValidation } from './errors.mjs';
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED, CHELONIA_KV_VALIDATION_ERROR } from './events.mjs';
import { ChelErrorKvMaxAttempts } from './internal-errors.mjs';
// Reserved sentinel returned by a `KvUpdater` to abort a write without
// touching the server (replaces the legacy `return null` idiom from
// `chelonia/kv/set`'s `onconflict`).
//
// `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the sentinel
// survives realm boundaries — iframes, workers, and the dual ESM/CJS
// load of `@chelonia/lib`. The string key is namespaced
// (`@chelonia/lib/KV_NOOP`) to make a userland collision implausible.
export const KV_NOOP = Symbol.for('@chelonia/lib/KV_NOOP');
// Internal sentinel thrown by the onconflict callback when the reducer
// returns KV_NOOP. The outer catch in chelonia/kv/update checks for
// the realm-safe Symbol.for marker on the prototype (not `instanceof`)
// to remain safe across realm boundaries (dual ESM/CJS loads, iframes,
// workers). Not exported — internal to the onconflict/retry plumbing.
class KvNoopAbort extends Error {
    name = 'KvNoopAbort';
}
// Realm-safe marker: Symbol.for survives dual ESM/CJS loads.
// Checked on the catch side instead of `instanceof`.
const KV_NOOP_ABORT = Symbol.for('@chelonia/lib/KV_NOOP_ABORT');
KvNoopAbort.prototype[KV_NOOP_ABORT] = true;
// ---------------------------------------------------------------------------
// Internal helpers (pure — no SBP context required)
// ---------------------------------------------------------------------------
const registryKey = (contractType, key) => `${contractType}::${key}`;
// Stable structural stringify used for the `defineSlot` idempotence
// check. Plain `JSON.stringify` is sensitive to object key order, but
// JSON / spec-equivalence treats `{a:1,b:2}` and `{b:2,a:1}` as the
// same value — schemas that re-emit keys in a different order (e.g.
// `z.object({...}).strict()` normalising key order across parse
// passes) would otherwise falsely fail the round-trip guard at
// registration. Walks plain objects and arrays only; primitives are
// emitted verbatim and any non-plain values fall through to
// `JSON.stringify`'s default handling.
function canonicalStringify(value) {
    return JSON.stringify(value, (_key, val) => {
        if (val &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            Object.getPrototypeOf(val) === Object.prototype) {
            const sorted = {};
            for (const k of Object.keys(val).sort()) {
                sorted[k] = val[k];
            }
            return sorted;
        }
        return val;
    });
}
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
        encryptionKeyName: def.encryptionKeyName ?? 'cek',
        signingKeyName: def.signingKeyName ?? 'csk',
        defaultUpdater: def.defaultUpdater,
        autoSubscribe: def.autoSubscribe ?? true,
        autoLoad: def.autoLoad ?? 'on-sync',
        refreshOnReconnect: def.refreshOnReconnect ?? true,
        onUpdate: def.onUpdate,
        source
    };
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
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
                'async/thenable schema parser; v1 supports synchronous parsers only');
        }
        throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema must ` +
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
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} resolved ` +
                'defaultValue failed schema.parse at registration', { cause: e });
        }
        if (first && typeof first.then === 'function') {
            Promise.resolve(first).catch(() => { });
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
                'async/thenable schema parser; v1 supports synchronous parsers only');
        }
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
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema is ` +
                'not idempotent on its own parsed output (defaultValue round-trip failed)', { cause: e });
        }
        if (canonicalStringify(first) !== canonicalStringify(second)) {
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] slot ${slot.contractType}::${slot.key} schema ` +
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
        throw new ChelErrorKvValidation(`[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
            'produced a thenable; v1 supports synchronous parsers only');
    }
    if (parsed === null || parsed === undefined) {
        throw new ChelErrorKvValidation(`[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
            `schema.parse returned the reserved sentinel ${String(parsed)}; ` +
            'null and undefined are reserved for wire/clear semantics');
    }
    return parsed;
}
// Ensure `rootState._kv[contractID]` exists as a reactive object. Returns
// the per-contract record. Idempotent.
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
// Emit a `CHELONIA_KV_STATUS_CHANGED` event after writing the new status
// onto the mirror entry. Skips the emit if the status is unchanged.
function setSlotStatus(ctx, rootState, contractID, contractType, key, status, lastError) {
    const perContract = ensureContractKv(ctx, rootState, contractID);
    const entry = perContract[key];
    if (!entry)
        return;
    const previousStatus = entry.status;
    const statusUnchanged = previousStatus === status;
    // `lastErrorChanged` detects a structural difference (name or message)
    // between the new and old error objects. When both have errors with
    // identical content this is false, but we still need to distinguish
    // "both have the same error" from "neither has an error" — the
    // latter means we can skip the event entirely; the former still
    // needs reactivity updates (e.g. clearing a stale lastError).
    const lastErrorChanged = !!lastError !== !!entry.lastError ||
        (lastError && entry.lastError &&
            (lastError.name !== entry.lastError.name ||
                lastError.message !== entry.lastError.message));
    // Clear stale lastError even when status hasn't changed.
    if (!lastError && entry.lastError) {
        ctx.config.reactiveDel(entry, 'lastError');
    }
    if (lastError) {
        ctx.config.reactiveSet(entry, 'lastError', lastError);
    }
    if (statusUnchanged && !lastErrorChanged)
        return;
    if (!statusUnchanged) {
        ctx.config.reactiveSet(entry, 'status', status);
    }
    sbp('okTurtles.events/emit', CHELONIA_KV_STATUS_CHANGED, {
        contractID,
        contractType,
        key,
        status,
        previousStatus,
        ...(lastError ? { lastError } : {})
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
        throw new ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: contract ${contractID} is not synced`);
    }
    const contractType = getContractType(rootState, contractID);
    if (typeof contractType !== 'string') {
        throw new ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: contract ${contractID} has no resolved type`);
    }
    const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key);
    if (!slot) {
        throw new ChelErrorKvSlotUnknown(`[chelonia/kv] ${label}: no active slot for ${contractID}::${key}`);
    }
    return slot;
}
// 128-bit random nonce, base64-encoded. Used by `chelonia/kv/update`
// for self-echo suppression (KV-REVAMPED §4.9). Collision between
// independent writers is cryptographically negligible at this width,
// so a remote write can never be misclassified as a local echo.
function base64Nonce() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let bin = '';
    for (let i = 0; i < 16; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
// Unwrap a `{ __chelKvNonce, value }` envelope, returning both the
// extracted nonce (if present) and the inner value. Raw-API writers
// may not wrap, so fall back to the data verbatim — same tolerance
// across `_loadSlot`, `_handleRemote`, and `onconflict`.
//
// NOTE: the shape `{ __chelKvNonce: string, value: any }` is a reserved
// wrapper shape used internally by the KV slot API for self-echo
// suppression (§4.9). Consumer values that happen to match this shape
// will be treated as an internal wrapper — the `__chelKvNonce` field
// will be stripped and `value` extracted. Avoid using `__chelKvNonce`
// as a top-level key in slot values.
function unwrapData(data) {
    if (data !== null &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        '__chelKvNonce' in data &&
        typeof data.__chelKvNonce === 'string' &&
        'value' in data) {
        const wrapper = data;
        return { nonce: wrapper.__chelKvNonce, value: wrapper.value };
    }
    return { nonce: undefined, value: data };
}
// Push a nonce onto the per-(contractID, key) FIFO, trimming to at
// most 8 entries (KV-REVAMPED §4.9 step 2). The cap is enough to
// absorb bursts of concurrent local writes without unbounded growth.
function recordEchoNonce(ctx, contractID, key, nonce) {
    const echoKey = `${contractID}::${key}`;
    let fifo = ctx.kvLocalEchoNonces.get(echoKey);
    if (!fifo) {
        fifo = [];
        ctx.kvLocalEchoNonces.set(echoKey, fifo);
    }
    fifo.push(nonce);
    while (fifo.length > 8)
        fifo.shift();
}
// Remove specific nonces from the per-(contractID, key) FIFO.
// Used on write-failure paths to prevent stale nonces from suppressing
// pubsub echoes that should update the mirror.
function removeEchoNonces(ctx, contractID, key, nonces) {
    if (nonces.length === 0)
        return;
    const echoKey = `${contractID}::${key}`;
    const fifo = ctx.kvLocalEchoNonces.get(echoKey);
    if (!fifo)
        return;
    for (const n of nonces) {
        const idx = fifo.indexOf(n);
        if (idx >= 0)
            fifo.splice(idx, 1);
    }
    if (fifo.length === 0)
        ctx.kvLocalEchoNonces.delete(echoKey);
}
// Invoke `onUpdate` with the dispatcher's MUST-NOT-throw contract:
// both synchronous throws and rejected promises are caught and logged.
// See KV-REVAMPED §4.1.
async function safeOnUpdate(slot, value, ctx) {
    if (!slot.onUpdate)
        return;
    try {
        const ret = slot.onUpdate(value, ctx);
        if (ret && typeof ret.then === 'function') {
            await ret;
        }
    }
    catch (e) {
        console.error(`[chelonia/kv] onUpdate threw for ${ctx.contractID}::${ctx.key}`, e);
    }
}
// ---------------------------------------------------------------------------
// Filter-flush coalescing (KV-REVAMPED §11.5)
// ---------------------------------------------------------------------------
// One `setFilter` frame per (contract, microtask) — even if N slots
// reconcile in the same tick. The flush snapshots
// `kvActiveFilters[cID]` at flush time, so any subsequent in-tick
// mutation is naturally folded into the single emitted frame.
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
    const dirty = Array.from(ctx.kvFilterDirty);
    ctx.kvFilterDirty.clear();
    for (const cID of dirty) {
        const active = ctx.kvActiveFilters.get(cID);
        try {
            await sbp('chelonia/kv/setFilter', cID, active ? [...active] : []);
        }
        catch (e) {
            console.warn(`[chelonia/kv] setFilter flush failed for ${cID}`, e);
        }
    }
}
export default sbp('sbp/selectors/register', {
    // Dev-time invariant check. See KV-REVAMPED.md §11.2 ("Index
    // invariant"). Walks the four KV maps + `rootState._kv` and verifies:
    //
    //   kvSlotsByContractID[cID].has(key) ⇔
    //     (a) kvSlots has a registration for `${contractType}::${key}` whose
    //         contractType matches rootState.contracts[cID]._vm.type, AND
    //     (b) cID ∈ subscriptionSet, AND
    //     (c) kvActiveFilters[cID].has(key).
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
        const rootState = sbp(this.config.stateSelector);
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
        sbp('chelonia/kv/_defineSlotInternal', def, { kind: 'defineSlot' });
    },
    // Private. The actual `defineSlot` implementation. Accepts an
    // explicit `source` so `_registerContractSlots` can mark slots as
    // manifest-owned for `_cleanupContractSlots` to scope removals
    // correctly. Not re-exported; not callable from userland through
    // typed APIs.
    'chelonia/kv/_defineSlotInternal': function (def, source) {
        if (!def || typeof def !== 'object') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid definition');
        }
        if (typeof def.key !== 'string' || def.key.length === 0) {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid key');
        }
        const types = Array.isArray(def.contractType) ? def.contractType : [def.contractType];
        if (types.length === 0) {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: contractType required');
        }
        // Runtime validation of optional fields (SBP selectors are callable
        // from JavaScript without TypeScript enforcement).
        if (def.match != null && typeof def.match !== 'function') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: match must be a function');
        }
        if (def.schema != null && (typeof def.schema.parse !== 'function')) {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: schema must have a parse method');
        }
        if (def.defaultUpdater != null && typeof def.defaultUpdater !== 'function') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultUpdater must be a function');
        }
        if (def.onUpdate != null && typeof def.onUpdate !== 'function') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: onUpdate must be a function');
        }
        if (def.autoLoad != null &&
            def.autoLoad !== 'on-sync' && def.autoLoad !== 'on-demand' && def.autoLoad !== 'never') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: autoLoad must be one of "on-sync", "on-demand", "never"');
        }
        if (def.encryptionKeyName != null && typeof def.encryptionKeyName !== 'string') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: encryptionKeyName must be a string');
        }
        if (def.signingKeyName != null && typeof def.signingKeyName !== 'string') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: signingKeyName must be a string');
        }
        if (def.autoSubscribe != null && typeof def.autoSubscribe !== 'boolean') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: autoSubscribe must be a boolean');
        }
        if (def.refreshOnReconnect != null && typeof def.refreshOnReconnect !== 'boolean') {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: refreshOnReconnect must be a boolean');
        }
        for (const contractType of types) {
            if (typeof contractType !== 'string' || contractType.length === 0) {
                throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid contractType');
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
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultValue factory threw', { cause: e });
        }
        if (rawDefault === null) {
            throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultValue may not be null; ' +
                'null is the reserved wire clear sentinel');
        }
        // Reject defaultValue with the reserved { __chelKvNonce, value }
        // top-level shape. `unwrapData` strips this envelope on read, so a
        // consumer storing { __chelKvNonce, value } would silently lose the
        // outer object. This check runs unconditionally (not gated on schema)
        // so schemaless slots are also protected.
        if (rawDefault !== undefined &&
            rawDefault !== null &&
            typeof rawDefault === 'object' &&
            !Array.isArray(rawDefault) &&
            '__chelKvNonce' in rawDefault &&
            'value' in rawDefault) {
            throw new ChelErrorKvSlotInvalid(`[chelonia/kv] defineSlot: defaultValue for key '${def.key}' ` +
                'has the reserved shape { __chelKvNonce, value }; this top-level ' +
                'key combination is reserved for internal use');
        }
        const resolvedDefault = rawDefault === undefined ? undefined : cloneDeep(rawDefault);
        // Run the schema guards once on a probe slot regardless of how many
        // contract types are listed. The guards parse `resolvedDefault` up
        // to four times (two sentinel probes + a two-step idempotence
        // round-trip), so the per-type loop below would otherwise multiply
        // that work by N and produce N sibling slots sharing the same
        // post-parse `resolvedDefault` object identity — a fragile invariant
        // if anything ever mutates `resolvedDefault` in place. Cloning
        // per-type keeps each slot independent.
        let postParseDefault = resolvedDefault;
        if (def.schema && resolvedDefault !== undefined) {
            const probe = resolveSlotDefinition(def, types[0], resolvedDefault, source);
            assertSchemaGuards(probe);
            postParseDefault = probe.resolvedDefault;
        }
        else {
            // No schema (or no resolved default) → guards are pure checks on
            // the schema itself; run once with the first type.
            const probe = resolveSlotDefinition(def, types[0], resolvedDefault, source);
            assertSchemaGuards(probe);
        }
        for (const contractType of types) {
            const perTypeDefault = postParseDefault === undefined ? undefined : cloneDeep(postParseDefault);
            const slot = resolveSlotDefinition(def, contractType, perTypeDefault, source);
            const rKey = registryKey(contractType, def.key);
            const previous = this.kvSlots.get(rKey);
            this.kvSlots.set(rKey, slot);
            // Walk every synced contract whose type matches and reconcile.
            // This both wires up newly-eligible contracts and re-validates
            // persisted mirror entries when `previous` exists (§4.1
            // "Cached-value re-validation on slot replacement").
            const rootState = sbp(this.config.stateSelector);
            for (const cID of this.subscriptionSet) {
                const meta = rootState.contracts?.[cID];
                if (!meta || getContractType(rootState, cID) !== contractType)
                    continue;
                // If a previous definition existed and the contract was
                // already in the index under it, the index entry has to be
                // refreshed to point at the new slot object before
                // `_reconcileForSlot` runs (the invariant check otherwise
                // trips on `registered !== slot`).
                if (previous) {
                    const perKey = this.kvSlotsByContractID.get(cID);
                    if (perKey && perKey.get(def.key) === previous) {
                        perKey.set(def.key, slot);
                    }
                }
                sbp('chelonia/kv/_reconcileForSlot', slot, cID);
                // Re-validate any persisted mirror entry against the new
                // schema *after* reconcile so the index invariant holds;
                // gate on the slot still being registered (reconcile may
                // have removed it if the contract was released or the match
                // filter changed). Surface failures via status/event but
                // keep the old value (§4.1).
                if (previous && this.kvSlotsByContractID.get(cID)?.get(def.key) === slot) {
                    revalidateMirrorEntry(this, rootState, cID, slot);
                }
            }
            // Also re-validate persisted mirror entries for contracts not
            // currently in subscriptionSet (e.g. not yet re-synced after a
            // reload). §4.1 requires re-validating *every* persisted entry,
            // not just those for currently-synced contracts. Skip entries
            // whose contract type cannot be confirmed to match — re-validating
            // against the wrong slot type would spuriously flip foreign
            // entries to 'error'.
            if (previous && rootState._kv) {
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
    // Private. See KV-REVAMPED §11.3 step 2. Maintains the index
    // invariant (§11.2) and schedules `autoLoad: 'on-sync'` fetches.
    'chelonia/kv/_reconcileForSlot': function (slot, contractID) {
        if (!this.subscriptionSet.has(contractID))
            return;
        const rootState = sbp(this.config.stateSelector);
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
            if (!filter) {
                filter = new Set();
                this.kvActiveFilters.set(contractID, filter);
            }
            if (slot.autoSubscribe && !filter.has(slot.key)) {
                filter.add(slot.key);
                queueFilterFlush(this, contractID);
            }
            else if (!slot.autoSubscribe && filter.has(slot.key)) {
                filter.delete(slot.key);
                queueFilterFlush(this, contractID);
            }
            // Seed the mirror entry as 'non-init' if absent so consumers
            // can observe the slot before the first load resolves.
            const perContract = ensureContractKv(this, rootState, contractID);
            if (!perContract[slot.key]) {
                this.config.reactiveSet(perContract, slot.key, {
                    value: undefined,
                    etag: null,
                    status: 'non-init'
                });
            }
            // Schedule a load. The actual fetch is serialised against
            // updates via the per-contract queueInvocation lane.
            if (!wasActive && slot.autoLoad === 'on-sync') {
                // Fire-and-forget — _loadSlot manages its own status events
                // and never throws out of its body.
                sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
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
                if (perKey.size === 0)
                    this.kvSlotsByContractID.delete(contractID);
                const filter = this.kvActiveFilters.get(contractID);
                if (filter?.has(slot.key)) {
                    filter.delete(slot.key);
                    queueFilterFlush(this, contractID);
                }
            }
            const perContract = rootState._kv?.[contractID];
            if (perContract && perContract[slot.key]) {
                this.config.reactiveDel(perContract, slot.key);
            }
        }
    },
    // Private. See KV-REVAMPED §11.3 step 3. Fetches via
    // `chelonia/kv/get`, unwraps the `{ __chelKvNonce, value }`
    // envelope, validates, and writes the mirror. Routes the fetch
    // through `chelonia/queueInvocation` keyed on `contractID` so it
    // serialises against in-flight `chelonia/kv/update` writes.
    'chelonia/kv/_loadSlot': function ({ contractID, slot, reason }) {
        return sbp('chelonia/queueInvocation', contractID, async () => {
            const rootState = sbp(this.config.stateSelector);
            // The contract may have been released between scheduling and
            // running — bail out cleanly.
            if (!this.subscriptionSet.has(contractID))
                return;
            const perContract = ensureContractKv(this, rootState, contractID);
            if (!perContract[slot.key]) {
                // Reconcile dropped the entry while we were queued.
                return;
            }
            const priorStatus = perContract[slot.key]?.status;
            setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'loading');
            let parsed;
            try {
                parsed = await sbp('chelonia/kv/get', contractID, slot.key);
            }
            catch (e) {
                const lastError = normalizeError(e);
                setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'error', lastError);
                throw e;
            }
            if (parsed === null) {
                // Staleness guard (symmetric with the non-null path below):
                // if `defineSlot` replaced this slot while the GET was in
                // flight, bail out before mutating the mirror.
                if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
                    const currentEntry = perContract[slot.key];
                    if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
                        setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus);
                    }
                    return;
                }
                // 404 — key not yet written (or deleted server-side). Reset
                // the mirror to the declared default state (`value: undefined`,
                // `etag: null`) and surface `'non-init'` rather than `'loaded'`
                // (§4.3). If the slot previously held a value, emit
                // `CHELONIA_KV_UPDATED` so consumers observe the transition.
                // The event payload carries the *resolved default* (cloned)
                // — not `undefined` — so consumers (and the externalState
                // projection) see the value `read` will subsequently return
                // (§4.5 / §4.9). The mirror itself keeps `value: undefined`
                // so the `'non-init'` status remains observable via `read`'s
                // default-substitution path.
                const existingEntry = perContract[slot.key];
                let previousValue;
                if (existingEntry) {
                    previousValue = existingEntry.value;
                    this.config.reactiveSet(existingEntry, 'value', undefined);
                    this.config.reactiveSet(existingEntry, 'etag', null);
                    if (previousValue !== undefined) {
                        const defaultedValue = slot.resolvedDefault !== undefined
                            ? cloneDeep(slot.resolvedDefault)
                            : undefined;
                        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
                            contractID,
                            contractType: slot.contractType,
                            key: slot.key,
                            value: defaultedValue,
                            previousValue,
                            reason,
                            etag: null
                        });
                    }
                }
                // Transition to 'non-init' before onUpdate (matching the
                // success-path sequencing of setSlotStatus → safeOnUpdate).
                setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'non-init');
                if (existingEntry && previousValue !== undefined) {
                    const defaultedValue = slot.resolvedDefault !== undefined
                        ? cloneDeep(slot.resolvedDefault)
                        : undefined;
                    await safeOnUpdate(slot, defaultedValue, {
                        contractID,
                        contractType: slot.contractType,
                        key: slot.key,
                        reason,
                        etag: null,
                        previousValue
                    });
                }
                return;
            }
            // Unwrap the `{ __chelKvNonce, value }` envelope written by
            // `chelonia/kv/update` / `chelonia/kv/clear`. For backwards
            // compatibility with raw-API writers that don't wrap, fall
            // back to `parsed.data` itself.
            const { value: unwrapped } = unwrapData(parsed.data);
            // Capture the etag from the GET response before any await point.
            const getEtag = parsed.etag ?? null;
            // Staleness guard: if `defineSlot` replaced this slot while the
            // fetch was in flight, the captured `slot` object is stale — its
            // schema / defaults / callbacks no longer match the registry.
            // Restore the prior status so the slot doesn't remain stuck at
            // 'loading' (the replacement slot will manage its own lifecycle).
            if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
                const currentEntry = perContract[slot.key];
                if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
                    setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus);
                }
                return;
            }
            const entry = perContract[slot.key];
            const previousValue = entry?.value;
            // Wire `null` is the clear sentinel — skip schema.parse and
            // restore the deep-cloned default.
            const wasClear = unwrapped === null;
            let nextValue;
            if (wasClear) {
                nextValue = slot.resolvedDefault !== undefined
                    ? cloneDeep(slot.resolvedDefault)
                    : undefined;
            }
            else if (slot.schema) {
                try {
                    nextValue = parseSyncSlotValue(slot, unwrapped, `load ${contractID}::${slot.key}`);
                }
                catch (e) {
                    sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
                        contractID,
                        contractType: slot.contractType,
                        key: slot.key,
                        error: e,
                        reason
                    });
                    setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'error', normalizeError(e));
                    throw new ChelErrorKvValidation(`[chelonia/kv] load: ${contractID}::${slot.key} validation failed`, { cause: e });
                }
            }
            else {
                nextValue = unwrapped;
            }
            // Write mirror — entry definitely exists (we seeded it
            // upstream and bail out if reconcile dropped it).
            this.config.reactiveSet(entry, 'value', nextValue);
            this.config.reactiveSet(entry, 'etag', getEtag);
            sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
                contractID,
                contractType: slot.contractType,
                key: slot.key,
                value: nextValue,
                previousValue,
                reason,
                etag: getEtag
            });
            setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, wasClear ? 'non-init' : 'loaded');
            await safeOnUpdate(slot, nextValue, {
                contractID,
                contractType: slot.contractType,
                key: slot.key,
                reason,
                etag: getEtag,
                previousValue
            });
        });
    },
    // Private listener for CONTRACTS_MODIFIED. Mounted from
    // `chelonia/_init` (see chelonia.ts) so that newly-synced
    // contracts automatically wire up every matching slot, and
    // removed contracts have their per-contract KV runtime state
    // cleaned up (KV-REVAMPED §11.4).
    'chelonia/kv/_onContractsModified': function ({ added, removed }) {
        if (added && added.length > 0) {
            const rootState = sbp(this.config.stateSelector);
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
                    sbp('chelonia/kv/_reconcileForSlot', slot, cID);
                }
            }
        }
        if (removed && removed.length > 0) {
            for (const cID of removed) {
                sbp('chelonia/kv/_cleanupContractRuntime', cID);
            }
        }
    },
    // Private. See KV-REVAMPED §11.4 (contract-release / unsubscribe path).
    // Clears per-contract KV runtime state for `contractID`: removes
    // `rootState._kv[contractID]`, `kvSlotsByContractID[contractID]`,
    // `kvActiveFilters[contractID]`, and schedules an empty-filter
    // `setFilter` flush. The `kvFilterDirty` mark is intentionally
    // retained until the microtask fires so the flush sees this
    // contract in the dirty set. Keeps long-lived sessions from
    // accumulating stale mirror entries after refcount goes to zero.
    'chelonia/kv/_cleanupContractRuntime': function (contractID) {
        // Queue a filter flush for this contract *before* dropping state so
        // the server receives the empty-filter frame (§11.5 empty
        // transitions). The flush reads kvActiveFilters at microtask time,
        // so removing the entry below won't affect the emitted filter.
        // We intentionally do NOT delete from kvFilterDirty here — the
        // microtask must see this contract in the dirty set to send the
        // empty-filter frame.
        queueFilterFlush(this, contractID);
        this.kvSlotsByContractID.delete(contractID);
        this.kvActiveFilters.delete(contractID);
        this.kvLocalEchoNonces.forEach((_fifo, key) => {
            if (key.startsWith(`${contractID}::`)) {
                this.kvLocalEchoNonces.delete(key);
            }
        });
        const rootState = sbp(this.config.stateSelector);
        if (rootState._kv && rootState._kv[contractID]) {
            this.config.reactiveDel(rootState._kv, contractID);
        }
    },
    // Private. See KV-REVAMPED §11.4 bullet 3 (reconnect hook).
    // Called from the pubsub reconnect path after re-subscription frames
    // are sent. Clears pending local echo nonces (any echo from a
    // pre-disconnect write has either been delivered or is lost) and
    // re-fetches every active slot with `refreshOnReconnect === true`
    // through the per-contract queueInvocation lane so reconnect fetches
    // are serialized with in-flight writes.
    'chelonia/kv/_onReconnect': function () {
        this.kvLocalEchoNonces.clear();
        for (const [cID, perKey] of this.kvSlotsByContractID) {
            for (const [, slot] of perKey) {
                if (slot.refreshOnReconnect) {
                    sbp('chelonia/kv/_loadSlot', { contractID: cID, slot, reason: 'reconnect' })
                        .catch((e) => {
                        console.error(`[chelonia/kv] _loadSlot (reconnect) rejected for ${cID}::${slot.key}`, e);
                    });
                }
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
    //     and the legacy raw API still runs through the existing
    //     callback path. No regression.
    //   - Read `__chelKvNonce` off the parsed wrapper; if it matches an
    //     entry in `kvLocalEchoNonces[${cID}::${key}]`, drop the frame
    //     silently (self-echo suppression — §4.9) and remove the nonce
    //     from the FIFO.
    //   - Strip the nonce field before further processing so it never
    //     reaches `schema.parse`, the mirror, the event payload, or
    //     `onUpdate`.
    //   - Wire `null` (after unwrap) is the clear sentinel — write the
    //     deep-cloned `resolvedDefault` without running `schema.parse`.
    //   - On schema validation failure: **keep** the previous mirror
    //     `value`, flip `status: 'error'`, set `lastError`, fire
    //     `CHELONIA_KV_VALIDATION_ERROR` and `CHELONIA_KV_STATUS_CHANGED`.
    //     Never throw out of the dispatch path.
    'chelonia/kv/_handleRemote': function (contractID, key, parsed) {
        const perKey = this.kvSlotsByContractID.get(contractID);
        const slot = perKey?.get(key);
        if (!slot)
            return Promise.resolve();
        // Unwrap `{ __chelKvNonce, value }` envelope, with raw-API
        // tolerance (mirrors the `_loadSlot` unwrap shape).
        const { nonce, value: unwrapped } = unwrapData(parsed?.data);
        // Self-echo suppression: if the nonce matches a pending local
        // write, drop the frame and pop the FIFO entry.
        if (nonce) {
            const echoKey = `${contractID}::${key}`;
            const fifo = this.kvLocalEchoNonces.get(echoKey);
            if (fifo) {
                const idx = fifo.indexOf(nonce);
                if (idx >= 0) {
                    fifo.splice(idx, 1);
                    if (fifo.length === 0)
                        this.kvLocalEchoNonces.delete(echoKey);
                    return Promise.resolve();
                }
            }
        }
        const rootState = sbp(this.config.stateSelector);
        const perContract = ensureContractKv(this, rootState, contractID);
        const entry = perContract[key];
        if (!entry) {
            // Reconcile dropped the mirror entry — nothing to write into.
            return Promise.resolve();
        }
        const previousValue = entry.value;
        // Wire `null` is the clear sentinel — skip schema.parse and
        // restore the deep-cloned default.
        let nextValue;
        if (unwrapped === null) {
            nextValue = slot.resolvedDefault !== undefined
                ? cloneDeep(slot.resolvedDefault)
                : undefined;
        }
        else if (slot.schema) {
            try {
                nextValue = parseSyncSlotValue(slot, unwrapped, `remote ${contractID}::${key}`);
            }
            catch (e) {
                sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
                    contractID,
                    contractType: slot.contractType,
                    key,
                    error: e,
                    reason: 'remote'
                });
                setSlotStatus(this, rootState, contractID, slot.contractType, key, 'error', normalizeError(e));
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
            nextValue = unwrapped;
        }
        this.config.reactiveSet(entry, 'value', nextValue);
        // Pubsub frames carry no etag — null it out so the next local
        // write doesn't send a stale `if-match` (§4.9).
        this.config.reactiveSet(entry, 'etag', null);
        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
            contractID,
            contractType: slot.contractType,
            key,
            value: nextValue,
            previousValue,
            reason: 'remote',
            etag: null
        });
        // A remote clear (unwrapped === null) transitions to 'non-init',
        // matching local clear semantics (§4.5). A successful remote update
        // always calls setSlotStatus('loaded') so that any stale `lastError`
        // is cleared (setSlotStatus internally skips the event when both
        // status and lastError are unchanged).
        if (unwrapped === null) {
            setSlotStatus(this, rootState, contractID, slot.contractType, key, 'non-init');
        }
        else {
            setSlotStatus(this, rootState, contractID, slot.contractType, key, 'loaded');
        }
        return safeOnUpdate(slot, nextValue, {
            contractID,
            contractType: slot.contractType,
            key,
            reason: 'remote',
            etag: null,
            previousValue
        });
    },
    // Public. See KV-REVAMPED §4.2, §11.3 step 5. The ergonomic write
    // path: resolves the slot, runs the reducer, validates, wraps with
    // a self-echo nonce, and writes via `chelonia/kv/queuedSet` (which
    // serialises writes per-contract through the same queueInvocation
    // lane used by `_handleRemote`).
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
    //   - other errors propagated verbatim from `chelonia/kv/queuedSet`
    //     for non-409/412 HTTP failures (5xx, offline). `status` is
    //     NOT flipped to `'error'` (that state is reserved for load
    //     failures — §4.9).
    'chelonia/kv/update': async function (args) {
        const { contractID, key, updater, value, maxAttempts, signal, ifMatch } = args;
        // ----- Step 1: resolve the slot via active index. -----
        const rootState = sbp(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'update');
        // ----- Step 1a: normalise the write input (synchronous). -----
        // Property-presence checks per §4.2: "Exactly one of `updater` or
        // `value` must be provided" discriminates on which channel the
        // caller chose, not on the runtime value (so `value: undefined`
        // counts as "value was provided").
        const hasUpdater = has(args, 'updater');
        const hasValue = has(args, 'value');
        if (hasUpdater && hasValue) {
            throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
                'of `updater` or `value` (both were provided)');
        }
        if (!hasUpdater && !hasValue) {
            throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
                'of `updater` or `value` (neither was provided)');
        }
        if (hasUpdater && typeof updater !== 'function') {
            throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — \`updater\` was ` +
                'provided but is not a function');
        }
        let reducer;
        if (hasUpdater) {
            reducer = updater;
        }
        else {
            if (!slot.defaultUpdater) {
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — \`value\` was ` +
                    'provided but the slot has no `defaultUpdater`');
            }
            // Synthesise the reducer once — the same closure is re-invoked
            // on conflict retries (§4.2 step 1a).
            let factoryOut;
            try {
                factoryOut = slot.defaultUpdater(value);
            }
            catch (e) {
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
                    'factory threw', { cause: e });
            }
            if (typeof factoryOut !== 'function') {
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
                    'did not return a function');
            }
            reducer = factoryOut;
        }
        // Honour a pre-aborted signal before touching the network.
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Aborted', 'AbortError');
        }
        // The mirror read, reducer, and network write must all run inside the
        // per-contract serial queue so that each write sees the etag left by
        // the preceding one. Reading the mirror outside the queue means
        // concurrent calls all snapshot the same stale etag → guaranteed 412
        // → ONCONFLICT thrashing.
        return sbp('chelonia/queueInvocation', contractID, async () => {
            // Re-read rootState inside the queue for fresh mirror state.
            const liveState = sbp(this.config.stateSelector);
            // ----- Step 2: read current mirror value. -----
            const perContract = ensureContractKv(this, liveState, contractID);
            const mirrorEntry = perContract[key];
            const seedValue = mirrorEntry?.value !== undefined
                ? cloneDeep(mirrorEntry.value)
                : slot.resolvedDefault !== undefined
                    ? cloneDeep(slot.resolvedDefault)
                    : undefined;
            // ----- Step 3: run reducer and validate. -----
            let reducerOut;
            try {
                reducerOut = reducer(seedValue);
            }
            catch (e) {
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer threw`, { cause: e });
            }
            if (typeof reducerOut === 'symbol') {
                if (reducerOut === KV_NOOP)
                    return undefined;
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                    'an unexpected symbol; use KV_NOOP to abort');
            }
            if (reducerOut === null || reducerOut === undefined) {
                // Reducer may not produce the reserved wire sentinels; clear
                // is its own selector (§4.5). This is a caller-contract
                // violation (reducer shape), not a schema failure, so the
                // taxonomy bucket is ChelErrorKvUpdateInvalid (§4.6).
                throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                    `${String(reducerOut)}; use chelonia/kv/clear or KV_NOOP instead`);
            }
            let nextValue = reducerOut;
            if (slot.schema) {
                try {
                    nextValue = parseSyncSlotValue(slot, nextValue, `update ${contractID}::${key}`);
                }
                catch (e) {
                    throw new ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                        'failed schema.parse', { cause: e });
                }
            }
            // ----- Step 5: nonce + wrap + kv/set with onconflict. -----
            const attemptNonces = [];
            const firstNonce = base64Nonce();
            attemptNonces.push(firstNonce);
            recordEchoNonce(this, contractID, key, firstNonce);
            let lastCurrentData;
            let lastEtag;
            const onconflict = async ({ currentData, etag }) => {
                lastEtag = etag;
                if (signal?.aborted) {
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException('Aborted', 'AbortError');
                }
                let basis;
                if (currentData === undefined) {
                    basis = slot.resolvedDefault !== undefined
                        ? cloneDeep(slot.resolvedDefault)
                        : undefined;
                }
                else {
                    const { value: unwrapped } = unwrapData(currentData);
                    if (unwrapped === null) {
                        basis = slot.resolvedDefault !== undefined
                            ? cloneDeep(slot.resolvedDefault)
                            : undefined;
                    }
                    else if (slot.schema) {
                        try {
                            basis = parseSyncSlotValue(slot, unwrapped, `update onconflict currentData ${contractID}::${key}`);
                        }
                        catch (e) {
                            throw new ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} server ` +
                                'currentData failed schema.parse on conflict retry', { cause: e });
                        }
                    }
                    else {
                        basis = unwrapped;
                    }
                }
                lastCurrentData = basis;
                let retried;
                try {
                    retried = reducer(basis);
                }
                catch (e) {
                    throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer threw on retry`, { cause: e });
                }
                if (typeof retried === 'symbol') {
                    if (retried === KV_NOOP) {
                        throw new KvNoopAbort();
                    }
                    throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                        'an unexpected symbol on retry; use KV_NOOP to abort');
                }
                if (retried === null || retried === undefined) {
                    throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
                        `${String(retried)} on retry; use KV_NOOP instead`);
                }
                let validated = retried;
                if (slot.schema) {
                    try {
                        validated = parseSyncSlotValue(slot, retried, `update onconflict retry ${contractID}::${key}`);
                    }
                    catch (e) {
                        throw new ChelErrorKvValidation(`[chelonia/kv] update: ${contractID}::${key} reducer output ` +
                            'failed schema.parse on conflict retry', { cause: e });
                    }
                }
                // Each retry gets a fresh nonce so the eventual pubsub echo of
                // *this* attempt is suppressed; the FIFO cap (8) reaps stale
                // ones automatically. `nextValue` tracks the latest accepted
                // reducer output — what we ultimately mirror on success.
                nextValue = validated;
                const nonce = base64Nonce();
                attemptNonces.push(nonce);
                recordEchoNonce(this, contractID, key, nonce);
                return [{ __chelKvNonce: nonce, value: validated }, typeof etag === 'string' ? etag : undefined];
            };
            const mirrorEtag = mirrorEntry?.etag ?? undefined;
            let setResult;
            try {
                // Call chelonia/kv/set directly (not via queuedSet) since we are
                // already inside the per-contract serial queue. Resolving key IDs
                // here (not at call-site) ensures key rotation mid-queue is seen.
                setResult = await sbp('chelonia/kv/set', contractID, key, { __chelKvNonce: firstNonce, value: nextValue }, {
                    ifMatch: ifMatch ?? mirrorEtag,
                    encryptionKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName),
                    signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName),
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
                if (e && typeof e === 'object' && KV_NOOP_ABORT in e) {
                    removeEchoNonces(this, contractID, key, attemptNonces);
                    return undefined;
                }
                // Map the lower-level conflict-exhaustion Error to the public
                // taxonomy (§4.2 step 6 / rejection table).
                if (e instanceof ChelErrorKvMaxAttempts) {
                    removeEchoNonces(this, contractID, key, attemptNonces);
                    throw new ChelErrorKvConflict(`[chelonia/kv] update: ${contractID}::${key} ran out of attempts ` +
                        'resolving conflicts', { cause: { currentData: lastCurrentData, etag: lastEtag ?? null } });
                }
                // Network / HTTP error. The server may have accepted the write
                // (ambiguous failure), but since the mirror was not updated
                // locally, removing the nonces lets any pubsub echo reconcile
                // the mirror as reason: 'remote' rather than being silently
                // suppressed.
                removeEchoNonces(this, contractID, key, attemptNonces);
                throw e;
            }
            // ----- Step 6: write mirror + emit events. -----
            // Post-write abort guard: the network write succeeded, but the
            // caller's signal was aborted between dispatch and resolution.
            // The spec (§4.2) requires the mirror to remain unchanged and no
            // event to fire. Remove only this call's nonces so the pubsub echo
            // is not suppressed for this write — it will reconcile the mirror
            // as reason: 'remote' — without corrupting a concurrent write's
            // echo suppression.
            if (signal?.aborted) {
                removeEchoNonces(this, contractID, key, attemptNonces);
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Aborted', 'AbortError');
            }
            // Staleness guard: if `defineSlot` replaced this slot while the
            // network write was in flight, the captured `slot` object is stale.
            // The network write succeeded against the *old* slot's keys/config,
            // but the mirror and events must reflect the *current* slot. Bail
            // out and let the new slot's reconcile pass handle the state.
            // Resolve with `undefined` (matching the symmetric `clear` staleness
            // path): the reducer's output was *not* written to the mirror under
            // the new slot, so returning `nextValue` would mislead the caller
            // into treating an unstored value as canonical.
            if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
                return undefined;
            }
            const perContractAfter = ensureContractKv(this, liveState, contractID);
            const entryAfter = perContractAfter[key];
            const previousValue = entryAfter?.value;
            if (!entryAfter) {
                // Reconcile dropped the slot mid-write — nothing to mirror into.
                // Same rationale as the staleness path above: the value was not
                // written to a live mirror entry, so resolve with `undefined`
                // rather than misleading the caller with an unstored value.
                return undefined;
            }
            this.config.reactiveSet(entryAfter, 'value', nextValue);
            this.config.reactiveSet(entryAfter, 'etag', setResult.etag);
            sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
                contractID,
                contractType: slot.contractType,
                key,
                value: nextValue,
                previousValue,
                reason: 'local',
                etag: setResult.etag
            });
            if (entryAfter.status !== 'loaded') {
                setSlotStatus(this, liveState, contractID, slot.contractType, key, 'loaded');
            }
            await safeOnUpdate(slot, nextValue, {
                contractID,
                contractType: slot.contractType,
                key,
                reason: 'local',
                etag: setResult.etag,
                previousValue
            });
            return nextValue;
        });
    },
    // Public. See KV-REVAMPED §4.3. Synchronous mirror read.
    //
    // Two-step slot resolution (same as `update`) — throws
    // `ChelErrorKvSlotUnknown` if the contract isn't synced or the slot
    // isn't registered for the resolved `(contractType, key)` pair.
    // Substitutes a deep-cloned `resolvedDefault` when the mirror entry
    // is absent or `value === undefined` (the "non-init" representation
    // — see the note in §4.3). Returned value is the cloned default,
    // or `undefined` if the slot has no `defaultValue` and the mirror
    // is empty.
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
        const rootState = sbp(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'read');
        const entry = rootState._kv?.[contractID]?.[key];
        if (!entry || entry.value === undefined) {
            return slot.resolvedDefault !== undefined
                ? cloneDeep(slot.resolvedDefault)
                : undefined;
        }
        const v = entry.value;
        return (v === null || typeof v !== 'object') ? v : cloneDeep(v);
    },
    // Public. See KV-REVAMPED §4.4. Force-fetch a slot (or every active
    // slot for a contract) and refresh the mirror.
    //
    // Single-slot form (with `key`) — rejects on slot failure, matching
    // the rejection semantics of `chelonia/kv/update`.
    //
    // Aggregate form (no `key`) — fans out across every entry in
    // `kvSlotsByContractID[contractID]` concurrently; per-slot failures
    // surface via the slot's `status` (and the
    // `CHELONIA_KV_STATUS_CHANGED` / `CHELONIA_KV_VALIDATION_ERROR`
    // events emitted from inside `_loadSlot`). The aggregate promise
    // resolves once every individual `_loadSlot` settles, regardless of
    // outcome.
    'chelonia/kv/sync': async function (contractID, key) {
        const rootState = sbp(this.config.stateSelector);
        if (key !== undefined) {
            const slot = resolveActiveSlot(this, rootState, contractID, key, 'sync');
            // _loadSlot throws on failure (preserving original error type
            // and cause) while still updating the slot's status. Let the
            // error propagate for the single-slot rejection semantics.
            await sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' });
            return;
        }
        // Aggregate form — per §4.4 the aggregate form never rejects.
        // If the contract isn't synced there are no active slots to
        // refresh, so return early silently.
        const contractMeta = rootState.contracts?.[contractID];
        if (!contractMeta || !this.subscriptionSet.has(contractID)) {
            return;
        }
        // Fan out across every currently-active slot for this contract.
        // Per-slot failures are caught by the `.catch()` below and
        // surfaced via the slot's status/events, so `Promise.all`
        // resolves once every load settles regardless of individual
        // outcomes.
        const perKey = this.kvSlotsByContractID.get(contractID);
        if (!perKey || perKey.size === 0)
            return;
        const slots = Array.from(perKey.values());
        await Promise.all(slots.map((slot) => sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
            // Per §4.4 the aggregate form never rejects. Per-slot failures
            // are the single source of truth for sync errors and are
            // surfaced through the slot's status/lastError and the
            // `CHELONIA_KV_STATUS_CHANGED` / `CHELONIA_KV_VALIDATION_ERROR`
            // events emitted from inside `_loadSlot` — listen to those
            // rather than relying on console output.
            .catch(() => { })));
    },
    // Public. See KV-REVAMPED §4.5. Resets a slot to its declared
    // default by writing the wrapper `{ __chelKvNonce, value: null }`
    // through the per-contract serial queue via `chelonia/kv/set`. The inner
    // `value: null` is the wire-level clear sentinel; `_handleRemote`
    // on other clients maps it back to the declared default before
    // any `schema.parse`.
    //
    // Local-side behaviour after the network write resolves:
    //   - mirror.value ← cloneDeep(slot.resolvedDefault)
    //   - mirror.etag  ← setResult.etag
    //   - status       ← 'non-init'
    //   - CHELONIA_KV_UPDATED fires with `reason: 'local'` and `value`
    //     set to the cloned default
    //   - safeOnUpdate dispatched
    //
    // Throws `ChelErrorKvSlotUnknown` on the same conditions as
    // `chelonia/kv/update`. Other errors from `chelonia/kv/queuedSet`
    // propagate verbatim; the mirror is untouched on failure.
    'chelonia/kv/clear': async function (contractID, key, { maxAttempts, signal } = {}) {
        const rootState = sbp(this.config.stateSelector);
        const slot = resolveActiveSlot(this, rootState, contractID, key, 'clear');
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Aborted', 'AbortError');
        }
        const attemptNonces = [];
        const nonce = base64Nonce();
        attemptNonces.push(nonce);
        recordEchoNonce(this, contractID, key, nonce);
        let lastEtag;
        const onconflict = async ({ etag }) => {
            lastEtag = etag;
            if (signal?.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Aborted', 'AbortError');
            }
            const retryNonce = base64Nonce();
            attemptNonces.push(retryNonce);
            recordEchoNonce(this, contractID, key, retryNonce);
            return [{ __chelKvNonce: retryNonce, value: null }, typeof etag === 'string' ? etag : undefined];
        };
        let setResult;
        try {
            setResult = await sbp('chelonia/queueInvocation', contractID, async () => {
                const liveState = sbp(this.config.stateSelector);
                const mirrorEtag = liveState._kv?.[contractID]?.[key]?.etag ?? undefined;
                return sbp('chelonia/kv/set', contractID, key, { __chelKvNonce: nonce, value: null }, {
                    ifMatch: mirrorEtag,
                    encryptionKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName),
                    signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName),
                    onconflict,
                    maxAttempts,
                    signal
                });
            });
        }
        catch (e) {
            if (e instanceof ChelErrorKvMaxAttempts) {
                removeEchoNonces(this, contractID, key, attemptNonces);
                throw new ChelErrorKvConflict(`[chelonia/kv] clear: ${contractID}::${key} ran out of attempts ` +
                    'resolving conflicts', { cause: { currentData: null, etag: lastEtag ?? null } });
            }
            removeEchoNonces(this, contractID, key, attemptNonces);
            throw e;
        }
        // Post-write abort guard (§4.2): the network write succeeded, but the
        // caller's signal was aborted mid-flight. The mirror must remain unchanged;
        // no event fires. Remove only this call's nonces so the pubsub echo
        // reconciles the mirror as reason: 'remote' without corrupting a
        // concurrent write's echo suppression.
        if (signal?.aborted) {
            removeEchoNonces(this, contractID, key, attemptNonces);
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Aborted', 'AbortError');
        }
        // Staleness guard (symmetric with update): if `defineSlot` replaced
        // this slot while the network write was in flight, bail out and let
        // the new slot's reconcile pass handle the state.
        if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
            return;
        }
        const perContract = ensureContractKv(this, rootState, contractID);
        const entry = perContract[key];
        if (!entry) {
            // Reconcile dropped the slot mid-write — nothing to mirror into.
            return;
        }
        const previousValue = entry.value;
        const defaultClone = slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined;
        this.config.reactiveSet(entry, 'value', defaultClone);
        this.config.reactiveSet(entry, 'etag', setResult.etag);
        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
            contractID,
            contractType: slot.contractType,
            key,
            value: defaultClone,
            previousValue,
            reason: 'local',
            etag: setResult.etag
        });
        if (entry.status !== 'non-init') {
            setSlotStatus(this, rootState, contractID, slot.contractType, key, 'non-init');
        }
        await safeOnUpdate(slot, defaultClone, {
            contractID,
            contractType: slot.contractType,
            key,
            reason: 'local',
            etag: setResult.etag,
            previousValue
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
        const rootState = sbp(this.config.stateSelector);
        if (key !== undefined) {
            // Use the active index to verify the slot is active, but fall
            // back to `'non-init'` instead of throwing — status is a query,
            // not a command.
            const active = this.kvSlotsByContractID.get(contractID)?.has(key);
            if (!active)
                return 'non-init';
            const entry = rootState._kv?.[contractID]?.[key];
            return entry?.status ?? 'non-init';
        }
        // Aggregate: precedence error > loading > non-init > loaded.
        const perKey = this.kvSlotsByContractID.get(contractID);
        if (!perKey || perKey.size === 0)
            return 'non-init';
        const perContract = rootState._kv?.[contractID];
        let sawLoading = false;
        let sawNonInit = false;
        let sawLoaded = false;
        for (const slotKey of perKey.keys()) {
            const status = perContract?.[slotKey]?.status ?? 'non-init';
            if (status === 'error')
                return 'error';
            if (status === 'loading')
                sawLoading = true;
            else if (status === 'non-init')
                sawNonInit = true;
            else if (status === 'loaded')
                sawLoaded = true;
        }
        if (sawLoading)
            return 'loading';
        if (sawNonInit)
            return 'non-init';
        if (sawLoaded)
            return 'loaded';
        return 'non-init';
    },
    // Private convenience used by `chelonia/defineContract`. Accepts the
    // `kv: { ... }` block declared inline on a contract definition and
    // registers each entry as a `defineSlot` call scoped to the
    // manifest. See KV-REVAMPED.md §4.8 / §11.3 step 7.
    'chelonia/kv/_registerContractSlots': function (manifest, kv) {
        for (const key of Object.keys(kv)) {
            const entry = kv[key];
            sbp('chelonia/kv/_defineSlotInternal', {
                ...entry,
                contractType: manifest,
                key
            }, { kind: 'defineContract', manifest });
        }
    },
    // Private. See KV-REVAMPED.md §11.3 step 8. Diffs `prevKv` vs
    // `nextKv` for `manifest`; for every key present in `prevKv` but not
    // in `nextKv`, unregister the slot from `kvSlots`, scrub it from
    // every `kvSlotsByContractID[cID]` and `kvActiveFilters[cID]`,
    // queue a filter flush, and drop the corresponding
    // `rootState._kv[cID][key]` mirror entry. Keys present in both
    // blocks are left to the normal `defineSlot` re-registration path
    // (which re-validates persisted mirror values against the new
    // schema — §4.1).
    'chelonia/kv/_cleanupContractSlots': function (manifest, prevKv, nextKv) {
        if (!prevKv)
            return;
        const rootState = sbp(this.config.stateSelector);
        const nextKeys = nextKv ? new Set(Object.keys(nextKv)) : new Set();
        for (const key of Object.keys(prevKv)) {
            if (nextKeys.has(key))
                continue;
            const rKey = registryKey(manifest, key);
            const slot = this.kvSlots.get(rKey);
            if (!slot)
                continue;
            // Only unregister slots that were registered by this manifest's
            // defineContract call — standalone `defineSlot` registrations
            // for the same key must survive.
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
                if (perKey.size === 0)
                    this.kvSlotsByContractID.delete(cID);
                const filter = this.kvActiveFilters.get(cID);
                if (filter?.has(key)) {
                    filter.delete(key);
                    queueFilterFlush(this, cID);
                }
                const perContract = rootState._kv?.[cID];
                if (perContract && perContract[key]) {
                    this.config.reactiveDel(perContract, key);
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
        const rootState = sbp(this.config.stateSelector);
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
                sbp('chelonia/kv/_reconcileForSlot', slot, cID);
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
function revalidateMirrorEntry(ctx, rootState, contractID, slot) {
    const entry = rootState._kv?.[contractID]?.[slot.key];
    if (!entry || entry.value === undefined)
        return;
    if (!slot.schema) {
        // No schema → nothing to validate; if previously errored, clear
        // the error state.
        if (entry.status === 'error') {
            setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, 'loaded');
        }
        return;
    }
    const previousValue = entry.value;
    try {
        const parsed = parseSyncSlotValue(slot, previousValue, `re-validate ${contractID}::${slot.key}`);
        // Successful re-validation: write the (possibly coerced) value
        // back and emit the standard transition events.
        ctx.config.reactiveSet(entry, 'value', parsed);
        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            value: parsed,
            previousValue,
            reason: 'load',
            etag: entry.etag
        });
        setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, 'loaded');
        // Fire onUpdate matching the normal `'load'` path (§4.1).
        // safeOnUpdate catches errors internally, so fire-and-forget
        // is safe from the synchronous defineSlot call site.
        safeOnUpdate(slot, parsed, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            reason: 'load',
            etag: entry.etag,
            previousValue
        });
    }
    catch (e) {
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            error: e,
            reason: 're-validate'
        });
        setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, 'error', normalizeError(e));
    }
}
