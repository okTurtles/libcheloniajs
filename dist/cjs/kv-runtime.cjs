"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearKvRuntime = exports.initKvRuntime = void 0;
// The runtime maps and sets behind KV slots and contract-height waits
// (KV-REVAMPED.md §11.2), created by `chelonia/_init` and replaced by
// `chelonia/reset`. One definition for both, and for the stand-ins of those
// selectors in `kv.test.ts`, so that a new field can't be missed in one of
// them. Internal: not re-exported from `index.ts`.
const kv_height_js_1 = require("./kv-height.cjs");
// Creates every per-session KV field of the context: everything but the
// slot definitions (`kvSlots`, `defContractKvByManifest`) and the count of
// resets in progress (`kvHeightSessionHolds`), which survive
// `chelonia/reset`. New instances rather than `.clear()`: every user reads
// them from the context when it runs, except `whenSettled`, which keeps the
// `kvSettleWaiters` map it registered in, so that its cleanup can't touch
// the next session's map (reset rejects it anyway).
const initKvSession = (ctx) => {
    ctx.kvSlotsByContractID = new Map();
    ctx.kvActiveFilters = new Map();
    ctx.kvFilterDirty = new Set();
    ctx.kvFilterRetry = new Set();
    ctx.kvFilterRetryTimer = undefined;
    ctx.kvFlushInFlight = false;
    ctx.kvLocalEchoCIDs = new Map();
    ctx.kvReconnectRefresh = new Set();
    ctx.kvPendingWrites = new Map();
    ctx.kvPendingLoads = new Map();
    ctx.kvOnUpdateActive = new Map();
    ctx.kvHeightListeners = new Map();
    ctx.kvHeightWaits = new Map();
    ctx.kvHeightReloadsQueued = new Map();
    ctx.kvRecoveries = new Map();
    ctx.kvHeightSession = new AbortController();
    ctx.kvSuspendedHeightWaits = [];
    ctx.kvSettleWaiters = new Map();
    ctx.kvReconciledContracts = new Set();
};
// Creates every KV field of the context. Not `kvReconnectListener` /
// `kvContractsModifiedListener`, which `chelonia/connect` installs lazily.
const initKvRuntime = (ctx) => {
    // `kvSlots` and `defContractKvByManifest` survive `chelonia/reset`
    // because slot definitions are application code.
    ctx.kvSlots = new Map();
    // Name for `defContractKvByManifest` doesn't start with `kv`, like the
    // preceding keys, for consistency with `defContractManifest`.
    ctx.defContractKvByManifest = new Map();
    // Counts the `chelonia/reset` calls in progress, across the resets
    // themselves (see `chelonia/kv/_finishHeightSession`).
    ctx.kvHeightSessionHolds = 0;
    initKvSession(ctx);
};
exports.initKvRuntime = initKvRuntime;
// The per-session part of `chelonia/reset`: everything but the slot
// definitions (`kvSlots`, `defContractKvByManifest`) and
// `kvHeightSessionHolds`. Called once the old session's KV writes and
// loads were drained (`chelonia/kv/_waitInFlight`, which also drains
// `kvRecoveries`), so dropping `kvLocalEchoCIDs` / `kvPendingWrites`
// can't strand a continuation mid-write. The caller re-seeds the `_kv`
// mirror, and then releases its reset's hold on the height session
// (`chelonia/kv/_finishHeightSession`).
const clearKvRuntime = (ctx) => {
    if (ctx.kvFilterRetryTimer != null)
        clearTimeout(ctx.kvFilterRetryTimer);
    // Height waits can't have been registered since the height session
    // ended (`chelonia/kv/_endHeightSession`), but listeners of passive
    // height waits started while draining can. Drop them (and their
    // fallback timers) before the next session starts: those of `ctx`, which
    // isn't necessarily the context the selectors are registered with.
    (0, kv_height_js_1.clearHeightWaits)(ctx);
    initKvSession(ctx);
};
exports.clearKvRuntime = clearKvRuntime;
