import sbp from '@sbp/sbp'
import '@sbp/okturtles.events'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvHeightAhead,
  ChelErrorKvUpdateInvalid,
  ChelErrorUnexpected,
  isKvHeightAhead,
  kvHeightAheadCause
} from './errors.js'
import { CONTRACT_IS_SYNCING } from './events.js'
import type {
  CheloniaContext,
  KvHeightAheadCause,
  KvHeightAheadMode,
  KvHeightListener,
  KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions
} from './types.js'

const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]*)$/

// Mutable so that tests can shorten them
export const kvHeightTimings = {
  // How long to wait for an incoming event to bring the contract to a height
  waitMs: 1500,
  // How long a slot waits for a height before syncing, then settling without it
  pendingFallbackMs: 10000,
  // How long one caller waits for a height-recovery sync
  recoveryTimeoutMs: 30000
}

export const DEFAULT_MAX_HEIGHT_RECOVERIES = 2

// `setTimeout` fires at once for delays of 2^31 ms or more
const MAX_TIMER_MS = 2 ** 31 - 1

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

export type ComposedAbortSignal = AbortSignal & { _cleanup?: () => void }

export function composeSignals (signals: AbortSignal[]): ComposedAbortSignal {
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

// Rejects as soon as `signal` aborts; `promise` carries on regardless
export function abortable<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
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

async function waitForSyncEnd (
  ctx: CheloniaContext,
  contractID: string,
  { timeoutMs = kvHeightTimings.waitMs, signal }: {
    timeoutMs?: number; signal?: AbortSignal | null
  } = {}
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
  { timeoutMs = kvHeightTimings.waitMs, signal }: {
    timeoutMs?: number; signal?: AbortSignal | null
  } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitForSyncEnd(ctx, contractID, { timeoutMs, signal }))) return false
  return waitForHeight(ctx, contractID, minHeight, {
    timeoutMs: Math.max(0, deadline - Date.now()), signal
  })
}

// Rejects at once if `signal` aborts while `body` is queued, or if it never runs.
// Once running, `body` alone decides the outcome (a write may have committed).
export function queueOnLane<T> (
  contractID: string,
  signal: AbortSignal,
  body: () => T | Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal))
    let ran = false
    const onAbort = () => { if (!ran) reject(abortReason(signal)) }
    const queued = sbp('chelonia/queueInvocation', contractID, () => {
      if (signal.aborted) return Promise.reject(abortReason(signal))
      ran = true
      return body()
    }) as Promise<T> | undefined
    if (!queued) {
      throw new ChelErrorUnexpected(`[chelonia/kv] Queueing work for ${contractID} was vetoed`)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    queued.then((result) => {
      // `chelonia/reset` drops queued work
      if (!ran) throw new DOMException(`[chelonia/kv] Work queued for ${contractID} never ran`, 'AbortError')
      resolve(result)
    }).catch(reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function resolveRecoveryOptions (
  options: KvHeightRecoveryOptions | null | undefined,
  operation: string
): { onHeightAhead: KvHeightAheadMode; maxHeightRecoveries: number } {
  const onHeightAhead = options?.onHeightAhead ?? 'sync'
  const maxHeightRecoveries = options?.maxHeightRecoveries ?? DEFAULT_MAX_HEIGHT_RECOVERIES
  if (onHeightAhead !== 'sync' && onHeightAhead !== 'reject') {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${operation}: \`onHeightAhead\` must be 'sync' or 'reject'`
    )
  }
  if (!(Number.isSafeInteger(maxHeightRecoveries) && maxHeightRecoveries >= 0)) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${operation}: \`maxHeightRecoveries\` must be an integer >= 0`
    )
  }
  return { onHeightAhead, maxHeightRecoveries }
}

// One sync per contract, shared by everyone recovering its height
function recoverySync (ctx: CheloniaContext, contractID: string): Promise<void> {
  const running = ctx.kvRecoveries.get(contractID)
  if (running) return running
  const recoveries = ctx.kvRecoveries
  const sync = (async () => {
    let ran = false
    await sbp('chelonia/private/queueEvent', contractID, async () => {
      ran = true
      // Syncing a released contract would subscribe it again
      if (!ctx.subscriptionSet.has(contractID)) {
        throw new ChelErrorUnexpected(`[chelonia/kv] ${contractID} is no longer subscribed`)
      }
      await sbp('chelonia/private/in/syncContract', contractID)
    })
    // An SBP filter vetoed it
    if (!ran) throw new ChelErrorUnexpected(`[chelonia/kv] The recovery sync of ${contractID} never ran`)
  })()
  const forget = () => {
    if (recoveries.get(contractID) === sync) recoveries.delete(contractID)
  }
  sync.then(forget, forget)
  recoveries.set(contractID, sync)
  return sync
}

// Syncs the contract to the height `error` (a `ChelErrorKvHeightAhead`) needs.
// `signal`, which `chelonia/reset` must abort, ends only this caller's wait.
export async function recoverContractHeight (
  ctx: CheloniaContext,
  contractID: string,
  error: unknown,
  { signal }: { signal: AbortSignal }
): Promise<void> {
  const required = kvHeightAheadCause(error)?.requiredHeight
  const reached = () =>
    typeof required === 'number' && (localHeight(ctx, contractID) ?? -1) >= required
  if (signal.aborted) throw abortReason(signal)
  if (reached()) return
  if (ctx.kvResetsInProgress > 0) {
    throw new DOMException('[chelonia/kv] chelonia/reset is in progress', 'AbortError')
  }
  const outcome: { failed?: true; error?: unknown } = {}
  const deadline = Date.now() + kvHeightTimings.recoveryTimeoutMs
  const synced = await waitFor(kvHeightTimings.recoveryTimeoutMs, signal, (done) => {
    let waiting = true
    // A sync that was already running may have stopped short of the height
    const joined = ctx.kvRecoveries.has(contractID)
    recoverySync(ctx, contractID)
      .then(() => {
        if (waiting && joined && !reached()) return recoverySync(ctx, contractID)
      })
      .then(done, (e) => {
        Object.assign(outcome, { failed: true, error: e })
        done()
      })
    return () => { waiting = false }
  })
  if (synced && !outcome.failed) return
  if (outcome.failed && typeof required === 'number' && ctx.subscriptionSet.has(contractID)) {
    await waitForHeight(ctx, contractID, required, {
      timeoutMs: Math.min(kvHeightTimings.waitMs, Math.max(0, deadline - Date.now())), signal
    })
  }
  const why = outcome.failed ? 'its sync failed' : 'its sync is taking too long'
  const details = outcome.failed ? [outcome.error] : []
  if (!reached()) {
    console.warn(`[chelonia/kv] Height recovery for ${contractID} gave up: ${why}`, ...details)
    throw error
  }
  console.warn(`[chelonia/kv] ${contractID} reached the height, though ${why}`, ...details)
}

export async function withHeightRecovery<T> (
  ctx: CheloniaContext,
  contractID: string,
  attempt: (args: KvHeightRecoveryAttempt) => T | Promise<T>,
  options: KvHeightRecoveryOptions | null | undefined,
  operation = 'withHeightRecovery'
): Promise<T> {
  const { onHeightAhead, maxHeightRecoveries } = resolveRecoveryOptions(options, operation)
  const signal = sessionSignal(ctx, options?.signal)
  const queue = <R>(body: () => Promise<R>) => queueOnLane(contractID, signal, body)
  try {
    for (let recoveries = 0; ; recoveries++) {
      if (signal.aborted) throw abortReason(signal)
      const last = onHeightAhead === 'reject' || recoveries >= maxHeightRecoveries
      try {
        // Only the last 'sync' attempt lets `kv/set` wait for the height
        const heightWaitMs = last && onHeightAhead === 'sync' ? undefined : 0
        return await attempt({ recoveries, heightWaitMs, queue })
      } catch (e) {
        if (last || !isKvHeightAhead(e)) throw e
        await recoverContractHeight(ctx, contractID, e, { signal })
      }
    }
  } finally {
    signal._cleanup?.()
  }
}
