// Checks shared by the KV selectors. Internal: not exported from the package root.
import { ChelErrorKvUpdateInvalid } from './errors.js'

// `null` and `undefined` stand for the option's default
export function assertIntegerOption (
  name: string,
  value: unknown,
  min: number,
  label: string,
  ErrorClass: new (message: string) => Error = ChelErrorKvUpdateInvalid
): void {
  if (value != null && !(Number.isSafeInteger(value) && (value as number) >= min)) {
    throw new ErrorClass(`[chelonia/kv] ${label}: \`${name}\` must be a safe integer >= ${min}`)
  }
}
