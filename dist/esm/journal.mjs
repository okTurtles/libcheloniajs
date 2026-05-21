// Journal — a compact diff-based record of contract state changes.
//
// Design philosophy: stay DUMB. The journal records "what changed" between
// the per-contract state immediately before and immediately after Chelonia
// processed an event. It MUST NOT replicate `processMessage` logic; if it
// did, it would diverge and become its own bug source.
//
// This file is intentionally split into:
//   - Pure helpers (defaultDiff, defaultApplyPatch, applyRedactions, ...)
//     which carry no Chelonia context and can be unit-tested in isolation.
//   - SBP selectors which glue the helpers into the Chelonia event
//     handling lifecycle.
//
// Patch shape is a strict subset of RFC 6902 (add / remove / replace) with
// JSON-Pointer paths. We never emit move/copy/test. The producer never
// emits a root-remove; instead the contract-cleared case is represented as
// `{ op: 'replace', path: '', value: null }`. The applier accepts the RFC
// 6901 `-` token for array tail-appends, rejects `replace` on missing
// object keys, and rejects `add`/`replace` whose `value` is absent. The
// intent is that output is consumable by any standards-conformant RFC 6902
// library and vice versa.
import { blake32Hash } from './functions.mjs';
import sbp from '@sbp/sbp';
import { has } from 'turtledash';
import { ChelErrorJournalCorrupt } from './errors.mjs';
// ---------------------------------------------------------------------------
// JSON-Pointer helpers
// ---------------------------------------------------------------------------
// RFC 6901 escapes: `~` -> `~0`, `/` -> `~1`.
export function escapePointerSegment(segment) {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
export function unescapePointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
export function segmentsToPointer(segments) {
    if (segments.length === 0)
        return '';
    return '/' + segments.map(escapePointerSegment).join('/');
}
export function pointerToSegments(pointer) {
    if (pointer === '')
        return [];
    if (pointer[0] !== '/') {
        throw new Error(`Invalid JSON Pointer: ${pointer}`);
    }
    return pointer.slice(1).split('/').map(unescapePointerSegment);
}
// Parse a dotted redaction path ("a.b.*.c") into segments. No escaping
// support — redaction paths are intended for development use on plain
// alphanumeric keys.
export function parseDottedPath(path) {
    if (path === '')
        return [];
    return path.split('.');
}
// ---------------------------------------------------------------------------
// Plain-object / array helpers
// ---------------------------------------------------------------------------
function isPlainObject(v) {
    if (v === null || typeof v !== 'object')
        return false;
    if (Array.isArray(v))
        return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}
export function cloneValue(v) {
    // Minimal structural clone for plain JSON-ish values. Functions, Dates,
    // Maps, Sets, etc. fall through and are returned as-is — Chelonia state
    // is plain JSON in practice, so this is enough.
    //
    // Round-trip caveat: `cloneValue` faithfully preserves own keys whose
    // value is `undefined` (`{ a: undefined }` clones to `{ a: undefined }`),
    // but `defaultDiff` treats `undefined` on either side as "key absent"
    // and emits an `add`/`remove`. Reconstructing through diff+apply
    // therefore drops such keys. This is consistent with JSON semantics
    // (`JSON.stringify({ a: undefined })` is `"{}"`) and matches the
    // documented "plain JSON state" contract; states that rely on
    // explicit-undefined keys must supply a custom `diff` / `applyPatch`.
    if (v === null || typeof v !== 'object')
        return v;
    if (Array.isArray(v))
        return v.map(cloneValue);
    if (isPlainObject(v)) {
        // Preserve the source prototype so `Object.create(null)` containers
        // (which Chelonia uses throughout contract state — `_vm`, `_volatile`,
        // etc.) round-trip as null-prototype objects rather than silently
        // gaining `Object.prototype`. `deepStrictEqual` against the live
        // state would otherwise diverge on prototype.
        const out = Object.create(Object.getPrototypeOf(v));
        for (const k of Object.keys(v)) {
            // Use `defineProperty` instead of `out[k] = ...` so a state with an
            // own enumerable `__proto__` key cannot pollute `Object.prototype`
            // via this clone path.
            Object.defineProperty(out, k, {
                value: cloneValue(v[k]),
                writable: true,
                enumerable: true,
                configurable: true
            });
        }
        return out;
    }
    return v;
}
// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
// Produce a JSON-Patch-style diff transforming `before` into `after`.
// Output order is recursive (parent before children), with one important
// guarantee: array shrinks emit removes from the tail down so subsequent
// indices stay valid as patches are applied in order. The patches array
// is NOT globally sorted deepest-first.
export function defaultDiff(before, after) {
    const patches = [];
    diffInto(before, after, [], patches);
    return patches;
}
function diffInto(before, after, segments, out) {
    // Identity / strict equality short-circuit.
    if (before === after)
        return;
    const path = segmentsToPointer(segments);
    if (before === undefined) {
        out.push({ op: 'add', path, value: cloneValue(after) });
        return;
    }
    if (after === undefined) {
        // RFC 6902 does not define `remove` at the document root, so we emit
        // `replace` with `null` at root instead. At non-root positions, a
        // proper `remove` is well-defined and that's what we use.
        if (segments.length === 0) {
            out.push({ op: 'replace', path, value: null });
        }
        else {
            out.push({ op: 'remove', path });
        }
        return;
    }
    const bIsArr = Array.isArray(before);
    const aIsArr = Array.isArray(after);
    const bIsObj = isPlainObject(before);
    const aIsObj = isPlainObject(after);
    // If either side is a primitive or the container shape differs, replace
    // the whole subtree.
    if (bIsArr !== aIsArr || bIsObj !== aIsObj || (!bIsArr && !bIsObj)) {
        if (!shallowEqualPrimitives(before, after)) {
            out.push({ op: 'replace', path, value: cloneValue(after) });
        }
        return;
    }
    if (bIsArr && aIsArr) {
        const bArr = before;
        const aArr = after;
        const minLen = Math.min(bArr.length, aArr.length);
        for (let i = 0; i < minLen; i++) {
            diffInto(bArr[i], aArr[i], [...segments, String(i)], out);
        }
        if (aArr.length > bArr.length) {
            for (let i = bArr.length; i < aArr.length; i++) {
                out.push({
                    op: 'add',
                    path: segmentsToPointer([...segments, String(i)]),
                    value: cloneValue(aArr[i])
                });
            }
        }
        else if (bArr.length > aArr.length) {
            // Remove from the tail down so indices remain valid as we apply.
            for (let i = bArr.length - 1; i >= aArr.length; i--) {
                out.push({
                    op: 'remove',
                    path: segmentsToPointer([...segments, String(i)])
                });
            }
        }
        return;
    }
    // Plain objects.
    const bObj = before;
    const aObj = after;
    const bKeys = Object.keys(bObj);
    const aKeys = Object.keys(aObj);
    const aSet = new Set(aKeys);
    for (const k of bKeys) {
        if (!aSet.has(k)) {
            out.push({ op: 'remove', path: segmentsToPointer([...segments, k]) });
        }
    }
    const bSet = new Set(bKeys);
    for (const k of aKeys) {
        if (!bSet.has(k)) {
            out.push({
                op: 'add',
                path: segmentsToPointer([...segments, k]),
                value: cloneValue(aObj[k])
            });
        }
        else {
            diffInto(bObj[k], aObj[k], [...segments, k], out);
        }
    }
}
function shallowEqualPrimitives(a, b) {
    // Used only when we've already established neither side is a container
    // we'd recurse into. NaN-aware so NaN equals NaN (avoids spurious diffs).
    if (a === b)
        return true;
    if (typeof a === 'number' && typeof b === 'number' &&
        Number.isNaN(a) && Number.isNaN(b))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
// Write `value` at key `last` on `obj` without invoking inherited setters.
//
// Why this matters: `obj[last] = value` on a plain object will trigger any
// setter inherited from the prototype chain. The most important case is
// `last === '__proto__'`: the assignment form invokes the inherited
// `Object.prototype.__proto__` setter and re-parents `obj`. Using
// `Object.defineProperty` instead defines an *own* data property literally
// named `"__proto__"` that shadows the accessor — `Object.prototype` is
// never touched and `Object.getPrototypeOf(obj)` is unchanged. The same
// reasoning covers any user-defined accessor on the prototype chain.
function safeDefine(obj, last, value) {
    Object.defineProperty(obj, last, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
    });
}
// Apply a sequence of patches to a value, returning a new value. Does not
// mutate the input. Rejects unknown op kinds.
export function defaultApplyPatch(state, patches) {
    let current = cloneValue(state);
    for (const p of patches) {
        current = applyOne(current, p);
    }
    return current;
}
function applyOne(root, patch) {
    const segments = pointerToSegments(patch.path);
    // Reject unknown ops up front. The strict-subset producer only emits
    // add/remove/replace, but external patches fed into the public
    // `defaultApplyPatch` could contain anything; without this guard the
    // root-path branch below would silently treat e.g. `{ op: 'frob', ... }`
    // as a whole-root replace.
    if (patch.op !== 'add' && patch.op !== 'replace' && patch.op !== 'remove') {
        throw new Error(`Unsupported patch op '${patch.op}' at '${patch.path}'`);
    }
    if (patch.op === 'add' || patch.op === 'replace') {
        // The strict-subset type guarantees `value`, but a malformed patch from
        // an external producer might omit it. Validate at runtime so we reject
        // instead of writing `undefined`.
        if (!('value' in patch)) {
            throw new Error(`Patch '${patch.op}' at '${patch.path}' is missing required 'value'`);
        }
    }
    if (segments.length === 0) {
        // Whole-root operation. RFC 6902 does not define `remove` at root.
        if (patch.op === 'remove') {
            throw new Error("Whole-root 'remove' is not supported (use replace with null)");
        }
        return cloneValue(patch.value);
    }
    if (root === undefined || root === null || typeof root !== 'object') {
        throw new Error(`Cannot apply patch '${patch.op}' at '${patch.path}' to non-container root`);
    }
    // Walk to parent. The root was already cloned by `defaultApplyPatch`,
    // so it is safe to mutate the container chain in place. Every object
    // step uses `has` (own-property only), so attacker-controlled segments
    // like `__proto__` / `constructor` cannot traverse into
    // `Object.prototype` — those names are inherited, not own, on plain
    // objects and the walk throws before reaching them.
    let parent = root;
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (Array.isArray(parent)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
                throw new Error(`Cannot apply patch '${patch.op}' at '${patch.path}': intermediate '${seg}' is not a container`);
            }
            const next = parent[idx];
            if (next === undefined || next === null || typeof next !== 'object') {
                throw new Error(`Cannot apply patch '${patch.op}' at '${patch.path}': intermediate '${seg}' is not a container`);
            }
            parent = next;
        }
        else {
            if (!has(parent, seg)) {
                throw new Error(`Cannot apply patch '${patch.op}' at '${patch.path}': intermediate '${seg}' is not a container`);
            }
            const next = parent[seg];
            if (next === undefined || next === null || typeof next !== 'object') {
                throw new Error(`Cannot apply patch '${patch.op}' at '${patch.path}': intermediate '${seg}' is not a container`);
            }
            parent = next;
        }
    }
    const last = segments[segments.length - 1];
    if (Array.isArray(parent)) {
        // RFC 6901 §4 end-of-array token: `-` means "position after the last
        // element". Only meaningful for `add`; for `replace`/`remove` it is
        // ill-defined and must be rejected.
        const isDash = last === '-';
        const idx = isDash ? parent.length : Number(last);
        if (!isDash && (!Number.isInteger(idx) || idx < 0)) {
            throw new Error(`Invalid array index '${last}' in patch '${patch.path}'`);
        }
        if (patch.op === 'add') {
            // RFC 6902 §4.1: for arrays the index must reference a position
            // within the array, OR equal its length (append). `splice` would
            // otherwise silently clamp out-of-bounds indices to `length`,
            // turning malformed patches like `/999` into a valid append.
            if (!isDash && idx > parent.length) {
                throw new Error(`Cannot 'add' at '${patch.path}': array index out of bounds`);
            }
            parent.splice(idx, 0, cloneValue(patch.value));
        }
        else if (patch.op === 'replace') {
            if (isDash) {
                throw new Error("'-' is not a valid array index for 'replace'");
            }
            if (idx >= parent.length) {
                throw new Error(`Cannot 'replace' at '${patch.path}': array index out of bounds`);
            }
            parent[idx] = cloneValue(patch.value);
        }
        else if (patch.op === 'remove') {
            if (isDash) {
                throw new Error("'-' is not a valid array index for 'remove'");
            }
            if (idx >= parent.length) {
                throw new Error(`Cannot 'remove' at '${patch.path}': array index out of bounds`);
            }
            parent.splice(idx, 1);
        }
        else {
            throw new Error(`Unsupported patch op: ${patch.op}`);
        }
    }
    else {
        const obj = parent;
        if (patch.op === 'add') {
            safeDefine(obj, last, cloneValue(patch.value));
        }
        else if (patch.op === 'replace') {
            // RFC 6902 §4.3: replace requires the target location to already
            // exist. Use `has` so inherited properties (e.g. via
            // Object.prototype) do NOT count as "existing".
            if (!has(obj, last)) {
                throw new Error(`Cannot 'replace' at '${patch.path}': target key does not exist`);
            }
            safeDefine(obj, last, cloneValue(patch.value));
        }
        else if (patch.op === 'remove') {
            if (!has(obj, last)) {
                throw new Error(`Cannot 'remove' at '${patch.path}': target key does not exist`);
            }
            delete obj[last];
        }
        else {
            throw new Error(`Unsupported patch op: ${patch.op}`);
        }
    }
    return root;
}
// ---------------------------------------------------------------------------
// Redactions
// ---------------------------------------------------------------------------
// Deep-clone `state` and apply each redaction. Redactors are invoked on the
// cloned value, so user code cannot mutate the live state object.
// A throwing redactor logs once and substitutes the sentinel string so a
// single bad redactor cannot blank out unrelated parts of the state.
export const REDACTION_ERROR_SENTINEL = '[REDACTION_ERROR]';
export function applyRedactions(state, redactions) {
    const cloned = cloneValue(state);
    if (!redactions || redactions.length === 0)
        return cloned;
    for (const r of redactions) {
        const segments = parseDottedPath(r.path);
        if (segments.length === 0)
            continue;
        walkAndRedact(cloned, segments, 0, r.redact, []);
    }
    return cloned;
}
function walkAndRedact(parent, segments, i, redact, resolved) {
    if (parent === null || typeof parent !== 'object')
        return;
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    // Only consider own properties when matching a literal segment, and only
    // own enumerable keys for the `*` glob — never traverse the prototype.
    const keys = seg === '*'
        ? (Array.isArray(parent)
            ? parent.map((_, idx) => String(idx))
            : Object.keys(parent))
        : (has(parent, seg) ? [seg] : []);
    for (const k of keys) {
        const fullPath = [...resolved, k];
        if (isLast) {
            const container = parent;
            const original = container[k];
            let replacement;
            try {
                replacement = redact(original, fullPath);
            }
            catch (e) {
                console.warn(`[chelonia][journal] redactor threw for path '${fullPath.join('.')}':`, e);
                replacement = REDACTION_ERROR_SENTINEL;
            }
            // Write via defineProperty on objects: even though `cloneValue`
            // produced this container, defending against prototype-polluting
            // keys at the write site costs nothing and keeps the invariant
            // local. On arrays we validate the index and use bracket
            // assignment — arrays don't have string keys in JSON Patch, so a
            // non-integer key here is a bug, not a write to mishandle.
            if (Array.isArray(container)) {
                const idx = Number(k);
                if (Number.isInteger(idx) && idx >= 0 && idx < container.length) {
                    container[idx] = replacement;
                }
            }
            else {
                Object.defineProperty(container, k, {
                    value: replacement,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });
            }
        }
        else {
            walkAndRedact(parent[k], segments, i + 1, redact, fullPath);
        }
    }
}
// A convenience redactor that maps a value to the first 8 characters of
// a blake2b-256 hash of its JSON serialization (base58btc-encoded, as
// produced by `blake32Hash` — not hex). Distinct inputs produce distinct
// outputs with high probability while never revealing the value.
//
// Caveat: this is NOT suitable for adversarial inputs. Low-entropy values
// (booleans, small integers, short enum strings) are trivially reversible
// by precomputation — anyone with the journal and the contract schema can
// recover the original. Use only for values with sufficient entropy, or
// substitute a constant sentinel (e.g. `'[REDACTED]'`) for low-entropy
// fields.
export function shortHashRedactor(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value) ?? 'undefined';
    }
    catch {
        // Cyclic or otherwise unserializable — fall back to a tag of the type.
        serialized = `[unserializable:${typeof value}]`;
    }
    return blake32Hash(serialized).slice(0, 8);
}
// ---------------------------------------------------------------------------
// SBP integration
// ---------------------------------------------------------------------------
// Default snapshot interval (X). The journal holds between X and 2X entries.
export const DEFAULT_SNAPSHOT_INTERVAL = 50;
function resolveJournalConfig(cfg) {
    // `chelonia/_init` populates `this.config.journal` with all of the
    // documented defaults so the policy lives in exactly one place. We still
    // tolerate a missing / partial config here because the public selectors
    // (`chelonia/journal/reconstruct`, `chelonia/journal/get`) can be invoked
    // via SBP from anywhere — including before `_init` has run in tests or
    // in unusual reset orderings — and a missing field must not crash.
    const enabled = cfg?.enabled === true;
    const snapshotInterval = typeof cfg?.snapshotInterval === 'number'
        ? cfg.snapshotInterval
        : DEFAULT_SNAPSHOT_INTERVAL;
    const contractIDs = cfg?.contractIDs && cfg.contractIDs.length > 0
        ? new Set(cfg.contractIDs)
        : null;
    const redactions = cfg?.redactions ?? [];
    const diff = cfg?.diff ?? defaultDiff;
    const applyPatch = cfg?.applyPatch ?? defaultApplyPatch;
    return { enabled, snapshotInterval, contractIDs, redactions, diff, applyPatch };
}
function indexOfLastSnapshot(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].kind === 'snapshot')
            return i;
    }
    return -1;
}
function appendAndTrim(entries, entry, snapshotInterval, 
// When non-null, provides the current redacted state to snapshot at the
// X-boundary. Passing null skips snapshot insertion (used for the very
// first entry, which is itself a snapshot).
postSnapshotState) {
    // Allocate a fresh array on every call so the array's identity changes
    // in lock-step with the `_journal` wrapper swap performed by
    // `recordEvent` via `reactiveSet`. This means consumers that destructure
    // (`const { entries } = _journal`) and reactive frameworks observing
    // `_journal.entries` directly see a single atomic transition per event
    // rather than a mid-tick `push` followed by a `splice` trim — they will
    // never observe the array at length `2X+1` between the push and the
    // trim. The O(window) copy is bounded by `2 * snapshotInterval` and
    // happens at most once per processed event.
    entries = entries.slice();
    entries.push(entry);
    // If this push reached snapshotInterval patches since the most recent
    // snapshot, append a snapshot entry as well. We derive the identifying
    // fields from `entry` itself so the snapshot can never drift away from
    // the patch it accompanies. The `postSnapshotState.state !== undefined`
    // gate keeps us from persisting `{ state: undefined }` when an errored
    // event lands on the boundary; in that case the auto-snapshot is
    // simply deferred to the next non-errored event.
    if (postSnapshotState &&
        postSnapshotState.state !== undefined &&
        entry.kind === 'patch') {
        const lastSnapIdx = indexOfLastSnapshot(entries);
        const patchesSinceSnap = entries.length - 1 - lastSnapIdx;
        if (patchesSinceSnap >= snapshotInterval) {
            const snap = Object.create(null);
            snap.kind = 'snapshot';
            snap.hash = entry.hash;
            snap.height = entry.height;
            snap.opType = entry.opType;
            snap.description = entry.description;
            snap.state = postSnapshotState.state;
            entries.push(snap);
        }
    }
    // Trim: if total length exceeded 2X, drop everything before the most
    // recent snapshot. The splice operates on the fresh copy allocated
    // above, so external observers of the previous `entries` array are
    // unaffected.
    if (entries.length > 2 * snapshotInterval) {
        const lastSnapIdx = indexOfLastSnapshot(entries);
        if (lastSnapIdx > 0) {
            entries.splice(0, lastSnapIdx);
        }
    }
    return entries;
}
function logJournalError(label, e) {
    console.warn(`[chelonia][journal] ${label}:`, e);
}
// Normalize an arbitrary throwable into `{ name, message }`. Mirrors
// the leniency of the JS `throw` statement: any value can be raised,
// so the journal must not assume an `Error` instance. We intentionally
// avoid `JSON.stringify` (cycles, BigInt, Symbol → throws) and use
// `String(...)` for value coercion. `Symbol` is a special case: its
// `String()` form is the readable `Symbol(...)` representation, which
// is exactly what we want for a debug breadcrumb.
function normalizeProcessingError(e) {
    // Object-shaped throwables (Error instances or plain objects).
    if (e !== null && typeof e === 'object') {
        const obj = e;
        const rawName = obj.name;
        const rawMessage = obj.message;
        let name;
        if (typeof rawName === 'string') {
            name = rawName;
        }
        else if (rawName === undefined) {
            // Default to the JS-conventional "Error" only when no name was
            // supplied at all. For non-Error values we'd already be in the
            // `else` branch below.
            name = e instanceof Error ? 'Error' : (e.constructor?.name ?? 'Object');
        }
        else {
            try {
                name = String(rawName);
            }
            catch {
                name = 'Error';
            }
        }
        let message;
        if (typeof rawMessage === 'string') {
            message = rawMessage;
        }
        else if (rawMessage === undefined) {
            message = '';
        }
        else {
            try {
                message = String(rawMessage);
            }
            catch {
                message = '';
            }
        }
        return { name, message };
    }
    // Primitive throwables (string, number, boolean, bigint, symbol).
    // Surface the type as `name` so consumers can tell at a glance that
    // a non-`Error` was raised, and stuff the value into `message`.
    let message;
    try {
        message = String(e);
    }
    catch {
        message = '';
    }
    return { name: typeof e, message };
}
export default sbp('sbp/selectors/register', {
    // Internal: record a single event in the contract's journal. Called from
    // `handleEvent.applyProcessResult`. MUST NOT throw — failures here are
    // debug-only and must never break event processing.
    'chelonia/private/journal/recordEvent': function (contractID, message, beforeState, afterState, processingErrored, 
    // Captured throwable from `processMutation`; only meaningful when
    // `processingErrored` is true. Typed as `unknown` because JS lets
    // anything be thrown — strings, numbers, plain objects, `null`,
    // `undefined`, even `Symbol`s — and `processMutation`'s catch sees
    // whatever the contract author / lower-level code raised. The
    // recorder normalizes that into `{ name, message }` before storing.
    processingError) {
        try {
            const cfg = resolveJournalConfig(this.config.journal);
            if (!cfg.enabled)
                return;
            if (cfg.contractIDs && !cfg.contractIDs.has(contractID))
                return;
            const rootState = sbp(this.config.stateSelector);
            if (!rootState || !rootState.contracts || !rootState.contracts[contractID]) {
                // No contracts bookkeeping entry yet — there's nowhere to attach
                // the journal. This can happen for messages discarded very early.
                console.debug(`[chelonia][journal] skipping recordEvent for ${contractID}: no contracts bookkeeping entry`);
                return;
            }
            const hash = message.hash();
            const height = message.height();
            const opType = String(message.opType());
            let description;
            try {
                description = message.description();
            }
            catch { /* optional */ }
            const contractMeta = rootState.contracts[contractID];
            const existing = contractMeta._journal?.entries;
            const lastEntry = existing && existing.length > 0
                ? existing[existing.length - 1]
                : undefined;
            // Re-sync detection: when the contract has been re-processed from
            // scratch (`_volatile.dirty` triggered a resync, etc.) the incoming
            // height moves strictly backwards relative to the last journalled
            // entry. In that unambiguous case we drop the stale window and
            // re-seed with a fresh snapshot.
            //
            // The duplicate-arrival case (`hash === lastEntry.hash` at the
            // same height) is *not* a resync — it just means the same event
            // was delivered twice (retry-on-publish, web-socket replay, etc.).
            // We ignore the duplicate so the perfectly valid prior window is
            // preserved.
            if (lastEntry !== undefined &&
                lastEntry.hash === hash &&
                height === lastEntry.height) {
                return;
            }
            // A strictly backwards height is the unambiguous resync signal
            // (the contract has been re-processed from scratch). We additionally
            // treat a strictly forward height *gap* as a resync: under normal
            // operation Chelonia journals every event at the current height,
            // so seeing the chain skip from height M to M+2+ means we missed
            // entries (e.g. journaling was disabled and re-enabled, or the
            // `contractIDs` filter changed to re-include this contract). The
            // before-state for this incoming event no longer matches the state
            // captured by `lastEntry`, so producing a patch on top of it would
            // silently corrupt `reconstruct`. Drop the stale window and re-seed
            // with a fresh snapshot in that case.
            const isBackwards = lastEntry !== undefined && height < lastEntry.height;
            const isForwardGap = lastEntry !== undefined && height > lastEntry.height + 1;
            const isResync = isBackwards || isForwardGap;
            const isFirstOrResync = !existing || existing.length === 0 || isResync;
            // When the contract errored we will emit an empty-patch entry that
            // doesn't need either redacted projection — skip the work.
            const willEmitEmptyPatch = !isFirstOrResync && processingErrored;
            // Compute redacted before/after defensively. We can skip the
            // `before` projection when we know the diff will be empty
            // (processingErrored on a chain that already has entries) or when
            // we're going to emit a snapshot. We must always compute
            // `after` for non-first/non-resync events so `appendAndTrim` has a
            // value to materialize a boundary snapshot from — without it, a
            // long run of errored events would keep pushing empty patches and
            // never be trimmed, growing the journal without bound.
            let redactedBefore;
            let redactedAfter;
            if (!willEmitEmptyPatch && !isFirstOrResync) {
                try {
                    redactedBefore = beforeState === undefined
                        ? undefined
                        : applyRedactions(beforeState, cfg.redactions);
                }
                catch (e) {
                    logJournalError('redaction (before) failed', e);
                    redactedBefore = undefined;
                }
            }
            try {
                redactedAfter = afterState === undefined
                    ? null
                    : applyRedactions(afterState, cfg.redactions);
            }
            catch (e) {
                logJournalError('redaction (after) failed', e);
                redactedAfter = null;
            }
            let nextEntries;
            if (isFirstOrResync) {
                // First event for this contract OR a resync: emit a snapshot only.
                const snap = Object.create(null);
                snap.kind = 'snapshot';
                snap.hash = hash;
                snap.height = height;
                snap.opType = opType;
                snap.description = description;
                snap.state = redactedAfter;
                nextEntries = [snap];
            }
            else {
                let patch;
                if (processingErrored) {
                    // Empty patch is itself a diagnostic signal. Skip redaction
                    // entirely above by short-circuiting the diff here.
                    patch = [];
                }
                else {
                    try {
                        patch = cfg.diff(redactedBefore, redactedAfter);
                    }
                    catch (e) {
                        logJournalError('diff failed', e);
                        patch = [];
                    }
                }
                const entry = Object.create(null);
                entry.kind = 'patch';
                entry.hash = hash;
                entry.height = height;
                entry.opType = opType;
                entry.description = description;
                entry.patch = patch;
                // Attach error detail when we have one. JS allows *anything*
                // to be thrown (strings, numbers, plain objects, `null`, even
                // `undefined`), so we normalize the raw throwable into a
                // JSON-safe `{ name, message }` pair. Rules:
                //   - `Error`-like objects: pull `name` / `message` if they are
                //     strings, else stringify them.
                //   - Plain objects with `name` / `message` string fields:
                //     same.
                //   - Everything else: derive `name` from `typeof`, stuff the
                //     stringified value into `message`.
                // `null` / `undefined` are treated as "no error detail" — the
                // catch site only forwards a value when it actually caught
                // something, but a paranoid extra check costs nothing.
                if (processingErrored && processingError != null) {
                    entry.error = normalizeProcessingError(processingError);
                }
                nextEntries = appendAndTrim(existing, entry, cfg.snapshotInterval, { state: redactedAfter });
            }
            const wrapper = Object.create(null);
            wrapper.entries = nextEntries;
            this.config.reactiveSet(contractMeta, '_journal', wrapper);
        }
        catch (e) {
            // The recorder is contractually "MUST NOT throw": any failure here
            // is debug-only and must never propagate up into event handling.
            // Log with the journal-specific prefix and swallow.
            logJournalError('recordEvent unexpected error', e);
        }
    },
    // Public: return a deep clone of the journal for a contract, or undefined
    // if no journal exists.
    'chelonia/journal/get': function (contractID) {
        const rootState = sbp(this.config.stateSelector);
        const j = rootState?.contracts?.[contractID]?._journal;
        if (!j)
            return undefined;
        // Use the module-local deep clone so `undefined` values inside
        // snapshots / patch payloads survive (a JSON round-trip would drop
        // them) and so any pathological references cannot throw the way
        // `JSON.stringify` would on cycles.
        return cloneValue(j);
    },
    // Public: rebuild the redacted contract state at the journal's HEAD by
    // walking from the most recent snapshot and applying subsequent patches.
    // Returns `undefined` if no journal exists (or the journal exists but is
    // empty / has no snapshot to seed from). Throws `ChelErrorJournalCorrupt`
    // if a recorded patch fails to apply: this is a debugging tool and a
    // self-check, so a loud failure is preferable to silently returning
    // `undefined` (which would be indistinguishable from "no journal"). The
    // thrown error's `cause` is the underlying applier error and its
    // `entryIndex` property points at the offending entry for inspection.
    'chelonia/journal/reconstruct': function (contractID) {
        const cfg = resolveJournalConfig(this.config.journal);
        const rootState = sbp(this.config.stateSelector);
        const entries = rootState?.contracts?.[contractID]?._journal?.entries;
        if (!entries || entries.length === 0)
            return undefined;
        const startIdx = indexOfLastSnapshot(entries);
        if (startIdx < 0)
            return undefined;
        const snap = entries[startIdx];
        let state = snap.state;
        for (let i = startIdx + 1; i < entries.length; i++) {
            const e = entries[i];
            // `indexOfLastSnapshot` returned the index of the latest snapshot,
            // so the tail (i > startIdx) cannot contain another snapshot by
            // construction. Skip defensively if it ever does.
            if (e.kind !== 'patch')
                continue;
            try {
                state = cfg.applyPatch(state, e.patch);
            }
            catch (err) {
                logJournalError(`reconstruct failed at entry ${i}`, err);
                const corruptErr = new ChelErrorJournalCorrupt(`journal reconstruct failed for contract ${contractID} at entry ${i}: ` +
                    `${err instanceof Error ? err.message : String(err)}`, { cause: err });
                corruptErr.entryIndex = i;
                corruptErr.contractID = contractID;
                throw corruptErr;
            }
        }
        return state;
    },
    // Public: clear the journal for one contract, or all if `contractID` is
    // omitted. Returns the number of journals cleared.
    'chelonia/journal/clear': function (contractID) {
        const rootState = sbp(this.config.stateSelector);
        if (!rootState?.contracts)
            return 0;
        if (contractID) {
            const meta = rootState.contracts[contractID];
            if (meta?._journal) {
                this.config.reactiveDel(meta, '_journal');
                return 1;
            }
            return 0;
        }
        let count = 0;
        for (const id of Object.keys(rootState.contracts)) {
            const meta = rootState.contracts[id];
            if (meta?._journal) {
                this.config.reactiveDel(meta, '_journal');
                count++;
            }
        }
        return count;
    }
});
