// KV slot API — see KV-REVAMPED.md for the full design.
//
// This module implements the declarative KV slot API layered on top of
// the `chelonia/kv/{set,get,setFilter}` primitives. It also hooks into
// `chelonia/reset` (via `_waitInFlight`), `chelonia/defineContract`
// (via `_registerContractSlots` / `_cleanupContractSlots`), and the
// pubsub reconnect / KV-notification paths in `chelonia.ts`.

import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import { cloneDeep, has } from 'turtledash'
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
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import type {
  ChelKvGetResult,
  CheloniaContext,
  ChelRootState,
  JSONType,
  KvLoadStatus,
  KvMirrorEntry,
  KvSlotDefinition,
  KvUpdateCtx,
  KvUpdater,
  ParsedEncryptedOrUnencryptedMessage,
  SlotDefinition,
  SlotDefinitionSource
} from './types.js'

// Reserved sentinel returned by a `KvUpdater` to abort a write without
// touching the server (replaces the legacy `return null` idiom from
// `chelonia/kv/set`'s `onconflict`).
//
// `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the sentinel
// survives realm boundaries — iframes, workers, and the dual ESM/CJS
// load of `@chelonia/lib`. The string key is namespaced
// (`@chelonia/lib/KV_NOOP`) to make a userland collision implausible.
export const KV_NOOP = Symbol.for('@chelonia/lib/KV_NOOP')
export type KvNoop = typeof KV_NOOP

// Internal sentinel thrown by the onconflict callback when the reducer
// returns KV_NOOP. The outer catch checks for the Symbol.for marker via
// `in` (not `instanceof`) so a KvNoopAbort created by another loaded
// copy of this module — e.g. the dual ESM/CJS build of @chelonia/lib in
// the same realm — is still recognised. The class is not exported and
// only this module's onconflict path attaches the marker; it is not a
// general cross-realm error-bridging mechanism.
class KvNoopAbort extends Error {
  override name = 'KvNoopAbort' as const
}
// Realm-safe marker: Symbol.for survives dual ESM/CJS loads.
// Checked on the catch side instead of `instanceof`.
const KV_NOOP_ABORT = Symbol.for('@chelonia/lib/KV_NOOP_ABORT')
;(KvNoopAbort.prototype as unknown as Record<symbol, boolean>)[KV_NOOP_ABORT] = true

// ---------------------------------------------------------------------------
// Internal helpers (pure — no SBP context required)
// ---------------------------------------------------------------------------

const KV_ECHO_NONCE_MAX = 8

type KvLoadReason = Exclude<KvUpdateCtx['reason'], 'local'>

const registryKey = (contractType: string, key: string): string =>
  `${contractType}::${key}`

// Stable structural stringify used for the `defineSlot` idempotence
// check. Plain `JSON.stringify` is sensitive to object key order, but
// JSON / spec-equivalence treats `{a:1,b:2}` and `{b:2,a:1}` as the
// same value — schemas that re-emit keys in a different order (e.g.
// `z.object({...}).strict()` normalising key order across parse
// passes) would otherwise falsely fail the round-trip guard at
// registration. Walks plain objects and arrays only; primitives are
// emitted verbatim and any non-plain values fall through to
// `JSON.stringify`'s default handling.
function canonicalStringify (value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      Object.getPrototypeOf(val) === Object.prototype
    ) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

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
  resolvedDefault: JSONType | undefined,
  source?: SlotDefinitionSource
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
    onUpdate: def.onUpdate,
    source
  }
}

function assertParsedDefaultValue (
  slot: SlotDefinition,
  value: unknown,
  pass: 'first' | 'second'
): void {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    Promise.resolve(value).catch(() => {})
    throw new ChelErrorKvSlotInvalid(
      `[chelonia/kv] slot ${slot.contractType}::${slot.key} uses an ` +
      'async/thenable schema parser; v1 supports synchronous parsers only'
    )
  }
  if (value === null || value === undefined) {
    throw new ChelErrorKvSlotInvalid(
      `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema.parse ` +
      `returned the reserved sentinel ${String(value)} for the defaultValue; ` +
      'null and undefined are reserved for wire/clear semantics'
    )
  }
  try {
    assertNotReservedWrapper(
      value,
      `defineSlot defaultValue ${pass} parse ${slot.contractType}::${slot.key}`,
      ChelErrorKvSlotInvalid
    )
    assertJsonShape(
      value,
      `defineSlot defaultValue ${pass} parse ${slot.contractType}::${slot.key}`
    )
  } catch (e) {
    throw new ChelErrorKvSlotInvalid(
      `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema.parse ` +
      'produced an invalid defaultValue (reserved sentinel, reserved ' +
      'wrapper shape, or non-JSON value)',
      { cause: e }
    )
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
// 3. `resolvedDefault` round-trip: the first `parse` is allowed to
//    transform the default (e.g. adding derived fields), and
//    `parse(parse(x))` must produce a JSON-equal value to the first
//    parse (idempotence), catching schemas that silently drop or
//    coerce fields across repeated applications.
//
// Additionally, any `schema.parse` that returns a thenable is
// rejected — v1 supports synchronous parsers only. Thenable detection
// runs on the sentinel probes and on the resolvedDefault parse; no
// arbitrary `{}` probe is used (schemas that only reveal async
// behaviour on future valid inputs will fail at runtime with
// `ChelErrorKvValidation`).
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
      Promise.resolve(parsed).catch(() => {})
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
    assertParsedDefaultValue(slot, first, 'first')
    // Idempotence check (KV-REVAMPED §4.1 guard 3): parse(parse(x))
    // must produce the same result as parse(x). The first parse is
    // allowed to transform the default (e.g. adding normalised
    // fields); the second parse must accept that transformed output
    // unchanged.
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
    assertParsedDefaultValue(slot, second, 'second')
    if (canonicalStringify(first) !== canonicalStringify(second)) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema ` +
        'is not idempotent on its own parsed output (defaultValue round-trip failed)'
      )
    }
    // Normalise: store the schema-parsed output as the effective default so
    // that schema transforms (e.g. adding `normalized: true`) are reflected
    // in defaults served by `chelonia/kv/read` (KV-REVAMPED §4.1).
    ;(slot as { resolvedDefault: JSONType }).resolvedDefault = first as JSONType
  }
}

// Post-parse sentinel guard: rejects `null` or `undefined` from a schema
// that passed `assertSchemaGuards` at registration but now somehow
// produces a reserved sentinel at runtime (e.g. a schema whose `parse`
// strips fields until only `undefined` remains). Also rejects thenables
// that escaped the registration-time async probe and the reserved
// `{ __chelKvNonce, value }` wrapper shape that `unwrapData` would
// silently strip on read.
//
// Returns the validated value cast as `JSONType`.
function parseSyncSlotValue (
  slot: SlotDefinition,
  input: unknown,
  where: string
): JSONType {
  const parsed = slot.schema!.parse(input)
  if (parsed && typeof (parsed as { then?: unknown }).then === 'function') {
    Promise.resolve(parsed).catch(() => {})
    throw new ChelErrorKvValidation(
      `[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
      'produced a thenable; v1 supports synchronous parsers only'
    )
  }
  if (parsed === null || parsed === undefined) {
    throw new ChelErrorKvValidation(
      `[chelonia/kv] ${where}: slot ${slot.contractType}::${slot.key} ` +
      `schema.parse returned the reserved sentinel ${String(parsed)}; ` +
      'null and undefined are reserved for wire/clear semantics'
    )
  }
  assertNotReservedWrapper(
    parsed, where, ChelErrorKvValidation
  )
  return assertJsonShape(parsed, where)
}

function assertJsonShape (input: unknown, where: string): JSONType {
  assertNotReservedWrapper(input, where, ChelErrorKvValidation)
  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined) {
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} is the reserved sentinel ${String(value)}`
      )
    }
    const t = typeof value
    if (t === 'string' || t === 'boolean') return
    if (t === 'number') {
      if (Number.isFinite(value)) return
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} has non-finite number ${String(value)}`
      )
    }
    if (t === 'bigint' || t === 'function' || t === 'symbol') {
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} has non-JSON type ${t}`
      )
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], `${path}[${i}]`)
      return
    }
    if (value && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ChelErrorKvValidation(
          `[chelonia/kv] ${where}: ${path} has non-plain object prototype`
        )
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, `${path}.${k}`)
      }
      return
    }
    throw new ChelErrorKvValidation(`[chelonia/kv] ${where}: ${path} is not JSON-shaped`)
  }
  visit(input, 'value')
  return input as JSONType
}

// Ensure `rootState._kv[contractID]` exists as a reactive object. Returns
// the per-contract record. Idempotent.

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

// Emit a `CHELONIA_KV_STATUS_CHANGED` event after writing status / lastError
// onto the mirror entry. Skips the emit only when both status and lastError
// are unchanged.
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
  // `lastErrorChanged` detects a structural difference (name or message)
  // between the new and old error objects. When both have errors with
  // identical content this is false, but we still need to distinguish
  // "both have the same error" from "neither has an error" — the
  // latter means we can skip the event entirely; the former still
  // needs reactivity updates (e.g. clearing a stale lastError).
  const lastErrorChanged =
    !!lastError !== !!entry.lastError ||
    (lastError && entry.lastError &&
      (lastError.name !== entry.lastError.name ||
       lastError.message !== entry.lastError.message))
  // Clear stale lastError even when status hasn't changed.
  if (!lastError && entry.lastError) {
    ctx.config.reactiveDel(entry as unknown as Record<string, unknown>, 'lastError')
  }
  if (lastError) {
    ctx.config.reactiveSet(entry, 'lastError', lastError)
  }
  if (statusUnchanged && !lastErrorChanged) return
  if (!statusUnchanged) {
    ctx.config.reactiveSet(entry, 'status', status)
  }
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
  return { name: 'Error', message }
}

// Resolve the contract type from rootState. The spec (KV-REVAMPED §4.2
// step 1) resolves via _vm.type; in the actual data model the same value
// is also stored on rootState.contracts[contractID].type. Prefer the
// registry copy and fall back to the contract state's _vm.type.
function getContractType (rootState: ChelRootState, contractID: string): string | undefined {
  const fromRegistry = rootState.contracts?.[contractID]?.type
  if (fromRegistry != null) return fromRegistry
  const cs = (rootState as unknown as Record<string, { _vm?: { type?: string } }>)[contractID]
  return cs?._vm?.type
}

// Resolve a slot from the per-contract *active* index
// (kvSlotsByContractID), enforcing match-gating for public selectors.
// Throws ChelErrorKvSlotUnknown if the contract isn't synced, has no
// type, or the slot isn't active for that contract (match returned false
// or the slot was never registered for the contract's type).
function resolveActiveSlot (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  key: string,
  label: string
): SlotDefinition {
  const contractMeta = rootState.contracts?.[contractID]
  if (!contractMeta || !ctx.subscriptionSet.has(contractID)) {
    throw new ChelErrorKvSlotUnknown(
      `[chelonia/kv] ${label}: contract ${contractID} is not synced`
    )
  }
  const contractType = getContractType(rootState, contractID)
  if (typeof contractType !== 'string') {
    throw new ChelErrorKvSlotUnknown(
      `[chelonia/kv] ${label}: contract ${contractID} has no resolved type`
    )
  }
  const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key)
  if (!slot) {
    throw new ChelErrorKvSlotUnknown(
      `[chelonia/kv] ${label}: no active slot for ${contractID}::${key}`
    )
  }
  return slot
}

// 128-bit random nonce, base64-encoded. Used by `chelonia/kv/update`
// for self-echo suppression (KV-REVAMPED §4.9). Collision between
// independent writers is cryptographically negligible at this width,
// so a remote write can never be misclassified as a local echo.
function base64Nonce (): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let bin = ''
  for (let i = 0; i < 16; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Unwrap a `{ __chelKvNonce, value }` envelope, returning both the
// extracted nonce (if present) and the inner value. Raw-API writers
// may not wrap, so fall back to the data verbatim — same tolerance
// across `_loadSlot`, `_handleRemote`, and `onconflict`.
//
// NOTE: the shape `{ __chelKvNonce: string, value: any }` is a reserved
// wrapper shape used internally by the KV slot API for self-echo
// suppression (§4.9). Consumer values that happen to match this shape
// will be treated as an internal wrapper — the `__chelKvNonce` field
// will be stripped and `value` extracted. Avoid using `__chelKvNonce`
// as a top-level key in slot values.
function unwrapData (data: JSONType): { nonce: string | undefined; value: JSONType } {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    '__chelKvNonce' in (data as object) &&
    typeof (data as { __chelKvNonce?: unknown }).__chelKvNonce === 'string' &&
    'value' in (data as object)
  ) {
    const wrapper = data as { __chelKvNonce: string; value: JSONType }
    return { nonce: wrapper.__chelKvNonce, value: wrapper.value }
  }
  return { nonce: undefined, value: data }
}

// Reject the reserved `{ __chelKvNonce, value }` wrapper shape on
// consumer-supplied values. `unwrapData` (above) strips this envelope on
// read, so a top-level value matching it would be silently unwrapped on
// any read path (`_loadSlot`, `_handleRemote`, `onconflict`). The
// `defineSlot` defaultValue check (§4.1), the schema-guard default-parse
// check (§4.1), and every runtime parse/store path (§4.9) call this so
// the reservation is enforced uniformly — not only for defaults.
//
// Throws the supplied `Error` subclass so each call site preserves its
// own taxonomy (`ChelErrorKvValidation` for load/remote/default-parse;
// `ChelErrorKvUpdateInvalid` for reducer outputs). The caller is
// responsible for `.cause` attachment if needed.
type KvErrorCtor = { new (...args: ConstructorParameters<typeof Error>): Error }
function assertNotReservedWrapper (
  value: unknown,
  where: string,
  ErrorCtor: KvErrorCtor
): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '__chelKvNonce' in (value as object) &&
    'value' in (value as object)
  ) {
    throw new ErrorCtor(
      `[chelonia/kv] ${where}: value has the reserved shape ` +
      '{ __chelKvNonce, value }; this top-level key combination is ' +
      'reserved for internal use'
    )
  }
}

// Track a locally-generated write nonce for self-echo suppression.
function recordEchoNonce (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  nonce: string
): void {
  const echoKey = `${contractID}::${key}`
  let nonces = ctx.kvLocalEchoNonces.get(echoKey)
  if (!nonces) {
    nonces = new Set()
    ctx.kvLocalEchoNonces.set(echoKey, nonces)
  }
  nonces.add(nonce)
  while (nonces.size > KV_ECHO_NONCE_MAX) {
    const oldest = nonces.values().next().value
    if (oldest === undefined) break
    nonces.delete(oldest)
  }
}

// Per-contract pending-write counter. `chelonia/kv/update` and
// `chelonia/kv/clear` increment this at call time (before their queued
// body runs) and decrement it from inside the body's `finally`. The
// counter is the third source for `chelonia/kv/_waitInFlight` so a
// write whose slot index entry and echo nonce have both been removed
// mid-flight (contract release, match→false, defineSlot replacement)
// still settles before `chelonia/reset` tears down state. See the
// `_waitInFlight` comment for the full three-source rationale.
function incrementPending (ctx: CheloniaContext, contractID: string): void {
  ctx.kvPendingWrites.set(contractID, (ctx.kvPendingWrites.get(contractID) ?? 0) + 1)
}

function decrementPending (ctx: CheloniaContext, contractID: string): void {
  const n = (ctx.kvPendingWrites.get(contractID) ?? 1) - 1
  if (n <= 0) ctx.kvPendingWrites.delete(contractID)
  else ctx.kvPendingWrites.set(contractID, n)
}

// Remove specific pending self-echo nonces.
function removeEchoNonces (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  nonces: string[]
): void {
  if (nonces.length === 0) return
  const echoKey = `${contractID}::${key}`
  const pending = ctx.kvLocalEchoNonces.get(echoKey)
  if (!pending) return
  for (const n of nonces) {
    pending.delete(n)
  }
  if (pending.size === 0) ctx.kvLocalEchoNonces.delete(echoKey)
}

function throwIfSignalAborted (signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError')
}

type KvConflictCause = { currentData?: JSONType; etag?: string | null }

function kvConflictCause (e: unknown): KvConflictCause | undefined {
  const cause = (e as { cause?: unknown })?.cause
  return cause && typeof cause === 'object' ? cause as KvConflictCause : undefined
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
    queueMicrotask(async () => {
      await flushDirtyFilters(ctx)
    })
  }
}

async function flushDirtyFilters (ctx: CheloniaContext): Promise<void> {
  const dirty = Array.from(ctx.kvFilterDirty)
  ctx.kvFilterDirty.clear()
  for (const cID of dirty) {
    const active = ctx.kvActiveFilters.get(cID)
    try {
      await sbp('chelonia/kv/setFilter', cID, active ? [...active] : [])
    } catch (e) {
      console.warn(`[chelonia/kv] setFilter flush failed for ${cID}`, e)
    }
  }
}

export default (sbp('sbp/selectors/register', {
  // Dev-time invariant check. See KV-REVAMPED.md §11.2 ("Index
  // invariant"). Walks the five KV maps + `rootState._kv` and verifies:
  //
  //   kvSlotsByContractID[cID].has(key) ⇔
  //     (a) kvSlots has a registration for `${contractType}::${key}` whose
  //         contractType matches getContractType(rootState, cID)
  //         (rootState.contracts[cID].type with a `_vm.type` fallback), AND
  //     (b) cID ∈ subscriptionSet, AND
  //     (c) autoSubscribe slots are present in kvActiveFilters[cID], while
  //         autoSubscribe:false slots are absent from kvActiveFilters[cID].
  //
  // Throws a plain Error on the first inconsistency found — this is a
  // CI / test-suite assertion, not a user-facing error class. Intended
  // to be called from each KV test's `afterEach`. Cheap enough to run
  // unconditionally in tests; gate behind a build-time flag in
  // production if it ever ships there.
  'chelonia/kv/_assertIndexConsistent': function (this: CheloniaContext) {
    // Skip in production only. Runs in both 'development' and 'test'.
    if (process.env.NODE_ENV === 'production') return
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
      const contractType = getContractType(rootState, cID)
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
    // kvFilterDirty entries that have no corresponding kvActiveFilters or
    // kvSlotsByContractID entry are legitimate: _cleanupContractRuntime
    // queues a microtask flush and then deletes the runtime state, leaving
    // the dirty mark until the microtask fires. Skip these pending-empty-
    // flush entries. For entries that *do* have runtime state, verify the
    // keys match kvSlotsByContractID.
    for (const cID of this.kvFilterDirty) {
      const hasRuntimeState = this.kvActiveFilters.has(cID) || this.kvSlotsByContractID.has(cID)
      if (hasRuntimeState) {
        const activeFilter = this.kvActiveFilters.get(cID)
        const perKey = this.kvSlotsByContractID.get(cID)
        if (activeFilter && perKey) {
          for (const key of activeFilter) {
            if (!perKey.has(key)) {
              throw new Error(
                `[chelonia/kv] index invariant: kvActiveFilters[${cID}] has ${key} but ` +
                'kvSlotsByContractID lacks it'
              )
            }
          }
        }
      }
    }
    // rootState._kv mirror entries must correspond to active slots. Every
    // key in rootState._kv[cID] should have a matching entry in
    // kvSlotsByContractID[cID]. Stale mirror entries after release or
    // match→false are a leak. Contracts not in subscriptionSet are
    // exempt — they may have persisted mirror entries from a previous
    // session that were re-validated by `defineSlot` but haven't been
    // synced yet (§4.1 "every persisted entry" re-validation path).
    const kvMirror = rootState._kv
    if (kvMirror) {
      for (const cID of Object.keys(kvMirror)) {
        if (!this.subscriptionSet.has(cID)) continue
        const perContract = kvMirror[cID]
        if (!perContract) continue
        const activeSlots = this.kvSlotsByContractID.get(cID)
        for (const key of Object.keys(perContract)) {
          if (!activeSlots?.has(key)) {
            throw new Error(
              `[chelonia/kv] index invariant: rootState._kv[${cID}] has key ` +
              `${key} but no active slot in kvSlotsByContractID`
            )
          }
        }
      }
    }
  },

  // Public API. See KV-REVAMPED.md §4.1. Idempotent per
  // `(contractType, key)` — last call wins, with re-validation of any
  // persisted mirror values against the new schema.
  //
  // This is a thin wrapper around the internal
  // `chelonia/kv/_defineSlotInternal` selector — it always tags the
  // resulting slot with `_source: { kind: 'defineSlot' }`. The internal
  // selector is what `chelonia/kv/_registerContractSlots` uses to tag
  // manifest-scoped slots; userland callers can never spoof a
  // `kind: 'defineContract'` source through this selector because the
  // public `KvSlotDefinition` type has no `_source` field.
  'chelonia/kv/defineSlot': function (
    this: CheloniaContext,
    def: KvSlotDefinition
  ): void {
    sbp('chelonia/kv/_defineSlotInternal', def, { kind: 'defineSlot' as const })
  },

  // Private. The actual `defineSlot` implementation. Accepts an
  // explicit `source` so `_registerContractSlots` can mark slots as
  // manifest-owned for `_cleanupContractSlots` to scope removals
  // correctly. Not re-exported; not callable from userland through
  // typed APIs.
  'chelonia/kv/_defineSlotInternal': function (
    this: CheloniaContext,
    def: KvSlotDefinition,
    source: SlotDefinitionSource
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
    // Runtime validation of optional fields (SBP selectors are callable
    // from JavaScript without TypeScript enforcement).
    if (def.match != null && typeof def.match !== 'function') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: match must be a function')
    }
    if (def.schema != null && (typeof def.schema.parse !== 'function')) {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: schema must have a parse method')
    }
    if (def.defaultUpdater != null && typeof def.defaultUpdater !== 'function') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: defaultUpdater must be a function')
    }
    if (def.onUpdate != null && typeof def.onUpdate !== 'function') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: onUpdate must be a function')
    }
    if (def.autoLoad != null &&
        def.autoLoad !== 'on-sync' && def.autoLoad !== 'on-demand' && def.autoLoad !== 'never') {
      throw new ChelErrorKvSlotInvalid(
        '[chelonia/kv] defineSlot: autoLoad must be one of "on-sync", "on-demand", "never"'
      )
    }
    if (def.encryptionKeyName != null && typeof def.encryptionKeyName !== 'string') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: encryptionKeyName must be a string')
    }
    if (def.signingKeyName != null && typeof def.signingKeyName !== 'string') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: signingKeyName must be a string')
    }
    if (def.autoSubscribe != null && typeof def.autoSubscribe !== 'boolean') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: autoSubscribe must be a boolean')
    }
    if (def.refreshOnReconnect != null && typeof def.refreshOnReconnect !== 'boolean') {
      throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: refreshOnReconnect must be a boolean')
    }
    for (const contractType of types) {
      if (typeof contractType !== 'string' || contractType.length === 0) {
        throw new ChelErrorKvSlotInvalid('[chelonia/kv] defineSlot: invalid contractType')
      }
    }
    // Resolve the default value once before the loop — factories must run
    // exactly once regardless of how many contract types are listed
    // (KV-REVAMPED §4.1).
    const dv = def.defaultValue
    let rawDefault: JSONType | undefined
    try {
      rawDefault = typeof dv === 'function' ? dv() : dv
    } catch (e) {
      throw new ChelErrorKvSlotInvalid(
        '[chelonia/kv] defineSlot: defaultValue factory threw',
        { cause: e }
      )
    }
    if (rawDefault === null) {
      throw new ChelErrorKvSlotInvalid(
        '[chelonia/kv] defineSlot: defaultValue may not be null; ' +
        'null is the reserved wire clear sentinel'
      )
    }
    // Reject defaultValue with the reserved { __chelKvNonce, value }
    // top-level shape. `unwrapData` strips this envelope on read, so a
    // consumer storing { __chelKvNonce, value } would silently lose the
    // outer object. This check runs unconditionally (not gated on schema)
    // so schemaless slots are also protected.
    if (rawDefault !== undefined) {
      try {
        assertNotReservedWrapper(
          rawDefault, `defineSlot defaultValue ${def.key}`, ChelErrorKvSlotInvalid
        )
      } catch (e) {
        throw new ChelErrorKvSlotInvalid(
          `[chelonia/kv] defineSlot: defaultValue for key '${def.key}' ` +
          'has the reserved shape { __chelKvNonce, value }; this top-level ' +
          'key combination is reserved for internal use',
          { cause: e }
        )
      }
    }
    if (rawDefault !== undefined) {
      try {
        assertJsonShape(rawDefault, `defineSlot defaultValue ${def.key}`)
      } catch (e) {
        throw new ChelErrorKvSlotInvalid(
          `[chelonia/kv] defineSlot: defaultValue for key '${def.key}' is not JSON-shaped`,
          { cause: e }
        )
      }
    }
    const resolvedDefault: JSONType | undefined =
      rawDefault === undefined ? undefined : cloneDeep(rawDefault)
    // Run the schema guards once on a probe slot regardless of how many
    // contract types are listed. The guards parse `resolvedDefault` up
    // to four times (two sentinel probes + a two-step idempotence
    // round-trip), so the per-type loop below would otherwise multiply
    // that work by N and produce N sibling slots sharing the same
    // post-parse `resolvedDefault` object identity — a fragile invariant
    // if anything ever mutates `resolvedDefault` in place. Cloning
    // per-type keeps each slot independent.
    let postParseDefault: JSONType | undefined = resolvedDefault
    if (def.schema && resolvedDefault !== undefined) {
      const probe = resolveSlotDefinition(def, types[0], resolvedDefault, source)
      assertSchemaGuards(probe)
      postParseDefault = probe.resolvedDefault
    } else {
      // No schema (or no resolved default) → guards are pure checks on
      // the schema itself; run once with the first type.
      const probe = resolveSlotDefinition(def, types[0], resolvedDefault, source)
      assertSchemaGuards(probe)
    }
    for (const contractType of types) {
      const perTypeDefault: JSONType | undefined =
        postParseDefault === undefined ? undefined : cloneDeep(postParseDefault)
      const slot = resolveSlotDefinition(def, contractType, perTypeDefault, source)
      const rKey = registryKey(contractType, def.key)
      const previous = this.kvSlots.get(rKey)
      this.kvSlots.set(rKey, slot)
      // Walk every synced contract whose type matches and reconcile.
      // This both wires up newly-eligible contracts and re-validates
      // persisted mirror entries on first activation and slot replacement.
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      for (const cID of this.subscriptionSet) {
        const meta = rootState.contracts?.[cID]
        if (!meta || getContractType(rootState, cID) !== contractType) continue
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
        }
        sbp('chelonia/kv/_reconcileForSlot', slot, cID)
        // Re-validate any persisted mirror entry *after* reconcile so
        // the index invariant holds; gate on the slot still being
        // registered (reconcile may have removed it if the contract was
        // released or the match filter changed). Surface failures via
        // status/event but keep the old value (§4.1).
        if (this.kvSlotsByContractID.get(cID)?.get(def.key) === slot) {
          revalidateMirrorEntry(this, rootState, cID, slot)
        }
      }
      // Also re-validate persisted mirror entries for contracts not
      // currently in subscriptionSet (e.g. not yet re-synced after a
      // reload). §4.1 requires re-validating *every* persisted entry,
      // not just those for currently-synced contracts. Skip entries
      // whose contract type cannot be confirmed to match — re-validating
      // against the wrong slot type would spuriously flip foreign
      // entries to 'error'.
      if (rootState._kv) {
        for (const cID of Object.keys(rootState._kv)) {
          if (this.subscriptionSet.has(cID)) continue
          const cType = getContractType(rootState, cID)
          if (cType !== contractType) continue
          revalidateMirrorEntry(this, rootState, cID, slot)
        }
      }
    }
  },

  // Private. Reconciles a single (slot, contractID) pair: evaluates
  // `match`, maintains the index invariant (§11.2), updates the active
  // filter set, and schedules an `autoLoad: 'on-sync'` fetch. This is
  // the per-contract inner step of KV-REVAMPED §11.3 step 2 — callers
  // iterate synced contracts and invoke this for each relevant pair.
  'chelonia/kv/_reconcileForSlot': function (
    this: CheloniaContext,
    slot: SlotDefinition,
    contractID: string
  ): void {
    if (!this.subscriptionSet.has(contractID)) return
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const meta = rootState.contracts?.[contractID]
    if (!meta || getContractType(rootState, contractID) !== slot.contractType) return
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
      const createdFilterBucket = !filter
      if (!filter) {
        filter = new Set()
        this.kvActiveFilters.set(contractID, filter)
      }
      if (slot.autoSubscribe && !filter.has(slot.key)) {
        filter.add(slot.key)
        queueFilterFlush(this, contractID)
      } else if (!slot.autoSubscribe) {
        if (filter.has(slot.key)) {
          filter.delete(slot.key)
          queueFilterFlush(this, contractID)
        } else if (createdFilterBucket) {
          queueFilterFlush(this, contractID)
        }
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
        // Fire-and-forget — `_loadSlot` manages its own status events and
        // may reject on GET or validation failure; the `.catch` here
        // keeps that rejection out of the reconcile dispatch path.
        sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
          .catch((e: unknown) => {
            console.error(
              `[chelonia/kv] _loadSlot rejected for ${contractID}::${slot.key}`, e
            )
          })
      }
    } else {
      // match returned false — tear down if active, and clean up any
      // stale persisted mirror entry regardless of prior active state.
      if (wasActive) {
        perKey!.delete(slot.key)
        const contractEmptied = perKey!.size === 0
        if (contractEmptied) this.kvSlotsByContractID.delete(contractID)
        const filter = this.kvActiveFilters.get(contractID)
        if (filter?.has(slot.key)) {
          filter.delete(slot.key)
          queueFilterFlush(this, contractID)
        }
        if (contractEmptied) this.kvActiveFilters.delete(contractID)
      }
      const perContract = rootState._kv?.[contractID]
      if (perContract && perContract[slot.key]) {
        this.config.reactiveDel(perContract, slot.key)
      }
    }
  },

  // Private queued wrapper. See KV-REVAMPED §11.3 step 3. Routes
  // `_loadSlotNow` through `chelonia/queueInvocation` keyed on
  // `contractID` so explicit loads serialize against in-flight
  // `chelonia/kv/update` writes.
  'chelonia/kv/_loadSlot': function (
    this: CheloniaContext,
    {
      contractID,
      slot,
      reason
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
    }
  ): Promise<void> {
    return sbp('chelonia/queueInvocation', contractID, () =>
      sbp('chelonia/kv/_loadSlotNow', { contractID, slot, reason })
    )
  },

  // Private unqueued implementation. Fetches via `chelonia/kv/get`,
  // unwraps the `{ __chelKvNonce, value }` envelope, validates, and
  // writes the mirror. Callers must already hold the per-contract lane
  // or intentionally run outside it.
  'chelonia/kv/_loadSlotNow': function (
    this: CheloniaContext,
    {
      contractID,
      slot,
      reason
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
    }
  ): Promise<void> {
    return (async () => {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      // The contract may have been released between scheduling and
      // running — bail out cleanly.
      if (!this.subscriptionSet.has(contractID)) return
      const perContract = ensureContractKv(this, rootState, contractID)
      if (!perContract[slot.key]) {
        // Reconcile dropped the entry while we were queued.
        return
      }
      const priorStatus = perContract[slot.key]?.status
      setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, 'loading')
      let parsed: ChelKvGetResult | null
      try {
        parsed = await sbp('chelonia/kv/get', contractID, slot.key)
      } catch (e) {
        // Staleness guard (symmetric with the success paths below): if
        // `defineSlot` replaced this slot while the GET was in flight,
        // bail out before stamping an error onto the replacement slot's
        // mirror entry. Restore priorStatus if this invocation set
        // 'loading', matching the null/non-null branches' teardown.
        if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
          const currentEntry = perContract[slot.key]
          if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
            setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus)
          }
          return
        }
        const lastError = normalizeError(e)
        setSlotStatus(
          this, rootState, contractID, slot.contractType, slot.key,
          'error', lastError
        )
        throw e
      }
      if (parsed === null) {
        // Staleness guard (symmetric with the non-null path below):
        // if `defineSlot` replaced this slot while the GET was in
        // flight, bail out before mutating the mirror.
        if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
          const currentEntry = perContract[slot.key]
          if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
            setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus)
          }
          return
        }
        // 404 — key not yet written (or deleted server-side). Reset
        // the mirror to the declared default state (`value: undefined`,
        // `etag: null`) and surface `'non-init'` rather than `'loaded'`
        // (§4.3). If the slot previously held a value, emit
        // `CHELONIA_KV_UPDATED` so consumers observe the transition.
        // The event payload carries `undefined`, matching the mirror;
        // `onUpdate` receives the resolved default so callbacks observe
        // the same value `read` will subsequently return.
        const existingEntry = perContract[slot.key]
        let previousValue: JSONType | undefined
        if (existingEntry) {
          previousValue = existingEntry.value
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
          }
        }
        // Transition to 'non-init' before onUpdate (matching the
        // success-path sequencing of setSlotStatus → safeOnUpdate).
        setSlotStatus(
          this, rootState, contractID, slot.contractType, slot.key, 'non-init'
        )
        if (existingEntry && previousValue !== undefined) {
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
        return
      }
      // Unwrap the `{ __chelKvNonce, value }` envelope written by
      // `chelonia/kv/update` / `chelonia/kv/clear`. For backwards
      // compatibility with raw-API writers that don't wrap, fall
      // back to `parsed.data` itself. `parsed.data` is a lazy accessor
      // that can throw on decrypt/signature failure, so downgrade that
      // failure through the same status path as schema validation.
      let unwrapped: JSONType
      try {
        ;({ value: unwrapped } = unwrapData(parsed.data))
      } catch (e) {
        if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
          const currentEntry = perContract[slot.key]
          if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
            setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus)
          }
          return
        }
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          error: e,
          reason
        })
        setSlotStatus(
          this, rootState, contractID, slot.contractType, slot.key,
          'error', normalizeError(e)
        )
        throw new ChelErrorKvValidation(
          `[chelonia/kv] load: ${contractID}::${slot.key} decode failed`,
          { cause: e }
        )
      }
      // Capture the etag from the GET response before any await point.
      const getEtag = parsed.etag ?? null
      // Staleness guard: if `defineSlot` replaced this slot while the
      // fetch was in flight, the captured `slot` object is stale — its
      // schema / defaults / callbacks no longer match the registry.
      // Restore the prior status so the slot doesn't remain stuck at
      // 'loading' (the replacement slot will manage its own lifecycle).
      if (this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) {
        const currentEntry = perContract[slot.key]
        if (currentEntry && currentEntry.status === 'loading' && priorStatus != null) {
          setSlotStatus(this, rootState, contractID, slot.contractType, slot.key, priorStatus)
        }
        return
      }
      const entry = perContract[slot.key]
      const previousValue = entry?.value
      // Wire `null` is the clear sentinel — skip schema.parse and
      // restore the deep-cloned default.
      const wasClear = unwrapped === null
      let nextValue: JSONType | undefined
      if (wasClear) {
        nextValue = slot.resolvedDefault !== undefined
          ? cloneDeep(slot.resolvedDefault)
          : undefined
      } else if (slot.schema) {
        try {
          nextValue = parseSyncSlotValue(slot, unwrapped, `load ${contractID}::${slot.key}`)
        } catch (e) {
          sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            error: e,
            reason
          })
          setSlotStatus(
            this, rootState, contractID, slot.contractType, slot.key,
            'error', normalizeError(e)
          )
          throw new ChelErrorKvValidation(
            `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`,
            { cause: e }
          )
        }
      } else {
        try {
          nextValue = assertJsonShape(unwrapped, `load ${contractID}::${slot.key}`)
        } catch (e) {
          sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            error: e,
            reason
          })
          setSlotStatus(
            this, rootState, contractID, slot.contractType, slot.key,
            'error', normalizeError(e)
          )
          throw new ChelErrorKvValidation(
            `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`,
            { cause: e }
          )
        }
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
        this, rootState, contractID, slot.contractType, slot.key,
        wasClear ? 'non-init' : 'loaded'
      )
      await safeOnUpdate(slot, nextValue, {
        contractID,
        contractType: slot.contractType,
        key: slot.key,
        reason,
        etag: getEtag,
        previousValue
      })
    })()
  },

  // Private listener for CONTRACTS_MODIFIED. Mounted from
  // `chelonia/connect` (see chelonia.ts) so that newly-synced
  // contracts automatically wire up every matching slot, and
  // removed contracts have their per-contract KV runtime state
  // cleaned up (KV-REVAMPED §11.4).
  'chelonia/kv/_onContractsModified': function (
    this: CheloniaContext,
    { added, removed }: { added: string[]; removed: string[] }
  ): void {
    if (added && added.length > 0) {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      for (const cID of added) {
        const meta = rootState.contracts?.[cID]
        if (!meta) continue
        const contractType = getContractType(rootState, cID)
        if (!contractType) continue
        for (const slot of this.kvSlots.values()) {
          if (slot.contractType !== contractType) continue
          sbp('chelonia/kv/_reconcileForSlot', slot, cID)
        }
      }
    }
    if (removed && removed.length > 0) {
      for (const cID of removed) {
        sbp('chelonia/kv/_cleanupContractRuntime', cID)
      }
    }
  },

  // Private. See KV-REVAMPED §11.4 (contract-release / unsubscribe path).
  // Clears per-contract KV runtime state for `contractID`: removes
  // `rootState._kv[contractID]`, `kvSlotsByContractID[contractID]`,
  // `kvActiveFilters[contractID]`, and schedules an empty-filter
  // `setFilter` flush. The `kvFilterDirty` mark is intentionally
  // retained until the microtask fires so the flush sees this
  // contract in the dirty set. Keeps long-lived sessions from
  // accumulating stale mirror entries after refcount goes to zero.
  'chelonia/kv/_cleanupContractRuntime': function (
    this: CheloniaContext,
    contractID: string
  ): void {
    // Queue a filter flush for this contract *before* dropping state so
    // the server receives the empty-filter frame (§11.5 empty
    // transitions). The flush reads kvActiveFilters at microtask time;
    // deleting the entry below is what makes the emitted filter empty.
    // We intentionally do NOT delete from kvFilterDirty here — the
    // microtask must see this contract in the dirty set to send the
    // empty-filter frame.
    queueFilterFlush(this, contractID)
    this.kvSlotsByContractID.delete(contractID)
    this.kvActiveFilters.delete(contractID)
    this.kvLocalEchoNonces.forEach((_fifo, key) => {
      if (key.startsWith(`${contractID}::`)) {
        this.kvLocalEchoNonces.delete(key)
      }
    })
    this.kvLocalWriteAwaitingRemote.forEach((key) => {
      if (key.startsWith(`${contractID}::`)) {
        this.kvLocalWriteAwaitingRemote.delete(key)
      }
    })
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (rootState._kv && rootState._kv[contractID]) {
      this.config.reactiveDel(rootState._kv, contractID)
    }
  },

  // Private. Drain (not cancel) in-flight `chelonia/kv/update` /
  // `chelonia/kv/clear` writes before `chelonia/reset` tears down state.
  // KV writes run inside the per-contract `chelonia/queueInvocation`
  // lane, so enqueuing a noop behind them resolves only once they
  // settle — symmetric with `chelonia/contract/wait`. The contract set
  // is the union of three sources:
  //   1. contracts with an active slot index
  //      (`kvSlotsByContractID`),
  //   2. contracts that still own an echo-suppression nonce
  //      (`kvLocalEchoNonces` — an in-flight write whose slot index was
  //      already cleaned up but whose body has progressed far enough to
  //      record a nonce), and
  //   3. contracts with a non-zero pending-write count
  //      (`kvPendingWrites` — a write whose body is still queued behind
  //      a prior operation and has not yet recorded a nonce; the slot
  //      index and nonce sources miss this window).
  // `chelonia/reset` awaits this before clearing the KV runtime maps so
  // continuations never run against a torn-down mirror or a swapped-out
  // `kvLocalEchoNonces`. `_loadSlot` syncs are drained through source #1;
  // if the contract is released before a queued load runs, `_loadSlot`'s
  // subscription guard bails out before mutating state.
  'chelonia/kv/_waitInFlight': function (
    this: CheloniaContext
  ): Promise<unknown> {
    const ids = new Set<string>(this.kvSlotsByContractID.keys())
    this.kvLocalEchoNonces.forEach((_fifo, echoKey) => {
      const idx = echoKey.indexOf('::')
      if (idx > 0) ids.add(echoKey.slice(0, idx))
    })
    this.kvPendingWrites.forEach((_n, cID) => ids.add(cID))
    return Promise.all(
      Array.from(ids).map((cID) =>
        sbp('chelonia/queueInvocation', cID, ['chelonia/private/noop'])
      )
    )
  },

  // Private. See KV-REVAMPED §11.4 bullet 3 (reconnect hook).
  // Called from the pubsub reconnect-open path. Clears pending local
  // echo nonces (any echo from a pre-disconnect write has either been
  // delivered or is lost) and re-fetches every active slot with
  // `refreshOnReconnect === true` through the per-contract
  // queueInvocation lane so reconnect fetches are serialized with
  // in-flight writes.
  'chelonia/kv/_onReconnect': function (this: CheloniaContext): void {
    this.kvLocalEchoNonces.clear()
    this.kvLocalWriteAwaitingRemote.clear()
    for (const [cID, perKey] of this.kvSlotsByContractID) {
      for (const [, slot] of perKey) {
        if (slot.refreshOnReconnect) {
          sbp('chelonia/kv/_loadSlot', { contractID: cID, slot, reason: 'reconnect' })
            .catch((e: unknown) => {
              console.error(
                `[chelonia/kv] _loadSlot (reconnect) rejected for ${cID}::${slot.key}`, e
              )
            })
        }
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
  //     from the FIFO and clear any nonce-scoped awaiting entry.
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
    // tolerance (mirrors the `_loadSlot` unwrap shape). `parsed.data`
    // may throw before we can read a local echo nonce; bounded nonce
    // storage keeps such unsuppressed entries from growing indefinitely.
    let nonce: string | undefined
    let unwrapped: JSONType
    try {
      ;({ nonce, value: unwrapped } = unwrapData(parsed?.data as JSONType))
    } catch (e) {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
        contractID,
        contractType: slot.contractType,
        key,
        error: e,
        reason: 'remote'
      })
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key,
        'error', normalizeError(e)
      )
      return Promise.resolve()
    }
    const echoKey = `${contractID}::${key}`
    // Self-echo suppression: if the nonce matches a pending local
    // write, drop the frame and remove the pending entry.
    if (nonce) {
      const pending = this.kvLocalEchoNonces.get(echoKey)
      if (pending?.has(nonce)) {
        pending.delete(nonce)
        if (pending.size === 0) this.kvLocalEchoNonces.delete(echoKey)
        this.kvLocalWriteAwaitingRemote.delete(`${echoKey}::${nonce}`)
        return Promise.resolve()
      }
    }
    let awaitingNonceKey: string | undefined
    for (const k of this.kvLocalWriteAwaitingRemote) {
      if (k.startsWith(`${echoKey}::`)) {
        awaitingNonceKey = k
        break
      }
    }
    if (awaitingNonceKey) {
      return sbp('chelonia/kv/_loadSlotNow', { contractID, slot, reason: 'remote' })
        .finally(() => {
          this.kvLocalWriteAwaitingRemote.delete(awaitingNonceKey)
        })
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
        nextValue = parseSyncSlotValue(slot, unwrapped, `remote ${contractID}::${key}`)
      } catch (e) {
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
          contractID,
          contractType: slot.contractType,
          key,
          error: e,
          reason: 'remote'
        })
        setSlotStatus(
          this, rootState, contractID, slot.contractType, key,
          'error', normalizeError(e)
        )
        // Deliberately leave `entry.etag` alone: validation failed, so
        // the mirror `value` is unchanged from the last successful
        // load/write — the etag still describes that value. Nulling
        // it here would diverge from the "value and etag move
        // together" invariant on the success path below (and on
        // §4.9's pubsub-success branch).
        return Promise.resolve()
      }
    } else {
      try {
        nextValue = assertJsonShape(unwrapped, `remote ${contractID}::${key}`)
      } catch (e) {
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
          contractID,
          contractType: slot.contractType,
          key,
          error: e,
          reason: 'remote'
        })
        setSlotStatus(
          this, rootState, contractID, slot.contractType, key,
          'error', normalizeError(e)
        )
        return Promise.resolve()
      }
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
    // A remote clear (unwrapped === null) transitions to 'non-init',
    // matching local clear semantics (§4.5). A successful remote update
    // always calls setSlotStatus('loaded') so that any stale `lastError`
    // is cleared (setSlotStatus internally skips the event when both
    // status and lastError are unchanged).
    if (unwrapped === null) {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key, 'non-init'
      )
    } else {
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
  // a self-echo nonce, and writes via `chelonia/kv/set` directly inside
  // the same per-contract queueInvocation lane used by `_handleRemote`.
  //
  // Resolves with the stored value (the reducer's last accepted
  // output), or `undefined` when the reducer returned `KV_NOOP`.
  //
  // Rejection taxonomy (§4.2):
  //   - `ChelErrorKvSlotUnknown`   — contract not synced, or no slot
  //                                  registered for `(contractType, key)`.
  //   - `ChelErrorKvUpdateInvalid` — `updater`/`value` misuse; thrown
  //                                  synchronously before any I/O.
  //                                  Also covers reducer throws and
  //                                  reducer returns of `null` /
  //                                  `undefined` (use `KV_NOOP` to
  //                                  abort explicitly). The original
  //                                  thrown value is preserved on
  //                                  `.cause`.
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
  //   - other errors propagated verbatim from `chelonia/kv/set` (called
  //     directly inside the per-contract queue; not via `queuedSet`) for
  //     non-409/412 HTTP failures (5xx, offline). `status` is NOT flipped
  //     to `'error'` (that state is reserved for load failures — §4.9).
  'chelonia/kv/update': async function (
    this: CheloniaContext,
    args: {
      contractID: string;
      key: string;
      updater?: KvUpdater<JSONType>;
      value?: JSONType;
      maxAttempts?: number;
      signal?: AbortSignal;
      ifMatch?: string;
    }
  ): Promise<JSONType | undefined> {
    const { contractID, key, updater, value, maxAttempts, signal, ifMatch } = args
    // ----- Step 1: resolve the slot via active index. -----
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'update')
    // ----- Step 1a: normalise the write input (synchronous). -----
    // Property-presence checks per §4.2: "Exactly one of `updater` or
    // `value` must be provided" discriminates on which channel the
    // caller chose, not on the runtime value (so `value: undefined`
    // counts as "value was provided").
    const hasUpdater = has(args, 'updater')
    const hasValue = has(args, 'value')
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
    if (hasUpdater && typeof updater !== 'function') {
      throw new ChelErrorKvUpdateInvalid(
        `[chelonia/kv] update: ${contractID}::${key} — \`updater\` was ` +
        'provided but is not a function'
      )
    }
    let reducer: KvUpdater<JSONType>
    if (hasUpdater) {
      reducer = updater as KvUpdater<JSONType>
    } else {
      if (!slot.defaultUpdater) {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} — \`value\` was ` +
          'provided but the slot has no `defaultUpdater`'
        )
      }
      // Synthesise the reducer once — the same closure is re-invoked
      // on conflict retries (§4.2 step 1a).
      let factoryOut: KvUpdater<JSONType>
      try {
        factoryOut = slot.defaultUpdater(value as JSONType) as KvUpdater<JSONType>
      } catch (e) {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
          'factory threw',
          { cause: e }
        )
      }
      if (typeof factoryOut !== 'function') {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} — defaultUpdater ` +
          'did not return a function'
        )
      }
      reducer = factoryOut
    }
    // Honour a pre-aborted signal before touching the network.
    throwIfSignalAborted(signal)
    // Track this operation on the pending-writes counter so
    // `chelonia/kv/_waitInFlight` can drain the contract even if the
    // slot index / nonce sources miss it (slot torn down mid-flight,
    // nonce not yet recorded). The increment runs at call time — before
    // the body is enqueued — so a concurrent `reset` cannot escape the
    // gate; the decrement runs in the queued body's `finally` so it
    // clears only when the body has settled.
    incrementPending(this, contractID)
    // The mirror read, reducer, and network write must all run inside the
    // per-contract serial queue so that each write sees the etag left by
    // the preceding one. Reading the mirror outside the queue means
    // concurrent calls all snapshot the same stale etag → guaranteed 412
    // → ONCONFLICT thrashing.
    const queued = sbp('chelonia/queueInvocation', contractID, async () => {
      throwIfSignalAborted(signal)
      // Re-read rootState inside the queue for fresh mirror state.
      const liveState = sbp(this.config.stateSelector) as ChelRootState
      if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
        throw new ChelErrorKvSlotUnknown(
          `[chelonia/kv] update: no active slot for ${contractID}::${key}`
        )
      }
      // ----- Step 2: read current mirror value. -----
      const perContract = ensureContractKv(this, liveState, contractID)
      const mirrorEntry = perContract[key]
      const seedValue: JSONType | undefined =
        mirrorEntry && mirrorEntry.status !== 'error' && mirrorEntry.value !== undefined
          ? cloneDeep(mirrorEntry.value as JSONType)
          : slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined
      // ----- Step 3: run reducer and validate. -----
      let reducerOut: unknown
      try {
        reducerOut = reducer(seedValue)
      } catch (e) {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} reducer threw`,
          { cause: e }
        )
      }
      if (typeof reducerOut === 'symbol') {
        if (reducerOut === KV_NOOP) return undefined
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
          'an unexpected symbol; use KV_NOOP to abort'
        )
      }
      if (reducerOut === null || reducerOut === undefined) {
        // Reducer may not produce the reserved wire sentinels; clear
        // is its own selector (§4.5). This is a caller-contract
        // violation (reducer shape), not a schema failure, so the
        // taxonomy bucket is ChelErrorKvUpdateInvalid (§4.6).
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
          `${String(reducerOut)}; use chelonia/kv/clear or KV_NOOP instead`
        )
      }
      let nextValue: JSONType = reducerOut as JSONType
      if (slot.schema) {
        try {
          nextValue = parseSyncSlotValue(slot, nextValue, `update ${contractID}::${key}`)
        } catch (e) {
          throw new ChelErrorKvValidation(
            `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
            'failed schema.parse',
            { cause: e }
          )
        }
      } else {
        try {
          nextValue = assertJsonShape(nextValue, `update ${contractID}::${key}`)
        } catch (e) {
          throw new ChelErrorKvUpdateInvalid(
            `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
            'is not JSON-shaped',
            { cause: e }
          )
        }
      }
      // ----- Step 5: nonce + wrap + kv/set with onconflict. -----
      throwIfSignalAborted(signal)
      const attemptNonces: string[] = []
      const firstNonce = base64Nonce()
      attemptNonces.push(firstNonce)
      recordEchoNonce(this, contractID, key, firstNonce)
      let lastCurrentData: JSONType | undefined
      let lastEtag: string | null | undefined
      let sawConflict = false
      const onconflict = async (conflictArgs: {
        currentData: JSONType | undefined;
        etag: string | null | undefined;
      }): Promise<[JSONType, string | undefined]> => {
        const { etag } = conflictArgs
        lastEtag = etag
        sawConflict = true
        throwIfSignalAborted(signal)
        let currentData: JSONType | undefined
        try {
          currentData = conflictArgs.currentData
        } catch (e) {
          throw new ChelErrorKvValidation(
            `[chelonia/kv] update: ${contractID}::${key} server ` +
            'currentData failed to decode on conflict retry',
            { cause: e }
          )
        }
        let basis: JSONType | undefined
        if (currentData === undefined) {
          basis = slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined
        } else {
          const { value: unwrapped } = unwrapData(currentData)
          if (unwrapped === null) {
            basis = slot.resolvedDefault !== undefined
              ? cloneDeep(slot.resolvedDefault)
              : undefined
          } else if (slot.schema) {
            try {
              basis = parseSyncSlotValue(slot, unwrapped, `update onconflict currentData ${contractID}::${key}`)
            } catch (e) {
              throw new ChelErrorKvValidation(
                `[chelonia/kv] update: ${contractID}::${key} server ` +
                'currentData failed schema.parse on conflict retry',
                { cause: e }
              )
            }
          } else {
            try {
              basis = assertJsonShape(unwrapped, `update onconflict currentData ${contractID}::${key}`)
            } catch (e) {
              throw new ChelErrorKvValidation(
                `[chelonia/kv] update: ${contractID}::${key} server ` +
                'currentData is not JSON-shaped on conflict retry',
                { cause: e }
              )
            }
          }
        }
        lastCurrentData = basis
        let retried: unknown
        try {
          retried = reducer(basis)
        } catch (e) {
          throw new ChelErrorKvUpdateInvalid(
            `[chelonia/kv] update: ${contractID}::${key} reducer threw on retry`,
            { cause: e }
          )
        }
        if (typeof retried === 'symbol') {
          if (retried === KV_NOOP) {
            throw new KvNoopAbort()
          }
          throw new ChelErrorKvUpdateInvalid(
            `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
            'an unexpected symbol on retry; use KV_NOOP to abort'
          )
        }
        if (retried === null || retried === undefined) {
          throw new ChelErrorKvUpdateInvalid(
            `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
            `${String(retried)} on retry; use KV_NOOP instead`
          )
        }
        let validated: JSONType = retried as JSONType
        if (slot.schema) {
          try {
            validated = parseSyncSlotValue(slot, retried, `update onconflict retry ${contractID}::${key}`)
          } catch (e) {
            throw new ChelErrorKvValidation(
              `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
              'failed schema.parse on conflict retry',
              { cause: e }
            )
          }
        } else {
          try {
            validated = assertJsonShape(validated, `update onconflict retry ${contractID}::${key}`)
          } catch (e) {
            throw new ChelErrorKvUpdateInvalid(
              `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
              'is not JSON-shaped on conflict retry',
              { cause: e }
            )
          }
        }
        // Each retry gets a fresh nonce so its pubsub echo is suppressed.
        nextValue = validated
        const nonce = base64Nonce()
        attemptNonces.push(nonce)
        recordEchoNonce(this, contractID, key, nonce)
        return [{ __chelKvNonce: nonce, value: validated }, typeof etag === 'string' ? etag : undefined] as [JSONType, string | undefined]
      }
      const mirrorEtag = mirrorEntry?.etag ?? undefined
      let setResult: { etag: string | null }
      try {
        // Call chelonia/kv/set directly (not via queuedSet) since we are
        // already inside the per-contract serial queue. Resolving key IDs
        // here (not at call-site) ensures key rotation that landed before
        // this write is seen; the IDs are fixed for kv/set's retries.
        setResult = await sbp('chelonia/kv/set', contractID, key,
          { __chelKvNonce: firstNonce, value: nextValue },
          {
            ifMatch: ifMatch ?? mirrorEtag,
            encryptionKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName),
            signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName),
            onconflict,
            maxAttempts,
            signal
          }
        ) as { etag: string | null }
      } catch (e) {
        // KV_NOOP abort: onconflict threw KvNoopAbort to signal that the
        // reducer chose not to write. The lower-level kv/set propagates
        // this throw, breaking the retry loop. Resolve as a no-op.
        // Use the Symbol.for marker (not instanceof) for realm safety.
        if (e && typeof e === 'object' && KV_NOOP_ABORT in (e as object)) {
          removeEchoNonces(this, contractID, key, attemptNonces)
          return undefined
        }
        // Map the lower-level conflict-exhaustion Error to the public
        // taxonomy (§4.2 step 6 / rejection table).
        if (e instanceof ChelErrorKvMaxAttempts) {
          removeEchoNonces(this, contractID, key, attemptNonces)
          const cause = kvConflictCause(e)
          throw new ChelErrorKvConflict(
            `[chelonia/kv] update: ${contractID}::${key} ran out of attempts ` +
            'resolving conflicts',
            {
              cause: {
                currentData: cause?.currentData ?? lastCurrentData,
                etag: cause?.etag ?? lastEtag ?? null
              }
            }
          )
        }
        // Network / HTTP error. The server may have accepted the write
        // (ambiguous failure), but since the mirror was not updated
        // locally, removing the nonces lets any pubsub echo reconcile
        // the mirror as reason: 'remote' rather than being silently
        // suppressed.
        removeEchoNonces(this, contractID, key, attemptNonces)
        throw e
      }
      // ----- Step 6: write mirror + emit events. -----
      // Post-write abort guard: the network write succeeded, but the
      // caller's signal was aborted between dispatch and resolution.
      // The spec (§4.2) requires the mirror to remain unchanged and no
      // event to fire. Remove only this call's nonces so the pubsub echo
      // is not suppressed for this write — it will reconcile the mirror
      // as reason: 'remote' — without corrupting a concurrent write's
      // echo suppression.
      try {
        throwIfSignalAborted(signal)
      } catch (e) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        throw e
      }
      // Staleness guard: `defineSlot` replaced the captured `slot`.
      // Remove this call's nonces so the pubsub echo reaches the current slot.
      if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        return undefined
      }
      const perContractAfter = ensureContractKv(this, liveState, contractID)
      const entryAfter = perContractAfter[key]
      const previousValue = entryAfter?.value
      if (!entryAfter) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        // Reconcile dropped the slot mid-write — nothing to mirror into.
        // Same rationale as the staleness path above: the value was not
        // written to a live mirror entry, so resolve with `undefined`
        // rather than misleading the caller with an unstored value.
        return undefined
      }
      this.config.reactiveSet(entryAfter, 'value', nextValue)
      this.config.reactiveSet(entryAfter, 'etag', setResult.etag)
      if (sawConflict) {
        const successfulNonce = attemptNonces[attemptNonces.length - 1]
        this.kvLocalWriteAwaitingRemote.add(`${contractID}::${key}::${successfulNonce}`)
      }
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
          this, liveState, contractID, slot.contractType, key, 'loaded'
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
    }) as Promise<JSONType | undefined>
    return queued.finally(() => {
      decrementPending(this, contractID)
    })
  },

  // Public. See KV-REVAMPED §4.3. Synchronous mirror read.
  //
  // Two-step slot resolution (same as `update`) — throws
  // `ChelErrorKvSlotUnknown` if the contract isn't synced/typed, or if
  // no slot is registered for `key` in the last-reconciled active index
  // (`kvSlotsByContractID[contractID]`). The contract type is resolved
  // only to confirm the contract is synced; the slot itself is looked up
  // by `(contractID, key)`, not by `registryKey(contractType, key)`.
  // Substitutes a deep-cloned `resolvedDefault` when the mirror entry
  // is absent, `value === undefined` (the "non-init" representation —
  // see the note in §4.3), or the slot is in `status: 'error'`. The
  // error-status fallback keeps `read` from exposing a value that failed
  // load / remote / re-validation under the current slot schema.
  // Returned value is the cloned default, or `undefined` if the slot has
  // no `defaultValue` and the mirror is empty.
  //
  // **Defensive deep-cloning.** Spec §4.1 only requires deep-cloning
  // the default, but the implementation goes further and deep-clones
  // every non-primitive mirror value on the way out. This prevents
  // the worst footgun — a caller mutating the returned object and
  // silently corrupting the mirror (and confusing every reactive
  // observer downstream). For very large slot values (e.g. namespace
  // caches) this is a non-trivial per-read cost; budget accordingly
  // or read-and-cache instead of reading-on-every-frame.
  'chelonia/kv/read': function (
    this: CheloniaContext,
    contractID: string,
    key: string
  ): JSONType | undefined {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'read')
    const entry = rootState._kv?.[contractID]?.[key]
    if (!entry || entry.value === undefined || entry.status === 'error') {
      return slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
    }
    const v = entry.value as JSONType
    return (v === null || typeof v !== 'object') ? v : cloneDeep(v)
  },

  // Public. See KV-REVAMPED §4.4. Force-fetch a slot (or every active
  // slot for a contract) and refresh the mirror.
  //
  // Single-slot form (with `key`) — rejects on slot failure, matching
  // the rejection semantics of `chelonia/kv/update`.
  //
  // Aggregate form (no `key`) — dispatches loads for every entry in the
  // last-reconciled active-slot index (`kvSlotsByContractID[contractID]`).
  // The loads are still serialized on the per-contract queue inside
  // `_loadSlot`, and per-slot failures surface via status/events while
  // the aggregate promise resolves after every load settles.
  'chelonia/kv/sync': async function (
    this: CheloniaContext,
    contractID: string,
    key?: string
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (key !== undefined) {
      const slot = resolveActiveSlot(this, rootState, contractID, key, 'sync')
      // _loadSlot rethrows GET failures verbatim, and wraps decode /
      // validation failures in ChelErrorKvValidation with the original
      // error on cause. Let the error propagate for the single-slot
      // rejection semantics.
      await sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
      return
    }
    // Aggregate form — per §4.4 the aggregate form never rejects.
    // If the contract isn't synced there are no active slots to
    // refresh, so return early silently.
    const contractMeta = rootState.contracts?.[contractID]
    if (!contractMeta || !this.subscriptionSet.has(contractID)) {
      return
    }
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey || perKey.size === 0) return
    const slots = Array.from(perKey.values())
    await Promise.all(slots.map((slot) =>
      sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: 'load' })
        .catch(() => {})
    ))
  },

  // Public. See KV-REVAMPED §4.5. Resets a slot to its declared
  // default by writing the wrapper `{ __chelKvNonce, value: null }`
  // through the per-contract serial queue via `chelonia/kv/set`. The inner
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
  // `chelonia/kv/update`. Other errors from `chelonia/kv/set` (called
  // directly inside the per-contract queue; not via `queuedSet`)
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
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'clear')
    throwIfSignalAborted(signal)
    // Track on the pending-writes counter (see `update` / `_waitInFlight`).
    incrementPending(this, contractID)
    const attemptNonces: string[] = []
    let lastEtag: string | null | undefined
    let sawConflict = false
    const onconflict = async ({
      etag
    }: {
      currentData?: JSONType;
      etag?: string | null;
    }): Promise<[JSONType, string | undefined]> => {
      lastEtag = etag
      sawConflict = true
      throwIfSignalAborted(signal)
      const retryNonce = base64Nonce()
      attemptNonces.push(retryNonce)
      recordEchoNonce(this, contractID, key, retryNonce)
      return [{ __chelKvNonce: retryNonce, value: null }, typeof etag === 'string' ? etag : undefined] as [JSONType, string | undefined]
    }
    const queued = sbp('chelonia/queueInvocation', contractID, async () => {
      throwIfSignalAborted(signal)
      const liveState = sbp(this.config.stateSelector) as ChelRootState
      if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
        throw new ChelErrorKvSlotUnknown(
            `[chelonia/kv] clear: no active slot for ${contractID}::${key}`
        )
      }
      const nonce = base64Nonce()
      attemptNonces.push(nonce)
      recordEchoNonce(this, contractID, key, nonce)
      const mirrorEtag = liveState._kv?.[contractID]?.[key]?.etag ?? undefined
      let setResult: { etag: string | null }
      try {
        // Resolve key IDs inside the queue so rotations that landed
        // before this clear are seen; they stay fixed for kv/set's retries.
        setResult = await sbp('chelonia/kv/set', contractID, key,
          { __chelKvNonce: nonce, value: null },
          {
            ifMatch: mirrorEtag,
            encryptionKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName),
            signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName),
            onconflict,
            maxAttempts,
            signal
          }
        ) as { etag: string | null }
      } catch (e) {
        if (e instanceof ChelErrorKvMaxAttempts) {
          removeEchoNonces(this, contractID, key, attemptNonces)
          const cause = kvConflictCause(e)
          throw new ChelErrorKvConflict(
              `[chelonia/kv] clear: ${contractID}::${key} ran out of attempts ` +
              'resolving conflicts',
              { cause: { currentData: null, etag: cause?.etag ?? lastEtag ?? null } }
          )
        }
        removeEchoNonces(this, contractID, key, attemptNonces)
        throw e
      }
      // Post-write abort guard (§4.2): the network write succeeded, but the
      // caller's signal was aborted mid-flight. The mirror must remain unchanged;
      // no event fires. Remove only this call's nonces so the pubsub echo
      // reconciles the mirror as reason: 'remote' without corrupting a
      // concurrent write's echo suppression.
      try {
        throwIfSignalAborted(signal)
      } catch (e) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        throw e
      }
      // Staleness guard: remove this call's nonces so the echo reaches the current slot.
      if (this.kvSlotsByContractID.get(contractID)?.get(key) !== slot) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        return
      }
      const perContract = ensureContractKv(this, liveState, contractID)
      const entry = perContract[key]
      if (!entry) {
        removeEchoNonces(this, contractID, key, attemptNonces)
        // Reconcile dropped the slot mid-write — nothing to mirror into.
        return
      }
      const previousValue = entry.value
      const defaultClone = slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
      this.config.reactiveSet(entry, 'value', defaultClone)
      this.config.reactiveSet(entry, 'etag', setResult.etag)
      if (sawConflict) {
        const successfulNonce = attemptNonces[attemptNonces.length - 1]
        this.kvLocalWriteAwaitingRemote.add(`${contractID}::${key}::${successfulNonce}`)
      }
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
          this, liveState, contractID, slot.contractType, key, 'non-init'
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
    }) as Promise<void>
    return queued.finally(() => {
      decrementPending(this, contractID)
    })
  },

  // Public. See KV-REVAMPED §4.6. Reports the load state of a slot,
  // or the aggregate state of an entire contract.
  //
  // Aggregate form (no `key`): reduces across every slot active for
  // `contractID` with precedence `error > loading > non-init > loaded`.
  // Returns `'non-init'` if no slots are active for the contract.
  //
  // Single form: reads the slot's `status` from the mirror. Returns
  // `'non-init'` if the mirror entry hasn't been seeded yet. Unlike
  // `read`/`update`/`sync`/`clear`, `status` does NOT reject on an
  // unknown or inactive slot — it returns `'non-init'`. This matches
  // the consumer pattern of "render a status badge regardless of
  // whether the slot is actually wired" without needing try/catch
  // around the call.
  'chelonia/kv/status': function (
    this: CheloniaContext,
    contractID: string,
    key?: string
  ): KvLoadStatus {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (key !== undefined) {
      // Use the active index to verify the slot is active, but fall
      // back to `'non-init'` instead of throwing — status is a query,
      // not a command.
      const active = this.kvSlotsByContractID.get(contractID)?.has(key)
      if (!active) return 'non-init'
      const entry = rootState._kv?.[contractID]?.[key]
      return entry?.status ?? 'non-init'
    }
    // Aggregate: precedence error > loading > non-init > loaded.
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey || perKey.size === 0) return 'non-init'
    const perContract = rootState._kv?.[contractID]
    let sawLoading = false
    let sawNonInit = false
    for (const slotKey of perKey.keys()) {
      const status = perContract?.[slotKey]?.status ?? 'non-init'
      if (status === 'error') return 'error'
      if (status === 'loading') sawLoading = true
      else if (status === 'non-init') sawNonInit = true
    }
    if (sawLoading) return 'loading'
    if (sawNonInit) return 'non-init'
    return 'loaded'
  },

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
      sbp('chelonia/kv/_defineSlotInternal', {
        ...entry,
        contractType: manifest,
        key
      }, { kind: 'defineContract' as const, manifest })
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
      // Only unregister the current registry entry if it was registered by
      // this manifest's defineContract call. A standalone defineSlot that
      // replaced the manifest entry after registration must survive; earlier
      // standalone definitions overwritten by the manifest entry are not restored.
      if (!slot.source) continue
      if (slot.source.kind !== 'defineContract') continue
      if (slot.source.manifest !== manifest) continue
      this.kvSlots.delete(rKey)
      // Scrub every per-contract index entry pointing at this slot.
      for (const [cID, perKey] of this.kvSlotsByContractID) {
        if (perKey.get(key) !== slot) continue
        perKey.delete(key)
        const contractEmptied = perKey.size === 0
        if (contractEmptied) this.kvSlotsByContractID.delete(cID)
        const filter = this.kvActiveFilters.get(cID)
        if (filter?.has(key)) {
          filter.delete(key)
          queueFilterFlush(this, cID)
        }
        if (contractEmptied) this.kvActiveFilters.delete(cID)
        const perContract = rootState._kv?.[cID]
        if (perContract && perContract[key]) {
          this.config.reactiveDel(perContract, key)
        }
        this.kvLocalEchoNonces.delete(`${cID}::${key}`)
      }
    }
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
      const contractType = getContractType(rootState, cID)
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
// Successful re-validations transition back to `'loaded'`, emit
// `CHELONIA_KV_UPDATED` with `reason: 'load'`, and fire `onUpdate`
// — so listeners observing transitions out of `'error'` can react.
function revalidateMirrorEntry (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  slot: SlotDefinition
): void {
  const entry = rootState._kv?.[contractID]?.[slot.key]
  if (!entry || entry.value === undefined) return
  const previousValue = entry.value
  try {
    const parsed = slot.schema
      ? parseSyncSlotValue(slot, previousValue, `re-validate ${contractID}::${slot.key}`)
      : assertJsonShape(previousValue, `re-validate ${contractID}::${slot.key}`)
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
    // Fire onUpdate matching the normal `'load'` path (§4.1).
    // safeOnUpdate catches errors internally, so fire-and-forget
    // is safe from the synchronous defineSlot call site.
    safeOnUpdate(slot, parsed, {
      contractID,
      contractType: slot.contractType,
      key: slot.key,
      reason: 'load',
      etag: entry.etag,
      previousValue
    })
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
