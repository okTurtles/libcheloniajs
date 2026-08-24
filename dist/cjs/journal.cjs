"use strict";
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
// library and vice versa. Operations that only record "a redacted value
// changed" carry an extra `redacted: true` member, which RFC 6902 §4
// requires appliers to ignore.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SNAPSHOT_INTERVAL = exports.REDACTION_NON_JSON_SAFE_SENTINEL = exports.REDACTION_ERROR_SENTINEL = void 0;
exports.escapePointerSegment = escapePointerSegment;
exports.unescapePointerSegment = unescapePointerSegment;
exports.segmentsToPointer = segmentsToPointer;
exports.pointerToSegments = pointerToSegments;
exports.parseDottedPath = parseDottedPath;
exports.cloneValue = cloneValue;
exports.defaultDiff = defaultDiff;
exports.structurallyEqual = structurallyEqual;
exports.defaultApplyPatch = defaultApplyPatch;
exports.applyRedactions = applyRedactions;
exports.shortHashRedactor = shortHashRedactor;
exports.hasHiddenChange = hasHiddenChange;
exports.synthesizeRedactedChangeOps = synthesizeRedactedChangeOps;
exports.defaultJournalConfig = defaultJournalConfig;
const functions_js_1 = require("./functions.cjs");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const errors_js_1 = require("./errors.cjs");
// ---------------------------------------------------------------------------
// JSON-Pointer helpers
// ---------------------------------------------------------------------------
// RFC 6901 escapes: `~` -> `~0`, `/` -> `~1`.
function escapePointerSegment(segment) {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
function unescapePointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
function segmentsToPointer(segments) {
    if (segments.length === 0)
        return '';
    return '/' + segments.map(escapePointerSegment).join('/');
}
function pointerToSegments(pointer) {
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
function parseDottedPath(path) {
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
// Read array element `i`, reporting a hole (a missing index in a sparse
// array) as `null`.
//
// JSON has no representation for a hole: `JSON.stringify` writes `null` in
// its place. A plain `arr[i]` read yields `undefined` instead, which the
// diff interprets as "index absent" and turns into an `add` / `remove` —
// ops that `defaultApplyPatch` applies with `splice`, shifting every later
// index and desynchronising the reconstructed state from the real one. So
// every traversal in this module reads holes as `null`, which is both what
// persistence produces and what the "plain JSON state" contract implies.
function readIndex(arr, i) {
    return i in arr ? arr[i] : null;
}
// Write `value` at `key` on `obj` without invoking inherited setters. This
// is the single write primitive for every object the journal builds or
// mutates: clones, JSON-safety normalization, redaction output and patch
// application all go through it.
//
// Why this matters: `obj[key] = value` on a plain object will trigger any
// setter inherited from the prototype chain. The most important case is
// `key === '__proto__'`: the assignment form invokes the inherited
// `Object.prototype.__proto__` setter and re-parents `obj`. Using
// `Object.defineProperty` instead defines an *own* data property literally
// named `"__proto__"` that shadows the accessor — `Object.prototype` is
// never touched and `Object.getPrototypeOf(obj)` is unchanged. The same
// reasoning covers any user-defined accessor on the prototype chain.
function safeDefine(obj, key, value) {
    Object.defineProperty(obj, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
    });
}
function cloneValue(v) {
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
    // Array holes, by contrast, are normalized to `null` (see `readIndex`),
    // so a clone is always dense.
    if (v === null || typeof v !== 'object')
        return v;
    if (Array.isArray(v)) {
        // `Array.prototype.map` preserves holes, so build the copy index by
        // index through `readIndex` — a clone that is handed to the diff must
        // already be dense (see `readIndex`).
        const src = v;
        const out = new Array(src.length);
        for (let i = 0; i < src.length; i++) {
            out[i] = cloneValue(readIndex(src, i));
        }
        return out;
    }
    if (isPlainObject(v)) {
        // Preserve the source prototype so `Object.create(null)` containers
        // (which Chelonia uses throughout contract state — `_vm`, `_volatile`,
        // etc.) round-trip as null-prototype objects rather than silently
        // gaining `Object.prototype`. `deepStrictEqual` against the live
        // state would otherwise diverge on prototype.
        const out = Object.create(Object.getPrototypeOf(v));
        for (const k of Object.keys(v)) {
            safeDefine(out, k, cloneValue(v[k]));
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
function defaultDiff(before, after) {
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
            // `readIndex`, not `bArr[i]`: a hole must compare as `null` rather
            // than as an absent index, or the emitted add/remove would splice
            // the array and shift every later element.
            diffInto(readIndex(bArr, i), readIndex(aArr, i), [...segments, String(i)], out);
        }
        if (aArr.length > bArr.length) {
            for (let i = bArr.length; i < aArr.length; i++) {
                out.push({
                    op: 'add',
                    path: segmentsToPointer([...segments, String(i)]),
                    value: cloneValue(readIndex(aArr, i))
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
// Deep equality using exactly the same notion of "changed" as
// `defaultDiff`: `a` and `b` are equal iff `defaultDiff(a, b)` would be
// empty. Keeping the two in lock-step matters because this predicate
// decides whether a change hidden behind a constant redactor gets its own
// journal entry; a looser or stricter notion would either invent churn or
// keep hiding real changes.
//
// Notably: `undefined` on one side only is a change (the diff emits
// add/remove), NaN equals NaN, array holes compare as `null` (see
// `readIndex`), and non-plain containers (Date, Map, class instances) are
// only equal by reference — mirroring `defaultDiff`, which emits a
// wholesale `replace` for them.
function structurallyEqual(a, b) {
    if (a === b)
        return true;
    if (a === undefined || b === undefined)
        return false;
    const aIsArr = Array.isArray(a);
    const bIsArr = Array.isArray(b);
    const aIsObj = isPlainObject(a);
    const bIsObj = isPlainObject(b);
    if (aIsArr !== bIsArr || aIsObj !== bIsObj)
        return false;
    if (aIsArr && bIsArr) {
        const aArr = a;
        const bArr = b;
        if (aArr.length !== bArr.length)
            return false;
        for (let i = 0; i < aArr.length; i++) {
            if (!structurallyEqual(readIndex(aArr, i), readIndex(bArr, i)))
                return false;
        }
        return true;
    }
    if (aIsObj && bIsObj) {
        const aObj = a;
        const bObj = b;
        const aKeys = Object.keys(aObj);
        if (aKeys.length !== Object.keys(bObj).length)
            return false;
        for (const k of aKeys) {
            // Own properties only — never let the prototype chain make two
            // states look alike.
            if (!(0, turtledash_1.has)(bObj, k))
                return false;
            if (!structurallyEqual(aObj[k], bObj[k]))
                return false;
        }
        return true;
    }
    return shallowEqualPrimitives(a, b);
}
// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
// Apply a sequence of patches to a value, returning a new value. Does not
// mutate the input. Rejects unknown op kinds.
function defaultApplyPatch(state, patches) {
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
            if (!(0, turtledash_1.has)(parent, seg)) {
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
            if (!(0, turtledash_1.has)(obj, last)) {
                throw new Error(`Cannot 'replace' at '${patch.path}': target key does not exist`);
            }
            safeDefine(obj, last, cloneValue(patch.value));
        }
        else if (patch.op === 'remove') {
            if (!(0, turtledash_1.has)(obj, last)) {
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
// Deep-clone `state` and apply each redaction. Redactors are invoked on
// the cloned value with a disposable copy of the resolved path, so user
// code can neither mutate the live state object nor corrupt the site
// bookkeeping derived from the internal path. A throwing redactor logs and
// substitutes `REDACTION_ERROR_SENTINEL` so a single bad redactor cannot
// blank out unrelated parts of the state; a redactor returning a
// non-JSON-safe value logs and substitutes
// `REDACTION_NON_JSON_SAFE_SENTINEL` (deeply, preserving the JSON-safe
// structure around an unsafe leaf) so projections, snapshots and markers
// all stay persistable.
exports.REDACTION_ERROR_SENTINEL = '[REDACTION_ERROR]';
// Substitute for redactor results that cannot survive JSON persistence
// unchanged. The journal is serialized by whatever layer snapshots
// `state.contracts[contractID]._journal`, and `JSON.stringify` drops
// `undefined` members, renders `NaN` / `Infinity` as `null`, and throws on
// `BigInt` and cycles — so a marker or snapshot carrying such a value would
// corrupt `chelonia/journal/reconstruct` after a reload (a `replace` that
// lost its `value` member is rejected by `defaultApplyPatch`). The bar is a
// lossless JSON round-trip, not merely a successful `JSON.stringify`: a
// `Date` serializes fine yet comes back as a string, so it is rejected too.
exports.REDACTION_NON_JSON_SAFE_SENTINEL = '[REDACTION_NON_JSON_SAFE]';
// True when `v` survives a JSON round-trip without changing shape: `null`,
// strings, booleans, finite numbers, and arrays / plain objects whose
// elements / own values are themselves JSON-safe. Cycles are rejected
// (`JSON.stringify` throws on them), as are `undefined`, `BigInt`, symbols,
// functions and non-plain containers (Dates, Maps, class instances — the
// journal's "plain JSON state" contract passes those through by reference,
// which persists lossily at best). Holes in a sparse array are rejected too:
// `JSON.stringify` writes `null` in their place, so the array would come
// back a different shape. So is an array carrying own enumerable non-index
// keys, which `JSON.stringify` drops outright. The `seen` set tracks only
// the current ancestor chain, so shared (DAG-shaped) references remain
// allowed exactly as they are for `JSON.stringify`.
//
// Note the deliberate asymmetry with `readIndex`, which reads a hole in
// *contract state* as `null`: state is data the journal must record
// faithfully, and `null` is its lossless JSON equivalent, whereas a hole in
// a *redactor result* is a bug in caller code that is better surfaced
// loudly through the sentinel than silently rewritten.
//
// This acceptance test and `normalizeToJSONSafe` below are deliberately
// separate traversals (this one allocates nothing on the common path), so
// they MUST classify every value identically. The agreement is asserted by
// the "JSON-safety acceptance and normalization agree" suite; extend both
// functions and that suite together.
function isJSONSafeValue(v, seen) {
    if (v === null)
        return true;
    const t = typeof v;
    if (t === 'string' || t === 'boolean')
        return true;
    if (t === 'number')
        return Number.isFinite(v);
    if (t !== 'object')
        return false;
    if (seen.has(v))
        return false;
    if (Array.isArray(v)) {
        seen.add(v);
        const arr = v;
        // An array carrying own enumerable keys that are not indices (e.g.
        // `const a = [1, 2]; a.extra = 'x'`) is rejected: `JSON.stringify`
        // serializes arrays index-by-index and silently drops those keys, so
        // the value would not round-trip. Comparing the own-key count with
        // the length catches that in O(1) extra allocations, and the
        // per-index `i in arr` check below still catches an array that is
        // both sparse and extra-keyed (where the two counts can coincide).
        // Symbol-keyed and non-enumerable properties are deliberately not
        // counted — `JSON.stringify` ignores them as well.
        let ok = Object.keys(arr).length === arr.length;
        for (let i = 0; ok && i < arr.length; i++) {
            // `every` would skip holes, silently accepting a sparse array.
            if (!(i in arr) || !isJSONSafeValue(arr[i], seen)) {
                ok = false;
            }
        }
        seen.delete(v);
        return ok;
    }
    if (!isPlainObject(v))
        return false;
    seen.add(v);
    const ok = Object.keys(v).every((k) => isJSONSafeValue(v[k], seen));
    seen.delete(v);
    return ok;
}
// Deep-rewrite a redactor result into JSON-safe shape, substituting
// `REDACTION_NON_JSON_SAFE_SENTINEL` for every unsafe leaf (and for cyclic
// back-references). Only called after `isJSONSafeValue` rejected the value,
// so allocation here is the exceptional path. MUST stay in agreement with
// `isJSONSafeValue` on what counts as unsafe (see the note above it).
//
// One rejection class is repaired without a sentinel: an array's own
// enumerable non-index keys are simply dropped, because the array is
// rebuilt index-by-index — which is exactly what JSON persistence would
// have done to it, only now it happens once, visibly, and with a warning.
function normalizeToJSONSafe(v, seen) {
    if (v === null)
        return v;
    const t = typeof v;
    if (t === 'string' || t === 'boolean')
        return v;
    if (t === 'number') {
        return Number.isFinite(v) ? v : exports.REDACTION_NON_JSON_SAFE_SENTINEL;
    }
    if (t !== 'object')
        return exports.REDACTION_NON_JSON_SAFE_SENTINEL;
    if (seen.has(v))
        return exports.REDACTION_NON_JSON_SAFE_SENTINEL;
    if (Array.isArray(v)) {
        seen.add(v);
        const arr = v;
        const out = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            // `map` would preserve holes, so this loop is what actually repairs
            // a sparse array. Holes get the sentinel for the reason given above
            // `isJSONSafeValue`.
            out[i] = i in arr
                ? normalizeToJSONSafe(arr[i], seen)
                : exports.REDACTION_NON_JSON_SAFE_SENTINEL;
        }
        seen.delete(v);
        return out;
    }
    if (!isPlainObject(v))
        return exports.REDACTION_NON_JSON_SAFE_SENTINEL;
    seen.add(v);
    const out = Object.create(Object.getPrototypeOf(v));
    for (const k of Object.keys(v)) {
        safeDefine(out, k, normalizeToJSONSafe(v[k], seen));
    }
    seen.delete(v);
    return out;
}
// A breadcrumb for the warning above. Deliberately describes the *shape*
// only — the rejected value is precisely what the redactor was asked to
// keep out of the journal, so it must not appear in logs.
function describeNonJSONSafe(v) {
    if (typeof v === 'number')
        return 'non-finite number';
    if (typeof v === 'object' && v !== null) {
        if (Array.isArray(v)) {
            // A hole and a stowaway non-index key are both different failures
            // than an unsafe element, and naming them saves the reader from
            // hunting for a value that looks fine.
            const keyCount = Object.keys(v).length;
            if (keyCount < v.length)
                return 'sparse array (holes are not JSON values)';
            if (keyCount > v.length) {
                return 'array with non-index properties (dropped by JSON)';
            }
            return 'array containing a non-JSON-safe value';
        }
        if (isPlainObject(v))
            return 'object containing a non-JSON-safe or cyclic value';
        return `non-plain object (${v.constructor?.name ?? 'unknown'})`;
    }
    return typeof v;
}
function applyRedactions(state, redactions, contractName, 
// Optional out-parameter. When supplied, every redacted leaf that was
// actually written is recorded as `JSON-Pointer -> { original,
// replacement }` so callers can tell whether the *underlying* value
// changed even when its redacted projection is a constant. Passing a map
// is the only way to obtain this: the returned state deliberately keeps
// no trace of the original values.
//
// The recorded `original`s are live references into `state`, not copies.
// Treat the map as read-only, and consume it before `state` can change
// (see the aliasing note below).
sites) {
    const cloned = cloneValue(state);
    if (!redactions || redactions.length === 0)
        return cloned;
    // Read-only view used to resolve pre-redaction originals. Aliasing the
    // input rather than cloning it a second time is safe on two counts:
    // `walkAndRedact` writes exclusively into `cloned`, and every recorded
    // `original` is consumed synchronously by the caller (see `recordEvent`)
    // before control returns to the event loop. Cloning bought no temporal
    // isolation anyway (the copy was taken at the same instant as the reads)
    // while costing a second full-state deep clone per projection, i.e. four
    // per journaled event instead of two.
    const source = sites ? state : undefined;
    for (const r of redactions) {
        const segments = parseDottedPath(r.path);
        if (segments.length === 0)
            continue;
        walkAndRedact(cloned, source, segments, 0, r.redact, [], contractName, sites);
    }
    return cloned;
}
// Record a redacted leaf. When two directives match the same leaf the
// second redactor sees the first one's output, so we keep the *first*
// `original` (the true pre-redaction value, which is what change detection
// must compare) and the *last* `replacement` (what actually ends up in the
// journal).
function recordSite(sites, fullPath, original, replacement) {
    const pointer = segmentsToPointer(fullPath);
    const existing = sites.get(pointer);
    if (existing) {
        existing.replacement = replacement;
    }
    else {
        sites.set(pointer, { original, replacement });
    }
}
function walkAndRedact(parent, source, segments, i, redact, resolved, contractName, sites) {
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
        : ((0, turtledash_1.has)(parent, seg) ? [seg] : []);
    for (const k of keys) {
        const fullPath = [...resolved, k];
        if (isLast) {
            const container = parent;
            const value = container[k];
            const sourceValue = sites
                ? resolveAtSegments(source, fullPath)
                : undefined;
            const original = sourceValue?.found ? sourceValue.value : value;
            let replacement;
            try {
                // The path is handed over as a disposable copy: redactors are
                // contracted pure, but a mutating callback must not be able to
                // corrupt the site bookkeeping `recordSite` derives from
                // `fullPath` right below.
                replacement = redact(value, [...fullPath], contractName);
            }
            catch (e) {
                console.warn(`[chelonia][journal] redactor threw for path '${fullPath.join('.')}':`, e);
                replacement = exports.REDACTION_ERROR_SENTINEL;
            }
            if (!isJSONSafeValue(replacement, new Set())) {
                console.warn(`[chelonia][journal] redactor for path '${fullPath.join('.')}' returned a ` +
                    `non-JSON-safe value (${describeNonJSONSafe(replacement)}); ` +
                    'normalizing it to a JSON-safe equivalent');
                replacement = normalizeToJSONSafe(replacement, new Set());
            }
            // Write via `safeDefine` on objects: even though `cloneValue`
            // produced this container, defending against prototype-polluting
            // keys at the write site costs nothing and keeps the invariant
            // local. On arrays we validate the index and use bracket
            // assignment — arrays don't have string keys in JSON Patch, so a
            // non-integer key here is a bug, not a write to mishandle.
            if (Array.isArray(container)) {
                const idx = Number(k);
                if (Number.isInteger(idx) && idx >= 0 && idx < container.length) {
                    container[idx] = replacement;
                    if (sites)
                        recordSite(sites, fullPath, original, replacement);
                }
            }
            else {
                safeDefine(container, k, replacement);
                if (sites)
                    recordSite(sites, fullPath, original, replacement);
            }
        }
        else {
            walkAndRedact(parent[k], source, segments, i + 1, redact, fullPath, contractName, sites);
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
function shortHashRedactor(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value) ?? 'undefined';
    }
    catch {
        // Cyclic or otherwise unserializable — fall back to a tag of the type.
        serialized = `[unserializable:${typeof value}]`;
    }
    return (0, functions_js_1.blake32Hash)(serialized).slice(0, 8);
}
// ---------------------------------------------------------------------------
// Redacted-change markers
// ---------------------------------------------------------------------------
// Resolve a path against a value, reporting whether the location exists.
// Own properties only, same as the applier's walk.
function resolveAtSegments(root, segments) {
    const notFound = { found: false, value: undefined };
    let current = root;
    for (const seg of segments) {
        if (current === null || typeof current !== 'object')
            return notFound;
        if (Array.isArray(current)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx >= current.length)
                return notFound;
            current = readIndex(current, idx);
        }
        else {
            if (!(0, turtledash_1.has)(current, seg))
                return notFound;
            current = current[seg];
        }
    }
    return { found: true, value: current };
}
// Same, for callers that only hold a JSON Pointer (site-map keys).
function resolveAtPointer(root, pointer) {
    return resolveAtSegments(root, pointerToSegments(pointer));
}
function buildCoverageIndex(patch) {
    const paths = new Set();
    let wholeRoot = false;
    for (const p of patch) {
        const path = p?.path;
        if (typeof path !== 'string')
            continue;
        if (path === '') {
            wholeRoot = true;
            continue;
        }
        paths.add(path);
    }
    return { paths, wholeRoot };
}
function coveredByPatch(idx, pointer) {
    if (idx.wholeRoot)
        return true;
    if (idx.paths.has(pointer))
        return true;
    // Any ancestor of `pointer` replaced wholesale.
    for (let i = pointer.lastIndexOf('/'); i > 0; i = pointer.lastIndexOf('/', i - 1)) {
        if (idx.paths.has(pointer.slice(0, i)))
            return true;
    }
    return false;
}
// True when the underlying change at a redacted site is (at least partly)
// invisible in the site's redacted projection — i.e. the diff of the
// unredacted originals touches a pointer path that the diff of the
// redacted projections does not reproduce exactly.
//
// Why this replaces the old "descendant of the site already shows up in
// the patch" heuristic: for a container-returning redactor (e.g. keep
// `id`/`purpose`, hide `data`) a change to the *visible* part of the
// container must not suppress the marker for the hidden part, and a
// visible-only change must not *produce* one either. Comparing the two
// per-site diffs makes exactly that distinction.
//
// Only an exact path match counts as "visible". A projected *ancestor*
// operation is never accepted as covering an original descendant change:
// the visible paths live in the projection's path space while the original
// paths live in the source's, and a reshaping redactor (e.g.
// `(v) => ({ profile: v.profile.name })`) maps source leaves onto
// projected ancestor positions, so those spaces do not correspond. A
// projected ancestor op only proves that *something* inside that ancestor
// changed — not that the hidden descendant change is visible. Moreover,
// the built-in diff emits an op at an ancestor (instead of descending)
// exactly when the projection changed container shape there between before
// and after, which is precisely the lossy case where coverage cannot be
// established. "Hidden" is the conservative direction: markers are
// identity writes, so an extra one is noise while a suppressed one loses
// the only record of the hidden change. (Contrast `coveredByPatch`, where
// ancestor coverage IS sound: patch operations are real writes into the
// reconstructed state, not observations about a projection.)
//
// Always uses `defaultDiff`, never `cfg.diff`: this asks a question
// about RFC-6901 pointer paths within a single site, which is the same
// vocabulary the markers themselves are emitted in.
function hasHiddenChange(before, after) {
    const visiblePaths = defaultDiff(before.replacement, after.replacement);
    if (visiblePaths.some((p) => p.path === ''))
        return false;
    const visible = new Set(visiblePaths.map((p) => p.path));
    for (const { path } of defaultDiff(before.original, after.original)) {
        if (!visible.has(path))
            return true;
    }
    return false;
}
// Append an identity `replace` for every redacted leaf whose underlying
// value changed while its redacted projection stayed the same.
//
// Why this is safe for `reconstruct`: each appended operation writes the
// value that `redactedAfter` already holds at that location, and the
// operations are appended *after* the diff — which by construction turns
// `redactedBefore` into `redactedAfter`. So every marker is a no-op when
// replayed. Leaves that are absent from `redactedAfter` (e.g. an
// overlapping directive redacted an ancestor wholesale) are skipped rather
// than emitted, since a `replace` on a missing location would throw.
function synthesizeRedactedChangeOps(patch, beforeSites, afterSites, redactedAfter) {
    if (beforeSites.size === 0 || afterSites.size === 0)
        return patch;
    const idx = buildCoverageIndex(patch);
    const markers = [];
    for (const [pointer, after] of afterSites) {
        const before = beforeSites.get(pointer);
        // Absent before: the location is new, so the diff already emits an
        // `add` carrying the redacted value.
        if (before === undefined)
            continue;
        if (structurallyEqual(before.original, after.original))
            continue;
        // The change is already fully visible through the diff: the exact
        // location, or an ancestor replaced wholesale. O(pointer depth).
        if (coveredByPatch(idx, pointer))
            continue;
        // A container-returning redactor can leave visible changes (e.g. a
        // sibling field) alongside hidden ones; only mark when part of the
        // change is genuinely invisible in the projection.
        if (!hasHiddenChange(before, after))
            continue;
        const resolved = resolveAtPointer(redactedAfter, pointer);
        if (!resolved.found)
            continue;
        markers.push({
            op: 'replace',
            path: pointer,
            value: cloneValue(resolved.value),
            redacted: true
        });
    }
    if (markers.length === 0)
        return patch;
    return patch.concat(markers);
}
// ---------------------------------------------------------------------------
// SBP integration
// ---------------------------------------------------------------------------
// Default snapshot interval (X). The journal holds between X and 2X entries.
exports.DEFAULT_SNAPSHOT_INTERVAL = 50;
// The documented default journal block, in one place. `chelonia/_init` seeds
// the live config with it, and `chelonia/configure` reuses it both for the
// `journal: null` reset and for the no-prior-block fallback: three call sites
// that previously each carried their own copy of the literal and could drift
// apart.
//
// A factory rather than a shared constant: each caller must own its arrays,
// or one consumer's `contractIDs.push` would surface in another's config.
//
// Deliberately partial. The function fields (`diff`, `applyPatch`,
// `redactions[*].redact`) are left unset because `chelonia/configure` merges
// through a JSON deep-clone that would strip them; it reattaches them in a
// dedicated pass. `markRedactedChanges` is left unset because its default is
// *derived* from which `diff` / `applyPatch` pair is active (markers are
// RFC-6901 pointer ops, only meaningful for the built-ins), so
// `resolveJournalConfig` computes it instead of storing it. Adding either
// here would silently change that behaviour.
function defaultJournalConfig() {
    return {
        enabled: false,
        snapshotInterval: exports.DEFAULT_SNAPSHOT_INTERVAL,
        contractIDs: [],
        redactions: []
    };
}
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
        : exports.DEFAULT_SNAPSHOT_INTERVAL;
    const contractIDs = cfg?.contractIDs && cfg.contractIDs.length > 0
        ? new Set(cfg.contractIDs)
        : null;
    const redactions = cfg?.redactions ?? [];
    const diff = cfg?.diff ?? defaultDiff;
    const applyPatch = cfg?.applyPatch ?? defaultApplyPatch;
    // Opt-out rather than opt-in: a change hidden behind a constant redactor
    // is indistinguishable from "nothing happened", which defeats the point
    // of keeping a journal. But default on only while both halves of the
    // patch pipeline are the built-ins: markers are always emitted as
    // RFC-6901 pointer `replace` operations, which would be meaningless (or
    // actively harmful) inside a foreign patch format. An explicit boolean
    // always wins.
    const markRedactedChanges = cfg?.markRedactedChanges ?? (diff === defaultDiff && applyPatch === defaultApplyPatch);
    return {
        enabled,
        snapshotInterval,
        contractIDs,
        redactions,
        markRedactedChanges,
        diff,
        applyPatch
    };
}
function indexOfLastSnapshot(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].kind === 'snapshot')
            return i;
    }
    return -1;
}
// True for a snapshot that carries no state to seed a replay from.
//
// `state` is `null` whenever no projection could be produced for the event:
// the contract's post-state was `undefined` (a first message whose
// processing threw), or the configured `redactions` threw while projecting
// it. Such an entry is a faithful record of the event — it keeps the
// `error` / `redactionError` detail — but it is *not* a checkpoint: a
// following patch applied to a `null` root is rejected by
// `defaultApplyPatch` ("cannot apply … to non-container root"), which would
// turn a journal-side degradation into a `reconstruct` failure. Contract
// state is always a container, so a `null` snapshot state is unambiguously
// a placeholder and never a legitimate value.
//
// Both the recorder (which re-seeds instead of emitting a patch on top of
// one) and `chelonia/journal/reconstruct` (which refuses to seed from one)
// go through this single predicate, so the two can never disagree.
function isPlaceholderSnapshot(entry) {
    return entry.kind === 'snapshot' && entry.state == null;
}
// Index of the most recent snapshot usable as a replay seed, or -1.
// Placeholders are skipped rather than trusted: an older real snapshot
// still reconstructs to something, since patch entries form one continuous
// chain across the window and snapshots are redundant checkpoints within
// it, whereas a placeholder seed reconstructs to nothing at all.
function indexOfLastSeedSnapshot(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind === 'snapshot' && !isPlaceholderSnapshot(entry))
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
    // the patch it accompanies. The `postSnapshotState.state != null` gate
    // keeps us from materializing a placeholder snapshot (see
    // `isPlaceholderSnapshot`) when an errored event or a failed projection
    // lands on the boundary; in that case the auto-snapshot is simply
    // deferred to the next event that has a usable state.
    if (postSnapshotState &&
        postSnapshotState.state != null &&
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
            // If the patch entry that triggered this auto-snapshot was itself
            // an errored event, carry the error detail forward onto the
            // snapshot too. Otherwise, once `appendAndTrim` collapses the
            // window past the most recent snapshot, the `error` information
            // (which currently lives only on the trimmed-away patch entry)
            // would be lost. Keeping the snapshot and the patch in sync
            // guarantees error detail survives trimming on every code path.
            // The journal-side failure fields ride along for the same reason.
            if (entry.kind === 'patch' && entry.error !== undefined) {
                snap.error = entry.error;
            }
            if (entry.kind === 'patch' && entry.diffError !== undefined) {
                snap.diffError = entry.diffError;
            }
            if (entry.kind === 'patch' && entry.redactionError !== undefined) {
                snap.redactionError = entry.redactionError;
            }
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
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
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
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
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
            // Contract name (a.k.a. contract type, e.g. `gi.contracts/group`)
            // passed to user-supplied redactors so a single redaction directive
            // can branch on which contract the value comes from. Falls back to
            // an empty string if the bookkeeping entry has no `type` yet.
            const contractName = contractMeta.type ?? '';
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
            // preserved. Note how narrow this exemption is: it takes the hash
            // to match too, because a *different* event at that height is a
            // rewritten chain (handled as a resync below).
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
            //
            // A *different* event at the height we already journalled is the
            // third variant of the same problem: heights identify positions in
            // the chain, so two hashes at one height mean the chain was rewritten
            // under us (the duplicate-arrival check above already consumed the
            // benign same-hash case). The recorded window describes the abandoned
            // branch, so it gets dropped rather than patched onto.
            const isBackwards = lastEntry !== undefined && height < lastEntry.height;
            const isForwardGap = lastEntry !== undefined && height > lastEntry.height + 1;
            const isRewrite = lastEntry !== undefined && height === lastEntry.height;
            const isResync = isBackwards || isForwardGap || isRewrite;
            // A placeholder seed cannot carry a patch stream (see
            // `isPlaceholderSnapshot`), so re-seed with a snapshot on the next
            // event instead of anchoring patches on `null`. Unlike a resync this
            // is not a sign that the recorded window is stale, so the placeholder
            // is kept and the new snapshot appended after it: the failed event
            // stays on the record with its `error` / `redactionError` detail.
            const reseedAfterPlaceholder = lastEntry !== undefined &&
                !isResync &&
                isPlaceholderSnapshot(lastEntry);
            const isFirstOrResync = !existing || existing.length === 0 ||
                isResync || reseedAfterPlaceholder;
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
            // Redacted-leaf bookkeeping, used to detect changes that the redacted
            // projections hide (constant redactors such as `() => '[REDACTED]'`).
            // Only allocated when it can actually be used.
            //
            // These maps hold live references into `beforeState` / `afterState`
            // (see `applyRedactions`), so they MUST be consumed before this
            // function yields. Keep the path from the projections below to
            // `synthesizeRedactedChangeOps` synchronous: an `await` in between
            // would let the states move under the recorded originals.
            const trackRedactedChanges = cfg.markRedactedChanges &&
                cfg.redactions.length > 0 &&
                !willEmitEmptyPatch &&
                !isFirstOrResync;
            const beforeSites = trackRedactedChanges ? new Map() : undefined;
            const afterSites = trackRedactedChanges ? new Map() : undefined;
            // A throwing `redactions` set is a journal-side failure, not a
            // contract failure. Capture it so the entry can say so instead of
            // silently degrading into an entry that looks like a real change:
            // diffing against a missing projection emits a whole-root `add`
            // (before failed) or a whole-root replace-to-`null` (after failed),
            // the latter actively corrupting `reconstruct`. The two flags are
            // tracked separately because only an after-failure invalidates the
            // snapshot state hint below.
            let redactionError = null;
            let redactionAfterFailed = false;
            if (!willEmitEmptyPatch && !isFirstOrResync) {
                try {
                    redactedBefore = beforeState === undefined
                        ? undefined
                        : applyRedactions(beforeState, cfg.redactions, contractName, beforeSites);
                }
                catch (e) {
                    logJournalError('redaction (before) failed', e);
                    redactedBefore = undefined;
                    if (redactionError == null)
                        redactionError = e;
                }
            }
            try {
                redactedAfter = afterState === undefined
                    ? null
                    : applyRedactions(afterState, cfg.redactions, contractName, afterSites);
            }
            catch (e) {
                logJournalError('redaction (after) failed', e);
                redactedAfter = null;
                redactionAfterFailed = true;
                if (redactionError == null)
                    redactionError = e;
            }
            let nextEntries;
            if (isFirstOrResync) {
                // First event for this contract OR a resync: emit a snapshot only.
                // If processing errored on this event we still attach the
                // normalized `{ name, message }` so the failure detail isn't lost
                // on the first-event / resync paths (patch entries preserve it
                // via `entry.error`; snapshots need the same affordance to keep
                // the journal a faithful record of every event).
                const snap = Object.create(null);
                snap.kind = 'snapshot';
                snap.hash = hash;
                snap.height = height;
                snap.opType = opType;
                snap.description = description;
                snap.state = redactedAfter;
                if (processingErrored && processingError != null) {
                    snap.error = normalizeProcessingError(processingError);
                }
                // A projection failure leaves `state: null`. Label it, or the
                // snapshot is indistinguishable from the legitimate "post-state
                // was undefined because the mutation threw" null. Either way the
                // entry is a placeholder, so the *next* event re-seeds again (see
                // `reseedAfterPlaceholder`) instead of stacking patches on it.
                if (redactionError != null) {
                    snap.redactionError = normalizeProcessingError(redactionError);
                }
                // A resync invalidates everything recorded so far, so the window
                // collapses to this snapshot alone. Re-seeding after a placeholder
                // does not: the recorded history is still valid, we just need a
                // usable checkpoint, so the snapshot is appended (and the window
                // trimmed as usual, which bounds a run of failing events).
                nextEntries = reseedAfterPlaceholder && existing
                    ? appendAndTrim(existing, snap, cfg.snapshotInterval, null)
                    : [snap];
            }
            else {
                let patch;
                let diffError = null;
                if (processingErrored) {
                    // Empty patch is itself a diagnostic signal. Skip redaction
                    // entirely above by short-circuiting the diff here.
                    patch = [];
                }
                else if (redactionError != null) {
                    // One of the projections is missing. Diffing against it would
                    // fabricate a whole-root operation: an `add` of the entire
                    // state (before failed) or a replace-to-`null` that wipes the
                    // reconstructed state (after failed). Record nothing and let
                    // `entry.redactionError` carry the reason instead.
                    patch = [];
                }
                else {
                    let diffFailed = false;
                    try {
                        patch = cfg.diff(redactedBefore, redactedAfter);
                    }
                    catch (e) {
                        logJournalError('diff failed', e);
                        patch = [];
                        diffFailed = true;
                        diffError = e;
                    }
                    // A value that changed behind a constant redactor produces no
                    // diff at all. Record it explicitly so the journal can tell
                    // "redacted value changed" apart from "event did nothing" and
                    // from "event failed". The appended operations are identity
                    // writes, so `reconstruct` is unaffected — but only if the diff
                    // they ride on is itself trustworthy, hence the `diffFailed`
                    // guard: on a failed diff the replayed state is already stale
                    // and a marker could then target a location that doesn't exist.
                    if (trackRedactedChanges && !diffFailed && beforeSites && afterSites) {
                        try {
                            patch = synthesizeRedactedChangeOps(patch, beforeSites, afterSites, redactedAfter);
                        }
                        catch (e) {
                            logJournalError('redacted-change marking failed', e);
                        }
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
                // Journal-side failures. Both mean "the journal could not record
                // what changed", which `patch: []` alone cannot express — it is
                // also what a no-op event records. `diffError` and
                // `redactionError` are mutually exclusive: a redaction failure
                // skips the diff entirely. `error` is orthogonal and never
                // co-occurs with `diffError` (an errored event skips the diff),
                // but it *can* co-occur with `redactionError`: only the
                // before-projection is skipped for an errored event, while the
                // after-projection always runs so `appendAndTrim` has a state to
                // materialize a boundary snapshot from — a throwing redactor is
                // therefore still reachable and labels the entry as well.
                if (diffError != null) {
                    entry.diffError = normalizeProcessingError(diffError);
                }
                if (redactionError != null) {
                    entry.redactionError = normalizeProcessingError(redactionError);
                }
                nextEntries = appendAndTrim(existing, entry, cfg.snapshotInterval, 
                // A failed *after*-projection means `redactedAfter` is a
                // placeholder `null`, not the real state: snapshotting it would
                // anchor `reconstruct` on a bogus state once trimming discards
                // everything before it. Skip the boundary snapshot in that case
                // (same deferral the errored-event path relies on). A failed
                // before-projection leaves `redactedAfter` valid and usable.
                redactionAfterFailed ? null : { state: redactedAfter });
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
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
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
    // empty / has no snapshot with a usable state to seed from — see
    // `isPlaceholderSnapshot`). Throws `ChelErrorJournalCorrupt`
    // if a recorded patch fails to apply: this is a debugging tool and a
    // self-check, so a loud failure is preferable to silently returning
    // `undefined` (which would be indistinguishable from "no journal"). The
    // thrown error's `cause` is the underlying applier error and its
    // `entryIndex` property points at the offending entry for inspection.
    'chelonia/journal/reconstruct': function (contractID) {
        const cfg = resolveJournalConfig(this.config.journal);
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const entries = rootState?.contracts?.[contractID]?._journal?.entries;
        if (!entries || entries.length === 0)
            return undefined;
        // Placeholder snapshots are skipped rather than replayed from: their
        // `null` state would make the very next patch throw
        // `ChelErrorJournalCorrupt`, reporting corruption for what is only a
        // recorded gap. Returning the older reconstruction (or `undefined`)
        // keeps the promised behaviour of a journal-side failure: stale data,
        // never a spurious error. Journals written by earlier versions of this
        // module can contain such a snapshot mid-window, hence the search
        // rather than a check of the last one.
        const startIdx = indexOfLastSeedSnapshot(entries);
        if (startIdx < 0)
            return undefined;
        const snap = entries[startIdx];
        let state = snap.state;
        for (let i = startIdx + 1; i < entries.length; i++) {
            const e = entries[i];
            // Snapshots in the tail are redundant checkpoints on the same patch
            // chain (or skipped placeholders), so replaying past them is safe.
            if (e.kind !== 'patch')
                continue;
            try {
                state = cfg.applyPatch(state, e.patch);
            }
            catch (err) {
                logJournalError(`reconstruct failed at entry ${i}`, err);
                const corruptErr = new errors_js_1.ChelErrorJournalCorrupt(`journal reconstruct failed for contract ${contractID} at entry ${i}: ` +
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
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
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
