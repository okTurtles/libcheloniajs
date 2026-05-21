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
| `chelonia/kv/*` | `chelonia-utils.ts` | Key-value store — queuedSet |
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
recorder still emits a patch entry — with an empty `patch: []` and an
additional `error: { name, message }` field copied from the captured
`Error` (e.g. `{ name: 'ChelErrorSignatureError', message: '...' }`).
This makes a failed event distinguishable from a no-op event in the
journal. The error fields are NOT passed through `redactions`; treat
them at the same trust level as `description` and strip
`entries[i].error` after reading via `chelonia/journal/get` if leakage
is a concern.

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
the journal as well. Treat the journal block as in-band with the rest
of the bookkeeping subtree: redact accordingly, and if you need a
journal-free view of `cheloniaState`, project it client-side via
`{ ...cheloniaState, _journal: undefined }` (the journal API itself
remains accessible through `chelonia/journal/get`).

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
