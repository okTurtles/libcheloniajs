# Debugging and observability

`@chelonia/lib` doesn't bundle a logger, but it exposes enough hooks
and events for an application to plug in whatever observability stack
it likes. This page collects the surfaces you have available.

Also, see the [`chel`](https://github.com/okTurtles/chel) CLI utility for useful commands to inspect the chain of events like `chel eventsAfter`.

## Table of contents

1. [Error hooks](#error-hooks)
2. [Lifecycle events](#lifecycle-events)
3. [Inspecting state](#inspecting-state)
4. [Replaying state from the journal](#replaying-state-from-the-journal)
5. [Reading history from the relay](#reading-history-from-the-relay)
6. [Common failure modes](#common-failure-modes)

---

## Error hooks

Set these on `chelonia/configure` to capture errors that don't
otherwise propagate to your call sites (most of Chelonia's processing
runs inside async event queues, so thrown errors won't surface at the
caller).

| Hook | Purpose |
|---|---|
| `processError(err, msg, meta)` | Recoverable error during action `process`. By default Chelonia logs it and continues; supply a hook to report it. |
| `sideEffectError(err, msg?)` | Error during `sideEffect`. `sideEffect` shouldn't mutate state (see [`contracts.md`](./contracts.md)) — wire this to your error reporter. |
| `handleEventError(err, msg?)` | Top-level error handling an incoming event. Usually indicates a bug or a malformed op from the relay. |
| `syncContractError(err, contractID)` | Initial sync of a contract failed (network, decryption, validation, ...). |
| `pubsubError(err, socket)` | Pubsub socket-level error. Reconnection is automatic; this is mostly informational. |

```js
await sbp('chelonia/configure', {
  hooks: {
    processError: (err, msg) => reportToSentry(err, { msg: msg?.hash() }),
    sideEffectError: (err, msg) => reportToSentry(err, { msg: msg?.hash() }),
    handleEventError: (err, msg) => reportToSentry(err, { msg: msg?.hash() }),
    syncContractError: (err, cid) => reportToSentry(err, { contractID: cid }),
    pubsubError: (err) => reportToSentry(err)
  }
})
```

Passing `null` for any hook disables it; omitting it leaves the
previous value in place.

You can also wire per-op hooks (`preOp`, `postOp`, `preOp_<code>`,
`postOp_<code>`) to trace exactly which ops are flowing through.
Return `false` from a `preOp` hook to reject the op. See
[`configure.md`](./configure.md#hooks) for the full list.

---

## Lifecycle events

`@chelonia/lib` emits events through `@sbp/okturtles.events`. See
[`api.md`](./api.md#events) for the full list. The most useful ones
for debugging:

| Event | Use |
|---|---|
| `EVENT_HANDLED` | Fires after every incoming event finishes `process` + `sideEffect`. Payload: `(contractID, message)`. |
| `EVENT_PUBLISHED` | Outgoing publish accepted by the relay. Payload: `{ contractID, message, originalMessage }`. |
| `EVENT_PUBLISHING_ERROR` | Outgoing publish failed (after retries). Payload: `{ contractID, message, originalMessage, error }`. |
| `CONTRACTS_MODIFIED` | Subscription set changed. Payload: `(subscriptionSet, { added, removed, permanent?, resync? })`. |
| `CONTRACT_IS_SYNCING` | Contract entered/left a syncing state. |

```js
import { EVENT_HANDLED, EVENT_PUBLISHING_ERROR } from '@chelonia/lib/events'

sbp('okTurtles.events/on', EVENT_HANDLED, (contractID, msg) => {
  console.debug('[chelonia] handled', msg.opType(), msg.hash(), '@', contractID)
})

sbp('okTurtles.events/on', EVENT_PUBLISHING_ERROR, ({ error, message }) => {
  console.error('[chelonia] publish failed', message?.hash(), error)
})
```

---

## Inspecting state

`chelonia/contract/fullState(contractID)` returns both halves of the
state subtree:

```js
const { contractState, cheloniaState } =
  sbp('chelonia/contract/fullState', contractID)

console.log('app state:', contractState)
console.log('chelonia bookkeeping:', cheloniaState)
console.log('HEAD:', cheloniaState.HEAD, '@ height', cheloniaState.height)
console.log('authorized keys:', cheloniaState._vm?.authorizedKeys)
```

For sync status:

```js
sbp('chelonia/contract/isSyncing', contractID)              // boolean
sbp('chelonia/contract/isSyncing', contractID, { firstSync: true })
sbp('chelonia/contract/isResyncing', contractID)             // boolean
sbp('chelonia/contract/currentSyncs')                        // contractID[]
```

For key resolution:

```js
sbp('chelonia/contract/currentKeyIdByName', contractID, 'csk')
sbp('chelonia/contract/historicalKeyIdsByName', contractID, 'csk')
sbp('chelonia/haveSecretKey', keyId)
```

---

## Replaying state from the journal

If you enabled the journal (see [`journal.md`](./journal.md)),
`chelonia/journal/get(contractID)` gives you the per-event audit
trail, and `chelonia/journal/reconstruct(contractID)` rebuilds the
redacted HEAD state without touching the relay:

```js
const journal = sbp('chelonia/journal/get', contractID)
for (const e of journal?.entries ?? []) {
  console.log(e.kind, e.opType, '@', e.height, e.hash, e.error?.message ?? '')
}

const head = sbp('chelonia/journal/reconstruct', contractID)
```

This is the lowest-cost way to answer "what did this contract's state
look like just before that bug?" — it doesn't go to the network.

---

## Reading history from the relay

When the journal isn't enabled (or the failure predates it), you can
ask the relay for raw events:

```js
// Stream every event for a contract from a given height onward:
const stream = sbp('chelonia/out/eventsAfter', contractID, {
  sinceHeight: 0
})

// Or pull the last N events ending at a known height:
const tail = sbp('chelonia/out/eventsBefore', contractID, {
  beforeHeight: 100,
  limit: 20,
  stream: false
})
```

`chelonia/out/eventsBetween` is the version that lets you pin both
endpoints. All three reuse `chelonia/out/fetchResource` under the
hood (`src/chelonia.ts`).

For a single message:

```js
const msg = await sbp('chelonia/out/deserializedHEAD', hash, { contractID })
```

---

## Common failure modes

| Symptom | Likely cause |
|---|---|
| `Missing reference count for contract` thrown by `chelonia/contract/sync` | You called `sync` without `retain`. Always `retain` first — see [`contracts.md`](./contracts.md#3-sync--reference-counting). |
| `Signing key <id> is not defined` | The secret key for `signingKeyId` is not in `transientSecretKeys`. Did `chelonia/storeSecretKeys` get called this session? Persistent keys are restored from `rootState.secretKeys`; transient keys are not. |
| Local state never updates after a publish | Pubsub isn't connected. Call `sbp('chelonia/connect')`. Outgoing publishes use `config.fetch` directly and can succeed without it, but incoming events (including your own echoes) require an open socket. |
| `ChelErrorDecryptionKeyNotFound` on an incoming op | You don't yet hold the encryption key. If this is a keyshare-pending contract, the op is buffered — watch for `CONTRACT_HAS_RECEIVED_KEYS`. If you should hold the key, check `chelonia/haveSecretKey(id)` and inspect `_volatile.pendingKeyRequests`. |
| `ChelErrorSignatureKeyNotFound` | The signing key referenced by the op was never added (or has been deleted). Usually means the op was crafted under an out-of-date state; force a `chelonia/contract/sync`. |
| `Selector not allowed in OP_ATOMIC` | You tried to nest a non-action / non-key-management selector inside `chelonia/out/atomic`. See the whitelist in [`contracts.md`](./contracts.md#atomic-batches). |
| `Selector denied` inside `sideEffect` | The SBP selector you called isn't in `contracts.defaults.allowedSelectors`. Add it to `chelonia/configure`. |
| `ChelErrorJournalCorrupt` from `chelonia/journal/reconstruct` | A persisted patch failed to apply. The error has `entryIndex` and `contractID`; `chelonia/journal/clear(contractID)` to reset. |
