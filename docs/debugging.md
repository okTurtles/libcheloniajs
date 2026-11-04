# Debugging and observability

`@chelonia/lib` doesn't bundle a logger, but it exposes enough hooks
and events for an application to plug in whatever observability stack
it likes. This page collects the surfaces you have available.

Also, see the [`chel`](https://github.com/okTurtles/chel) CLI utility for useful commands to inspect the chain of events like `chel eventsAfter`.

## Table of contents

1. [Error hooks](#error-hooks)
2. [Lifecycle events](#lifecycle-events)
3. [Pubsub connection](#pubsub-connection)
4. [Inspecting state](#inspecting-state)
5. [Replaying state from the journal](#replaying-state-from-the-journal)
6. [Reading history from the relay](#reading-history-from-the-relay)
7. [Common failure modes](#common-failure-modes)

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

## Pubsub connection

Incoming events (other participants', and the echoes of your own
publishes) arrive over the pubsub WebSocket that `chelonia/connect`
opens. To check that it is healthy:

```js
sbp('chelonia/pubsub/status')
// {
//   state: 'open',            // 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed'
//   since: 1762267000000,     // Date.now() when it entered `state`
//   wanted: 12,               // how many contracts Chelonia is subscribed to
//   missing: [],              // of those, the ones the pubsub client neither has nor is requesting
//   pending: [],              // of those, the ones whose SUB awaits an answer or a connection
//   oldestPendingSince: null  // Date.now() when the oldest pending SUB was sent
// }
```

The result is plain data, so it can be posted across a service worker
boundary. Without a pubsub client, `state` is `'closed'` and every
contract is `missing`. `missing` should only be non-empty briefly:
Chelonia subscribes again after every reconnection and every
[`pubsubReconcileInterval`](./configure.md#connection) ms. A `pending`
list with an old `oldestPendingSince` means that the relay doesn't
answer; the pubsub client replaces the connection once the request's
retry budget runs out (20 to 30 s with the defaults).

To follow the connection state, e.g. for an "offline" banner, listen to
`PUBSUB_STATE_CHANGED`:

```js
import { PUBSUB_STATE_CHANGED } from '@chelonia/lib/pubsub'

sbp('okTurtles.events/on', PUBSUB_STATE_CHANGED, (client, { state, previous }) => {
  showConnectionBanner(state !== 'open')
})
```

On the pubsub client itself (the one `chelonia/connect` returns),
`client.state`, `client.stateSince` and `client.getStatus()` (`{ state,
since, subscribed, pending, oldestPendingSince }`) give the same
information. `PUBSUB_SUBSCRIPTION_FAILED` `(client, { channelID, reason
})` fires when the relay rejects a pending SUB; Chelonia requests it
again at its next reconciliation.

How the pubsub client recovers on its own:

- A SUB, UNSUB or KV filter request that gets no answer is retried
  `maxOpRetries` times, and then the connection is considered broken and
  replaced; the request is never dropped, but sent again on the new
  connection.
- The socket is dropped at once (close code `4001`), without waiting
  for a `close` event that a dead socket may not fire for minutes, when
  nothing arrived for `pingTimeout` ms (also checked against the wall
  clock, so this happens within seconds of the device waking up), when
  a connection attempt times out, and when the browser goes `offline`.
  A new connection follows (once the browser is online again). Going
  `online` also replaces a socket that is stuck closing.

Log lines worth looking for:

| Line | Level | Meaning |
|---|---|---|
| `[pubsub] Event: close (code C, reason "R"), open for N ms, last message M ms ago` | info | A socket closed. A connection attempt that never opened says `never opened (connecting for N ms)` instead. A large `last message` points at a dead connection, a small one at a close by the server. |
| `[pubsub] Abandoning socket: <reason>` | warn | The client replaced a socket it considers dead: `ping timeout`, `ping timeout (wall clock)`, `connection timeout`, `offline`, `online, socket not open`, or `no response to <request> for <channelID>`. |
| `[pubsub] Late ACK: subscribed to <channelID> N ms after the request` | info | The relay answered a SUB more than `opRetryInterval` ms after it was sent: a slow link. |
| `[pubsub] Received unexpected sub for <channelID> (already subscribed \| not requested)` | info | The answer to a SUB that is no longer pending, e.g. to one of its retries. |
| `[pubsub] State: <previous> -> <state>` | debug | Every connection state change. |
| `[chelonia] pubsub reconcile (reconnected \| periodic): subscribing again to N contract(s) missing from the pubsub client` | info | Chelonia found subscriptions that the pubsub client had lost, and restores them. |
| `[chelonia] Published <event> but did not receive it (<reason>); syncing <contractID>` | warn | A published event didn't come back over pubsub, so Chelonia syncs the contract to process it. See [`contracts.md`](./contracts.md#making-sure-a-published-event-is-processed). |
| `[chelonia/time] Date.now() jumped N ms ahead of performance.now() (sleep or clock change); adjusted the time estimate` | info | The device slept (or the clock was set forward): `chelonia/time` was corrected at once and is being resynced with the relay. A jump `behind` is a clock change, which doesn't affect `chelonia/time`; it is resynced too. |

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

`cheloniaState` leaves the journal out. Ask for it explicitly when
inspecting journal contents:

```js
const { cheloniaState } = sbp('chelonia/contract/fullState', contractID, undefined, {
  includeJournal: true
})
console.log('journal entries:', cheloniaState._journal?.entries.length)
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
| Local state only changes after your own publishes, with `Published ... but did not receive it (not subscribed)` warnings | Pubsub isn't connected. Call `sbp('chelonia/connect')`. Outgoing publishes use `config.fetch` directly and can succeed without it, and Chelonia then syncs to process them, but other participants' events only arrive with those syncs. |
| Other participants' events stop arriving for some contracts | Check [`chelonia/pubsub/status`](#pubsub-connection): `missing` contracts are restored at the next reconnection or within `pubsubReconcileInterval`; a `state` other than `'open'` or a long-`pending` SUB point at the connection itself. The pubsub log lines above show what happened. |
| `ChelErrorDecryptionKeyNotFound` on an incoming op | You don't yet hold the encryption key. If this is a keyshare-pending contract, the op is buffered — watch for `CONTRACT_HAS_RECEIVED_KEYS`. If you should hold the key, check `chelonia/haveSecretKey(id)` and inspect `_volatile.pendingKeyRequests`. |
| `ChelErrorSignatureKeyNotFound` | The signing key referenced by the op was never added (or has been deleted). Usually means the op was crafted under an out-of-date state; force a `chelonia/contract/sync`. |
| `Selector not allowed in OP_ATOMIC` | You tried to nest a non-action / non-key-management selector inside `chelonia/out/atomic`. See the whitelist in [`contracts.md`](./contracts.md#atomic-batches). |
| `Selector denied` inside `sideEffect` | The SBP selector you called isn't in `contracts.defaults.allowedSelectors`. Add it to `chelonia/configure`. |
| `ChelErrorJournalCorrupt` from `chelonia/journal/reconstruct` | A persisted patch failed to apply. The error has `entryIndex` and `contractID`; `chelonia/journal/clear(contractID)` to reset. |
