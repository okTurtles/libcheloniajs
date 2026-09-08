# Keys: declarative key definitions and derivation

This guide shows how to define the keys of a contract in one declarative,
name-addressed structure. Chelonia then does the `keygen`, the `keyId`, the
`serializeKey`, the wrapping, and the assembly. The guide also covers
name-addressed references, generic sharing, and rotation.

- Selector reference: [`api.md`](./api.md#key-api)
- Source: [`src/keys.ts`](../src/keys.ts) (pure engine + selectors),
  [`src/chelonia.ts`](../src/chelonia.ts) (selector integration)

Everything here is additive. Raw `SPKey[]` arrays, `EncryptedData<SPKey>`
entries, and every existing `*KeyId` parameter continue to work without
change.

## Concepts

### Key specs: name-addressed declarations

The unit of the API is a **key spec**. A key spec is a partial description
of a key, and it carries a name. Chelonia derives all other fields: `id`,
`data`, `meta.private.content`, and the curve type. Two equivalent forms
exist:

```js
// Object form (recommended): the record key is the caller alias
keys: {
  csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', encryptWith: 'iek' },
  cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' }
}

// Array form, when order or duplication of aliases matters. Every entry must
// be a `keySpec()`; raw SPKey objects are mixed in at the selector level
// (`chelonia/out/keyAdd`'s `data`), not inside `keys:`.
keys: [keySpec('csk', { ... }), keySpec('cek', { ... })]
```

You must make each array entry with `keySpec(alias, spec)`. A prototype
marker tells a spec from a raw `SPKey`. The library never infers a spec from
missing fields.

### Aliases and wire names

The **alias** is the record key in object form. It is also the first
argument of `keySpec()`. You use the alias in the `KeyMap`, in
`encryptWith`, and in the name-based registration fields.

The **wire name** (`GeneratedKey.name`, `SPKey.name`) is the name on the
chain. Alias and wire name are the same in the normal case. They differ in
two cases:

1. The spec sets `name` explicitly. Then `keySpec(alias, spec)` keeps the
   alias and the given `spec.name` separate, exactly like the object form.
2. The key is an invite key. The wire name then gets the id as a suffix:
   `#inviteKey` becomes `#inviteKey-<id>`.

For this reason, two invite specs with the same `name` do not collide. This
is also true for multiple `keySpec()` entries in array form.

### The wrapping graph (`encryptWith`)

The field `encryptWith: '<name>'` makes this declaration: the secret half
of this key is encrypted under the key named `<name>`. The target is one
of:

- A different key in the same spec set. Chelonia wraps with the raw key.
- `{ key }`: a raw key that you already hold (for example, a password key
  from a fresh derivation).
- `{ contractID, name }` (spec generation only): an active key in a loaded
  contract, wrapped by id. For this reason, a concurrent rotation of the
  wrapper still decrypts.
- A plain string that is not in the set, in `keyAdd` contexts: an active
  key in the target contract, wrapped by id.

The specs form a directed acyclic graph (DAG). Chelonia resolves this
graph. A cycle between two or more different keys throws
`ChelErrorKeyWrapCycle`. Self-wrap means `encryptWith: 'cek'` on the `cek`
spec itself. It is correct: the secret of the key is encrypted under the
key itself. This is a common CEK pattern.

If you omit `encryptWith`, the contract stores only the public half. This
is exactly the current meaning of an omitted `meta.private.content`. The
library gives an error for a `meta.private.content` that you set directly
on a spec.
Such a value bypasses three mechanisms: the wrapper purpose check, the
in-set or in-contract resolution, and the cycle detection. The library also
never validates the value against the key that it is attached to. Put
hand-crafted entries in the raw `SPKey` form. The selector
`chelonia/out/keyAdd` still takes this form.

### Conventions as defaults

| Name pattern | Defaults |
|---|---|
| `#sak` | `purpose: ['sak']`, `ringLevel: 0`, `permissions: []`, `allowedActions: []`, edwards key. These are the invariants that `keyAdditionProcessor` enforces. Chelonia now checks them at authoring time. |
| `#inviteKey` (or `#inviteKey-*`) | `ringLevel: Number.MAX_SAFE_INTEGER`, `purpose: ['sig']`. The fields `quantity` and `expires` are optional and apply to invites only (see [Invite quantity and expiry](#invite-quantity-and-expiry)). Only the exact name `#inviteKey` gets the id suffix. A name like `#inviteKey-foo` is also an invite. It gets the same defaults and the same invite accounting, but it keeps its name without change. |
| anything else | `permissions: []`, `allowedActions: []` (fail-closed). The field `ringLevel` is necessary. It is a security decision. |

Chelonia infers the curve type. A purpose with only `enc` means the type
`CURVE25519XSALSA20POLY1305`. A purpose with `sig` or `sak` means the type
`EDWARDS25519SHA512BATCH`. If you supply `key` or public `data`, the type
comes from the key. Chelonia then makes sure that the purpose agrees with
the type.

The `#` namespace is reserved. Only these exact names and their documented
suffix forms pass: `#sak`, `#inviteKey`, `#inviteKey-*`, and `#krrk-*`.
Every other name with the `#` prefix gets an error. This includes near
misses, for example `#sak-1` or a bare `#krrk`: accepting one would quietly
make an ordinary key that no convention handling matches, which is never
what the author of such a name intended.

### Invite quantity and expiry

The field `quantity` on an invite spec gives the number of times that a
person can use the invite. If you do not set it, the invite has unlimited
uses. This is a feature, not an omission.

The `OP_KEY_REQUEST` processing decreases a quantity only when
`meta.quantity` is present. Only such an invite can become used up. An
invite without a quantity stays correct until its revocation, or until its
`expires` time passes.

Because an omitted quantity has a large effect, the explicit form is a
symbol:

```js
import { UNLIMITED_INVITE_USES } from '@chelonia/lib/keys'

keys: {
  memberInvite: { name: '#inviteKey', quantity: 60 },
  publicInvite: { name: '#inviteKey', quantity: UNLIMITED_INVITE_USES }
}
```

`UNLIMITED_INVITE_USES` and an omitted `quantity` give the same wire form:
no `meta.quantity`. The symbol only documents the intent at the call site.
A numeric `quantity` must be a positive safe integer. The values `0`, `NaN`,
fractions, and negative numbers get an error at authoring time. Such a key
is not usable. On the wire, you cannot tell it from a damaged key.

The processing works in the same way. `keyAdditionProcessor` records an
invite with no `meta.quantity` as correct and unlimited. It fails closed
only when `meta.quantity` is present and is not a positive safe integer. It
then records the invite as revoked. Only a hand-built `SPKey` or a message
from an attacker can have this shape.

The field `expires` is a `Date.now()` millisecond timestamp. It must be a
positive safe integer. Omit it for an invite that does not expire. The
reason for the check is that processing compares the value with `<`, and
every comparison against a non-number is `false`. An `expires` of
`'tomorrow'` would therefore produce an invite that never expires, which is
the opposite of the intent.

Both fields apply to invite keys only. `keyAdditionProcessor` reads
`meta.quantity` and `meta.expires` in its `#inviteKey-` branch, and nothing
else looks at them. Declaring either on any other name gets an error rather
than a silent no-op, because a `quantity` on a CSK reads like a use limit
and an `expires` on a CSK reads like a lifetime, and neither has any
effect. Use revocation to end the life of an ordinary key.

### The secret-key lifecycle

1. Expansion registers each raw key as **transient**
   (`chelonia/storeSecretKeys`, `transient: true`). The outgoing message
   needs this registration for its signature and for local processing.
2. `transient: true` on a spec sets `meta.private.transient`. This field
   makes `keyAdditionProcessor` skip the persistence step.
   Password-derived keys like IPK and IEK use it.
3. Chelonia stores every non-transient wrapped key automatically. This
   happens when it processes the outgoing `OP_CONTRACT` or `OP_KEY_ADD`. A
   manual "store persistent keys" call after registration has no effect.
   It is only a safety net.

The clearing of password-derived keys after registration stays an explicit
call. Use the ids from the `KeyMap` that the selector returns:

```js
await sbp('chelonia/clearTransientSecretKeys', [K.ipk.id, K.iek.id])
```

Keys that Chelonia made stay transient after a failed publish. This matches
the current manual workflow. There is no automatic rollback:

- A publish failure does not prove a rejection. The server can store the
  event, and then the response can be lost. The secret of a live on-chain
  key is then gone.
- A spec set is not always fresh material. An entry with an explicit `key`
  can be in the secret-key store before expansion. Examples are
  password-derived roots and keys that the caller holds. The entry can even
  be there on purpose, stored permanently. The selector
  `chelonia/storeSecretKeys` keeps this existing entry. A complete rollback
  can clear key material that the caller owns and still needs.
- The publish can fail after the caller uses the `KeyMap`. Examples are
  invite links, recovery metadata, and `onKeysReady` side effects.

Note: an id collision is not the concern. A fresh id comes from random key
material, so the store cannot have this id in it already. For this reason,
the clearing stays an explicit call, with the ids from the returned
`KeyMap`.

## Generating keys: `chelonia/key/generate`

The composable entry point with two phases:

```js
const K = sbp('chelonia/key/generate', {
  contractID?,            // optional: when present, `encryptWith` may also
                          // reference active keys in that contract by name
  keys: KeySpecMap | MarkedKeySpec[]
})
```

The result is a `KeyMap`: `Record<alias, GeneratedKey>`, where

```ts
type GeneratedKey = {
  name: string   // the final wire name ('#inviteKey-<id>' for invites)
  id: string     // keyId(key)
  key?: Key      // raw key — treat as sensitive; undefined for data-only
                 // and foreign entries
  spkey: SPKey   // the assembled, ready-to-publish key
}
```

Side effects: the selector registers every raw key as transient. This is
the only side effect. The selector makes no messages and sends none. Use
`serializeKey(k.key, true)` when a consumer really needs the serialized
secret. Examples are invite links and recovery metadata.

CAUTION: Never log a `KeyMap`. Never put a serialized `KeyMap` into state.
A `KeyMap` is secret material.

### Purity

The functions `expandKeySpecs` and `expandKeyUpdateSpecs` are pure. They
use no Chelonia or SBP state. All contract state goes in through an
explicit `KeyExpansionContext`. Expansion calls no selector. The
`EncryptedData` wrappers are lazy. The encryption happens at serialization
time, not at expansion time.

## Spec-based registration

`chelonia/out/registerContract` takes the spec form when `keys` is a
`KeySpecMap` (or an array with marked specs):

```js
await sbp('chelonia/out/registerContract', {
  contractName: 'gi.contracts/identity',
  signingKeyName: 'ipk',
  actionSigningKeyName: 'csk',
  actionEncryptionKeyName: 'pek',
  keys: {
    ipk: { key: IPK, purpose: ['sig'], ringLevel: 0, permissions: '*', transient: true },
    iek: { key: IEK, purpose: ['enc'], ringLevel: 0, transient: true },
    csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' },
    cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' },
    pek: { purpose: ['enc'], ringLevel: 2, encryptWith: 'cek' },
    '#sak': { encryptWith: 'iek' }
  },
  data: (K) => ({ ...params.data, inviteSecret: serializeKey(K.someKey.key, true) }),
  onKeysReady: async (K) => { /* runs after transient registration,
                                 before the message is created */ },
  publishOptions
})
```

Semantics:

1. Chelonia expands spec-form `keys` through `chelonia/key/generate`, in
   the same tick.
2. The `*KeyName` fields resolve against the `KeyMap` (an alias or a wire
   name).
3. A function `data` gets the `KeyMap`. In this way, an application puts
   invite secrets into the join payload, and it does not need to make the
   keys first. The function can be `async`. Chelonia awaits the result
   before it builds the payload.
4. `onKeysReady` runs after the transient storage and before the creation
   of the payload or message. Chelonia awaits it too. An error in
   `onKeysReady`, or in the data factory, stops the publication.
5. Everything after the expansion uses the current code path: the same
   `SPMessage`, the same publish, the same sync. The return value does not
   change. It is the initial-action `SPMessage`.

The option `autoSak` is opt-in for the first release. The default is off.
When you enable it, you must give an explicit wrapper. The wrapper is a
security decision, and the library does not guess it:

```js
autoSak: { encryptWith: 'iek' }  // or declare '#sak' explicitly
```

Calls with raw arrays keep the exact legacy behavior: no auto-SAK, no
callbacks, no expansion.

### Service-worker caveat

The functions themselves are transport-serializable. `@chelonia/serdes`
changes a function into a `MessagePort`. On the far side, serdes assembles
an async proxy again. Selector calls cross a tab-to-service-worker boundary
in this way today. But the `KeyMap` that these callbacks receive cannot
cross this boundary:

- `Key` objects keep the secret half in non-enumerable storage. The
  serialized copy carries only the public half. On the far side,
  `serializeKey(K.x.key, true)` throws `no secret key to export`. But an
  invite link or a recovery blob needs exactly this secret.
- The field `spkey.meta.private.content` is a lazy `EncryptedData` wrapper.
  It has no serdes tag. After the serialization, only `{ encryptionKeyId }`
  stays. The wrapped secret is gone.
- There is also a third problem, and it is serious. Serialization moves the
  typed arrays that back the keys. This transfer detaches the arrays in the
  sender. After one proxied call, the local `KeyMap` is not usable:
  `keyId()` throws on a detached buffer. A second call fails with `Cannot
  transfer object of unsupported type`.

For this reason, `onKeysReady` and the `data` factory must run in the
context that owns Chelonia. This is the same context that made the keys.
Chelonia awaits both callbacks, so an `async` callback is correct locally.
But do not send the callbacks across a boundary. Do not send a `KeyMap`
back from a remote `chelonia/key/generate` call either.

Callers across a boundary have two options:

1. Do the complete registration on the Chelonia side. Expose one
   application-level selector there. This selector builds the specs and the
   callbacks locally. Call it from the tab with plain serializable
   arguments.
2. Move key material explicitly as strings, never as `Key` objects. Make
   the keys where the secret is necessary. Send `serializeKey(key, true)`
   in a `Secret`, which is serdes-registered. Give it back through
   `spec.key` or `spec.data` on the other side.

The suite "KeyMap across a serdes boundary" in
`src/keys-integration.test.ts` pins this behavior. It makes sure that this
caveat stays correct.

## Name references across outgoing operations

Every `*KeyId` parameter on the out-selectors has a `*KeyName` twin. To
resolve a name means: change the name into the id of the current key. The
name twin resolves against the current state of the target contract. At
registration time, the aliases resolve. After that, the function
`findKeyIdByName` does the work:

| Selector | Name twins |
|---|---|
| `chelonia/out/actionEncrypted` / `actionUnencrypted` | `signingKeyName`, `innerSigningKeyName`, `encryptionKeyName` |
| `chelonia/out/keyAdd`, `keyDel`, `keyUpdate`, `keyShare`, `keyRequestResponse` | `signingKeyName` |
| `chelonia/out/keyRequest` | `signingKeyName`, `innerSigningKeyName`, `encryptionKeyName`, `innerEncryptionKeyName` |
| `chelonia/out/atomic` | `signingKeyName` (the outer message only, and nested invocations keep their own references) |
| `chelonia/out/encryptedOrUnencryptedPubMessage` | same as the action selectors |

For `chelonia/out/keyRequest`, each name resolves against its real owner.
The outer `signingKeyName` and the `innerEncryptionKeyName` live in the
destination contract. The `innerSigningKeyName` and the `encryptionKeyName`
live in the originating contract. This flow is easy to get wrong. The types
show which name belongs where.

### id/name pair semantics

For every `fooKeyId` / `fooKeyName` pair:

- Neither field, when the pair is necessary → `TypeError`
- Only an id → the current behavior
- Only a name → resolution to the current, not-revoked key with that name
- Both fields → resolution, and the two values must be equal. A mismatch
  throws `ChelErrorKeyNameNotFound`. A mismatch is almost certainly a
  stale key or a bug. The id never wins automatically.

The resolution happens one time, at selector entry. The lower-level
primitives `signedOutgoingData` and `encryptedOutgoingData` stay id-only.

The action selectors also accept a raw `encryptionKey`, which is a `Key`
object rather than a reference. It needs no pair of its own: the payload is
encrypted with it directly and carries its key id. Give an
`encryptionKeyId` or `encryptionKeyName` alongside it only as an assertion.
The values must then agree with the raw key, or the call throws.

TypeScript enforces the same rule at compile time. A necessary pair takes
`{ id }`, `{ name }`, or `{ id, name }`, but not an empty pair. Plain
JavaScript callers still get the runtime `TypeError`.

Inside `chelonia/out/atomic`, the signing pair is optional for each entry.
A nested operation without a signer gets the signing reference of the
batch.

## Spec-based `keyAdd`

`chelonia/out/keyAdd` takes a mixed array of `SPKey`,
`EncryptedData<SPKey>`, and marked `keySpec()` entries. It also takes a
`KeySpecMap` when every entry is a spec. The library expands spec entries
against the live contract state:

- For `encryptWith: 'pek'`, Chelonia first looks for a local alias in the
  same expansion. Then it looks for an active key named `pek` in the
  target contract. This key wraps by id.
- `foreignKeyFrom: [otherContractID, 'csk']` builds the complete
  foreign-key entry. It makes the `shelter:` URI and copies the public
  `data` from the origin contract. The default wire name is
  `<originContractID>/<originKeyId>`. Before, applications assembled this
  pattern by hand. The origin contract must be loaded: retain and sync it
  first. No secret material is copied.

```js
await sbp('chelonia/out/keyAdd', {
  contractID: chatroomID,
  contractName: 'gi.contracts/chatroom',
  signingKeyName: 'csk',
  data: userIDs.map((cID) => keySpec(`${cID}/csk`, {
    foreignKeyFrom: [cID, 'csk'],
    purpose: ['sig'],
    ringLevel: Number.MAX_SAFE_INTEGER,
    permissions: [SPMessage.OP_ACTION_ENCRYPTED + '#inner'],
    allowedActions: '*'
  }))
})
```

## Sharing: `chelonia/out/shareKeys`

Generic cross-contract key sharing (`OP_KEY_SHARE`):

```js
await sbp('chelonia/out/shareKeys', {
  contractID: destinationID,       // receives the OP_KEY_SHARE
  contractName: 'gi.contracts/group',
  subjectContractID: sourceID,     // whose keys are being shared
  keyNames: ['csk', 'cek'],        // or keyIds, or '*' (active recoverable)
  // optional overrides:
  encryptionKeyName: 'cek',        // destination CEK; defaults to 'cek'
  signingKeyName: 'csk',           // defaults to auto-selecting a suitable
                                   // key with OP_KEY_SHARE permission
  atomic: false
})
```

The selector selects the active keys of the subject with two properties: a
recoverable secret (`meta.private.content`) and a locally available secret
key. A transient local copy comes first. The selector encrypts each secret
again under the destination encryption key. It encrypts the whole payload
under the same key. Then it gives the wire operation to
`chelonia/out/keyShare`.

If the destination and the subject are the same contract, the selector does
nothing. The same is true when `keyIds` or `keyNames` is explicitly empty.
It is also true when `'*'` matches no recoverable key. In all these cases,
nothing is published, and the selector resolves to `undefined`. With
`atomic: true`, the result is the unpublished `SPMessage`.

You can use the selector inside `chelonia/out/atomic`, with one
restriction. An `OP_ATOMIC` is a single message on a single contract. For
this reason, the destination must be the batch contract. In other words, a
batch can pull the keys of other contracts into its own contract. To do
this, leave `contractID` off, or set it to the batch contract, and point
`subjectContractID` elsewhere. But a batch cannot push its own keys out to
other contracts. Those contracts need one published `OP_KEY_SHARE` per
destination. A nested `contractID` that names a different contract gets an
error. The library does not retarget the operation.

The selector retains both contracts for the duration of the call, but only
when a sync is really necessary. A contract that is loaded and not marked
dirty is read directly. The difference matters for this reason: a retain
waits on the event queue of the contract, even when the contract is
already subscribed. A second retain of a contract whose queue you are
already running on can wait on itself. Two examples: a contract side
effect, and a nested `atomic` entry built from one. Two caveats still
exist:

- A contract with the dirty mark still syncs. It can still wait on itself.
- A publish into your own event queue deadlocks in every case. From a side
  effect, use `atomic: true` and put the result into a batch. Or send the
  call at a later time.

## Updates and rotation

### Update specs

`chelonia/out/keyUpdate` takes marked `keyUpdateSpec(alias, spec)` entries,
or a `KeyUpdateSpecMap`. The alias is the record key in map form. The
caller selects this label. Chelonia uses it for deduplication and as the
default `oldKeyName`. The alias does not have to equal the wire name of the
key. This is useful for `#inviteKey-*` keys. Exactly one of `oldKeyId` and
`oldKeyName` selects the key. In map form, the alias is the default
`oldKeyName`. If you give both fields, they must agree. An explicit `name`
is a consistency assertion. It must equal the current wire name. You cannot
update a name:

```js
await sbp('chelonia/out/keyUpdate', {
  contractID, contractName,
  signingKeyName: 'ipk',
  data: {
    csk: { rotate: true },                        // same-type replacement
    iek: { key: newIEK, encryptWith: { key: newIEK } },
    pek: { permissions: [SPMessage.OP_KEY_DEL] }   // policy-only: no id/data
  }
})
```

- `rotate: true` makes a replacement of the same type
  (`keygenOfSameType`).
- `key` supplies the replacement directly. The type must match.
- Neither field: a policy-only or meta-only update. The operation emits no
  `id` and no `data`.
- A rotation keeps most properties: the wire name, the purpose, the ring
  level, the permissions, and the allowed actions. It also keeps
  `meta.quantity`, `expires`, `keyRequest`, `private.transient`,
  `private.shareable`, and `private.oldKeys`. Only `meta.private.content`
  is replaced.
- The two-case wrapper rule has one implementation. Case 1: the same set
  also replaces the current wrapper of the key. Chelonia then encrypts the
  secret again with the new raw wrapper. Case 2: every other situation.
  Chelonia encrypts by id. For this reason, a concurrent rotation of the
  wrapper still decrypts. An explicit `encryptWith: { key }` overrides both
  cases.
- The replacement of a key with no wrapped secret needs
  `encryptWith: { key }` or `transient: true`. Without a wrapper, the new
  secret is lost after a reload.

### `chelonia/key/rotate`

Bulk rotation. It comes from `rotateKeysInternal` in Group Income:

```js
const result = await sbp('chelonia/key/rotate', {
  contractID, contractName,
  names: ['csk', 'cek'],           // '*', or 'pending'
                                    // ('pending' = _volatile.pendingKeyRevocations
                                    //  markers that are exactly true, not 'del')
  signingKeyName: 'ipk',           // optional; otherwise a suitable key is
                                    // auto-selected at the minimum ringLevel
                                    // of the rotated set
  additionalOperations: async (newKeys, { lastAttempt }) => ({
    after: [['chelonia/out/keyAdd', { ... }]]      // bundled via OP_ATOMIC
  }),
  lastAttempt,                      // forwarded to the callback
  hooks, publishOptions
})
// => { updates, newKeys, msg } — or undefined when no keys qualify
//    (a bulk form with nothing to rotate; an explicit name that cannot be
//    rotated throws instead)
```

The selector rotates only active keys with a recoverable, locally available
secret. A key qualifies when it carries a wrapped secret
(`meta.private.content`) and that secret is available on this device. The
two bulk forms, `'*'` and `'pending'`, mean "rotate whatever qualifies", so
they skip a key that does not. An explicit name list does not: a name that
cannot be rotated throws `ChelErrorKeyNameNotFound`, and nothing is
published. The reason for the difference is that a caller who names a key
usually has a reason to believe that the key must be replaced, for example
a suspected compromise. A quiet skip would return a successful result with
the old key still authorized.

Rotation fails fast before publishing in one more case: no signing key at
the minimum ring level of the rotated set is locally available. For
example, a cleared transient root key causes this condition. In that case,
give `signingKeyName` explicitly.

If `additionalOperations` returns operations, the update and the extra
invocations are published as one `OP_ATOMIC`. If the callback returns
nothing, a direct `OP_KEY_UPDATE` is published. A composed `preSendCheck`
suppresses a stale update. A stale update is one where every old key is
revoked already. The retry and persistence policy stays with the
application, for example the persistent action queue. The selector
`chelonia/key/rotate` tries exactly one time.

Chelonia invokes `additionalOperations` before the selection of the signing
key. For this reason, the auto-selected signer must carry `OP_ATOMIC` only
when the callback really returns operations. A callback without a result
needs nothing more than `OP_KEY_UPDATE`. One consequence: a rotation with
no eligible signer runs the callback first and fails after it. This causes
no damage. The callback only builds invocations and publishes nothing.
Extra operations can need permissions that the auto-selected signer does
not have. In that case, give an explicit `signingKeyId` or
`signingKeyName`.

An `OP_ATOMIC` is one message on one contract. Every operation from
`additionalOperations` must target the contract under rotation. An
operation with a different `contractID` gets an error. The library does not
retarget the operation. For this reason, the distribution of the new keys
to other contracts cannot be part of the same atomic message. Each
destination needs its own `OP_KEY_SHARE` on that destination. Await the
rotation. Then send one `chelonia/out/shareKeys` call per destination. The
selector gives `newKeys` to `additionalOperations` and returns it for
exactly this purpose.

## Validation (authoring-time)

Expansion fails fast, with exact errors, in these cases:

- `ringLevel` is missing for a name without a convention.
- `purpose`, `type`, and `key` do not agree (for example, an `enc` purpose
  with an edwards key).
- `key` together with `type`, `key` together with `data`, or `data`
  together with `type`. The type always comes from the key material that
  you supply.
- None of `key`, `type`, `purpose`, and `data`.
- A `meta.private.content` set directly on a spec. `encryptWith` is the
  only declared way to wrap a secret, and it is the only way that validates
  the wrapper. The same rule applies to an update spec. There,
  `encryptWith: { key }` wraps the replacement secret.
- An `encryptWith` reference to an unknown name, in the set and in the
  contract. The same is true for a reference to a non-`enc` key, or for a
  multi-node cycle.
- A `#sak` spec with a policy field that is not a default.
- A `#inviteKey*` spec with a `quantity` that is neither
  `UNLIMITED_INVITE_USES` nor a positive safe integer, or with an `expires`
  that is not a positive safe integer. An omitted `quantity` is correct and
  means unlimited uses. An omitted `expires` is correct and means no expiry.
- A `quantity` or an `expires` on any name that is not an invite. Only
  invite accounting reads these two fields, so on another key they would be
  a silent no-op, and they are rejected instead.
- A reserved conventional name (`#sak`, `#inviteKey*`, `#krrk-*`) declared
  as a foreign key. A `#sak` is a contract-local, policy-free accounting
  key. An invite has a local secret and locally tracked accounting. A key
  owned elsewhere can never satisfy these invariants.
- A replacement key (`rotate` or `key`) for a key with no wrapped secret
  and no `encryptWith`. Exception: the key is `transient`. Then the caller
  keeps the secret, as with invite links and password-derived roots.
- An unknown `#`-prefixed name. This includes near misses of the
  conventional names, for example `#sak-1` or a bare `#krrk`.
- Duplicate aliases, or duplicate final wire names or key ids.

An invalid invocation, with no id and no name on a reference, throws a
plain `TypeError`. A structurally correct declaration that does not resolve
throws `ChelErrorKeyNameNotFound`, `ChelErrorKeySpecInvalid`, or
`ChelErrorKeyWrapCycle`. A declaration that is not an object at all also
fails. A conditional can leave a `null` or `undefined` entry behind. The
error is `ChelErrorKeySpecInvalid`, and it names the offending alias.

## Migrating existing callers

All features in this guide are additive, with two exceptions: one behavior
change in `chelonia/out/atomic`, and one TypeScript-only change in the key
types.

**Originating contracts now belong to the operation, not to the batch.**
Before, Chelonia copied the fields `originatingContractID` and
`originatingContractName` of the batch into every nested operation. This
copy also overwrote a `signingKeyId` of a nested operation. For this
reason, the library ignored the per-operation signers without an error. Now
both fields get an error on the batch. Each nested operation keeps its own
references:

```js
// Before: batch-level originating contract, inherited by the nested keyShare
await sbp('chelonia/out/atomic', {
  contractID: groupID,
  contractName: 'gi.contracts/group',
  originatingContractID: identityID,        // no longer accepted
  originatingContractName: 'gi.contracts/identity',
  signingKeyId,
  data: [['chelonia/out/keyShare', { data: payload }]]
})

// After: the operation that needs it carries it
await sbp('chelonia/out/atomic', {
  contractID: groupID,
  contractName: 'gi.contracts/group',
  signingKeyId,
  data: [['chelonia/out/keyShare', {
    originatingContractID: identityID,
    originatingContractName: 'gi.contracts/identity',
    data: payload
  }]]
})
```

Both fields on the batch throw `TypeError`. The library does not ignore
them. A silent drop also skips the originating-contract validation in the
nested operation. The result is an `OP_KEY_SHARE` with the wrong
provenance.

A nested operation without a signing reference gets the reference of the
batch. For this reason, batches without a signer continue to work without
change. An explicit `signingKeyId: undefined` or
`signingKeyName: undefined` also counts as omitted. It inherits too. A
conditional can easily produce this value.

**Authored key literals no longer carry the processing-time fields.**
`SPKey` is the shape that you author. It lost `_notBeforeHeight`,
`_notAfterHeight`, and `_private`. Chelonia computes these fields during
message processing. They now live on `ChelContractKey`. That is the shape
that you read from `state._vm.authorizedKeys`. Under the old type,
`_notBeforeHeight` was necessary. For this reason, almost every downstream
`SPKey` literal sets it. Object literals now fail the TypeScript
excess-property check. Remove these three fields from authored literals.
Keep reading them from contract state through `ChelContractKey`.

Note: a literal on an untyped `const` still compiles. For this reason, the
problem can stay unseen until you pass the literal directly to a selector.

You can also see two related type widenings:

- The type of `SPKeyUpdate.meta.private.content` is now `string |
  EncryptedData<string>`. Policy-only updates copy the serialized tuple
  from contract state without change. Consumers that read it as `string`
  need a narrowing check.
- The type of `SPKeyUpdate.permissions` is now `'*' | string[]`, like
  `SPKey`. This is harmless for writers. It affects only code that assumed
  an array.

## Selector reference

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/key/generate` | `src/keys.ts` | Expands a spec set against the optional target contract. Stores raw keys as transient. Returns the `KeyMap`. Makes no messages. |
| `chelonia/key/rotate` | `src/keys.ts` | Does a bulk rotation with the two-case wrapper rule. Adds optional atomic operations before and after. Suppresses stale updates. |

## Types

These types are exported from `@chelonia/lib` and `@chelonia/lib/keys`
(`src/keys.ts`): `KeySpecWrapTarget`, `KeySpec`, `MarkedKeySpec`,
`KeySpecMap`, `GeneratedKey`, `KeyMap`, `KeyExpansionContext`,
`KeyUpdateSpec`, `MarkedKeyUpdateSpec`, `KeyUpdateSpecMap`,
`RotationKeyMap`, `AtomicInvocation`. The module also exports these
helpers: `keySpec`, `isKeySpec`, `keyUpdateSpec`, `isKeyUpdateSpec`,
`UNLIMITED_INVITE_USES`, `normalizeKeySpecs`, `normalizeKeyUpdateSpecs`,
`resolveGeneratedKeyReference`, `resolveStateKeyReference`,
`expandKeySpecs`, `expandKeyUpdateSpecs`.

The registration selector-parameter types live in `src/chelonia.ts`:
`ChelRegParams` (legacy and spec forms), `RegistrationKeyReferences`,
`ChelShareKeysParams`, `NestedInvocationParams` (the shape of an entry in
an `OP_ATOMIC` batch). The types `ChelActionParams`, `ChelKeyAddParams`,
`ChelKeyUpdateParams`, and `ChelAtomicParams` are the widened forms.

## Security notes

- **Ring levels stay explicit.** Ordinary names need `ringLevel`. The
  library never infers authority from key order or type.
- **`autoSak` is opt-in** and needs an explicit wrapper. Identity, group,
  and chatroom contracts use different wrapping roots. An inferred wrapper
  hides a recovery decision.
- CAUTION: **Never log a `KeyMap`.** The field `GeneratedKey.key` is raw
  secret material.
- CAUTION: **Never send a `KeyMap` across a serialization boundary.** The
  secret halves are dropped. The wrapped secrets collapse. The key buffers
  of the sender become detached in the process. See the
  [service-worker caveat](#service-worker-caveat).
- **Metadata merging is one-way.** Caller `meta` can add fields. It cannot
  override the `meta.private.content` that Chelonia makes, or the
  convention invariants.
- Foreign-key construction copies only public material. Private metadata
  from the origin is never copied.
