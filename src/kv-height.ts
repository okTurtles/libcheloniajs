import sbp from '@sbp/sbp'
import { ChelErrorInvalidMessageHeight, ChelErrorKvHeightAhead } from './errors.js'
import type { CheloniaContext, KvHeightAheadCause } from './types.js'

const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/

// Mutable so that tests can shorten them
export const kvHeightTimings = {
  // How long to wait for an incoming event to bring the contract to a height
  waitMs: 1500
}

// `setTimeout` fires at once for delays of 2^31 ms or more
const MAX_TIMER_MS = 2 ** 31 - 1

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

export const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError')

type HeightListeners = Set<{ minHeight: number; fire: () => void }>

const dropIfEmpty = (ctx: CheloniaContext, contractID: string, listeners: HeightListeners) => {
  if (!listeners.size && ctx.kvHeightListeners.get(contractID) === listeners) {
    ctx.kvHeightListeners.delete(contractID)
  }
}

// Calls `fire` once, when the local contract commits `minHeight` or later
export function onHeight (
  ctx: CheloniaContext,
  contractID: string,
  minHeight: number,
  fire: () => void
): () => void {
  const listeners = ctx.kvHeightListeners.get(contractID) ?? new Set()
  ctx.kvHeightListeners.set(contractID, listeners)
  const listener = { minHeight, fire }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    dropIfEmpty(ctx, contractID, listeners)
  }
}

export function notifyContractHeight (
  ctx: CheloniaContext,
  contractID: string,
  height: number
): void {
  const listeners = ctx.kvHeightListeners.get(contractID)
  if (!listeners) return
  for (const listener of listeners) {
    if (listener.minHeight > height) continue
    listeners.delete(listener)
    try {
      listener.fire()
    } catch (e) {
      console.error(`[chelonia/kv] Height listener for ${contractID} failed`, e)
    }
  }
  dropIfEmpty(ctx, contractID, listeners)
}

// `true` once `subscribe` calls back, `false` after `ms`; rejects if `signal` aborts
function waitFor (
  ms: number,
  signal: AbortSignal | null | undefined,
  subscribe: (done: () => void) => () => void
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    if (!(ms > 0)) return resolve(false)
    let settled = false
    let off = () => {}
    const settle = (result: boolean | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      off()
      if (result === null) reject(abortReason(signal!))
      else resolve(result)
    }
    const onAbort = () => settle(null)
    const timer = setTimeout(() => settle(false), Math.min(ms, MAX_TIMER_MS))
    signal?.addEventListener('abort', onAbort, { once: true })
    off = subscribe(() => settle(true))
    if (settled) off()
  })
}

export async function sleep (ms: number, signal?: AbortSignal | null): Promise<void> {
  await waitFor(ms, signal, () => () => {})
}

// Waits for an incoming event to bring the contract to `minHeight`; not while
// a pubsub socket is down, as no event can arrive then
export async function waitForHeight (
  ctx: CheloniaContext,
  contractID: string,
  minHeight: number,
  { timeoutMs = kvHeightTimings.waitMs, signal }: {
    timeoutMs?: number; signal?: AbortSignal | null
  } = {}
): Promise<boolean> {
  if (signal?.aborted) throw abortReason(signal)
  if ((localHeight(ctx, contractID) ?? -1) >= minHeight) return true
  const socketDown = !!ctx.pubsub && ctx.pubsub.socket?.readyState !== WebSocket.OPEN
  return waitFor(socketDown ? 0 : timeoutMs, signal, (done) =>
    onHeight(ctx, contractID, minHeight, done)
  )
}
