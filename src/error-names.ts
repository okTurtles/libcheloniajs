// Internal: the name check behind the realm-safe error predicates of
// `src/errors.ts` and `src/internal-errors.ts`. Not re-exported from
// `src/index.ts`, and registers no selectors.

// Whether `e` is an object whose `name` is one of `names`. Name-based, so it
// matches errors created by another loaded copy of the library (dual
// ESM/CJS builds, bundles, other realms), where `instanceof` fails, and plain
// `{ name, message }` objects such as a slot's `lastError`.
export function hasErrorName<N extends string> (
  e: unknown,
  ...names: N[]
): e is Error & { name: N } {
  return !!e && typeof e === 'object' && names.includes((e as { name?: unknown }).name as N)
}

// The `.cause` of `e` as a `T`, when it is an object (`undefined`
// otherwise, also for a plain `{ name, message }` such as `lastError`).
// Callers check what `e` is first: `T` isn't checked.
export function objectCause<T extends object> (e: unknown): T | undefined {
  const cause = (e as { cause?: unknown } | null | undefined)?.cause
  return cause && typeof cause === 'object' ? cause as T : undefined
}
