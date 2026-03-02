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
