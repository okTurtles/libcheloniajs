# `chelonia/configure`

`chelonia/configure` is the single entry point for configuring a Chelonia
instance. It is an SBP selector — importing `@chelonia/lib` registers it
(along with every other selector) into the global SBP registry as a
side-effect, and you invoke it via `sbp('chelonia/configure', config)`.

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib' // side-effect: registers all chelonia/* selectors

await sbp('chelonia/configure', { /* ...config... */ })
```

You can call `chelonia/configure` more than once. Each call **merges**
into the existing configuration: fields you provide replace the previous
value, fields you omit are left alone. Hooks and the `journal` block
have a few extra rules described below.

> Server-side use: bundle `SERVER` from `@chelonia/lib` as a preset —
> `await sbp('chelonia/configure', { ...SERVER, connectionURL })`. It
> sets `acceptAllMessages`, `skipActionProcessing`, `skipSideEffects`,
> `skipDecryptionAttempts`, `strictProcessing`, `strictOrdering`, and
> `saveMessageMetadata` to `true`.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Full configuration reference](#full-configuration-reference)
3. [Reconfigure semantics](#reconfigure-semantics)
4. [Journal configuration](#journal-configuration) (see also [`journal.md`](./journal.md))
5. [Full working example](#full-working-example)
6. [Integrating with Vue 3 / Pinia / Vuex](#integrating-with-vue-3--pinia--vuex)
7. [Common pitfalls](#common-pitfalls)

For the end-to-end contract lifecycle (define, register, publish
actions, tear down) see [`contracts.md`](./contracts.md). For a flat
selector index see [`api.md`](./api.md). For a runnable end-to-end
walkthrough see [`quickstart.md`](./quickstart.md).

---

## Quick start

```js
import sbp from '@sbp/sbp'
import '@chelonia/lib'

await sbp('chelonia/configure', {
  connectionURL: 'https://chelonia.example.com',
  contracts: {
    manifests: {
      'my.app/chatroom': 'z9brRu3VPbjQNZeJYU3vYn5sFNwTjvKQGT2HZRJjyB1jX' // example
    }
  },
  hooks: {
    syncContractError: (e, contractID) => console.error('sync failed', contractID, e)
  }
})
```

That's the minimum needed for a client. For a runnable end-to-end
example see [Full working example](#full-working-example) further down.

---

## Full configuration reference

Every field below is **optional** unless noted otherwise. Defaults come
from `chelonia/_init` (which runs the first time a selector is invoked
that needs the context).

### Connection

| Field | Type | Default | Purpose |
|---|---|---|---|
| `connectionURL` | `string` | _(none — required before connecting)_ | Pubsub/HTTP base URL of the relay server. Accessing it before it is set throws. |
| `connectionOptions.maxRetries` | `number` | `Infinity` | Pubsub reconnection budget. |
| `connectionOptions.reconnectOnTimeout` | `boolean` | `true` | Reconnect when the server stops answering pings. |
| `fetch` | `typeof fetch` | global `fetch` | HTTP transport. Override in environments that need a custom fetch (e.g. service workers with credentials). |

### State integration

| Field | Type | Default | Purpose |
|---|---|---|---|
| `stateSelector` | `string` | `'chelonia/private/state'` | Name of an SBP selector that returns the **root state** object. Override this when Chelonia must share state with another framework (Vuex, Pinia, Redux, etc.). |
| `reactiveSet` | `(obj, key, value) => void` | `(o,k,v)=>{o[k]=v}` | Setter Chelonia uses to mutate state. Plug in `Vue.set`, a Vuex setter, etc. |
| `reactiveDel` | `(obj, key) => void` | `(o,k)=>{delete o[k]}` | Companion to `reactiveSet`. |

### Contracts

| Field | Type | Default | Purpose |
|---|---|---|---|
| `contracts.defaults.modules` | `Record<string, unknown>` | `{}` | Pre-resolved modules a contract may `require` from its sandbox. |
| `contracts.defaults.exposedGlobals` | `object` | `{}` | Globals exposed inside contracts. |
| `contracts.defaults.allowedDomains` | `string[]` | `[]` | Domains contracts may import modules from. |
| `contracts.defaults.allowedSelectors` | `string[]` | `[]` | SBP selectors contracts may invoke from `process` / `sideEffect`. |
| `contracts.defaults.preferSlim` | `boolean` | `false` | Prefer the "slim" build of contracts where available. |
| `contracts.overrides` | `Record<string, Partial<defaults>>` | `{}` | Reserved for per-contract overrides. Currently **not consumed** by the runtime (`TODO` in `src/types.ts`); set it if you want, but no code reads it yet. |
| `contracts.manifests` | `Record<contractName, manifestHash>` | `{}` | The contract definitions Chelonia is allowed to load. Manifests are eagerly preloaded by `chelonia/configure`. The runtime only ever reads `contracts.manifests`. Group Income's generated `manifests.json` is authored with a top-level `manifests` key (i.e. `{ manifests: { 'gi.contracts/identity': '<hash>', ... } }`) so that spreading it directly into `contracts:` (e.g. `contracts: { ...manifests, defaults: { ... } }`) produces `contracts.manifests`. Without that wrapping key, the spread would put contract names directly under `contracts`, where nothing reads them. |

### Processing knobs

These are mostly relay-server flags but a few are useful client-side.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `whitelisted` | `(action: string) => boolean` | `(a) => !!ctx.whitelistedActions[a]` | Gate that decides whether an action may be processed locally. |
| `acceptAllMessages` | `boolean` | `false` | Skip the "expected message" filter (server use). |
| `skipActionProcessing` | `boolean` | `false` | Don't execute action `process`/`sideEffect` (server use). |
| `skipSideEffects` | `boolean` | `false` | Run `process` but skip `sideEffect` (useful for replaying state). |
| `skipDecryptionAttempts` | `boolean` | `false` | Don't attempt to decrypt encrypted ops (server use). Swaps `unwrapMaybeEncryptedData` for a passthrough shim. |
| `strictProcessing` | `boolean` | `false` | Treat every processing error as fatal (server use). |
| `strictOrdering` | `boolean` | `false` | Throw `ChelErrorAlreadyProcessed` on past events and `ChelErrorDBBadPreviousHEAD` on future events instead of buffering. |
| `saveMessageMetadata` | `boolean` | `false` | Persist `_private_hidx` and similar (server use). |
| `unwrapMaybeEncryptedData` | function | built-in | Override decryption unwrapping (rarely needed; controlled by `skipDecryptionAttempts`). |

### Hooks

`hooks` is a flat object of optional callbacks. Each can be `null` to
disable. Hooks are merged with `Object.assign` (not deep-merged), so
omitted keys keep their previous values.

| Hook | Signature | Fires |
|---|---|---|
| `preHandleEvent` | `async (msg: SPMessage) => void` | Before an incoming event is processed. |
| `postHandleEvent` | `async (msg: SPMessage) => void` | After processing + side-effects. |
| `processError` | `(err, msg, meta) => void` | Recoverable error during `process`. |
| `sideEffectError` | `(err, msg?) => void` | Error during `sideEffect`. |
| `handleEventError` | `(err, msg?) => void` | Top-level event-handler error. |
| `syncContractError` | `(err, contractID) => void` | Failure during contract sync. |
| `pubsubError` | `(err, socket) => void` | Pubsub-level error. |

You can also register **per-op** hooks at the top level:

| Field | Signature | Purpose |
|---|---|---|
| `preOp` | `(msg, state) => boolean` | Run before every op; return `false` to reject. |
| `postOp` | `(msg, state) => boolean` | Run after every op. |
| `preOp_<SPOpType>` | same | Run before a specific op type (e.g. `preOp_ae`). |
| `postOp_<SPOpType>` | same | Run after a specific op type. |

The valid `SPOpType` codes (from `SPMessage.ts`) are:

| Code | Constant | Meaning |
|---|---|---|
| `c` | `OP_CONTRACT` | Create a new contract. |
| `ae` | `OP_ACTION_ENCRYPTED` | Encrypted state mutation. |
| `au` | `OP_ACTION_UNENCRYPTED` | Unencrypted state mutation. |
| `ka` | `OP_KEY_ADD` | Add authorized key. |
| `kd` | `OP_KEY_DEL` | Remove authorized key. |
| `ku` | `OP_KEY_UPDATE` | Rotate / update key. |
| `ks` | `OP_KEY_SHARE` | Share key with another contract. |
| `kr` | `OP_KEY_REQUEST` | Request keys. |
| `krs` | `OP_KEY_REQUEST_SEEN` | Acknowledge key request. |
| `ps` | `OP_PROP_SET` | Set a contract property. *(Incoming handler is implemented in `src/internals.ts`; the outgoing selector is a stub — see [`api.md`](./api.md#not-yet-implemented-op-selectors).)* |
| `pd` | `OP_PROP_DEL` | Delete a contract property. *(Incoming handler is **NOT** implemented; outgoing selector is a stub.)* |
| `pu` | `OP_PROTOCOL_UPGRADE` | Protocol upgrade. *(Incoming handler is **NOT** implemented; outgoing selector is a stub.)* |
| `a` | `OP_ATOMIC` | Atomic batch of ops. |

The following two op codes are defined as constants on `SPMessage` but
are **not** part of the `SPOpType` union, so `preOp_ca` / `preOp_cd` /
`postOp_ca` / `postOp_cd` hooks cannot fire in the current
implementation:

| Code | Constant | Meaning |
|---|---|---|
| `ca` | `OP_CONTRACT_AUTH` | Authorize a contract. |
| `cd` | `OP_CONTRACT_DEAUTH` | Deauthorize a contract. |

So e.g. `preOp_ae` runs before every `OP_ACTION_ENCRYPTED`, `postOp_c`
runs after every `OP_CONTRACT`, and so on.

The default `whitelisted: (action) => !!ctx.whitelistedActions[action]`
consults a map that Chelonia populates automatically from
`chelonia/defineContract`: every action declared in a registered
contract is auto-whitelisted. You only need to override `whitelisted`
if you want a stricter gate on top of that (for example, server-side
rejection of specific actions).

### Journal

See the dedicated [Journal configuration](#journal-configuration)
section below, and [`journal.md`](./journal.md) for the in-depth guide.

---

## Reconfigure semantics

Calling `chelonia/configure` a second time **merges** into the existing
config:

- Top-level scalar fields you provide replace the previous value.
- Fields you **omit** are left alone.
- `contracts.defaults` is patched with `Object.assign` (so module
  function references are preserved — `turtledash.merge` would
  JSON-clone them away).
- `hooks` is patched with `Object.assign` (same reason).
- Setting a hook to `null` disables it.
- For `journal`, the rules are slightly stricter — see below.

The selector also eagerly preloads any new manifests in
`contracts.manifests`.

---

## Journal configuration

The journal is an **opt-in** per-contract record of every event applied
to a contract's state, plus a strict RFC-6902 JSON Patch diff between
the before- and after-state for each event. Periodic snapshots keep it
bounded. The full guide is in [`journal.md`](./journal.md); this
section documents the configuration surface.

```js
import { shortHashRedactor, defaultDiff, defaultApplyPatch } from '@chelonia/lib'

await sbp('chelonia/configure', {
  journal: {
    enabled: true,
    snapshotInterval: 50,
    contractIDs: [],      // empty = all contracts
    redactions: [
      { path: 'profiles.*.email', redact: shortHashRedactor },
      { path: 'secrets.apiKey', redact: () => '[REDACTED]' }
    ],
    diff: defaultDiff,
    applyPatch: defaultApplyPatch
  }
})
```

| Field | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch. Strict-typed — non-boolean throws `TypeError`. |
| `snapshotInterval` | positive integer | `50` (`DEFAULT_SNAPSHOT_INTERVAL`) | A new snapshot is recorded every N patches; the journal is trimmed to the most recent snapshot once it reaches `2N` entries. Non-integer/non-positive values fall back to the default and emit a `console.warn`. |
| `contractIDs` | `string[]` | `[]` (= all) | If non-empty, only these contracts are journaled. Stored via `.slice()` so later mutations on the caller's reference don't leak in. |
| `redactions` | `{ path, redact }[]` | `[]` | Applied to both the before- and after-state **before diffing**. `path` uses dotted segments; `*` matches any key/index. `redact(value, fullPath, contractName)` MUST be pure and return the replacement. Deep-copied on the way in. |
| `diff` | `(before, after) => JournalPatch[]` | `defaultDiff` | Override the diff implementation. Must be a function or `TypeError`. To revert to the built-in, pass `defaultDiff` explicitly. |
| `applyPatch` | `(state, patches) => unknown` | `defaultApplyPatch` | Override the patch applier used by `chelonia/journal/reconstruct`. To revert, pass `defaultApplyPatch` explicitly. |

### Journal reconfigure rules

These are stricter than for top-level fields:

- **Per-field `null` throws `TypeError`.** Omit the field to leave it
  alone; pass `journal: null` to reset the whole block.
- **`journal: null` is an escape hatch.** It resets the block to
  disabled defaults *and* wipes every persisted journal via
  `chelonia/journal/clear`. Use it when you really want to stop
  journaling.
- **Omitted `journal` block is left alone.** `journal: undefined`
  behaves the same as omitting the key.
- **Changing `redactions` does NOT auto-clear the journal.** The
  existing snapshots/patches were produced under the *old* set; if
  you've genuinely changed the semantics, you must call
  `chelonia/journal/clear` yourself (snapshot first via
  `chelonia/journal/get` if you want to preserve history). Chelonia
  does not auto-clear because function identity isn't stable across
  process restarts, and most apps re-supply the same redactions at
  every boot.
- `contractIDs` and `redactions` accept an empty array to **clear**
  them. They are deep-copied on the way in so caller mutations don't
  leak into Chelonia.

See [`journal.md`](./journal.md) for the public read/reconstruct/clear
selectors, redaction details, and observability concerns.

---

## Full working example

A minimal but complete client bootstrap: register a state selector →
configure Chelonia → open the pubsub connection → enable journaling
→ tear down.

The runnable end-to-end *contract* lifecycle (define + register +
publish actions + sync) is split out into [`contracts.md`](./contracts.md)
because it depends on a loaded manifest. This page only covers what
`chelonia/configure` itself owns.

```js
// app.ts
import sbp from '@sbp/sbp'
import '@chelonia/lib'                       // registers chelonia/* selectors
import {
  shortHashRedactor,
  defaultDiff,
  defaultApplyPatch
} from '@chelonia/lib'
// Or, equivalently, tree-shake just the journal helpers:
//   import { defaultDiff, defaultApplyPatch } from '@chelonia/lib/journal'

// 1. Register your state selector BEFORE configuring Chelonia.
//    `chelonia/configure` eagerly preloads contract manifests, which
//    reads through `stateSelector`; the selector must already exist.
const rootState = { contracts: {} }
sbp('sbp/selectors/register', {
  'myapp/state': () => rootState
})

// 2. Configure Chelonia.
await sbp('chelonia/configure', {
  connectionURL: 'https://chelonia.example.com',
  // Point the state selector at the one we just registered.
  stateSelector: 'myapp/state',
  reactiveSet: (o, k, v) => { o[k] = v },
  reactiveDel: (o, k) => { delete o[k] },
  contracts: {
    // `manifests` maps contract name => manifest hash. Each entry is
    // eagerly loaded; see contracts.md for how to author one.
    manifests: {
      // 'my.app/chatroom': '<manifestHashHere>'
    },
    defaults: {
      allowedSelectors: ['okTurtles.events/emit'],
      allowedDomains: ['https://chelonia.example.com'],
      preferSlim: true
    }
  },
  hooks: {
    preHandleEvent: async (msg) => console.debug('<<', msg.opType(), msg.hash()),
    syncContractError: (err, cid) => console.error('sync', cid, err),
    handleEventError: (err, msg) => console.error('event', msg?.hash(), err)
  },
  journal: {
    enabled: true,
    snapshotInterval: 25,
    redactions: [
      // Hash members' email addresses (high-entropy — `shortHashRedactor` is safe here).
      { path: 'profiles.*.email', redact: shortHashRedactor },
      // Replace low-entropy enum-like values with a sentinel.
      { path: 'profiles.*.role', redact: () => '[REDACTED]' }
    ],
    // `diff` / `applyPatch` are the built-ins; passed explicitly so
    // re-running configure won't be surprised by a previous swap.
    diff: defaultDiff,
    applyPatch: defaultApplyPatch
  }
})

// 3. Open the pubsub connection. Strictly required so incoming events
//    from the relay reach this client; `chelonia/configure` does NOT
//    auto-connect.
sbp('chelonia/connect')

// 4. ... define + register your contracts, send actions, etc.
//    See docs/contracts.md for the end-to-end contract walkthrough.

// 5. Inspect the journal for a contract you've synced.
//    (Replace `contractID` with the id returned by chelonia/out/registerContract.)
//
//    const journal = sbp('chelonia/journal/get', contractID)
//    const head    = sbp('chelonia/journal/reconstruct', contractID)
//
//    See docs/journal.md for full coverage.

// 6. (Later, on logout.) Stop journaling and wipe the persisted log.
await sbp('chelonia/configure', { journal: null })

// 7. Tear everything down. `chelonia/reset` waits for pending publishes
//    and post-sync ops to drain, aborts in-flight outgoing messages,
//    clears `rootState.contracts` and `rootState.secretKeys`, drops all
//    contract subscriptions, clears transient secret keys, and emits
//    CHELONIA_RESET + CONTRACTS_MODIFIED. It does NOT close the pubsub
//    socket itself — call `pubsub.destroy()` (or just let GC handle it)
//    if you want to fully shut down.
await sbp('chelonia/reset')
```

### Integrating with Vue 3 / Pinia / Vuex

Chelonia doesn't bundle a framework adapter; `stateSelector`,
`reactiveSet`, and `reactiveDel` are the integration surface.

**Vue 3 (Composition API).** Vue 3's reactivity uses `Proxy`, so plain
assignment / `delete` already trigger reactivity — the defaults are
fine, and you only need to point `stateSelector` at a `reactive()`
root:

```js
import { reactive } from 'vue'
const cheloniaRoot = reactive({ contracts: {} })

sbp('sbp/selectors/register', {
  'myapp/state': () => cheloniaRoot
})

await sbp('chelonia/configure', {
  connectionURL: 'https://chelonia.example.com',
  stateSelector: 'myapp/state'
  // reactiveSet / reactiveDel: defaults are correct for Vue 3.
})
```

**Pinia.** Same as Vue 3 — return `store.$state` (or a nested key on
it) from your selector. Pinia tracks deep mutations on `$state` via
Vue 3's reactivity, so the default `reactiveSet`/`reactiveDel` work
unchanged.

**Vuex / Vue 2.** Vue 2 needs `Vue.set` / `Vue.delete` to make
property additions/removals reactive. Point Chelonia's bookkeeping
state at a dedicated slice of the Vuex store's `state`, and wire
`reactiveSet`/`reactiveDel` to `Vue.set`/`Vue.delete` directly. (Note
that this writes through the store outside of mutations; if you run
Vuex in strict mode you'll want to wrap the writes in a
mutation/plugin of your own — Chelonia's bookkeeping is high-traffic
and noisy through devtools.):

```js
// store.js
export const store = new Vuex.Store({
  state: { chelonia: { contracts: {} } }
})

// chelonia-setup.js
import Vue from 'vue'

sbp('sbp/selectors/register', {
  'myapp/state': () => store.state.chelonia
})

await sbp('chelonia/configure', {
  connectionURL: 'https://chelonia.example.com',
  stateSelector: 'myapp/state',
  reactiveSet: (obj, key, value) => Vue.set(obj, key, value),
  reactiveDel: (obj, key) => Vue.delete(obj, key)
})
```

For external state mirroring (e.g. Chelonia in a service worker, Vuex
in the tab), see `chelonia/externalStateSetup` in
`src/local-selectors/`.

---

## Common pitfalls

- **`connectionURL` is required before connecting.** Reading it before
  it is set throws — set it in your very first `chelonia/configure`
  call.
- **`chelonia/configure` doesn't auto-connect.** It only loads
  manifests and seeds config. Outgoing publishes use `config.fetch`
  directly so they can succeed without `chelonia/connect`, but
  **incoming pubsub events never arrive** until you call
  `sbp('chelonia/connect')`. Symptom: actions appear to publish but
  local state never updates.
- **`stateSelector` must already exist.** Register it via
  `sbp('sbp/selectors/register', ...)` *before* calling
  `chelonia/configure`, otherwise manifest preloading will fail.
- **Don't deep-merge with `null` on journal sub-fields.** Per-field
  `null` throws. To clear an array, pass `[]`. To reset the whole
  block, pass `journal: null`.
- **`shortHashRedactor` is reversible for low-entropy values.** Use a
  constant sentinel (`() => '[REDACTED]'`) for booleans, small ints,
  short enums — anyone with the journal and the contract schema can
  rainbow-table the hash.
- **The journal travels with `state.contracts[contractID]._journal`.**
  Anything that serializes that subtree (e.g. a Vuex mirror set up via
  `chelonia/externalStateSetup`, or `chelonia/contract/fullState`)
  exposes the journal as well. Project it out client-side if needed.
- **Contract state must be plain JSON for the journal to behave.**
  `Date` / `Map` / `Set` / class instances in contract state aren't
  cloned by `defaultDiff` — in-place mutations would retroactively
  alter prior entries. Either keep state as plain JSON, or swap in a
  `structuredClone`-based `diff`/`applyPatch` pair.
