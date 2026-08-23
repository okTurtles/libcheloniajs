# Contract journal

Chelonia can keep an optional per-contract **journal** of every event
applied to a contract's state. For each processed event the journal
records:

- The event's identity (`hash`, `height`, `opType`, `description`),
- A strict-subset RFC-6902 JSON Patch diff between the contract state
  **before** and **after** processing,
- Periodic full snapshots so the journal stays bounded and the state
  at HEAD remains reconstructible.

The journal is **opt-in**: `enabled` defaults to `false`. Turn it on
via `chelonia/configure` (see [`configure.md`](./configure.md)).

---

## Table of contents

1. [Why journal](#why-journal)
2. [Enabling and tuning the journal](#enabling-and-tuning-the-journal)
3. [Public selectors](#public-selectors)
4. [Redactions](#redactions)
5. [Resync, gaps, and failed events](#resync-gaps-and-failed-events)
6. [Storage layout and observability](#storage-layout-and-observability)
7. [Custom `diff` / `applyPatch`](#custom-diff--applypatch)
8. [Full example: enable, read, reconstruct, clear](#full-example-enable-read-reconstruct-clear)

---

## Why journal

The journal is useful for:

- **Audit logs / debugging**: replay exactly what happened to a
  contract's state, including ops that failed processing.
- **Time-travel views**: reconstruct historical state without
  re-syncing from the relay server.
- **Compliance**: keep a redacted record of state mutations while
  scrubbing sensitive fields before they hit disk.

It is **not** a backup of contract messages — it records *state diffs
after processing*, not raw signed events. Use `chelonia.db/*` for
message persistence.

---

## Enabling and tuning the journal

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'
import { shortHashRedactor, defaultDiff, defaultApplyPatch, DEFAULT_SNAPSHOT_INTERVAL } from '@chelonia/lib'
// Equivalent, for consumers that want to tree-shake just the journal helpers:
//   import { shortHashRedactor, defaultDiff, defaultApplyPatch, DEFAULT_SNAPSHOT_INTERVAL } from '@chelonia/lib/journal'

await sbp('chelonia/configure', {
  journal: {
    enabled: true,
    snapshotInterval: 50,        // default DEFAULT_SNAPSHOT_INTERVAL
    contractIDs: [],             // empty = all contracts; or whitelist a subset
    redactions: [
      { path: 'profiles.*.email', redact: shortHashRedactor },
      { path: 'secrets.apiKey', redact: () => '[REDACTED]' }
    ],
    markRedactedChanges: true,   // default while diff/applyPatch are the built-ins
    diff: defaultDiff,           // optional override
    applyPatch: defaultApplyPatch // optional override
  }
})
```

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch. Must be a literal boolean. |
| `snapshotInterval` | `50` | Snapshot every N patches; trim to most recent snapshot at `2N`. Non-positive / non-integer values fall back to `50` with a `console.warn`. |
| `contractIDs` | `[]` (all) | Whitelist a subset. Stored via `.slice()`. |
| `redactions` | `[]` | `{ path, redact }` directives applied before diffing. Deep-copied. |
| `markRedactedChanges` | `true`* | Record changes that a constant redactor would otherwise hide. Must be a literal boolean. *Derived: defaults to `true` only while both `diff` and `applyPatch` are the built-ins, `false` otherwise. An explicit value always wins. |
| `diff` | `defaultDiff` | RFC-6902 subset diff implementation. |
| `applyPatch` | `defaultApplyPatch` | Patch applier used by `chelonia/journal/reconstruct`. |

See [`configure.md`](./configure.md#journal-configuration) for the
per-field validation and reconfigure rules.

### Snapshot cadence

With `snapshotInterval = N` the journal contains between `N` and `2N`
entries per active contract:

1. The first event records a `snapshot`.
2. Subsequent events record `patch` entries.
3. After `N` patches, a fresh `snapshot` is recorded.
4. Once the journal reaches `2N` entries, everything before the most
   recent snapshot is trimmed.

The first entry is **always** a snapshot, so
`chelonia/journal/reconstruct` can rebuild HEAD state by replaying
patches over it.

---

## Public selectors

All three are registered by importing `@chelonia/lib`.

### `chelonia/journal/get(contractID): { entries: JournalEntry[] } | undefined`

Returns a deep clone of the contract's journal block, or `undefined`
if the contract has no journal.

```js
const journal = sbp('chelonia/journal/get', contractID)
journal?.entries.forEach((e) => {
  if (e.kind === 'snapshot') console.log('snap @', e.height, e.opType)
  else console.log('patch @', e.height, e.patch.length, 'ops')
})
```

`JournalEntry` is a discriminated union:

```ts
type JournalEntry =
  | {
      kind: 'snapshot'
      hash: string; height: number; opType: string
      description?: string
      state: unknown // redacted clone of post-event state; null if
                     // the contract state was undefined (e.g., failed
                     // first-message processing) or if `redactions` threw
      error?: { name: string; message: string } // set if processMutation threw
                                                // on a first-event / resync /
                                                // forward-gap snapshot
      redactionError?: { name: string; message: string } // set if `redactions` threw
      diffError?: { name: string; message: string }      // carried forward from the
                                                         // patch entry at a boundary
    }
  | {
      kind: 'patch'
      hash: string; height: number; opType: string
      description?: string
      patch: JournalPatch[]
      error?: { name: string; message: string } // set if processMutation threw
      diffError?: { name: string; message: string }      // set if `diff` threw
      redactionError?: { name: string; message: string } // set if `redactions` threw
    }
```

`description` is **optional**: `chelonia/private/journal/recordEvent`
wraps `SPMessage.description()` in a `try`/`catch` and falls back to
`undefined` if it throws. Don't assume it's always present.

`JournalPatch` is RFC-6902-compatible (only `add` / `remove` /
`replace`), with RFC-6901 JSON-Pointer paths. Root-removal is
represented as `{ op: 'replace', path: '', value: null }` because
RFC-6902 doesn't define root-remove.

`replace` operations may additionally carry `redacted: true` — see
[Changes behind a constant redactor](#changes-behind-a-constant-redactor).
RFC-6902 §4 requires appliers to ignore members it doesn't define, so
the marker is safe to hand to any conformant JSON Patch library.

### `chelonia/journal/reconstruct(contractID): unknown | undefined`

Replays the journal from its most recent snapshot to recover the
contract's HEAD state, with `redactions` already applied. Returns
`undefined` if there is no journal for `contractID`, **or** if the
stored journal is empty / contains no snapshot to seed from.

Throws `ChelErrorJournalCorrupt` (with `entryIndex`, `contractID`, and
`cause`) if a recorded patch fails to apply.

```js
import { ChelErrorJournalCorrupt } from '@chelonia/lib'

try {
  const state = sbp('chelonia/journal/reconstruct', contractID)
  console.log('redacted HEAD state:', state)
} catch (e) {
  if (e instanceof ChelErrorJournalCorrupt) {
    console.warn('journal corrupt at entry', e.entryIndex, '— clearing')
    sbp('chelonia/journal/clear', contractID)
  } else throw e
}
```

### `chelonia/journal/clear(contractID?): number`

Clears one contract's journal, or **all** journals if called with no
argument. Returns the number of contracts cleared.

```js
sbp('chelonia/journal/clear', contractID) // clear one
sbp('chelonia/journal/clear')             // clear all
```

You'll typically want to call this:

- When you genuinely change the `redactions` semantics (Chelonia does
  *not* auto-clear — see [`configure.md`](./configure.md#journal-reconfigure-rules)).
- When `chelonia/journal/reconstruct` reports corruption.
- On logout, before the next user signs in (or use `chelonia/reset`
  which clears state more broadly).

---

## Redactions

Redactions are applied to both the **before**-state and the
**after**-state *before* diffing. That means the journal never holds
the raw value of a redacted field — and `reconstruct` returns the
already-redacted view.

```js
{ path: 'profiles.*.email', redact: shortHashRedactor }
```

- `path` is a dotted segment list (`a.b.c`). `*` matches any single
  key or array index.
- `redact(value, fullPath, contractName)` MUST:
  - Be pure (no I/O, no side-effects),
  - **Not mutate** `value` or `fullPath` (`fullPath` is a disposable
    copy anyway — mutating it cannot corrupt the journal's
    bookkeeping, but don't rely on that),
  - Return a **JSON-safe** replacement: `null`, strings, booleans,
    finite numbers, and arrays / plain objects thereof.

Non-JSON-safe results (`undefined`, `BigInt`, symbols, functions,
non-finite numbers, class instances, cycles, and holes in a sparse
array) are replaced with the string sentinel
`'[REDACTION_NON_JSON_SAFE]'` (exported as
`REDACTION_NON_JSON_SAFE_SENTINEL`) and a warning is logged — the
description names the offending path and the value's *shape* only,
never the value itself. Container results are normalized deeply, so a
JSON-safe projection with one unsafe leaf keeps its structure:

```js
// redact returns { id: 1, raw: <function> }
// journal stores   { id: 1, raw: '[REDACTION_NON_JSON_SAFE]' }
```

Why the strictness: the journal is serialized by whatever persistence
layer snapshots `state.contracts`, and `JSON.stringify` drops
`undefined` members, renders `NaN` / `Infinity` as `null`, and throws
on `BigInt` and cycles. Letting such values in would corrupt
`chelonia/journal/reconstruct` after a reload. The requirement is a
*lossless* round-trip rather than a successful `JSON.stringify`, which
is why values that do serialize but come back reshaped — a `Date`
becomes a string, an array hole becomes `null` — are rejected as well.

Holes in contract state itself are treated differently: they are data
rather than caller error, so the journal reads them as `null` (their
exact JSON equivalent) instead of flagging them. See
[Supported state shape](#supported-state-shape).

### Built-in redactors

- **`shortHashRedactor(value)`** — returns the first 8 characters of
  the base58btc blake2b-256 hash of `JSON.stringify(value)`. Good for
  high-entropy values (emails, UUIDs, contract IDs). **Trivially
  reversible for low-entropy values** (booleans, small ints, short
  enums) — anyone with the journal and the contract schema can
  precompute the mapping.

For low-entropy fields, use a constant sentinel:

```js
{ path: 'profiles.*.role', redact: () => '[REDACTED]' }
```

### Low-level redaction helpers

These are exported for people building a **custom diff pipeline** (a
`diff` / `applyPatch` pair that needs to reproduce the built-in
redaction behaviour). Normal use of the journal never calls them: the
recorder applies redactions, detects hidden changes and emits markers
on its own.

#### `applyRedactions(state, redactions, contractName, sites?)`

Deep-clones `state` and applies each `{ path, redact }` directive to
the clone, returning the redacted projection. Never mutates `state`. A
throwing redactor is caught and its leaf becomes
`REDACTION_ERROR_SENTINEL`; a non-JSON-safe result becomes
`REDACTION_NON_JSON_SAFE_SENTINEL` (see above).

Pass a `RedactionSiteMap` (a plain `Map`) as `sites` to learn what was
redacted where: each redacted leaf is recorded as its JSON Pointer
mapped to `{ original, replacement }`. This is the only way to recover
that information, because the returned projection deliberately keeps no
trace of the originals.

> `original` is a **live reference** into `state`, not a copy. Treat
> the map as read-only and read it before `state` can change.

#### `hasHiddenChange(before, after)`

Takes two `RedactionSite`s for the *same* pointer (one from the
before-projection's site map, one from the after-projection's) and
returns `true` when some path of the diff between the two `original`s
is not exactly reproduced by the diff between the two `replacement`s —
the leaf case being "the underlying value changed while its redacted
projection did not". Two consequences worth knowing: a change to a
*visible sibling* alongside a hidden one still returns `true` (both
diffs are non-empty but do not coincide), and a projection that changed
wholesale at its root returns `false`. Note `synthesizeRedactedChangeOps`
additionally suppresses markers the outer diff already covers, so
`hasHiddenChange(...) === true` alone does not guarantee a marker.

#### `synthesizeRedactedChangeOps(patch, beforeSites, afterSites, redactedAfter)`

Given a diff and the two site maps, returns the patch with an identity
`replace` carrying `redacted: true` appended for every hidden change
that the diff did not already cover (`redactedAfter` is the redacted
after-projection, used to read the value each marker writes back over
itself). This is what produces the markers described in [Changes behind
a constant redactor](#changes-behind-a-constant-redactor).

#### `structurallyEqual(a, b)`

Deep equality defined as "`defaultDiff(a, b)` would be empty": own keys
only, `NaN` equals `NaN`, array holes compare as `null`, `undefined` on
one side only is a difference, and non-plain containers (`Date`, `Map`,
class instances) are equal only by reference. A custom pipeline that
substitutes its own equality must keep it in lock-step with its own
diff, or markers will either invent churn or keep hiding real changes.

### Changes behind a constant redactor

A constant redactor maps every value to the same output, so the
before- and after-states look identical at that path and a plain diff
emits nothing. The event would then be indistinguishable from one that
did nothing at all — or from one that failed.

Chelonia therefore records such changes explicitly, as an **identity
edit** flagged with `redacted: true`:

```js
{
  kind: 'patch',
  hash: 'h7', height: 7, opType: 'ae',
  patch: [
    { op: 'replace', path: '/secrets/apiKey', value: '[REDACTED]', redacted: true }
  ]
}
```

Read it as "the value at this path changed, but its journal projection
cannot show how". The operation writes back the value already stored
at that location, so replaying it is a no-op and
`chelonia/journal/reconstruct` is unaffected.

Each event gets its own marker — three consecutive writes produce three
patch entries with one marker each, and an event that leaves the value
alone produces none. The journal does not grow beyond its normal
cadence.

Details worth knowing:

- The decision is made by comparing the **unredacted** values on both
  sides. Those values are only compared, never stored: the journal
  still holds nothing but redacted output.
- No marker is emitted when the change is already visible — because
  the redactor is value-dependent (e.g. `shortHashRedactor`), because
  the key was added or removed, or because a surrounding subtree was
  replaced wholesale.
- Container-returning redactors (e.g. keep `id`/`purpose`, hide `data`)
  are handled per-field: a change to the hidden part is marked even when
  a sibling field in the same container is also changing, and no marker
  is invented when only the visible part changed. This holds exactly
  while the redactor preserves the container's path shape. A *reshaping*
  redactor (e.g. `(v) => ({ profile: v.profile.name })`) breaks the
  correspondence between source paths and projected paths, so hidden
  changes under a visibly changed projected ancestor are still marked —
  and, since the projection then provides no way to verify the hidden
  parts, detection is conservative: a visible-only change under a lossy
  projection may also be marked. An extra marker is a no-op; a
  suppressed one would lose the only record of a hidden change.
- **Overlapping directives are supported, but their projected output is
  order-sensitive.** Each redactor still sees the result of earlier
  directives, while change detection compares each recorded site with its
  untouched pre-redaction value. If a later ancestor replaces a subtree
  containing an earlier redacted leaf, the ancestor site records the hidden
  change and the final projected value follows the configured order.
- Failed events are unaffected: they still record `patch: []` plus
  `error` (see [Failed events](#failed-events)). An empty patch is never
  ambiguous — five cases are distinguishable: a no-op event (`patch: []`,
  no error fields), a redacted change (`redacted: true` marker), a
  processing failure (`error`), a journal diff failure (`diffError`), and
  a journal redaction failure (`redactionError`). The last two are
  described under [Journal-side failures](#journal-side-failures).
- Arrays are diffed by index, so removing an element shifts its
  successors and a redacted element that merely moved can surface as a
  marker.
- Set `markRedactedChanges: false` to opt out and get the minimal diff
  instead. You normally don't need to: the default is derived from the
  active patch pipeline (see below), so installing a custom `diff` /
  `applyPatch` pair turns markers off automatically. Set it back to
  `true` only if your custom format also speaks RFC-6901 pointers.

### Redaction scope

Redactions cover **`state` only**. The `description` field on each
journal entry is a copy of `SPMessage.description()` and is **not**
redacted. For unencrypted ops `description()` can echo action data —
treat the journal at the same trust level as the description output.
If you need to scrub descriptions, strip them after reading via
`chelonia/journal/get`.

The `error.name` / `error.message` fields on failed-event patches are
also **not** redacted, and neither are `diffError` / `redactionError`.
Strip them downstream if leakage is a concern.

---

## Resync, gaps, and failed events

The journal recorder watches each event's `height` to decide between
three cases:

| Case | Action |
|---|---|
| `height < lastEntry.height` (strict backwards) | Resync detected. Journal is collapsed to a fresh snapshot. |
| `height > lastEntry.height + 1` (gap) | Also treated as a resync — entries are missing (e.g. journaling was toggled off and back on, or `contractIDs` was widened). Cached `before`-state no longer matches, so producing a patch would corrupt `reconstruct`. Re-seeds with a snapshot. |
| `height === lastEntry.height` (duplicate) | Ignored; journal unchanged. |
| `height === lastEntry.height + 1` (normal) | Patch entry recorded. |

### Failed events

If `processMutation` throws and Chelonia discards the mutation, the
recorder still emits an entry — empty `patch: []` plus an additional
`error: { name, message }` field copied from the captured `Error`:

```js
{
  kind: 'patch',
  hash: 'h7', height: 7, opType: 'ae',
  patch: [],
  error: { name: 'ChelErrorSignatureError', message: '...' }
}
```

The same `error: { name, message }` field is attached to **snapshot**
entries when the failure lands on a snapshot path — i.e. the first
event for a contract, or a resync / forward-gap re-seed (see
[Resync, gaps, and failed events](#resync-gaps-and-failed-events)). Without this, the error detail
would be silently lost on those three paths because they emit only a
snapshot and no accompanying patch entry.

```js
{
  kind: 'snapshot',
  hash: 'h0', height: 0, opType: 'c',
  state: null, // post-state was undefined because the mutation threw
  error: { name: 'ChelErrorSignatureError', message: '...' }
}
```

This makes failed events distinguishable from no-op events on every
path the recorder emits. Changes hidden behind a constant redactor are
distinguishable too, via a separate mechanism — see
[Changes behind a constant redactor](#changes-behind-a-constant-redactor).

### Journal-side failures

A configured `diff` or `redactions` set can throw on its own, while the
event itself processed perfectly well. That is a *journal-side* failure:
the recorder swallows it (recording never throws), records `patch: []`,
and labels the entry so the empty patch is not misread as "this event
changed nothing".

| Field | Meaning |
|---|---|
| `diffError` | The configured `diff` threw. |
| `redactionError` | A redactor threw *outside* the per-leaf guard — i.e. the whole projection failed, not a single leaf (a throwing leaf redactor yields `REDACTION_ERROR_SENTINEL` instead and is not a failure). |

```js
{
  kind: 'patch',
  hash: 'h4', height: 4, opType: 'ae',
  patch: [],
  redactionError: { name: 'TypeError', message: '...' }
}
```

On a redaction failure the diff is skipped entirely rather than run
against a missing projection: doing otherwise would fabricate a
whole-root `add` of the entire state (before-projection failed) or a
whole-root replace-to-`null` (after-projection failed), the latter
corrupting `reconstruct` outright. `diffError` and `redactionError` are
therefore mutually exclusive.

Both are **degradations, not corruptions**: the affected event's changes
are missing from the patch stream, so `reconstruct` returns the last
good state until the next snapshot re-seeds the window (bounded by
`2 * snapshotInterval` entries). When the *after*-projection is the one
that failed, the boundary auto-snapshot is deferred — snapshotting the
placeholder `null` would anchor the window on a bogus state once
trimming discards everything before it. Snapshot entries carry
`redactionError` too, which is what distinguishes a `state: null`
snapshot caused by a failed projection from one caused by an undefined
post-state.

### Recording is non-throwing

The recorder is wrapped in a top-level `try`/`catch` and MUST NOT
throw — a journal bug can never break event handling.

---

## Storage layout and observability

The journal is stored at `state.contracts[contractID]._journal`,
alongside `HEAD` / `height` / `previousKeyOp` (not on the contract's
own state). It is serialized by any persistence layer that snapshots
that subtree.

### Disk footprint

With `enabled: true`, expect per active contract:

- Up to **two redacted full-state snapshots**,
- Plus up to ~`snapshotInterval` patch entries.

Tune `snapshotInterval` down (or set `enabled: false`) if state size
is a concern.

### Consumer-visible leakage

Because `_journal` is an own property of `state.contracts[contractID]`,
it travels with anything exposing that subtree:

- **`chelonia/contract/fullState`** returns
  `cheloniaState: rootState.contracts[contractID]` verbatim.
- **`EVENT_HANDLED` listeners** that snapshot `state.contracts` (e.g.
  the Vuex mirror set up by `chelonia/externalStateSetup`) receive the
  journal too.

Treat the journal as in-band with the rest of the bookkeeping subtree.
If you need a journal-free view, project it out client-side:

```js
const { _journal, ...cheloniaStateWithoutJournal } = cheloniaState
```

TypeScript consumers: `_journal` is typed as optional on the
bookkeeping subtree (`{ entries: JournalEntry[] } | undefined`), so
the destructured `_journal` is `undefined` whenever the contract
never enabled journaling. Ignore the binding (or `void _journal`) if
your lint config flags unused destructured names.

The journal API itself remains accessible via `chelonia/journal/get`.

### Supported state shape

The journal's deep-clone is **JSON-shape only**. `Date` / `Map` /
`Set` / `Buffer` / class instances inside contract state are passed
through *by reference* rather than copied. In-place mutation of such
values would retroactively mutate prior journal entries and confuse
the `before === after` short-circuit in the diff.

Either:

- Keep contract state plain JSON, or
- Swap in a `structuredClone`-based `diff`/`applyPatch` override (see
  next section).

Two JSON-shape details worth knowing:

- **Array holes read as `null`.** A sparse array (`[1, , 3]`) has no
  JSON representation; `JSON.stringify` writes `null` in the hole. The
  journal does the same when cloning, diffing and comparing state, so a
  hole can never be mistaken for a missing index — which would
  otherwise produce an insert/delete that shifts every later element and
  leave `reconstruct` returning an array of the wrong length.
- **Own keys explicitly set to `undefined` do not survive replay.** The
  journal's clone keeps them faithfully (`{ a: undefined }` clones to
  `{ a: undefined }`, so a same-session `chelonia/journal/get` snapshot
  still has the key), but `defaultDiff` treats `undefined` as "absent"
  — matching `JSON.stringify`, where `{ a: undefined }` serializes to
  `{}` — so `reconstruct` never produces them. State that needs to
  distinguish "absent" from "present but undefined" must supply a custom
  `diff` / `applyPatch`.

---

## Custom `diff` / `applyPatch`

```ts
import type { JournalPatch } from '@chelonia/lib'

const structuredDiff = (before: unknown, after: unknown): JournalPatch[] => {
  // Your implementation here. Must return an RFC-6902-compatible patch
  // array (Chelonia restricts to add/remove/replace by convention).
}

const structuredApply = (state: unknown, patches: JournalPatch[]): unknown => {
  // Your applier here. Must be pure.
}

await sbp('chelonia/configure', {
  journal: { diff: structuredDiff, applyPatch: structuredApply }
})
```

Redacted-change markers are `{ op: 'replace', path, value, redacted: true }`
operations with an RFC-6901 pointer path, so they are only meaningful to
the built-in patch pipeline. Because of that, `markRedactedChanges`
defaults to `true` only while both `diff` and `applyPatch` are the
built-ins: as soon as you install a custom pair the default flips to
`false`, so no foreign pointer ops are appended to your patch format.
Pass `markRedactedChanges: true` explicitly if your custom format also
speaks RFC-6901 pointers and you want the markers back.

To revert to the built-ins after a swap, pass them explicitly:

```js
import { defaultDiff, defaultApplyPatch } from '@chelonia/lib'
await sbp('chelonia/configure', {
  journal: { diff: defaultDiff, applyPatch: defaultApplyPatch }
})
```

(Or use `journal: null` to reset the whole block to disabled
defaults — which also wipes existing journals.)

---

## Full example: enable, read, reconstruct, clear

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'
import {
  shortHashRedactor,
  defaultDiff,
  defaultApplyPatch,
  ChelErrorJournalCorrupt,
  DEFAULT_SNAPSHOT_INTERVAL
} from '@chelonia/lib'

// 1. Enable journaling. (See configure.md for the rest of the config.)
await sbp('chelonia/configure', {
  // ... other configuration (connectionURL, contracts, hooks, etc.) ...
  journal: {
    enabled: true,
    snapshotInterval: 25,
    contractIDs: [],
    redactions: [
      { path: 'profiles.*.email', redact: shortHashRedactor },
      { path: 'secrets.*',        redact: () => '[REDACTED]' }
    ],
    markRedactedChanges: true,
    diff: defaultDiff,
    applyPatch: defaultApplyPatch
  }
})

// ... bootstrap your contracts, sync them, send actions ...
//     (see docs/configure.md for the full bootstrap example)

// 2. Read the journal for a contract.
const journal = sbp('chelonia/journal/get', contractID)
if (journal) {
  for (const e of journal.entries) {
    if (e.kind === 'snapshot') {
      console.log(`[snap] @${e.height} ${e.opType} (${e.hash})`)
    } else if (e.error) {
      console.log(`[err ] @${e.height} ${e.opType}: ${e.error.name}: ${e.error.message}`)
    } else if (e.diffError || e.redactionError) {
      const j = e.diffError ?? e.redactionError
      console.log(`[jrnl] @${e.height} ${e.opType}: not recorded: ${j.name}: ${j.message}`)
    } else {
      const hidden = e.patch.filter((p) => p.redacted).length
      console.log(
        `[diff] @${e.height} ${e.opType} +${e.patch.length} ops` +
        (hidden ? ` (${hidden} redacted)` : '')
      )
    }
  }
}

// 3. Reconstruct redacted HEAD state without re-syncing.
try {
  const head = sbp('chelonia/journal/reconstruct', contractID)
  console.log('redacted HEAD:', head)
} catch (e) {
  if (e instanceof ChelErrorJournalCorrupt) {
    console.warn(`corrupt at entry ${e.entryIndex} — clearing`)
    sbp('chelonia/journal/clear', contractID)
  } else {
    throw e
  }
}

// 4. Clear one contract's journal (e.g. before sharing fullState off-device).
sbp('chelonia/journal/clear', contractID)

// 5. Clear all journals.
sbp('chelonia/journal/clear')

// 6. Stop journaling entirely. Resets the journal config block to
//    disabled defaults AND wipes every persisted journal.
await sbp('chelonia/configure', { journal: null })
```

For the full configuration surface (and the rest of the
`chelonia/configure` selector), see [`configure.md`](./configure.md).
