# API index

A reference listing of the public SBP selectors registered by
`@chelonia/lib`. Importing the package (`import '@chelonia/lib'`)
registers everything below into the global SBP registry as a
side-effect.

For the prose guides, see [`configure.md`](./configure.md),
[`contracts.md`](./contracts.md), and [`journal.md`](./journal.md).
For the authoritative signatures, follow the source links.

> Internal selectors (`chelonia/private/*`, `chelonia/private/in/*`,
> `chelonia/private/out/*`) are **not** documented here and are not
> part of the public API. They may change without notice.
>
> A handful of selectors documented here are intentionally not used
> outside Chelonia itself (e.g. `chelonia/_init`, `chelonia/handleEvent`,
> `chelonia/in/processMessage`). They are included for completeness
> because they are registered as non-private selectors.

## Core lifecycle

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/_init` | `src/chelonia.ts` | Initialize the Chelonia context. Runs automatically the first time a selector that needs it is invoked. |
| `chelonia/config` | `src/chelonia.ts` | Return the live `CheloniaConfig` object. Useful for introspection in tests. |
| `chelonia/configure` | `src/chelonia.ts` | Apply a `CheloniaConfig`. See [`configure.md`](./configure.md). |
| `chelonia/reset` | `src/chelonia.ts` | Drain publishes, abort in-flight messages, clear state. `(newState?, postCleanupFn?)`. |
| `chelonia/connect` | `src/chelonia.ts` | Open the pubsub WebSocket. Returns a `PubSubClient`. |
| `chelonia/defineContract` | `src/chelonia.ts` | Register a contract definition (actions / getters / methods / metadata). |
| `chelonia/pubsub/update` | `src/chelonia.ts` | Reconcile pubsub subscriptions against the current subscription set. Auto-called after subscription changes; call manually if you swap `stateSelector` at runtime. |
| `chelonia/handleEvent` | `src/chelonia.ts` | Hand a raw incoming event string to Chelonia's processing queue. Used by the pubsub client; rarely called directly. |
| `chelonia/in/processMessage` | `src/chelonia.ts` | Try-applying an `SPMessage`: deep-clones the supplied per-contract `state`, runs `chelonia/private/in/processMessage` against the clone, and returns the mutated copy on success or the original `state` unchanged on failure (errors are caught and logged via `console.warn`). Useful in tests / dry-runs; root state is never touched. (The outgoing-validation path in `publishEvent` calls the private `chelonia/private/in/processMessage` directly.) |
| `chelonia/queueInvocation` | `src/chelonia.ts` | Queue an SBP invocation on a contract's event queue. Use to ensure work runs after the current sync drains. |
| `chelonia/begin` | `src/chelonia.ts` | Run a sequence of SBP invocations sequentially. |
| `chelonia/rootState` | `src/chelonia.ts` | Return the root state object (`sbp(stateSelector)`). |
| `chelonia/shelterAuthorizationHeader` | `src/chelonia.ts` | Build a `Shelter` HTTP Authorization header for a billable contract. |
| `chelonia/crypto/keyId` | `src/chelonia.ts` | Re-export of `@chelonia/crypto.keyId`. Provided as a selector so contracts can call it through their allow-list. |

## Secret-key management

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/storeSecretKeys` | `src/chelonia.ts` | Store persistent and/or transient secret keys. Takes `Secret<{ key, transient? }[]>`. |
| `chelonia/clearTransientSecretKeys` | `src/chelonia.ts` | Clear specific transient keys (`string[]`) or all of them. |
| `chelonia/haveSecretKey` | `src/chelonia.ts` | `(keyId, persistent?) => boolean`. |

## Contract lifecycle

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/contract/retain` | `src/chelonia.ts` | Increment the (persistent or `ephemeral`) refcount and sync. |
| `chelonia/contract/release` | `src/chelonia.ts` | Decrement the refcount. At 0 the contract is unsubscribed and removed. |
| `chelonia/contract/sync` | `src/chelonia.ts` | Force re-sync. Requires a positive refcount. |
| `chelonia/contract/withRetained` | `src/chelonia.ts` | Retain (`ephemeral: true`) → callback → release. |
| `chelonia/contract/wait` | `src/chelonia.ts` | Wait for the contract's internal event queue to drain. |
| `chelonia/contract/waitPublish` | `src/chelonia.ts` | Wait for the contract's `publish:` event queue to drain. |
| `chelonia/contract/isSyncing` | `src/chelonia.ts` | Boolean. Accepts `{ firstSync: true }` to scope. |
| `chelonia/contract/isResyncing` | `src/chelonia.ts` | Boolean. Reads `_volatile.dirty` / `_volatile.resyncing`. |
| `chelonia/contract/currentSyncs` | `src/chelonia.ts` | Array of currently-syncing contract IDs. |
| `chelonia/contract/currentKeyIdByName` | `src/chelonia.ts` | Resolve a contract-local key `name` to the current `keyId`. |
| `chelonia/contract/historicalKeyIdsByName` | `src/chelonia.ts` | Resolve a key `name` to the list of every `keyId` it has had over time. |
| `chelonia/contract/suitableSigningKey` | `src/chelonia.ts` | Find a key satisfying `(permissions, purpose, ringLevel)` for a signing operation. |
| `chelonia/contract/foreignKeysByContractID` | `src/chelonia.ts` | List the IDs of every foreign key owned by another contract. |
| `chelonia/contract/setPendingKeyRevocation` | `src/chelonia.ts` | Mark named keys as pending revocation in `_volatile.pendingKeyRevocations`. |
| `chelonia/contract/hasKeysToPerformOperation` | `src/chelonia.ts` | `(contractID, opType) => boolean`. Does the local store hold a key with permission for `opType`? |
| `chelonia/contract/receivedKeysToPerformOperation` | `src/chelonia.ts` | Same as above, scoped to keys learned via `OP_KEY_SHARE`. |
| `chelonia/contract/successfulKeySharesByContractID` | `src/chelonia.ts` | Map of contract ID → list of successful `OP_KEY_SHARE`s received. |
| `chelonia/contract/waitingForKeyShareTo` | `src/chelonia.ts` | Returns the originating contract IDs we're currently awaiting a key share from. |
| `chelonia/contract/hasKeyShareBeenRespondedBy` | `src/chelonia.ts` | Has a given contract responded to one of our outstanding key requests? |
| `chelonia/contract/state` | `src/chelonia.ts` | Deep-clone of a contract's state, optionally filtered to a particular `height`. |
| `chelonia/contract/fullState` | `src/chelonia.ts` | `{ contractState, cheloniaState }` for one id or an array of ids. |
| `chelonia/contract/remove` | `src/chelonia.ts` | Hard-remove a contract from state (refcount-aware via callback). |
| `chelonia/contract/disconnect` | `src/chelonia.ts` | Publish an `OP_KEY_DEL` to detach the foreign keys we hold for another contract. |
| `chelonia/latestContractState` | `src/chelonia.ts` | Return a cloned, possibly freshly-synced contract state. Accepts `{ forceSync }`. |

## Outgoing operations

All publish to the relay via `chelonia/private/out/publishEvent` once
`chelonia/connect` has been called.

| Selector | Source | Op | Purpose |
|---|---|---|---|
| `chelonia/out/registerContract` | `src/chelonia.ts` | `OP_CONTRACT` + initial action | Create a new contract on-chain. Returns the initial-action `SPMessage`. |
| `chelonia/out/actionEncrypted` | `src/chelonia.ts` | `OP_ACTION_ENCRYPTED` | Publish an encrypted state mutation. |
| `chelonia/out/actionUnencrypted` | `src/chelonia.ts` | `OP_ACTION_UNENCRYPTED` | Publish an unencrypted state mutation. |
| `chelonia/out/keyAdd` | `src/chelonia.ts` | `OP_KEY_ADD` | Add authorized key(s). |
| `chelonia/out/keyDel` | `src/chelonia.ts` | `OP_KEY_DEL` | Remove authorized key(s). |
| `chelonia/out/keyUpdate` | `src/chelonia.ts` | `OP_KEY_UPDATE` | Rotate a key and/or update `permissions` / `purpose`. |
| `chelonia/out/keyShare` | `src/chelonia.ts` | `OP_KEY_SHARE` | Share secret key material with another contract. |
| `chelonia/out/keyRequest` | `src/chelonia.ts` | `OP_KEY_REQUEST` | Request keys from another contract. |
| `chelonia/out/keyRequestResponse` | `src/chelonia.ts` | `OP_KEY_REQUEST_SEEN` | Acknowledge / respond to a key request. |
| `chelonia/out/atomic` | `src/chelonia.ts` | `OP_ATOMIC` | Bundle multiple operations into one published message. |
| `chelonia/out/encryptedOrUnencryptedPubMessage` | `src/chelonia.ts` | n/a | Build a signed (and optionally encrypted) pub message without publishing it. |
| `chelonia/out/ownResources` | `src/chelonia.ts` | HTTP | Fetch the calling contract's billable resources from the relay. |
| `chelonia/out/deleteContract` | `src/chelonia.ts` | HTTP | Permanently delete one or more contracts (requires token or billable-contract id). |
| `chelonia/out/fetchResource` | `src/chelonia.ts` | HTTP | Fetch a CID from `${connectionURL}/file/${cid}` and verify the CID hash before caching/returning it. Used by higher-level readers. |
| `chelonia/out/latestHEADInfo` | `src/chelonia.ts` | HTTP | Latest known HEAD info for a contract, from the relay. |
| `chelonia/out/deserializedHEAD` | `src/chelonia.ts` | HTTP | Fetch and deserialize a single message hash. Asserts that it matches the expected contractID. |
| `chelonia/out/eventsAfter` | `src/chelonia.ts` | HTTP | Stream events with `height >= sinceHeight` for a contract. |
| `chelonia/out/eventsBefore` | `src/chelonia.ts` | HTTP | Stream the `limit` events ending at `beforeHeight`. |
| `chelonia/out/eventsBetween` | `src/chelonia.ts` | HTTP | Stream events between a `startHash` and an `endHeight`. |
| `chelonia/parseEncryptedOrUnencryptedDetachedMessage` | `src/chelonia.ts` | n/a | Parse a detached (off-chain) signed-and-optionally-encrypted message. |

### Time

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/time` | `src/time-sync.ts` | Returns the relay-synchronized timestamp (Date.now() offset by the server delta). |

### Not-yet-implemented op selectors

For parity with the `SPOpType` table in [`configure.md`](./configure.md),
the following selectors are **registered as stubs** (`async () => {}`)
and do not currently publish anything. Tracking issue: see the `TODO`
markers in `src/chelonia.ts`.

| Selector | Source | Notes |
|---|---|---|
| `chelonia/out/protocolUpgrade` | `src/chelonia.ts` | `OP_PROTOCOL_UPGRADE`. Stub. |
| `chelonia/out/propSet` | `src/chelonia.ts` | `OP_PROP_SET`. Stub. |
| `chelonia/out/propDel` | `src/chelonia.ts` | `OP_PROP_DEL`. Stub. |

## Journal

See [`journal.md`](./journal.md) for the full guide.

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/journal/get` | `src/journal.ts` | Return a deep clone of `{ entries }` or `undefined`. |
| `chelonia/journal/reconstruct` | `src/journal.ts` | Rebuild the redacted HEAD state from the most recent snapshot. Throws `ChelErrorJournalCorrupt` on bad patches. |
| `chelonia/journal/clear` | `src/journal.ts` | Clear one contract's journal, or all if called with no argument. Returns the count cleared. |

## Database

Pluggable storage layer. Defaults to an in-memory `Map`.

| Selector | Source | Purpose |
|---|---|---|
| `chelonia.db/get` | `src/db.ts` | Low-level `get(key)`. |
| `chelonia.db/set` | `src/db.ts` | Low-level `set(key, value)`. |
| `chelonia.db/delete` | `src/db.ts` | Low-level `delete(key)`. |
| `chelonia.db/iterKeys` | `src/db.ts` | Iterate over stored keys. |
| `chelonia.db/keyCount` | `src/db.ts` | Total number of stored keys. |
| `chelonia/db/latestHEADinfo` | `src/db.ts` | Get the latest known HEAD info for a contract. |
| `chelonia/db/getEntry` | `src/db.ts` | Fetch a stored `SPMessage`. |
| `chelonia/db/addEntry` | `src/db.ts` | Persist an `SPMessage`. Serialized per-contract via `okTurtles.eventQueue`. |

## Persistent action queue

Retry queue for outgoing actions that must eventually succeed. See
[`persistent-actions.md`](./persistent-actions.md) for the prose guide.

| Selector | Source | Purpose |
|---|---|---|
| `chelonia.persistentActions/_init` | `src/persistent-actions.ts` | Internal init; cleans up resolved/failed actions automatically. |
| `chelonia.persistentActions/configure` | `src/persistent-actions.ts` | Set `databaseKey` and override default retry options (`maxAttempts`, `retrySeconds`). |
| `chelonia.persistentActions/enqueue` | `src/persistent-actions.ts` | Schedule one or more persistent actions. Returns the new IDs. |
| `chelonia.persistentActions/cancel` | `src/persistent-actions.ts` | Cancel a queued action by ID. Persists the change to the DB. |
| `chelonia.persistentActions/forceRetry` | `src/persistent-actions.ts` | Retry an action immediately instead of waiting for `retrySeconds`. |
| `chelonia.persistentActions/retryAll` | `src/persistent-actions.ts` | Force-retry every loaded action. |
| `chelonia.persistentActions/load` | `src/persistent-actions.ts` | Load persisted actions from the DB and start retrying them. |
| `chelonia.persistentActions/save` | `src/persistent-actions.ts` | Persist the current queue to the DB. Normally called automatically. |
| `chelonia.persistentActions/unload` | `src/persistent-actions.ts` | Drop in-memory state without cancelling — the queue can be `/load`-ed again later. |
| `chelonia.persistentActions/status` | `src/persistent-actions.ts` | Snapshot of each action's `{ id, invocation, attempting, failedAttemptsSoFar, lastError, nextRetry, resolved }`. |

## Files

See [`files.md`](./files.md) for the prose guide and full signatures.

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/fileUpload` | `src/files.ts` | Encrypt one or more `Blob` chunks, build a `ChelFileManifest`, POST as `multipart/form-data` to `${connectionURL}/file`. Returns `{ download, delete }`. |
| `chelonia/fileDownload` | `src/files.ts` | Fetch a manifest by CID, verify it, decrypt and return the payload as a `Blob` (or `false` if `manifestChecker` rejects). |
| `chelonia/fileDelete` | `src/files.ts` | Delete a manifest (and its chunks) by CID. Accepts either a deletion token or a billable contract ID. |

## Key-value store

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/kv/set` | `src/chelonia.ts` | `POST /kv/:contractID/:key`. Encrypts, signs, retries on `409`. |
| `chelonia/kv/get` | `src/chelonia.ts` | `GET /kv/:contractID/:key`. Returns the decrypted value or `undefined`. |
| `chelonia/kv/setFilter` | `src/chelonia.ts` | Restrict the set of KV keys subscribed to over pubsub. |
| `chelonia/kv/queuedSet` | `src/chelonia-utils.ts` | Wrapper around `chelonia/kv/set` that serializes concurrent updates via `okTurtles.eventQueue`. Prefer this over `kv/set` for typical writes. |

## KV slots

A declarative key/value API layered on top of the primitives above.
Consumers register typed "slots" via `defineSlot`; the library manages
local mirroring, pubsub filters, conflict retries, and schema
validation automatically.

All slot selectors live in `src/kv.ts`.

| Selector | Purpose |
|---|---|
| `chelonia/kv/defineSlot` | Register a `KvSlotDefinition` (contract type + key + schema + options). Idempotent — subsequent calls replace and re-validate. |
| `chelonia/kv/update` | Write a slot value. Accepts either a `updater(prev) → next` reducer or a plain `value` (requires `defaultUpdater` on the slot). Retries on `409`/`412`. |
| `chelonia/kv/read` | Synchronous read of the local mirror for `(contractID, key)`. Returns the cloned default if no mirror entry exists. |
| `chelonia/kv/sync` | Force-fetch a single slot (with `key`) or every active slot for a contract and refresh the mirror. |
| `chelonia/kv/clear` | Reset a slot to its declared `defaultValue` by writing `null` to the server. |
| `chelonia/kv/status` | Report the `KvLoadStatus` of a single slot (`'non-init' | 'loading' | 'loaded' | 'error'`) or the aggregate status of all slots for a contract. |
| `chelonia/kv/refreshFilters` | Re-evaluate every slot's `match` predicate against the current root state. Call after login / logout transitions. |

`chelonia/kv/set` now resolves to `{ etag: string | null }` instead of `void`; the return value is forwarded through `chelonia/kv/queuedSet` as well.

### Inline definition via `chelonia/defineContract`

Slots can also be declared inline on a contract definition under the
`kv` key. `chelonia/defineContract` registers each entry automatically
and diffs added/removed keys on re-registration.

```ts
sbp('chelonia/defineContract', {
  metadata: { … },
  manifest: 'gi.contracts/identity',
  kv: {
    preferences: {
      defaultValue: {},
      schema: PreferencesSchema,
      defaultUpdater: (patch) => (prev) => ({ ...prev, ...patch })
    }
  },
  …
})
```

### KV_NOOP sentinel

```ts
import { KV_NOOP } from '@chelonia/lib'

// Inside an updater — abort the write without touching the server:
sbp('chelonia/kv/update', {
  contractID, key: 'lastSeen',
  updater: (prev) => {
    if (Date.now() - prev.ts < 30 * 60_000) return KV_NOOP
    return { ts: Date.now() }
  }
})
```

## External state sync

For mirroring Chelonia's state into another process / store (e.g.
Chelonia in a service worker, Vuex/Pinia in the tab).

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/externalStateSetup` | `src/local-selectors/index.ts` | Wire up Chelonia → external store synchronization. |

## Events

`@chelonia/lib` emits via `okTurtles.events/emit`. The full list lives
in `src/events.ts`; the most commonly observed:

| Event | Source | Fires |
|---|---|---|
| `CHELONIA_RESET` | `src/events.ts` | After `chelonia/reset` has drained and cleared state. |
| `CONTRACT_IS_SYNCING` | `src/events.ts` | When a contract enters / leaves the syncing state. Payload: `(contractID, isSyncing)`. |
| `CONTRACTS_MODIFIED` | `src/events.ts` | After any subscription set change. Payload: `(subscriptionSet, { added, removed, permanent?, resync? })`. |
| `CONTRACTS_MODIFIED_READY` | `src/events.ts` | Mirror of the above, fired after subscriptions have actually opened/closed on the wire. |
| `EVENT_HANDLED` | `src/events.ts` | After an incoming event has been processed and side-effects run. Payload: `(contractID, message)`. |
| `EVENT_HANDLED_READY` | `src/events.ts` | Drains-only signal for sync-completion observers; fires after the per-contract queue is empty. |
| `EVENT_PUBLISHED` | `src/events.ts` | After an outgoing event was accepted by the relay. Payload: `{ contractID, message, originalMessage }`. |
| `EVENT_PUBLISHING_ERROR` | `src/events.ts` | When publishing fails (after retries). |
| `CONTRACT_REGISTERED` | `src/events.ts` | After `chelonia/defineContract` finishes registering. |
| `CONTRACT_UNREGISTERED` | `src/events.ts` | When a previously-registered contract is removed (e.g. via `chelonia/contract/remove`). |
| `CONTRACT_IS_PENDING_KEY_REQUESTS` | `src/events.ts` | A `OP_KEY_REQUEST` we sent is awaiting acknowledgement. |
| `CONTRACT_HAS_RECEIVED_KEYS` | `src/events.ts` | A key share we asked for has arrived. |
| `PERSISTENT_ACTION_FAILURE` | `src/events.ts` | A persistent action attempt failed (will retry unless `maxAttempts` reached). |
| `PERSISTENT_ACTION_SUCCESS` | `src/events.ts` | A persistent action resolved. |
| `PERSISTENT_ACTION_TOTAL_FAILURE` | `src/events.ts` | A persistent action gave up after `maxAttempts`. |
| `CHELONIA_KV_UPDATED` | `src/events.ts` | After a slot's mirror value changes (load, remote push, local write, reconnect). Payload: `{ contractID, contractType, key, value, previousValue, reason, etag }`. |
| `CHELONIA_KV_STATUS_CHANGED` | `src/events.ts` | A slot's `KvLoadStatus` transitioned. Payload: `{ contractID, contractType, key, status, previousStatus, lastError? }`. |
| `CHELONIA_KV_VALIDATION_ERROR` | `src/events.ts` | A slot's mirror value failed `schema.parse`. Payload: `{ contractID, contractType, key, error }`. |

Subscribe with:

```js
import { CHELONIA_RESET } from '@chelonia/lib/events'

sbp('okTurtles.events/on', CHELONIA_RESET, () => { /* ... */ })
```

## Types

The most useful exported types (re-exported from the package root):

| Type | Source | Purpose |
|---|---|---|
| `CheloniaConfig` | `src/types.ts` | Top-level configuration object passed to `chelonia/configure`. |
| `PublishOptions` | `src/internals.ts` (re-exported from `src/chelonia.ts`, reachable from the package root and the `./chelonia` subpath) | Per-call `/out/*` options: `maxAttempts`, `headers`, `billableContractID`, `bearer`, `disableAutoDedup`. |
| `ChelRegParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/registerContract`. |
| `ChelActionParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/actionEncrypted` / `actionUnencrypted`. |
| `ChelKeyAddParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyAdd`. |
| `ChelKeyDelParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyDel`. |
| `ChelKeyUpdateParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyUpdate`. |
| `ChelKeyShareParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyShare`. |
| `ChelKeyRequestParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyRequest`. |
| `ChelKeyRequestResponseParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/keyRequestResponse`. |
| `ChelAtomicParams` | `src/chelonia.ts` | Argument shape for `chelonia/out/atomic`. Each entry's params are pre-validated by the inner selector. |
| `ChelContractProcessMessageObject` | `src/types.ts` | First argument to a contract action's `process(...)`. |
| `ChelContractSideeffectMutationObject` | `src/types.ts` | First argument to a contract action's `sideEffect(...)`. |
| `CheloniaContractCtx` | `src/types.ts` | Shape accepted by `chelonia/defineContract`. |
| `SendMessageHooks` | `src/types.ts` | `hooks` object on `/out/*` params: `prepublish`, `onprocessed`, `preSendCheck`, `beforeRequest`, `postpublish`. |
| `JournalConfig` | `src/types.ts` | Journal sub-tree of `CheloniaConfig`. |
| `JournalEntry` | `src/types.ts` | Discriminated union of `{ kind: 'snapshot', ..., state }` and `{ kind: 'patch', ..., patch, error? }`. See [`journal.md`](./journal.md#public-selectors). |
| `JournalPatch` | `src/types.ts` | Strict subset of RFC-6902 (`add` / `remove` / `replace`). |
| `JournalRedaction` | `src/types.ts` | `{ path, redact }` directive. |
| `SPMessage` | `src/SPMessage.ts` | Wire format for every on-chain message. |
| `Secret<T>` | `src/Secret.ts` | `WeakMap`-backed wrapper that prevents accidental key leakage in logs / serialization. |
| `EncryptedData<T>` | `src/encryptedData.ts` | Tagged wrapper around encrypted payloads. |
| `SignedData<T>` | `src/signedData.ts` | Tagged wrapper around signed payloads. |
| `KvSlotDefinition` | `src/types.ts` | Argument shape for `chelonia/kv/defineSlot`. |
| `KvUpdater<T>` | `src/types.ts` | Reducer signature `(prev: T) => T | typeof KV_NOOP` used by `chelonia/kv/update`. |
| `KvUpdateCtx` | `src/types.ts` | Context object passed to `onUpdate` and included in `CHELONIA_KV_UPDATED` payloads. |
| `KvLoadStatus` | `src/types.ts` | `'non-init' | 'loading' | 'loaded' | 'error'` — status of a slot's mirror entry. |
| `KV_NOOP` | `src/kv.ts` | `Symbol.for('@chelonia/lib/KV_NOOP')` — return from an updater to abort the write. |

## Errors

All errors are generated by `ChelErrorGenerator` in `src/errors.ts`.

| Error | Thrown by |
|---|---|
| `ChelErrorUnexpected` | Generic recoverable error. |
| `ChelErrorDecryptionError` | Failed to decrypt an incoming op. |
| `ChelErrorDecryptionKeyNotFound` | No matching secret key for an encrypted op. |
| `ChelErrorSignatureError` | Signature verification failed. |
| `ChelErrorSignatureKeyNotFound` | No matching public key for a signature. |
| `ChelErrorSignatureKeyUnauthorized` | Signing key is known but not authorized for this op. |
| `ChelErrorAlreadyProcessed` | Strict-ordering rejected a past event. |
| `ChelErrorDBBadPreviousHEAD` | Strict-ordering rejected a future event. |
| `ChelErrorDBConnection` | DB backend failed to read/write. |
| `ChelErrorForkedChain` | Detected a forked event chain. |
| `ChelErrorKeyAlreadyExists` | Tried to add a key that already exists. |
| `ChelErrorUnrecoverable` | Non-recoverable processing failure. |
| `ChelErrorWarning` | Soft warning thrown as an error sentinel. |
| `ChelErrorFetchServerTimeFailed` | `chelonia/time` could not synchronize. |
| `ChelErrorUnexpectedHttpResponseCode` | Server returned an unexpected HTTP status. |
| `ChelErrorResourceGone` | Server signalled the resource is permanently gone (HTTP 410). |
| `ChelErrorJournalCorrupt` | `chelonia/journal/reconstruct` could not apply a stored patch. Has `entryIndex` and `contractID`. |
| `ChelErrorKvSlotUnknown` | KV slot or contract not found / not synced. Thrown by `read`, `update`, `sync`, `clear`. |
| `ChelErrorKvSlotInvalid` | Malformed `KvSlotDefinition` (bad key, schema, or defaultValue). Thrown by `defineSlot`. |
| `ChelErrorKvUpdateInvalid` | Invalid `update` arguments (both/neither `updater` + `value`, or `value` without `defaultUpdater`). |
| `ChelErrorKvValidation` | Reducer output failed `schema.parse`. |
| `ChelErrorKvConflict` | Unrecoverable conflict during `chelonia/kv/update` after exhausting retries. |

## Presets

```js
import { SERVER } from '@chelonia/lib'
await sbp('chelonia/configure', { ...SERVER, connectionURL })
```

`SERVER` enables `acceptAllMessages`, `skipActionProcessing`,
`skipSideEffects`, `skipDecryptionAttempts`, `strictProcessing`,
`strictOrdering`, and `saveMessageMetadata`. The caller MUST still
provide `connectionURL` (or any other site-specific config). See
`src/presets.ts`.
