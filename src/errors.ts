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
// Key-spec API (src/keys.ts). Structural problems in a key declaration
// (invalid type/purpose combination, missing ringLevel on an ordinary key,
// forbidden field combinations, duplicate names) fail with the base error.
export const ChelErrorKeySpecInvalid = ChelErrorGenerator('ChelErrorKeySpecInvalid')
// A wrapping graph (`encryptWith`) that cycles between two or more distinct
// keys and therefore cannot be resolved.
export const ChelErrorKeyWrapCycle = ChelErrorGenerator(
  'ChelErrorKeyWrapCycle',
  ChelErrorKeySpecInvalid
)
// A structurally valid name reference that cannot be resolved against the
// generated key set or the contract state (unknown or revoked key name, or an
// id/name pair that does not match).
export const ChelErrorKeyNameNotFound = ChelErrorGenerator(
  'ChelErrorKeyNameNotFound',
  ChelErrorKeySpecInvalid
)
export const ChelErrorKvSlotUnknown = ChelErrorGenerator('ChelErrorKvSlotUnknown')
export const ChelErrorKvSlotInvalid = ChelErrorGenerator('ChelErrorKvSlotInvalid')
export const ChelErrorKvUpdateInvalid = ChelErrorGenerator('ChelErrorKvUpdateInvalid')
export const ChelErrorKvValidation = ChelErrorGenerator('ChelErrorKvValidation')
export const ChelErrorKvConflict = ChelErrorGenerator('ChelErrorKvConflict')
export const ChelErrorKvReentrant = ChelErrorGenerator('ChelErrorKvReentrant')
