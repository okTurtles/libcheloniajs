# AGENTS.md

Guide for AI agents working in the `@chelonia/lib` codebase.

## Project Overview

`@chelonia/lib` is a TypeScript library for building end-to-end encrypted (E2EE), federated applications using [Shelter Protocol](https://shelterprotocol.net). It provides core functionality for decentralized applications with encryption, federation, and secure data synchronization:

- E2EE smart contracts with key management
- E2EE file storage and retrieval
- E2EE key-value store
- E2EE WebSocket-based encrypted pubsub messaging
- Zero-knowledge password proofs (ZKPP)
- Persistent action queue with retry logic

Every contract is represented as an append-only log of operations (op codes). Some of the opcodes are for managing keys, others are for updating contract state. Clients that are interested in the contracts will subscribe to them, load the chain of events, decrypt them locally on-device, and process them to update their local contract state. Each contract is referenced by its `contractID`, the hash of the first message in the contract. Contracts can be multi-writer and multi-reader, but a message can only be added on top of the previous one, with the server acting as the source of truth for message ordering. The structure of a message is defined by an object called `SPMessage` and contains the hash of the previous message in a field called `previousHEAD`.

## Essential Commands

```bash
npm install        # Install dependencies
npm test           # Run tests (node:test via ts-node with ESM loader)
npm run build      # Build both ESM and CJS outputs
npm run build:esm  # Build ESM only (.mjs files)
npm run build:cjs  # Build CJS only (.cjs files)
npm run lint       # Run ESLint
npm run clean      # Remove dist/ artifacts
```

## Build System

Dual ESM/CJS output with TypeScript declarations:

| Output | Directory | Extensions | Config |
|---|---|---|---|
| ESM | `dist/esm/` | `.mjs`, `.d.mts` | `tsconfig.json` (target ES2022, module esnext) |
| CJS | `dist/cjs/` | `.cjs`, `.d.cts` | `tsconfig.cjs.json` (module nodenext) |

### Build Process (`buildHelper.ts`)

1. Temporarily changes `package.json` `"type"` field (to `"module"` or `"commonjs"`)
2. Runs `tsc` with the appropriate tsconfig
3. Runs `renameFiles.mjs` to rename `.js` → `.mjs`/`.cjs` and rewrite import paths within files
4. Restores `package.json`

**Note**: CJS build excludes test files via `tsconfig.cjs.json`.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@sbp/sbp` | Selector-based programming core library for registering and calling selectors |
| `@chelonia/crypto` | Cryptographic operations |
| `@chelonia/serdes` | Serialization/deserialization |
| `turtledash` | Utility functions (lodash-style) |
| `tweetnacl` | NaCl cryptography |
| `scrypt-async` | Key derivation |
| `@sbp/okturtles.data` | In-memory key-value store |
| `@sbp/okturtles.events` | Event emitter system |
| `@sbp/okturtles.eventQueue` | Serialized event queue for async operations |

## Code Organization

All source lives in `src/`. The largest files are `internals.ts` and `chelonia.ts`.

```
src/
├── index.ts              # Entry point — re-exports all modules
├── chelonia.ts           # Core framework — ~50 SBP selectors for contract lifecycle
├── internals.ts          # Internal processing — message handling, sync, key ops
├── SPMessage.ts          # Shelter Protocol message types and serialization
├── types.ts              # All TypeScript type definitions
├── encryptedData.ts      # EncryptedData<T> — encryption/decryption functions
├── signedData.ts         # SignedData<T> — signing/verification functions
├── Secret.ts             # Secret<T> — WeakMap-based secret wrapper
├── db.ts                 # Database abstraction (in-memory default)
├── files.ts              # Encrypted file upload/download/delete
├── functions.ts          # CID creation, blake32Hash, base64 utilities
├── utils.ts              # Key lookup, permissions, event stream utilities
├── errors.ts             # Custom error classes via ChelErrorGenerator factory
├── events.ts             # Event name constants
├── constants.ts          # INVITE_STATUS enum
├── persistent-actions.ts # PersistentAction queue with retry
├── journal.ts            # Per-contract state-change journal (diff + snapshots)
├── kv.ts                 # KV slots — declarative typed key/value store API
├── presets.ts            # Server preset for configuring Chelonia
├── time-sync.ts          # Server time synchronization via monotonic offsets
├── chelonia-utils.ts     # Optional utility selectors (e.g., chelonia/kv/queuedSet)
├── zkpp.ts               # Zero-knowledge password proof primitives
├── zkppConstants.ts      # ZKPP constants (AUTHSALT, CONTRACTSALT, etc.)
├── pubsub/
│   ├── index.ts          # WebSocket PubSub client with reconnection logic
│   └── index.test.ts     # Tests for reconnection delay
└── local-selectors/
    └── index.ts          # External state sync (e.g., Chelonia in service worker → Vuex in tab)
```

## Architecture Patterns

### SBP (Selector-Based Programming)

The codebase uses `@sbp/sbp` for dependency injection and module communication. Functions are registered as "selectors":

```typescript
// Registering selectors
sbp('sbp/selectors/register', {
  'chelonia/_init': function (this: CheloniaContext) { /* ... */ },
  'chelonia/config': function (this: CheloniaContext) { /* ... */ },
  // ...
})

// Selectors are called via `sbp('selector/name', ...args)`
await sbp('chelonia/contract/sync', contractID)
```

Often the source file's default export is an array of the selector names it registered.

#### Selector Namespaces

| Namespace | Location | Purpose |
|---|---|---|
| `chelonia/*` | `chelonia.ts` | Public API — init, configure, connect, defineContract |
| `chelonia/out/*` | `chelonia.ts` | Outgoing operations — actionEncrypted, keyAdd, keyDel, keyShare, keyRequest, atomic |
| `chelonia/contract/*` | `chelonia.ts` | Contract lifecycle — sync, retain, release |
| `chelonia/private/*` | `internals.ts` | Internal implementation — message processing, sync, key ops, side effects |
| `chelonia/private/in/*` | `internals.ts` | Incoming message handlers — processMessage, syncContract, handleEvent |
| `chelonia/private/out/*` | `internals.ts` | Outgoing internals — publishEvent |
| `chelonia.db/*` | `db.ts` | Database primitives — get, set, delete, iterKeys, keyCount |
| `chelonia/db/*` | `db.ts` | Higher-level DB — latestHEADinfo, getEntry, addEntry |
| `chelonia.persistentActions/*` | `persistent-actions.ts` | Retry queue — configure, enqueue, cancel, status |
| `chelonia/journal/*` | `journal.ts` | Public journal API — get, reconstruct, clear |
| `chelonia/private/journal/*` | `journal.ts` | Internal journal recorder — recordEvent |
| `chelonia/kv/queuedSet` | `chelonia-utils.ts` | Optional queued raw KV setter |
| `chelonia/kv/{defineSlot,update,read,sync,clear,status,refreshFilters}` | `kv.ts` | KV slots — declarative typed key/value API |
| `chelonia/externalStateSetup` | `local-selectors/` | External state synchronization |

#### Key Public Selectors

```
chelonia/_init              — Initialize Chelonia context (call automatically on registration)
chelonia/configure          — Apply CheloniaConfig
chelonia/reset              — Reset state
chelonia/connect            — Connect to server
chelonia/defineContract     — Register a contract definition
chelonia/contract/sync      — Sync contract state from server
chelonia/contract/retain    — Increment contract reference count
chelonia/contract/release   — Decrement reference count (unsubscribe at 0)
chelonia/out/registerContract    — Create a new contract on-chain
chelonia/out/actionEncrypted     — Send an encrypted action
chelonia/out/actionUnencrypted   — Send an unencrypted action
chelonia/out/keyAdd              — Add a key to a contract
chelonia/out/keyDel              — Remove a key from a contract
chelonia/out/keyUpdate           — Rotate key and/or update key properties
chelonia/out/keyShare            — Share a key with another contract
chelonia/out/keyRequest          — Request keys from a contract
chelonia/out/atomic              — Execute multiple operations atomically
```

### Message Flow

1. **Outgoing**: Create `SPMessage` → Sign/Encrypt → Publish via `chelonia/private/out/publishEvent`
2. **Incoming**: Receive via PubSub WebSocket or RESTful server endpoint → Deserialize → Validate signatures → Decrypt → Process → Update state → Run side effects

### Shelter Protocol Operations

Types defined in `SPMessage.ts` (and implemented/processed in `internals.ts`):

| Operation | Type | Purpose |
|---|---|---|
| `OP_CONTRACT` | `SPOpContract` | Create a new contract |
| `OP_ACTION_ENCRYPTED` | `SPOpActionEncrypted` | Encrypted state mutation |
| `OP_ACTION_UNENCRYPTED` | `SPOpActionUnencrypted` | Unencrypted state mutation |
| `OP_KEY_ADD` | `SPOpKeyAdd` | Add authorized key |
| `OP_KEY_DEL` | `SPOpKeyDel` | Remove authorized key |
| `OP_KEY_SHARE` | `SPOpKeyShare` | Share key with another contract |
| `OP_KEY_REQUEST` | `SPOpKeyRequest` (V1/V2) | Request keys |
| `OP_KEY_REQUEST_SEEN` | `SPOpKeyRequestSeen` | Acknowledge key request |
| `OP_KEY_UPDATE` | `SPOpKeyUpdate` | Rotate a key and/or update properties like "permissions"/"purpose" |
| `OP_PROP_SET` | `SPOpPropSet` | Set contract properties |
| `OP_ATOMIC` | `SPOpAtomic` | Atomic batch of operations |

### Error Handling

Custom errors are generated using `ChelErrorGenerator` in `src/errors.ts`:

```typescript
export const ChelErrorUnexpected = ChelErrorGenerator('ChelErrorUnexpected')
export const ChelErrorDecryptionError = ChelErrorGenerator('ChelErrorDecryptionError')
```

### Journal of Contract State Changes

Chelonia keeps an optional per-contract journal of every event applied to
a contract's state. For each processed event the journal records the
event's identity (`hash`, `height`, `opType`, `description`) plus a
strict-subset RFC 6902 JSON Patch diff between the per-contract state
before and after processing. Periodic full snapshots keep the journal
bounded and reconstructible. Recording happens inside
`handleEvent.applyProcessResult` (`src/internals.ts`); the recorder
itself enforces a "MUST NOT throw" contract via its own try/catch so a
journal bug can never break event handling.

The journal is **opt-in**: `enabled` defaults to `false` so existing
consumers don't pay the per-event diff + persisted-state cost unless
they explicitly turn it on via `chelonia/configure`.

The diff produced is a strict subset of RFC 6902 (only `add`, `remove`,
`replace`), with JSON-Pointer (RFC 6901) paths including the `-`
end-of-array token on `add`. Whole-root removal is represented as
`{ op: 'replace', path: '', value: null }` rather than `remove` (RFC
6902 does not define root-remove). The output is consumable by any
standards-conformant JSON Patch implementation, and the applier rejects
malformed input (`replace` on a missing key, `add`/`replace` without
`value`).

When `processMutation` throws and Chelonia discards the mutation, the
recorder still emits a journal entry — with an empty `patch: []` (on
patch entries) and an additional `error: { name, message }` field
copied from the captured `Error` (e.g. `{ name:
'ChelErrorSignatureError', message: '...' }`). The same `error` field
is also attached to **snapshot** entries when the failure lands on a
snapshot path — the first event for a contract, or a resync /
forward-gap re-seed — so error detail is preserved on every path the
recorder emits, not just patch entries. This makes a failed event
distinguishable from a no-op event in the journal. The error fields
are NOT passed through `redactions`; treat them at the same trust
level as `description` and strip `entries[i].error` after reading via
`chelonia/journal/get` if leakage is a concern.

The journal is stored at `state.contracts[contractID]._journal` (next to
`HEAD`/`height`/etc., not on the contract state itself).

Config keys (all optional, under `CheloniaConfig.journal`):

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Master switch. Opt-in; turn on via `chelonia/configure`. |
| `snapshotInterval` | `50` | Journal keeps between X and 2X entries, snapshotting every X patches and trimming to the most recent snapshot at 2X. |
| `contractIDs` | `[]` (all) | If non-empty, only these contracts are journaled. |
| `redactions` | `[]` | `{ path, redact }` directives applied to both before- and after-states before diffing. `path` uses dotted segments and supports `*`. `redact` is called as `(value, fullPath, contractName)` so a shared redactor can branch on the contract type. |
| `diff` | built-in | Override the diff implementation. |
| `applyPatch` | built-in | Override the patch applier used by `reconstruct`. |

Public selectors:

```
chelonia/journal/get          — Returns a deep clone of { entries } or undefined
chelonia/journal/reconstruct  — Rebuilds the redacted state at HEAD;
                                returns undefined if no journal exists,
                                throws `ChelErrorJournalCorrupt` (with
                                `entryIndex`, `contractID`, and `cause`)
                                if a recorded patch fails to apply
chelonia/journal/clear        — Clears one contract's journal (or all if no arg)
```

All config keys above (including `enabled`, `redactions`, `diff`,
`applyPatch`) can be toggled at runtime by calling `chelonia/configure`
again — provided fields replace the previous value; omitted fields are
left alone. Arrays (`contractIDs`, `redactions`) are copied so later
mutations on the caller's reference don't leak in.

Reconfigure semantics: omitted fields are left alone. For individual
journal fields (`enabled`, `snapshotInterval`, `contractIDs`,
`redactions`, `diff`, `applyPatch`), `null` is rejected with a
`TypeError` — only the documented value types are accepted; pass
`undefined` (or omit the field) to leave it alone. To revert `diff` /
`applyPatch` back to the built-ins, pass `defaultDiff` /
`defaultApplyPatch` (imported from `@chelonia/lib` or
`@chelonia/lib/journal`) explicitly. To clear `contractIDs` /
`redactions`, pass an empty array. The top-level `config.journal`
block itself can be omitted (or set to `undefined`) to leave the
journal config alone; passing `journal: null` explicitly means "stop
journaling" and resets the whole block back to disabled defaults
(`enabled: false`, `snapshotInterval: 50`, no `contractIDs`, no
`redactions`, default `diff`/`applyPatch`) and clears every persisted
journal so no stale entries linger after the reset.

Resync detection: the recorder watches the incoming event's `height`
relative to the last journalled entry to decide between three cases.
A strictly backwards height (`height < lastEntry.height`) is an
unambiguous resync — the contract was re-processed from scratch — and
the journal is collapsed to a fresh snapshot. A strictly forward gap
(`height > lastEntry.height + 1`) is also treated as a resync: under
normal operation Chelonia journals every event at the current height,
so a gap means entries are missing (e.g. journaling was toggled
`enabled: false → true`, or `contractIDs` was widened to re-include
this contract) and the cached `before`-state no longer matches the
incoming event. Producing a patch on top of it would silently corrupt
`reconstruct`, so the recorder re-seeds with a snapshot instead. The
duplicate-arrival case (same `hash` at the same `height`) is ignored
without rewriting the journal.

Changing `redactions` at runtime is destructive to existing journal
state: the previously recorded snapshots and patches were produced
under the old redaction set, so applying a new redaction would leave
those entries projected through the old set while subsequent entries
use the new one, breaking `reconstruct`. Chelonia does **not**
auto-clear on `redactions` change — function identity isn't stable
across process restarts (so an in-memory equality check would either
clear on every relaunch or fail to detect real changes), and
`chelonia/configure` is normally called with the same redaction set
on every app start. If a caller is genuinely *changing* the redaction
set vs. what produced the persisted journal, they MUST call
`chelonia/journal/clear` themselves; otherwise the next event on each
contract simply continues under the new redactions and `reconstruct`
output will be inconsistent until the next snapshot. If you need
pre-change history preserved, snapshot the journal via
`chelonia/journal/get` *before* clearing.

Redaction scope: `redactions` covers `state` only. The
`JournalEntry.description` field (a copy of `SPMessage.description()`)
is persisted verbatim. For unencrypted ops `description()` can echo
action data, so treat the journal as visible at the same trust level
as the description output. Callers that need to scrub the description
should strip it from `entries` after reading via `chelonia/journal/get`,
or rely on encrypted ops whose `description()` is intentionally opaque.

Persistence note: `_journal` lives under `state.contracts[contractID]`
and is serialized alongside the rest of that subtree by typical
persistence layers. When `enabled: true`, expect up to two redacted
full-state snapshots plus up to ~`snapshotInterval` patch entries per
active contract sitting in persisted state. Tune `snapshotInterval`
down (or set `enabled: false`) if state size is a concern.

Consumer-visible leakage: because `_journal` is an own property of
`state.contracts[contractID]`, it travels with anything that exposes
that subtree. Notably `chelonia/contract/fullState` returns
`cheloniaState: rootState.contracts[contractID]` verbatim, and any
listener on `EVENT_HANDLED` that snapshots `state.contracts` (e.g.
the Vuex mirror set up by `chelonia/externalStateSetup`) will receive
the journal as well. Similarly, `rootState._kv` (the KV mirror
subtree) is projected into external stores by
`chelonia/externalStateSetup`. Treat both `_journal` and `_kv` as
in-band with the rest of the bookkeeping subtree: redact accordingly,
and if you need a journal-free view of `cheloniaState`, project it
client-side via `{ ...cheloniaState, _journal: undefined }` (the
journal API itself remains accessible through `chelonia/journal/get`).
For a `_kv`-free view, use `{ ...rootState, _kv: undefined }`.

Supported state shape: the journal's deep-clone is JSON-shape-only.
`Date` / `Map` / `Set` / `Buffer` / class instances inside contract
state are passed through by reference rather than copied. In-place
mutation of such values would retroactively mutate prior journal
entries and confuse the `before === after` short-circuit in the diff.
Keep contract state plain JSON for the journal to behave correctly,
or swap in a `structuredClone`-based `diff` / `applyPatch` override.

Redaction caveat: the bundled `shortHashRedactor` hashes
`JSON.stringify(value)` and returns the first 8 characters of the
base58btc-encoded blake2b-256 hash. This is fine for high-entropy
values, but **trivially reversible** for booleans, small integers, or
short enum strings — anyone with the journal and the contract schema
can precompute the mapping. Use a constant sentinel (e.g.
`'[REDACTED]'`) for low-entropy fields.

Import path: the journal module is re-exported from the package root
(`import { defaultDiff } from '@chelonia/lib'`) and is also available
under the `./journal` subpath (`import { defaultDiff } from
'@chelonia/lib/journal'`). The package-root import is the preferred
form; the subpath is provided as a convenience for consumers that want
to tree-shake just the journal helpers.

### KV slots

Chelonia provides a declarative key/value API (`chelonia/kv/*`) layered
on the existing server-side KV store. Consumers register typed "slots"
via `chelonia/kv/defineSlot`; the library manages a local mirror
(`rootState._kv[contractID][key]`), pubsub filter coalescing, conflict
retries, and schema validation automatically.

Mirror state lives at `rootState._kv[contractID][key]` and contains
`{ value, etag, status, lastError? }`. It is populated by
`chelonia/kv/defineSlot` / `_loadSlot` / `_handleRemote` and cleaned up
on contract release.

Mirror `value` is canonical: it is **always** either a
server-confirmed payload or `undefined`. Every `'non-init'` transition
— a first-load 404, a local `clear`, and a remote (wire-`null`) clear
— leaves `value === undefined`; the declared default is surfaced only
through `chelonia/kv/read` and the `onUpdate` callback, never written
into the raw mirror. Direct `rootState._kv` readers MUST treat
`status` (not `value`) as the source of truth and substitute the
default via `value ?? read(contractID, key)`. A first load of a
never-written key emits only `CHELONIA_KV_STATUS_CHANGED`
(`non-init → loading → non-init`); `CHELONIA_KV_UPDATED` is **not**
emitted because the value did not change, so consumers that need a
"settled" signal must watch `CHELONIA_KV_STATUS_CHANGED` reaching a
terminal status.

`chelonia/kv/update` resolves with the value it persisted. If the slot
is replaced (`defineSlot`/HMR) or dropped (reconcile) *after* the
server write commits, `update` still resolves with that committed
value rather than `undefined` — `undefined` is reserved for
`KV_NOOP`/abort, i.e. "no write happened" — so callers can distinguish
a persisted write from a genuine no-op. The committed write is
echo-suppressed regardless of slot replacement, so its own pubsub echo
never re-validates through (and spuriously errors) the replacement
slot.

`chelonia/reset` aborts stuck/offline network work, then **drains**
in-flight `chelonia/kv/update` / `chelonia/kv/clear` writes via
`chelonia/kv/_waitInFlight` before `postCleanupFn` and before clearing the
KV runtime maps. This matches `chelonia/contract/wait`: persistence hooks
observe a quiescent mirror, and continuations never run against torn-down
state.

Slot definitions (`KvSlotDefinition`) declare a `contractType`, `key`,
`defaultValue`, optional `schema` (sync `.parse`), `match` predicate,
`onUpdate` callback, and a handful of boolean flags (`autoSubscribe`,
`autoLoad`, `refreshOnReconnect`). Slots can also be declared inline on
a `chelonia/defineContract` call via the `kv` key; inline slots are
registered under the contract name stored in `state.contracts[cID].type`.
`defaultUpdater` enables a shorthand `value`-form on `chelonia/kv/update`.

`KvUpdater<T>` receives `T | undefined`: `undefined` is passed when a
slot has neither a mirror value nor a `defaultValue`.

The `KV_NOOP` symbol (`Symbol.for('@chelonia/lib/KV_NOOP')`) can be
returned from an updater to abort the write without touching the server.

Config keys (all on `KvSlotDefinition`):

| Key | Default | Purpose |
|---|---|---|
| `contractType` | (required) | Contract type/name string or array of strings. |
| `key` | (required) | KV key name. |
| `defaultValue` | `undefined` | Value returned by `read` before the slot is loaded or while the slot is in `'error'`. |
| `schema` | none | Object with a synchronous `.parse(value)` method (e.g. Zod schema). `null` / `undefined` are rejected anywhere in the value for schema-backed and schemaless slots; model optional fields by omission or tagged unions rather than `T \| null`. |
| `match` | `() => true` | Predicate `(cID, contractState, rootState) => boolean`. |
| `encryptionKeyName` | `'cek'` | Contract key name used for encryption. Missing named keys reject slot writes; set `null` explicitly to write plaintext. |
| `signingKeyName` | `'csk'` | Contract key name used for signing. Missing named keys reject slot writes. |
| `autoSubscribe` | `true` | Whether to subscribe to pubsub for this slot automatically. |
| `autoLoad` | `'on-sync'` | `'on-sync'` fetches on contract sync; `'on-demand'` waits for `read`/`sync`; `'never'` skips. |
| `refreshOnReconnect` | `true` | Re-fetch the slot on pubsub reconnect. |
| `defaultUpdater` | none | Factory `(value) => (prev) => next` enabling the `value` form of `update`. |
| `onUpdate` | none | Callback `(value, ctx: KvUpdateCtx) => void` fired after every mirror change. Must not throw. Must not synchronously call a same-contract KV write selector (rejected with `ChelErrorKvReentrant` — see the re-entrancy caveat below). |

Public selectors:

```
chelonia/kv/defineSlot        — Register or replace a slot definition
chelonia/kv/update            — Write via updater or value; retries on conflict
chelonia/kv/read              — Synchronous mirror read (returns default if unloaded/error)
chelonia/kv/sync              — Force-fetch slot(s) from the server
chelonia/kv/clear             — Reset slot (mirror value→undefined, default via read; writes null to server)
chelonia/kv/status            — KvLoadStatus of a slot or aggregate for a contract
chelonia/kv/refreshFilters    — Re-evaluate match predicates after state transitions
```

Events emitted:

```
CHELONIA_KV_UPDATED          — Mirror value changed (load / remote / local / reconnect)
CHELONIA_KV_STATUS_CHANGED   — Slot status transitioned
CHELONIA_KV_VALIDATION_ERROR — Mirror value failed schema.parse
```

Unloaded-write caveat: `chelonia/kv/update` derives its `if-match`
precondition from the mirror etag. A never-loaded (`'non-init'`) slot
has `etag: null`, so its first `update` is sent with no precondition
and overwrites whatever the server already holds — even a value this
client never read — rather than producing a `412`. This is harmless
for the default `autoLoad: 'on-sync'` (the slot loads on sync before
any write), but for `autoLoad: 'on-demand'` / `'never'` slots, call
`chelonia/kv/sync` before `update` to avoid clobbering an unread
server value.

`onUpdate` re-entrancy caveat: `onUpdate` runs *inside* the contract's
`chelonia/queueInvocation` lane, which is held until the callback
settles. Calling a KV **write** selector (`chelonia/kv/update`,
`clear`, or `sync`) for the **same contract** from within `onUpdate`
would enqueue behind the very lane that is blocked awaiting the
callback — a permanent deadlock. To turn the most common form of this
hang (a write issued during the callback's *synchronous* execution,
e.g. `onUpdate: () => sbp('chelonia/kv/update', …)`) into a clear
error, those selectors detect synchronous re-entrancy and reject with
`ChelErrorKvReentrant`. The guard is held only for the callback's
synchronous portion, so it never rejects an *independent* concurrent
write that merely interleaves with a slow async `onUpdate` (those
queue safely and succeed). Safe from `onUpdate` at any time:
`chelonia/kv/read` and `chelonia/kv/status` (synchronous, unqueued),
and writes to *other* contracts. To re-enter a write on the same
contract, schedule it off the synchronous stack and do not await it
inside the callback, e.g.
`queueMicrotask(() => sbp('chelonia/kv/update', …))` — it queues
behind the lane and runs once the lane releases. (A re-entrant write
issued *after* an `await` inside `onUpdate` is not detected and still
deadlocks; treat it as unsupported and schedule it off the stack as
above.)

No-`cid` remote frame handling: a pubsub KV frame without a `cid`
carries no server identifier to pair with the mirror etag. If such a
frame arrives for a slot that already holds an etag, applying it inline
would write the new value while keeping the *old* etag, breaking the
"value and etag move together" invariant and guaranteeing a `412` on
the next local write. Chelonia therefore forces an authoritative
`chelonia/kv/get` for value-bearing no-`cid` frames on etag-bearing
slots (re-pairing value+etag from the server, mirroring the
conflict-reconciliation path). A no-`cid` frame on a never-loaded slot
(etag `null`) still applies inline — there is no stale etag to clobber.

Ordering note: `CHELONIA_KV_UPDATED` is emitted *before* the slot
status transitions (the mirror `value`/`etag` are written, the event
fires, then `setSlotStatus` runs). Because `okTurtles.events/emit` is
synchronous, a `CHELONIA_KV_UPDATED` handler that reads
`chelonia/kv/status` observes the **pre-transition** status (e.g.
`'loading'` on a first successful load, not `'loaded'`). Consumers
that need a settled status signal must watch
`CHELONIA_KV_STATUS_CHANGED` reaching a terminal status rather than
inferring status from inside a `CHELONIA_KV_UPDATED` handler.

Ordering caveat (re-validate path): the load / remote / local paths
emit `CHELONIA_KV_UPDATED` *before* the status transition (above), but
the `defineSlot`-replacement re-validation path (`revalidateMirrorEntry`)
flips status to `'loaded'` *before* emitting `CHELONIA_KV_UPDATED` for
the error-recovery and coercion cases. A `CHELONIA_KV_UPDATED` handler
that reads `chelonia/kv/status` therefore observes the **already-
transitioned** (`'loaded'`) status on the re-validate path, the opposite
of the load path. This inconsistency is accepted rather than reordered:
the re-validate path must clear `'error'` promptly so `chelonia/kv/read`
(which returns the default while `status === 'error'`) stops hiding the
recovered value, and a handler that reads back a freshly-recovered value
should see `'loaded'`, not the stale `'error'`. The general guidance
stands — derive a settled signal from `CHELONIA_KV_STATUS_CHANGED`, not
from the status observed inside a `CHELONIA_KV_UPDATED` handler.

Payload-mutation safety: the `value` and `previousValue` fields on
`CHELONIA_KV_UPDATED`, and the `value` argument to `onUpdate`, are
**detached deep clones** of the mirror, not live references into
`rootState._kv`. Mutating them in a listener/callback is safe — it
cannot corrupt the mirror or other observers — but the mutation is also
not reflected back into the mirror (use `chelonia/kv/update` to persist
a change). Primitive values pass through unwrapped.

Change-detection caveat: `CHELONIA_KV_UPDATED` does **not** guarantee
the value actually changed. `chelonia/kv/clear` always emits (per
§4.5), whereas a no-op first load suppresses the event, so the event is
fired on a superset of real changes. Consumers needing strict change
detection must compare `previousValue` against `value` themselves.

`onUpdate` replacement caveat: because the slot-identity guard before
`await safeOnUpdate` is synchronous, a slot replaced via `defineSlot`
(or HMR) *during* an in-flight async load/write may still see its
previous definition's `onUpdate` fire once after the replacement's own
revalidation. Callbacks must therefore be idempotent and must not
assume they are still the active slot for the contract/key.

Slot-replacement refetch (no stale `'loaded'`): when `defineSlot`
replaces an already-active `autoLoad: 'on-sync'` slot, Chelonia decides
between re-validating the persisted mirror value and scheduling a fresh
server fetch. A fetch is forced not only when the entry looks unloaded
(`non-init` / `loading` / no value) or a write is in flight, but also
when a *load* is pending for the contract (`kvPendingLoads` > 0). A load
can be pending because it is queued behind busy lane work but not yet
started (its status is still `'loaded'`, so the unloaded check misses
it) or because it is the authoritative GET `_handleRemote` runs to
reconcile a conflict / no-`cid` frame. In both cases that in-flight load
will discard its result at its own staleness guard once it sees the
replacement, so re-validating the soon-to-be-stale value would strand
the mirror at the old value with a `'loaded'` status and no signal to
the consumer. Forcing a fresh load for the replacement re-fetches the
live server value instead. (Idempotent re-`defineSlot` with no pending
work still re-validates in place and issues no network request.)

Low-level selector extensions: the slot layer extends (does not
replace) `chelonia/kv/set` (returns `{ etag }`, accepts `signal`,
`onconflict`, `maxAttempts`), `chelonia/kv/get` (attaches `etag`
lazily without forcing the `data` accessor), and `chelonia/kv/queuedSet`
(forwards `signal`, returns `{ etag }`). `chelonia/kv/setFilter` is
unchanged. These additions are backward-compatible.

Data-loss-guard reload (status quiet): `chelonia/kv/update` on a slot
that is in `'error'` but still holds a retained value+etag first issues
one *silent* authoritative reload (so the reducer seeds from, and the
write's `if-match` guards against, live server state instead of the
default). That reload's internal status churn is hidden: it emits no
`CHELONIA_KV_UPDATED` / `onUpdate`, **and** no `CHELONIA_KV_STATUS_CHANGED`
— the observable status stays at its pre-reload value so a single
`update` does not surface a spurious `error → loading → loaded` flicker.
The one status transition consumers observe is the terminal
`error → loaded` the write itself emits after the commit. Internally the
mirror `value`/`etag` are still refreshed by the reload; `update` derives
its reducer seed from whether the reload ran/succeeded, not from the
(deliberately frozen) status field.

Filter-flush retry: a transient `chelonia/kv/setFilter` failure (e.g. a
server error while the websocket stays up) is retried after a short
backoff (`KV_FILTER_RETRY_MS`). The contract is held in a separate
`kvFilterRetry` set (not re-added to `kvFilterDirty` inline, which would
hot-spin the drain loop); a single deferred timer moves the pending
contracts back into `kvFilterDirty` and re-flushes, re-sending the filter
cached in `kvActiveFilters`. Retries repeat (rate-limited) until the
server accepts the filter or the slot set changes. A reconnect
re-establishes filters independently from `kvActiveFilters`, so this
retry only matters for failures that leave the socket up.

Self-echo suppression uses a time-decaying map of server-issued data
CIDs per `(contractID, key)` stored in `kvLocalEchoCIDs` (`Map<string,
Map<string, { expiry: number; fromConflict: boolean }>>`). The CID is
returned from `chelonia/kv/set` as `etag` and also appears on pubsub KV
frames as `cid`; matching, non-expired frames are dropped and the entry
is deleted on first match (except conflict markers — see "Conflict-marker
arrival ordering" below). Entries auto-expire after `KV_ECHO_TTL_MS`
(300 s) and are purged lazily; a per-bucket cap of `KV_ECHO_CID_MAX`
(128, evict earliest-expiry first, but never the just-recorded CID)
is a hard backstop only. A non-self
frame that arrives while a conflict-resolved write's echo is still
pending forces an authoritative `chelonia/kv/get` instead of applying the
frame last-write-wins. A value-bearing frame without `cid` on an
etag-bearing slot also forces an authoritative `chelonia/kv/get` (so
value and etag stay paired); a no-`cid` frame on a never-loaded slot
(etag `null`) applies inline with a `null` etag. Either way it surfaces
as `reason: 'remote'`. An echo whose CID has
expired or was evicted surfaces as `reason: 'remote'`.

Conflict-marker arrival ordering: because KV pubsub frames are not
ordered, a conflict-resolved write's own echo can arrive either before
or after a competing non-self frame. Both orderings preserve the
`fromConflict` marker so the competing frame always forces the
authoritative GET. (1) Non-self-first: the GET runs, then the marker is
demoted (`fromConflict → false`) on both success and failure so it
cannot loop. (2) Echo-first: the matching echo is suppressed but the
marker is **kept** (not deleted) and stays `fromConflict`, so the
later competing frame still triggers a GET rather than regressing the
mirror via last-write-wins; the GET demotes the marker afterwards.
A demoted or expired marker no longer forces a GET.

Echo-CID clock: the TTL uses `performance.now()` (monotonic), not
`Date.now()`. This is immune to wall-clock/NTP steps — a backwards
clock jump can never prematurely expire a pending echo — at the cost
of background-tab throttling possibly *extending* the effective TTL,
which only makes suppression more conservative.

Consumer-visible leakage: `rootState._kv` is a separate subtree from
`rootState.contracts`, but it is projected into external stores by
`chelonia/externalStateSetup` (alongside `rootState.contracts`).
Listeners on `CHELONIA_KV_UPDATED` / `CHELONIA_KV_STATUS_CHANGED` and
the Vuex-style mirror receive the changed `_kv[contractID][key]` entry
for slot updates, while contract removal drops the full per-contract KV
subtree. Treat it as in-band with the rest of the bookkeeping data:
redact accordingly in consumer code if needed.

### Contract State Structure

Contracts update a `state` object as events/messages/actions come in by adding key/value parts to the `state` object.

This object also has internal keys managed by Chelonia that start with an underscore:

```typescript
{
  _vm: {
    authorizedKeys: Record<string, ChelContractKey>,
    type: string,                          // Contract type identifier
    invites?: Record<string, {...}>,        // Invite tracking
    keyshares?: Record<string, {...}>       // Key share tracking
  },
  // unlike _vm, _volatile is not sync'd between clients and is unique to each client
  _volatile?: {
    pendingKeyRequests?: [...],             // Awaiting key responses
    pendingKeyRevocations?: Record<string, ...>,
    dirty?: boolean,                        // State needs re-sync
    resyncing?: boolean                     // Currently re-syncing
  }
}
```

### Encryption

Uses `@chelonia/crypto` for cryptographic operations. The `encryptedData.ts` module provides:
- `encryptedOutgoingData()` - Encrypt data for transmission
- `encryptedIncomingData()` - Decrypt received data
- `encryptedOutgoingDataWithRawKey()` - Encrypt with raw key

## Coding Conventions

### Import Style

**Always use `.js` extension** for local imports even though source files are `.ts`:

```typescript
import { something } from './utils.js' // ✅ Correct
import { something } from './utils'    // ❌ Wrong
import { something } from './utils.ts' // ❌ Wrong
```

This is required for ESM compatibility — TypeScript compiles `.ts` → `.js` and the import paths must match the output.

### Prototype-Based Type Checking

`EncryptedData<T>` and `SignedData<T>` use prototype-based type detection instead of `instanceof`:

```typescript
// Checking type — uses a marker property on the prototype
function isEncryptedData(obj: unknown): obj is EncryptedData<unknown> {
  return !!obj && (obj as any)._isEncryptedData === true
}
```

### Secret Values

`Secret<T>` stores values in a `WeakMap` keyed by the instance, preventing accidental exposure in logs or serialization. It implements `@chelonia/serdes` serialization symbols for controlled serialization.

```typescript
const secret = new Secret(sensitiveValue)
secret.valueOf()  // Returns the actual value
console.log(secret)  // Does NOT reveal the value
```

### Events

All event constants are in `events.ts`:

Events are emitted and listened to via `sbp('okTurtles.events/emit', ...)` and `sbp('okTurtles.events/on', ...)`.

### Key Management

- Keys have `ringLevel` (integer) — lower values have more authority and can rotate/revoke higher values
- `purpose` is an array of `'enc' | 'sig' | 'sak'` (encryption, signing, server accounting key)
- `permissions` control what operations a key can authorize (e.g., `[OP_ACTION_ENCRYPTED]`)
- `foreignKey` references keys in other contracts

### Linting

ESLint with `@typescript-eslint/parser` and `eslint-config-standard`. Configuration is inline in `package.json` (not a separate file).

- Max line length: **100 characters** (150 for comments)
- Template literals and strings are exempt from line length
- Uses `standard` style (no semicolons, single quotes, 2-space indent)

### Test Style

Tests use Node.js built-in test runner (`node:test`):

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('Feature name', () => {
  it('should do something', () => {
    assert.strictEqual(actual, expected)
  })
})
```

Test files use `.test.ts` suffix and are imported in `src/index.test.ts`.

## Common Gotchas

1. **Import extensions**: Always use `.js` extension in imports, even for TypeScript files. The build process does not transform these.
2. **SBP context**: Many functions use `this: CheloniaContext` - they must be called through SBP to have proper context binding.
3. **`dist/` under version control**: Ignore the files in `dist/`, don't review them or read them or update them.
4. **Test isolation**: Tests use SBP selectors which are globally registered. Mock functions carefully to avoid cross-test contamination.
5. **Secret keys**: Secret keys are stored in `rootState.secretKeys` as serialized strings and accessed via `transientSecretKeys` proxy.
6. **Reference counting for contracts** — Use `chelonia/contract/retain` and `chelonia/contract/release` for contract lifecycle. At refcount 0, the contract is unsubscribed.
7. **Event queue serialization** — `chelonia/db/addEntry` and other operations use `okTurtles.eventQueue` to ensure serialized execution of asynchronous operations. Each contract has its own event queue under the `contractID` key. Convention: to ensure an operation is run after a contract sync finishes, add it to this queue.
