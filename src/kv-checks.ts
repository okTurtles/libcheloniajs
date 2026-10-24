// Checks shared by the KV writers. Internal: not exported from the package root.
import sbp from '@sbp/sbp'
import { ChelErrorKvReentrant, ChelErrorKvUpdateInvalid } from './errors.js'
import type { CheloniaContext } from './types.js'

// The contract's lane is held while its `onUpdate` callbacks run, so a call
// made synchronously from one of them, if awaited there, would never settle
export function assertNotReentrant (
  ctx: CheloniaContext,
  contractID: string,
  key: string | undefined,
  operation: 'update' | 'clear' | 'sync' | 'withHeightRecovery' | 'queuedSet' | 'whenSettled'
): void {
  if ((ctx.kvOnUpdateActive.get(contractID) ?? 0) > 0) {
    const target = key === undefined ? contractID : `${contractID}::${key}`
    throw new ChelErrorKvReentrant(
      `[chelonia/kv] ${operation}: ${target} was called ` +
      'synchronously from within an onUpdate callback for the same ' +
      'contract; this would deadlock the contract lane. Schedule the ' +
      'call off the synchronous stack instead, e.g. ' +
      "queueMicrotask(() => sbp('chelonia/kv/" + operation + "', …))."
    )
  }
}

export function assertMaxAttempts (maxAttempts: unknown, label: string): void {
  if (maxAttempts != null && !(Number.isSafeInteger(maxAttempts) && (maxAttempts as number) >= 1)) {
    throw new ChelErrorKvUpdateInvalid(`[chelonia/kv] ${label}: \`maxAttempts\` must be an integer >= 1`)
  }
}

// Resolved right before each write, so that it uses keys rotated since the call
export function resolveKvKeyIds (
  contractID: string,
  names: { encryptionKeyName: string | null; signingKeyName: string },
  label: string
): { encryptionKeyId: string | null; signingKeyId: string } {
  const { encryptionKeyName, signingKeyName } = names
  const keyId = (name: string): string | null | undefined =>
    sbp('chelonia/contract/currentKeyIdByName', contractID, name)
  const encryptionKeyId = encryptionKeyName === null ? null : keyId(encryptionKeyName)
  if (encryptionKeyName !== null && !encryptionKeyId) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${label}: encryption key '${encryptionKeyName}' not found on contract; ` +
      'refusing to write plaintext'
    )
  }
  const signingKeyId = keyId(signingKeyName)
  if (!signingKeyId) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${label}: signing key '${signingKeyName}' not found on contract`
    )
  }
  return { encryptionKeyId: encryptionKeyId ?? null, signingKeyId }
}
