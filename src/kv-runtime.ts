// The runtime maps and sets behind KV slots and contract-height waits
// (KV-REVAMPED.md §11.2), created by `chelonia/_init` and cleared by
// `chelonia/reset`. One definition for both, and for the stand-ins of those
// selectors in `kv.test.ts`, so that a new field can't be missed in one of
// them. Internal: not re-exported from `index.ts`.
import sbp from '@sbp/sbp'
import type { CheloniaContext } from './types.js'

// Creates every KV field of the context. Not `kvReconnectListener` /
// `kvContractsModifiedListener`, which `chelonia/connect` installs lazily.
export const initKvRuntime = (ctx: CheloniaContext): void => {
  // `kvSlots` and `defContractKvByManifest` survive `chelonia/reset`
  // because slot definitions are application code.
  ctx.kvSlots = new Map()
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
  ctx.kvHeightWaits = new Map()
  ctx.kvHeightReloadsQueued = new Map()
  ctx.kvRecoveries = new Map()
  ctx.kvHeightSession = new AbortController()
  ctx.kvSuspendedHeightWaits = []
  // Name for `defContractKvByManifest` doesn't start with `kv`, like the
  // preceding keys, for consistency with `defContractManifest`.
  ctx.defContractKvByManifest = new Map()
}

// The per-session part of `chelonia/reset`: everything but the slot
// definitions (`kvSlots`, `defContractKvByManifest`). Called once the old
// session's KV writes and loads were drained (`chelonia/kv/_waitInFlight`),
// so clearing `kvLocalEchoCIDs` / `kvPendingWrites` can't strand a
// continuation mid-write. The caller re-seeds the `_kv` mirror.
export const clearKvRuntime = (ctx: CheloniaContext): void => {
  ctx.kvSlotsByContractID.clear()
  ctx.kvActiveFilters.clear()
  ctx.kvFilterDirty.clear()
  ctx.kvFilterRetry.clear()
  if (ctx.kvFilterRetryTimer != null) {
    clearTimeout(ctx.kvFilterRetryTimer)
    ctx.kvFilterRetryTimer = undefined
  }
  ctx.kvFlushInFlight = false
  ctx.kvLocalEchoCIDs.clear()
  ctx.kvReconnectRefresh.clear()
  ctx.kvPendingWrites.clear()
  ctx.kvPendingLoads.clear()
  ctx.kvOnUpdateActive.clear()
  // Height waits can't have been registered since the height session
  // ended (`chelonia/kv/_endHeightSession`), but listeners of passive
  // height waits started while draining can. Drop them, then start the
  // next session's height session. `kvRecoveries` was drained by
  // `_waitInFlight`.
  sbp('chelonia/kv/_clearHeightWaits')
  ctx.kvHeightSession = new AbortController()
  ctx.kvSuspendedHeightWaits = []
  ctx.kvRecoveries.clear()
}
