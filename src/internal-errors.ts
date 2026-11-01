// Internal error classes — NOT part of the public API. These are
// intentionally kept out of `src/errors.ts` (and therefore out of the
// package-root `export *`) so that adding new internal error types
// does not widen the public taxonomy.
import { ChelErrorGenerator, isKvConflict } from './errors.js'
import type { KvConflictCause } from './types.js'

// Thrown by the low-level `chelonia/kv/set` primitive when the
// conflict-retry loop exhausts `maxAttempts`, or on a 412 without
// `onconflict`. `chelonia/kv/update`, `clear` and `queuedSet` catch this and
// remap it to the public `ChelErrorKvConflict`.
//
// Internal — not part of the published API. The package's
// `exports` map intentionally does not expose `./internal-errors`,
// so this class is only reachable via a deep import. The only
// legitimate external consumer is the `@chelonia/lib` test suite,
// which needs to simulate the low-level throw without going through
// the public `ChelErrorKvConflict` mapping. Application code should
// use `isKvConflict`, which matches both.
export const ChelErrorKvMaxAttempts = ChelErrorGenerator('ChelErrorKvMaxAttempts')

export function isKvMaxAttempts (e: unknown): e is Error & {
  name: 'ChelErrorKvMaxAttempts'; cause?: KvConflictCause
} {
  return isKvConflict(e) && e.name === 'ChelErrorKvMaxAttempts'
}
