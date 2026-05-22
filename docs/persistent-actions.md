# Persistent action queue

`@chelonia/lib` ships a retry queue for outgoing SBP calls that must
eventually succeed but whose immediate failure is recoverable
(network errors, transient `409`s, rate-limiting, etc.). Actions are
persisted via the configured `chelonia.db/*` storage so they survive
a process restart.

Source: `src/persistent-actions.ts`. The selectors live under the
`chelonia.persistentActions/*` namespace.

## Table of contents

1. [When to use it](#when-to-use-it)
2. [Configuration](#configuration)
3. [Enqueue and cancel](#enqueue-and-cancel)
4. [Retry policy](#retry-policy)
5. [Lifecycle: load / save / unload](#lifecycle-load--save--unload)
6. [Status and events](#status-and-events)
7. [Common pitfalls](#common-pitfalls)

---

## When to use it

Use the persistent queue when:

- The outgoing call **must** eventually run (e.g. logging a user out
  on the relay, notifying a peer contract of a key rotation).
- Failure modes are transient and a retry is the right response.
- You want the action to survive a tab close / process restart.

If a one-shot retry is enough — or the call is idempotent and you're
happy to let the next sync pick up the change — use the publish-time
retry knobs (`publishOptions.maxAttempts`) on `/out/*` instead.

The queue is **just SBP**: each entry is a `[selector, ...args]`
tuple. It doesn't know anything about Chelonia's `OP_*` semantics, so
you can also use it for arbitrary HTTP calls, KV writes, etc.

---

## Configuration

Call `chelonia.persistentActions/configure` once during boot, before
the first `enqueue` or `load`:

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'

sbp('chelonia.persistentActions/configure', {
  // Required. The DB key under which the queue is persisted.
  databaseKey: 'app/persistentActions',
  // Optional. Overrides for the global defaults (see below).
  options: {
    maxAttempts: 50,
    retrySeconds: 60
  }
})
```

| Option | Default | Purpose |
|---|---|---|
| `maxAttempts` | `Infinity` | Hard cap on retry attempts per action. After this many failures the action emits `PERSISTENT_ACTION_TOTAL_FAILURE` and is removed from the queue. |
| `retrySeconds` | `30` | Wait between attempts (seconds). |

These defaults apply to every action unless overridden at enqueue
time.

> **Storage**: The queue is JSON-serialized via `chelonia.db/set`
> under `databaseKey`. The default in-memory `Map` DB will lose the
> queue across process restarts; plug in a persistent `chelonia.db/*`
> implementation (e.g. IndexedDB, SQLite) if you need survival across
> reloads.

---

## Enqueue and cancel

```js
const [id] = sbp('chelonia.persistentActions/enqueue', {
  invocation: ['chelonia/out/actionEncrypted', {
    action: 'my.app/chatroom/post',
    contractID,
    data: { body: 'hello' },
    signingKeyId,
    innerSigningKeyId: signingKeyId,
    encryptionKeyId
  }],
  // Per-action overrides:
  maxAttempts: 10,
  retrySeconds: 5,
  // Optional. Skip the attempt if this SBP call resolves truthy.
  skipCondition: ['app/areWeOffline'],
  // Optional. Run on each failure (e.g. UI toast). The id/error are
  // available via the `PERSISTENT_ACTION_FAILURE` event payload.
  errorInvocation: ['app/notifyTransientFailure'],
  // Optional. Run when `maxAttempts` is exhausted.
  totalFailureInvocation: ['app/notifyHardFailure']
})

// Or, simplest form (no options):
sbp('chelonia.persistentActions/enqueue',
  ['chelonia/out/actionEncrypted', { /* ... */ }]
)

// Bulk enqueue:
const ids = sbp('chelonia.persistentActions/enqueue', a, b, c)
```

`enqueue` immediately calls `attempt()` on each new action; you don't
need to "start" the queue.

```js
// Cancel by id. No-op if the action has already resolved or been
// cancelled. An in-flight attempt cannot be aborted — cancellation
// just prevents future retries.
await sbp('chelonia.persistentActions/cancel', id)

// Force a retry now, ignoring the `retrySeconds` timer:
sbp('chelonia.persistentActions/forceRetry', id)

// Retry every loaded action immediately:
await sbp('chelonia.persistentActions/retryAll')
```

---

## Retry policy

Each action goes through this state machine:

1. `attempt()` is called.
2. If `skipCondition` resolves truthy the action is cancelled and the
   queue moves on.
3. Otherwise the `invocation` is `await sbp(...)`'d.
4. **On success:** the action emits `PERSISTENT_ACTION_SUCCESS` and is
   removed from the queue (the `_init` selector listens for the event
   and calls `/cancel` for you).
5. **On failure:** `failedAttemptsSoFar` is incremented, `lastError`
   is recorded, `errorInvocation` (if any) is called, and Chelonia
   schedules a retry `retrySeconds` later — unless
   `failedAttemptsSoFar >= maxAttempts`, in which case it emits
   `PERSISTENT_ACTION_TOTAL_FAILURE` and the action is removed.

Action state is held in memory under `this.actionsByID` and persisted
to `databaseKey` after every mutation. The persisted form is
`JSON.stringify(Object.values(this.actionsByID))` so callbacks
(`skipCondition`, `errorInvocation`, `totalFailureInvocation`) are
stored as SBP invocations — plain arrays of selector + args.

---

## Lifecycle: load / save / unload

On app boot, after `configure`:

```js
await sbp('chelonia.persistentActions/load')
```

`load` reads the persisted queue, instantiates a `PersistentAction`
for each entry, and calls `retryAll`. Use it once per app start; calling
it twice will duplicate everything.

On logout (or when switching users):

```js
// Drop all in-memory actions WITHOUT touching the DB. The queue can
// be `/load`-ed again later — useful if you keep the actions across
// re-logins.
sbp('chelonia.persistentActions/unload')

// Or, if you genuinely want the queue gone, cancel each action by id
// (which also calls `/save`):
for (const { id } of sbp('chelonia.persistentActions/status')) {
  await sbp('chelonia.persistentActions/cancel', id)
}
```

`save` is normally called automatically. Call it manually if you've
mutated action state outside the documented selectors (rare).

---

## Status and events

```js
const rows = sbp('chelonia.persistentActions/status')
// [
//   {
//     id, invocation,
//     attempting,            // boolean: is an attempt currently in flight?
//     failedAttemptsSoFar,   // integer
//     lastError,             // string (Error.message)
//     nextRetry,             // ISO timestamp, or '' if resolved/no retry scheduled
//     resolved               // boolean
//   },
//   ...
// ]
```

Subscribe to lifecycle events via `okTurtles.events`:

| Event | Payload |
|---|---|
| `PERSISTENT_ACTION_SUCCESS` | `{ id, result }` |
| `PERSISTENT_ACTION_FAILURE` | `{ error, id }` (fires on every failed attempt) |
| `PERSISTENT_ACTION_TOTAL_FAILURE` | `{ error, id }` (fires once when `maxAttempts` is exhausted) |

```js
import { PERSISTENT_ACTION_TOTAL_FAILURE } from '@chelonia/lib/events'

sbp('okTurtles.events/on', PERSISTENT_ACTION_TOTAL_FAILURE, ({ id, error }) => {
  console.error('persistent action gave up', id, error)
})
```

---

## Common pitfalls

- **Forgetting to call `configure` before `enqueue`.** Without
  `databaseKey`, the first internal `/save` throws `TypeError: No
  database key configured`.
- **Using the default in-memory DB.** Actions don't survive a process
  restart unless `chelonia.db/*` is backed by persistent storage.
- **Closures in `invocation`.** Persisted actions are JSON-serialized;
  arguments must be JSON-safe. Don't put functions or class instances
  in the args — pass an SBP-callable selector that re-derives them.
- **Calling `/load` twice.** Actions are keyed by stored `id`, so the
  second load **overwrites** the in-memory entries rather than
  duplicating them — but the previous `PersistentAction` instances are
  dropped without `cancel()`, leaking their pending `setTimeout`
  retries and orphaning any in-flight `attempt()` (its
  `handleSuccess`/`handleError` will fire on a stale object that's no
  longer in `actionsByID`). Track whether you've loaded already, or
  call `chelonia.persistentActions/unload` first.
- **`cancel` doesn't abort in-flight attempts.** A pending
  `await sbp(...)` will run to completion; cancellation only prevents
  *future* retries. If you need true abort, make the invocation itself
  honour an abort signal.
- **`forceRetry` is a no-op if `attempting === true`.** Forced retries
  only kick in when the action is idle.
