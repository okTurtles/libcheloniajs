import type { CheloniaContext } from './types.js'

// Slot definitions (`kvSlots`, `defContractKvByManifest`) are application
// code, so only `chelonia/_init` creates them; everything else is per session.
// The old session's `whenSettled` waits end with an `AbortError`.
const startKvSession = (ctx: CheloniaContext, endedBy: string): void => {
  const settleWaiters = ctx.kvSettleWaiters
  clearTimeout(ctx.kvFilterRetryTimer)
  ctx.kvFilterRetryTimer = undefined
  ctx.kvHeightWaits?.forEach((wait) => clearTimeout(wait.timer))
  ctx.kvHeightWaits = new Map()
  ctx.kvSlotsByContractID = new Map()
  ctx.kvActiveFilters = new Map()
  ctx.kvFilterDirty = new Set()
  ctx.kvFilterRetry = new Set()
  ctx.kvFlushInFlight = false
  ctx.kvLocalEchoCIDs = new Map()
  ctx.kvReconnectRefresh = new Set()
  ctx.kvPendingWrites = new Map()
  ctx.kvPendingLoads = new Map()
  ctx.kvOnUpdateActive = new Map()
  ctx.kvHeightListeners = new Map()
  ctx.kvRecoveries = new Map()
  ctx.kvSettleWaiters = new Map()
  ctx.kvReconciledContracts = new Set()
  ctx.kvResyncedContracts = new Set()
  settleWaiters?.forEach((waiters, waitKey) => {
    const error = new DOMException(
      `[chelonia/kv] whenSettled: ${endedBy} ended the wait for ${waitKey}`, 'AbortError'
    )
    for (const waiter of waiters) waiter.reject(error)
  })
}

export const initKvRuntime = (ctx: CheloniaContext): void => {
  ctx.kvSlots = new Map()
  ctx.defContractKvByManifest = new Map()
  // A reset still draining counts until its `finally`
  ctx.kvResetsInProgress ??= 0
  startKvSession(ctx, 'chelonia/_init')
}

export const resetKvRuntime = (ctx: CheloniaContext): void => {
  startKvSession(ctx, 'chelonia/reset')
}
