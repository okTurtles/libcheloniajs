# Keys: declarative key definitions and derivation

How to define a contract's keys in one declarative, name-addressed structure
and let Chelonia do the `keygen` / `keyId` / `serializeKey` / wrapping /
assembly — plus name-addressed references, generic sharing, and rotation.

- Selector reference: [`api.md`](./api.md#key-api)
- Source: [`src/keys.ts`](../src/keys.ts) (pure engine + selectors),
  [`src/chelonia.ts`](../src/chelonia.ts) (selector integration)

Everything here is additive: raw `SPKey[]` arrays, `EncryptedData<SPKey>`
entries, and every existing `*KeyId` parameter keep working unchanged.

## Concepts

### Key specs: name-addressed declarations

The unit of the API is a **key spec** — a partial description of a key,
keyed by (or carrying) a name. Everything else — `id`, `data`,
`meta.private.content`, curve type — is derived. Two equivalent forms:

```js
// Object form (recommended): the record key is the caller alias
keys: {
  csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', encryptWith: 'iek' },
  cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' }
}

// Array form, for mixing specs with pre-built SPKey objects
keys: [keySpec('csk', { ... }), existingSpKey, keySpec('cek', { ... })]
```

Array entries **must** be created with `keySpec(alias, spec)`; the prototype
marker distinguishes a spec from a raw `SPKey` (specs are never inferred from
missing fields).

### Aliases vs wire names

The **alias** (object-form key, or `keySpec()` first argument) is what you
use in `KeyMap`, `encryptWith`, and name-based registration fields. The
**wire name** (`GeneratedKey.name`, `SPKey.name`) is what lands on chain.
They are the same unless the spec sets `name` explicitly — in both forms:
`keySpec(alias, spec)` keeps the alias and a caller-provided `spec.name`
separate, exactly like the object form — or the key is an invite key, whose
wire name is suffixed with its id: `#inviteKey` → `#inviteKey-<id>`. Two
invite specs with the same `name` therefore don't collide, including
multiple `keySpec()` entries in array form.

### The wrapping graph (`encryptWith`)

`encryptWith: '<name>'` declares "this key's secret half is encrypted under
the key named `<name>`". The target is one of:

- another key **in the same spec set** → wrapped with the raw key
- `{ key }` → a raw key you already hold (e.g. a just-derived password key)
- `{ contractID, name }` (spec generation only) → an active key in a loaded
  contract, wrapped by id so a concurrent rotation of the wrapper still
  decrypts
- a plain string that is not in the set, **in `keyAdd`/rotation contexts**
  → an active key in the target contract, wrapped by id

The set of specs forms a DAG which Chelonia resolves. Cycles between two or
more distinct keys throw `ChelErrorKeyWrapCycle`; **self-wrap**
(`encryptWith: 'cek'` on the `cek` spec itself) is valid — the key's secret
is encrypted under itself, a common CEK pattern.

Omitting `encryptWith` means the contract stores only the public half —
exactly today's meaning of omitting `meta.private.content`. Setting
`meta.private.content` on a spec directly is rejected: it would bypass the
wrapper purpose check, the in-set/contract resolution and the cycle
detection, and it is never validated against the key it is attached to.
Hand-crafted entries belong in the raw `SPKey` form that
`chelonia/out/keyAdd` still accepts.

### Conventions as defaults

| Name pattern | Defaults |
|---|---|
| `#sak` | `purpose: ['sak']`, `ringLevel: 0`, `permissions: []`, `allowedActions: []`, edwards key — the invariants `keyAdditionProcessor` enforces, now checked at authoring time |
| `#inviteKey` (or `#inviteKey-*`) | `ringLevel: Number.MAX_SAFE_INTEGER`, `purpose: ['sig']`; `quantity` **required**. Only the exact name `#inviteKey` is suffixed with the id; a name like `#inviteKey-foo` is recognized as an invite (same defaults, invite accounting) but keeps its name verbatim |
| anything else | `permissions: []`, `allowedActions: []` (fail-closed); `ringLevel` **required** — it is a security decision |

Curve type is inferred: purpose containing only `enc` →
`CURVE25519XSALSA20POLY1305`; `sig`/`sak` → `EDWARDS25519SHA512BATCH`. If
you supply `key` or public `data`, the type comes from the key and the
purpose is validated against it.

The `#` namespace is reserved and only the exact conventional names and their
documented suffixed forms are accepted: `#sak`, `#inviteKey`, `#inviteKey-*`
and `#krrk-*`. Every other `#`-prefixed name is rejected, including near
misses such as `#sak-1` or a bare `#krrk` — accepting those would quietly
produce an ordinary key that none of the convention handling matches.

### The secret-key lifecycle

1. Expansion registers every generated/provided raw key as **transient**
   (`chelonia/storeSecretKeys`, `transient: true`) — required anyway so the
   outgoing message can be signed and processed locally.
2. `transient: true` on a spec sets `meta.private.transient`, which makes
   `keyAdditionProcessor` skip persisting it (password-derived keys like
   IPK/IEK).
3. Every *non-transient* wrapped key is persisted automatically when the
   outgoing `OP_CONTRACT` / `OP_KEY_ADD` is processed — a manual
   "store persistent keys" call after registration is a no-op safety net.

Clearing password-derived keys after registration remains an explicit call,
addressed by the returned `KeyMap`:

```js
await sbp('chelonia/clearTransientSecretKeys', [K.ipk.id, K.iek.id])
```

Generated keys stay transient after a failed publish (matching today's
manual workflow). Automatic rollback is unsafe because an id may already
have been present in the transient store before generation.

## Generating keys: `chelonia/key/generate`

The composable, two-phase entry point:

```js
const K = sbp('chelonia/key/generate', {
  contractID?,            // optional: when present, `encryptWith` may also
                          // reference active keys in that contract by name
  keys: KeySpecMap | MarkedKeySpec[]
})
```

Returns a `KeyMap`: `Record<alias, GeneratedKey>` where

```ts
type GeneratedKey = {
  name: string   // the final wire name ('#inviteKey-<id>' for invites)
  id: string     // keyId(key)
  key?: Key      // raw key — treat as sensitive; undefined for data-only
                 // and foreign entries
  spkey: SPKey   // the assembled, ready-to-publish key
}
```

Side effects: transient registration of every raw key. That is the *only*
side effect — no messages are created or sent. `serializeKey(k.key, true)`
gives the serialized secret when a consumer genuinely needs it (invite
links, recovery metadata).

`KeyMap` is sensitive: never log it, never serialize it into state.

### Purity

`expandKeySpecs` (and `expandKeyUpdateSpecs`) are pure with respect to
Chelonia/SBP: contract state is passed through an explicit
`KeyExpansionContext`, and no selector is called during expansion. The
`EncryptedData` wrappers are lazy — encryption happens at serialization
time, not expansion time.

## Spec-based registration

`chelonia/out/registerContract` accepts the spec form when `keys` is a
`KeySpecMap` (or an array containing marked specs):

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

1. Spec-form `keys` are expanded via `chelonia/key/generate` (same tick).
2. The `*KeyName` fields resolve against the generated `KeyMap` (alias or
   wire name).
3. `data` as a function receives the `KeyMap` — how an application embeds
   invite secrets into the join payload without pre-generating.
4. `onKeysReady` runs after transient storage, before payload/message
   creation; an error in it (or in the data factory) prevents publication.
5. Everything after expansion is today's code path: same `SPMessage`,
   same publish, same sync. The return value is unchanged (the
   initial-action `SPMessage`).

`autoSak` is **opt-in** for the first release (default off). When enabled it
requires an explicit wrapper — a silently generated server-accounting key is
too consequential to guess:

```js
autoSak: { encryptWith: 'iek' }  // or declare '#sak' explicitly
```

Raw-array calls keep the exact legacy behavior: no auto-SAK, no callbacks,
no expansion.

### Service-worker caveat

`onKeysReady` and the `data` factory are local JavaScript callbacks.
Callers that construct operations on one side of a serialization boundary
(e.g. a UI tab invoking a service worker via message passing) must use the
two-phase form instead — generate with `chelonia/key/generate`, pass the
resulting raw `SPKey`s — since functions are not transport-serializable.

## Name references across outgoing operations

Every `*KeyId` parameter on the out-selectors has a `*KeyName` twin that
resolves against the **target contract's** current state (aliases at
registration time; `findKeyIdByName` afterwards):

| Selector | Name twins |
|---|---|
| `chelonia/out/actionEncrypted` / `actionUnencrypted` | `signingKeyName`, `innerSigningKeyName`, `encryptionKeyName` |
| `chelonia/out/keyAdd`, `keyDel`, `keyUpdate`, `keyShare`, `keyRequestResponse` | `signingKeyName` |
| `chelonia/out/keyRequest` | `signingKeyName`, `innerSigningKeyName`, `encryptionKeyName`, `innerEncryptionKeyName` |
| `chelonia/out/atomic` | `signingKeyName` (outer message only; nested invocations keep their own references) |
| `chelonia/out/encryptedOrUnencryptedPubMessage` | same as the action selectors |

For `chelonia/out/keyRequest`, each name resolves against its **real owner**:
outer `signingKeyName` and `innerEncryptionKeyName` live in the *destination*
contract; `innerSigningKeyName` and `encryptionKeyName` live in the
*originating* contract. This flow is easy to invert — the types say which is
which.

### id/name pair semantics

For every `fooKeyId` / `fooKeyName` pair:

- neither provided when required → `TypeError`
- only id → current behavior
- only name → resolved to the current unrevoked key by that name
- both → resolved and required equal; a mismatch throws
  `ChelErrorKeyNameNotFound` (a mismatch is almost certainly a stale key or
  a bug — the id never silently wins)

Resolution happens once at selector entry. The lower-level
`signedOutgoingData` / `encryptedOutgoingData` primitives remain id-only.

TypeScript enforces the same rule at compile time: a required pair accepts
`{ id }`, `{ name }` or `{ id, name }`, but not an empty pair. Plain
JavaScript callers still get the runtime `TypeError`.

Inside `chelonia/out/atomic` the signing pair is optional per entry, because
a signer-less nested operation inherits the batch's signing reference.

## Spec-based `keyAdd`

`chelonia/out/keyAdd` accepts a mixed array of `SPKey`,
`EncryptedData<SPKey>`, and marked `keySpec()` entries (or a `KeySpecMap`
when every entry is a spec). Spec entries are expanded against the **live
contract state**:

- `encryptWith: 'pek'` first looks for a local alias in the same expansion,
  then an active key named `pek` in the target contract (wrapped by id).
- `foreignKeyFrom: [otherContractID, 'csk']` builds the whole foreign-key
  entry: the `shelter:` URI, public `data` copied from the origin contract,
  and a default wire name of `<originContractID>/<originKeyId>` — the
  pattern applications previously assembled by hand. The origin contract
  must be loaded (retain and sync it first); no secret material is copied.

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

Selects the subject's active keys that have recoverable secrets
(`meta.private.content`) and a locally available secret key (transient
first), re-encrypts each secret under the destination encryption key,
encrypts the whole payload under that same key, and delegates the wire
operation to `chelonia/out/keyShare`. Sharing a contract's keys with itself
does nothing. The same applies when `keyIds`/`keyNames` is explicitly empty,
or when `'*'` matches no recoverable key: nothing is published and the
selector resolves to `undefined`. `atomic: true` returns the unpublished
`SPMessage`.

The selector is allowed inside `chelonia/out/atomic`, with one restriction:
an `OP_ATOMIC` is a single message on a single contract, so the destination
must be the batch contract. In other words a batch can pull *other*
contracts' keys **into** the contract it is published to (leave `contractID`
off, or set it to the batch contract, and point `subjectContractID`
elsewhere), but it cannot push its own keys **out** to other contracts —
those need one published `OP_KEY_SHARE` per destination. A nested
`contractID` naming a different contract is rejected rather than silently
retargeted.

## Updates and rotation

### Update specs

`chelonia/out/keyUpdate` accepts marked `keyUpdateSpec(alias, spec)` entries
(or a `KeyUpdateSpecMap`). The alias (record key in map form) is a
caller-chosen label used for deduplication and as the default `oldKeyName` —
it does not have to equal the key's wire name, which is convenient for
`#inviteKey-*` keys. Exactly one of `oldKeyId` / `oldKeyName` selects
the key (in map form, the alias is the default `oldKeyName`); when both are
given they must agree. `name`, when given explicitly, is a consistency
assertion that must equal the existing wire name (names cannot be updated):

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

- `rotate: true` generates a same-type replacement (`keygenOfSameType`).
- `key` supplies the replacement directly (type must match).
- Neither → policy/meta-only update that emits no `id`/`data`.
- Rotation preserves the wire name, purpose, ring level, permissions,
  allowed actions, `meta.quantity`, `expires`, `keyRequest`, and
  `private.transient` / `shareable` / `oldKeys`; only
  `meta.private.content` is replaced.
- The **two-case wrapper rule** has one implementation: if the key's current
  wrapper is itself being replaced in the same set, the secret is
  re-encrypted with the *new raw* wrapper; otherwise it is encrypted *by
  id* so a concurrent rotation of the wrapper still decrypts. An explicit
  `encryptWith: { key }` overrides both.
- Replacing a key that has **no** wrapped secret requires
  `encryptWith: { key }` or `transient: true`. Without a wrapper, the new
  secret is lost after reload.

### `chelonia/key/rotate`

Bulk rotation (the promotion of Group Income's `rotateKeysInternal`):

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
```

Only active keys whose secret is recoverable and locally available are
rotated. Rotation **fails fast before publishing** when no signing key at
the minimum ring level of the rotated set is locally available (e.g. a
cleared transient root key) — pass `signingKeyName` explicitly in that case.
When `additionalOperations` returns operations, the update and the
extra invocations are published as one `OP_ATOMIC`; otherwise a direct
`OP_KEY_UPDATE` is published. A composed `preSendCheck` suppresses
publishing when every old key has already been revoked (stale update).
Retry/persistence policy stays with the application (e.g. the persistent
action queue): `chelonia/key/rotate` performs exactly one attempt.

An `OP_ATOMIC` is one message on one contract, so every operation returned by
`additionalOperations` must target the contract being rotated; one naming a
different `contractID` is rejected rather than silently retargeted.
Distributing the new keys to *other* contracts therefore cannot be part of
the same atomic message — each destination needs its own `OP_KEY_SHARE` on
that destination. Await the rotation, then issue one
`chelonia/out/shareKeys` per destination; `newKeys` is handed to
`additionalOperations` (and returned) precisely so the caller can do this.

## Validation (authoring-time)

Expansion fails fast, with pointed errors, on:

- `ringLevel` missing for a non-conventional name
- `purpose`/`type`/`key` inconsistency (e.g. `enc` purpose with an edwards key)
- both `key` and `type`; both `key` and `data`; both `data` and `type` (the
  type is always derived from the supplied key material); neither `key`,
  `type`, `purpose` nor `data`
- `meta.private.content` set directly on a spec — `encryptWith` is the only
  declared way to wrap a secret, and it is the only one that validates the
  wrapper
- `encryptWith` referencing an unknown name (in set *and* contract), a
  non-`enc` key, or producing a multi-node cycle
- a `#sak` spec with any non-default policy field
- `#inviteKey*` without `quantity`
- a replacement key (`rotate` / `key`) for a key with no wrapped secret and
  no `encryptWith`, unless the key is `transient` (then the caller keeps the
  secret, as with invite links and password-derived roots)
- unknown `#`-prefixed names, including near misses of the conventional ones
  (`#sak-1`, a bare `#krrk`)
- duplicate aliases or duplicate final wire names / key ids

Invalid *invocations* (missing both id and name on a reference) throw plain
`TypeError`; structurally valid declarations that cannot be resolved throw
`ChelErrorKeyNameNotFound` / `ChelErrorKeySpecInvalid` /
`ChelErrorKeyWrapCycle`. A key declaration that is not an object at all
(a `null`/`undefined` entry left behind by a conditional) is rejected as
`ChelErrorKeySpecInvalid` naming the offending alias.

## Migrating existing callers

Everything in this guide is additive except one change to
`chelonia/out/atomic`.

**Originating contracts now belong to the operation, not the batch.**
Previously the batch's `originatingContractID` / `originatingContractName`
were copied into every nested operation. That spread also overwrote a nested
operation's own `signingKeyId`, so per-operation signers were silently
ignored. Both fields are now rejected on the batch, and each nested
operation keeps its own references:

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

Passing them on the batch throws `TypeError` rather than being ignored:
silently dropping them would also skip the originating-contract validation
in the nested operation, publishing an `OP_KEY_SHARE` with the wrong
provenance.

A nested operation that omits its signing reference still inherits the
batch's, so signer-less batches keep working unchanged.

## Selector reference

| Selector | Source | Purpose |
|---|---|---|
| `chelonia/key/generate` | `src/keys.ts` | Expand a spec set against the optional target contract, store raw keys transiently, return the `KeyMap`. No messages are created. |
| `chelonia/key/rotate` | `src/keys.ts` | Bulk rotation with two-case re-wrapping, optional atomic before/after operations, stale-update suppression. |

## Types

Exported from `@chelonia/lib` / `@chelonia/lib/keys` (`src/keys.ts`):
`KeySpecWrapTarget`, `KeySpec`, `MarkedKeySpec`, `KeySpecMap`, `GeneratedKey`,
`KeyMap`, `KeyExpansionContext`, `KeyUpdateSpec`, `MarkedKeyUpdateSpec`,
`KeyUpdateSpecMap`, `RotationKeyMap`, `AtomicInvocation`, plus helpers
`keySpec`, `isKeySpec`, `keyUpdateSpec`, `isKeyUpdateSpec`,
`normalizeKeySpecs`, `normalizeKeyUpdateSpecs`,
`resolveGeneratedKeyReference`, `resolveStateKeyReference`,
`expandKeySpecs`, `expandKeyUpdateSpecs`.

Registration selector-parameter types live in `src/chelonia.ts`:
`ChelRegParams` (legacy ∪ spec forms), `RegistrationKeyReferences`,
`ChelShareKeysParams`, `NestedInvocationParams` (the shape of an entry in an
`OP_ATOMIC` batch), and the widened `ChelActionParams` /
`ChelKeyAddParams` / `ChelKeyUpdateParams` / `ChelAtomicParams`.

## Security notes

- **Ring levels stay explicit.** Ordinary names require `ringLevel`; the
  library never infers authority from key order or type.
- **`autoSak` is opt-in** and requires an explicit wrapper; identity,
  group, and chatroom contracts use different wrapping roots and inferring
  one would hide a recovery decision.
- **Never log a `KeyMap`** — `GeneratedKey.key` is raw secret material.
- **Metadata merging is one-way**: caller `meta` may add fields but cannot
  override generated `meta.private.content` or convention invariants.
- Foreign-key construction copies only public material; origin private
  metadata is never copied.
