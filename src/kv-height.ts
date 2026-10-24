import sbp from '@sbp/sbp'
import { ChelErrorInvalidMessageHeight, ChelErrorKvHeightAhead } from './errors.js'
import type { CheloniaContext, KvHeightAheadCause } from './types.js'

const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/

// The server checks `Number(stamp)`; a lenient parse ('1e1' as 1) would let a
// revoked key pass the key-window check with a stamp the server accepts.
export function readHeightStamp (
  serializedData: unknown,
  ErrorClass: new (message: string) => Error = ChelErrorInvalidMessageHeight
): number {
  const stamp = (serializedData as { height?: unknown } | null | undefined)?.height
  const height = typeof stamp === 'string' && CANONICAL_HEIGHT.test(stamp) ? Number(stamp) : stamp
  if (typeof height === 'number' && Number.isSafeInteger(height) && height >= 0) return height
  throw new ErrorClass(
    `[chelonia] Invalid height stamp ${String(JSON.stringify(stamp)).slice(0, 32)}`
  )
}

export function localHeight (ctx: CheloniaContext, contractID: string): number | undefined {
  const height = sbp(ctx.config.stateSelector)?.contracts?.[contractID]?.height
  return typeof height === 'number' ? height : undefined
}

export function heightAheadError (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  { requiredHeight, exact, etag, httpStatus }: Omit<KvHeightAheadCause, 'localHeight'>
): Error & { cause: KvHeightAheadCause } {
  const local = localHeight(ctx, contractID)
  const server = exact
    ? `the server value was written at contract height ${requiredHeight}`
    : `the server needs contract height ${requiredHeight} or later`
  return new ChelErrorKvHeightAhead(
    `[chelonia/kv] ${contractID}::${key}: ${server}, but the local ` +
      `contract ${local === undefined ? 'is not loaded' : `is at height ${local}`}; ` +
      'sync the contract and retry',
    { cause: { requiredHeight, exact, localHeight: local, etag, httpStatus } }
  ) as Error & { cause: KvHeightAheadCause }
}
