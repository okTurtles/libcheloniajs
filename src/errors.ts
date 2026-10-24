import type { KvConflictCause, KvHeightAheadCause } from './types.js'

// ugly boilerplate because JavaScript is stupid
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#Custom_Error_Types

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
export const ChelErrorKvHeightAhead = ChelErrorGenerator(
  'ChelErrorKvHeightAhead',
  ChelErrorInvalidMessageHeight
)
export const ChelErrorKvHeightMalformed = ChelErrorGenerator(
  'ChelErrorKvHeightMalformed',
  ChelErrorInvalidMessageHeight
)

// Names, not classes: the error may come from another copy of the library or
// another realm, or be a plain `{ name, message }` such as a slot's `lastError`.
function hasErrorName<N extends string> (e: unknown, ...names: N[]): e is Error & { name: N } {
  return typeof e === 'object' && e !== null &&
    (names as unknown[]).includes((e as { name?: unknown }).name)
}

export function isKvHeightAhead (e: unknown): e is Error & {
  name: 'ChelErrorKvHeightAhead'; cause?: KvHeightAheadCause
} {
  return hasErrorName(e, 'ChelErrorKvHeightAhead')
}

export function isKvHeightMalformed (e: unknown): e is Error & {
  name: 'ChelErrorKvHeightMalformed'
} {
  return hasErrorName(e, 'ChelErrorKvHeightMalformed')
}

// Also matches the error raw `chelonia/kv/set` throws for a 412 it won't retry
export function isKvConflict (e: unknown): e is Error & {
  name: 'ChelErrorKvConflict' | 'ChelErrorKvMaxAttempts'; cause?: KvConflictCause
} {
  return hasErrorName(e, 'ChelErrorKvConflict', 'ChelErrorKvMaxAttempts')
}

export function kvHeightAheadCause (e: unknown): KvHeightAheadCause | undefined {
  const cause = isKvHeightAhead(e) ? e.cause : undefined
  return typeof cause === 'object' && cause !== null ? cause : undefined
}

// Walks `e` and its `.cause` chain; `maxDepth` counts the errors checked, `e` included.
export function findErrorCause<T> (
  e: unknown,
  predicate: (e: unknown) => e is T,
  maxDepth = 8
): T | undefined {
  for (let depth = 0; depth < maxDepth && typeof e === 'object' && e !== null; depth++) {
    if (predicate(e)) return e
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}
