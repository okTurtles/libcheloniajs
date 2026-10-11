// ugly boilerplate because JavaScript is stupid
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#Custom_Error_Types

import { hasErrorName } from './error-names.js'
import type { KvHeightAheadCause } from './types.js'

type ErrorConstructorType = { new (...args: ConstructorParameters<typeof Error>): Error };

export const ChelErrorGenerator = (name: string, base: ErrorConstructorType = Error) =>
  class extends base {
    constructor (...params: ConstructorParameters<typeof Error>) {
      super(...params)
      this.name = name // string literal so minifier doesn't overwrite
      // Polyfill for cause property
      if (params[1]?.cause !== this.cause) {
        Object.defineProperty(this, 'cause', {
          configurable: true,
          writable: true,
          value: params[1]?.cause
        })
      }
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor)
      }
    }
  }

export const ChelErrorWarning = ChelErrorGenerator('ChelErrorWarning')
export const ChelErrorAlreadyProcessed = ChelErrorGenerator('ChelErrorAlreadyProcessed')
export const ChelErrorDBBadPreviousHEAD = ChelErrorGenerator('ChelErrorDBBadPreviousHEAD')
export const ChelErrorDBConnection = ChelErrorGenerator('ChelErrorDBConnection')
export const ChelErrorUnexpected = ChelErrorGenerator('ChelErrorUnexpected')
export const ChelErrorKeyAlreadyExists = ChelErrorGenerator('ChelErrorKeyAlreadyExists')
export const ChelErrorUnrecoverable = ChelErrorGenerator('ChelErrorUnrecoverable')
export const ChelErrorForkedChain = ChelErrorGenerator('ChelErrorForkedChain')
export const ChelErrorInvalidMessageHeight = ChelErrorGenerator('ChelErrorInvalidMessageHeight')
export const ChelErrorDecryptionError = ChelErrorGenerator('ChelErrorDecryptionError')
export const ChelErrorDecryptionKeyNotFound = ChelErrorGenerator(
  'ChelErrorDecryptionKeyNotFound',
  ChelErrorDecryptionError
)
export const ChelErrorSignatureError = ChelErrorGenerator('ChelErrorSignatureError')
export const ChelErrorSignatureKeyUnauthorized = ChelErrorGenerator(
  'ChelErrorSignatureKeyUnauthorized',
  ChelErrorSignatureError
)
export const ChelErrorSignatureKeyNotFound = ChelErrorGenerator(
  'ChelErrorSignatureKeyNotFound',
  ChelErrorSignatureError
)
export const ChelErrorFetchServerTimeFailed = ChelErrorGenerator('ChelErrorFetchServerTimeFailed')
export const ChelErrorUnexpectedHttpResponseCode = ChelErrorGenerator(
  'ChelErrorUnexpectedHttpResponseCode'
)
export const ChelErrorResourceGone = ChelErrorGenerator(
  'ChelErrorResourceGone',
  ChelErrorUnexpectedHttpResponseCode
)
export const ChelErrorJournalCorrupt = ChelErrorGenerator('ChelErrorJournalCorrupt')
export const ChelErrorKvSlotUnknown = ChelErrorGenerator('ChelErrorKvSlotUnknown')
export const ChelErrorKvSlotInvalid = ChelErrorGenerator('ChelErrorKvSlotInvalid')
export const ChelErrorKvUpdateInvalid = ChelErrorGenerator('ChelErrorKvUpdateInvalid')
export const ChelErrorKvValidation = ChelErrorGenerator('ChelErrorKvValidation')
export const ChelErrorKvConflict = ChelErrorGenerator('ChelErrorKvConflict')
export const ChelErrorKvReentrant = ChelErrorGenerator('ChelErrorKvReentrant')
// A KV value on the server was written at a contract height the local
// contract has not reached, so it cannot be verified yet. Extends
// `ChelErrorInvalidMessageHeight` so existing `instanceof` checks keep
// matching. Its `name` differs on purpose, as does that of
// `ChelErrorKvHeightMalformed`: a name-based guard must not mistake either
// error for the other (syncing helps one, never the other). Match it with
// `isKvHeightAhead`. `.cause` is a `KvHeightAheadCause` (`src/types.ts`).
export const ChelErrorKvHeightAhead = ChelErrorGenerator(
  'ChelErrorKvHeightAhead',
  ChelErrorInvalidMessageHeight
)
// A KV value whose height stamp is missing or malformed: it can never be
// verified, and syncing doesn't help (`clear` the key instead). Extends
// `ChelErrorInvalidMessageHeight`, the name it had before, for `instanceof`;
// match it with `isKvHeightMalformed`. Only the KV selectors throw it:
// `chelonia/parseEncryptedOrUnencryptedDetachedMessage` keeps
// `ChelErrorInvalidMessageHeight`, since it parses non-KV messages too.
export const ChelErrorKvHeightMalformed = ChelErrorGenerator(
  'ChelErrorKvHeightMalformed',
  ChelErrorInvalidMessageHeight
)

// Whether `e` is a `ChelErrorKvHeightAhead`. Name-based, so it also matches
// errors created by another loaded copy of the library (dual ESM/CJS
// builds, bundles), where `instanceof` fails. It also matches a plain
// `{ name, message }` object, such as a slot's `lastError`, although the
// guard narrows to `Error & { name }`: only rely on `name`, `message` and
// `cause` after it. `.cause` may be missing (a `lastError` keeps only the
// name and message): read it with `kvHeightAheadCause`.
export function isKvHeightAhead (
  e: unknown
): e is Error & { name: 'ChelErrorKvHeightAhead'; cause?: KvHeightAheadCause } {
  return hasErrorName(e, 'ChelErrorKvHeightAhead')
}

// Whether `e` is a `ChelErrorKvHeightMalformed`: a KV value whose height
// stamp is missing or malformed. Name-based, like `isKvHeightAhead` (and,
// like it, also true for a plain `{ name, message }` object such as a slot's
// `lastError`). `.cause` is the stamp error.
export function isKvHeightMalformed (
  e: unknown
): e is Error & { name: 'ChelErrorKvHeightMalformed' } {
  return hasErrorName(e, 'ChelErrorKvHeightMalformed')
}

// The `.cause` of a `ChelErrorKvHeightAhead` (`undefined` for any other
// error): the height to wait for, and what the server returned.
export function kvHeightAheadCause (e: unknown): KvHeightAheadCause | undefined {
  if (!isKvHeightAhead(e)) return undefined
  const cause = (e as { cause?: unknown }).cause
  return cause && typeof cause === 'object' ? cause as KvHeightAheadCause : undefined
}

// Whether `e` is a KV write that ran out of attempts resolving `412`
// conflicts: `ChelErrorKvConflict` (from `chelonia/kv/update`,
// `chelonia/kv/clear` and `chelonia/kv/queuedSet`), or the internal error
// raw `chelonia/kv/set` rejects with. Name-based, like `isKvHeightAhead`
// (and, like it, also true for a plain `{ name, message }` object such as a
// slot's `lastError`).
// `.cause`, when present, is `{ currentStatus, currentData, etag }` from the
// last server response (`update` and `clear` normalize `currentData` for
// the slot); `currentData` is omitted when the value is unknown.
export function isKvConflict (
  e: unknown
): e is Error & { name: 'ChelErrorKvConflict' | 'ChelErrorKvMaxAttempts' } {
  return hasErrorName(e, 'ChelErrorKvConflict', 'ChelErrorKvMaxAttempts')
}
