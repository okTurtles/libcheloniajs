# Contracts: define, register, sync, publish

Once Chelonia is configured (see [`configure.md`](./configure.md)) and
connected, the contract API lives under three selector families:

| Family | Selectors | Purpose |
|---|---|---|
| `chelonia/defineContract` | `defineContract` | Register a contract definition (actions, getters, metadata) into Chelonia. |
| `chelonia/contract/*` | `sync`, `retain`, `release`, `currentKeyIdByName`, `fullState`, `isResyncing`, `isSyncing`, ... | Per-contract lifecycle: refcounting, syncing, key lookups. |
| `chelonia/out/*` | `registerContract`, `actionEncrypted`, `actionUnencrypted`, `keyAdd`, `keyDel`, `keyUpdate`, `keyShare`, `keyRequest`, `atomic` | Outgoing operations: publish messages to the relay. |

This page walks through one full lifecycle: define → register → publish
an encrypted action → tear down. The example assumes Chelonia is
already configured with a registered `stateSelector` and that
`sbp('chelonia/connect')` has been called.

## Table of contents

1. [Define the contract](#1-define-the-contract)
   - [Manifests (out of scope here)](#manifests-out-of-scope-here)
   - [Storing secret keys](#storing-secret-keys)
2. [Register the contract on-chain](#2-register-the-contract-on-chain)
3. [Sync & reference counting](#3-sync--reference-counting)
   - [Booting with a persisted root state](#booting-with-a-persisted-root-state)
4. [Publish an action](#4-publish-an-action)
   - [Key-management ops](#key-management-ops)
   - [Atomic batches](#atomic-batches)
   - [Hooks and `publishOptions`](#hooks-and-publishoptions)
5. [Read state](#5-read-state)
6. [Tear down](#6-tear-down)
7. [Common pitfalls](#common-pitfalls)

---

## 1. Define the contract

`chelonia/defineContract` registers a contract under a manifest hash.
Outside of manifest-driven autoloading (handled by
`chelonia/private/loadManifest` during `chelonia/configure`), you call
`defineContract` from inside your contract module's source. The
`manifest` field is populated by Chelonia's manifest loader (it sets
`this.defContractManifest` immediately before evaluating the contract
source), so a real contract source file does **not** hardcode it.

> **Where does this code live?** A contract module is the JavaScript
> body that the manifest's `body` entry points at. Chelonia's manifest
> loader fetches that body and evaluates it (eventually inside a
> sandbox), with `this.defContractManifest` pre-populated, so a
> top-level `sbp('chelonia/defineContract', { ... })` call wires
> everything up correctly. Calling `defineContract` from your app's
> entry point also "works" — the resulting registration uses
> `this.defContractManifest = undefined`, so the contract is reachable
> by name but bypasses the manifest → sandbox path and won't survive a
> production sandboxed deployment. Use it for local development /
> tests; ship contract code through the manifest pipeline.

A full contract definition has this shape
(authoritative source: `src/chelonia.ts` and below):

| Field | Type | Required | Purpose |
|---|---|---|---|
| `name` | `string` | yes | Contract type (e.g. `my.app/chatroom`). Must match the `ACTION_REGEX` (`<namespace>/<name>` form). |
| `getters` | `Record<string, (state, getters) => unknown>` | no | Vue-style computed views over `state`. Auto-exposed at `${manifest}/${name}/getters`. |
| `actions` | `Record<actionName, { validate, process, sideEffect? }>` | yes | One entry per action selector. Each action name must start with the contract `name`. |
| `methods` | `Record<string, Function>` | no | Free-standing helpers registered at `${manifest}/${methodName}`. Useful for contract-internal logic that isn’t a state mutation. |
| `metadata` | `{ validate(meta, ctx), create() }` | no | Per-message metadata factory. Defaults to no-op + `() => ({})`. Common pattern: stamp `createdDate`. |
| `state` | _set by Chelonia_ | — | Chelonia overwrites this with `(contractID) => rootState[contractID]`. Don’t set it yourself. |
| `manifest` | _set by Chelonia_ | — | Populated by the manifest loader. Don’t set it yourself. |

Each `action.process(message, { state, ...getters })` receives a
`ChelContractProcessMessageObject` with `{ data, meta, hash, height,
contractID, direction, signingKeyId, signingContractID, innerSigningKeyId?, innerSigningContractID? }`.
Mutate `state` directly — Chelonia treats the
function's return value as ignored. **`process` must be synchronous**
— do not declare it `async` and do not `await` anything inside it
(`src/internals.ts` is explicit about this; the `await` Chelonia wraps
around `process` exists only so it can dynamically load contract
source/definitions, not so contracts can do their own async work).
`sideEffect(mutation, { state,
...getters })` runs after `process` and receives the same mutated
copy of the contract state that `process` produced (Chelonia clones
the root contract state once per incoming event and reuses that copy
for both hooks). Do **not** mutate `state` from `sideEffect` — use
`sbp('chelonia/queueInvocation', contractID, ...)` for follow-up
state changes. Use `sideEffect` for I/O, event-emission, and SBP
calls that have to be in `contracts.defaults.allowedSelectors`.

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'

sbp('chelonia/defineContract', {
  name: 'my.app/chatroom',
  metadata: {
    validate (meta) {
      if (typeof meta?.createdDate !== 'string') {
        throw new TypeError('meta.createdDate must be an ISO string')
      }
    },
    create () {
      return { createdDate: new Date().toISOString() }
    }
  },
  getters: {
    messages: (state) => state.messages ?? []
  },
  actions: {
    'my.app/chatroom/post': {
      validate (data) {
        if (typeof data?.body !== 'string') {
          throw new TypeError('body must be a string')
        }
      },
      process ({ data, meta, hash }, { state }) {
        state.messages ??= []
        state.messages.push({ id: hash, body: data.body, at: meta.createdDate })
      },
      sideEffect ({ data, contractID }) {
        // `okTurtles.events/emit` must be listed in
        // `contracts.defaults.allowedSelectors` for this call to succeed.
        sbp('okTurtles.events/emit', 'CHATROOM_MESSAGE', {
          contractID, body: data.body
        })
      }
    }
  }
})
```

Any SBP selector invoked from `process` / `sideEffect` / `methods`
must be listed in `contracts.defaults.allowedSelectors` when you call
`chelonia/configure`. (`contracts.overrides` is reserved for future
per-contract overrides but is **not** currently consumed by the
runtime — see [`configure.md`](./configure.md#contracts).) The
example above needs `'okTurtles.events/emit'` for the `sideEffect`.

### Manifests (out of scope here)

`defineContract` registers a definition under the manifest hash that
Chelonia’s manifest loader injected before evaluating the contract
source. The on-disk format of a manifest (signed JSON pointing at one
or more contract `body` files), the tooling for producing one, and
signing conventions are **not currently documented in this repo** —
see the relay-server / SDK that produces your manifests. Configure
Chelonia with the resulting `{ name: manifestHash }` map under
`contracts.manifests` and Chelonia will eagerly load each manifest
during `chelonia/configure`.

### Storing secret keys

Before you can sign or decrypt anything, Chelonia needs the secret
halves of any keys it will use. `chelonia/storeSecretKeys` accepts a
`Secret<{ key: Key | string; transient?: boolean }[]>`:

```js
import sbp from '@sbp/sbp'
import { Secret } from '@chelonia/lib'
import { keygen, EDWARDS25519SHA512BATCH } from '@chelonia/crypto'

const csk = keygen(EDWARDS25519SHA512BATCH)

sbp('chelonia/storeSecretKeys', new Secret([
  { key: csk },               // persistent: written to rootState.secretKeys
  { key: someOtherKey, transient: true } // RAM-only: lost on reload
]))
```

- `key` may be a `Key` (from `@chelonia/crypto`) or its serialized
  string form. Strings are deserialized via `deserializeKey`.
- Persistent keys (default) land in `rootState.secretKeys[keyId]` as
  serialized strings *and* in the in-memory `transientSecretKeys` map.
  They survive a page reload as long as your `stateSelector` is
  persisted: on the next `chelonia/configure` Chelonia rehydrates
  every entry under `rootState.secretKeys` back into
  `transientSecretKeys` automatically, so you do **not** need to call
  `storeSecretKeys` again for persistent keys after a reload.
- `transient: true` keys live only in `transientSecretKeys`. Use this
  for short-lived material (e.g. a `keyRequestResponseId` reply key)
  or for secrets you intentionally don’t want persisted.
- The `Secret` wrapper keeps the key material out of accidental log
  lines / stack traces. The selector’s signature requires it — passing
  a bare array will not type-check.
- Existing entries are **not** overwritten: calling
  `storeSecretKeys` twice with the same `keyId` is a no-op for that
  entry. To remove transient keys explicitly, call
  `chelonia/clearTransientSecretKeys` (optionally with a `string[]`
  of ids).
- To check whether Chelonia has a key, use
  `chelonia/haveSecretKey(keyId, persistent?)`.

---

## 2. Register the contract on-chain

> The example below assumes you have already called `chelonia/connect`.
> `chelonia/configure` does **not** auto-connect. Outgoing publishes
> work without `connect` (Chelonia POSTs via `config.fetch`), but
> incoming pubsub events — including your own actions echoed back
> through `process`/`sideEffect` — only arrive once the socket is
> open. Call `chelonia/connect` before publishing if you expect to
> observe local state updates.

`chelonia/out/registerContract` publishes the first message
(`OP_CONTRACT`) and returns the published action message. The
contractID is the hash of that first message — read it from the
returned message via `msg.contractID()`.

```js
import sbp from '@sbp/sbp'
import { Secret } from '@chelonia/lib'
import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  keyId,
  keygen,
  serializeKey
} from '@chelonia/crypto'

// Create signing (CSK) and content-encryption (CEK) keys.
// `@chelonia/crypto`'s `Key` type is `{ type, secretKey?, publicKey? }` —
// it has no `id` field. Derive the id via `keyId(key)`.
const csk = keygen(EDWARDS25519SHA512BATCH)
const cek = keygen(CURVE25519XSALSA20POLY1305)
const cskId = keyId(csk)
const cekId = keyId(cek)

// Hand the secret material to Chelonia (see "Storing secret keys"
// above for the full rules).
sbp('chelonia/storeSecretKeys', new Secret([
  { key: csk }, // signing key
  { key: cek }  // content-encryption key
]))

const msg = await sbp('chelonia/out/registerContract', {
  contractName: 'my.app/chatroom',
  keys: [
    {
      id: cskId,
      name: 'csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      allowedActions: '*',
      data: serializeKey(csk, false)
    },
    {
      id: cekId,
      name: 'cek',
      purpose: ['enc'],
      ringLevel: 1,
      permissions: '*',
      data: serializeKey(cek, false)
    }
  ],
  signingKeyId: cskId,
  actionSigningKeyId: cskId,
  actionEncryptionKeyId: cekId,
  data: { name: 'general' }
})

const contractID = msg.contractID()
```

`registerContract` internally:

1. Publishes `OP_CONTRACT`,
2. Calls `chelonia/private/in/sync` to load the new contract,
3. Publishes the initial `OP_ACTION_(EN|UN)CRYPTED` carrying `data`.

The returned `msg` is the second of those two (the initial action).
Its `contractID()` is the id used by every other selector.

---

## 3. Sync & reference counting

Subscribed contracts are tracked by reference count. After registering
or learning about a contract you want to follow:

```js
// Increment the persistent refcount and trigger a sync. Required
// before reading state on app boot from a persisted root state.
await sbp('chelonia/contract/retain', [contractID])

// Force a re-sync. You usually don't need to call this directly —
// `retain` already triggers a sync, and subsequent pubsub events flow
// in automatically. Use `sync` for explicit re-syncs after marking a
// contract `_volatile.dirty`, or when debugging.
await sbp('chelonia/contract/sync', [contractID])

// Later, when you stop caring about the contract:
await sbp('chelonia/contract/release', [contractID])
// At refcount 0 Chelonia unsubscribes and removes it when safe.
// If foreign-key watches still require it, removal is deferred.
```

`retain` / `release` also accept `{ ephemeral: true }` for short-lived
subscriptions (e.g. one-off lookups) that are kept in-memory only
and don't survive a `chelonia/reset` cycle.

You can introspect sync state via `chelonia/contract/isSyncing(id)`,
`chelonia/contract/isResyncing(id)`, and
`chelonia/contract/currentSyncs()`.

### Booting with a persisted root state

The more common case than `registerContract` is "the app reloads with
a state blob from disk; reconnect every contract the user was
following". Persisted root state already contains
`rootState.contracts[contractID]` entries (with `references`, `HEAD`,
`_journal`, etc.) but Chelonia's in-memory `subscriptionSet` is empty
on boot, so pubsub knows nothing yet. The fix is to re-`retain` each
known contract — `retain` increments the refcount, opens the pubsub
subscription, and triggers a fast sync against the stored HEAD.

```js
// After `chelonia/configure` + `chelonia/connect`, but before the UI
// asks Chelonia for any contract state:
const rootState = sbp('chelonia/rootState')
const knownContractIDs = Object
  .keys(rootState.contracts ?? {})
  // Skip contracts the server has marked as deleted (rootState.contracts[id] === null).
  .filter((id) => rootState.contracts[id] !== null)

if (knownContractIDs.length) {
  // Re-secret-keys first if your stateSelector persisted them — see
  // "Storing secret keys" above.
  await sbp('chelonia/contract/retain', knownContractIDs)
}
```

`retain` is idempotent across reloads in the sense that calling it on
a contract that already has `references >= 1` simply bumps the
counter — it does *not* require matching `release` calls from prior
sessions. If your app keeps its own "currently joined" list, treat
the persisted-state pass and your app's own joins as additive: every
`retain` you call must be paired with a `release` *during this
session*. Use `chelonia/contract/withRetained(ids, callback)` if you
just want a scoped subscription.

---

## 4. Publish an action

```js
const signingKeyId =
  sbp('chelonia/contract/currentKeyIdByName', contractID, 'csk')
const encryptionKeyId =
  sbp('chelonia/contract/currentKeyIdByName', contractID, 'cek')

await sbp('chelonia/out/actionEncrypted', {
  action: 'my.app/chatroom/post',
  contractID,
  data: { body: 'hello, world' },
  signingKeyId,
  // Outer signing key Chelonia uses to sign the OP. Identifies the
  // "sender" to the relay/other clients.
  innerSigningKeyId: signingKeyId,
  // Inner signing key. Use the same CSK to attest "the action body
  // came from this key", or pass `null` to skip the inner signature
  // (e.g. anonymous chatroom posts). Required field; pass `null`
  // explicitly if you don’t want an inner signature.
  encryptionKeyId
})
```

`innerSigningKeyId` is a **required** field on `ChelActionParams` (see
`src/chelonia.ts`). The conventions Group Income established:

| `innerSigningKeyId` | Effect |
|---|---|
| same as `signingKeyId` | Single-signer action (typical). |
| key id of a *foreign* key (a key Chelonia knows about from a different contract) | Action is sent on behalf of one contract but attested by another — useful when posting into a shared contract from your identity. Chelonia derives `innerSigningContractID` from the inner-signing key's contract at processing time; it is *not* a caller-supplied param. |
| `null` | No inner signature. The outer signature still identifies the sender. |

`chelonia/contract/currentKeyIdByName` resolves a key by its
contract-local `name` field to the current keyID (which can rotate via
`OP_KEY_UPDATE`). Use it instead of pinning to a literal keyID.

The unencrypted variant (`chelonia/out/actionUnencrypted`) takes the
same shape minus `encryptionKeyId`.

---

## Key-management ops

The four operations documented below follow the same pattern: pass the contract you’re
mutating, a `signingKeyId` with `OP_KEY_*` permission, and an
operation-specific `data` payload. Each can also be embedded in
`chelonia/out/atomic` (see next section) by setting `atomic: true` and
letting the atomic call publish.

### `chelonia/out/keyAdd`

```js
await sbp('chelonia/out/keyAdd', {
  contractName: 'my.app/chatroom',
  contractID,
  signingKeyId,
  data: [
    {
      id: keyId(newKey),
      name: 'invite-1',
      purpose: ['sig'],
      ringLevel: 2,
      permissions: '*',
      allowedActions: '*',
      data: serializeKey(newKey, false)
    }
  ]
})
```

`data` is an array so a single op can add multiple keys atomically.
Duplicate-`id` entries are skipped unless you set
`skipExistingKeyCheck: true` (used inside atomic `keyDel`+`keyAdd`
rotations).

### `chelonia/out/keyDel`

```js
await sbp('chelonia/out/keyDel', {
  contractName: 'my.app/chatroom',
  contractID,
  signingKeyId,
  data: [keyIdToRevoke]    // array of key ids
})
```

### `chelonia/out/keyUpdate`

Rotate a key and/or change its `permissions` / `purpose`:

```js
await sbp('chelonia/out/keyUpdate', {
  contractName: 'my.app/chatroom',
  contractID,
  signingKeyId,
  data: [
    {
      oldKeyId,
      id: keyId(rotatedKey),
      name: 'csk',          // contract-local name stays the same
      purpose: ['sig'],
      data: serializeKey(rotatedKey, false)
    }
  ]
})
```

### `chelonia/out/keyShare`

Share a secret key with another contract’s `_vm`:

```js
import { encryptedOutgoingData } from '@chelonia/lib/encryptedData'
import { serializeKey, keyId } from '@chelonia/crypto'

// Wrap the secret key material so it can safely travel to the
// recipient contract: encrypt the serialized private key to the
// recipient's encryption key.
const encryptedSerializedKey = encryptedOutgoingData(
  recipientContractID,         // wrap to the recipient's encryption key
  recipientEncryptionKeyId,
  serializeKey(cek, true)      // `true` = include the private half
)

// In addition, real-world consumers (e.g. Group Income) wrap the
// *whole* `data` payload — `{ contractID, keys: [...] }` — in another
// `encryptedOutgoingData` so the recipient list itself does not leak
// to the relay. The plain (unwrapped) form below publishes that list
// as signed-but-unencrypted metadata; prefer the double-encrypted
// form when the recipient set is sensitive:
//
//   data: encryptedOutgoingData(recipientContractID, recipientEncryptionKeyId, {
//     contractID,
//     keys: [{ id: keyId(cek), name: 'cek', purpose: ['enc'], ringLevel: 1,
//             permissions: '*',
//             meta: { private: { content: encryptedSerializedKey } } }]
//   })
await sbp('chelonia/out/keyShare', {
  contractName: 'my.app/chatroom',
  contractID: recipientContractID,
  signingKeyId,
  data: {
    contractID,            // the contract whose keys are being shared
    keys: [
      // Each entry is a full `SPKey` (see `src/SPMessage.ts`). The
      // shared secret material rides on `meta.private.content` as an
      // `EncryptedData<string>` wrapping the serialized secret key
      // (e.g. produced by `encryptedOutgoingData`).
      {
        id: keyId(cek),
        name: 'cek',
        purpose: ['enc'],
        ringLevel: 1,
        permissions: '*',
        meta: { private: { content: encryptedSerializedKey } }
      }
    ]
  }
})
```

### `chelonia/out/keyRequest`

Ask another contract to share its keys with the originating contract.
See `ChelKeyRequestParams` in `src/chelonia.ts` for the full
parameter set — it includes `originatingContractID`,
`innerEncryptionKeyId`, optional `permissions`, `allowedActions`,
`request` selector, and `keyRequestResponseId` to reuse an existing
`#krrk` key id rather than minting a fresh one.

---

## Atomic batches

Bundle multiple outgoing operations into a single `OP_ATOMIC` so they
are published — and processed by every subscriber — as a unit:

```js
await sbp('chelonia/out/atomic', {
  contractName: 'my.app/chatroom',
  contractID,
  signingKeyId,
  data: [
    ['chelonia/out/keyDel', {
      contractName: 'my.app/chatroom',
      contractID,
      signingKeyId,
      data: [oldKeyId],
      atomic: true
    }],
    ['chelonia/out/keyAdd', {
      contractName: 'my.app/chatroom',
      contractID,
      signingKeyId,
      data: [newKeySpec],
      atomic: true,
      skipExistingKeyCheck: true
    }]
  ]
})
```

Each inner entry MUST set `atomic: true` so the inner selector returns
an op rather than publishing on its own. Only
`chelonia/out/actionEncrypted`, `actionUnencrypted`, `keyAdd`,
`keyDel`, `keyUpdate`, `keyShare`, and `keyRequestResponse` are
accepted inside atomic batches (see the whitelist in
`src/chelonia.ts`); anything else — including
`chelonia/out/keyRequest` — throws.

---

## Hooks and `publishOptions`

Every `/out/*` selector accepts an optional `hooks` object and an
optional `publishOptions` object on its params (see `ChelRegParams` /
`ChelActionParams` / etc. in `src/chelonia.ts`). Both pass
through to the underlying `chelonia/private/out/publishEvent`.

### `hooks`

`hooks` is a `SendMessageHooks` (`src/types.ts`). Each callback is
optional; Chelonia calls them around the publish lifecycle:

| Hook | When it fires | Notes |
|---|---|---|
| `prepublish(msg)` | Right before the first publish attempt. May be `async`. | Use for last-minute mutations to derived state — e.g. recording the outgoing hash in a UI-only queue. Throwing aborts the publish. |
| `beforeRequest(newEntry, oldEntry)` | Before every HTTP attempt, after Chelonia recreates the message (height/previousHEAD updated). | Fires once per retry. `oldEntry` is the previously-serialized entry from the prior attempt. |
| `preSendCheck(msg, state)` | Inside the per-contract queue before the wire send. | Return `false` to silently cancel the publish (e.g. \"another writer raced us\"). |
| `postpublish(msg)` | After the relay accepts the message. | Useful for fire-and-forget follow-up work; runs before local processing. |
| `onprocessed(msg)` | After the message has come back over pubsub and run through `process` + `sideEffect`. | Subscribed via `EVENT_HANDLED`; the listener is automatically detached after firing once. |

`chelonia/out/registerContract` additionally accepts `prepublishContract`
and `postpublishContract` (`src/chelonia.ts`), which apply to
the initial `OP_CONTRACT` rather than to the follow-up action.

### `publishOptions`

`publishOptions` tunes the wire-level behaviour:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `maxAttempts` | `number` | `5` | How many times to retry on HTTP `409` (HEAD raced). After this many failures `publishEvent` throws. |
| `headers` | `Record<string, string>` | none | Extra HTTP headers merged into the `POST /event` request (e.g. tracing IDs). |
| `billableContractID` | `string` | none | Sets the `Shelter` Authorization header. The relay charges this contract's quota for the operation. Mutually exclusive with `bearer`. |
| `bearer` | `string` | none | Sets `Authorization: Bearer <token>` instead. |
| `disableAutoDedup` | `boolean` | `false` | Skip Chelonia's automatic \"already-processed\" detection. Rarely needed; set when intentionally re-publishing a known-duplicate op. |

```js
await sbp('chelonia/out/actionEncrypted', {
  action: 'my.app/chatroom/post',
  contractID,
  data: { body: 'hello' },
  signingKeyId,
  innerSigningKeyId: signingKeyId,
  encryptionKeyId,
  hooks: {
    postpublish: (msg) => console.log('relay accepted', msg.hash()),
    onprocessed: (msg) => console.log('locally processed', msg.hash())
  },
  publishOptions: {
    maxAttempts: 10,
    billableContractID: identityContractID
  }
})
```

---

## 5. Read state

Chelonia maintains your contract's state under
`rootState[contractID]` (the bookkeeping subtree lives at
`rootState.contracts[contractID]`). To get a snapshot:

```js
const { cheloniaState, contractState } =
  sbp('chelonia/contract/fullState', contractID)
// cheloniaState  → rootState.contracts[contractID]  (includes _journal!)
// contractState  → rootState[contractID]            (your action-produced state)
```

If journaling is enabled, `cheloniaState._journal` rides along with
`cheloniaState`. See
[`journal.md`](./journal.md#consumer-visible-leakage) for how to
project it out.

---

## 6. Tear down

```js
await sbp('chelonia/contract/release', [contractID]) // refcount-aware
// or, for a full logout:
await sbp('chelonia/reset')
```

`chelonia/reset(newState?, postCleanupFn?)` drains pending publishes,
aborts in-flight messages, clears `rootState.contracts` and
`rootState.secretKeys`, drops all subscriptions, and emits
`CHELONIA_RESET` + `CONTRACTS_MODIFIED`.

- The single-argument form accepts **either** `newState` (a
  `ChelRootState` to seed into the root state after the wipe) **or**
  `postCleanupFn` (an `async` callback invoked after the drain but
  before the synchronous wipe). Chelonia picks based on the typeof.
- The two-argument form is `(newState, postCleanupFn)`.
- The return value is whatever `postCleanupFn` returned (or
  `undefined`).
- `chelonia/reset` does **not** close the pubsub socket — call
  `pubsub.destroy()` (or just let GC handle it) if you want a hard
  shutdown.
- `chelonia/reset` clears state in bulk; it does **not** call
  `release` for each retained contract. If your app maintains its own
  "currently retained" list outside Chelonia, treat `reset` as
  invalidating that list and rebuild it from scratch on next boot
  rather than calling `release` against the now-empty state.

```js
// Seed a known root state after reset (e.g. after logout-with-import):
await sbp('chelonia/reset', { contracts: {} })

// Run a callback after the drain but before the wipe (e.g. snapshot
// state to durable storage):
await sbp('chelonia/reset', async () => {
  await snapshotToDisk(sbp(stateSelector))
})
```

---

## Common pitfalls

- **Forgetting `chelonia/connect`.** `chelonia/configure` does not
  open the pubsub socket. Outgoing `/out/*` selectors still POST to
  the relay via `config.fetch`, but **incoming** pubsub events
  (everyone else's actions, your own actions echoed back through
  `process` + `sideEffect`) never arrive until you call
  `sbp('chelonia/connect')`. Symptom: actions appear to publish
  successfully but your local state never updates.
- **Forgetting `chelonia/storeSecretKeys` before publishing.**
  `registerContract` and `actionEncrypted` look up signing keys in
  `transientSecretKeys`. Calling them with a `signingKeyId` Chelonia
  doesn’t have throws an opaque `Signing key ... is not defined`.
- **Pinning to a literal key id.** Use
  `chelonia/contract/currentKeyIdByName` so key rotation via
  `OP_KEY_UPDATE` doesn’t break your call sites.
- **Missing `innerSigningKeyId`.** It is a *required* field on
  `ChelActionParams`. Pass the same id as `signingKeyId` for the
  common case, or `null` to skip the inner signature.
- **Calling `chelonia/contract/sync` without retaining first.**
  `sync` validates that there is a positive refcount; otherwise it
  throws `Missing reference count for contract`. Always `retain`
  before `sync` (or use `chelonia/contract/withRetained`).
- **Listing `okTurtles.events/emit` (or any other SBP selector you
  call from a contract) is required.** If it’s not in
  `contracts.defaults.allowedSelectors`, the call inside
  `sideEffect` will throw at runtime.
- **`sideEffect` mutating `state`.** Mutations *do* land in the root
  state (Chelonia clones the contract state once per event and reuses
  the same copy for `process` and `sideEffect`), but they (a) bypass
  the journal's after-state diff (recorded after `sideEffect` returns),
  and (b) race the next event's `cloneDeep`. Do follow-up state
  changes via `sbp('chelonia/queueInvocation', contractID, ...)` so
  they run as a fresh event after the current one has been applied.

---

## See also

- [`quickstart.md`](./quickstart.md) — end-to-end runnable example.
- [`configure.md`](./configure.md) — config surface, hooks, reconfigure
  semantics.
- [`journal.md`](./journal.md) — per-contract state-change journal.
- [`api.md`](./api.md) — flat selector / type / error index.
- `src/chelonia.ts` — authoritative source for every selector listed
  here.
