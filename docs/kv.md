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
`{ value: JSONType | undefined, etag: string | null, status: KvLoadStatus, lastError? }`
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
  `status: 'non-init'`, `value: undefined`, and `etag: null`.
- The declared `defaultValue` is never copied into the mirror eagerly;
  `chelonia/kv/read` substitutes it at read time.

Direct observers of `rootState._kv` must therefore treat `status`, not
`value`, as the source of truth: `value: undefined` means "presenting
the default", not "no value configured" (see
[Consumer caveats](#consumer-caveats)). For a `_kv`-free view of root
state, project `{ ...rootState, _kv: undefined }`.

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

Both rules apply identically on the first attempt and on every
conflict-retry pass.

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
value — not from the declared default. Only an `'error'` slot with no
retained value seeds from the declared default. This prevents the
silent data loss that would occur if a default-seeded write carrying
the retained etag matched and overwrote the live server value.

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

- **Unloaded writes can clobber.** `chelonia/kv/update` derives its
  `if-match` precondition from the mirror etag. A never-loaded
  (`'non-init'`) slot has `etag: null`, so its first `update` is sent with
  no precondition and overwrites whatever the server holds, even a value
  this client never read, instead of producing a `412`. Harmless for the
  default `autoLoad: 'on-sync'`; for `'on-demand'` / `'never'` slots, call
  `chelonia/kv/sync` before `update`.

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
  `CHELONIA_KV_STATUS_CHANGED` reaching a terminal status, not from inside
  a `CHELONIA_KV_UPDATED` handler. A first load of a never-written key
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
  `chelonia/kv/update` / `chelonia/kv/clear` writes to settle before
  `postCleanupFn` and before clearing the KV runtime maps (matching
  `chelonia/contract/wait`), so persistence hooks observe a quiescent
  mirror and continuations never run against torn-down state.
