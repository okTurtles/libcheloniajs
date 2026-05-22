# Quickstart

End-to-end "hello world" for `@chelonia/lib`: bootstrap Chelonia,
register a contract, publish an action, read state, and tear down.

This page wires together the three reference docs:

- [`configure.md`](./configure.md) for the configuration surface.
- [`contracts.md`](./contracts.md) for the contract API.
- [`journal.md`](./journal.md) (optional) for the per-contract event
  journal.

For a flat selector listing see [`api.md`](./api.md).

---

## Prerequisites

- A reachable Chelonia relay (`connectionURL`).
- A manifest hash for at least one contract. Manifest authoring is
  outside the scope of `@chelonia/lib`; consult your relay's SDK.

> A reachable relay is required for `/out/*` selectors to succeed:
> Chelonia issues an `HTTP POST` to `${connectionURL}/event` for every
> outgoing op (see `src/internals.ts`). If the URL is unreachable
> the publish throws after `publishOptions.maxAttempts` retries. There
> is **no** offline / mock mode in `@chelonia/lib` itself — stand up
> a local relay (or stub `config.fetch`) to experiment without one.

---

## Minimal client bootstrap

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'                 // registers all chelonia/* selectors
import { Secret } from '@chelonia/lib'
import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  keyId,
  keygen,
  serializeKey
} from '@chelonia/crypto'

// 1. Provide a state selector BEFORE `chelonia/configure`. Manifest
//    preloading reads through it.
const rootState = { contracts: {} }
sbp('sbp/selectors/register', {
  'myapp/state': () => rootState
})

// 2. Configure Chelonia.
await sbp('chelonia/configure', {
  connectionURL: 'https://chelonia.example.com',
  stateSelector: 'myapp/state',
  contracts: {
    manifests: {
      'my.app/chatroom': '<manifest-hash-here>'
    },
    defaults: {
      // Any SBP selector your contract's process/sideEffect calls
      // must appear here.
      allowedSelectors: ['okTurtles.events/emit']
    }
  },
  hooks: {
    syncContractError: (e, id) => console.error('sync', id, e)
  }
})

// 3. Open the pubsub socket. `chelonia/configure` does NOT auto-connect.
sbp('chelonia/connect')

// 4. Create signing + content-encryption keys and hand them to Chelonia.
//    `@chelonia/crypto`'s `Key` object has no `id` field — derive it
//    via `keyId(key)`.
const csk = keygen(EDWARDS25519SHA512BATCH)
const cek = keygen(CURVE25519XSALSA20POLY1305)
const cskId = keyId(csk)
const cekId = keyId(cek)

sbp('chelonia/storeSecretKeys', new Secret([
  { key: csk },
  { key: cek }
]))

// 5. Publish OP_CONTRACT + the initial action.
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

// 6. Retain (so refcount > 0) and publish an action.
await sbp('chelonia/contract/retain', [contractID])

const signingKeyId =
  sbp('chelonia/contract/currentKeyIdByName', contractID, 'csk')
const encryptionKeyId =
  sbp('chelonia/contract/currentKeyIdByName', contractID, 'cek')

await sbp('chelonia/out/actionEncrypted', {
  action: 'my.app/chatroom/post',
  contractID,
  data: { body: 'hello, world' },
  signingKeyId,
  innerSigningKeyId: signingKeyId,
  encryptionKeyId
})

// 7. Read state.
const { contractState } = sbp('chelonia/contract/fullState', contractID)
console.log(contractState.messages)

// 8. Tear down.
await sbp('chelonia/contract/release', [contractID])
await sbp('chelonia/reset')
```

---

## Where to go next

- **Defining your own contract.** See
  [`contracts.md`](./contracts.md#1-define-the-contract) for the full
  `defineContract` shape, including `metadata`, `methods`, and the
  `process` / `sideEffect` contract.
- **All configuration knobs.** See [`configure.md`](./configure.md).
- **Audit trails / time-travel debugging.** Turn on the journal:
  [`journal.md`](./journal.md).
- **Selector reference.** [`api.md`](./api.md).

---

## Common first-run pitfalls

- **`/out/*` throws `HTTP fetch failed` / connection errors.** Did you
  call `sbp('chelonia/connect')` *and* point `connectionURL` at a
  reachable relay? `chelonia/configure` does neither for you.
- **`Signing key … is not defined`.** Did you call
  `chelonia/storeSecretKeys` before the publish?
- **`Missing reference count for contract`.** Always
  `chelonia/contract/retain` before `chelonia/contract/sync`.
- **Selector denied inside `sideEffect`.** Add it to
  `contracts.defaults.allowedSelectors` in `chelonia/configure`.
