# `@chelonia/lib` Documentation

In-depth guides for using `@chelonia/lib`. The library is consumed by
importing the package root (`import '@chelonia/lib'` for the
side-effect of registering every SBP selector, plus named imports for
helpers and types). The pre-built `dist/` directory is not intended to
be imported directly — use the package name.

## Where to start

| Document | Topic |
|---|---|
| [`quickstart.md`](./quickstart.md) | End-to-end "hello world": configure → connect → register a contract → publish an action → tear down. |
| [`configure.md`](./configure.md) | The `chelonia/configure` selector — every option, validation rules, and framework integration. |
| [`contracts.md`](./contracts.md) | Defining contracts, registering them, syncing, publishing actions, key management, atomic batches, and tearing down. |
| [`journal.md`](./journal.md) | The optional per-contract event journal: enabling it, redactions, snapshot tuning, reconstruct, and clear. |
| [`files.md`](./files.md) | Encrypted file upload, download, and delete — manifest layout and cipher choices. |
| [`persistent-actions.md`](./persistent-actions.md) | The retry queue for must-succeed SBP calls — enqueue, cancel, persistence, and lifecycle. |
| [`debugging.md`](./debugging.md) | Observability — error hooks, lifecycle events, inspecting state, and replaying from the journal. |
| [`api.md`](./api.md) | Selector / type / error / event index with source links. Useful when you know what you're looking for. |

If you're new to the library, start with
[`quickstart.md`](./quickstart.md). It pulls together the minimum
slice of `configure.md` and `contracts.md` needed to publish your
first action. [`journal.md`](./journal.md) is optional reading — turn
it on if you need an audit trail of state mutations. When something
goes wrong, [`debugging.md`](./debugging.md) lists the hooks and
events to reach for.

## Out of scope here

- **Manifest authoring.** The on-disk manifest format (signed JSON
  pointing at one or more contract `body` files), the tooling for
  producing one, and signing conventions are not documented in this
  repo. Consult your relay-server / SDK; `@chelonia/lib` only consumes
  pre-built manifest hashes via `contracts.manifests`.
- **Relay-server internals.** This is a client/server-agnostic library
  for the Shelter Protocol. The `SERVER` preset (in
  [`configure.md`](./configure.md)) is the only server-flavoured
  surface here.
