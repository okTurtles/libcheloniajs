// KV slot API — see KV-REVAMPED.md for the full design.
//
// This module implements the declarative KV slot API layered on top of the
// existing `chelonia/kv/*` primitives (`chelonia/kv/set`,
// `chelonia/kv/get`, `chelonia/kv/setFilter`, `chelonia/kv/queuedSet`).
// Behaviour lands incrementally — see the kv-revamped task plan.

import { Buffer } from 'buffer'
import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import { cloneDeep } from 'turtledash'
import {
  ChelErrorKvConflict,
  ChelErrorKvSlotInvalid,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorKvValidation
} from './errors.js'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
import type {
  CheloniaContext,
  ChelRootState,
  JSONType,
  KvLoadStatus,
  KvSlotDefinition,
  KvUpdateCtx,
  KvUpdater,
  ParsedEncryptedOrUnencryptedMessage,
  SlotDefinition
} from './types.js'

// Reserved sentinel returned by a `KvUpdater` to abort a write without
// touching the server (replaces the legacy `return null` idiom from
// `chelonia/kv/set`'s `onconflict`).
//
// `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the sentinel
// survives realm boundaries — iframes, workers, and the dual ESM/CJS
// load of `@chelonia/lib`. The string key is namespaced
// (`@chelonia/lib/KV_NOOP`) to make a userland collision implausible.
export const KV_NOOP: unique symbol = Symbol.for('@chelonia/lib/KV_NOOP') as never

// ---------------------------------------------------------------------------
// Internal helpers (pure — no SBP context required)
// ---------------------------------------------------------------------------

const registryKey = (contractType: string, key: string): string =>
  `${contractType}::${key}`

// Resolve a public `KvSlotDefinition` into its internal `SlotDefinition`
// form. `contractType` arrays are flattened by the caller; this helper
// produces one `SlotDefinition` per (already-singular) `contractType`.
//
// The `defaultValue` factory is invoked exactly once here — per the
// KV-REVAMPED §4.1 contract that factories run at registration time
// and the result is what every subsequent reader sees.
function resolveSlotDefinition (
  def: KvSlotDefinition,
  contractType: string,
  resolvedDefault: JSONType | undefined
): SlotDefinition {
  return {
    contractType,
    key: def.key,
    defaultValue: def.defaultValue as JSONType | (() => JSONType),
    resolvedDefault,
    schema: def.schema,
    match: def.match,
    encryptionKeyName: def.encryptionKeyName ?? 'cek',
    signingKeyName: def.signingKeyName ?? 'csk',
    defaultUpdater: def.defaultUpdater,
    autoSubscribe: def.autoSubscribe ?? true,
    autoLoad: def.autoLoad ?? 'on-sync',
    refreshOnReconnect: def.refreshOnReconnect ?? true,
    onUpdate: def.onUpdate
  }
}

// KV-REVAMPED §4.1: three registration-time guards against schemas
// that collide with the wire sentinels or are async-only.
//
// 1. `schema.parse(null)` succeeds → `null` is reserved as the clear
//    sentinel, so the schema cannot disambiguate "cleared" from
//    "explicit null".
// 2. `schema.parse(undefined)` succeeds → collides with the mirror's
//    "not yet loaded" representation.
// 3. `resolvedDefault` round-trip: `parse(parse(resolvedDefault))`
//    must produce a JSON-equal value to the first parse, catching
//    schemas that silently drop or coerce fields.
//
// Additionally, any `schema.parse` that returns a thenable is
// rejected — v1 supports synchronous parsers only.
function assertSchemaGuards (slot: SlotDefinition): void {
  const schema = slot.schema
  if (!schema) return
  // Guard 1 + 2 + thenable detection in one pass per sentinel.
  for (const sentinel of [null, undefined]) {
    let parsed: unknown
    try {
      parsed = schema.parse(sentinel)
    } catch {
      continue // schema correctly rejected the sentinel
    }
    if (parsed && typeof (parsed as { then?: unknown }).then === 'function') {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
        'async/thenable schema parser; v1 supports synchronous parsers only'
      )
    }
    throw new ChelErrorKvSlotInvalid(
      `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema must ` +
      `reject the reserved wire sentinel ${String(sentinel)}`
    )
  }
  // Guard 3: round-trip of resolvedDefault.
  // Skipped when there is no resolvedDefault — nothing to round-trip.
  if (slot.resolvedDefault !== undefined) {
    let first: unknown
    try {
      first = schema.parse(slot.resolvedDefault)
    } catch (e) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} resolved ` +
        'defaultValue failed schema.parse at registration',
        { cause: e }
      )
    }
    if (first && typeof (first as { then?: unknown }).then === 'function') {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
        'async/thenable schema parser; v1 supports synchronous parsers only'
      )
    }
    let second: unknown
    try {
      second = schema.parse(first)
    } catch (e) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema is ` +
        'not idempotent on its own parsed output (defaultValue round-trip failed)',
        { cause: e }
      )
    }
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema ` +
        'silently coerces or drops fields of the resolved defaultValue'
      )
    }
    if (JSON.stringify(slot.resolvedDefault) !== JSON.stringify(first)) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema ` +
        'silently coerces or drops fields of the resolved defaultValue'
      )
    }
  }
}

// Ensure `rootState._kv[contractID]` exists as a reactive object. Returns
// the per-contract record. Idempotent.
type KvMirrorEntry = {
  value: JSONType | undefined;
  etag: string | null;
  status: KvLoadStatus;
  lastError?: { name: string; message: string };
}

function ensureContractKv (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string
): Record<string, KvMirrorEntry> {
  if (!rootState._kv) {
    ctx.config.reactiveSet(rootState, '_kv', Object.create(null))
  }
  const perContract = rootState._kv![contractID]
  if (!perContract) {
    const fresh = Object.create(null)
    ctx.config.reactiveSet(rootState._kv!, contractID, fresh)
    return fresh
  }
  return perContract
}

// Emit a `CHELONIA_KV_STATUS_CHANGED` event after writing the new status
// onto the mirror entry. Skips the emit if the status is unchanged.
function setSlotStatus (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  contractType: string,
  key: string,
  status: KvLoadStatus,
  lastError?: { name: string; message: string }
): void {
  const perContract = ensureContractKv(ctx, rootState, contractID)
  const entry = perContract[key]
  if (!entry) return
  const previousStatus = entry.status
  const statusUnchanged = previousStatus === status
  if (statusUnchanged && !lastError && !entry.lastError) return
  // Clear stale lastError even when status hasn't changed.
  if (!lastError && entry.lastError) {
    ctx.config.reactiveDel(entry as unknown as Record<string, unknown>, 'lastError')
  }
  if (lastError) {
    ctx.config.reactiveSet(entry, 'lastError', lastError)
  }
  if (statusUnchanged) return
  ctx.config.reactiveSet(entry, 'status', status)
  sbp('okTurtles.events/emit', CHELONIA_KV_STATUS_CHANGED, {
    contractID,
    contractType,
    key,
    status,
    previousStatus,
    ...(lastError ? { lastError } : {})
  })
}

// Normalize a thrown value into `{ name, message }`, matching the
// convention used elsewhere in the library (see journal.ts).
function normalizeError (e: unknown): { name: string; message: string } {
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    const err = e as { name?: unknown; message?: unknown }
    return {
      name: typeof err.name === 'string' ? err.name : 'Error',
      message: typeof err.message === 'string' ? err.message : String(e)
    }
  }
  let message: string
  try { message = String(e) } catch { message = '' }
  return { name: typeof e, message }
}

// 128-bit random nonce, base64-encoded. Used by `chelonia/kv/update`
// for self-echo suppression (KV-REVAMPED §4.9). Collision between
// independent writers is cryptographically negligible at this width,
// so a remote write can never be misclassified as a local echo.
function base64Nonce (): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

// Unwrap a `{ __chelKvNonce, value }` envelope. Raw-API writers may
// not wrap, so fall back to the data verbatim — same tolerance as
// `_loadSlot` / `_handleRemote`.
function unwrapData (data: JSONType): JSONType {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    '__chelKvNonce' in (data as object) &&
    'value' in (data as object)
  ) {
    return (data as { value: JSONType }).value
  }
  return data
}

// Push a nonce onto the per-(contractID, key) FIFO, trimming to at
// most 8 entries (KV-REVAMPED §4.9 step 2). The cap is enough to
// absorb bursts of concurrent local writes without unbounded growth.
function recordEchoNonce (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  nonce: string
): void {
  const echoKey = `${contractID}::${key}`
  let fifo = ctx.kvLocalEchoNonces.get(echoKey)
  if (!fifo) {
    fifo = []
    ctx.kvLocalEchoNonces.set(echoKey, fifo)
  }
  fifo.push(nonce)
  while (fifo.length > 8) fifo.shift()
}

// Invoke `onUpdate` with the dispatcher's MUST-NOT-throw contract:
// both synchronous throws and rejected promises are caught and logged.
// See KV-REVAMPED §4.1.
async function safeOnUpdate (
  slot: SlotDefinition,
  value: JSONType | undefined,
  ctx: KvUpdateCtx
): Promise<void> {
  if (!slot.onUpdate) return
  try {
    const ret = slot.onUpdate(value, ctx)
    if (ret && typeof (ret as { then?: unknown }).then === 'function') {
      await ret
    }
  } catch (e) {
    console.error(
      `[chelonia/kv] onUpdate threw for ${ctx.contractID}::${ctx.key}`,
      e
    )
  }
}

// ---------------------------------------------------------------------------
// Filter-flush coalescing (KV-REVAMPED §11.5)
// ---------------------------------------------------------------------------

// One `setFilter` frame per (contract, microtask) — even if N slots
// reconcile in the same tick. The flush snapshots
// `kvActiveFilters[cID]` at flush time, so any subsequent in-tick
// mutation is naturally folded into the single emitted frame.
function queueFilterFlush (ctx: CheloniaContext, contractID: string): void {
  const wasEmpty = ctx.kvFilterDirty.size === 0
  ctx.kvFilterDirty.add(contractID)
  if (wasEmpty) {
    queueMicrotask(() => {
      const dirty = Array.from(ctx.kvFilterDirty)
      ctx.kvFilterDirty.clear()
      for (const cID of dirty) {
        const active = ctx.kvActiveFilters.get(cID)
        try {
          sbp('chelonia/kv/setFilter', cID, active ? [...active] : [])
        } catch (e) {
          // setFilter is a thin passthrough to pubsub; a throw here is
          // almost certainly a missing pubsub connection. Log and
          // continue — the next reconnect or explicit refresh will
          // re-emit the desired filter.
          console.warn(`[chelonia/kv] setFilter flush failed for ${cID}`, e)
        }
      }
    })
  }
}

export default (sbp('sbp/selectors/register', {
  // Dev-time invariant check. See KV-REVAMPED.md §11.2 ("Index
  // invariant"). Walks the four KV maps + `rootState._kv` and verifies:
  //
  //   kvSlotsByContractID[cID].has(key) ⇔
  //     (a) kvSlots has a registration for `${contractType}::${key}` whose
  //         contractType matches rootState.contracts[cID]._vm.type, AND
  //     (b) cID ∈ subscriptionSet, AND
  //     (c) kvActiveFilters[cID].has(key).
  //
  // Throws a plain Error on the first inconsistency found — this is a
  // CI / test-suite assertion, not a user-facing error class. Intended
  // to be called from each KV test's `afterEach`. Cheap enough to run
  // unconditionally in tests; gate behind a build-time flag in
  // production if it ever ships there.
  'chelonia/kv/_assertIndexConsistent': function (this: CheloniaContext) {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    // Forward direction: every entry in kvSlotsByContractID must be
    // mirrored in kvActiveFilters and kvSlots, and the contract must
    // be in subscriptionSet with a matching _vm.type.
    for (const [cID, perKey] of this.kvSlotsByContractID) {
      if (!this.subscriptionSet.has(cID)) {
        throw new Error(
          `[chelonia/kv] index invariant: kvSlotsByContractID has entry for ${cID} ` +
          'but it is not in subscriptionSet'
        )
      }
      const contractType = rootState.contracts?.[cID]?.type
      const activeFilter = this.kvActiveFilters.get(cID)
      if (!activeFilter) {
        throw new Error(
          `[chelonia/kv] index invariant: kvSlotsByContractID[${cID}] exists ` +
          'but kvActiveFilters has no entry'
        )
      }
      for (const [key, slot] of perKey) {
        if (slot.contractType !== contractType) {
          throw new Error(
            `[chelonia/kv] index invariant: slot ${cID}::${key} has contractType ` +
            `${slot.contractType} but rootState.contracts[${cID}].type is ${String(contractType)}`
          )
        }
        const rKey = registryKey(slot.contractType, key)
        const registered = this.kvSlots.get(rKey)
        if (!registered) {
          throw new Error(
            `[chelonia/kv] index invariant: slot ${cID}::${key} is indexed but ` +
            `not present in kvSlots under ${rKey}`
          )
        }
        if (registered !== slot) {
          throw new Error(
            `[chelonia/kv] index invariant: slot ${cID}::${key} indexed entry does ` +
            `not match kvSlots[${rKey}] (stale definition)`
          )
        }
        if (slot.autoSubscribe && !activeFilter.has(key)) {
          throw new Error(
            `[chelonia/kv] index invariant: ${cID}::${key} indexed but not in ` +
            'kvActiveFilters'
          )
        }
        if (!slot.autoSubscribe && activeFilter.has(key)) {
          throw new Error(
            `[chelonia/kv] index invariant: ${cID}::${key} is autoSubscribe:false ` +
            'but is in kvActiveFilters'
          )
        }
      }
    }
    // Reverse direction: every kvActiveFilters entry must be in the
    // per-contract slot index. (kvActiveFilters[cID] may legitimately
    // be an empty set during a microtask gap, but if it has any keys
    // they must be reflected in the slot index.)
    for (const [cID, activeFilter] of this.kvActiveFilters) {
      const perKey = this.kvSlotsByContractID.get(cID)
      if (activeFilter.size === 0) continue
      if (!perKey) {
        throw new Error(
          `[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${activeFilter.size} ` +
          'entries but kvSlotsByContractID has no entry'
        )
      }
      for (const key of activeFilter) {
        if (!perKey.has(key)) {
          throw new Error(
            `[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${key} but ` +
            'kvSlotsByContractID lacks it'
          )
        }
      }
    }
  },

  // Public API. See KV-REVAMPED.md §4.1. Idempotent per
  // `(contractType, key)` — last call wins, with re-validation of any
  // persisted mirror values against the new schema.
  'chelonia/kv/defineSlot': function (
    this: CheloniaContext,
    def: KvSlotDefinition
  ): void {
    if (!def || typeof def !== 'object') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid definition')
    }
    if (typeof def.key !== 'string' || def.key.length === 0) {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid key')
    }
    const types = Array.isArray(def.contractType) ? def.contractType : [def.contractType]
    if (types.length === 0) {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: contractType required')
    }
    // Resolve the default value once before the loop — factories must run
    // exactly once regardless of how many contract types are listed
    // (KV-REVAMPED §4.1).
    const dv = def.defaultValue
    const resolvedDefault: JSONType | undefined = typeof dv === 'function' ? dv() : dv
    for (const contractType of types) {
      if (typeof contractType !== 'string' || contractType.length === 0) {
        throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid contractType')
      }
      const slot = resolveSlotDefinition(def, contractType, resolvedDefault)
      assertSchemaGuards(slot)
      const rKey = registryKey(contractType, def.key)
      const previous = this.kvSlots.get(rKey)
      this.kvSlots.set(rKey, slot)
      // Walk every synced contract whose type matches and reconcile.
      // This both wires up newly-eligible contracts and re-validates
      // persisted mirror entries when `previous` exists (§4.1
      // "Cached-value re-validation on slot replacement").
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      for (const cID of this.subscriptionSet) {
        const meta = rootState.contracts?.[cID]
        if (!meta || meta.type !== contractType) continue
        // If a previous definition existed and the contract was
        // already in the index under it, the index entry has to be
        // refreshed to point at the new slot object before
        // `_reconcileForSlot` runs (the invariant check otherwise
        // trips on `registered !== slot`).
        if (previous) {
          const perKey = this.kvSlotsByContractID.get(cID)
          if (perKey && perKey.get(def.key) === previous) {
            perKey.set(def.key, slot)
          }
          // Re-validate any persisted mirror entry against the new
          // schema; surface failures via status/event but keep the
          // old value (§4.1).
          revalidateMirrorEntry(this, rootState, cID, slot)
        }
        sbp('chelonia/kv/_reconcileForSlot', slot, cID)
      }
    }
  },

  // Private. See KV-REVAMPED §11.3 step 2. Maintains the index
  // invariant (§11.2) and schedules `autoLoad: 'on-sync'` fetches.
  'chelonia/kv/_reconcileForSlot': function (
    this: CheloniaContext,
    slot: SlotDefinition,
    contractID: string
  ): void {
    if (!this.subscriptionSet.has(contractID)) return
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const meta = rootState.contracts?.[contractID]
    if (!meta || meta.type !== slot.contractType) return
    const contractState = (rootState as unknown as Record<string, object>)[contractID] ?? {}
    let matches: boolean
    try {
      matches = slot.match ? !!slot.match(contractID, contractState, rootState) : true
    } catch (e) {
      // A throwing `match` predicate is treated as "does not match"
      // — the slot simply stays inactive for this contract. We log
      // so a buggy predicate is at least visible during development.
      console.error(
        `[chelonia/kv] match() threw for ${contractID}::${slot.key}`, e
      )
      matches = false
    }
    const perKey = this.kvSlotsByContractID.get(contractID)
    const wasActive = !!perKey?.has(slot.key)
    if (matches) {
      // Index in (idempotent).
      let bucket = perKey
      if (!bucket) {
        bucket = new Map()
        this.kvSlotsByContractID.set(contractID, bucket)
      }
      bucket.set(slot.key, slot)
      let filter = this.kvActiveFilters.get(contractID)
      if (!filter) {
        filter = new Set()
        this.kvActiveFilters.set(contractID, filter)
      }
      if (slot.autoSubscribe && !filter.has(slot.key)) {
        filter.add(slot.key)
        queueFilterFlush(this, contractID)
      } else if (!slot.autoSubscribe && filter.has(slot.key)) {
        filter.delete(slot.key)
        queueFilterFlush(this, contractID)
      }
      // Seed the mirror entry as 'non-init' if absent so consumers
      // can observe the slot before the first load resolves.
      const perContract = ensureContractKv(this, rootState, contractID)
      if (!perContract[slot.key]) {
        this.config.reactiveSet(perContract, slot.key, {
          value: undefined,
          etag: null,
          status: 'non-init'
        })
      }
      // Schedule a load. The actual fetch is serialised against
      // updates via the per-contract queueInvocation lane.
      if (!wasActive && slot.autoLoad === 'on-sync') {
        // Fire-and-forget — _loadSlot manages its own status events
        // and never throws out of its body.
        sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
          .catch((e: unknown) => {
            console.error(
              `[chelonia/kv] _loadSlot rejected for ${contractID}::${slot.key}`, e
            )
          })
      }
    } else if (wasActive) {
      // Tear down: drop from both indices, drop mirror entry,
      // flush filter.
      perKey!.delete(slot.key)
      if (perKey!.size === 0) this.kvSlotsByContractID.delete(contractID)
      const filter = this.kvActiveFilters.get(contractID)
      if (filter?.has(slot.key)) {
        filter.delete(slot.key)
        queueFilterFlush(this, contractID)
      }
      const perContract = rootState._kv?.[contractID]
      if (perContract && perContract[slot.key]) {
        this.config.reactiveDel(perContract, slot.key)
      }
    }
  },

  // Private. See KV-REVAMPED §11.3 step 3. Fetches via
  // `chelonia/kv/get`, unwraps the `{ __chelKvNonce, value }`
  // envelope, validates, and writes the mirror. Routes the fetch
  // through `chelonia/queueInvocation` keyed on `contractID` so it
  // serialises against in-flight `chelonia/kv/update` writes.
  'chelonia/kv/_loadSlot': function (
    this: CheloniaContext,
    {
      contractID,
      slot,
      reason
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: 'load' | 'reconnect';
    }
  ): Promise<void> {
    return sbp('chelonia/queueInvocation', contractID, async () => {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      // The contract may have been released between scheduling and
      // running — bail out cleanly.
      if (!this.subscriptionSet.has(contractID)) return
      const perContract = ensureContractKv(this, rootState, contractID)
      if (!perContract[slot.key]) {
        // Reconcile dropped the entry while we were queued.
        return
      }
      setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'loading')
      let parsed: (ParsedEncryptedOrUnencryptedMessage<JSONType> & { etag?: string | null }) | null
      try {
        parsed = await sbp('chelonia/kv/get', contractID, slot.key) as
          (ParsedEncryptedOrUnencryptedMessage<JSONType> & { etag?: string | null }) | null
      } catch (e) {
        const lastError = normalizeError(e)
        setSlotStatus(
          this, rootState, contractID, slot.contractType, slot.key,
          'error', lastError
        )
        return
      }
      if (parsed === null) {
        // 404 — key not yet written (or deleted server-side). Reset
        // the mirror to the declared default state (`value: undefined`,
        // `etag: null`) and surface `'non-init'` rather than `'loaded'`
        // (§4.3). If the slot previously held a value, emit
        // `CHELONIA_KV_UPDATED` so consumers observe the transition.
        const existingEntry = perContract[slot.key]
        if (existingEntry) {
          const previousValue = existingEntry.value
          this.config.reactiveSet(existingEntry, 'value', undefined)
          this.config.reactiveSet(existingEntry, 'etag', null)
          if (previousValue !== undefined) {
            sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
              contractID,
              contractType: slot.contractType,
              key: slot.key,
              value: undefined,
              previousValue,
              reason,
              etag: null
            })
            // Mirror the successful-load path: fire onUpdate so
            // consumers observing the slot via the callback (not just
            // the event bus) see the reversion to default. Pass the
            // cloned default — the effective value a `read()` call
            // would return (§4.3).
            const defaultedValue = slot.resolvedDefault !== undefined
              ? cloneDeep(slot.resolvedDefault)
              : undefined
            await safeOnUpdate(slot, defaultedValue, {
              contractID,
              contractType: slot.contractType,
              key: slot.key,
              reason,
              etag: null,
              previousValue
            })
          }
        }
        setSlotStatus(
          this, rootState, contractID, slot.contractType, slot.key, 'non-init'
        )
        return
      }
      // Unwrap the `{ __chelKvNonce, value }` envelope written by
      // `chelonia/kv/update` / `chelonia/kv/clear`. For backwards
      // compatibility with raw-API writers that don't wrap, fall
      // back to `parsed.data` itself.
      const unwrapped = unwrapData(parsed.data)
      // Capture the etag from the GET response before any await point.
      const getEtag = parsed.etag ?? null
      // Staleness guard: if `defineSlot` replaced this slot while the
      // fetch was in flight, the captured `slot` object is stale — its
      // schema / defaults / callbacks no longer match the registry.
      if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
        return
      }
      const entry = perContract[slot.key]
      const previousValue = entry?.value
      // Wire `null` is the clear sentinel — skip schema.parse and
      // restore the deep-cloned default.
      let nextValue: JSONType | undefined
      if (unwrapped === null) {
        nextValue = slot.resolvedDefault !== undefined
          ? cloneDeep(slot.resolvedDefault)
          : undefined
      } else if (slot.schema) {
        try {
          nextValue = slot.schema.parse(unwrapped)
        } catch (e) {
          const lastError = normalizeError(e)
          sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            error: e,
            reason
          })
          setSlotStatus(
            this, rootState, contractID, slot.contractType, slot.key,
            'error', lastError
          )
          return
        }
      } else {
        nextValue = unwrapped
      }
      // Write mirror — entry definitely exists (we seeded it
      // upstream and bail out if reconcile dropped it).
      this.config.reactiveSet(entry, 'value', nextValue)
      this.config.reactiveSet(entry, 'etag', getEtag)
      sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
        contractID,
        contractType: slot.contractType,
        key: slot.key,
        value: nextValue,
        previousValue,
        reason,
        etag: getEtag
      })
      setSlotStatus(
        this, rootState, contractID, slot.contractType, slot.key, 'loaded'
      )
      await safeOnUpdate(slot, nextValue, {
        contractID,
        contractType: slot.contractType,
        key: slot.key,
        reason,
        etag: getEtag,
        previousValue
      })
    })
  },

  // Private listener for CONTRACTS_MODIFIED(added). Mounted from
  // `chelonia/_init` (see chelonia.ts) so that newly-synced
  // contracts automatically wire up every matching slot. The
  // `removed` half is handled by the contract-release path (a
  // later task step).
  'chelonia/kv/_onContractsModified': function (
    this: CheloniaContext,
    { added }: { added: string[]; removed: string[] }
  ): void {
    if (!added || added.length === 0) return
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    for (const cID of added) {
      const meta = rootState.contracts?.[cID]
      if (!meta) continue
      const contractType = meta.type
      if (!contractType) continue
      for (const slot of this.kvSlots.values()) {
        if (slot.contractType !== contractType) continue
        sbp('chelonia/kv/_reconcileForSlot', slot, cID)
      }
    }
  },

  // Private. See KV-REVAMPED §4.9, §11.3 step 4, §11.4 bullet 1.
  // Called from the existing NOTIFICATION_TYPE.KV dispatch in
  // `src/chelonia.ts` after `parseEncryptedOrUnencryptedMessage`
  // has resolved the wrapper. Runs inside the per-contract
  // `chelonia/queueInvocation` lane (set up by the caller) so it
  // serialises against `chelonia/kv/update` writes and other KV
  // operations on the same contract.
  //
  // Behaviour:
  //   - O(1) slot lookup via `kvSlotsByContractID[cID][key]`. Returns
  //     immediately on miss — `defineSlot` may not have registered yet
  //     and the legacy raw API still runs through the existing
  //     callback path. No regression.
  //   - Read `__chelKvNonce` off the parsed wrapper; if it matches an
  //     entry in `kvLocalEchoNonces[${cID}::${key}]`, drop the frame
  //     silently (self-echo suppression — §4.9) and remove the nonce
  //     from the FIFO.
  //   - Strip the nonce field before further processing so it never
  //     reaches `schema.parse`, the mirror, the event payload, or
  //     `onUpdate`.
  //   - Wire `null` (after unwrap) is the clear sentinel — write the
  //     deep-cloned `resolvedDefault` without running `schema.parse`.
  //   - On schema validation failure: **keep** the previous mirror
  //     `value`, flip `status: 'error'`, set `lastError`, fire
  //     `CHELONIA_KV_VALIDATION_ERROR` and `CHELONIA_KV_STATUS_CHANGED`.
  //     Never throw out of the dispatch path.
  'chelonia/kv/_handleRemote': function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    parsed: ParsedEncryptedOrUnencryptedMessage<JSONType>
  ): Promise<void> {
    const perKey = this.kvSlotsByContractID.get(contractID)
    const slot = perKey?.get(key)
    if (!slot) return Promise.resolve()
    // Unwrap `{ __chelKvNonce, value }` envelope, with raw-API
    // tolerance (mirrors the `_loadSlot` unwrap shape).
    const data = parsed?.data as JSONType
    let unwrapped: JSONType
    let nonce: string | undefined
    if (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      '__chelKvNonce' in (data as object) &&
      'value' in (data as object)
    ) {
      const wrapper = data as { __chelKvNonce?: unknown; value: JSONType }
      if (typeof wrapper.__chelKvNonce === 'string') {
        nonce = wrapper.__chelKvNonce
      }
      unwrapped = wrapper.value
    } else {
      unwrapped = data
    }
    // Self-echo suppression: if the nonce matches a pending local
    // write, drop the frame and pop the FIFO entry.
    if (nonce) {
      const echoKey = `${contractID}::${key}`
      const fifo = this.kvLocalEchoNonces.get(echoKey)
      if (fifo) {
        const idx = fifo.indexOf(nonce)
        if (idx >= 0) {
          fifo.splice(idx, 1)
          if (fifo.length === 0) this.kvLocalEchoNonces.delete(echoKey)
          return Promise.resolve()
        }
      }
    }
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const perContract = ensureContractKv(this, rootState, contractID)
    const entry = perContract[key]
    if (!entry) {
      // Reconcile dropped the mirror entry — nothing to write into.
      return Promise.resolve()
    }
    const previousValue = entry.value
    // Wire `null` is the clear sentinel — skip schema.parse and
    // restore the deep-cloned default.
    let nextValue: JSONType | undefined
    if (unwrapped === null) {
      nextValue = slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
    } else if (slot.schema) {
      try {
        nextValue = slot.schema.parse(unwrapped)
      } catch (e) {
        const lastError = normalizeError(e)
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
          contractID,
          contractType: slot.contractType,
          key,
          error: e,
          reason: 'remote'
        })
        setSlotStatus(
          this, rootState, contractID, slot.contractType, key,
          'error', lastError
        )
        return Promise.resolve()
      }
    } else {
      nextValue = unwrapped
    }
    this.config.reactiveSet(entry, 'value', nextValue)
    // Pubsub frames carry no etag — null it out so the next local
    // write doesn't send a stale `if-match` (§4.9).
    this.config.reactiveSet(entry, 'etag', null)
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
      contractID,
      contractType: slot.contractType,
      key,
      value: nextValue,
      previousValue,
      reason: 'remote',
      etag: null
    })
    // If the slot was in `'error'` (e.g. from a prior validation
    // failure) and the new value validated cleanly, transition back
    // to `'loaded'`. Otherwise leave status alone (a successful
    // remote update on an already-`'loaded'` slot doesn't need to
    // re-emit the status).
    if (entry.status !== 'loaded') {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key, 'loaded'
      )
    }
    return safeOnUpdate(slot, nextValue, {
      contractID,
      contractType: slot.contractType,
      key,
      reason: 'remote',
      etag: null,
      previousValue
    })
  },

  // Public. See KV-REVAMPED §4.2, §11.3 step 5. The ergonomic write
  // path: resolves the slot, runs the reducer, validates, wraps with
  // a self-echo nonce, and writes via `chelonia/kv/queuedSet` (which
  // serialises writes per-contract through the same queueInvocation
  // lane used by `_handleRemote`).
  //
  // Resolves with the stored value (the reducer's last accepted
  // output), or `undefined` when the reducer returned `KV_NOOP`.
  //
  // Rejection taxonomy (§4.2):
  //   - `ChelErrorKvSlotUnknown`   — contract not synced, or no slot
  //                                  registered for `(contractType, key)`.
  //   - `ChelErrorKvUpdateInvalid` — `updater`/`value` misuse; thrown
  //                                  synchronously before any I/O.
  //   - `ChelErrorKvValidation`    — reducer output (or server
  //                                  `currentData` on retry) fails
  //                                  `schema.parse`. Original Zod
  //                                  error attached on `.cause`.
  //   - `ChelErrorKvConflict`      — `maxAttempts` exhausted on
  //                                  real 409/412 contention. Last
  //                                  observed `{ currentData, etag }`
  //                                  attached on `.cause`.
  //   - `AbortError`               — `signal` aborted. Mirror is
  //                                  unchanged; no event fires.
  //   - other errors propagated verbatim from `chelonia/kv/queuedSet`
  //     for non-409/412 HTTP failures (5xx, offline). `status` is
  //     NOT flipped to `'error'` (that state is reserved for load
  //     failures — §4.9).
  'chelonia/kv/update': async function (
    this: CheloniaContext,
    {
      contractID,
      key,
      updater,
      value,
      maxAttempts,
      signal,
      ifMatch
    }: {
      contractID: string;
      key: string;
      updater?: KvUpdater<JSONType>;
      value?: JSONType;
      maxAttempts?: number;
      signal?: AbortSignal;
      ifMatch?: string;
    }
  ): Promise<JSONType | undefined> {
    // ----- Step 1: resolve the slot via two-step lookup. -----
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const contractMeta = rootState.contracts?.[contractID]
    if (!contractMeta || !this.subscriptionSet.has(contractID)) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] update: contract ${contractID} is not synced`
      )
    }
    const contractType = contractMeta.type
    if (typeof contractType !== 'string') {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] update: contract ${contractID} has no resolved type`
      )
    }
    const slot = this.kvSlots.get(registryKey(contractType, key))
    if (!slot) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] update: no slot registered for ${contractType}::${key}`
      )
    }
    // ----- Step 1a: normalise the write input (synchronous). -----
    const hasUpdater = typeof updater === 'function'
    const hasValue = value !== undefined
    if (hasUpdater && hasValue) {
      throw new ChelErrorKvUpdateInvalid(
        `[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
        'of `updater` or `value` (both were provided)'
      )
    }
    if (!hasUpdater && !hasValue) {
      throw new ChelErrorKvUpdateInvalid(
        `[chelonia/kv] update: ${contractID}::${key} — pass exactly one ` +
        'of `updater` or `value` (neither was provided)'
      )
    }
    let reducer: KvUpdater<JSONType>
    if (hasUpdater) {
      reducer = updater!
    } else {
      if (!slot.defaultUpdater) {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} — \`value\` was ` +
          'provided but the slot has no `defaultUpdater`'
        )
      }
      // Synthesise the reducer once — the same closure is re-invoked
      // on conflict retries (§4.2 step 1a).
      reducer = slot.defaultUpdater(value as JSONType)
    }
    // Honour a pre-aborted signal before touching the network.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError')
    }
    // ----- Step 2: read current mirror value. -----
    const perContract = ensureContractKv(this, rootState, contractID)
    const mirrorEntry = perContract[key]
    const seedValue: JSONType | undefined = mirrorEntry?.value !== undefined
      ? cloneDeep(mirrorEntry.value as JSONType)
      : slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
    // ----- Step 3: run reducer and validate. -----
    const reducerOut = reducer(seedValue as JSONType)
    if (typeof reducerOut === 'symbol') {
      if (reducerOut === KV_NOOP) return undefined
      throw new ChelErrorKvUpdateInvalid(
        `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
        'an unexpected symbol; use KV_NOOP to abort'
      )
    }
    if (reducerOut === null || reducerOut === undefined) {
      // Reducer may not produce the reserved wire sentinels; clear
      // is its own selector (§4.5).
      throw new ChelErrorKvValidation(
        `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
        `${String(reducerOut)}; use chelonia/kv/clear or KV_NOOP instead`
      )
    }
    let nextValue: JSONType = reducerOut as JSONType
    if (slot.schema) {
      try {
        nextValue = slot.schema.parse(nextValue)
      } catch (e) {
        throw new ChelErrorKvValidation(
          `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
          'failed schema.parse',
          { cause: e }
        )
      }
    }
    // ----- Step 5: nonce + wrap + queuedSet with onconflict. -----
    const firstNonce = base64Nonce()
    recordEchoNonce(this, contractID, key, firstNonce)
    let lastCurrentData: JSONType | undefined
    let lastEtag: string | null | undefined
    let abortedViaNoop = false
    const onconflict = async ({
      currentData,
      etag
    }: {
      currentData: JSONType | undefined;
      etag: string | null | undefined;
    }): Promise<[JSONType, string] | false> => {
      lastCurrentData = currentData
      lastEtag = etag
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError')
      }
      let basis: JSONType | undefined
      if (currentData === undefined) {
        basis = slot.resolvedDefault !== undefined
          ? cloneDeep(slot.resolvedDefault)
          : undefined
      } else {
        const unwrapped = unwrapData(currentData)
        if (unwrapped === null) {
          basis = slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined
        } else if (slot.schema) {
          try {
            basis = slot.schema.parse(unwrapped)
          } catch (e) {
            throw new ChelErrorKvValidation(
              `[chelonia/kv] update: ${contractID}::${key} server ` +
              'currentData failed schema.parse on conflict retry',
              { cause: e }
            )
          }
        } else {
          basis = unwrapped
        }
      }
      const retried = reducer(basis as JSONType)
      if (retried === KV_NOOP) {
        // Abort the retry loop without raising — resolve as no-op.
        abortedViaNoop = true
        return false
      }
      if (retried === null || retried === undefined) {
        throw new ChelErrorKvValidation(
          `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
          `${String(retried)} on retry; use KV_NOOP instead`
        )
      }
      let validated: JSONType = retried as JSONType
      if (slot.schema) {
        try {
          validated = slot.schema.parse(retried)
        } catch (e) {
          throw new ChelErrorKvValidation(
            `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
            'failed schema.parse on conflict retry',
            { cause: e }
          )
        }
      }
      // Each retry gets a fresh nonce so the eventual pubsub echo of
      // *this* attempt is suppressed; the FIFO cap (8) reaps stale
      // ones automatically. `nextValue` tracks the latest accepted
      // reducer output — what we ultimately mirror on success.
      nextValue = validated
      const nonce = base64Nonce()
      recordEchoNonce(this, contractID, key, nonce)
      return [{ __chelKvNonce: nonce, value: validated }, etag ?? ''] as [JSONType, string]
    }
    const mirrorEtag = mirrorEntry?.etag ?? undefined
    let setResult: { etag: string | null }
    try {
      setResult = await sbp('chelonia/kv/queuedSet', {
        contractID,
        key,
        data: { __chelKvNonce: firstNonce, value: nextValue },
        onconflict,
        ifMatch: ifMatch ?? mirrorEtag,
        maxAttempts,
        signal,
        encryptionKeyName: slot.encryptionKeyName,
        signingKeyName: slot.signingKeyName
      }) as { etag: string | null }
    } catch (e) {
      // Map the legacy "kv/set conflict setting KV value" Error to
      // the public taxonomy (§4.2 step 6 / rejection table).
      if (
        e instanceof Error &&
        e.message === 'kv/set conflict setting KV value'
      ) {
        throw new ChelErrorKvConflict(
          `[chelonia/kv] update: ${contractID}::${key} ran out of attempts ` +
          'resolving conflicts',
          { cause: { currentData: lastCurrentData, etag: lastEtag ?? null } }
        )
      }
      throw e
    }
    // If the retry path aborted with `KV_NOOP`, no write happened —
    // resolve as a no-op without touching the mirror.
    if (abortedViaNoop) {
      return undefined
    }
    // ----- Step 6: write mirror + emit events. -----
    const perContractAfter = ensureContractKv(this, rootState, contractID)
    const entryAfter = perContractAfter[key]
    const previousValue = entryAfter?.value
    if (!entryAfter) {
      // Reconcile dropped the slot mid-write — nothing to mirror into.
      return nextValue
    }
    this.config.reactiveSet(entryAfter, 'value', nextValue)
    this.config.reactiveSet(entryAfter, 'etag', setResult.etag)
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
      contractID,
      contractType: slot.contractType,
      key,
      value: nextValue,
      previousValue,
      reason: 'local',
      etag: setResult.etag
    })
    if (entryAfter.status !== 'loaded') {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key, 'loaded'
      )
    }
    await safeOnUpdate(slot, nextValue, {
      contractID,
      contractType: slot.contractType,
      key,
      reason: 'local',
      etag: setResult.etag,
      previousValue
    })
    return nextValue
  },

  // Public. See KV-REVAMPED §4.3. Synchronous mirror read.
  //
  // Two-step slot resolution (same as `update`) — throws
  // `ChelErrorKvSlotUnknown` if the contract isn't synced or the slot
  // isn't registered for the resolved `(contractType, key)` pair.
  // Substitutes a deep-cloned `resolvedDefault` when the mirror entry
  // is absent or `value === undefined` (the "non-init" representation
  // — see the note in §4.3). Returned value is the cloned default,
  // or `undefined` if the slot has no `defaultValue` and the mirror
  // is empty.
  'chelonia/kv/read': function (
    this: CheloniaContext,
    contractID: string,
    key: string
  ): JSONType | undefined {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const contractMeta = rootState.contracts?.[contractID]
    if (!contractMeta || !this.subscriptionSet.has(contractID)) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] read: contract ${contractID} is not synced`
      )
    }
    const contractType = contractMeta.type
    if (typeof contractType !== 'string') {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] read: contract ${contractID} has no resolved type`
      )
    }
    const slot = this.kvSlots.get(registryKey(contractType, key))
    if (!slot) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] read: no slot registered for ${contractType}::${key}`
      )
    }
    const entry = rootState._kv?.[contractID]?.[key]
    if (!entry || entry.value === undefined) {
      return slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
    }
    return entry.value as JSONType
  },

  // Public. See KV-REVAMPED §4.4. Force-fetch a slot (or every active
  // slot for a contract) and refresh the mirror.
  //
  // Single-slot form (with `key`) — rejects on slot failure, matching
  // the rejection semantics of `chelonia/kv/update`.
  //
  // Aggregate form (no `key`) — fans out across every entry in
  // `kvSlotsByContractID[contractID]` concurrently; per-slot failures
  // surface via the slot's `status` (and the
  // `CHELONIA_KV_STATUS_CHANGED` / `CHELONIA_KV_VALIDATION_ERROR`
  // events emitted from inside `_loadSlot`). The aggregate promise
  // resolves once every individual `_loadSlot` settles, regardless of
  // outcome.
  'chelonia/kv/sync': async function (
    this: CheloniaContext,
    contractID: string,
    key?: string
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const contractMeta = rootState.contracts?.[contractID]
    if (!contractMeta || !this.subscriptionSet.has(contractID)) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] sync: contract ${contractID} is not synced`
      )
    }
    const contractType = contractMeta.type
    if (typeof contractType !== 'string') {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] sync: contract ${contractID} has no resolved type`
      )
    }
    if (key !== undefined) {
      const slot = this.kvSlots.get(registryKey(contractType, key))
      if (!slot) {
        throw new ChelErrorKvSlotUnknown(
          `[chelonia/kv] sync: no slot registered for ${contractType}::${key}`
        )
      }
      // _loadSlot owns its own status events; on failure it sets the
      // slot's `status` to 'error' but does NOT throw. For the
      // single-slot form we need rejection semantics, so inspect the
      // slot's lastError after the load resolves.
      await sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
      const entry = rootState._kv?.[contractID]?.[key]
      if (entry?.status === 'error' && entry.lastError) {
        // Re-create an Error so the caller sees something throwable
        // rather than a `{name, message}` POJO.
        const err = new Error(entry.lastError.message)
        err.name = entry.lastError.name
        throw err
      }
      return
    }
    // Aggregate form — fan out across every currently-active slot for
    // this contract. Per-slot failures are swallowed by `_loadSlot`
    // (they surface via status / event), so `Promise.all` here will
    // resolve cleanly once every load settles.
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey || perKey.size === 0) return
    const slots = Array.from(perKey.values())
    await Promise.all(slots.map((slot) =>
      sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
    ))
  },

  // Public. See KV-REVAMPED §4.5. Resets a slot to its declared
  // default by writing the wrapper `{ __chelKvNonce, value: null }`
  // through the existing `chelonia/kv/queuedSet`. The inner
  // `value: null` is the wire-level clear sentinel; `_handleRemote`
  // on other clients maps it back to the declared default before
  // any `schema.parse`.
  //
  // Local-side behaviour after the network write resolves:
  //   - mirror.value ← cloneDeep(slot.resolvedDefault)
  //   - mirror.etag  ← setResult.etag
  //   - status       ← 'non-init'
  //   - CHELONIA_KV_UPDATED fires with `reason: 'local'` and `value`
  //     set to the cloned default
  //   - safeOnUpdate dispatched
  //
  // Throws `ChelErrorKvSlotUnknown` on the same conditions as
  // `chelonia/kv/update`. Other errors from `chelonia/kv/queuedSet`
  // propagate verbatim; the mirror is untouched on failure.
  'chelonia/kv/clear': async function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    {
      maxAttempts,
      signal
    }: { maxAttempts?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const contractMeta = rootState.contracts?.[contractID]
    if (!contractMeta || !this.subscriptionSet.has(contractID)) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] clear: contract ${contractID} is not synced`
      )
    }
    const contractType = contractMeta.type
    if (typeof contractType !== 'string') {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] clear: contract ${contractID} has no resolved type`
      )
    }
    const slot = this.kvSlots.get(registryKey(contractType, key))
    if (!slot) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] clear: no slot registered for ${contractType}::${key}`
      )
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError')
    }
    const nonce = base64Nonce()
    recordEchoNonce(this, contractID, key, nonce)
    const setResult = await sbp('chelonia/kv/queuedSet', {
      contractID,
      key,
      data: { __chelKvNonce: nonce, value: null },
      encryptionKeyName: slot.encryptionKeyName,
      signingKeyName: slot.signingKeyName,
      maxAttempts,
      signal
    }) as { etag: string | null }
    const perContract = ensureContractKv(this, rootState, contractID)
    const entry = perContract[key]
    if (!entry) {
      // Reconcile dropped the slot mid-write — nothing to mirror into.
      return
    }
    const previousValue = entry.value
    const defaultClone = slot.resolvedDefault !== undefined
      ? cloneDeep(slot.resolvedDefault)
      : undefined
    this.config.reactiveSet(entry, 'value', defaultClone)
    this.config.reactiveSet(entry, 'etag', setResult.etag)
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
      contractID,
      contractType: slot.contractType,
      key,
      value: defaultClone,
      previousValue,
      reason: 'local',
      etag: setResult.etag
    })
    if (entry.status !== 'non-init') {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key, 'non-init'
      )
    }
    await safeOnUpdate(slot, defaultClone, {
      contractID,
      contractType: slot.contractType,
      key,
      reason: 'local',
      etag: setResult.etag,
      previousValue
    })
  },

  // Public. See KV-REVAMPED §4.6. Reports the load state of a slot,
  // or the aggregate state of an entire contract.
  //
  // Aggregate form (no `key`): reduces across every slot active for
  // `contractID` with precedence `error > loading > non-init > loaded`.
  // Returns `'non-init'` if no slots are active for the contract.
  //
  // Single form: reads the slot's `status` from the mirror, or
  // `'non-init'` if the mirror entry hasn't been seeded yet. Unlike
  // `read`/`update`/`sync`/`clear`, `status` does NOT reject on an
  // unknown slot — it returns `'non-init'`. This matches the consumer
  // pattern of "render a status badge regardless of whether the slot
  // is actually wired" without needing try/catch around the call.
  'chelonia/kv/status': function (
    this: CheloniaContext,
    contractID: string,
    key?: string
  ): KvLoadStatus {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (key !== undefined) {
      const entry = rootState._kv?.[contractID]?.[key]
      return entry?.status ?? 'non-init'
    }
    // Aggregate: precedence error > loading > non-init > loaded.
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey || perKey.size === 0) return 'non-init'
    const perContract = rootState._kv?.[contractID]
    let sawLoading = false
    let sawNonInit = false
    let sawLoaded = false
    for (const slotKey of perKey.keys()) {
      const status = perContract?.[slotKey]?.status ?? 'non-init'
      if (status === 'error') return 'error'
      if (status === 'loading') sawLoading = true
      else if (status === 'non-init') sawNonInit = true
      else if (status === 'loaded') sawLoaded = true
    }
    if (sawLoading) return 'loading'
    if (sawNonInit) return 'non-init'
    if (sawLoaded) return 'loaded'
    return 'non-init'
  },

  // Public. See KV-REVAMPED §4.7. Runs a full reconcile pass: walks
  // `subscriptionSet`, re-evaluates every registered slot's `match`
  // predicate against the current root state, and drives
  // `_reconcileForSlot` to update indices and schedule loads / drops.
  //
  // With `contractID`, the pass is scoped to that single contract.
  // Without, every currently-synced contract is processed.
  //
  // Consumers call this after they mutate state the library cannot
  // observe — most notably the login transition that flips an
  // "own identity" predicate. The reconciler is idempotent: a slot
  // whose match result hasn't changed is a no-op apart from the
  // `_reconcileForSlot` walk itself.

  // Private convenience used by `chelonia/defineContract`. Accepts the
  // `kv: { ... }` block declared inline on a contract definition and
  // registers each entry as a `defineSlot` call scoped to the
  // manifest. See KV-REVAMPED.md §4.8 / §11.3 step 7.
  'chelonia/kv/_registerContractSlots': function (
    this: CheloniaContext,
    manifest: string,
    kv: Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>
  ): void {
    for (const key of Object.keys(kv)) {
      const entry = kv[key]
      sbp('chelonia/kv/defineSlot', {
        ...entry,
        contractType: manifest,
        key
      })
    }
  },

  // Private. See KV-REVAMPED.md §11.3 step 8. Diffs `prevKv` vs
  // `nextKv` for `manifest`; for every key present in `prevKv` but not
  // in `nextKv`, unregister the slot from `kvSlots`, scrub it from
  // every `kvSlotsByContractID[cID]` and `kvActiveFilters[cID]`,
  // queue a filter flush, and drop the corresponding
  // `rootState._kv[cID][key]` mirror entry. Keys present in both
  // blocks are left to the normal `defineSlot` re-registration path
  // (which re-validates persisted mirror values against the new
  // schema — §4.1).
  'chelonia/kv/_cleanupContractSlots': function (
    this: CheloniaContext,
    manifest: string,
    prevKv: Record<string, unknown> | undefined,
    nextKv: Record<string, unknown> | undefined
  ): void {
    if (!prevKv) return
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const nextKeys = nextKv ? new Set(Object.keys(nextKv)) : new Set<string>()
    for (const key of Object.keys(prevKv)) {
      if (nextKeys.has(key)) continue
      const rKey = registryKey(manifest, key)
      const slot = this.kvSlots.get(rKey)
      if (!slot) continue
      this.kvSlots.delete(rKey)
      // Scrub every per-contract index entry pointing at this slot.
      for (const [cID, perKey] of this.kvSlotsByContractID) {
        if (perKey.get(key) !== slot) continue
        perKey.delete(key)
        if (perKey.size === 0) this.kvSlotsByContractID.delete(cID)
        const filter = this.kvActiveFilters.get(cID)
        if (filter?.has(key)) {
          filter.delete(key)
          queueFilterFlush(this, cID)
        }
        const perContract = rootState._kv?.[cID]
        if (perContract && perContract[key]) {
          this.config.reactiveDel(perContract, key)
        }
      }
    }
  },

  'chelonia/kv/refreshFilters': function (
    this: CheloniaContext,
    contractID?: string
  ): void {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const targets: string[] = contractID !== undefined
      ? (this.subscriptionSet.has(contractID) ? [contractID] : [])
      : Array.from(this.subscriptionSet)
    for (const cID of targets) {
      const meta = rootState.contracts?.[cID]
      if (!meta) continue
      const contractType = meta.type
      if (typeof contractType !== 'string') continue
      for (const slot of this.kvSlots.values()) {
        if (slot.contractType !== contractType) continue
        sbp('chelonia/kv/_reconcileForSlot', slot, cID)
      }
    }
  }
}) as string[])

// ---------------------------------------------------------------------------
// Helpers that close over the `sbp` registry (declared after the register
// block so they can call back into selectors registered above).
// ---------------------------------------------------------------------------

// On `defineSlot` replacement, re-run the new `schema.parse` against
// any persisted mirror entry for this slot. KV-REVAMPED §4.1:
// the library NEVER discards data on schema mismatch — failing
// entries keep their previous `value` but transition to
// `status: 'error'` with `lastError` set, and
// `CHELONIA_KV_VALIDATION_ERROR` fires with `reason: 're-validate'`.
// Successful re-validations transition back to `'loaded'` and emit
// `CHELONIA_KV_UPDATED` with `reason: 'load'` so listeners observing
// transitions out of `'error'` can react.
function revalidateMirrorEntry (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  slot: SlotDefinition
): void {
  const entry = rootState._kv?.[contractID]?.[slot.key]
  if (!entry || entry.value === undefined) return
  if (!slot.schema) {
    // No schema → nothing to validate; if previously errored, clear
    // the error state.
    if (entry.status === 'error') {
      setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, 'loaded')
    }
    return
  }
  const previousValue = entry.value
  try {
    const parsed = slot.schema.parse(previousValue)
    // Successful re-validation: write the (possibly coerced) value
    // back and emit the standard transition events.
    ctx.config.reactiveSet(entry, 'value', parsed)
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
      contractID,
      contractType: slot.contractType,
      key: slot.key,
      value: parsed,
      previousValue,
      reason: 'load',
      etag: entry.etag
    })
    setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, 'loaded')
  } catch (e) {
    sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
      contractID,
      contractType: slot.contractType,
      key: slot.key,
      error: e,
      reason: 're-validate'
    })
    setSlotStatus(
      ctx, rootState, contractID, slot.contractType, slot.key,
      'error', normalizeError(e)
    )
  }
}
