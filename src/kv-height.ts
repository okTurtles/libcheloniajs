import sbp from '@sbp/sbp'
import '@sbp/okturtles.events'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvHeightAhead
} from './errors.js'
import { CONTRACT_IS_SYNCING } from './events.js'
import { clampTimerDelay } from './timer-utils.js'
import type {
  CheloniaContext,
  KvHeightAheadCause,
  KvHeightListener
} from './types.js'
import { abortReason } from './utils.js'

const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/

export const WEBSOCKET_OPEN = 1

// Mutable so that tests can shorten them
export const kvHeightTimings = {
  // How long to wait for an incoming event to bring the contract to a height
  waitMs: 1500
}

// Re-signs of one `kv/set` call after the server rejected a stale height stamp
export const MAX_STALE_STAMP_RETRIES = 5

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

// An unknown local height (the contract isn't in state) is never reached
export const heightReached = (ctx: CheloniaContext, contractID: string, height: number): boolean =>
  (localHeight(ctx, contractID) ?? -1) >= height

export function heightAheadError (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  { requiredHeight, exact, etag, httpStatus }: Omit<KvHeightAheadCause, 'localHeight'>,
  // `kv/set` gave up on a `409` after `resigns` re-signs, or with a sync of the
  // contract still running: the local height may have reached `requiredHeight`
  { resigns, syncing = false }: { resigns?: number; syncing?: boolean } = {}
): Error & { cause: KvHeightAheadCause } {
  const local = localHeight(ctx, contractID)
  const at = local === undefined ? 'is not loaded' : `is at height ${local}`
  // The local contract reached the height after the write was signed or the
  // value was read
  const caughtUp = local !== undefined && local >= requiredHeight
  const server = () => exact
    ? `the server value was written at contract height ${requiredHeight}`
    : `the server needs contract height ${requiredHeight} or later`
  const reason = resigns !== undefined
    ? caughtUp
      ? `the contract kept advancing: after ${resigns} re-signs the server still rejected the ` +
        `height stamp (it needs contract height ${requiredHeight} or later, which the local ` +
        'contract reached only after the last write was signed)'
      : `the server still rejected the height stamp after ${resigns} re-signs ` +
        `(it needs contract height ${requiredHeight} or later; the local contract ${at})`
    : syncing
      ? caughtUp
        ? `${server()}; the local contract has reached it, but a sync of it is still running`
        : `${server()}; the local contract ${at}, and a sync of it is still running`
      : caughtUp
        ? `${server()}, which the local contract has reached since`
        : `${server()}, but the local contract ${at}`
  const advice = syncing
    ? 'wait for the sync to end and retry'
    : caughtUp ? 'retry' : 'sync the contract and retry'
  return new ChelErrorKvHeightAhead(
    `[chelonia/kv] ${contractID}::${key}: ${reason}; ${advice}`,
    { cause: { requiredHeight, exact, localHeight: local, etag, httpStatus } }
  ) as Error & { cause: KvHeightAheadCause }
}

export type ComposedAbortSignal = AbortSignal & { _cleanup?: () => void }

function composeSignals (signals: AbortSignal[]): ComposedAbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals) as ComposedAbortSignal
  const controller = new AbortController()
  const cleanupFns: Array<() => void> = []
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    const handler = () => abort(signal)
    signal.addEventListener('abort', handler, { once: true })
    cleanupFns.push(() => signal.removeEventListener('abort', handler))
  }
  const composed = controller.signal as ComposedAbortSignal
  composed._cleanup = () => {
    for (const cleanup of cleanupFns.splice(0)) cleanup()
  }
  return composed
}

// Aborted by `signal` or by `chelonia/reset`. Captured now, as a reset replaces
// the controller it aborts.
export const sessionSignal = (
  ctx: CheloniaContext,
  signal?: AbortSignal | null
): ComposedAbortSignal => signal
  ? composeSignals([ctx.abortController.signal, signal])
  : ctx.abortController.signal

type HeightListeners = Set<KvHeightListener>

const dropIfEmpty = (ctx: CheloniaContext, contractID: string, listeners: HeightListeners) => {
  if (!listeners.size && ctx.kvHeightListeners.get(contractID) === listeners) {
    ctx.kvHeightListeners.delete(contractID)
  }
}

// Calls `fire` once, when the local contract commits `minHeight` or later. A
// height already reached doesn't fire it: callers check that first.
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

type HeightWaitOptions = { timeoutMs?: number; signal?: AbortSignal | null }

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
    const timer = setTimeout(() => settle(false), clampTimerDelay(ms))
    signal?.addEventListener('abort', onAbort, { once: true })
    off = subscribe(() => settle(true))
    if (settled) off()
  })
}

// Waits for an incoming event to bring the contract to `minHeight`; not while
// a pubsub socket is down, as no event can arrive then
export async function waitForHeight (
  ctx: CheloniaContext,
  contractID: string,
  minHeight: number,
  { timeoutMs = kvHeightTimings.waitMs, signal }: HeightWaitOptions = {}
): Promise<boolean> {
  if (signal?.aborted) throw abortReason(signal)
  if (heightReached(ctx, contractID, minHeight)) return true
  const socketDown = !!ctx.pubsub && ctx.pubsub.socket?.readyState !== WEBSOCKET_OPEN
  return waitFor(socketDown ? 0 : timeoutMs, signal, (done) =>
    onHeight(ctx, contractID, minHeight, done)
  )
}

async function waitForSyncEnd (
  ctx: CheloniaContext,
  contractID: string,
  { timeoutMs = kvHeightTimings.waitMs, signal }: HeightWaitOptions = {}
): Promise<boolean> {
  if (signal?.aborted) throw abortReason(signal)
  if (!ctx.currentSyncs[contractID]) return true
  return waitFor(timeoutMs, signal, (done) => {
    const listener = (id: string, syncing: boolean) => {
      if (id === contractID && !syncing) done()
    }
    sbp('okTurtles.events/on', CONTRACT_IS_SYNCING, listener)
    return () => sbp('okTurtles.events/off', CONTRACT_IS_SYNCING, listener)
  })
}

// Acting on the height reached partway through a sync would likely still be
// behind the server, so a running sync is waited for first, within one budget
export async function waitForHeightAfterSync (
  ctx: CheloniaContext,
  contractID: string,
  minHeight: number,
  { timeoutMs = kvHeightTimings.waitMs, signal }: HeightWaitOptions = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitForSyncEnd(ctx, contractID, { timeoutMs, signal }))) return false
  return waitForHeight(ctx, contractID, minHeight, {
    timeoutMs: Math.max(0, deadline - Date.now()), signal
  })
}
