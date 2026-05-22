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
                     // first-message processing)
      error?: { name: string; message: string } // set if processMutation threw
                                                // on a first-event / resync /
                                                // forward-gap snapshot
    }
  | {
      kind: 'patch'
      hash: string; height: number; opType: string
      description?: string
      patch: JournalPatch[]
      error?: { name: string; message: string } // set if processMutation threw
    }
```

`description` is **optional**: `chelonia/private/journal/recordEvent`
wraps `SPMessage.description()` in a `try`/`catch` and falls back to
`undefined` if it throws. Don't assume it's always present.

`JournalPatch` is RFC-6902-compatible (only `add` / `remove` /
`replace`), with RFC-6901 JSON-Pointer paths. Root-removal is
represented as `{ op: 'replace', path: '', value: null }` because
RFC-6902 doesn't define root-remove.

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
  - **Not mutate** `value`,
  - Return the replacement.

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

### Redaction scope

Redactions cover **`state` only**. The `description` field on each
journal entry is a copy of `SPMessage.description()` and is **not**
redacted. For unencrypted ops `description()` can echo action data —
treat the journal at the same trust level as the description output.
If you need to scrub descriptions, strip them after reading via
`chelonia/journal/get`.

The `error.name` / `error.message` fields on failed-event patches are
also **not** redacted. Strip them downstream if leakage is a concern.

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
path the recorder emits.

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
    } else {
      console.log(`[diff] @${e.height} ${e.opType} +${e.patch.length} ops`)
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
