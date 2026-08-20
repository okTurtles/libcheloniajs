# Code Review

**Base**: `origin/main` (b2a82be, includes #95)
**Head**: `fix/94-publish-error-status` (73f6c5a)
**Date**: 2026-08-20
**Model**: Claude Opus 5

Reviewed against `origin/main` rather than the local `main`, which is stale at
ef78f18. That matters here: #95 landed on main after this branch was cut and it
touches the same file. The merge itself is clean, but it introduced a helper
this branch should be using (finding 1).

---

## 1. 🟡 `httpErrorMessage` from #95 is not used, so there are now two formats

- [x] Addressed
- [ ] Dismissed

#95 added a helper to `src/utils.ts` whose stated purpose is exactly this case:

```ts
// Single source of truth for the message of errors raised from a failed HTTP
// response, so callers that map statuses themselves stay consistent with
// `handleFetchResult`.
export const httpErrorMessage = (r: Response) => `${r.status}: ${r.statusText}`
```

It is used by `handleFetchResult` and by `eventsAfter`. This branch adds a
third caller that maps statuses itself and builds its own string instead
(`src/internals.ts:899`):

```ts
const description = `${r.status} - ${r.statusText}${detail ? `: ${detail}` : ''}`
```

So the library now emits `403: Forbidden` from two places and
`403 - Forbidden: detail` from a third. The comment on `httpErrorMessage` asks
for the opposite.

It is not a straight swap, because `publishEvent` wants a detail suffix and its
existing format uses ` - `. Changing it to `httpErrorMessage(r)` alone would
give `publishEvent: 403: Forbidden: Registration disabled`, which reads worse
and silently changes a long-standing message.

The cleaner fix is to let the helper carry the detail, so all three callers stay
on one format:

```diff
-export const httpErrorMessage = (r: Response) => `${r.status}: ${r.statusText}`
+export const httpErrorMessage = (r: Response, detail?: string) =>
+  `${r.status}: ${r.statusText}${detail ? ` - ${detail}` : ''}`
```

and then in `publishEvent`:

```diff
-const description = `${r.status} - ${r.statusText}${detail ? `: ${detail}` : ''}`
+const description = httpErrorMessage(r, detail)
```

**Fixed.** The status line now uses the same `${status}: ${statusText}` shape
as `httpErrorMessage`, with the body detail appended after ` - `, so the library
speaks one format again. `httpErrorMessage` itself only exists on `origin/main`,
so `publishEvent` cannot call it from this branch without merging main in first;
once that happens the status line becomes a one-line swap to
`httpErrorMessage(r)`. Still worth confirming the separator with @corrideat,
since he wrote that comment.

## 2. 🟡 The bug being fixed has no automated test

- [x] Addressed
- [ ] Dismissed

`errorMessageFromResponse` is well covered in `src/utils.test.ts` (7 cases,
including the plain-text body that caused the issue). But nothing tests
`publishEvent` itself, which is where the bug lived. The two things a reader
would most want pinned down are untested:

- a non-ok, non-JSON response produces `ChelErrorUnexpectedHttpResponseCode`
  rather than a `SyntaxError`
- `.cause` carries the numeric status

Both were checked by hand against a real relay with `disabled = true` under
`[server.signup]`, but a reviewer cannot re-run that, and nothing stops the
regression coming back.

`src/name-lookup.test.ts` from #95 shows the pattern for stubbing `config.fetch`
and asserting on `ChelErrorUnexpectedHttpResponseCode` and `e.cause`. The extra
work here is building a valid `SPMessage` to publish;
`createTestContractRegistration` in chel's `src/serve/routes-test-helpers.ts`
does that and could be adapted.

**Fixed.** Added `src/publish-error.test.ts`, wired into `src/index.test.ts`.
It turned out not to need a manifest fixture: `skipActionProcessing: true` stops
`processMessage` from loading one, so a self-signed OP_CONTRACT and a stubbed
`config.fetch` are enough to reach the POST. Four cases: a plain text error body
(the actual regression), a JSON body, a body that lies about its content type,
and a 409 that exhausts its retries. Each asserts both the error type and
`.cause`.

Checked the tests can fail: inverting the content-type branch in
`httpErrorDetail` fails 10 tests, including all three message-detail cases here.

## 3. ⚪️ `errorMessageFromResponse` sits far from the helper it belongs with

- [x] Addressed
- [ ] Dismissed

It is defined after `handleFetchResult` but the related `httpErrorMessage` is
just above it, and all three do the same job for the same kind of response.
Grouping them, and naming them consistently (`httpErrorMessage` /
`httpErrorDetail`?), would make it obvious they are one small family rather than
three separate utilities. Cosmetic, but this file is long and easy to duplicate
things in, which is how finding 1 happened.

**Fixed.** Renamed `errorMessageFromResponse` to `httpErrorDetail` and it sits
directly after `handleFetchResult`, so after main merges it reads as a pair with
`httpErrorMessage`: one builds the status line, the other reads the body.

## 4. ⚪️ A 409 that exhausts its retries still reports no detail

- [x] Addressed
- [ ] Dismissed

`src/internals.ts:877` now throws the right error type with `.cause`, which is
the important half. But it never reads the body, so the message stays
`publishEvent: 409 - Conflict. attempt 5` with no server explanation, while
every other status now gets one.

Probably fine, since a 409 here means "HEAD raced" and the body rarely adds
anything. Worth a one-line comment saying that is deliberate, otherwise the
asymmetry looks like an oversight.

**Fixed.** Comment added saying the body is deliberately not read, because the
attempt count already explains a 409. Behaviour unchanged.

## Checked and clear

- No consumer parses the `publishEvent:` message string, so changing the thrown
  type from `Error` to `ChelErrorUnexpectedHttpResponseCode` breaks nothing.
  `ChelErrorGenerator` extends `Error`, so `instanceof Error` still holds and
  the persistent-action retry path (which only reads `error.message`) is
  unaffected.
- `src/utils.test.ts` is imported by `src/index.test.ts`, so the new tests do
  run under `npm test`. 147 pass after the fixes above (143 before).
- Merging `origin/main` into this branch is conflict-free.
- The previous code interpolated `undefined` into the message when a JSON body
  had no `message` field; that is now omitted. An improvement, not a regression.
