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
etag, so the mirror never holds a value the server didn't confirm.
Because the mirror lives inside Chelonia's root state, it is projected
into external stores (Vuex, Pinia) by `chelonia/externalStateSetup`
with no per-key wiring — see
[External state sync](./api.md#external-state-sync).

### Lazy initialization

The mirror and its entries are created lazily:

- `chelonia/_init` creates `rootState._kv` on Chelonia's own state, as a
  null-prototype plain object via `config.reactiveSet` so reactive
  frameworks (e.g. Vue) observe additions. To restore a persisted
  mirror, pass it to `chelonia/reset(newState)`, which marks every
  restored entry `settled: false`. An app store selected with
  `stateSelector` that already holds `_kv` keeps its raw `settled` flags
  until each slot activates: read `settledStatus`, or gate on active
  slots only (see [Pending vs. settled](#pending-vs-settled)).
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
and `previousSettled`. It is also emitted, with the status unchanged, when
the (re)activation of a settled entry (e.g. one persisted by an earlier
session) resets `settled` to `false`, so an external store
(`chelonia/externalStateSetup`) follows.

A `'non-init'` slot, settled or not, whose load or pubsub frame finds a
value written at a contract height the local contract hasn't reached
goes `'loading'`: the server value isn't absent, it just can't be
verified yet. It then goes `'loaded'` once the contract catches up, or
`'error'` if it can't (see [Contract heights](#contract-heights)). Likewise,
an outcome that finds no value (a load's `404` or cleared value, a remote
clear, a committed `clear`) settles the slot `'loading'`, not
`'non-init'`, while a wait for a value that is ahead remains for the key
(one registered while that request was in flight). So a
settled `'non-init'` never hides a value the server is known to hold.

A slot has settled when its entry has `settled && status !== 'loading'`,
on an active slot: once settled, a slot stays settled while it reloads
(until it is re-activated, e.g. by a resync),
and a reload that reports `'loading'` hasn't reported an outcome yet (e.g. a
settled `'non-init'` slot whose server value turns out to be ahead). In a
store copy of the mirror (`chelonia/externalStateSetup`), check both.
Outside a store, ask, or wait:

```ts
sbp('chelonia/kv/settledStatus', contractID, 'unreadMessages')
// 'loaded' | 'non-init' (no value found) | 'error', or undefined until it settles

const status = await sbp('chelonia/kv/whenSettled', contractID, 'unreadMessages', {
  signal: AbortSignal.timeout(30_000)
})
// 'loaded' | 'non-init' | 'error'
```

`settledStatus` is `undefined` for a slot that isn't active (also for an
entry persisted by an earlier session: `chelonia/reset(newState)`
restores every KV entry with `settled: false`, and only an active slot's
flag counts). `whenSettled` waits for the contract to sync and a defined
slot to activate, and never resolves with `'loading'`. It rejects with
`ChelErrorKvSlotUnknown` when the slot can't settle:

- at once when no slot is defined for the key (for the contract's type,
  once known), e.g. a misspelled key;
- at once when the contract's slots have been reconciled (it has synced)
  and the slot isn't active for it: its `match` is false;
- while it waits, when the contract's type turns out to have no such
  slot, its slot doesn't activate (`match` is false) or is deactivated
  (its `match` turns false, or it is unregistered), or the contract is
  released, also before the slot ever activated (e.g. its first sync
  failed).

It also rejects when `signal` aborts (at once if it already has), or on
`chelonia/reset`. A resync of the contract (e.g. a dirty one) doesn't
reject it: it settles once the slot has reloaded after the resync. A
resync keeps the mirror entries and their values, but it re-activates the
slots, so they go `settled: false` until that reload (which reports a
value removed meanwhile, as a reconnect reload does), and `read` throws
`ChelErrorKvSlotUnknown` while the resync runs. If the
resync fails, it waits until the contract is released, or `signal`
aborts. `match` is only evaluated again by `chelonia/kv/refreshFilters`:
`whenSettled` doesn't wait for a `match` that may turn true later.

It never resolves for a slot that is never loaded: `autoLoad: 'never'`,
or `'on-demand'`, without a `sync`, `update` (a `KV_NOOP` one too),
`clear` or applied pubsub frame. Pass a `signal` when that can happen.

Which reloads report `'loading'`: `sync`'s own loads (aggregate, or the
first round of a single-key `sync`), and reconnect and resync reloads. A
`'loaded'` slot keeps its status during the other reloads: deferred
reloads, `update`'s reloads, the reload after a pubsub conflict and the
later rounds of a single-key `sync`.

Like `sync` and `update`, don't await a `whenSettled` that has to wait
from code that the contract's lanes await (a `sideEffect`, a
`queueInvocation` body, an `onconflict`, an `onUpdate`): the load it
waits for queues behind that code, so it never resolves (see
[How height recovery runs](#how-height-recovery-runs)). Only a call from
the synchronous part of a same-contract `onUpdate` is detected
(`ChelErrorKvReentrant`). On a settled slot it resolves at once.

A reducer passed to `chelonia/kv/update` never runs against a value
that couldn't be verified, or against the default in its place (see
[Contract heights](#contract-heights)). A slot that hasn't settled in
this activation (never loaded, or persisted by an earlier session) isn't
loaded up front: the reducer runs on the mirror value (or the default),
and the write carries the mirror's etag in `if-match` (`""` for a slot
without a value), so a server value this client never read comes back as
a `412` and is merged in `onconflict`. The commit settles the slot. Only
when the reducer returns `KV_NOOP`, which writes nothing, is the slot
loaded and the reducer run again on what the load found; if that load
fails, the `KV_NOOP` rejects with the load's error. A caller's own
`ifMatch` (e.g. `'*'`) wouldn't catch such a value, so with it the slot
is loaded first; if that load fails, the call rejects with its error,
without running the reducer.

One case remains where a `KV_NOOP` resolves on a basis that this
activation didn't confirm: an `'error'` slot holding a value whose reload
fails runs the reducer on the retained value, the last one this client
verified (see the
[rejection taxonomy](#cheloniakvupdate-rejection-taxonomy-extended)).
That is unless the library knows the server holds a value it couldn't
verify (below). This data-loss guard applies to every `'error'` slot
that holds a value, also one persisted by an earlier session: it takes
precedence over the lazy handling of a slot that hasn't settled, above.
When its reload succeeds, the slot reports it as any load does (a
`'load'` event and `onUpdate`) and leaves `'error'`, also when the
reducer then returns `KV_NOOP`.

An `'error'` slot without a value is handled like a slot that hasn't
settled. If the reload after a `KV_NOOP`, or the reload after a height
recovery, fails, the reducer still runs (on the default, or the current
mirror value) and a write is still guarded by its `if-match`, but a
`KV_NOOP` rejects with the reload's error: nothing confirmed that there
was nothing to write. With the caller's own `ifMatch`, which guards
nothing of the kind, the call rejects with the reload's error instead.
A mirror known to hold an unverifiable value (see
[Contract heights](#contract-heights)) reloads first; if that reload
fails, the attempt rejects with the reload's error without running the
reducer.

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
  (contract events keep being processed), but a caller that holds the
  contract's `queueInvocation` lane keeps holding it during the wait.
  Its `heightWaitMs` option sets the longest wait (`0` skips it). While
  the pubsub socket isn't open, no contract event can arrive, so `kv/set`
  doesn't wait at all (a client whose socket is open but slow still
  waits; without a pubsub client, e.g. server-side, it waits too). A
  `409` is then re-signed with the same data (up to 5 times; this
  doesn't count against `maxAttempts`); a conflicting value that is
  still ahead makes the call reject with `ChelErrorKvHeightAhead` instead
  of reaching `onconflict`. A `409` while a sync of the contract is
  running (e.g. one catching up after a reconnect) first waits for that
  sync to end, within the same budget: signing again at each height the
  sync replays would only get more `409`s. A sync that doesn't end in
  time makes the call reject with `ChelErrorKvHeightAhead` after that one
  `409`, which the selectors below (and `withHeightRecovery`) recover from
  once the sync has ended. `kv/set` itself never syncs the contract.
- `chelonia/kv/update`, `chelonia/kv/clear` and `chelonia/kv/queuedSet`
  go further: on `ChelErrorKvHeightAhead` they sync the contract and try
  again, up to `maxHeightRecoveries` (default 2) times. They wait for that
  sync holding no lane; the sync itself runs on the contract's internal
  lane (see [How height recovery runs](#how-height-recovery-runs)). Since
  they recover anyway, they skip `kv/set`'s passive wait
  (`heightWaitMs: 0`), so a client that is behind doesn't hold the lane
  for it: its write costs one sync per round instead. The last attempt
  keeps the passive wait, since it is then the write's only chance, so
  `maxHeightRecoveries: 0` means "wait passively, never sync". That
  includes `update`'s reload of a slot known to be ahead (below): on the
  last attempt, it waits passively for the height, then reloads once
  more, before giving up. Pass `onHeightAhead: 'reject'` to get the
  error at once instead, without
  waiting or syncing; nothing then retries the write (a deferred reload
  only refreshes the slot's mirror, and only for a value that is ahead,
  not after a stale-stamp `409`), so use it only when the caller re-issues
  the write itself. The deferred reload's wait still arms its 10 s
  fallback, which forces one contract sync if the height hasn't arrived
  by then. A sync that takes longer than 30 s ends the recovery
  unless the contract reached the height anyway (e.g. through pubsub),
  and so does a sync that fails, unless the contract reaches the height
  within a short passive wait (1.5 s; none while the pubsub socket is
  closed). After such a timeout the retry waits for the sync to finish,
  since it is queued behind it (a `signal` still ends the write at once).
  No sync runs when the contract has already reached the height by the
  time the attempt failed (e.g. through pubsub): the attempt simply runs
  again. After a recovery,
  `update` reloads the slot before running its reducer again (the value
  that just became verifiable is its basis), except when the attempt
  failed on a plain `409` (a stale stamp, with no `412` before it): its
  `if-match` held, so the mirror still matches the server. Nor does it
  reload a value that the slot's deferred reload, queued ahead of the
  retry, has just loaded (the value the failed attempt found ahead): a
  recovery reloads each value once.
  Before running its reducer, `update` reloads a slot whose server value
  is known to be ahead (its load is deferred or gave up, the reload that
  follows reaching the height is still queued, or a single-key `sync` is
  recovering it), so the reducer never runs against the default, or a
  stale value, in place of that value. When `update` gives up on such a
  value (`onHeightAhead: 'reject'`, no recoveries left, a recovery sync
  that failed or timed out, or an abort, by `signal` or `chelonia/reset`,
  while it recovers), the slot remembers it exactly as a load that found
  it would (see the next item): a settled `'non-init'` slot goes
  `'loading'`, and the slot reloads once the contract reaches the height.
- A slot load or pubsub frame whose value is ahead doesn't fail: the
  slot keeps its value and status (a slot without a value that isn't in
  `'error'`, including a settled `'non-init'` one, goes or stays
  `'loading'`; an `'error'` slot stays `'error'`, with its `lastError`)
  and reloads the key once the contract catches up. If it hasn't after
  10 s, the library syncs the contract; if that doesn't help either, the
  slot settles. A slot that holds a value keeps it, with its status and
  `lastError` (`'loaded'`, or `'error'`; a slot that was reloading it
  stays `'loading'` until that reload settles); any other slot settles to
  `'error'` (`lastError.name === 'ChelErrorKvHeightAhead'`).
  Either way the slot remembers that the server value is ahead: it still
  reloads the key if the contract catches up later, and `update` keeps
  refusing to run its reducer on the stale value or the default until
  then. The next load or frame that finds the value ahead starts over
  (with a new 10 s fallback). The raw `NOTIFICATION_TYPE.KV` handler
  passed to `chelonia/connect` is not called for frames that are ahead,
  and a `console.warn` says so for each such frame. No event fires
  either, so a raw handler can't tell that a newer value exists: define a
  slot for the key (its entry's `heightAhead` says so, and the slot
  reloads its own copy once the contract catches up; the raw handler
  still misses the frame).
- `chelonia/kv/sync` for a single key waits up to 1.5 s, then syncs the
  contract and loads again, up to `maxHeightRecoveries` (default 2) times,
  before rejecting (and settling the slot as above). It skips the 1.5 s
  wait while the pubsub socket isn't open (no contract event can arrive)
  and while a recovery sync of the contract is already running (it joins
  that sync). If the contract has reached the height by then, it loads
  once more instead (waiting for a recovery sync that is still running,
  since the load is queued behind it). With the default timings that can
  take about a minute when the syncs are slow. It takes the same
  `signal` and `onHeightAhead` options as `update`, and
  `maxHeightRecoveries` with one difference: `0` means neither wait nor
  sync here, as `'reject'` does (for `update`, `0` waits passively).
  Meanwhile the slot keeps knowing that its value is stale, so
  `update` doesn't run its reducer on it. With `onHeightAhead: 'reject'`
  or `maxHeightRecoveries: 0`, the call rejects after its first load
  without waiting or syncing, and the slot is left to its deferred reload
  (including the 10 s fallback), as if the load had run in the
  background. Reaching the height reloads the slot once: the call uses
  that reload rather than loading the key again.

While the library knows that the server holds a value this client can't
verify yet, the mirror entry carries `heightAhead: { requiredHeight }`,
the contract height the local contract must reach. The entry's `value`,
if any, is then the last verified one, not the server's, whatever
`status` says: a `'loaded'` slot keeps presenting its value, and an
`'error'` slot keeps its status and `lastError` while its reload is
deferred, even when that error is unrelated (e.g. a failed GET). The
marker is set when a load, a pubsub frame or a giving-up `update` finds
the value ahead. It is cleared:

- when a load verifies the key (finds a value, or a 404);
- when a local `update` or `clear` commits (unless a newer value was
  found ahead meanwhile);
- once the contract reaches the height and the reload that this starts
  verifies the key. If that reload fails (e.g. its GET does; the slot is
  then `'error'`), or can't start (e.g. a filter vetoes it; the slot then
  settles, keeping a value it holds), the marker stays, and `update`
  keeps reloading before running its
  reducer (rejecting with the reload's error if that fails too) until a
  load verifies the key.

It is persisted with the mirror: in the next session `update` keeps
reloading before running its reducer until a load clears it. Each
change is announced with `CHELONIA_KV_STATUS_CHANGED`, which can
therefore fire with an unchanged `status` (its `heightAhead` field is
`null` once cleared), and `chelonia/externalStateSetup` copies it into
the app's store with the rest of the entry. Read it to show that a newer
value exists. (A pre-flight `chelonia/contract/sync` before a write isn't
needed: see
[Replacing an app-level height guard](#replacing-an-app-level-height-guard).)

Don't await KV writes from code that a contract's lanes await (a
`sideEffect`, a `queueInvocation` body, an `onconflict`, an `onUpdate`):
for the same contract they never settle, and for another contract they
hold its lane while they wait. See
[How height recovery runs](#how-height-recovery-runs).

`ChelErrorKvHeightAhead` extends `ChelErrorInvalidMessageHeight`, but has
its own `name`; match it with `isKvHeightAhead(e)` (exported, and
name-based, so it also matches errors from another copy of the library),
and read its `.cause` (`{ requiredHeight, exact, localHeight, etag,
httpStatus }`) with `kvHeightAheadCause(e)`. A slot's stored `lastError`
keeps only `name` and `message`, so it has no `.cause`:
`isKvHeightAhead(lastError)` still matches, and `kvHeightAheadCause`
returns `undefined` for it.

A value with a malformed height stamp is rejected with
`ChelErrorKvHeightMalformed` (match it with `isKvHeightMalformed(e)`; it
extends `ChelErrorInvalidMessageHeight`, the name such a value had
before, and its `.cause` is the stamp error). A stamp must be a
non-negative integer or its plain decimal string: `"1e1"`, `"010"` or
`" 10"` are malformed, because a stamp read differently by different
parsers could get a value verified against the wrong key validity
window. See KV-REVAMPED.md §3.4 for the full rationale. Such a value can
never be verified, so `update`, slot loads and `kv/get` keep rejecting
(the slot shows `'error'`), and retrying can't help. A pubsub frame
carrying a malformed stamp is logged, and a slot for the key reloads it:
the slot then shows `'error'` too (or the stored value, if the frame was
a stale one). `chelonia/kv/clear` overwrites it, and so does a `kv/set`
or `queuedSet` with `allowUnverifiedConflict: true`, whose `onconflict`
then gets `currentStatus: 'malformed'`.

### How height recovery runs

`update`, `clear`, `queuedSet`, single-key `sync` and
`chelonia/kv/withHeightRecovery` recover from `ChelErrorKvHeightAhead`
the same way. This is the reference; the other places that mention it
link here.

- The operation waits, holding no lane, for a sync of the contract. That
  sync runs on the contract's **internal** lane (behind the contract
  events being processed, and their `sideEffect`s), and concurrent
  callers share it.
- `signal` and `chelonia/reset` end this caller's wait, not the shared
  sync: `chelonia/reset` waits for that sync to finish, as part of
  draining the contract's lanes.
- After the sync, the attempt is queued again on the contract's public
  lane (`chelonia/queueInvocation`), behind whatever was queued for the
  contract meanwhile, so a later write to the same key can commit before
  it, as with an app-level retry. Chain writes to the same key yourself
  when their order matters. A sync that timed out with the height
  reached (e.g. through pubsub) still lets the attempt run: it is queued
  behind that sync, so it waits for it to finish.
- While the work of an `update`, `clear` or `queuedSet` is queued, on
  any lane (behind a busy lane, or behind a recovery sync), `signal` (or
  `chelonia/reset`) rejects it at once, and the queued work then writes
  nothing. Once the
  work runs, the usual abort rules apply: the request is aborted, and a
  write that committed still resolves. `withHeightRecovery` runs your
  own attempt: queue its lane work with the attempt's `queue`, which
  gives it the same guarantees. Work that never runs rejects rather
  than resolving `undefined`: with an `AbortError` when the lane dropped
  it (`chelonia/reset` does, and so does a filter that vetoes one of the
  selectors `chelonia/queueInvocation` calls), and with
  `ChelErrorUnexpected` when a filter vetoed `chelonia/queueInvocation`
  itself.

**Never await** `update`, `clear`, `queuedSet`, single-key `sync`,
`whenSettled` or `withHeightRecovery` for contract X from code that X's
lanes await:

- one of X's `sideEffect`s (X's internal lane, which every one of these
  selectors queues on first, and on which the recovery sync runs);
- a `chelonia/queueInvocation` body for X, or an `onconflict` of a write
  to X (X's public lane, which every attempt queues on);
- an `onUpdate` of one of X's slots. A synchronous call from there rejects
  with `ChelErrorKvReentrant`; a call after the callback's first `await`
  isn't detected.

None of these calls would ever settle. Schedule the call without awaiting
it instead (from an `onUpdate`, with `queueMicrotask(…)`). Raw pubsub
handlers (`KV`, `PUB`) and `okTurtles.events` listeners are not awaited
by the library: only their synchronous part runs on the lane, so a write
they await queues behind the frame's work and settles.

**From another contract's lane** (a `sideEffect` of contract Y, or a
`queueInvocation` body for Y), don't await the write either: Y's lane is
held for as long as the write waits for heights or a recovery sync. With
the defaults, an awaited write can take two recovery syncs (up to 30 s
each), then a last attempt with up to 5 stale-stamp waits and one wait
per `412` whose value is ahead (up to 1.5 s each; none while the pubsub
socket is closed). If you must await it, pass a `signal` (e.g.
`AbortSignal.timeout(…)`): it is then the only bound. A recovery sync
that timed out with the height reached keeps the retry queued behind it,
and a lane cycle through your own code (X's work awaiting Y's, and Y's
awaiting X's) deadlocks with or without a height error.

### Replacing an app-level height guard

Apps that wrapped KV writes in "sync the contract first" and/or "sync and
retry on a height error" helpers should delete them:

- `chelonia/kv/update`, `chelonia/kv/clear`, `chelonia/kv/queuedSet` and
  single-key `chelonia/kv/sync` already force-sync the contract (waiting
  for the sync holding no lane; see
  [How height recovery runs](#how-height-recovery-runs)) and retry on
  `ChelErrorKvHeightAhead`, up to `maxHeightRecoveries` times, also when
  the recovery sync fails but the contract reaches the height anyway
  (within a short passive wait after the failure). Wrapping them again
  only adds sync rounds. Call them directly.
- A pre-write `chelonia/contract/sync` isn't needed: a stale height
  stamp comes back as a `409`, and a value that is ahead as
  `ChelErrorKvHeightAhead`. `update`, `clear` and `queuedSet` recover
  from both by syncing at once, without first waiting for a pubsub event
  (only their last attempt waits passively). Single-key `sync` first
  waits passively (up to 1.5 s, outside every lane), then syncs. A
  pre-flight costs a `latestHEADinfo` round trip per throttle window even
  when the client is current; the selectors only pay for a sync after
  the server rejected a write (a stale client then pays for one rejected
  upload).
- Replace `e.name === 'ChelErrorInvalidMessageHeight'` checks with
  `isKvHeightAhead(e)`: no library path wraps `ChelErrorKvHeightAhead`.
  Where your app wraps errors, keep a walk along `.cause` (see
  **Wrapped errors** below). The KV selectors never reject with the old
  name any more: a value whose height stamp is malformed, which no sync
  or retry can fix (see above), is `isKvHeightMalformed(e)`; `clear` it
  instead. (Lower-level parsing, e.g.
  `chelonia/parseEncryptedOrUnencryptedDetachedMessage`, still throws a
  plain `ChelErrorInvalidMessageHeight` for both.)
- A `409` no longer counts against `maxAttempts`, so running out of
  attempts means real contention. Match it with `isKvConflict(e)`, which
  matches the `ChelErrorKvConflict` of `update`, `clear` and `queuedSet`
  (and the internal error of raw `kv/set`), and raise `maxAttempts` if it
  happens too often. When the last conflicting value is ahead of the
  local contract, an `update` (or a `queuedSet` with an `onconflict` and
  without `allowUnverifiedConflict`) rejects with
  `ChelErrorKvHeightAhead` instead, which it recovers from as above. A
  blind write (`clear`, or `allowUnverifiedConflict`) doesn't depend on
  the value, so it reports the conflict, without waiting for the value's
  height or syncing. A slot still records the value as ahead, as a load
  that found it would: it gets the `heightAhead` marker (a settled
  `'non-init'` slot goes `'loading'`), and reloads once the contract
  reaches the value's height.
- Raw `chelonia/kv/get` rejects at once with `ChelErrorKvHeightAhead` for
  a value that is ahead; raw `chelonia/kv/set` first waits passively (see
  [Contract heights](#contract-heights); `heightWaitMs: 0` skips it), and
  then rejects. Neither syncs the contract. Wrap such a call in
  `chelonia/kv/withHeightRecovery`, the recovery `update`, `clear` and
  `queuedSet` use:

  ```js
  await sbp('chelonia/kv/withHeightRecovery', contractID, ({ heightWaitMs, queue }) =>
    queue(() => {
      // Per attempt: the recovery sync may have rotated keys.
      const encryptionKeyId = sbp('chelonia/contract/currentKeyIdByName', contractID, 'cek')
      // Without it, `kv/set` would only sign, i.e. store plaintext.
      if (!encryptionKeyId) throw new Error(`${contractID} has no 'cek' key`)
      return sbp('chelonia/kv/set', contractID, key, data, {
        ...options,
        signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, 'csk'),
        encryptionKeyId,
        heightWaitMs,
        signal
      })
    }),
  { onHeightAhead, maxHeightRecoveries, signal })
  ```

  While the attempt rejects with `ChelErrorKvHeightAhead`, it waits
  (holding no lane) for a sync of the contract that runs on the
  contract's internal lane (one sync shared by concurrent callers;
  `signal` and `chelonia/reset` end this caller's wait, not the shared
  sync; see [How height recovery runs](#how-height-recovery-runs)), and
  runs the attempt again, up to `maxHeightRecoveries` (default 2) times,
  also when the sync fails but the contract reaches the height anyway
  (e.g. through pubsub, within a short passive wait after the failure;
  none while the pubsub socket is closed). It runs no sync when the
  contract had already reached the height by the time the attempt
  failed. Otherwise the caller gets the attempt's own error. The attempt
  must:

  - reject with the library's error as is (a wrapped error isn't
    recovered);
  - queue its lane work with `queue` (the recovery must not run with the
    lane held). `queue` is what makes `signal` and `chelonia/reset` end
    an attempt that is still queued: until the body starts, they reject
    it at once, and the body then never runs;
  - resolve key IDs inside the attempt: `kv/set` replaces a revoked key
    with the current key of the same name, but rejects with
    `ChelErrorSignatureKeyNotFound` when no key of that name is left;
  - pass `signal` on to `kv/set`, so that it aborts the request in
    flight;
  - only read or write keys of `contractID` (the recovery syncs that
    contract, whichever contract the error came from; this isn't
    checked);
  - pass `heightWaitMs` on to `kv/set`: `0` while a recovery follows,
    the default passive wait on the last attempt (`onHeightAhead:
    'reject'` runs one attempt, with `0`).

  Invalid options reject with `ChelErrorKvUpdateInvalid` before the
  attempt runs (a non-function attempt with a `TypeError`), and so does
  a synchronous call from an `onUpdate` of one of the contract's slots
  (`ChelErrorKvReentrant`). Never await it from code that the contract's
  lanes await (see [How height recovery runs](#how-height-recovery-runs)).
  Prefer `queuedSet` or a slot where they fit.
- `onUpdate` is called when a value lands (`'load'`, `'remote'`,
  `'local'`, `'reconnect'`), and when a load's 404 replaces a value the
  slot held. A load that finds no value (a 404) on a slot that never
  held one doesn't call it, so a gate that waits for "the slot has
  loaded" must not wait for `onUpdate`: use `whenSettled`,
  `settledStatus`, or the entry's `settled && status !== 'loading'` (in
  a store, or in `CHELONIA_KV_STATUS_CHANGED`'s payload).

In terms of a typical app-level guard (Group Income's `kv-guard.js`):

| App-level helper | Replacement |
|---|---|
| `isHeightAheadError(e)` | `isKvHeightAhead(e)` (walk `.cause` above your own wrappers); for a malformed stamp, `isKvHeightMalformed(e)` (`clear` the key; syncing doesn't help) |
| `isKvConflictError(e)` plus an extra retry | `isKvConflict(e)`; pass an `onconflict` (or use a slot's `update`) to resolve conflicts, and a larger `maxAttempts`. A `412` without `onconflict` rejects on the first attempt whatever `maxAttempts` is |
| `withKvGuard` / `withKvHeightRetry` around `update`, `clear` or `queuedSet` | Nothing: the selectors recover on their own (`onHeightAhead`, `maxHeightRecoveries`). Unlike the guard, they never retry blindly at a stale height: after a failed sync they wait passively (up to 1.5 s; not while the pubsub socket is closed) for the height, and retry only once it has arrived |
| `withKvHeightRetry` around raw `kv/get` / `kv/set` | `chelonia/kv/withHeightRecovery` (see above) |
| The guard's side-effect rule (no pre-flight on a hot lane; still sync and retry on a height error) | Keep the default `onHeightAhead: 'sync'`: it never pre-flights, and it only syncs after the server rejected the write. But don't await the write on the lane: it can hold the lane for a long time (see [How height recovery runs](#how-height-recovery-runs) for the worst case with the defaults). If it must be awaited, pass a `signal` (e.g. `AbortSignal.timeout(…)`), which also ends the wait while the write is queued. `'reject'` gives up on the write, a stale-stamp `409` included: use it only when the caller re-issues the write itself |
| `ensureContractHeightCurrent` before a write | Not needed: the selectors recover by syncing, without first waiting for a pubsub event, except on the last attempt |
| Telling "empty" from "not loaded yet" (e.g. on a first-load 404) | `whenSettled`, `settledStatus`, or `settled && status !== 'loading'` (see [Pending vs. settled](#pending-vs-settled)) |
| Tracking "the server holds a newer value" | The mirror entry's `heightAhead` (see [Contract heights](#contract-heights)) |

- **Wrapped errors.** The predicates (`isKvHeightAhead`,
  `isKvHeightMalformed`, `isKvConflict`) only check the error itself. No
  library error wraps these errors: the library's own rejections reach
  the caller as they are (the KV tests check them with these
  predicates), so a walk is only needed above the app's own wrappers. An
  app that re-wraps them walks `.cause` itself, e.g.:

  ```js
  const findCause = (e, predicate) => {
    for (let depth = 0; e && depth < 8; depth++, e = e.cause) {
      if (predicate(e)) return e
    }
  }
  ```

- **Remove the guard in the same upgrade.** A guard left in place no
  longer recognises height errors: `kv/get` and `kv/set` now reject with
  `ChelErrorKvHeightAhead`, whose `.cause` is a plain object (no `name`),
  so a walk for `name === 'ChelErrorInvalidMessageHeight'` matches
  nothing, and the guard silently stops syncing and retrying raw calls
  (the class still extends `ChelErrorInvalidMessageHeight`, but only
  `instanceof` sees that). This is a breaking change for such guards. A
  guard left in place also
  matches `queuedSet`'s conflicts (an extra sync, and a retry that rarely
  helps), and its own `chelonia/kv/sync` call now recovers on its own
  (up to two rounds of a passive wait plus a sync; pass
  `onHeightAhead: 'reject'` for the old single GET).

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
| `onUpdate` | none | Callback `(value, ctx: KvUpdateCtx) => void` fired after every successful load, applied remote frame or committed local write (also when the value didn't change), and when a load's 404 replaces a value the slot held (not on a 404 for a slot that never held a value). Must not throw. For the same contract, must not call `update`, `clear`, `queuedSet`, `sync`, `withHeightRecovery`, or a `whenSettled` that would wait, synchronously (rejected with `ChelErrorKvReentrant`; see the rejection taxonomy below), nor await one after its first `await` (an undetected deadlock; see [How height recovery runs](#how-height-recovery-runs)). |

`KvUpdater<T>` receives `T | undefined`: `undefined` is passed when a slot
has neither a mirror value nor a `defaultValue`.

`chelonia/kv/set` now resolves to `{ etag: string | null }` instead of `void`; the return value is forwarded through `chelonia/kv/queuedSet` as well.

Slot values must reject `null` / `undefined` anywhere in the parsed value, not just at the root. This invariant is enforced for schema-backed and schemaless slots alike: `null` is reserved for wire-clear semantics and `undefined` for unloaded mirror state, so model optional fields as explicit tagged unions or by omitting the field rather than using `T | null`.

Slot writes resolve `encryptionKeyName` / `signingKeyName` inside the per-contract queue. A missing named encryption key rejects with `ChelErrorKvUpdateInvalid` instead of silently writing plaintext. Set `encryptionKeyName: null` explicitly to opt into plaintext slot storage. A missing signing key always rejects. `chelonia/kv/queuedSet` does the same with its own `encryptionKeyName` option (default `'cek'`): a missing key rejects with `ChelErrorKvUpdateInvalid`, and `null` stores plaintext. Raw `chelonia/kv/set` only signs when it gets no `encryptionKeyId`, so check that the key exists (as in the snippet above).

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
  5 re-signs) it rejects with `ChelErrorKvHeightAhead`. Wrap raw calls in
  `chelonia/kv/withHeightRecovery` (see
  [Replacing an app-level height guard](#replacing-an-app-level-height-guard));
  `queuedSet`, `update` and `clear` already do.
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
  throws `ChelErrorKvHeightMalformed`. An exhaustive `switch` on
  `currentStatus` needs a case for it.

`chelonia/kv/get` rejects with `ChelErrorKvHeightAhead` for a value that
is ahead, and with `ChelErrorKvHeightMalformed` for one whose height stamp
is malformed. Both used to reject with a plain
`ChelErrorInvalidMessageHeight`: `instanceof ChelErrorInvalidMessageHeight`
still matches, but a check of
`e.name === 'ChelErrorInvalidMessageHeight'` (e.g. one that has to work
across separately bundled copies of the library) no longer does. Use
`isKvHeightAhead(e)` and `isKvHeightMalformed(e)`.

Running out of `maxAttempts` still rejects raw `kv/set` with an internal
error (`ChelErrorKvMaxAttempts`), unless the last conflicting value is
ahead of the local contract and the write isn't blind (it has an
`onconflict` and no `allowUnverifiedConflict`): that rejects with
`ChelErrorKvHeightAhead`, with the last response's etag.
Its `.cause` now describes one response, the final `412`:
`{ currentStatus, currentData, requiredHeight, etag }`, with
`currentData` omitted when the value is unknown (`'ahead'`, `'malformed'`,
or undecodable), `requiredHeight` (the value's height stamp) only for a
value that is `'ahead'`, and `currentStatus` omitted too (rather than set
to `undefined`) when that response couldn't be read or decoded. It used
to pair the last value that could be decoded, possibly from an earlier
`412`, with the latest etag. `update`, `clear` and `queuedSet` report the
same response the same way (`update` and `clear` normalize
`currentData` for the slot, and omit it when it fails the slot's
schema); they no longer fall back to what their `onconflict` saw an
attempt earlier. A `412` without
an `onconflict` handler, which used to reject with a plain `Error`, now
rejects with `ChelErrorKvMaxAttempts` too (the message, "kv/set failed
with status 412 and no onconflict handler was provided", is kept), at
once and whatever `maxAttempts` is.
`chelonia/kv/queuedSet` now remaps it to the public `ChelErrorKvConflict`
with the same `.cause`, like `update` and `clear`: a check of a
`queuedSet` rejection with `instanceof ChelErrorKvMaxAttempts`, or by that
name, no longer matches. Use `isKvConflict(e)`, which matches both. A
`412` without `onconflict` is never reported as `ChelErrorKvHeightAhead`,
so `queuedSet` doesn't sync the contract for it: no sync can make a
write that conflicts without a merge succeed.

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
- `maxAttempts` is not a positive integer (e.g. `0`, `1.5`, `-1`).

The two reducer rules apply identically on the first attempt and on every
conflict-retry pass. The option check runs once, before the first attempt
and before any network access; `chelonia/kv/queuedSet` and single-key
`chelonia/kv/sync` reject invalid options the same way.

A reducer that returns `KV_NOOP` makes `update` resolve `undefined`,
except when a reload that `update` needed failed: the reload that a
`KV_NOOP` on a basis nothing confirmed triggers (a slot that hasn't
settled, or an `'error'` slot without a value), or the reload after a
height recovery. `update` then rejects with that reload's error (e.g.
`ChelErrorUnexpectedHttpResponseCode`): nothing confirmed that there was
nothing to write. After a failed reload of an `'error'` slot that still
holds a value (see below), a `KV_NOOP` resolves `undefined`.

`chelonia/kv/update`, `chelonia/kv/clear`, `chelonia/kv/queuedSet`,
`chelonia/kv/sync` and `chelonia/kv/withHeightRecovery` (and a
`chelonia/kv/whenSettled` that would wait) also reject with
`ChelErrorKvReentrant` when called for the **same
contract** from within the *synchronous* portion of that contract's own
`onUpdate` callback. `onUpdate` holds the per-contract
`chelonia/queueInvocation` lane, so a same-contract write issued during
the callback would enqueue behind the lane that is blocked awaiting the
callback — a deadlock. The guard is narrow (synchronous portion only)
so it never rejects an *independent* concurrent write that interleaves
with a slow async `onUpdate` (those queue safely and succeed); a call
that the callback itself awaits after its first `await` deadlocks
undetected (see [How height recovery runs](#how-height-recovery-runs)).
`chelonia/kv/read` / `chelonia/kv/status` (synchronous, unqueued) and
writes to *other* contracts are always unaffected. To re-enter a
same-contract write, schedule it off the synchronous stack and do not
await it inside the callback:
`queueMicrotask(() => sbp('chelonia/kv/update', …))` — it queues
behind the lane and runs once it releases.

When a slot is in `'error'` status but still holds a retained value,
`update` first performs one authoritative reload and seeds the
reducer from the refreshed (or retained, if the reload fails) mirror
value, not from the declared default. This prevents the silent data
loss that would occur if a default-seeded write carrying the retained
etag matched and overwrote the live server value. The reload reports
what it loads, as any load does (`'loading'`, then a `'load'` event and
`onUpdate`), so the slot leaves `'error'` even when the reducer then
returns `KV_NOOP`; a reload that fails restores `'error'`. If the reload finds
the server value ahead, the retained value is known to be stale:
`update` recovers (it syncs the contract and tries again, as for any
`ChelErrorKvHeightAhead`) instead of seeding from it. An `'error'` slot
with no retained value writes against `if-match: ""` instead, and
reloads only when the reducer returns `KV_NOOP`, which
then rejects when that reload fails (see
[Pending vs. settled](#pending-vs-settled)).

**Abort after commit:** an abort can only stop a write before it
commits. A write aborted before its POST is sent writes nothing. An abort
that lands while the POST is in flight can't stop the server: the call
rejects with the abort reason, but the write may still have committed,
and the mirror then learns it from its pubsub echo or the next load. An
abort after `chelonia/kv/set` resolved is ignored: the write is applied
to the mirror, its event and `onUpdate` fire, and the call resolves
(`update` with the committed value).

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
  doesn't load a slot that hasn't settled in this activation (an
  `'on-demand'` / `'never'` slot, or a persisted entry) before running its
  reducer: the reducer runs on the mirror value (or the default), and the
  write derives its `if-match` precondition from the mirror etag. A
  never-loaded (`'non-init'`) slot has `etag: null`, so the write is sent
  with `if-match: ""` ("the key must not exist"). If the server already
  holds a value, the write gets a `412` and the reducer is re-run against
  the server value. The slot is only loaded first when that precondition
  can't help: for a `KV_NOOP` (which writes nothing; the reducer then runs
  again on what the load found), and with the caller's own `ifMatch`. If
  that load fails, the call rejects with its error.

- **`update` resolves with the committed value.** If the slot is replaced
  (`defineSlot`/HMR) or dropped after the server write commits, or the
  caller aborts then, `update` still resolves with that committed value.
  `undefined` is reserved for `KV_NOOP` ("no write happened"), so callers
  can distinguish a persisted write from a genuine no-op.

- **Event ordering.** `CHELONIA_KV_UPDATED` fires *before* the slot status
  transitions, so an updated-handler that reads `chelonia/kv/status` sees
  the pre-transition status (e.g. `'loading'` on a first successful load).
  The `defineSlot`-replacement re-validate path is the exception: it flips
  status to `'loaded'` first. Either way, derive a "settled" signal from
  `settled && status !== 'loading'` (both are on the entry and in
  `CHELONIA_KV_STATUS_CHANGED`'s payload), or from
  `chelonia/kv/settledStatus` / `whenSettled`, not from the `settled`
  flag alone (it stays `true` while a settled `'non-init'` slot goes
  `'loading'` for a value that is ahead), and not from
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

- **`chelonia/reset` drains in-flight KV writes.** `reset` first waits
  for every contract's lanes (`chelonia/contract/wait`): an `update` or
  `clear` already running there, even one in its conflict backoff,
  finishes and commits. Then it aborts the session, which stops
  stuck/offline network work and anything still waiting (a raw
  `chelonia/kv/set` in its backoff rejects at once), and waits for the
  `update` / `clear` writes that started meanwhile (and any contract
  sync started to recover from `ChelErrorKvHeightAhead`) to settle.
  Only then does it run `postCleanupFn` and clear the KV runtime maps,
  so persistence hooks observe a quiescent mirror and continuations
  never run against torn-down state. Deferred reloads are cancelled.

- **Height recovery syncs the contract.** When `update`, `clear` or
  `queuedSet` recovers from a value that is ahead, it runs a forced
  contract sync (outside the KV queue lane) before retrying, which takes
  a network round trip. `onHeightAhead: 'reject'` skips that sync and
  `kv/set`'s passive waits (see [Contract heights](#contract-heights)):
  the call rejects with `ChelErrorKvHeightAhead` at once, without holding
  the contract's queue lane. Hot paths shouldn't await KV writes at all.
