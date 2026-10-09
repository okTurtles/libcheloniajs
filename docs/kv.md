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
`{ value: JSONType | undefined, etag: string | null, status: KvLoadStatus, lastError?, settled? }`
— so `chelonia/kv/read` answers synchronously from local state and
consumers never call `chelonia/kv/get` for a declared slot.

The library keeps the replica in lockstep with the server through four
update channels, each surfaced as a distinct `reason` on
`CHELONIA_KV_UPDATED` / `onUpdate`: the initial fetch after contract
sync (`'load'`), pubsub pushes from other clients (`'remote'`), this
client's own successful writes (`'local'`), and re-fetches after a
websocket reconnect (`'reconnect'`). Every channel validates the value
against the slot's `schema` before it lands and pairs the value with its
etag, so the mirror never holds a value the server didn't confirm.
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

### Pending vs. settled

`status: 'non-init'` is both what a freshly seeded slot reports while
its first load is still pending and what a slot reports after the last
verifiable read found no value (a 404, or a clear) and nothing since has
found one. The entry's `settled` flag tells them apart: it is `false`
when the slot is (re)activated and becomes `true` on the first terminal
outcome — a load (value or 404), an applied pubsub frame, a committed
local `update` / `clear`, or a terminal error. A load abandoned because
its slot was replaced mid-flight, or deferred because the server value
is ahead of the local contract (see [Contract heights](#contract-heights)),
does not settle the slot. `CHELONIA_KV_STATUS_CHANGED` carries `settled`
and `previousSettled`.

A `'non-init'` slot, settled or not, whose load or pubsub frame finds a
value written at a contract height the local contract hasn't reached
goes `'loading'`: the server value isn't absent, it just can't be
verified yet. It then goes `'loaded'` once the contract catches up, or
`'error'` if it can't (see [Contract heights](#contract-heights)). So a
settled `'non-init'` never hides a value the server is known to hold.

To run code once a slot has settled, check the flag, or wait for it:

```ts
const status = await sbp('chelonia/kv/whenSettled', contractID, 'unreadMessages', { signal })
// 'loaded' | 'non-init' (no value found) | 'error'
```

`whenSettled` also waits for the contract to sync and the slot to
activate, rejects when `signal` aborts or on `chelonia/reset`, and never
resolves for a slot that is never loaded (`autoLoad: 'never'`, or
`'on-demand'` without a `sync`/`update`/`clear`). It never resolves with
`'loading'`: once settled, a slot stays settled while it reloads (and
reports `'loading'` meanwhile, unless it holds a value), and
`whenSettled` waits for the reload to finish. Only an active slot's
`settled` counts: an entry persisted by an earlier session may still
carry `settled: true` until its slot is activated again.

A reducer passed to `chelonia/kv/update` never runs against a value
that couldn't be verified, or against the default in its place (see
[Contract heights](#contract-heights)). Two cases remain where the first
attempt doesn't run on a value verified just now:

- A slot that has never loaded (`autoLoad: 'never'`, or `'on-demand'`
  without a `sync`) runs it on the default. A write is then still guarded
  (it is sent with `if-match: ""` and merged on the `412`), but a reducer
  that returns `KV_NOOP` on the default sends nothing. When that would be
  wrong, `sync` the slot (or `await whenSettled`) first.
- An `'error'` slot holding a value whose reload fails runs it on the
  retained value, the last one this client verified (see the
  [rejection taxonomy](#cheloniakvupdate-rejection-taxonomy-extended)).
  A `KV_NOOP` then resolves `undefined`.

An `'error'` slot without a value reloads first. If that reload, or the
reload after a height recovery, fails, the reducer still runs (on the
default, or the current mirror value) and a write is still guarded by its
`if-match`, but a `KV_NOOP` rejects with the reload's error: nothing
confirmed that there was nothing to write.

## Contract heights

Every KV value is stamped with the contract height at which it was
written, and this has two consequences for clients:

- **A value can only be verified once the local contract has reached
  its height.** The signing key's validity is checked against the local
  contract state, so a client that is behind (other devices have
  published contract events it hasn't processed yet) can't verify a value
  written after those events.
- **The server only accepts a write stamped with its current contract
  height.** A client that is even one event behind gets a `409` until it
  catches up.

The library handles both, so that an unverifiable value is never
mistaken for an absent one (which used to silently drop writes, or
overwrite the other device's value with a default-seeded one):

- `chelonia/kv/set` waits briefly for the local contract to catch up:
  up to 1.5 s per stale stamp (`409`), for up to 5 stamps per call, plus
  up to 1.5 s per conflicting value that is ahead. The wait is passive
  (contract events keep being processed), but when `kv/set` runs inside
  `update`, `clear` or `queuedSet`, the contract's `queueInvocation` lane
  stays held during it. While the pubsub socket isn't open, no contract
  event can arrive, so `kv/set` doesn't wait at all (a client whose
  socket is open but slow still waits; without a pubsub client, e.g.
  server-side, it waits too). A `409` is then re-signed with the same
  data (up to 5 times; this doesn't count against `maxAttempts`); a
  conflicting value that is still ahead makes the call reject with
  `ChelErrorKvHeightAhead` instead of reaching `onconflict`. `kv/set`
  itself never syncs the contract.
- `chelonia/kv/update`, `chelonia/kv/clear` and `chelonia/kv/queuedSet`
  go further: on `ChelErrorKvHeightAhead` they sync the contract (outside
  the queue lane) and try again, up to `maxHeightRecoveries` (default 2)
  times. Pass `onHeightAhead: 'reject'` to get the error instead. A sync
  that fails, or takes longer than 30 s, ends the recovery unless the
  contract reached the height anyway (e.g. through pubsub); after such a
  timeout the retry waits for the sync to finish, since it runs on the
  contract's queue.
  Before running its reducer, `update` reloads a slot whose server value
  is known to be ahead (its load is deferred or gave up, the reload that
  follows reaching the height is still queued, or a single-key `sync` is
  recovering it), so the reducer never runs against the default, or a
  stale value, in place of that value.
- A slot load or pubsub frame whose value is ahead doesn't fail: the
  slot keeps its value and status (a slot without a value that isn't in
  `'error'`, including a settled `'non-init'` one, goes or stays
  `'loading'`; an `'error'` slot stays `'error'`, with its `lastError`)
  and reloads the key once the contract catches up. If it hasn't after
  10 s, the library syncs the contract; if that doesn't help either, the
  slot settles: a slot that holds a value keeps it, and its status and
  `lastError` (`'loaded'`, or `'error'`), any other slot settles to
  `'error'` (`lastError.name === 'ChelErrorKvHeightAhead'`).
  Either way the slot remembers that the server value is ahead: it still
  reloads the key if the contract catches up later, and `update` keeps
  refusing to run its reducer on the stale value or the default until
  then. The next load or frame that finds the value ahead starts over
  (with a new 10 s fallback). The raw
  `NOTIFICATION_TYPE.KV` handler passed to `chelonia/connect` is not
  called for frames that are ahead: define a slot for the key to receive
  the value once the contract catches up.
- `chelonia/kv/sync` for a single key waits up to 1.5 s, then syncs the
  contract and loads again, up to `maxHeightRecoveries` (default 2) times,
  before rejecting (and settling the slot as above). If the contract has
  reached the height by then, it loads once more instead (waiting for a
  recovery sync that is still running, since the load is queued behind
  it). With the default
  timings that can take about a minute when the syncs are slow; it takes
  the same `signal`, `onHeightAhead` and `maxHeightRecoveries` options as
  `update`. Meanwhile the slot keeps knowing that its value is stale, so
  `update` doesn't run its reducer on it.

KV writes made from code that holds another contract's queue (e.g. a
contract `sideEffect`, or a listener of an event emitted while a contract
event is processed, such as Group Income's `MESSAGE_RECEIVE_RAW`
handlers) shouldn't be awaited there: waiting for heights, or for a
recovery sync, would hold that queue too.

`ChelErrorKvHeightAhead` extends `ChelErrorInvalidMessageHeight`, but has
its own `name`; match it with `isKvHeightAhead(e)` (exported, and
name-based, so it also matches errors from another copy of the library),
and read its `.cause` (`{ requiredHeight, exact, localHeight, etag,
status }`) with `kvHeightAheadCause(e)`. A slot's stored `lastError`
keeps only `name` and `message`, so it has no `.cause`:
`isKvHeightAhead(lastError)` still matches, and `kvHeightAheadCause`
returns `undefined` for it. A
value with a malformed height stamp is rejected with
`ChelErrorInvalidMessageHeight`. A stamp must be a non-negative integer
or its plain decimal string: `"1e1"`, `"010"` or `" 10"` are malformed,
because a stamp read differently by different parsers could get a value
verified against the wrong key validity window. See KV-REVAMPED.md §3.4
for the full rationale. Such a value can never be verified, so `update`,
slot loads and `kv/get` keep rejecting (the slot shows `'error'`), and
retrying can't help. `chelonia/kv/clear` overwrites it, and so does a
`kv/set` or `queuedSet` with `allowUnverifiedConflict: true`, whose
`onconflict` then gets `currentStatus: 'malformed'`.

### Replacing an app-level height guard

Apps that wrapped KV writes in "sync the contract first" and/or "sync and
retry on a height error" helpers should delete them:

- `chelonia/kv/update`, `chelonia/kv/clear`, `chelonia/kv/queuedSet` and
  single-key `chelonia/kv/sync` already force-sync the contract (outside
  the queue lane) and retry on `ChelErrorKvHeightAhead`, up to
  `maxHeightRecoveries` times, also when the recovery sync fails but the
  contract reached the height anyway. Wrapping them again only adds sync
  rounds. Call them directly.
- A pre-write `chelonia/contract/sync` isn't needed for correctness: a
  stale height stamp comes back as a `409`, which `kv/set` re-signs, and
  a value that is ahead is recovered as above. It isn't free to drop,
  though. A client that is behind and gets no pubsub event first waits
  for one (up to 1.5 s per stale stamp, see above) before syncing. With
  production timings, a write from such a client took about 1.5 s without
  the pre-flight, against about 20 ms with it. While the pubsub socket is
  closed `kv/set` doesn't wait, which removes most of that difference; a
  client whose socket is open but that misses an event still waits. A
  current client, on the other hand, pays for the pre-flight's sync on
  every write.
- Replace `e.name === 'ChelErrorInvalidMessageHeight'` checks (with or
  without a walk along `.cause`) with `isKvHeightAhead(e)`: no library
  path wraps `ChelErrorKvHeightAhead`. The old name now only matches a
  value whose height stamp is malformed, which no sync or retry can fix
  (see above): `clear` it instead.
- A `409` no longer counts against `maxAttempts`, so running out of
  attempts means real contention. Match it with `isKvConflict(e)`, which
  matches the `ChelErrorKvConflict` of `update`, `clear` and `queuedSet`
  (and the internal error of raw `kv/set`), and raise `maxAttempts` if it
  happens too often.
- Raw `chelonia/kv/set` and `chelonia/kv/get` only wait and reject: their
  callers still handle `isKvHeightAhead(e)` themselves.

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

Five runtime changes come with height-aware conflict handling (see
[Contract heights](#contract-heights)):

- **A `409` no longer calls `onconflict`.** The server checks `if-match`
  before the height stamp, so a `409` means the data is still right and
  only the stamp is stale. `kv/set` waits for the local contract to move
  past it and signs the same data again. A `409` therefore also works
  without an `onconflict` handler.
- **`maxAttempts` only counts conflicts (`412`).** Re-signing after a
  `409` is bounded separately (5 times per call), and running out of
  those retries rejects with `ChelErrorKvHeightAhead`.
- **`kv/set` never syncs the contract.** After its bounded wait (or the
  5 re-signs) it rejects with `ChelErrorKvHeightAhead`, and callers of
  raw `kv/set` handle `isKvHeightAhead(e)` themselves: sync the contract
  with `chelonia/contract/sync` (outside the contract's queue, or the
  sync waits behind the write), then retry. `queuedSet` and
  `chelonia/kv/update` do this automatically.
- **An unverifiable conflicting value no longer reaches `onconflict` as
  `currentData: undefined`.** `kv/set` rejects with
  `ChelErrorKvHeightAhead` instead (after a short wait). `onconflict`
  receives `currentStatus: 'absent' | 'present'`, so it can tell an
  empty server apart from a value. `'present'` means the value can be
  verified: decryption and signature verification still happen lazily,
  when `currentData` is read, which may throw. A blind writer that
  doesn't care about the current value can pass
  `allowUnverifiedConflict: true` (to `kv/set` or `queuedSet`) to be
  called with `currentStatus: 'ahead'` (and a `requiredHeight`) instead;
  `currentData` then throws `ChelErrorKvHeightAhead`.
- **A malformed height stamp is an error.** It used to be treated like
  an absent value. With `allowUnverifiedConflict: true`, `onconflict` is
  called with `currentStatus: 'malformed'` instead, and `currentData`
  throws `ChelErrorInvalidMessageHeight`. An exhaustive `switch` on
  `currentStatus` needs a case for it.

`chelonia/kv/get` rejects with `ChelErrorKvHeightAhead` for a value that
is ahead. It used to reject with a plain `ChelErrorInvalidMessageHeight`:
`instanceof ChelErrorInvalidMessageHeight` still matches, but a check of
`e.name === 'ChelErrorInvalidMessageHeight'` (e.g. one that has to work
across separately bundled copies of the library) no longer does. Use
`isKvHeightAhead(e)`.

Running out of `maxAttempts` still rejects raw `kv/set` with an internal
error (`ChelErrorKvMaxAttempts`, `.cause` `{ currentData, etag }`).
`chelonia/kv/queuedSet` now remaps it to the public `ChelErrorKvConflict`
with the same `.cause`, like `update` and `clear`: a check of a
`queuedSet` rejection with `instanceof ChelErrorKvMaxAttempts`, or by that
name, no longer matches. Use `isKvConflict(e)`, which matches both.

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

In addition to the cases listed in KV-REVAMPED.md §4.6,
`chelonia/kv/update` (and `chelonia/kv/clear`) reject with
`ChelErrorKvUpdateInvalid` when:

- The reducer (or `defaultUpdater` factory) **throws**. The original
  error is preserved on `.cause`.
- The reducer returns `null` or `undefined`. Use `KV_NOOP` to abort a
  write explicitly; bare `null`/`undefined` collides with the wire
  clear sentinel and the "not yet loaded" mirror representation.
- `onHeightAhead` is not `'sync'` / `'reject'`, or `maxHeightRecoveries`
  is not a non-negative integer.

The two reducer rules apply identically on the first attempt and on every
conflict-retry pass. The option check runs once, before the first attempt
and before any network access; `chelonia/kv/queuedSet` and single-key
`chelonia/kv/sync` reject invalid options the same way.

A reducer that returns `KV_NOOP` makes `update` resolve `undefined`,
except when a reload that `update` needed failed: the reload of an
`'error'` slot without a value, or the reload after a height recovery.
`update` then rejects with that reload's error (e.g.
`ChelErrorUnexpectedHttpResponseCode`): nothing confirmed that there was
nothing to write. After a failed reload of an `'error'` slot that still
holds a value (see below), a `KV_NOOP` resolves `undefined`.

`chelonia/kv/update`, `chelonia/kv/clear`, and `chelonia/kv/sync` also
reject with `ChelErrorKvReentrant` when called for the **same
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

When a slot is in `'error'` status but still holds a retained value,
`update` first performs one silent authoritative reload and seeds the
reducer from the refreshed (or retained, if the reload fails) mirror
value, not from the declared default. This prevents the silent data
loss that would occur if a default-seeded write carrying the retained
etag matched and overwrote the live server value. If the reload finds
the server value ahead, the retained value is known to be stale:
`update` recovers (it syncs the contract and tries again, as for any
`ChelErrorKvHeightAhead`) instead of seeding from it. An `'error'` slot
with no retained value reloads first too (non-silently), and a
`KV_NOOP` rejects when that reload fails (see
[Pending vs. settled](#pending-vs-settled)).

**Abort after commit:** when the caller's `signal` aborts in the window
after `chelonia/kv/set` resolves, the write has already committed
server-side and its pubsub echo is deliberately suppressed. The mirror
(value and etag) stays stale until the next remote frame, local write,
or explicit `chelonia/kv/sync`. Other clients see the new value
immediately. Call `chelonia/kv/sync` after aborting if you need the
mirror reconciled.

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

- **Unloaded writes merge; they don't clobber.** `chelonia/kv/update`
  derives its `if-match` precondition from the mirror etag. A never-loaded
  (`'non-init'`) slot has `etag: null`, so its first `update` is sent with
  `if-match: ""` ("the key must not exist"). If the server already holds a
  value, the write gets a `412` and the reducer is re-run against the
  server value, at the cost of one extra round trip. For `'on-demand'` /
  `'never'` slots, calling `chelonia/kv/sync` before `update` avoids that
  round trip. A reducer that returns `KV_NOOP` against the default,
  though, sends nothing and so never sees the server value; sync first
  when that matters.

- **`update` resolves with the committed value.** If the slot is replaced
  (`defineSlot`/HMR) or dropped after the server write commits, `update`
  still resolves with that committed value. `undefined` is reserved for
  `KV_NOOP` / abort ("no write happened"), so callers can distinguish a
  persisted write from a genuine no-op.

- **Event ordering.** `CHELONIA_KV_UPDATED` fires *before* the slot status
  transitions, so an updated-handler that reads `chelonia/kv/status` sees
  the pre-transition status (e.g. `'loading'` on a first successful load).
  The `defineSlot`-replacement re-validate path is the exception: it flips
  status to `'loaded'` first. Either way, derive a "settled" signal from
  the entry's `settled` flag (or `chelonia/kv/whenSettled`), not from
  inside a `CHELONIA_KV_UPDATED` handler. A first load of a never-written key
  emits only `CHELONIA_KV_STATUS_CHANGED` (`non-init -> loading ->
  non-init`), not `CHELONIA_KV_UPDATED`, because the value did not change.

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

- **`chelonia/reset` drains in-flight KV writes.** `reset` aborts
  stuck/offline network work, then waits for in-flight
  `chelonia/kv/update` / `chelonia/kv/clear` writes (and any contract
  sync started to recover from `ChelErrorKvHeightAhead`) to settle before
  `postCleanupFn` and before clearing the KV runtime maps (matching
  `chelonia/contract/wait`), so persistence hooks observe a quiescent
  mirror and continuations never run against torn-down state. Deferred
  reloads are cancelled.

- **Height recovery syncs the contract.** When `update`, `clear` or
  `queuedSet` recovers from a value that is ahead, it runs a forced
  contract sync (outside the KV queue lane) before retrying, which takes
  a network round trip. `onHeightAhead: 'reject'` skips only that sync:
  `kv/set`'s passive waits (see [Contract heights](#contract-heights))
  still run, with the contract's queue lane held, before the call
  rejects with `ChelErrorKvHeightAhead`. Hot paths shouldn't await KV
  writes at all.
