# KV API revamp — design document

Status: **proposal**
Tracking: [okTurtles/group-income#2903](https://github.com/okTurtles/group-income/issues/2903)
Scope: `@chelonia/lib` — new ergonomic, declarative key/value API layered on top of
the existing `chelonia/kv/*` selectors.

---

## 1. Background

### 1.1 The KV store today

`@chelonia/lib` exposes four KV selectors (see `docs/api.md` and
`src/chelonia.ts:2565-2750`, `src/chelonia-utils.ts:22-47`):

| Selector | Purpose |
|---|---|
| `chelonia/kv/set` | `POST /kv/:contractID/:key`. Caller supplies `encryptionKeyId`, `signingKeyId`, `ifMatch` (etag), and an `onconflict` callback. Retries 3× on `409`/`412`. |
| `chelonia/kv/get` | `GET /kv/:contractID/:key`. Returns the parsed encrypted/unencrypted message or `null`. |
| `chelonia/kv/queuedSet` | Convenience wrapper that resolves `cek`/`csk` by name and runs the write through `chelonia/queueInvocation` keyed by `contractID`. |
| `chelonia/kv/setFilter` | Tells the pubsub server which KV keys for a given contract should be broadcast over the socket. |

Updates arrive over pubsub as `NOTIFICATION_TYPE.KV` messages
(`src/pubsub/index.ts:12`, dispatched in `src/chelonia.ts:1089-1115`). There is
**no built-in event** in `src/events.ts` and **no local state mirror** — the
library hands the consumer a parsed message and walks away.

The single advertised conflict primitive is `ChelKvOnConflictCallback`
(`src/types.ts:444-452`):

```ts
type ChelKvOnConflictCallback = (args: {
  contractID: string; key: string;
  failedData?: JSONType; status: number;
  etag: string | null | undefined;
  currentData: JSONType | undefined;
  currentValue: ParsedEncryptedOrUnencryptedMessage<JSONType> | undefined;
}) => Promise<[JSONType, string]>
```

### 1.2 What this looks like for a consumer (Group Income today)

A single new KV key in Group Income costs roughly:

1. A constant in `frontend/utils/constants.js → KV_KEYS`.
2. A `fetch*` selector (`chelonia/kv/get` + unwrap `.data` + default value).
3. A `save*` selector (`chelonia/kv/queuedSet` + per-key `onconflict` wrapping).
4. A `load*` selector that fetches and **emits a `NEW_*` event** in
   `frontend/utils/events.js`.
5. A branch in `setupChelonia.js → NOTIFICATION_TYPE.KV` to translate the
   raw pubsub notification into a `KV_EVENT`.
6. A branch in `setupChelonia.js → CONTRACTS_MODIFIED` to add the key to
   `chelonia/kv/setFilter`.
7. A branch in `sw-primary.js → KV_EVENT` to write into `rootState`.
8. A branch in `main.js → KV_EVENT` to commit into Vuex.
9. A branch in `identity.js → NEW_*` to commit the *initial load* into Vuex
   (a different event from the pubsub path).
10. An `onconflict` that re-implements the merge logic — every one of them
    repeats `({ currentData = {}, etag } = {}) => [merge(currentData), etag]`.

A representative pain example, repeated 8+ times in `identity-kv.js`:

```js
const getUpdatedUnreadMessages = ({ currentData = {}, etag } = {}) => {
  if (currentData[contractID]?.readUntil.createdHeight < createdHeight) {
    const index = currentData[contractID].unreadMessages.findIndex(
      msg => msg.messageHash === messageHash
    )
    if (index === -1) {
      currentData[contractID].unreadMessages.push({ messageHash, createdHeight })
      return [currentData, etag]
    }
  }
  return null
}
```

There is no schema validation anywhere — the contract layer enforces
signing/encryption but the **shape** of the JSON is trusted.

### 1.3 Pain points (summary)

1. **N selectors per key** (`fetch`/`save`/`load`) + N event constants +
   N branches in 3 different files.
2. **Etag plumbing leaks** into every reducer (`currentData, etag` →
   `[result, etag]`). It is identical in every handler and serves no
   purpose for the caller.
3. **Pubsub is the consumer's problem** — there is no built-in event nor
   state mirror, so every consumer reinvents the same `KV_EVENT` →
   `commit` path twice (once for the service worker root state, once for
   the Vuex mirror) plus a separate path for the initial load.
4. **`setFilter` duplication** — the list of keys to subscribe to is
   maintained in *one* place (`CONTRACTS_MODIFIED` switch) and the merge
   logic + event handlers are maintained in *another*. Drift is easy.
5. **Two write APIs** with subtly different responsibilities
   (`chelonia/kv/set` vs `chelonia/kv/queuedSet`) and inconsistent use
   across the same project.
6. **No validation hook** — once contract actions migrate to KV
   (e.g. `state.attributes`), trusting raw JSON is no longer acceptable.
7. **No load-status story** — Group Income hand-rolls
   `NEW_KV_LOAD_STATUS` (`non-init` / `loading` / `loaded`).

---

## 2. Goals

1. **Declare a KV slot once**, in one place, and get reads, writes,
   conflict handling, pubsub-driven updates, validation, and an
   automatic state mirror for free.
2. **Hide etag/conflict mechanics.** Consumers write *reducers*
   (`(previous) => next`), not `onconflict` callbacks.
3. **Auto-managed `setFilter`.** The library derives the per-contract
   filter set from the registered slots; consumers never call
   `setFilter` directly for declared keys.
4. **Validation as a first-class concern.** A slot may declare a Zod
   schema (or any `{ parse(value) }` validator) that runs on writes,
   incoming pubsub updates, reconnect/load paths, and first activation
   of persisted mirror entries. Reads return already-validated values
   and substitute defaults for entries currently in `error` status.
5. **Keep the low-level API.** `chelonia/kv/set`, `chelonia/kv/get`,
   `chelonia/kv/queuedSet`, and `chelonia/kv/setFilter` remain available
   verbatim for advanced cases (binary blobs, ad-hoc keys, custom merge
   policies).
6. **Backwards compatible.** Existing consumers keep working with no
   runtime changes. The new API is additive at runtime, but two public
   TypeScript signatures are intentionally widened: `chelonia/kv/set`
   resolves to `{ etag: string | null }`, and `ChelKvOnConflictCallback`
   may return `[JSONType, string | undefined]` or `false`. See
   `docs/kv.md` for the direct-caller migration notes.
7. **Framework-agnostic.** No dependency on Vuex, Redux, or any UI
   framework; the state mirror is just a path inside Chelonia's root
   state, surfaced via existing `EVENT_HANDLED`-style events.

---

## 3. Concepts

### 3.1 The "slot"

A **slot** is a declarative description of a single KV key on a given
contract type. It binds together everything that today is scattered
across nine files in Group Income:

- the key name (e.g. `'preferences'`)
- which contract type(s) it lives on (e.g. `'gi.contracts/identity'`)
- the default value when the key is absent
- an optional validator (Zod schema or `{ parse }` object)
- an optional `onUpdate(value, ctx)` callback fired whenever the value
  changes (initial load *or* pubsub notification *or* successful write)

Slots are registered up-front (typically when a contract is defined or
at app boot) and live in an in-memory slot registry on the Chelonia
context (see §5/§11.2). Their **scope** is the contract type,
optionally narrowed by a `match(contractID, contractState, rootState)`
predicate. This is mandatory, not cosmetic: Group Income only subscribes
`unreadMessages` / `preferences` / `notifications` on the *own* identity
contract (the one matching `rootState.loggedIn?.identityContractID`),
not on every foreign identity contract the user happens to have synced.
Without `match`, the library would either over-subscribe (leaking pubsub
bandwidth and triggering per-foreign-contract KV fetches that resolve to
`null` via the 404 path in `chelonia/kv/get` — wasted round-trips, not
thrown errors) or the consumer would have to fall back to the raw API.

A slot's `match` predicate is re-evaluated on every `CONTRACTS_MODIFIED`.
The library cannot observe arbitrary rootState changes, so any
predicate that depends on state outside `rootState.contracts[contractID]`
and `rootState[contractID]`
(notably `rootState.loggedIn` for the own-identity case) requires the
consumer to call `chelonia/kv/refreshFilters` after the relevant state
mutation (login, logout, etc.). A predicate that returns `false` causes
the slot to be skipped for that contract — no `setFilter`, no
`autoLoad`, no mirror entry, no events.

> ⚠️ **`refreshFilters` race window.** There is an inherent gap between
> a login/logout state flip and the consumer's `refreshFilters` call.
> Any pubsub `NOTIFICATION_TYPE.KV` frame arriving in that window is
> dropped by `_handleRemote` because the slot is not yet in
> `kvSlotsByContractID` (or has just been removed). This is correct
> behaviour — the alternative is firing events for a slot the consumer
> has declared inactive — but it does mean **`refreshFilters` must run
> *before* the contract sync that will trigger KV traffic**, not after.
> Call it synchronously from the same event that drives the state
> transition (`LOGIN_COMPLETE`, etc.), and prefer wiring it as a
> one-time event handler at app boot over scattering calls through the
> code. Slots with `refreshOnReconnect: true` recover automatically on
> the next reconnect; a slot relying on a one-shot pubsub push to
> populate (e.g. a notification the user just sent) will appear missing
> until the next explicit `chelonia/kv/sync` or page reload.

### 3.2 The state mirror

Every successful read, write, or pubsub update of a registered slot
writes the value into `rootState._kv[contractID][key]`. Consumers read
synchronously from there; they never need to call `chelonia/kv/get`
again for a declared slot.

The mirror is part of Chelonia's root state, so it is automatically
picked up by anything that already observes `rootState.contracts`
changes (e.g. the Vuex mirror set up by `chelonia/externalStateSetup`)
— no `KV_EVENT` plumbing required. The underscore naming (`_kv`) is
intentional: this is library-managed bookkeeping, aligned with
`_vm`/`_volatile`/`_journal` conventions.

### 3.3 Reducers, not conflict callbacks

Writes are expressed as **pure updater functions**:

```ts
type KvUpdater<T> = (prev: T) => T | typeof KV_NOOP
```

The library calls the updater with the latest known value (the local
mirror on the first attempt; the server's `currentData` on conflict
retries) and persists the result. Etag handling and the
`if-match` / `409` / `412` retry loop are entirely internal.

Returning the sentinel `KV_NOOP` aborts the write (replaces today's
`return null` idiom from `onconflict`).

Reducers are re-run on conflict retries, so the reducer's **return
value must be a deterministic function of `prev` and surrounding
observable state**: do not mutate `prev`, do not call out to network
APIs, do not emit events, and do not rely on implicit ordering between
invocations. Reading external values inside
the reducer (the current time via `sbp('chelonia/time')`, a slice of
root state, a feature flag) is fine and expected — the contract is
that given the same `prev` and the same surrounding observable state,
the reducer returns the same result. The throttling example below
relies on this: it reads the clock, compares against `prev`, and
returns a deterministic value or `KV_NOOP`.

> ⚠️ **Don't embed wall-clock values in the reducer's return.** Reading
> the clock to *gate* the write (NOOP vs. proceed) is fine, but
> embedding `new Date().toISOString()` / `Date.now()` directly into the
> persisted value means the conflict-retry invocation produces a
> different result than the first attempt — defeating optimistic-write
> semantics and producing user-visible clock drift on contended slots.
> If you need a timestamp in the value, derive it from `prev` (e.g.
> `prev.lastSeen` advanced by a fixed delta) or compute it **once**
> outside the reducer and close over the captured value:
>
> ```ts
> const now = new Date().toISOString()
> sbp('chelonia/kv/update', { contractID, key, updater: (prev) => ({ ...prev, lastSeen: now }) })
> ```
>
> The `lastLoggedIn` example in §7.2 follows this rule literally:
> both the gate (`nowMs`) and the persisted value (`now`) are
> captured once *outside* the reducer, so every retry returns the
> same string. Do not read `Date.now()` or `new Date()` from inside
> the reducer body for a value that ends up in the persisted result.

**Throttling, debouncing, and other "don't-write-yet" gates** belong
*inside* the reducer, not outside it. The `LAST_LOGGED_IN` selector
in `group-kv.js` throttles writes to one per 30 minutes per
`(group, identity)` pair; under the new API the reducer reads the
existing timestamp from `prev`, compares against `sbp('chelonia/time')`,
and returns `KV_NOOP` if the window has not elapsed. This keeps the
throttle decision atomic with the read of the previous value (no TOCTOU
gap between "is the throttle window open?" and "write the new
value"), which the current external-throttle implementation cannot
guarantee.

---

## 4. Public API

All selectors live under the `chelonia/kv/*` namespace, alongside the
existing primitives.

### 4.1 `chelonia/kv/defineSlot`

```ts
sbp('chelonia/kv/defineSlot', {
  // Required
  contractType: string | string[],   // e.g. 'gi.contracts/identity'
  key: string,                       // e.g. 'preferences'

  // Optional
  defaultValue?: JSONType | (() => JSONType),
  schema?: ZodLikeSchema,            // anything with .parse(value)
  match?: (
    contractID: string,
    contractState: object,
    rootState: object
  ) => boolean,                      // default: () => true
  encryptionKeyName?: string | null, // default 'cek'; null explicitly disables encryption
  signingKeyName?: string,           // default 'csk'
  // Optional default reducer factory. When provided, callers may pass
  // `value` to `chelonia/kv/update` instead of `updater`, and the
  // library will synthesise the reducer as `defaultUpdater(value)`.
  // See §4.2 for semantics, mutual-exclusion rules, and error cases.
  defaultUpdater?: (value: PatchT) => (prev: T) => T | typeof KV_NOOP,
  autoSubscribe?: boolean,           // default true — manages setFilter
  autoLoad?: 'on-sync' | 'on-demand' | 'never',  // default 'on-sync'
  refreshOnReconnect?: boolean,      // default true — re-fetch on websocket reconnect
  // MUST NOT throw — thrown errors (and rejected promises) are caught
  // and logged; they never propagate into the library's dispatch path
  // (matching the journal recorder's contract). There is no
  // return-value channel for signalling success: the callback returns
  // `void` (or a `Promise<void>`), and any failure handling must
  // happen inside the callback itself.
  onUpdate?: (value: JSONType, ctx: KvUpdateCtx) => void | Promise<void>
}): void
```

`onUpdate` is the single hook for side effects that today live in
`sw-primary.js` (`KV_EVENT` switch) and in `loadCachedNames` (re-running
`checkAndAugmentNames` against the freshly-fetched namespace cache).
It fires with `ctx.reason ∈ { 'load', 'remote', 'local', 'reconnect' }`
so consumers can differentiate "initial fetch after sync" from "pubsub
push" from "our own successful write" from "websocket re-fetch" when
needed. Both synchronous **throws and rejected promises** from
`onUpdate` are caught (the dispatcher wraps the call in
`try { await onUpdate(...) } catch (e) { /* log */ }`); neither
propagates into the library's dispatch path. This is a hard library
contract enforced by the dispatcher itself (matching the journal
recorder's MUST-NOT-throw contract, which is enforced the same way):
a buggy `onUpdate` cannot wedge the KV pipeline. The MUST-NOT-throw
label describes the *consumer's* intent; the *library* guarantees
it by catching.

**Per-frame firing (no deep-equality suppression).** `onUpdate` (and
the `CHELONIA_KV_UPDATED` event) fire once per *accepted* frame, not
once per *distinct* value. A pubsub frame whose decoded value is
deep-equal to the current mirror value still fires — most visibly a
re-broadcast after a websocket reconnect (`reason: 'reconnect'`) or a
redundant remote push (`reason: 'remote'`). The library deliberately
does **not** diff old vs. new before firing: that would change the
observable `reason` stream and hide legitimate "the server reaffirmed
this value" signals. Consumers that need change-only semantics should
compare `ctx.value` against `ctx.previousValue` (both are on every
payload) and early-return when they match.

**Async `onUpdate` and head-of-line blocking.** The KV dispatcher
`await`s `onUpdate`, and pubsub processing is serialised per-contract
through `chelonia/queueInvocation` (`src/chelonia.ts:1103`). A slow
async `onUpdate` therefore blocks every subsequent KV notification
*for the same contract*. If the work doesn't need to complete before
the next KV frame is processed, fire-and-forget it:

```ts
onUpdate (value, ctx) {
  queueMicrotask(() => doExpensiveWork(value, ctx))
}
```

The library does not provide a separate priority lane in v1.

**Re-entrant same-contract writes from `onUpdate` deadlock — the
synchronous form is detected and rejected.** Because `onUpdate` runs
*inside* the per-contract `chelonia/queueInvocation` lane and the lane
is held until the callback settles, calling a KV **write** selector
(`chelonia/kv/update`, `clear`, or `sync`) for the **same contract**
from `onUpdate` enqueues behind the lane that is blocked awaiting that
very callback — a permanent deadlock. To turn the most common form of
this hang into a clear, debuggable failure, those selectors detect
re-entrancy during the callback's *synchronous* execution and reject
with `ChelErrorKvReentrant`. The guard is deliberately narrow — it
covers only the callback's synchronous portion (up to its first
`await`), because during that window the JS engine cannot interleave
any other task, so a same-contract write observed then is provably
re-entrant. Holding the flag across the callback's own awaits would
falsely reject *independent* concurrent writes that merely interleave
with a slow async `onUpdate` (those queue safely behind the lane and
must succeed). Safe from `onUpdate` at any time: `chelonia/kv/read` /
`chelonia/kv/status` (synchronous, unqueued) and writes to *other*
contracts. To re-enter a write on the same contract, schedule it off
the synchronous stack and do not await it inside the callback:

```ts
onUpdate (value, ctx) {
  queueMicrotask(() => sbp('chelonia/kv/update', { contractID: ctx.contractID, key: ctx.key, … }))
}
```

The scheduled write simply queues behind the lane and runs once the
lane releases — no deadlock, no rejection. (A re-entrant write issued
*after* an `await` inside `onUpdate` is outside the synchronous window
and is not detected; treat it as unsupported and schedule it off the
stack as above.)

`defaultValue` may be a value or a zero-arg factory. When it is a
factory, it is called **once** at registration time and the result is
validated through `schema.parse`. Every subsequent `chelonia/kv/read`
that returns the default does so by **deep-cloning** the stored value
so readers can never mutate the shared default.

> ⚠️ **Factories run exactly once, at registration time.** A factory
> like `() => new Date().toISOString()` freezes the timestamp at boot
> and every reader for the lifetime of the process will see that one
> value. Factories are only useful for cheap object/array literals you
> want schema-validated and per-call cloned. For anything time- or
> state-dependent, compute the value inside the reducer instead.

**Schema-accepted `null` is forbidden.** Wire-level `null` is reserved
as the clear sentinel (see §4.5), so a slot's `schema` MUST NOT accept
`null` anywhere in the parsed stored value (e.g. avoid
`z.nullable(...)` / `z.union([X, z.null()])`). The same restriction
applies to `undefined`: a schema that accepts `undefined` cannot
disambiguate "never written" from "explicitly written undefined"
(the mirror's `value: undefined` is reserved for the former — §4.3).
Schemaless slots are held to the same invariant by the built-in JSON
shape guard. If you need a tri-state, encode it as
`{ kind: 'present' | 'absent', ... }` or `{ value: T }`.
`defineSlot` performs **three** registration-time guards:

1. `schema.parse(null)` is invoked; if it *succeeds*, registration
   throws `ChelErrorKvSlotInvalid` because the schema cannot
   disambiguate "cleared" from "explicit null".
2. `schema.parse(undefined)` is invoked; if it *succeeds*,
   registration throws `ChelErrorKvSlotInvalid` for the same reason
   (collides with the "not yet loaded" mirror representation).
3. The resolved `defaultValue` is round-tripped through
   `schema.parse(schema.parse(resolvedDefault))` to catch schemas
   that coerce or discard fields silently. The first parse must
   produce a value that the second parse accepts unchanged
   (structural equality via `JSON.stringify`); otherwise registration
   throws `ChelErrorKvSlotInvalid`. This catches schemas that
   silently drop or coerce fields of the resolved default.

Only the wire byte `null` is treated as a clear by the dispatcher;
absence of a value at the server (404 / empty response) is treated as
"not yet written" and resolves the slot to its `resolvedDefault`.

**Optional `defaultUpdater` (preferred for simple slots).** A slot
whose write shape is uniform — "shallow-merge this patch", "replace
with this value", "throttle a single timestamp" — can declare a
`defaultUpdater` factory once and let every call site drop the
hand-written reducer:

```ts
sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'preferences',
  defaultValue: {},
  schema: PreferencesSchema,
  defaultUpdater: (patch) => (prev) => ({ ...prev, ...patch })
})

// Every call site collapses from:
//   updater: (prev) => ({ ...prev, ...patch })
// to:
sbp('chelonia/kv/update', {
  contractID, key: 'preferences', value: { theme: 'dark' }
})
```

The factory is invoked **once** per `chelonia/kv/update` call,
closing over the caller's `value`; the returned `(prev) => next`
reducer is what gets re-run on `409`/`412` conflict retries. All the
ordinary reducer rules from §3.3 apply unchanged — including
returning `KV_NOOP` to gate writes (e.g. a slot that throttles a
single timestamp can encode the 30-minute window inside its
`defaultUpdater`, eliminating call-site boilerplate). Validation
against `schema.parse` happens on the reducer's *output*, identical
to the hand-written `updater` path; the caller's `value` is **not**
schema-checked before being handed to the factory, so the factory is
responsible for producing a schema-shaped result.

This form is **preferred for slots with a single canonical write
shape** (shallow-merge patches, full-value replacement, throttled
single-field writes, etc.). Slots with multiple distinct write
intents against the same key (e.g. Group Income's `unreadMessages`,
which has set-read-cursor / add-msg / remove-msg / delete-room
intents) should continue to use `updater` at the call site — there
is no sensible single `defaultUpdater(value)` that expresses all
four intents, and encoding an action tag in `value` is just
reinventing a reducer with a worse type signature.

`defaultUpdater` and `updater` are **mutually exclusive** at the
call site (§4.2). The factory may also be reused across multiple
slots — e.g. a shared `(patch) => (prev) => ({ ...prev, ...patch })`
helper handed to every slot whose write shape is "shallow merge".

**Notably absent: no `merge` hook.** An earlier draft included a
`merge(server, local)` callback for incoming pubsub notifications.
It was removed because it overlaps with `onUpdate` (which fires
*after* the mirror write and is the right place for read-side side
effects) and with the `chelonia/kv/update` reducer (which fires
*before* the network write and is the right place for write-side
conflict resolution). Last-write-wins on the pubsub path keeps the
mirror in lockstep with the server; consumers who need to react to
remote updates do so through `onUpdate` with `ctx.reason === 'remote'`.
Because KV pubsub frames do not carry etags and are not documented as
ordered relative to HTTP conflict responses, a non-self remote frame
that arrives after a local conflict retry forces an authoritative
`chelonia/kv/sync` instead of blindly overwriting the mirror.
This authoritative re-fetch reconciles the mirror but never surfaces a
transient `'loading'` status when the slot is already `'loaded'` — the
`loaded → loading → loaded` flicker would be a cosmetic artefact of
reusing the load path, not a real state transition. If the re-fetch
itself fails (offline, malformed server data), the failure is logged
and swallowed — it never throws out of the pubsub dispatch path — and
the pending conflict markers are demoted regardless of success or
failure, so a persistent fetch failure cannot pin the slot into a
GET-per-frame loop until the echo TTL expires.
If a real use case for a pre-mirror-write transform emerges, it can be
added later — but v1 ships without it to keep the surface small.

The `match` predicate is the *correct* way to express "only on the
own identity contract". Example, lifted verbatim from the GI port:

```ts
const onOwnIdentity = (cID, _state, rootState) =>
  cID === rootState.loggedIn?.identityContractID
```

Registers a slot. May be called multiple times safely; the
`{contractType, key}` pair is the identity. Subsequent calls **replace**
the definition, re-evaluate `match` against currently-synced contracts,
adjust the `setFilter` set, and re-validate any cached value against
the new `schema`. There is no `ChelErrorKvSlotConflict`: the registry
is last-write-wins per `(contractType, key)` so hot-module-reloaded
code keeps working in dev. Two different `contractType`s using the
same `key` string are not a conflict — they're independent slots.

**Cached-value re-validation on slot replacement.** When a `defineSlot`
call replaces an existing definition, every persisted mirror entry for
that slot whose contract type can be resolved (across all matching
contracts) is re-run through the new `schema.parse`. Entries whose
contract type cannot be resolved — for example, released contracts that
still have persisted `_kv` rows before the next sync — are skipped until
`_loadSlotNow` validates them on re-sync. The library does **not**
discard data on schema mismatch — that would silently destroy state
across a deploy. Instead, for each failing entry: the mirror **keeps**
the old value, `status` flips to `'error'`, `lastError` records the Zod
issue, and `CHELONIA_KV_VALIDATION_ERROR` fires. The consumer can then
choose to call `chelonia/kv/clear` (to reset to the new default) or
`chelonia/kv/sync` (to refetch from the server in case the persisted
value is stale). Successful re-validations transition `status` back to
`'loaded'` and fire `CHELONIA_KV_UPDATED` with `reason: 'load'`.

On re-validation events, `previousValue` is the mirror value as it
stood *before* the re-validation pass. On a successful re-validation
where the parsed value is structurally identical to the previous
mirror value, the event still fires (so listeners observing
transitions out of `'error'` can react); consumers that diff on
`previousValue` should treat structural equality as a no-op themselves.

**Behaviour wiring (all internal):**

- On `chelonia/contract/sync` and `CONTRACTS_MODIFIED` (added contracts),
  the library evaluates every registered slot's `match` predicate
  against the new contracts. For each `(contractID, slot)` pair where
  `match` returns true and `autoSubscribe` is true, the library
  recomputes the union of subscribed keys *for that contractID* and
  emits a **single** coalesced `chelonia/kv/setFilter` call (see §11.5).
- If `autoLoad === 'on-sync'`, the library issues a `chelonia/kv/get`
  for the slot immediately after sync. The fetched value is validated,
  written into the mirror, and `onUpdate` fires with `ctx.reason = 'load'`.
- If `autoLoad === 'on-demand'`, no automatic fetch runs on sync;
  `chelonia/kv/read` serves the declared default until the consumer
  calls `chelonia/kv/sync` (or performs a successful
  `chelonia/kv/update`).
- If `autoLoad === 'never'`, the library never auto-fetches this slot;
  only explicit `chelonia/kv/sync` or `chelonia/kv/update` writes can
  materialize a mirror value.
- Pubsub `NOTIFICATION_TYPE.KV` notifications for a registered slot
  are validated, written into the mirror, and `onUpdate` fires with
  `ctx.reason = 'remote'`. Notifications for slots whose `match`
  currently returns false are dropped before validation.
- On websocket reconnect (the library already tracks this for its own
  sync; see `src/pubsub/index.ts`), slots with `refreshOnReconnect: true`
  are re-fetched and `onUpdate` fires with `ctx.reason = 'reconnect'`.
  This replaces GI's hand-rolled `ONLINE` listeners in `identity-kv.js`
  and `group-kv.js`.
- All slot validation failures throw `ChelErrorKvValidation` (which
  carries the underlying error from `schema.parse`), so callers can
  branch on schema rejection in their own error handlers.

```ts
type KvUpdateCtx = {
  contractID: string
  contractType: string  // resolved from rootState.contracts[contractID].type
  // (fallback: rootState[contractID]._vm.type)
  key: string
  reason: 'load' | 'remote' | 'local' | 'reconnect'
  etag: string | null
  previousValue: JSONType | undefined  // mirror value before this update; undefined on first load
}
```

`contractType` is included in both `KvUpdateCtx` and the
`CHELONIA_KV_UPDATED` event payload (see §4.9). The slot registry is
keyed by `(contractType, key)`, so consumers that route updates by
type — for example the generic Vuex mirror table in §9 — can do so
without maintaining a parallel `contractID → contractType` lookup.

### 4.2 `chelonia/kv/update`

The ergonomic write path. Takes a reducer (or a value, if the slot
declared a `defaultUpdater`) and handles the rest.

```ts
sbp('chelonia/kv/update', {
  contractID: string,
  key: string,
  // Exactly one of `updater` or `value` must be provided.
  // - `updater`: explicit reducer (always available).
  // - `value`:   sugar for slots that declared `defaultUpdater` in
  //              `defineSlot`. Equivalent to
  //              `updater: slot.defaultUpdater(value)`.
  updater?: (prev: T) => T | typeof KV_NOOP,
  value?: PatchT,
  // Optional escape hatches (most consumers should not need these):
  maxAttempts?: number,         // default 3 (matches chelonia/kv/set)
  signal?: AbortSignal,
  ifMatch?: string              // bypass the mirror-based optimistic etag
}): Promise<T | undefined>
```

**Choosing between `updater` and `value`.** The `value` form is the
recommended shape for any slot whose writes all follow one canonical
pattern (see §4.1's `defaultUpdater` discussion). The `updater` form
remains the right choice for multi-intent slots and for one-off
writes whose shape doesn't match the slot's `defaultUpdater`. Both
forms produce the same network traffic, same retry semantics, and
same events; the only difference is who authors the reducer.

**Rejection taxonomy.** `chelonia/kv/update` rejects with one of:

| Error | Cause |
|---|---|
| `ChelErrorKvSlotUnknown` | No slot is registered for the resolved `(contractType, key)`, or `contractID` isn't synced. |
| `ChelErrorKvUpdateInvalid` | Neither `updater` nor `value` was provided; **or** both were provided; **or** `value` was provided but the slot has no `defaultUpdater`; **or** the reducer threw, or returned `null` / `undefined` (use `KV_NOOP` to abort a write explicitly). The first three cases reject synchronously before any network or mirror access; reducer-side faults reject after the reducer runs but before the network write. The original thrown value (if any) is preserved on `.cause`. |
| `ChelErrorKvValidation` | The reducer's output failed `schema.parse`, or the server's `currentData` on a conflict retry failed `schema.parse`. The underlying issue is attached as `.cause`. |
| `ChelErrorKvConflict` | All `maxAttempts` attempts hit a 409/412 and the reducer kept producing a new value (i.e. real contention, not malformed data). The last server `currentData` and `etag` are attached on `.cause` (the same convention the journal uses for `ChelErrorJournalCorrupt`). |
| `AbortError` | `signal` was aborted. Mirror is unchanged; no event fires. |
| underlying network / HTTP errors | Propagated verbatim from `chelonia/kv/set` for non-409/412 failures (e.g. 5xx, offline). The mirror is not updated by the rejected call and `status` is **not** flipped to `'error'` (that state is reserved for *load* failures). If the server committed an ambiguous write before the failure surfaced, the later pubsub notification can still reconcile the mirror as a `reason: 'remote'` update. |

Returning `KV_NOOP` from the reducer resolves with `undefined` and is
not an error.

`T` is inferred from the slot schema when available (`schema.parse`
return type); without a schema it falls back to `JSONType`.

`signal` aborts the in-flight update attempt (including the
conflict-retry loop) and rejects with an `AbortError`. On abort, the
mirror remains at its previous value and no `CHELONIA_KV_UPDATED` event
is emitted.

> Implementation note: the existing `chelonia/kv/set`
> (`src/chelonia.ts:2565`) passes `this.abortController.signal`
> (Chelonia's global controller) into `fetch`. v1 takes the
> compose-controllers approach (the only one that aborts the
> in-flight HTTP request, not just the next retry): thread an
> optional `signal?: AbortSignal` through `chelonia/kv/queuedSet`
> → `chelonia/kv/set` and, at the `fetch` call sites in
> `chelonia/kv/set` (`src/chelonia.ts:2658, 2674`), pass
> `AbortSignal.any([this.abortController.signal, signal].filter(Boolean))`
> as the `fetch` `signal`. `AbortSignal.any` is available in all
> currently supported Node/browser targets; if a target without it
> ever resurfaces, fall back to a tiny shim that listens on both
> and forwards `abort()` to a combined controller. The retry loop
> inside `chelonia/kv/set` additionally checks `signal?.aborted`
> at every loop boundary so a cancellation that lands between
> requests is honoured without waiting for the next `fetch`.

Internally:

1. Resolves the slot definition by **two-step lookup**: first reads
   `rootState.contracts[contractID].type` to get the contract type
   (see `getContractType` for fallback), then looks up the slot in
   the per-contract active index (`kvSlotsByContractID[contractID][key]`).
   Throws `ChelErrorKvSlotUnknown` if the contract isn't synced or
   the slot is not active for that contract (match returned false or
   the slot was never registered for that contract type).
   (See §11.2 for the registry layout and the secondary
   `contractID → slots` index that makes pubsub dispatch O(1)
   rather than a registry scan.)
1a. Normalises the write input. Exactly one of `updater` / `value`
    must be present:
    - both or neither → reject with `ChelErrorKvUpdateInvalid`;
    - `value` given but the slot has no `defaultUpdater` → reject
      with `ChelErrorKvUpdateInvalid`;
    - `value` given and the slot has a `defaultUpdater` → synthesise
      `updater = slot.defaultUpdater(value)` **once** (the returned
      reducer is what gets re-invoked on conflict retries, so the
      caller's `value` is closed over and stable across retries).
    All rejections in this step happen synchronously, before any
    mirror read or network access.
2. Looks up the current `(value, etag)` from the local mirror.
3. Calls `updater(value)`. If the result is `KV_NOOP`, resolves with
   `undefined` and skips the network entirely.
4. Validates the result through `schema.parse` (if defined). On
   failure, rejects with `ChelErrorKvValidation` — the network is
   never hit.
5. Calls `chelonia/kv/queuedSet` with the validated value as `data`
   (written raw — no wrapper). The queued primitive in turn hands
   the value to
   `chelonia/kv/set` → `outputEncryptedOrUnencryptedMessage`,
   which signs/encrypts it as one opaque payload — no signature
   change is required to either primitive. An internally
   constructed `onconflict` then:
   - **validates the server's `currentData` through `schema.parse`**
     before passing it to the reducer (so the reducer always sees a
     schema-shaped value, identical to its first-attempt input);
   - re-runs `updater` against the validated value;
   - re-validates the reducer's output through `schema.parse`;
   - returns `[newData, etag]` to retry, or aborts the retry loop on
     `KV_NOOP`.
   If the server's `currentData` itself fails validation, the conflict
   handler rejects with `ChelErrorKvValidation` carrying the Zod issue
   (the update cannot safely proceed without a sound base value).
6. On success, reads the server-issued etag (the data CID) from the
   `kv/set` response (`x-cid` / `etag` header, the same fields already
   consumed by the existing `onconflict` plumbing at
   `src/chelonia.ts:2635`) and writes `(value, etag)` into the
   mirror, fires `CHELONIA_KV_UPDATED` then `onUpdate` with
   `reason: 'local'`, and resolves with the stored value. The pubsub
   echo of this write will carry the same data CID in its `cid` field
   (see §4.9); the dispatcher (§4.9, §11.3 step 4) recognises the CID
   as one of our own recent writes (tracked in a time-decaying map
   that expires entries after ~5 minutes) and drops it without firing
   a second event.

   The etag is reachable here because v1 changes
   `chelonia/kv/set` to return `{ etag: string | null }` on
   successful writes (currently it returns `void`). This is
   backwards compatible — every existing call site ignores the
   return value — and `chelonia/kv/queuedSet` forwards the
   resolved value through verbatim. See §11.3 step 5 for the
   exact signature change.

`KV_NOOP` is exported as a Symbol from the package root and is the
single sanctioned "no-op" sentinel — it replaces today's mix of
`return null` / `return undefined` from `onconflict`.

### 4.3 `chelonia/kv/read`

```ts
sbp('chelonia/kv/read', contractID: string, key: string): T
```

Synchronous read from the mirror. Returns the slot's `defaultValue`
(deep-cloned) if no value has been fetched yet. Does **not** hit the
network; use `chelonia/kv/sync` if a fresh fetch is required.

Throws `ChelErrorKvSlotUnknown` if no slot is registered for the
resolved `(contractType, key)` pair or if `contractID` is not in
`subscriptionSet` (same conditions as `chelonia/kv/update` — §4.2).
This is symmetric with the write path: a consumer that misspells a
key or queries before sync fails loudly instead of silently getting
`undefined`.

> **Mirror representation of "not yet loaded".** When a slot's `match`
> first returns true, the reconcile pass creates a mirror entry with
> `status: 'non-init'` and **`value: undefined`** — the
> `resolvedDefault` is *not* eagerly copied into the mirror. This
> keeps the persisted `rootState._kv` honest: a mirror `value` is
> always either a server-confirmed (or server-cleared) payload or
> `undefined`. The same `value: undefined` shape is used for **every**
> `'non-init'` transition — a first-load 404, a local `clear`, and a
> remote (wire-`null`) clear all leave `value === undefined` (§4.5),
> so direct `rootState._kv` observers see one consistent shape per
> logical state. `chelonia/kv/read` substitutes the deep-cloned default
> on every call when `value === undefined`, so callers never observe
> the `undefined`. External observers reading `rootState._kv` directly
> (the §9 Vuex mirror table, anyone subscribed via
> `chelonia/externalStateSetup`) MUST treat `status` as the source of
> truth: `'non-init'` means "the mirror is presenting the declared
> default; nothing has been confirmed from the server yet", regardless
> of what `value` looks like. The cleanest pattern in such consumers
> is `value ?? read(contractID, key)`.
>
> **First-load 404 emits no `CHELONIA_KV_UPDATED`.** On the very first
> load of a never-written key the mirror `value` stays `undefined`
> (`undefined → undefined`, no change), so only
> `CHELONIA_KV_STATUS_CHANGED` fires (`non-init → loading →
> non-init`); `CHELONIA_KV_UPDATED` / `onUpdate` are intentionally
> **not** emitted (consistent with the "value actually changed" emit
> discipline used everywhere else). Consumers that need a "slot has
> settled" signal MUST key off `CHELONIA_KV_STATUS_CHANGED` reaching a
> terminal status (`non-init` / `loaded` / `error`), **not** off
> `CHELONIA_KV_UPDATED`.

### 4.4 `chelonia/kv/sync`

```ts
sbp('chelonia/kv/sync', contractID: string, key?: string): Promise<void>
```

Forces a fetch (over `chelonia/kv/get`) and refreshes the mirror.
Without `key`, refreshes every slot registered for `contractID`'s
contract type whose `match` predicate currently returns true — slots
whose `match` is currently false are skipped (they have no mirror
entry to refresh and no business being fetched). When refreshing
multiple slots, fetches are dispatched concurrently with
`Promise.all` but each individual `chelonia/kv/get` runs through
`chelonia/queueInvocation` keyed on `contractID`, so the call is
serialised against any in-flight `chelonia/kv/update` writes against
the same contract and cannot race them. **Resolves with `void`** once
the mirror is up to date — the aggregate (no-`key`) form never
rejects, even if some slots fail. Per-slot failures (HTTP errors,
validation rejections) flip *that* slot's `status` to `'error'` and
update `lastError`; consumers detect failures by inspecting
`chelonia/kv/status` (or by listening for
`CHELONIA_KV_STATUS_CHANGED` / `CHELONIA_KV_VALIDATION_ERROR`)
after the call resolves. The single-slot form (called with an
explicit `key`) *does* reject on that slot's failure — use it when
you need rejection-based error handling for a specific slot.

### 4.5 `chelonia/kv/clear`

```ts
sbp('chelonia/kv/clear', contractID: string, key: string, options?: {
  maxAttempts?: number,    // default 3 (matches chelonia/kv/set)
  signal?: AbortSignal     // abort the clear attempt
}): Promise<void>
```

Resets a key to its declared default.

**Wire protocol.** Server-side, `clear` writes JSON `null` through the
existing `chelonia/kv/set` (the same write path that
`chelonia/kv/update` uses — §4.9). The `value: null` *is* the
clear sentinel; it is signed/encrypted normally and opaque to the
server. (`undefined` is not an option:
`chelonia/kv/set` treats a `data === undefined` argument as a
fetch-first sentinel that performs a `GET` and routes through
`onconflict` instead of a write — see `src/chelonia.ts:2649,2667-2679`.
Writing JSON `null` keeps the write path active
and produces an unambiguous payload on the wire.) On the receive
side, `_handleRemote` recognises the
`value === null` as a clear, restores the slot's `defaultValue`,
and does **not** invoke `schema.parse`. Because `null` is reserved
across the entire KV surface as the clear sentinel, §4.1 forbids
slot schemas that accept `null` — that's how the wire encoding
stays unambiguous.

**Local mirror.** Immediately after the network write resolves, the
local mirror `value` is reset to `undefined` — the canonical
`'non-init'` representation (§4.3), identical to a first-load 404 —
rather than to a copy of the default. `status` returns to
`'non-init'`, and `CHELONIA_KV_UPDATED` fires with `reason: 'local'`
and `value: undefined` (matching the raw mirror). `chelonia/kv/read`
and the `onUpdate` callback still surface the deep-cloned default, so
consumers observe the declared default while direct `rootState._kv`
readers see one consistent "no value" shape.

**Remote receivers.** Other clients receive `null` over pubsub; their
slot loaders treat it as a clear sentinel *before* `schema.parse`
(map `null` → `value: undefined` in the mirror, surface the cloned
default via `read`/`onUpdate`, then write status/events with
`reason: 'remote'`). `schema.parse` is not invoked for this
wire-level sentinel.

If/when the server grows a real `DELETE /kv/...` verb, this selector's
contract is unchanged — only the wire encoding shifts.

### 4.6 `chelonia/kv/status`

```ts
sbp('chelonia/kv/status', contractID: string, key?: string):
  'non-init' | 'loading' | 'loaded' | 'error'
```

Reports the load state of a slot or aggregate state of an entire
contract. Replaces Group Income's hand-rolled
`NEW_KV_LOAD_STATUS` machinery.

**Single-slot form** (with `key`): reads the active slot's `status`
from the mirror. Unlike `read`/`update`/`sync`/`clear`, `status` does
**not** reject on an unknown or inactive slot — it returns `'non-init'`.
This matches the consumer pattern of rendering a status badge
regardless of whether the slot is actually wired without needing
try/catch around the call.

**Aggregate form** (no `key`): reduces across every slot active for
`contractID` (i.e. every entry in `kvSlotsByContractID[contractID]`)
with the precedence `'error'` > `'loading'` > `'non-init'` >
`'loaded'`. Rationale: a UI rendering an aggregate badge wants the
worst observable state — if anything is failing, surface failure;
if anything is still loading and nothing is failing, surface loading;
if everything has reached `'loaded'`, surface `'loaded'`. Returns
`'non-init'` if no slots are active for the contract.

### 4.7 `chelonia/kv/refreshFilters`

```ts
sbp('chelonia/kv/refreshFilters', contractID?: string): void
```

Runs a full reconcile pass: re-evaluates every registered slot's
`match` predicate, updates the `kvSlotsByContractID` index, schedules
`autoLoad` fetches for slots whose `match` newly returned `true`, drops
mirror entries for slots whose `match` newly returned `false`, and
emits a coalesced `setFilter` flush for the affected contracts. With
`contractID`, the pass is scoped to one contract; without, it applies
to all currently-synced contracts.

Consumers call this after they mutate root state that the library
cannot observe — most notably the login transition
(`rootState.loggedIn = { identityContractID }` flips the "own identity"
predicate). It's a no-op if no slot's match result changed.

**Iteration source:** the reconcile pass walks
`this.subscriptionSet` (i.e. currently-synced contracts) and skips
any `contractID` whose `rootState.contracts[contractID]?._vm.type`
does not match a registered slot. It deliberately does **not**
consider unsynced or pending contracts — those will be reconciled
when their own `CONTRACTS_MODIFIED(added)` fires.

> Naming note: this is called `refreshFilters` for historical
> continuity with `chelonia/kv/setFilter`, but its effect is the full
> reconcile described above, not just a filter resend.

### 4.8 `defineContract` KV co-location (sugar over `defineSlot`)

For consumers using `chelonia/defineContract`, slots can be declared
inline:

```ts
sbp('chelonia/defineContract', {
  manifest: 'gi.contracts/identity',
  // ... actions, getters, sideEffects ...
  kv: {
    preferences: {
      defaultValue: {},
      schema: PreferencesSchema,
      match: onOwnIdentity
    },
    unreadMessages: { defaultValue: {}, schema: UnreadMessagesSchema, match: onOwnIdentity },
    notifications: { defaultValue: {}, schema: NotificationsSchema.transform(applyStorageRules), match: onOwnIdentity },
    'namespace-cache': {
      defaultValue: [],
      autoSubscribe: false,         // not in pubsub filter
      autoLoad: 'on-demand',
      onUpdate: (value, ctx) => { /* checkAndAugmentNames(value) */ }
    }
  }
})
```

This is sugar over `chelonia/kv/defineSlot` — each entry is registered
as if the consumer had called `defineSlot` with `contractType` set to
the contract name (the value stored in `state.contracts[cID].type`).
Slots declared this way are unregistered when the contract definition is
replaced by tracking the previous key-set for that manifest and removing
keys that are no longer present in the new `kv` block before registering
replacements.

### 4.9 Events

A small, fixed set of events on the existing `okTurtles.events` bus —
no per-key event constants ever again. All events emit a payload of
shape `{ contractID, contractType, key, value, previousValue, reason, etag }`
— the same fields as `KvUpdateCtx` (§4.1) plus `value`. `previousValue`
is `undefined` on the first load of a slot and otherwise carries the
mirror's value immediately prior to this update, so consumers can diff
without keeping their own shadow copy. `etag` on the event payload is
is the server-issued identifier currently held by the mirror (`null`
until the first successful load or write completes). A 404 / missing-key
transition after a previous value emits `value: undefined`, matching the
mirror; the slot's `onUpdate` callback receives the read-substituted
default for that transition.

| Event | When | Payload notes |
|---|---|---|
| `CHELONIA_KV_UPDATED` | Any change to a registered slot — `reason` is one of `'load'` (initial fetch after sync), `'remote'` (pubsub notification *not* originating from this client's own write), `'local'` (our own successful write), `'reconnect'` (refetch on websocket reconnect). The canonical replacement for Group Income's `KV_EVENT` plus all `NEW_*` constants. | `{ contractID, contractType, key, value, previousValue, reason, etag }`. On `reason: 'remote'` the `etag` is the data CID carried in the pubsub frame's `cid` field (see "Self-echo suppression" below), so the mirror etag stays authoritative across pubsub updates and a subsequent local write can use it as the default `if-match` without a guaranteed `412`. |
| `CHELONIA_KV_STATUS_CHANGED` | Slot transitions between `non-init`/`loading`/`loaded`/`error`, **or** `lastError` changes while the status remains the same (e.g. repeated validation failures produce different error details). On a load path the sequence is `CHELONIA_KV_STATUS_CHANGED('loading')` → mirror write → `CHELONIA_KV_UPDATED` → `CHELONIA_KV_STATUS_CHANGED('loaded')`, so a consumer can rely on "about to populate" / "populated" being observable without races. | `{ contractID, contractType, key, status, previousStatus, lastError }`. `lastError` is `{ name, message }` when transitioning into `'error'` or when the error details change while already in `'error'`, and `null` otherwise. When `previousStatus === status` and only `lastError` changed, `status` and `previousStatus` are identical — consumers that only care about status transitions can skip these events by checking `previousStatus !== status`. |
| `CHELONIA_KV_VALIDATION_ERROR` | `schema.parse` rejected a remote or load-path value. Carries the Zod error on `.cause`. Reducer-side validation rejects the `chelonia/kv/update` promise instead; no event fires in that case to avoid double-reporting. | `{ contractID, contractType, key, error, reason: 'load' \| 'remote' \| 'reconnect' \| 're-validate' }`. The `'re-validate'` reason fires when a `defineSlot` replacement re-runs the new schema against persisted entries (§4.1). |

**Load-path failure sequence.** On the load path, the equivalent
failure sequence is `CHELONIA_KV_STATUS_CHANGED('loading')` →
`CHELONIA_KV_VALIDATION_ERROR` (or the underlying load error) →
`CHELONIA_KV_STATUS_CHANGED('error')`, with **no**
`CHELONIA_KV_UPDATED` emitted (the mirror keeps its previous value,
so there is no transition to broadcast). This is the mirror image
of the success-path sequence in the `CHELONIA_KV_UPDATED` row.

**Event-vs-status contract on the conflict-resolution path.** The
authoritative GET that resolves a KV conflict runs with
`preserveStatusOnError: true` (see `_loadSlotNow`'s flag definition):
a failed GET must not flip the slot to `'error'` because the
conflict-resolved write already committed a valid value to the
mirror, and flipping would make `chelonia/kv/read` return the default
and silently hide that retained value. Consequently
`CHELONIA_KV_VALIDATION_ERROR` fires even though the status stays
`'loaded'` — the event is diagnostic ("the server returned something
invalid") while `status` reflects the mirror's actual usability.
Consumers that need a "slot is in trouble" signal MUST watch
`CHELONIA_KV_STATUS_CHANGED` reaching a terminal status, not infer
health from the presence or absence of a `CHELONIA_KV_VALIDATION_ERROR`
event.

**Status on remote validation failure.** When `schema.parse` rejects a
load-path, reconnect-path, or pubsub-path value, the mirror keeps its
previous value **and** the slot transitions to `status: 'error'` with
`lastError` set. This is consistent with the load-path failure
behaviour and gives consumers a single observable signal (the status)
to drive "stale data" UI. The next successful validation (via
`chelonia/kv/sync`, a successful local `chelonia/kv/update`, or a
subsequent valid pubsub frame) clears `lastError` and returns
`status` to `'loaded'`. Non-load HTTP failures from
`chelonia/kv/update` itself do **not** flip `status` (per §4.2) —
`'error'` is reserved for load/validation problems where the *mirror*
is potentially stale.

**Self-echo suppression.** When `chelonia/kv/update` succeeds, the
server broadcasts the same value back over pubsub. The pubsub `KV`
frame carries `{ channelID, key, data, cid }`
(`createKvMessage` in `src/pubsub/index.ts:425-429`), where `cid` is
the **server-issued data CID** — the very same identifier returned in
the `x-cid` / `etag` HTTP header of the `kv/set` response. Because the
write response and the pubsub echo now share one stable server
identifier, self-echo suppression keys directly on that CID: no
client-generated nonce and no envelope wrapper are required, and the
value is written to the wire raw (exactly as `data` is handled today).

1. `chelonia/kv/update` hands the validated user value straight to
   `outputEncryptedOrUnencryptedMessage` as `data` — no wrapper, no
   injected fields. It gets signed and (if applicable) encrypted as
   one opaque payload, identical to how `data` is treated today
   (`src/chelonia.ts:2778-2810`). On the receive side,
   `_handleRemote` calls `parseEncryptedOrUnencryptedMessage` as
   usual and passes `parsed.data` directly through `schema.parse` /
   mirror / event / `onUpdate`. The wire-level clear sentinel `null`
   is detected on the value itself, and `chelonia/kv/clear` writes
   plain JSON `null`.
2. On a successful write, the data CID returned in the `kv/set`
   response (`x-cid` / `etag` header) is recorded in a **time-decaying
   map** `kvLocalEchoCIDs` keyed by `${contractID}::${key}`. Each entry
   maps the CID to `{ expiry, fromConflict }`, where `expiry` is
   `now() + KV_ECHO_TTL_MS` (default **5 minutes**) and
   `fromConflict` marks whether the write succeeded after a 409 / 412
   conflict retry. The clock `now()` is `performance.now()` (monotonic),
   chosen over `Date.now()` so that a wall-clock/NTP step cannot
   prematurely expire a pending echo; the tradeoff is that a throttled
   background tab may advance it slowly and extend the effective TTL,
   which only makes suppression more conservative. The same CID is
   stored as the mirror `etag`.
   A fixed-size FIFO was rejected: it silently drops suppression for
   the oldest write once N concurrent writes pile up against one slot,
   so a slow echo for an evicted CID resurfaces as a spurious
   `reason: 'remote'` event. Keying on wall-clock expiry instead means
   suppression survives for as long as an echo could *plausibly* still
   be in flight, independent of how many other writes happened in the
   meantime.
3. On every incoming `NOTIFICATION_TYPE.KV` frame the dispatcher reads
   the frame's `cid` field and, if it matches a *non-expired* entry,
   drops the frame silently (no event, no `onUpdate`, no mirror write)
   and **immediately deletes the entry** — once an echo is seen, its
   CID can never legitimately recur, so the entry is evicted early
   rather than waiting for its TTL. An entry whose expiry has passed is
   treated as absent (and lazily purged on access — see step 6).
4. Concurrent writes from another tab/client carry a *different* data
   CID (the server assigns a new CID per write), so remote writes are
   never misclassified as local. When a non-self frame arrives while a
   conflict-resolved write's echo CID is still pending for the same
   `(contractID, key)`, the frame's ordering relative to the local HTTP
   conflict response is unknown (§3.3). Instead of applying the frame as
   last-write-wins, `_handleRemote` performs an authoritative
   `chelonia/kv/get` / `_loadSlotNow(reason: 'remote')` and mirrors the
   server's latest value. A frame whose `cid` is absent (produced by a
   non-Chelonia writer or an older server) never matches. If it carries
   a value for a slot that already holds an etag, applying it inline
   would pair the new value with the *stale* etag (we have no server CID
   for it), breaking the "value and etag move together" invariant and
   guaranteeing a `412` on the next local write — so `_handleRemote`
   performs the same authoritative `chelonia/kv/get` to re-pair value
   and etag, then fires with `reason: 'remote'`. A no-`cid` frame on a
   never-loaded slot (etag `null`) has no stale etag to clobber, so it
   applies inline with a `null` etag and fires normally with
   `reason: 'remote'`.
   A CID can only ever match the
   originating client's own pending entry, so even a CID that survives
   to expiry (its echo was dropped or lost) can never collide with a
   future server-issued CID.
5. The map is cleared on websocket reconnect (per §11.4): any pending
   echo from a pre-disconnect write has either been delivered or is
   lost.
6. **Bounding.** Expiry-based eviction keeps the map naturally small —
   entries self-delete once seen (step 3) or once their TTL lapses.
   Expired entries are purged lazily on every record/lookup (a cheap
   scan of the affected `(contractID, key)` bucket), and empty buckets
   are removed. As a hard backstop against a pathological burst of
   writes whose echoes never arrive within the TTL, each bucket is
   capped at `KV_ECHO_CID_MAX` (default **128**, well above the old
   FIFO's 8); on overflow non-conflict entries are evicted before
   `fromConflict` markers (dropping a conflict marker would let a
   competing frame regress the mirror via last-write-wins), and within
   each class the *earliest* expiry is evicted first — but the
   just-recorded CID is **never** evicted, so the current write can
   always be self-echo-suppressed even when the bucket is already full
   of conflict markers. Reaching the cap is not expected in normal
   operation — it exists only so a misbehaving server or an offline
   spell cannot grow the map without bound.

> Implementation note: an earlier version of this design used a
> client-generated `__chelKvNonce` injected into a wrapper object
> (`{ __chelKvNonce, value }`) because the pubsub frame carried only
> `{ channelID, key, data }` with no server identifier on the wire.
> `createKvMessage` now includes the server data `cid` in the frame,
> so the authoritative server identifier *does* reach the websocket
> path. Suppression keys on it directly, eliminating the wrapper, the
> reserved `{ __chelKvNonce, value }` top-level shape, the
> registration-time guard against that shape, and the nonce-stripping
> step on the receive path.

Existing low-level pubsub plumbing (`NOTIFICATION_TYPE.KV` dispatch in
`src/chelonia.ts:1089`) keeps firing for anyone using the raw API —
it just additionally feeds the slot machinery.

---

## 5. State shape

A new top-level branch in Chelonia's root state:

```ts
rootState._kv = {
  [contractID: string]: {
    [key: string]: {
      value: JSONType | undefined,  // last known good value; undefined until status !== 'non-init'
      etag: string | null,    // last server etag (x-cid / etag header)
      status: 'non-init' | 'loading' | 'loaded' | 'error',
      lastError?: { name: string; message: string }
    }
  }
}
```

Slot definitions themselves are not persisted — they're code, and live
in an in-memory registry on the Chelonia context. This means:

- The mirror is persisted alongside the rest of `rootState` by typical
  persistence layers (matching today's behaviour for
  `state.contracts[...]`).
- Slot definitions are re-registered at boot. The `autoLoad: 'on-sync'`
  pass refreshes any stale persisted values.

Like `_journal`, this subtree is "in-band" with the rest of Chelonia's
bookkeeping; once `chelonia/externalStateSetup` is extended to project
`rootState._kv` (see §9 and §11.4), consumers that mirror
`rootState.contracts` to Vuex will also pick up `rootState._kv` — that
is the whole point.

**Multi-tab / service-worker coordination.** `rootState._kv` lives next
to `rootState.contracts`, so every mechanism that already keeps the
contracts subtree in sync across tabs and the service worker applies
here without new wiring:

- Whatever persistence layer the host app uses (IndexedDB,
  `localStorage`, etc.) snapshots `rootState._kv` for free when it
  snapshots `rootState`. Group Income's `CHELONIA_STATE_MODIFIED`
  emission fires after every successful mirror write — local update,
  remote pubsub update, initial load, or reconnect re-fetch — exactly
  as it does today for `rootState.contracts`.
- If the host app already has a cross-tab forwarder for contract
  events, it should also forward `CHELONIA_KV_UPDATED` so a write in
  tab A reaches tab B's mirror through the same channel.
- In a service-worker setup, the worker owns the authoritative
  `rootState._kv` (it is the one with the pubsub socket); tabs see the
  mirror through whatever existing snapshot-and-commit mechanism
  already projects `rootState.contracts` into their Vuex / Pinia
  store. No per-key plumbing is required.

In short: anything that worked for the contracts subtree works for
the KV mirror, and the design deliberately does **not** introduce a
parallel cross-tab protocol.

Values under `_kv` are expected to be JSON-shaped (plain objects,
arrays, numbers, strings, booleans). `null` is reserved as the
wire-level clear sentinel (§4.5), `undefined` is reserved for unloaded
mirror state, and neither may appear anywhere in a stored value.
Non-JSON instances (`Date`, `Map`, `Set`, class instances,
functions) are out of scope and must not be stored in slots. This
restriction extends to the **output** of `schema` — a Zod
`.transform()` that produces a `Date` or `Map` is unsafe even if the
parsed input is plain JSON, because the resulting value is what
lands in the mirror and gets cloned/diffed/serialised. If you need
richer types in user code, materialise them at read time (e.g. in
`onUpdate` or in a derived selector) rather than inside the schema's
transform output. Schemaless slots are still protected by the same
structural JSON-shape guard before mirror writes and before
`chelonia/kv/set`; use an explicit schema for domain-specific checks.

### 5.1 Size and persistence considerations

Unlike `state.contracts[...]`, which grows roughly with the number of
processed events, `rootState._kv` grows with whatever the consumer
chooses to store. There is no automatic compaction. Two practical
rules:

- **Cap unbounded collections in the slot's schema.** Notifications,
  unread message lists, and similar growing structures should declare
  pruning rules via `schema.transform` — `applyStorageRules` (§6) is
  the canonical example. The transform runs on every write and on
  every load, so stale entries cannot accumulate even if a buggy
  client wrote them in the past.
- **Treat `rootState._kv` as persisted state.** Anything stored here
  is snapshot-serialised by the host app's persistence layer
  (IndexedDB, `localStorage`, etc.) on every successful mirror write.
  Large blobs (multi-megabyte caches, image data) belong in
  `chelonia/files`, not in a KV slot.

---

## 6. Validation

`schema` may be any object exposing a `parse(value): T` method that
either returns the (possibly coerced) value or throws. This shape is a
deliberate subset of Zod / Valibot / Yup so consumers can pick their
favourite without `@chelonia/lib` taking a hard dependency:

```ts
defineSlot({
  contractType: 'gi.contracts/identity',
  key: 'preferences',
  defaultValue: {},
  schema: z.object({
    hideDistributionBanner: z.record(z.string(), z.boolean()).optional()
  }).passthrough()
})
```

Validation runs:

- on `defaultValue` at registration time (catches typos at boot)
- on every successful `chelonia/kv/get` (fail → status `'error'`,
  `CHELONIA_KV_VALIDATION_ERROR` event, mirror keeps previous value)
- on every incoming pubsub notification (same)
- on every `chelonia/kv/update` reducer result *before* network
  (caller's promise rejects with `ChelErrorKvValidation` — write
  never happens)

Failures never throw out of the pubsub dispatch path — they downgrade
to the event so a bad remote value can't crash the app.

**Normalization belongs in `schema`.** Today's `applyStorageRules`
function in `identity-kv.js` (prune-expired notifications) is invoked
separately on the initial `data` payload *and* inside the `onconflict`
wrapper. Under the new API, model it as a Zod `.transform`:

```ts
const NotificationsSchema = z.record(z.string(), NotificationEntry)
  .transform(applyStorageRules)        // prune expired entries
```

Because `schema.parse` runs *after* the reducer and *before* the
network write, the transform applies once on the merged value, both
on the first attempt and on every conflict-retry attempt. There's no
longer a need for `applyStorageRules` to be re-applied at two
different layers.

### 6.1 What schema validation does *not* solve

The issue body raises this explicitly and the design must be honest
about it: schema validation enforces *well-formedness* (the JSON
matches a declared shape). It does **not** enforce *authorization*
— it cannot tell a legitimate "add user X as admin" from a malicious
one, because both write the same shape. With on-chain ops, other
clients reject unauthorized actions and the bad event is dropped from
the local state; with the KV store, the server keeps whatever was
last written.

The slot definition does not attempt to fix this — there is no
`canWrite` predicate, because a slot lives client-side and a malicious
client simply bypasses it. The right tools are:

1. **Restricted signing keys.** Use a signing key whose `permissions`
   on the contract prohibit it from signing meaningful state changes;
   the server enforces the signature/permission check. Sensitive KV
   keys should be signed by a key with a `permissions` list that
   excludes operations that would let an attacker grant themselves
   authority (`OP_KEY_ADD`, `OP_KEY_UPDATE`).
2. **Server-side write rules.** For genuinely security-sensitive
   keys (the permissions-table example from the issue body), do not
   use the KV store — keep them on-chain where other clients can
   reject unauthorized writes.
3. **Voting / multi-write** for cases that must live in KV. Out of
   scope for v1; see §12.

The slot's `schema` is the *upper bound* on what the library can
defend against. Anything beyond that is the consumer's protocol
design problem, and the design doc should not paper over it.

---

## 7. Worked examples (Group Income)

### 7.1 Today

```js
// identity-kv.js (excerpt — actually 200+ lines total)
const updateKVPreferences = (updater) => {
  return sbp('okTurtles.eventQueue/queueEvent', KV_QUEUE, async () => {
    const getUpdated = ({ etag, currentData = {} } = {}) => [updater(currentData), etag]
    const data = getUpdated()[0]
    await sbp('gi.actions/identity/kv/savePreferences', { data, onconflict: getUpdated })
  })
}

// setupChelonia.js
[NOTIFICATION_TYPE.KV] ([key, value]) {
  sbp('okTurtles.events/emit', KV_EVENT, { contractID, key, data: value.data })
}
sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (_, { added }) => {
  added.forEach((cID) => {
    if (rootState.contracts[cID]?.type === 'gi.contracts/identity') {
      sbp('chelonia/kv/setFilter', cID, [KV_KEYS.UNREAD_MESSAGES, KV_KEYS.PREFERENCES, KV_KEYS.NOTIFICATIONS])
    }
  })
})

// main.js, sw-primary.js, identity.js — three more places to wire each key
```

### 7.2 With the new API

Note: every identity-scoped slot below uses the `onOwnIdentity` match
predicate, mirroring the existing `setFilter` gating in
`setupChelonia.js`. Without it, the slots would attach to *every*
identity contract the logged-in user has synced (group members'
identities, mentions, etc.), which would over-fetch and 404.

```ts
const onOwnIdentity = (cID, _state, rootState) =>
  cID === rootState.loggedIn?.identityContractID
```

One file, one declaration, one updater per call site:

```js
// kv-slots.js
import { z } from 'zod'

sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'preferences',
  defaultValue: {},
  match: onOwnIdentity,
  schema: z.object({
    hideDistributionBanner: z.record(z.string(), z.boolean()).optional()
  }).passthrough(),
  // `preferences` is a single-shape slot (shallow-merge patches), so
  // every write site can use the `value` form below instead of an
  // explicit reducer. See §4.1 (`defaultUpdater`).
  defaultUpdater: (patch) => (prev) => ({ ...prev, ...patch })
})

// Call site — preferred form for single-shape slots:
sbp('chelonia/kv/update', {
  contractID: identityContractID,
  key: 'preferences',
  value: { theme: 'dark' }
})

sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'unreadMessages',
  defaultValue: {},
  match: onOwnIdentity,
  schema: UnreadMessagesSchema
})

sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/group',
  key: 'lastLoggedIn',
  defaultValue: {}
  // No match: every group contract gets the slot. The throttle lives
  // in the reducer; see §3.3.
})

sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'notifications',
  defaultValue: {},
  match: onOwnIdentity,
  // The TTL filter that today lives in saveNotificationStatus
  schema: NotificationsSchema.transform(applyStorageRules)
})

// NS_CACHE is special-cased: not in pubsub filter (autoSubscribe:false)
// and re-derived from local state via a debounced trigger. The slot
// still gives us a typed read/write surface and a single onUpdate hook
// that replaces the sw-primary `KV_KEYS.NS_CACHE` branch.
sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'namespace-cache',
  defaultValue: [],
  match: onOwnIdentity,
  autoSubscribe: false,
  autoLoad: 'on-demand',
  onUpdate: async (value, ctx) => {
    if (ctx.reason === 'load' || ctx.reason === 'reconnect') {
      await checkAndAugmentNames(value)
    }
  }
})

// Login transition: the match predicates above depend on rootState.loggedIn,
// which Chelonia cannot observe directly. Call refreshFilters once after login.
sbp('okTurtles.events/on', LOGIN_COMPLETE, () => {
  sbp('chelonia/kv/refreshFilters')
})

// Throttled write (replaces LAST_LOGGED_IN_THROTTLE_WINDOW logic in group-kv.js).
// `now` is captured ONCE outside the reducer so that conflict-retry
// invocations produce identical output (see §3.3 wall-clock warning).
const now = new Date().toISOString()
const nowMs = Date.parse(now)
sbp('chelonia/kv/update', {
  contractID: groupContractID,
  key: 'lastLoggedIn',
  updater: (prev) => {
    const last = prev[identityContractID] && new Date(prev[identityContractID]).getTime()
    if (last && (nowMs - last) < 30 * 60_000) return KV_NOOP
    return { ...prev, [identityContractID]: now }
  }
})
```

The eight `getUpdatedUnreadMessages` variants collapse to plain
updaters:

```js
// Was: 25 lines of currentData/etag plumbing, called via savePreferences + onconflict
sbp('chelonia/kv/update', {
  contractID, key: 'unreadMessages',
  updater: (prev) => {
    if (prev[contractID]?.readUntil.createdHeight >= createdHeight) return KV_NOOP
    const unreadMessages = prev[contractID]?.unreadMessages.filter(
      m => m.createdHeight > createdHeight) ?? []
    return { ...prev, [contractID]: { readUntil: { messageHash, createdHeight }, unreadMessages } }
  }
})
```

And the Vuex side becomes a single, generic listener:

```js
sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, ({ contractID, key, value }) => {
  // optional: only if you want a Vuex mirror; the rootState._kv mirror is already there.
})
```

…or, for projects that already mirror `rootState` into Vuex via
`chelonia/externalStateSetup`, **zero new wiring** — the mirror just
appears under `state._kv`.

The new `chatRoomScrollPosition` / `chatNotificationSettings` /
`deviceSettings` keys mentioned in #2903 each cost exactly one
`defineSlot` call.

---

## 8. Deep-dive: `unreadMessages` end-to-end

This section walks through one real Group Income KV key —
`KV_KEYS.UNREAD_MESSAGES` on the identity contract — to show every
file the new API removes from the consumer's surface. The data shape
stored at the key is:

```ts
{
  [chatRoomID]: {
    readUntil:       { messageHash, createdHeight, isManuallyMarked?: boolean },
    unreadMessages:  Array<{ messageHash, createdHeight }>
  }
}
```

### 8.1 What Group Income has to maintain today

Across the repo, `unreadMessages` is wired through **at least eight
files**. Each row is one piece of plumbing the consumer must keep in
sync with the others:

| File | Role | Approx. size |
|---|---|---|
| `frontend/utils/constants.js` | `KV_KEYS.UNREAD_MESSAGES = 'unreadMessages'` | 1 line |
| `frontend/utils/events.js` | `NEW_UNREAD_MESSAGES = 'new-unread-messages'` | 1 line |
| `frontend/controller/actions/identity-kv.js` | `fetchChatRoomUnreadMessages` selector | ~10 lines |
| `frontend/controller/actions/identity-kv.js` | `saveChatRoomUnreadMessages` selector (queuedSet wrapper) | ~17 lines |
| `frontend/controller/actions/identity-kv.js` | `loadChatRoomUnreadMessages` selector (fetch + emit `NEW_UNREAD_MESSAGES`) | ~6 lines |
| `frontend/controller/actions/identity-kv.js` | `initChatRoomUnreadMessages` selector + its reducer | ~20 lines |
| `frontend/controller/actions/identity-kv.js` | `setChatRoomReadUntil` selector + its reducer | ~55 lines |
| `frontend/controller/actions/identity-kv.js` | `addChatRoomUnreadMessage` selector + its reducer | ~18 lines |
| `frontend/controller/actions/identity-kv.js` | `removeChatRoomUnreadMessage` selector + its reducer | ~17 lines |
| `frontend/controller/actions/identity-kv.js` | `deleteChatRoomUnreadMessages` selector + its reducer | ~13 lines |
| `frontend/setupChelonia.js` | `UNREAD_MESSAGES` added to `chelonia/kv/setFilter` for `'gi.contracts/identity'` | 1 array entry |
| `frontend/setupChelonia.js` | generic `NOTIFICATION_TYPE.KV → KV_EVENT` translator (shared, but every key relies on it) | — |
| `frontend/setupChelonia.js` | `allowedSelectors` whitelist for the SW: lists each of the five high-level UNREAD selectors | 5 entries |
| `frontend/main.js` | `KV_EVENT` switch: `case KV_KEYS.UNREAD_MESSAGES → commit 'setUnreadMessages'` | ~3 lines |
| `frontend/controller/serviceworkers/sw-primary.js` | `KV_EVENT` switch: `case KV_KEYS.UNREAD_MESSAGES → rootState.chatroom.unreadMessages = data` | ~3 lines |
| `frontend/controller/serviceworkers/sw-primary.js` | separate `NEW_UNREAD_MESSAGES` listener for the initial-load path (mirrors KV_EVENT branch) | ~4 lines |
| `frontend/controller/serviceworkers/sw-primary.js` | `NEW_UNREAD_MESSAGES` in the cross-tab event forwarder array | 1 entry |
| `frontend/controller/app/identity.js` | `NEW_UNREAD_MESSAGES` listener → `commit 'setUnreadMessages'` (initial-load Vuex commit) | ~3 lines |

Three of the reducers — the ones that actually matter — look like this
(quoted minimally to anchor the comparison):

```js
// setChatRoomReadUntil — header + the call out to saveChatRoomUnreadMessages
'gi.actions/identity/kv/setChatRoomReadUntil': ({ contractID, messageHash, createdHeight, forceUpdate = false }) => {
  return sbp('okTurtles.eventQueue/queueEvent', KV_QUEUE, async () => {
    // … getUpdatedUnreadMessages reducer (~40 lines) …
    await sbp('gi.actions/identity/kv/saveChatRoomUnreadMessages', { onconflict: getUpdatedUnreadMessages })
  })
}
```

```js
// addChatRoomUnreadMessage — the boilerplate this design targets
const getUpdatedUnreadMessages = ({ currentData = {}, etag } = {}) => {
  if (currentData[contractID]?.readUntil.createdHeight < createdHeight) {
    const index = currentData[contractID].unreadMessages.findIndex(msg => msg.messageHash === messageHash)
    if (index === -1) {
      currentData[contractID].unreadMessages.push({ messageHash, createdHeight })
      return [currentData, etag]
    }
  }
  return null
}
```

```js
// main.js — half of the receive-side mirror
case KV_KEYS.UNREAD_MESSAGES:
  sbp('state/vuex/commit', 'setUnreadMessages', data)
  break
```

Every reducer in `identity-kv.js` repeats the same shape:
`({ currentData = {}, etag } = {}) => [next, etag] | null`. The
`etag` is threaded straight through, untouched. The receive side is
mirrored in three places: `main.js` (tab Vuex), `sw-primary.js`
(service-worker rootState), and `identity.js` (initial-load Vuex).
The `setFilter` array in `setupChelonia.js` must list every key by
hand, separately from the reducers.

Call sites that drive all of this:

- `frontend/model/notifications/messageReceivePostEffect.js` — calls
  `addChatRoomUnreadMessage` when a chat message arrives that should
  be unread.
- `contracts/chatroom*.js` — `deleteMessage` sideEffect calls
  `removeChatRoomUnreadMessage`; `postLeaveChatRoomCleanup` calls
  `deleteChatRoomUnreadMessages`.
- Chatroom Vue components — call `setChatRoomReadUntil` on scroll and
  on "mark all read".

So a single conceptual key — *"per-chatroom unread cursor + list"* —
is implemented as **5 selectors + 1 queue + 1 event constant + 1
filter entry + 3 receive-side branches + 5 allow-list entries**, all
of which must agree on the same key name and the same data shape, and
none of which validate that shape.

### 8.2 What the same key looks like under the new API

One declaration, in one file, and the existing call sites change from
multi-selector wrappers to a single `chelonia/kv/update` invocation
with a pure reducer.

**Declaration (typically lives next to the contract definition):**

```js
import { z } from 'zod'

const UnreadCursor = z.object({
  messageHash: z.string(),
  createdHeight: z.number().int().nonnegative(),
  isManuallyMarked: z.boolean().optional()
})

const UnreadMessagesSchema = z.record(
  z.string(), // chatRoomID
  z.object({
    readUntil: UnreadCursor,
    unreadMessages: z.array(z.object({
      messageHash: z.string(),
      createdHeight: z.number().int().nonnegative()
    }))
  })
)

sbp('chelonia/kv/defineSlot', {
  contractType: 'gi.contracts/identity',
  key: 'unreadMessages',
  defaultValue: {},
  schema: UnreadMessagesSchema
  // autoSubscribe: true (default) → setFilter handled for us
  // autoLoad: 'on-sync'  (default) → first load fires CHELONIA_KV_UPDATED
})
```

**Call sites — one `chelonia/kv/update` per intent, pure reducers:**

```js
// was: gi.actions/identity/kv/setChatRoomReadUntil (~55 lines)
sbp('chelonia/kv/update', {
  contractID: identityContractID,
  key: 'unreadMessages',
  updater: (prev) => {
    const entry = prev[chatRoomID]
    if (!forceUpdate && entry && entry.readUntil.createdHeight >= createdHeight) return KV_NOOP
    return {
      ...prev,
      [chatRoomID]: {
        readUntil: {
          messageHash,
          createdHeight,
          ...(entry?.readUntil?.isManuallyMarked !== undefined
            ? { isManuallyMarked: entry.readUntil.isManuallyMarked }
            : {})
        },
        unreadMessages: (entry?.unreadMessages ?? []).filter(m => m.createdHeight > createdHeight)
      }
    }
  }
})
```

```js
// was: gi.actions/identity/kv/addChatRoomUnreadMessage (~18 lines + reducer)
sbp('chelonia/kv/update', {
  contractID: identityContractID,
  key: 'unreadMessages',
  updater: (prev) => {
    const entry = prev[chatRoomID]
    if (!entry || entry.readUntil.createdHeight >= createdHeight) return KV_NOOP
    if (entry.unreadMessages.some(m => m.messageHash === messageHash)) return KV_NOOP
    return {
      ...prev,
      [chatRoomID]: { ...entry, unreadMessages: [...entry.unreadMessages, { messageHash, createdHeight }] }
    }
  }
})
```

```js
// was: gi.actions/identity/kv/removeChatRoomUnreadMessage
sbp('chelonia/kv/update', {
  contractID: identityContractID,
  key: 'unreadMessages',
  updater: (prev) => {
    const entry = prev[chatRoomID]
    if (!entry?.unreadMessages.some(m => m.messageHash === messageHash)) return KV_NOOP
    return {
      ...prev,
      [chatRoomID]: { ...entry, unreadMessages: entry.unreadMessages.filter(m => m.messageHash !== messageHash) }
    }
  }
})
```

```js
// was: gi.actions/identity/kv/deleteChatRoomUnreadMessages
sbp('chelonia/kv/update', {
  contractID: identityContractID,
  key: 'unreadMessages',
  updater: (prev) => {
    if (!(chatRoomID in prev)) return KV_NOOP
    const { [chatRoomID]: _gone, ...rest } = prev
    return rest
  }
})
```

**Reads — synchronous, from the auto-managed mirror:**

```js
// was: NEW_UNREAD_MESSAGES + KV_EVENT + Vuex commit + sw-primary branch
const unread = sbp('chelonia/kv/read', identityContractID, 'unreadMessages')
```

…or, for consumers that observe state changes via Vuex / Pinia /
`chelonia/externalStateSetup`, simply bind to `rootState._kv[id].unreadMessages.value`.
Nothing else to wire — initial load, pubsub updates, and successful
local writes all converge on the same mirror entry and fire one
`CHELONIA_KV_UPDATED` event.

### 8.3 Side-by-side accounting

| Surface | Today | With the new API |
|---|---|---|
| Files touched to add the key | 8 (constants, events, identity-kv, setupChelonia, main, sw-primary, identity, contracts allow-list) | 1 (slot declaration file) |
| KV-related selectors registered | 5 high-level + 3 plumbing (`fetch/save/load`) = **8** | **0** (consumers call the generic `chelonia/kv/update`) |
| Event constants introduced | `NEW_UNREAD_MESSAGES` + reliance on global `KV_EVENT`, `NEW_KV_LOAD_STATUS` | none; one generic `CHELONIA_KV_UPDATED` for all keys |
| `setFilter` maintenance | manual entry in the `CONTRACTS_MODIFIED` switch | automatic from registered slots |
| Receive-side mirror code | 3 branches (`main.js`, `sw-primary.js` ×2, `identity.js`) | 0 — `rootState._kv` is the mirror |
| Boilerplate per reducer | `({ currentData = {}, etag } = {}) => [next, etag] \| null` wrapping every merge | `(prev) => next \| KV_NOOP` — pure function |
| Schema validation | none (data shape trusted on read **and** on write) | `UnreadMessagesSchema.parse` on every load, remote update, and write |
| Lines of code for the key | ~155 in identity-kv.js + ~25 across receive sites ≈ **180** | **~25** for the schema + slot, plus the existing call sites slim to 5–10 lines each |

The functional behaviour is preserved: the per-contract event queue
still serializes writes (provided by the library, no longer by
`okTurtles.eventQueue/queueEvent` in user code), conflict retries
still happen via `if-match` / `409` / `412`, and the pubsub
notification still drives remote-update events. The consumer simply
stops seeing any of it.

### 8.4 Validation as a real safety net (vs. trust-by-default)

Today, if a buggy client (or a malicious one writing through the
delegator-access path described in the issue thread) pushes
`unreadMessages = "lol"` to the KV store, every other client
happily writes `"lol"` straight into `rootState.chatroom.unreadMessages`
and downstream code crashes the first time it does
`unread[chatRoomID]?.readUntil`.

Under the new API, `UnreadMessagesSchema.parse` runs on the incoming
pubsub notification, the parse throws, the mirror keeps the previous
valid value, and a `CHELONIA_KV_VALIDATION_ERROR` event fires with
the Zod issue. The local app never sees the bad shape. This is
"well-formedness" validation in the sense of §1 of the issue thread
— it is necessary but not sufficient, see §6.1 above for the
authorization side.

---

## 9. Mirroring into existing UI state (Vuex / Pinia / Redux)

The library writes to `rootState._kv[contractID][key].value`. Group
Income's UI currently reads from purpose-built slices: `state.preferences`,
`state.notifications.status`, `state.chatroom.unreadMessages`,
`state.lastLoggedIn[contractID]`. Two migration shapes are supported:

**(a) Read directly from `rootState._kv`** — preferred for new code
and for slices that don't exist yet (`chatRoomScrollPosition`,
`chatNotificationSettings`, `deviceSettings`). Vue components read
from the existing Vuex mirror that already syncs `rootState.contracts`
via `chelonia/externalStateSetup`. **Note:** today
`chelonia/externalStateSetup` only mirrors `rootState.contracts` and
the per-contract state slices (see `src/local-selectors/index.ts`).
Shipping `rootState._kv` through the same channel requires a small
extension to `externalStateSetup` (mirror `rootState._kv[contractID]`
alongside `cheloniaState`/`contractState` in the `EVENT_HANDLED` and
`CONTRACTS_MODIFIED` handlers, and project it into the external store
the same way). This is part of v1 implementation work (§11.4) — it
isn't "free" today but it is a few lines once and then truly free for
every future slot.

**(b) Map onto existing slices** — for the four legacy keys that
the codebase already exposes under purpose-built names. Provide a
single generic listener that replaces the per-key switches in
`main.js` and `sw-primary.js`:

```ts
const KV_VUEX_MIRROR = {
  'gi.contracts/identity::preferences':      ({ value }) => sbp('state/vuex/commit', 'setPreferences', value),
  'gi.contracts/identity::unreadMessages':   ({ value }) => sbp('state/vuex/commit', 'setUnreadMessages', value),
  'gi.contracts/identity::notifications':    ({ value }) => sbp('state/vuex/commit', 'setNotificationStatus', value),
  'gi.contracts/group::lastLoggedIn':        ({ contractID, value }) => sbp('state/vuex/commit', 'setLastLoggedIn', [contractID, value])
}
sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, (e) => {
  const fn = KV_VUEX_MIRROR[`${e.contractType}::${e.key}`]
  if (fn) fn(e)
})
```

This collapses both the `main.js` switch *and* the `sw-primary.js`
switch into one declarative table. The `initial-load` /
`NEW_UNREAD_MESSAGES` / `NEW_PREFERENCES` events disappear entirely
because `CHELONIA_KV_UPDATED` fires with `reason: 'load'` on the
initial fetch — there is no longer a separate codepath.

The sw-primary `CHELONIA_STATE_MODIFIED` emit (triggering persistence)
is fired by the library itself after every successful mirror write, so
consumers don't have to.

---

## 10. Migration

Backwards compatibility is total: nothing in §1.1 changes. The new
API is layered on top.

Recommended migration path for a consumer:

1. Move `KV_KEYS.*` registrations to `chelonia/kv/defineSlot` calls.
   Schemas optional but encouraged.
2. Replace every `gi.actions/identity/kv/save*` selector that wraps
   `queuedSet` with a `chelonia/kv/update` call site.
3. Delete the per-key `NEW_*` events and the `KV_EVENT` translator.
   Read from `rootState._kv[contractID][key].value` (or subscribe to
   `CHELONIA_KV_UPDATED`).
4. Delete the manual `setFilter` switch in `CONTRACTS_MODIFIED` —
   the library now derives it from registered slots.
5. Keep using `chelonia/kv/set` / `chelonia/kv/queuedSet` directly for
   any key whose merge policy genuinely cannot be expressed as a
   side-effect-free `(prev) => next` reducer — e.g. keys whose
   server-side write rules diverge from the standard etag-conflict
   protocol, or keys where the consumer wants to bypass the slot
   registry / mirror entirely for a one-off ad-hoc write. Do not mix
   direct `chelonia/kv/setFilter` calls with declared slots on the
   same contract: registering any slot transfers pubsub filter ownership
   for that contract to the slot layer, and an `autoSubscribe:false`-only
   slot set intentionally emits `setFilter(cID, [])`. (Binary blobs are
   **not** an example: KV values must be JSON-shaped per §5, and the
   raw `chelonia/kv/*` selectors share that constraint — use
   `chelonia/files` for binary content regardless of which KV API you
   use.) The namespace cache is *not* one of these: its asynchronous
   `checkAndAugmentNames` work lives in `onUpdate` (read-side side
   effect), and its writes are still expressible as a reducer over
   `prev`.

---

## 11. Implementation plan

This is a sequencing guide; each step is independently shippable and
testable. Existing tests stay green throughout because the new API
is additive.

### 11.1 Module structure

Create `src/kv.ts` (new file). Re-export from `src/index.ts`. The
selectors live alongside the existing `chelonia/kv/*` namespace; the
file imports `chelonia/kv/queuedSet`, `chelonia/kv/setFilter`, and
`chelonia/kv/get` from `chelonia-utils.ts` / `chelonia.ts` and wires
the rest. The low-level selectors were extended (not rewritten) to
support the slot layer: `chelonia/kv/set` now returns `{ etag }`,
accepts a caller `signal`, an `onconflict` callback, and `maxAttempts`;
`chelonia/kv/get` attaches `etag` (lazily, without forcing the `data`
accessor); `chelonia/kv/queuedSet` forwards `signal` and returns
`{ etag }`. `chelonia/kv/setFilter` is unchanged. These additions are
backward-compatible: existing callers that ignore the return value and
omit the new options behave as before.

Add public types to `src/types.ts` (and re-export from `src/index.ts`):
`KvUpdater<T>`, `KvUpdateCtx`, `KvLoadStatus`, and `KvSlotDefinition`
(public subset of the internal `SlotDefinition`).

Add the new error classes to `src/errors.ts`:

```ts
export const ChelErrorKvSlotUnknown = ChelErrorGenerator('ChelErrorKvSlotUnknown')
export const ChelErrorKvSlotInvalid = ChelErrorGenerator('ChelErrorKvSlotInvalid')
export const ChelErrorKvUpdateInvalid = ChelErrorGenerator('ChelErrorKvUpdateInvalid')
export const ChelErrorKvValidation = ChelErrorGenerator('ChelErrorKvValidation')
export const ChelErrorKvConflict = ChelErrorGenerator('ChelErrorKvConflict')
```

Add the new event names to `src/events.ts`:

```ts
export const CHELONIA_KV_UPDATED = 'chelonia-kv-updated'
export const CHELONIA_KV_STATUS_CHANGED = 'chelonia-kv-status-changed'
export const CHELONIA_KV_VALIDATION_ERROR = 'chelonia-kv-validation-error'
```

Export `KV_NOOP` from `src/kv.ts` and re-export from `src/index.ts`:

```ts
export const KV_NOOP = Symbol.for('@chelonia/lib/KV_NOOP')
```

> `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the
> sentinel survives realm boundaries (iframes, workers, dual
> ESM/CJS loads). The string key is namespaced (`@chelonia/lib/KV_NOOP`)
> to make a userland collision implausible.

### 11.2 Internal data structures

On the Chelonia context (see how `journal.ts` attaches `_journal`):

```ts
type SlotDefinition = {
  contractType: string
  key: string
  defaultValue: JSONType | (() => JSONType)
  resolvedDefault: JSONType  // factory result, computed once at registration
  schema?: { parse(value: unknown): JSONType }
  match?: (cID: string, contractState: object, rootState: object) => boolean
  // contractState = rootState[cID] (ChelContractState, including _vm)
  encryptionKeyName: string | null  // resolved with default 'cek'; null disables encryption
  signingKeyName: string            // resolved with default 'csk'
  autoSubscribe: boolean     // resolved with default true
  autoLoad: 'on-sync' | 'on-demand' | 'never'
  refreshOnReconnect: boolean
  onUpdate?: (value: JSONType, ctx: KvUpdateCtx) => void | Promise<void>
}

// Primary registry, keyed by `${contractType}::${key}`. The authoritative
// store of slot definitions.
this.kvSlots = new Map<string, SlotDefinition>()

// Secondary index for O(1) pubsub dispatch: contractID → (key → SlotDefinition).
// Populated lazily by `_reconcileForSlot` whenever a contract's match
// predicate flips to true; entries are removed when match flips back to
// false or the contract is unsubscribed. Without this index every
// NOTIFICATION_TYPE.KV frame would have to scan `kvSlots` and re-evaluate
// every slot's match predicate, which is O(slots) per frame.
this.kvSlotsByContractID = new Map<string, Map<string, SlotDefinition>>()

// Per-(contractID) effective filter cache, used to coalesce setFilter.
this.kvActiveFilters = new Map<string, Set<string>>()  // contractID → Set<key>

// Microtask flush set for setFilter coalescing (see §11.5).
this.kvFilterDirty = new Set<string>()

// Time-decaying map of server-issued data CIDs from our own successful
// writes, used to drop the server's pubsub echo of our own update (see
// §4.9). Keyed by `${contractID}::${key}`; each bucket maps a CID to
// the timestamp at which the suppression entry expires
// (`performance.now() + KV_ECHO_TTL_MS`, default 5 min; monotonic clock
// so a wall-clock step can't prematurely expire it). An entry is
// deleted the moment its echo is observed, lazily purged once expired,
// and — as a hard backstop only — evicted earliest-expiry-first if a
// bucket ever exceeds KV_ECHO_CID_MAX (default 128). Expiry-keyed
// suppression replaces the old fixed-size FIFO (max 8), which silently
// dropped suppression for the oldest of a burst of concurrent writes.
// The CID is the `x-cid` / `etag` value returned by the `kv/set`
// response; the pubsub dispatcher reads the matching `cid` field off the
// incoming KV frame and compares. `fromConflict` marks writes that
// succeeded only after a 409 / 412 retry, so non-self frames can force
// an authoritative read while their echo is still pending. A
// `fromConflict` echo is suppressed WITHOUT deleting its entry (and
// keeps `fromConflict` set), so an out-of-order competing frame
// arriving after the echo still forces the authoritative read instead
// of regressing the mirror via last-write-wins; the forced read demotes
// the marker (`fromConflict → false`) on both success and failure.
this.kvLocalEchoCIDs = new Map<string, Map<string, { expiry: number; fromConflict: boolean }>>()
```

Mirror state lives in `rootState._kv` (see §5). Initialise this in
`chelonia/_init` and clear it in `chelonia/reset`. `chelonia/reset`
first drains in-flight `chelonia/kv/update` / `chelonia/kv/clear` writes
via `chelonia/kv/_waitInFlight` (noop enqueued behind each active
per-contract `chelonia/queueInvocation` lane), then clears
`kvSlotsByContractID`, `kvActiveFilters`, `kvFilterDirty`, and
`kvLocalEchoCIDs` — these are per-subscription state, not code-level
state — but **leaves `kvSlots` (and `defContractKvByManifest`) intact**
because slot definitions are application code, not runtime state. After a
`chelonia/reset`, the next contract sync replays the `_reconcileForSlot`
pass against the surviving definitions.

`kvLocalEchoCIDs` is **runtime-only** and never persisted. A tab
reload drops both the in-flight `chelonia/kv/update` call and the
CID that would have suppressed its echo; this is correct because
any echo that arrives post-reload corresponds to a write whose
originating call site no longer exists and should simply repopulate
the mirror via the normal `reason: 'remote'` path.

A fifth field, `this.defContractKvByManifest = new Map<string, KvBlock>()`,
stores the previous `kv` block per manifest so the
`defineContract` replacement path (§11.3 step 8) can diff old vs.
new key sets. It lives next to `this.defContract` and
`this.defContractSelectors` on the Chelonia context.

**Index invariant.** A junior dev maintaining this code can rely on
the following invariant, which is the single source of truth for the
behaviour of `_handleRemote`, `_loadSlot`, the reconnect pass, and the
contract-release cleanup:

> `kvSlotsByContractID[cID].has(key)` ⇔
> (a) `kvSlots.has(`${contractType}::${key}`)` for some
> `contractType === rootState.contracts[cID].type`, **and**
> (b) `cID ∈ subscriptionSet`, **and**
> (c) the slot's last `match(cID, ...)` evaluation returned `true`,
> **and** equivalently `kvActiveFilters[cID].has(key)` (for `autoSubscribe: true` slots;
> slots with `autoSubscribe: false` are indexed in `kvSlotsByContractID` but deliberately
> absent from `kvActiveFilters`).

All four mutation points must preserve this invariant simultaneously:

1. `defineSlot` (initial register + replacement — runs `_reconcileForSlot`
   for every matching `cID`)
2. `_reconcileForSlot` (called on `CONTRACTS_MODIFIED`, `refreshFilters`,
   and from `defineSlot`)
3. `_cleanupContractSlots` (called from `defineContract` replacement —
   §11.3 step 8)
4. The contract-release / unsubscribe path (§11.4 last bullet) — strips
   *all four* of `kvSlotsByContractID[cID]`, `kvActiveFilters[cID]`,
   `kvFilterDirty.has(cID)`, and `rootState._kv[cID]`.

A private `chelonia/kv/_assertIndexConsistent` selector should be
implemented and called from every KV test's `afterEach` (and gated
behind a `__DEV__` / build-time flag in production builds) so any
mutation site that forgets to update one of the indices fails loudly
in CI rather than silently leaking stale subscriptions.

### 11.3 Selectors to implement (in order)

**Ordering note: `subscriptionSet` is populated before
`CONTRACTS_MODIFIED` fires.** Every emission site adds the new
`contractID` to `this.subscriptionSet` *before* emitting (see
`src/internals.ts:2041-2042` and `src/internals.ts:3370-3371`), so
the `CONTRACTS_MODIFIED` listener installed in §11.4 can safely
iterate `subscriptionSet` to drive `_reconcileForSlot` and will see
the newly-added contract on the first pass. The same property holds
for the reset path (`src/chelonia.ts:708-715`) where the set is
cleared *before* emit with `added: []` and a populated `removed` list.

1. `chelonia/kv/defineSlot` — validate the `null`-reserved rule by
   running `schema.parse(null)` once; if it succeeds, throw
   `ChelErrorKvSlotInvalid`. Apply the same guard to `undefined`
   (`schema.parse(undefined)` succeeding is equally ambiguous — a
   schema like `z.any()` / `z.unknown()` / `z.union([X,
   z.undefined()])` cannot disambiguate "never written" from
   "explicitly written undefined"). Additionally, if `schema.parse`
   returns a thenable (async-only schema), throw
   `ChelErrorKvSlotInvalid` — v1 supports synchronous parsers only
   (see §12 open question #2). Register, evaluate `defaultValue` (call
   it if it's a function) to populate `resolvedDefault`, run
   `resolvedDefault` through `schema.parse` to catch typos at boot,
   then walk the existing `rootState.contracts` and call
   `chelonia/kv/_reconcileForSlot` per contract whose type
   (`rootState.contracts[contractID].type`) matches. If a previous definition under the same key exists,
   re-validate every persisted mirror entry through the new schema
   per the rules in §4.1 (keep old value, flip status to `'error'`
   on failure).
2. `chelonia/kv/_reconcileForSlot` (private) — for one slot, iterate
   the **synced contracts** by walking `this.subscriptionSet` and
   filtering by `rootState.contracts[cID]?.type === slot.contractType`
   (this is the same data source `chelonia/contract/sync` mutates, so
   the reconciler always sees the live set). For each contract, run
   `match` against `(cID, rootState[cID], rootState)`, where
   `rootState[cID]` is the contract's live state (`ChelContractState`,
   including `_vm`). On
   `true`: add the slot to `kvSlotsByContractID[cID]`, create the
   `kvActiveFilters[cID]` bucket even for `autoSubscribe:false` slots,
   add the key to that bucket only for `autoSubscribe:true`, queue a
   coalesced `setFilter` flush (§11.5), ensure the mirror has a
   `status: 'non-init'` entry, and
   if `autoLoad === 'on-sync'` schedule a `_loadSlot` call. On
   `false` (or on a previously-true match that has flipped to false):
   remove from both indices, drop the mirror entry, and queue a
   filter flush.

   For `autoLoad === 'on-demand'`, do not fetch in reconcile; the first
   explicit `chelonia/kv/sync` (or successful `chelonia/kv/update`)
   materializes loaded state. `chelonia/kv/read` keeps serving default
   until then.
3. `chelonia/kv/_loadSlot` (private) — set `status: 'loading'`, fire
   `CHELONIA_KV_STATUS_CHANGED`, then `chelonia/kv/get` → unwrap
   `.data` → schema-validate (mapping wire `null` → default *before*
   `schema.parse`; mapping a 404 / missing-key response — which
   `chelonia/kv/get` resolves as `null` today — to `status:
   'non-init'` with `value: undefined` in the mirror, *no*
   `CHELONIA_KV_UPDATED` emitted, and the subsequent
   `CHELONIA_KV_STATUS_CHANGED` transitions to `'non-init'` rather
   than `'loaded'`. "Key not yet written" is not the same as
   "loaded with the declared default" — the next `chelonia/kv/read`
   substitutes the default at read time, per §4.3. **Exception:** if
   the slot previously held a value (`previousValue !== undefined`),
   the 404 represents a state transition (value → cleared) and
   `CHELONIA_KV_UPDATED` *is* emitted with `value: undefined` and
   `previousValue` set to the old mirror value, followed by
   `onUpdate` with the cloned default. This ensures consumers
   observing the slot via the event bus see the reversion to default
   instead of being stuck with stale state.) → write mirror → fire `CHELONIA_KV_UPDATED` with
   the supplied `reason` (`'load'` from reconcile, `'reconnect'` from
   the pubsub reconnect hook) → fire
   `CHELONIA_KV_STATUS_CHANGED('loaded')` → call `onUpdate` (wrapped
   in try/catch). Catches and downgrades validation errors to
   `CHELONIA_KV_VALIDATION_ERROR`. **Retry policy:** a network failure
   sets `status: 'error'` and records `lastError`; the slot is **not**
   auto-retried on a timer. The normal recovery paths are (a) the
   reconnect hook (§11.4) which re-runs `_loadSlot` automatically when
   the websocket comes back, and (b) explicit consumer-driven retries
   via `chelonia/kv/sync`. This avoids reinventing exponential-backoff
   machinery and matches the way `chelonia/contract/sync` itself
   handles transient errors.
4. `chelonia/kv/_handleRemote` (private) — invoked from the existing
   `NOTIFICATION_TYPE.KV` dispatch in `src/chelonia.ts:1089`. Looks
   up the slot via `kvSlotsByContractID[contractID][key]` (O(1) —
   no registry scan, no re-running of `match`, because
   `_reconcileForSlot` already gated entry into this index on a true
   match). Read the `cid` field off the incoming KV frame
   (before `schema.parse`, before the value reaches the mirror). If
   it matches a non-expired entry in `kvLocalEchoCIDs[`${contractID}::${key}`]`,
   drop the frame silently (self-echo suppression — §4.9) and delete
   the entry immediately (a seen CID can never legitimately recur). If the incoming
   value is wire-level `null`, treat
   it as a clear sentinel and write `value: undefined` to the mirror
   (the canonical `'non-init'` shape — §4.3/§4.5; `read`/`onUpdate`
   still surface the cloned default) without
   running `schema.parse`; otherwise validate `parsed.data` directly,
   write the mirror, set the mirror `etag` to the frame's `cid`, and
   fire the event with `reason: 'remote'`. On `schema.parse`
   rejection, **keep the previous mirror `value`** but flip
   `status` to `'error'`, set `lastError`, and fire
   `CHELONIA_KV_VALIDATION_ERROR` followed by
   `CHELONIA_KV_STATUS_CHANGED('error')` (per §4.9). The exception
   does **not** escape the dispatch path — pubsub processing
   continues for other contracts/keys. If no slot is registered,
   the existing raw dispatch still runs (no regression).
   > Signature change to `chelonia/kv/set` (additive,
   > backwards compatible): change the return type from `void` to
   > `Promise<{ etag: string | null }>`, where `etag` is the value
   > of the `x-cid` / `etag` response header from the final
   > successful POST (or `null` if neither header was sent).
   > `chelonia/kv/queuedSet` forwards the resolved object verbatim.
   > Every existing caller in the repo ignores the return value,
   > so no migration is required. `chelonia/kv/update` reads
   > `.etag` off the resolved object to populate the mirror.
   > An `onSuccess` callback option was considered and rejected as
   > more verbose without enabling any use case the direct return
   > value does not.

5. `chelonia/kv/update` — contract-type resolution via
   `rootState.contracts[contractID].type` (fallback:
   `rootState[contractID]._vm.type`) → active-slot lookup via
   `kvSlotsByContractID[contractID][key]` → mirror
   read (using the same error-status default substitution as
   `chelonia/kv/read`, not the retained mirror value) → reducer → noop
   check → schema validate →
   `chelonia/kv/queuedSet` with internal `onconflict` that
   schema-validates the server's `currentData` *before* re-running
   the reducer (per §4.2 step 5), then re-validates the reducer's
   output. The validated value is handed to `queuedSet` as `data`
   raw — no wrapper, no injected fields. On
   success: read the server data CID from the `kv/set` response headers
   (`x-cid` / `etag`, same fields used today by `chelonia/kv/set`'s
   internal `onconflict` plumbing — see `src/chelonia.ts:2635`),
   record it in `kvLocalEchoCIDs` (time-decaying map keyed by
   `(contractID, key)`, entry expires after `KV_ECHO_TTL_MS` ≈ 5 min)
   for self-echo suppression, write
   it into `rootState._kv[id][key].etag`, then mirror-write the value
   → event → `onUpdate`. The pubsub echo of this write carries the
   same CID in its `cid` field, so `_handleRemote` drops it (§4.9).
   On exhaustion of `maxAttempts`, reject with
   `ChelErrorKvConflict` carrying the last seen `currentData` and
   `etag` (`.cause` carries the conflict detail in the
   `ChelErrorGenerator` convention used by `ChelErrorJournalCorrupt`).
   Propagate `AbortError` from `signal`. Non-409/412 HTTP errors
   propagate verbatim from `queuedSet` without flipping `status` to
   `'error'` (per §4.2 / §4.9: `'error'` is reserved for load/validation
   failures where the *mirror* might be stale).

   > Server-etag plumbing: today's `chelonia/kv/set` does not return
   > the response etag to its caller. v1 should expose it — either by
   > returning `{ etag }` from `chelonia/kv/set` (additive, non-breaking)
   > or by passing an `onSuccess({ etag })` callback option through
   > `chelonia/kv/queuedSet`. Pick whichever keeps the existing
   > `chelonia/kv/set` signature intact for current consumers.
6. `chelonia/kv/read`, `chelonia/kv/sync`, `chelonia/kv/clear`,
   `chelonia/kv/status`, `chelonia/kv/refreshFilters` — straightforward
   wrappers around the private helpers.
7. `chelonia/kv/_registerContractSlots` (private convenience used by
   `defineContract`) — accepts the contract name, manifest, and
   `kv: { ... }` object and loops `defineSlot`. Modify
   `chelonia/defineContract` in `src/chelonia.ts` (around line 1165,
   where `this.defContract = contract` is assigned and
   `this.defContractSelectors` is rebuilt) to: (a) before the
   reassignment, read `this.defContractKvByManifest.get(contract.manifest)`
   as `prevKv` (may be `undefined` on first define), (b) after
   registering the new selectors, if `contract.kv` is present, call
   `_cleanupContractSlots(contract.name, contract.manifest, prevKv, contract.kv)`
   to diff the key sets, then call
   `_registerContractSlots(contract.name, contract.manifest, contract.kv)`
   to register the new ones, and (c) `this.defContractKvByManifest.set(
   contract.manifest, contract.kv)` so the next replacement can diff
   against the now-current key set. (If `contract.kv` is absent on
   the new definition but `prevKv` exists, treat it as `nextKv = {}`
   so `_cleanupContractSlots` unregisters every previously-declared
   key, then `delete` the manifest entry.) This piggybacks on the
   existing replacement point used by HMR / re-defines, so there is
   exactly one site to keep in sync — the same site where action
   selectors are already torn down and re-registered.

8. `chelonia/kv/_cleanupContractSlots(contractType, manifest, prevKv, nextKv)`
   (private) — diff the previous and next `kv` key sets for the
   manifest, and for every key in `prevKv` that is not in `nextKv`:
   unregister the slot from `kvSlots`, remove it from every
   `kvSlotsByContractID[cID]` entry, remove the key from every
   `kvActiveFilters[cID]`, mark each affected contract dirty in
   `kvFilterDirty`, and drop the corresponding `rootState._kv[cID][key]`
   mirror entry. The single flush at the microtask boundary (§11.5)
   emits one `setFilter` frame per affected contract. Keys present
   in **both** `prevKv` and `nextKv` are handled by the normal
   `defineSlot` re-registration path (which already re-validates
   persisted mirror values against the new schema — §4.1).

### 11.4 Hook points in the existing code

Four minimal patches to existing files:

- `src/chelonia.ts:1089` — inside the `NOTIFICATION_TYPE.KV` branch,
  after the existing `parseEncryptedOrUnencryptedMessage` call and
  inside the same `chelonia/queueInvocation` callback (keyed on
  `msg.channelID`), additionally invoke `chelonia/kv/_handleRemote`
  with `(msg.channelID, msg.key, parsedValue, msg.cid)`. The pubsub
  message shape at this site is `{ channelID, key, data, cid }` (see
  `createKvMessage` in `src/pubsub/index.ts:425-429`); the `cid` is
  the **server-issued data CID**, which is why self-echo suppression
  keys on it directly rather than on a client-injected token (§4.9).
  Keep the
  existing dispatch path that calls into `this.pubsub` so consumers
  using the raw API are unaffected — the new handler runs in addition
  to, not instead of, the legacy callback.
- `src/chelonia.ts` — after `chelonia/contract/sync` resolves for a
  newly-added contract (and at the `CONTRACTS_MODIFIED` emission
  site, lines 708–715), iterate `this.kvSlots` and call
  `chelonia/kv/_reconcileForSlot` for each slot whose `contractType`
  matches the new contract's `type` (from
  `rootState.contracts[contractID].type`). The `journal.ts` recorder
  is wired similarly inside `handleEvent.applyProcessResult`;
  pattern-match on that for the integration shape.
- `src/pubsub/index.ts` / `src/chelonia.ts` — the reconnect path emits
  `PUBSUB_RECONNECTION_SUCCEEDED` when the socket opens; Chelonia listens
  there and re-runs `_loadSlot` with `reason: 'reconnect'` for every
  `(contractID, slot)` pair currently in `kvSlotsByContractID` where
  `slot.refreshOnReconnect === true`. The refresh is an HTTP GET and does
  not depend on SUB / KV filter replay order. Route this through the
  existing per-contract `chelonia/queueInvocation` lane so reconnect
  fetches are serialized with in-flight `chelonia/kv/update` writes and
  cannot race them. Do not re-run `match` here — reconnect should not
  silently drop slots; that's the reconcile pass's job, which fires on
  `CONTRACTS_MODIFIED`. Also clear `kvLocalEchoCIDs` on reconnect:
  any pending echo from a write that happened before the disconnect
  has either already been delivered or is lost, so retaining a CID
  would only keep a dead entry around until its TTL lapsed (a stale
  CID can never collide with a future server-issued CID, but the clear
  is still good hygiene).
- `src/chelonia.ts` — in the contract-release/unsubscribe path (the same
  place that removes a contract from the active subscription set), clear
  all per-contract KV runtime state for that `contractID`: remove
  `rootState._kv[contractID]`, `kvSlotsByContractID[contractID]`,
  `kvActiveFilters[contractID]`, and any pending `kvFilterDirty` mark.
  This keeps long-lived sessions from accumulating stale mirror entries
  after refcount goes to zero.
- `src/local-selectors/index.ts` — extend `chelonia/externalStateSetup`
  so `rootState._kv[contractID]` is projected into the external store
  alongside `cheloniaState` / `contractState`. KV updates do **not**
  fire `EVENT_HANDLED` (that event is on-chain-only), so the
  projection must be driven by KV-specific events:
  - Subscribe to `CHELONIA_KV_UPDATED`: after the existing
    `reactiveSet(externalState.contracts, contractID, ...)` pattern,
    `reactiveSet(externalState._kv ?? {}, contractID,
    cloneDeep(rootState._kv?.[contractID]))` (creating
    `externalState._kv` lazily, mirroring the `externalState.contracts`
    pattern). Fires on every `reason ∈ {load, remote, local,
    reconnect}`, covering every mirror transition that carries a value.
  - Subscribe to `CHELONIA_KV_STATUS_CHANGED` for the `'error'`
    transition (where `value` is unchanged but `status` / `lastError`
    are): re-project so consumers see the new status in their store.
  - On `CONTRACTS_MODIFIED`, drop `externalState._kv[cID]` for every
    removed contract (matching the contract-release cleanup in the
    previous bullet).

  **Teardown.** `chelonia/externalStateSetup` is invoked on login
  and torn down on logout (the existing pattern in
  `src/local-selectors/index.ts` already registers `EVENT_HANDLED`
  and `CONTRACTS_MODIFIED` listeners with handles that get `off()`'d
  on teardown). The three new subscriptions above MUST be registered
  with retained handles and `off()`'d in the same teardown path —
  otherwise listeners accumulate across login sessions and a logged-in
  user can observe state from a previous account. Add a unit test
  that calls `externalStateSetup` → tears down → calls it again, and
  asserts the listener count on the `okTurtles.events` bus is
  stable (or that `CHELONIA_KV_UPDATED` fires exactly once per
  mirror write after the second setup).

  With this in place, §9 option (a) is truly free — the mirror appears
  under `state._kv` in Vuex with no per-key wiring.

### 11.5 `setFilter` coalescing

Naive implementation: call `chelonia/kv/setFilter` for each
`_reconcileForSlot` invocation. This produces N pubsub frames at boot
if N slots are defined.

Correct implementation: collect filter mutations during a microtask
and emit one call per contractID per tick. The pattern is:

```ts
this.kvFilterDirty = new Set<string>()
function queueFilterUpdate (cID: string) {
  if (this.kvFilterDirty.size === 0) queueMicrotask(flushFilterUpdates)
  this.kvFilterDirty.add(cID)
}
function flushFilterUpdates () {
  for (const cID of this.kvFilterDirty) {
    sbp('chelonia/kv/setFilter', cID, [...this.kvActiveFilters.get(cID) ?? []])
  }
  this.kvFilterDirty.clear()
}
```

Result: defining 5 slots at boot produces 1 `KV_FILTER` frame per
contract, not 5.

**Empty transitions.** When the last active slot for a contract flips
off (`match` returned `false` for every slot, or the contract is being
released), the flush emits `setFilter(cID, [])` so the server clears
any previous subscription — silently dropping the call would leave the
server pushing stale notifications until the contract is re-subscribed.
(The existing `chelonia/kv/setFilter` accepts an empty array.) When the
contract is being unsubscribed via the contract-release path (§11.4),
the filter flush runs *before* the per-contract runtime KV state is
dropped so the empty-filter frame still reaches the server.

### 11.6 Tests to write (add `src/kv.test.ts`)

Mirror the structure of `src/journal.test.ts`:

1. `defineSlot` is idempotent; replacing a definition re-validates.
   A slot whose `schema.parse(null)` succeeds is rejected at
   registration with `ChelErrorKvSlotInvalid` (§4.1 reserved-null rule).
2. `defineSlot` with a `match` predicate only attaches to matching
   contracts; flipping `match` and calling `refreshFilters` adds and
   removes filter entries correctly.
3. `update` writes the reducer result; on a synthesised 412 response
   from a stub `fetch`, the reducer is re-run against the fresh
   `currentData`. Returning `KV_NOOP` skips the network entirely.
4. Schema rejection on `update` reducer output throws
   `ChelErrorKvValidation` and does **not** hit the network.
5. Schema rejection on a simulated pubsub notification does *not*
   throw out of the dispatch path; the mirror keeps the previous
   valid value, `status` flips to `'error'` with `lastError` set,
   and `CHELONIA_KV_VALIDATION_ERROR` followed by
   `CHELONIA_KV_STATUS_CHANGED('error')` fire. The next valid
   pubsub frame for the same slot returns `status` to `'loaded'`
   and clears `lastError`.
6. Multiple `defineSlot` calls in one tick produce one `setFilter`
   call per contract.
7. `refreshOnReconnect: true` slot re-fetches on a simulated reconnect.
8. `clear` resets the mirror `value` to `undefined` (the canonical
   `'non-init'` shape; `read`/`onUpdate` surface the cloned default),
   writes JSON `null` server-side via `chelonia/kv/set` (not
   `undefined`, which the underlying primitive treats as a fetch-first
   sentinel), transitions `status` to `'non-init'`, and fires
   `CHELONIA_KV_UPDATED` with `reason: 'local'` and `value: undefined`.
9. `chelonia/reset` first **drains** in-flight `chelonia/kv/update` /
   `chelonia/kv/clear` writes via `chelonia/kv/_waitInFlight` (which
   enqueues a noop behind each active per-contract
   `chelonia/queueInvocation` lane — symmetric with
   `chelonia/contract/wait`); `abortController.abort()` remains the
   backstop for genuinely stuck/offline writes. Only then does it empty
   `rootState._kv`, clear `kvSlotsByContractID`, `kvActiveFilters`,
   `kvFilterDirty`, and `kvLocalEchoCIDs`, but leave `kvSlots` (the
   code-level definitions) intact; the next contract sync replays the
   reconcile pass and rebuilds the per-contract indices. Draining before
   the synchronous teardown guarantees no continuation runs against a
   torn-down mirror or a swapped-out `kvLocalEchoCIDs`. Any echo that
   still arrives post-reset corresponds to a write whose call site no
   longer exists and repopulates a fresh session via the normal
   `reason: 'remote'` path (see the `kvLocalEchoCIDs` note above).
10. Integration: a slot defined inside `chelonia/defineContract`
    `{ kv: { ... } }` is registered and behaves identically to a
    free-standing `defineSlot` call.

11. `update` retries: when `onconflict` fires with a server
    `currentData` that *fails* `schema.parse`, the update rejects
    with `ChelErrorKvValidation` and does not silently swallow the
    failure or write garbage.
12. `update` retries: when `currentData` is well-formed but the
    re-run reducer returns `KV_NOOP`, the retry loop aborts cleanly
    and the original `update` call resolves with `undefined`.
13. `defineSlot` replacement with a stricter schema flips persisted
    mirror entries that fail re-validation to `status: 'error'` and
    fires `CHELONIA_KV_VALIDATION_ERROR`, without discarding the old
    value.
14. Event payloads carry both `contractID` and `contractType` so the
    generic Vuex mirror table in §9 can route by type without a
    separate lookup.
15. `clear` remote-path: an incoming wire `null` is treated as a clear
    sentinel (`defaultValue` restore) before schema validation.
16. `defineContract` replacement unregisters removed manifest-scoped KV
    keys via `_cleanupContractSlots` and updates active filters.
17. Contract release/unsubscribe removes per-contract runtime KV state
    (`rootState._kv[contractID]`, indices, dirty filter marks).
18. Self-echo suppression: a successful `chelonia/kv/update` records
    the server data CID in `kvLocalEchoCIDs`; the synthesised pubsub
    echo carrying that CID in its `cid` field is dropped (no second
    `CHELONIA_KV_UPDATED`, no second `onUpdate`) **and the entry is
    deleted on first match**. A simulated remote
    write (different `cid`, or no `cid` at all) on the same slot
    still fires `reason: 'remote'`, and its `cid` is recorded as the
    mirror `etag`. With the clock advanced past `KV_ECHO_TTL_MS`, the
    recorded CID is treated as absent and a late echo fires
    `reason: 'remote'` (expiry path); and a bucket pushed past
    `KV_ECHO_CID_MAX` evicts the earliest-expiry entry first (backstop
    path).
19. `chelonia/kv/update` rejection taxonomy: a synthesised exhaustion
    of `maxAttempts` rejects with `ChelErrorKvConflict` (with the
    last `currentData` / `etag` attached on `.cause`); a synthesised
    5xx rejects with the underlying error and leaves `status`
    unchanged; `signal.abort()` rejects with `AbortError` and the
    mirror is unchanged.
20. **Index invariant.** A scenario that exercises
    `defineSlot` → `_reconcileForSlot` → `match` flipping false →
    `refreshFilters` → contract release ends with
    `_assertIndexConsistent` passing (no entry leaked in any of
    `kvSlotsByContractID`, `kvActiveFilters`, `kvFilterDirty`, or
    `rootState._kv` once the contract is released).
21. **`defineSlot` defaultValue round-trip guard:** a schema whose
    parse drops or coerces a field of the resolved default is
    rejected at registration with `ChelErrorKvSlotInvalid`.
22. **`sync` without `key`** dispatches concurrent `chelonia/kv/get`
    calls, skips slots whose `match` currently returns false, and
    routes each fetch through `chelonia/queueInvocation` keyed on
    `contractID` (assertable by observing serialisation against an
    in-flight `chelonia/kv/update`).
23. **Wall-clock-in-reducer documentation test** — a reducer that
    returns `{ ...prev, t: Date.now() }` is forced through a 412
    retry; the test asserts that the persisted value's `t` differs
    between the first-attempt invocation and the retry invocation
    (captured via a spy on the reducer). This documents — and locks
    in — the §3.3 contract that the library does **not** freeze
    reducer output across retries: the reducer is the source of
    truth, and embedding wall-clock values inside it is the
    *consumer's* bug. The test exists so that any future change
    that introduces hidden first-attempt caching (and thereby
    silently "fixes" this anti-pattern) trips CI and forces an
    explicit API decision rather than a behavioural drift.
24. **Async `onUpdate` rejection** — an `onUpdate` whose returned
    promise rejects is caught by the dispatcher and logged; the
    mirror write, `CHELONIA_KV_UPDATED`, and subsequent KV frames
    for the same contract all proceed normally. Symmetric with the
    synchronous-throw case, covers the explicit promise contract
    in §4.1.
25. **`defaultUpdater` happy path** — a slot defined with
    `defaultUpdater: (patch) => (prev) => ({ ...prev, ...patch })`
    accepts a `value` payload on `chelonia/kv/update`, writes the
    shallow-merged result, and re-applies the same `patch` on a
    synthesised 412 retry (the factory is called once; the returned
    reducer is what re-runs against `currentData`).
26. **`defaultUpdater` error cases** — `chelonia/kv/update` rejects
    synchronously with `ChelErrorKvUpdateInvalid` when (a) neither
    `updater` nor `value` is provided, (b) both are provided, or
    (c) `value` is provided against a slot that has no
    `defaultUpdater`. No mirror read or network call occurs in any
    of these cases.
27. **`defaultUpdater` + `KV_NOOP`** — a slot whose `defaultUpdater`
    returns `KV_NOOP` based on `prev` (e.g. a throttle window not
    yet elapsed) skips the network entirely and resolves with
    `undefined`, identical to the hand-written `updater` path.

Use the same stubbing approach as `src/journal-integration.test.ts`
for `fetch`/`pubsub`.

### 11.7 Documentation

- Add a `## KV slots` section to `docs/api.md` next to the existing
  `chelonia/kv/*` documentation.
- Add a `### KV slots` paragraph to `AGENTS.md` immediately
  after the journal section, mirroring its structure (one paragraph
  + a config-table block + a public-selectors block).
- The `_journal` paragraph in `AGENTS.md` already documents the
  pattern for adding consumer-visible state branches under
  `rootState`; reuse that wording for `rootState._kv`.

### 11.8 Definition of done

- All twenty-seven test cases above pass under `npm test`.
- `npm run lint` is clean.
- `npm run build` produces both ESM and CJS outputs with the new
  selectors exported.
- The Group Income port (separate PR in that repo) replaces
  `identity-kv.js` + `group-kv.js` with a single declaration file
  and one generic mirror listener (§9), and CI stays green.

---

## 12. Open questions

1. **Per-contract slot binding beyond `match`.** `match` covers the
   own-identity case, but some consumers may want slots keyed by an
   inner value (e.g. group-level chat settings keyed by chatroom).
   For v1, callers compose: define one slot whose value is
   `{ [chatroomID]: settings }`. A future first-class
   `contractIDs?: string[]` whitelist or `keyTemplate` is additive.
2. **Async validators / async `onUpdate`.** v1 ships with
   **synchronous** `schema.parse` only — every validation site in
   §6 calls `parse(value)` and treats the return value as the
   validated payload. Async validators (`parseAsync`) are out of
   scope; if a consumer needs one they should pre-validate in a
   wrapper around `chelonia/kv/update` or precompute the
   derived/awaited value before the reducer returns. Async
   `onUpdate` _is_ supported (the dispatcher awaits it), but pubsub
   processing is serialised per-contract through
   `chelonia/queueInvocation`, so a slow async `onUpdate` blocks
   subsequent KV notifications for the same contract. Document the
   constraint; do not introduce a separate priority lane in v1.
3. **Schema versioning / migrations.** Out of scope for v1. Today's
   solution (validate-and-discard on failure) is acceptable as a
   starting point.
4. **Deletion semantics.** `chelonia/kv/clear` is documented as
   "reset to default + server write of JSON `null`" (see §4.5 for why
   JSON `null`, not `undefined` — the existing
   `chelonia/kv/set` at `src/chelonia.ts:2649,2667-2679` treats
   `data === undefined` as a fetch-first sentinel that does a `GET`
   and routes through `onconflict` instead of writing). If the
   server ever grows a proper `DELETE /kv/...` verb, the selector
   keeps the same signature.
5. **Server-side filter compaction.** Out of scope for backend changes
   in v1; client-side coalescing in §11.5 is sufficient for the first
   release.
6. **Snapshot/restore interactions with the journal.** The new
   `rootState._kv` subtree is a sibling of `rootState.contracts`, not
   contract state, so it is already outside the journal's diff scope
   (the journal only walks `state.contracts[contractID]`). No journal
   change is required, but the AGENTS.md "Consumer-visible leakage"
   note should be updated to mention `rootState._kv` as a second
   subtree shipped through `chelonia/externalStateSetup`.
7. **Voting / co-signed KV updates.** Out of scope for v1. The
   right composition is a slot whose value is itself a tally object,
   with `chelonia/kv/update` reducers that append a signed vote and
   only "commit" the change once a quorum is reached. This is
   protocol-level work, not library plumbing, but the slot API does
   not preclude it.

---

## 13. Summary

The new API turns this:

> "Add a constant, write a fetch selector, write a save selector,
> write a load selector, define a `NEW_*` event, add a branch in
> `setupChelonia.js`, add a branch in `sw-primary.js`, add a branch
> in `main.js`, add a branch in `identity.js`, and re-implement the
> `({ currentData, etag } = {}) => […, etag]` shape for the eighth
> time"

into this:

> "Call `chelonia/kv/defineSlot` once; call `chelonia/kv/update`
> with a pure `(prev) => next` updater at the use site; read from
> `rootState._kv` or listen for `CHELONIA_KV_UPDATED`."

The low-level primitives stay exactly as they are for the rare cases
that genuinely need them.
