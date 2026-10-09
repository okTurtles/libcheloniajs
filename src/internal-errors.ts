// Internal error classes — NOT part of the public API. These are
// intentionally kept out of `src/errors.ts` (and therefore out of the
// package-root `export *`) so that adding new internal error types
// does not widen the public taxonomy.
import { ChelErrorGenerator } from './errors.js'

// Thrown by the low-level `chelonia/kv/set` primitive when the
// conflict-retry loop exhausts `maxAttempts`, or on a `412` when there is
// no `onconflict` to resolve it. `chelonia/kv/update`,
// `chelonia/kv/clear` and `chelonia/kv/queuedSet` catch this and remap it
// to the public `ChelErrorKvConflict`, so only raw `chelonia/kv/set`
// rejects with it; its callers should match it with `isKvConflict(e)`
// (`src/errors.ts`).
//
// Internal — not part of the published API. The package's
// `exports` map intentionally does not expose `./internal-errors`,
// so this class is only reachable via a deep import. The only
// legitimate external consumer is the `@chelonia/lib` test suite,
// which needs to simulate the low-level throw without going through
// the public `ChelErrorKvConflict` mapping. Application code should
// use `isKvConflict(e)` instead.
export const ChelErrorKvMaxAttempts = ChelErrorGenerator('ChelErrorKvMaxAttempts')

// Realm-safe detection of `ChelErrorKvMaxAttempts`, for the selectors that
// remap it. `ChelErrorGenerator` assigns `.name` from a string literal, so
// it survives a dual ESM/CJS or cross-realm load of `@chelonia/lib` where
// `instanceof` would fail. (`isKvConflict` in `src/errors.ts`, which this
// module imports, matches the name itself.)
export function isKvMaxAttempts (e: unknown): boolean {
  return e instanceof Error && e.name === 'ChelErrorKvMaxAttempts'
}
