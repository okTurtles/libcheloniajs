// Internal error classes — NOT part of the public API. These are
// intentionally kept out of `src/errors.ts` (and therefore out of the
// package-root `export *`) so that adding new internal error types
// does not widen the public taxonomy.
import { ChelErrorGenerator, isKvConflict } from './errors.js'
import type { KvConflictCause } from './types.js'

// Thrown by the low-level `chelonia/kv/set` primitive when the
// conflict-retry loop exhausts `maxAttempts`, on a 412 without
// `onconflict`, or on a conflict value that can't be read (`reason`).
// `chelonia/kv/update`, `clear` and `queuedSet` catch this and remap it to
// the public `ChelErrorKvConflict`.
//
// Internal — not part of the published API. The package's
// `exports` map intentionally does not expose `./internal-errors`,
// so this class is only reachable via a deep import. The only
// legitimate external consumer is the `@chelonia/lib` test suite,
// which needs to simulate the low-level throw without going through
// the public `ChelErrorKvConflict` mapping. Application code should
// use `isKvConflict`, which matches both.
export const ChelErrorKvMaxAttempts = ChelErrorGenerator('ChelErrorKvMaxAttempts')

// Why `kv/set` gave up. The cause can't tell: a final 412 whose value doesn't
// decode leaves `currentStatus` out too.
export type KvMaxAttemptsReason = 'attempts' | 'unreadable' | 'no-onconflict'

export function isKvMaxAttempts (e: unknown): e is Error & {
  name: 'ChelErrorKvMaxAttempts'; cause?: KvConflictCause; reason?: KvMaxAttemptsReason
} {
  return isKvConflict(e) && e.name === 'ChelErrorKvMaxAttempts'
}

const KV_CONFLICT_TEXT: Record<KvMaxAttemptsReason, string> = {
  attempts: 'ran out of attempts resolving conflicts',
  unreadable: "got a conflict whose value can't be read",
  'no-onconflict': 'got a conflict, and no onconflict handler was provided'
}

// `label` is `<selector>: <contractID>::<key>`
export function kvMaxAttemptsError (
  label: string, reason: KvMaxAttemptsReason, cause: KvConflictCause
): Error & { reason: KvMaxAttemptsReason } {
  return Object.assign(
    new ChelErrorKvMaxAttempts(`[chelonia/kv] ${label} ${KV_CONFLICT_TEXT[reason]}`, { cause }),
    { reason }
  )
}

// The text for an error that wraps `e`; that of `'attempts'` if `e` has no reason
export function kvConflictText (e: unknown): string {
  const reason = (e as { reason?: unknown } | null)?.reason
  return typeof reason === 'string' && Object.hasOwn(KV_CONFLICT_TEXT, reason)
    ? KV_CONFLICT_TEXT[reason as KvMaxAttemptsReason]
    : KV_CONFLICT_TEXT.attempts
}
