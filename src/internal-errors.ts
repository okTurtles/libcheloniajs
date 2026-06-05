// Internal error classes — NOT part of the public API. These are
// intentionally kept out of `src/errors.ts` (and therefore out of the
// package-root `export *`) so that adding new internal error types
// does not widen the public taxonomy.
import { ChelErrorGenerator } from './errors.js'

// Thrown by the low-level `chelonia/kv/set` primitive when the
// conflict-retry loop exhausts `maxAttempts`. The high-level slot
// API (`chelonia/kv/update` / `chelonia/kv/clear`) catches this and
// remaps it to the public `ChelErrorKvConflict`.
//
// Internal — not part of the published API. The package's
// `exports` map intentionally does not expose `./internal-errors`,
// so this class is only reachable via a deep import. The only
// legitimate external consumer is the `@chelonia/lib` test suite,
// which needs to simulate the low-level throw without going through
// the public `ChelErrorKvConflict` mapping. Application code should
// catch `ChelErrorKvConflict` instead.
export const ChelErrorKvMaxAttempts = ChelErrorGenerator('ChelErrorKvMaxAttempts')
