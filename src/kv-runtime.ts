import type { CheloniaContext } from './types.js'

// Slot definitions (`kvSlots`, `defContractKvByManifest`) are application
// code, so only `chelonia/_init` creates them; everything else is per session.
const startKvSession = (ctx: CheloniaContext): void => {
  clearTimeout(ctx.kvFilterRetryTimer)
  ctx.kvFilterRetryTimer = undefined
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
}

export const initKvRuntime = (ctx: CheloniaContext): void => {
  ctx.kvSlots = new Map()
  ctx.defContractKvByManifest = new Map()
  ctx.kvResetsInProgress = 0
  startKvSession(ctx)
}

export const resetKvRuntime = (ctx: CheloniaContext): void => {
  startKvSession(ctx)
}
