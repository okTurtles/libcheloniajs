# Key-value store and KV slots

`@chelonia/lib` exposes its server-side KV store through two layers:

- **Raw primitives** — `chelonia/kv/set`, `chelonia/kv/get`,
  `chelonia/kv/setFilter`, and `chelonia/kv/queuedSet`. Thin wrappers
  over the relay's `POST`/`GET /kv/:contractID/:key` endpoints. See the
  [Key-value store](./api.md#key-value-store) selector table.
- **KV slots** — a declarative, typed key/value API layered on those
  primitives. Consumers register "slots" via `chelonia/kv/defineSlot`
  (or inline under the `kv` key of `chelonia/defineContract`); the
  library manages local mirroring, pubsub filter coalescing, conflict
  retries, and schema validation automatically. See the
  [KV slots](./api.md#kv-slots) selector table.

All slot selectors live in `src/kv.ts`.

## The local mirror

"Mirror" refers to `rootState._kv` — a local, in-state replica of the
server-side KV store covering every declared slot. The server remains
authoritative; the mirror is what consumers actually read. For each
`(contractID, key)` pair where a slot's `match` holds, the mirror keeps
the last server-confirmed value paired with its server etag (the value
CID) plus a load status — a [`KvMirrorEntry`](./api.md#types) of shape
`{ value: JSONType | undefined, etag: string | null, status: KvLoadStatus, lastError?, settled?, heightAhead? }`
— so `chelonia/kv/read` answers synchronously from local state and
consumers never call `chelonia/kv/get` for a declared slot.

The library keeps the replica in lockstep with the server through four
update channels, each surfaced as a distinct `reason` on
`CHELONIA_KV_UPDATED` / `onUpdate`: the initial fetch after contract
sync (`'load'`), pubsub pushes from other clients (`'remote'`), this
client's own successful writes (`'local'`), and re-fetches after a
websocket reconnect (`'reconnect'`). Every channel validates the value
against the slot's `schema` before it lands and pairs the value with its
etag, so the mirror never holds a value the server didn't confirm, nor
one this client can't verify yet (see [Contract heights](#contract-heights)).
Because the mirror lives inside Chelonia's root state, it is projected
into external stores (Vuex, Pinia) by `chelonia/externalStateSetup`
with no per-key wiring — see
[External state sync](./api.md#external-state-sync).

### Lazy initialization

The mirror and its entries are created lazily:

- `chelonia/_init` sets `rootState._kv` only if it is not already
  present (so a mirror restored from a persistence layer is preserved,
  not clobbered), as a null-prototype plain object via
  `config.reactiveSet` so reactive frameworks (e.g. Vue) observe
  additions.
- The reconcile pass adds a `_kv[contractID][key]` entry only when a
  slot's `match` first returns `true`, seeding it with
  `status: 'non-init'`, `value: undefined`, `etag: null` and
  `settled: false`.
- The declared `defaultValue` is never copied into the mirror eagerly;
  `chelonia/kv/read` substitutes it at read time.

Direct observers of `rootState._kv` must therefore treat `status`, not
`value`, as the source of truth: `value: undefined` means "presenting
the default", not "no value configured" (see
[Consumer caveats](#consumer-caveats)). For a `_kv`-free view of root
state, project `{ ...rootState, _kv: undefined }`.

### Pending vs settled

`status` alone can't tell a key with no value from one that hasn't been
loaded yet: both are `'non-init'`. Each entry therefore also carries:

- `settled`: `true` once the slot has reached a final outcome since it
  last became active: a load found a value or none, a pubsub frame or a
  local write was applied, a load failed, or the library gave up
  waiting for a contract height. It turns `false` whenever the slot
  becomes active (after a contract sync or resync, also for entries
  restored from persistence), then stays `true` through later reloads.
- `heightAhead: { requiredHeight }`: the server holds a value for the
  key that this client can't verify yet (see
  [Contract heights](#contract-heights)). It is removed once a load or
  a write verifies the key.

Read them through the selectors rather than the raw entry:

- `chelonia/kv/settledStatus(contractID, key)` gives `'loaded'`,
  `'non-init'` (verified empty) or `'error'` once the active slot has
  settled, and `undefined` before that, while a reload shows
  `'loading'`, or when the slot isn't active.
- `chelonia/kv/whenSettled(contractID, key, { signal })` resolves with
  that value as soon as it is defined, waiting through boot, the first
  contract sync and slot activation if needed. It rejects with
  `ChelErrorKvSlotUnknown` when no slot can become active for the key
  (none is defined for it, or the contract's slots were reconciled
  without it) or stops being able to (slot deactivated or unregistered,
  contract removed); with `signal.reason` on abort; and with an
  `AbortError` on `chelonia/reset`. A resync doesn't end the wait
  ([full rules](specs/KV-REVAMPED.md#35-settled-status)).

`CHELONIA_KV_STATUS_CHANGED` also carries `settled`, `previousSettled`
and `heightAhead` (`null` when there is none), and fires when only
these (or `lastError`) change.

When `stateSelector` points at an app store that persists `_kv`,
restored entries keep the previous session's `settled: true` until
their slot becomes active. Use `settledStatus`, which only reports
active slots, instead of the raw flag.

## Contract heights

Every KV value is stamped with the height its contract had when the
value was written. A client can verify a value only once its local copy
of the contract has reached that height (the signing key may have been
added after the local height), and the server only accepts writes
stamped with the contract's current height (`409` otherwise). Both
happen mostly right after switching devices, or while another device
is changing the contract. A value that can't be verified yet is not an
absent value: never treat it as one. The exact rules are in
[KV-REVAMPED.md §3.4](specs/KV-REVAMPED.md#34-height-stamps-verifiability-and-recovery).

The KV selectors report these cases with their own errors. Check them
with the predicates exported from the package root. They compare
names, so they work across realms and library copies, but they only
look at `e` itself: `findErrorCause(e, isKvHeightAhead)` finds one
wrapped in your own errors.

| Error | Predicate | Meaning |
|---|---|---|
| `ChelErrorKvHeightAhead` | `isKvHeightAhead` | The value (or the server) needs a contract height not reached locally; syncing the contract helps. `kvHeightAheadCause(e)` gives its `KvHeightAheadCause` (`requiredHeight`, `exact`, `localHeight`, `etag`, `httpStatus`). |
| `ChelErrorKvHeightMalformed` | `isKvHeightMalformed` | The value's height stamp is missing or invalid: it can never be verified, and syncing doesn't help. Overwrite it (`chelonia/kv/clear`). |
| `ChelErrorKvConflict` | `isKvConflict` | A write ran out of attempts on `412` conflicts, or got a `412` without `onconflict`. `.cause` (`KvConflictCause`) describes the server value of the last `412`. Also matches the internal error raw `chelonia/kv/set` throws. |

Both height errors extend `ChelErrorInvalidMessageHeight` (`instanceof`
still holds), but have their own names.

### What the library does

- **Slot loads and pubsub frames** that find a value ahead leave the
  slot pending: the mirror keeps its value (a `'non-init'` slot shows
  `'loading'`), the entry gets `heightAhead`, and the key reloads once
  the contract reaches the height. After 10 s without it, the library
  syncs the contract once; if that isn't enough, the slot settles (as
  `'error'`, with `lastError.name === 'ChelErrorKvHeightAhead'`, if it
  holds no value) and still reloads if the height arrives later. A
  malformed value fails the load (`'error'`); a malformed frame isn't
  applied, and the key reloads.
- **`update`, `clear`, `queuedSet` and single-key `sync`** recover from
  `ChelErrorKvHeightAhead`: they sync the contract and retry. A write
  gives up its place in the contract's queue while the sync runs, and
  concurrent callers share one sync. A slot write that still fails on a
  value ahead leaves the slot pending, like a load.
- **`chelonia/kv/set`** waits briefly for incoming events to bring the
  contract to a conflicting value's height before giving up. After a
  `409` it re-signs the same data once the contract catches up (waiting
  for a running sync first). It never syncs, and `409`s never reach
  `onconflict`.
- **Raw KV pubsub handlers** (`messageHandlers[NOTIFICATION_TYPE.KV]`
  of `chelonia/connect`) never receive frames that are ahead (a warning
  is logged) or malformed (the error is logged).

### Options and timings

`update`, `clear`, `queuedSet`, single-key `sync` and
`withHeightRecovery` accept these options (`null` means the default;
invalid values reject with `ChelErrorKvUpdateInvalid` before any
request):

| Option | Default | Effect |
|---|---|---|
| `onHeightAhead` | `'sync'` | `'reject'`: reject with `ChelErrorKvHeightAhead` at once (no wait, no sync). |
| `maxHeightRecoveries` | `2` | Syncs before giving up. `0`: one short wait for incoming events, no sync. |
| `signal` | none | Aborting rejects with `signal.reason`; a write the server already accepted still resolves. |

Whatever the options, a slot found ahead still reloads once the
contract reaches the height.

| Timing | Value |
|---|---|
| Wait for incoming events to reach a height (`kv/set`'s `heightWaitMs` default; no wait while the pubsub socket is down) | 1.5 s |
| A pending slot stops waiting: one sync, then it settles if still behind | 10 s |
| One caller's wait for a recovery sync, then it rejects with the original error | 30 s |
| `kv/set` re-signs after `409`s | at most 5 per call |
| Random backoff before each `onconflict` retry | 0-1.5 s |

### Raw `kv/get` and `kv/set`

`chelonia/kv/get` never waits or syncs: it rejects with
`ChelErrorKvHeightAhead` or `ChelErrorKvHeightMalformed`. Wrap raw
calls in `chelonia/kv/withHeightRecovery` to recover like the slots do:

```ts
const value = await sbp('chelonia/kv/withHeightRecovery', contractID,
  () => sbp('chelonia/kv/get', contractID, key))

await sbp('chelonia/kv/withHeightRecovery', contractID,
  ({ heightWaitMs, queue }) => queue(() => sbp('chelonia/kv/set', contractID, key, data, {
    encryptionKeyId, signingKeyId, onconflict, heightWaitMs
  })),
  { maxHeightRecoveries: 1 })
```

The attempt runs outside the contract's queue unless it calls
`queue(body)`. Pass `heightWaitMs` on to `kv/set`: it is `0` except on
the last attempt, so earlier attempts sync instead of waiting. Only a
`ChelErrorKvHeightAhead` thrown as is (not wrapped) is recovered.

`onconflict` gets `currentStatus` (`'present'`, `'absent'`, `'ahead'`
or `'malformed'`). By default an unverifiable value fails the write
instead of reaching `onconflict`; a blind writer, which doesn't need
the current value, can pass `allowUnverifiedConflict: true` to get it
(reading `currentData` then throws).

### Where not to await

A contract's side effects, `queueInvocation` bodies, and slot loads and
writes (so `onUpdate`, reducers and `onconflict`) run on that
contract's queue. From there, never await `update`, `clear`,
`queuedSet`, single-key `sync` or a pending `whenSettled` for the same
contract: they wait for the queue you hold, so they never settle. A
synchronous call from the same contract's `onUpdate` rejects with
`ChelErrorKvReentrant` instead; schedule it with `queueMicrotask` and
don't await it. `withHeightRecovery` never settles there if its
attempt calls `queue`, and from a side effect it gets no recovery sync
before its 30 s deadline. Raw `kv/get` and `kv/set` don't use the
queue, so they settle (at worst, their waits for a height time out).

Awaiting another contract's KV writes from a side effect works, but
holds your contract's queue for as long as their recoveries take.
Event listeners and raw pubsub handlers aren't awaited, so they may
await anything.

### Replacing an app-level height guard

Apps used to guard KV writes themselves: a pre-flight
`chelonia/contract/sync`, a `.cause` walk looking for
`ChelErrorInvalidMessageHeight`, then a sync and a retry. Remove it:

| Guard | Replacement |
|---|---|
| Pre-flight `chelonia/contract/sync` before a write | Not needed: writes recover when they find the contract behind. |
| Sync and retry around `update` / `clear` / `queuedSet` | Built in (`onHeightAhead`, `maxHeightRecoveries`). |
| The same around raw `kv/get` / `kv/set` | `chelonia/kv/withHeightRecovery`. |
| `.cause` walk for a height error | `isKvHeightAhead(e)` (`findErrorCause` across your own wrappers); `isKvHeightMalformed(e)` for values to overwrite. |
| `e.name === 'ChelErrorKvConflict'` plus a retry | `isKvConflict(e)`; merge in the reducer / `onconflict`, or raise `maxAttempts`. |
| Telling an empty slot from one not loaded yet | `settledStatus` / `whenSettled`. |
| Remembering that the server holds a newer value | The entry's `heightAhead`. |

Caveats:

- A leftover guard that matches `e.name === 'ChelErrorInvalidMessageHeight'`
  silently stops working: the KV selectors now throw the errors above.
- `queuedSet` used to reject conflicts with `ChelErrorKvMaxAttempts`; it
  now rejects with `ChelErrorKvConflict` (same `.cause`). `isKvConflict`
  matches both.
- A write awaited from another contract's side effect may now sync while
  holding that contract's queue (see [Where not to await](#where-not-to-await)).
  Where that stall matters, don't await it, or pass
  `onHeightAhead: 'reject'`.

## `KvSlotDefinition` reference

| Field | Default | Purpose |
|---|---|---|
| `contractType` | (required) | Contract type/name string, or an array of strings. |
| `key` | (required) | KV key name. |
| `defaultValue` | `undefined` | Value returned by `chelonia/kv/read` before the slot is loaded or while it is in `'error'`. Never written into the raw mirror. |
| `schema` | none | Object with a synchronous `.parse(value)` method (e.g. a Zod schema). `null` / `undefined` are rejected anywhere in the value; model optional fields by omission or tagged unions, not `T \| null`. |
| `match` | `() => true` | Predicate `(cID, contractState, rootState) => boolean` deciding which contracts the slot attaches to. |
| `encryptionKeyName` | `'cek'` | Contract key name used for encryption. A missing named key rejects the write; set `null` explicitly to store plaintext. |
| `signingKeyName` | `'csk'` | Contract key name used for signing. A missing named key rejects the write. |
| `autoSubscribe` | `true` | Subscribe to pubsub for this slot automatically. |
| `autoLoad` | `'on-sync'` | `'on-sync'` loads on contract sync; `'on-demand'` waits for `chelonia/kv/sync` (or a successful `update`); `'never'` skips. |
| `refreshOnReconnect` | `true` | Re-fetch the slot on pubsub reconnect. |
| `defaultUpdater` | none | Factory `(value) => (prev) => next` enabling the plain-`value` form of `chelonia/kv/update`. |
| `onUpdate` | none | Callback `(value, ctx: KvUpdateCtx) => void` fired after every mirror change. Must not throw; must not synchronously call a same-contract KV write (rejected with `ChelErrorKvReentrant`; see the rejection taxonomy below). |

`KvUpdater<T>` receives `T | undefined`: `undefined` is passed when a slot
has neither a mirror value nor a `defaultValue`.

`chelonia/kv/set` now resolves to `{ etag: string | null }` instead of `void`; the return value is forwarded through `chelonia/kv/queuedSet` as well.

Slot values must reject `null` / `undefined` anywhere in the parsed value, not just at the root. This invariant is enforced for schema-backed and schemaless slots alike: `null` is reserved for wire-clear semantics and `undefined` for unloaded mirror state, so model optional fields as explicit tagged unions or by omitting the field rather than using `T | null`.

Slot writes resolve `encryptionKeyName` / `signingKeyName` inside the per-contract queue. A missing named encryption key rejects with `ChelErrorKvUpdateInvalid` instead of silently writing plaintext. Set `encryptionKeyName: null` explicitly to opt into plaintext slot storage. A missing signing key always rejects.

KV pubsub frames should carry `cid`; legacy or non-Chelonia frames without one still apply as `reason: 'remote'`, but preserve the mirror's previous etag and may cause extra conflict retries on the next local write.

Under sustained cross-client contention on a single key, a non-self remote frame that arrives while a conflict-resolved local write is still waiting for its echo forces one authoritative `chelonia/kv/get`. Consumers designing high-contention slots should expect up to one extra fetch per remote frame until the pending conflict marker is cleared.

## Filter ownership: don't mix slots with raw `setFilter`

Registering any slot for a contract transfers pubsub filter ownership
for that contract to the slot layer. The first slot to attach — even
one declared `autoSubscribe: false` — causes the library to emit a
`chelonia/kv/setFilter` frame for that contract. An
`autoSubscribe: false`-only contract therefore receives
`setFilter(cID, [])`, which tells the server to deliver no KV pubsub
for that contract.

Do not call `chelonia/kv/setFilter` directly on a contract that also
has declared slots, and do not rely on the default "receive all keys"
behavior for raw KV reads on such a contract. Use a dedicated contract
for raw-KV usage, or declare `autoSubscribe: true` slots for every key
you need delivered.

## Migration notes for direct `chelonia/kv/set` callers

The direct `chelonia/kv/set` contract has been widened to support the
slot-API plumbing. Three type-level changes are observable to existing
direct callers (the high-level slot API hides them):

- **`chelonia/kv/set` resolves to `Promise<{ etag: string | null }>`**
  (previously `Promise<void>`). Callers that simply `await` and ignore
  the result are unaffected at runtime; callers that annotate the result
  as `void` must drop that annotation or accept the returned object.
- **`onconflict` return type is now `Promise<[JSONType, string | undefined] | false>`**
  (previously `Promise<[JSONType, string]>`). The `etag` element may be
  `undefined` when the server returned neither `x-cid` nor `etag`
  (typical for 404 / 410 fall-throughs); the primitive substitutes
  `''` at the wire so the POST still goes through.
- **Any falsy `onconflict` return aborts the write** (including `false`,
  `null`, `undefined`, `0`, `''`). The runtime `if (!result) return false`
  guard already existed pre-revamp, so a falsy return always silently
  aborted; the type now *advertises* `false` as a valid return value
  where previously it was only representable at the type level as a
  tuple. No runtime behaviour change for existing callers.

Behaviour changes (see [Contract heights](#contract-heights)):

- **A `409` (stale height stamp) is no longer a conflict.** It doesn't
  call `onconflict` or count against `maxAttempts`: `kv/set` re-signs,
  or rejects with `ChelErrorKvHeightAhead` (`exact: false`).
- **Unverifiable values reject** with `ChelErrorKvHeightAhead` /
  `ChelErrorKvHeightMalformed` (from `kv/get`, and from `kv/set` instead
  of reaching `onconflict`), not with `ChelErrorInvalidMessageHeight`.
- **Invalid options throw up front.** A bad `maxAttempts` or
  `heightWaitMs`, or `data === undefined` without `onconflict`, throws a
  `TypeError` before any request.

## Schema-driven default normalization

If a slot's `schema` is a `.transform()` (or otherwise mutating)
parser, `defineSlot` runs the resolved `defaultValue` through
`schema.parse` once and stores the **post-parse** value as the slot's
effective default. Every `chelonia/kv/read` that falls back to the
default returns a deep clone of the post-parse value, not the raw
`defaultValue` you passed in. The parse must be idempotent
(`parse(parse(x))` structurally equal to `parse(x)`); registration
throws `ChelErrorKvSlotInvalid` otherwise.

## `chelonia/kv/update` rejection taxonomy (extended)

In addition to the cases listed in KV-REVAMPED.md §4.2,
`chelonia/kv/update` (and `chelonia/kv/clear`) reject with
`ChelErrorKvUpdateInvalid` when:

- The reducer (or `defaultUpdater` factory) **throws**. The original
  error is preserved on `.cause`.
- The reducer returns `null` or `undefined`. Use `KV_NOOP` to abort a
  write explicitly; bare `null`/`undefined` collides with the wire
  clear sentinel and the "not yet loaded" mirror representation.

Both rules apply identically on the first attempt and on every
conflict-retry pass.

`chelonia/kv/update`, `chelonia/kv/clear`, `chelonia/kv/sync`,
`chelonia/kv/queuedSet`, `chelonia/kv/withHeightRecovery` and a
`chelonia/kv/whenSettled` that would wait also reject with
`ChelErrorKvReentrant` when called for the **same
contract** from within the *synchronous* portion of that contract's own
`onUpdate` callback. `onUpdate` holds the per-contract
`chelonia/queueInvocation` lane, so a same-contract write issued during
the callback would enqueue behind the lane that is blocked awaiting the
callback — a deadlock. The guard is narrow (synchronous portion only)
so it never rejects an *independent* concurrent write that interleaves
with a slow async `onUpdate` (those queue safely and succeed).
`chelonia/kv/read` / `chelonia/kv/status` (synchronous, unqueued) and
writes to *other* contracts are always unaffected. To re-enter a
same-contract write, schedule it off the synchronous stack and do not
await it inside the callback:
`queueMicrotask(() => sbp('chelonia/kv/update', …))` — it queues
behind the lane and runs once it releases.

**Reducer basis.** `update` reloads the slot before running the
reducer when the mirror can't be trusted: the slot is `'loading'` or
has `heightAhead`, the attempt follows a height recovery, the slot
hasn't settled and you passed `ifMatch`, or the slot is `'error'` but
still holds a value (seeding that write from the default could
overwrite the live value). These reloads emit `'load'` events and call
`onUpdate` like any load. If one fails, `update` rejects without
running the reducer when the slot was `'loading'` or had `heightAhead`,
or you passed `ifMatch`; otherwise the reducer runs on the mirror (or
the `'error'` slot's retained value) under the mirror's etag, and a
`KV_NOOP` rejects with the reload error (it resolves for the retained
value). Without those triggers, a slot that hasn't settled yet isn't
reloaded first: its reducer runs on the mirror or default, and a
`KV_NOOP` there forces one reload and a second run. Fine print:
[KV-REVAMPED.md §3.4](specs/KV-REVAMPED.md#34-height-stamps-verifiability-and-recovery)
("Reducer basis").

**Abort after commit:** a `signal` that aborts after the server
accepted the write doesn't undo it: the mirror is updated, events fire
and `update` resolves with the committed value.

## Inline definition via `chelonia/defineContract`

Slots can also be declared inline on a contract definition under the
`kv` key. `chelonia/defineContract` registers each entry automatically
under the contract name (the type stored for synced contracts) and diffs
added/removed keys on re-registration.

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

## KV_NOOP sentinel

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

## Consumer caveats

Semantics that bite consumers who don't expect them. Internal
implementation detail (echo suppression, conflict-marker ordering,
filter-flush retries, the mirror's internal layout) is intentionally
omitted here; the source is authoritative.

- **Mirror `value` is canonical.** `rootState._kv[contractID][key].value`
  is always either a server-confirmed payload or `undefined`. A first-load
  404, a local `clear`, and a remote wire-`null` clear all leave
  `value === undefined`; the declared default is surfaced only through
  `chelonia/kv/read` and `onUpdate`, never written into the raw mirror.
  Direct `rootState._kv` readers must treat `status`, not `value`, as the
  source of truth and substitute the default via `value ?? read(cID, key)`.

- **Unloaded writes merge.** `chelonia/kv/update` derives its `if-match`
  precondition from the mirror etag (`""`, meaning "no value", if the
  slot never held one), so a server value this client never read comes
  back as a `412` and the reducer re-runs on it instead of overwriting it.
  An `'on-demand'` / `'never'` slot can therefore `update` without a
  `chelonia/kv/sync` first, at the cost of that extra round trip.

- **`update` resolves with the committed value.** If the slot is replaced
  (`defineSlot`/HMR) or dropped after the server write commits, `update`
  still resolves with that committed value. `undefined` is reserved for
  `KV_NOOP` ("no write happened"), so callers can distinguish a
  persisted write from a genuine no-op.

- **Event ordering.** `CHELONIA_KV_UPDATED` fires *before* the slot status
  transitions, so an updated-handler that reads `chelonia/kv/status` sees
  the pre-transition status (e.g. `'loading'` on a first successful load).
  The `defineSlot`-replacement re-validate path is the exception: it flips
  status to `'loaded'` first. Either way, use `chelonia/kv/whenSettled` /
  `settledStatus` (see [Pending vs settled](#pending-vs-settled)), not the
  status seen inside a `CHELONIA_KV_UPDATED` handler. A first load of a
  never-written key emits only `CHELONIA_KV_STATUS_CHANGED` (`non-init ->
  loading -> non-init`), not `CHELONIA_KV_UPDATED`, because the value did
  not change.

- **`CHELONIA_KV_UPDATED` does not guarantee a change.**
  `chelonia/kv/clear` always emits, whereas a no-op first load suppresses
  the event, so the event fires on a superset of real changes. Compare
  `previousValue` against `value` if you need strict change detection.

- **Payloads are detached clones.** The `value` / `previousValue` fields
  on `CHELONIA_KV_UPDATED` and the `value` argument to `onUpdate` are deep
  clones of the mirror, not live references. Mutating them is safe (it
  cannot corrupt the mirror or other observers) but is not reflected back
  into the mirror; use `chelonia/kv/update` to persist a change.

- **`onUpdate` must be idempotent.** A slot replaced via `defineSlot` (or
  HMR) during an in-flight async load/write may still see its previous
  definition's `onUpdate` fire once after the replacement's own
  revalidation. Callbacks must not assume they are still the active slot
  for the contract/key.

- **`chelonia/reset` drains, then cancels, KV work.** `reset` first lets
  each contract's queue drain (writes already queued normally finish),
  then aborts: a write still queued or not yet sent (e.g. reloading its
  basis) rejects with an `AbortError` and writes nothing, as do running
  single-key `chelonia/kv/sync` calls. It waits for writes in flight to
  settle before `postCleanupFn`; clearing the KV runtime maps afterwards
  rejects pending `whenSettled` calls with an `AbortError` and ends the
  slots' waits for contract heights. Persistence hooks therefore observe
  a quiescent mirror, and continuations never run against torn-down
  state.

- **A resync keeps the mirror.** While a contract re-syncs, its slots
  are inactive (`read` / `update` / single-key `sync` reject with
  `ChelErrorKvSlotUnknown`, `status` is `'non-init'`, `whenSettled` keeps
  waiting), but their entries keep values and statuses. The slots reload
  once active again; entries of slots no longer claimed are dropped.
