// KV slot API — see KV-REVAMPED.md for the full design.
//
// This module implements the declarative KV slot API layered on top of
// the `chelonia/kv/{set,get,setFilter}` primitives. It also hooks into
// `chelonia/reset` (via `_waitInFlight`), `chelonia/defineContract`
// (via `_registerContractSlots` / `_cleanupContractSlots`), and the
// pubsub reconnect / KV-notification paths in `chelonia.ts`.

import '@sbp/okturtles.events'
import sbp from '@sbp/sbp'
import { cloneDeep, deepEqualJSONType, has } from 'turtledash'
import {
  ChelErrorKvConflict,
  ChelErrorKvSlotInvalid,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorKvValidation,
  ChelErrorUnexpected,
  isKvConflict,
  isKvHeightAhead,
  kvHeightAheadCause
} from './errors.js'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
import { isKvMaxAttempts } from './internal-errors.js'
import { assertMaxAttempts, assertNotReentrant, resolveKvKeyIds } from './kv-checks.js'
import {
  abortable,
  abortReason,
  composeSignals,
  heightAheadError,
  kvHeightTimings,
  localHeight,
  notifyContractHeight,
  onHeight,
  recoverContractHeight,
  resolveRecoveryOptions,
  waitForHeight,
  withHeightRecovery,
  type ComposedAbortSignal
} from './kv-height.js'
import {
  KV_AUTO_LOAD,
  KV_DEFAULT_ENCRYPTION_KEY_NAME,
  KV_DEFAULT_SIGNING_KEY_NAME,
  KV_ECHO_CID_MAX,
  KV_ECHO_TTL_MS,
  KV_FILTER_RETRY_MS,
  KV_KEY_SEPARATOR,
  KV_LOAD_STATUS,
  KV_NOOP,
  KV_NOOP_ABORT_ERROR_NAME,
  KV_NOOP_ABORT_SYMBOL,
  KV_UPDATE_REASON,
  KV_VALIDATION_REASON_REVALIDATE
} from './kv-constants.js'
import type {
  ChelKvGetResult,
  CheloniaContext,
  ChelRootState,
  JSONType,
  KvConflictCause,
  KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions,
  KvHeightWait,
  KvLoadStatus,
  KvMirrorEntry,
  KvSlotDefinition,
  KvUpdateCtx,
  KvUpdater,
  ParsedEncryptedOrUnencryptedMessage,
  SlotDefinition,
  SlotDefinitionSource
} from './types.js'

// Internal sentinel thrown by the onconflict callback when the reducer
// returns KV_NOOP. The outer catch checks for the Symbol.for marker via
// `in` (not `instanceof`) so a KvNoopAbort created by another loaded
// copy of this module — e.g. the dual ESM/CJS build of @chelonia/lib in
// the same realm — is still recognised. The class is not exported and
// only this module's onconflict path attaches the marker; it is not a
// general cross-realm error-bridging mechanism.
class KvNoopAbort extends Error {
  override name = KV_NOOP_ABORT_ERROR_NAME
}
// Realm-safe marker: Symbol.for survives dual ESM/CJS loads.
// Checked on the catch side instead of `instanceof`.
;(KvNoopAbort.prototype as unknown as Record<symbol, boolean>)[KV_NOOP_ABORT_SYMBOL] = true

// ---------------------------------------------------------------------------
// Internal helpers (pure — no SBP context required)
// ---------------------------------------------------------------------------

type KvLoadReason = Exclude<KvUpdateCtx['reason'], typeof KV_UPDATE_REASON.LOCAL>
type SettledStatus = Exclude<KvLoadStatus, typeof KV_LOAD_STATUS.LOADING>

// Echo-CID TTL clock. Deliberately `performance.now()` (monotonic)
// rather than the spec's `Date.now()`: it is immune to wall-clock / NTP
// adjustments, so a backwards clock step can never prematurely expire a
// pending self-echo and let a write's own echo regress the mirror. The
// only tradeoff is that backgrounded/throttled tabs may advance it
// slowly, extending the effective TTL — which merely makes echo
// suppression more conservative and never drops a real frame early.
// Both record and check use this same source, so TTL accounting stays
// internally consistent.
const defaultNowMs = (): number => performance.now()
let nowMs = defaultNowMs

// Backoff before retrying a transiently-failed `setFilter` flush. Held
// in a mutable module-level binding (mirroring `nowMs`) so tests can
// shrink it to 0 via `chelonia/kv/_testSetFilterRetryMs` and exercise
// the retry deterministically without a real 2 s wait.
let filterRetryMs = KV_FILTER_RETRY_MS

// Maximum nesting depth accepted by `assertJsonShape`. Guards against
// pathological (e.g. circular) values that a buggy or malicious schema
// could produce from `schema.parse`, which would otherwise infinite-loop
// the recursive walker and hang the realm. 1000 is well above any
// legitimate JSON value while keeping the recursion stack bounded.
const MAX_JSON_DEPTH = 1000

const registryKey = (contractType: string, key: string): string =>
  `${contractType}${KV_KEY_SEPARATOR}${key}`

// Resolve a public `KvSlotDefinition` into its internal `SlotDefinition`
// form. `contractType` arrays are flattened by the caller; this helper
// produces one `SlotDefinition` per (already-singular) `contractType`.
//
// The `defaultValue` factory is invoked exactly once in
// `_defineSlotInternal` (before the per-type loop); the resolved result
// is passed in as `resolvedDefault`. Per the KV-REVAMPED §4.1 contract,
// factories run at registration time and the result is what every
// subsequent reader sees.
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
    encryptionKeyName: def.encryptionKeyName === null
      ? null
      : def.encryptionKeyName ?? KV_DEFAULT_ENCRYPTION_KEY_NAME,
    signingKeyName: def.signingKeyName ?? KV_DEFAULT_SIGNING_KEY_NAME,
    defaultUpdater: def.defaultUpdater,
    autoSubscribe: def.autoSubscribe ?? true,
    autoLoad: def.autoLoad ?? KV_AUTO_LOAD.ON_SYNC,
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
    assertJsonShape(
      value,
      `defineSlot defaultValue ${pass} parse ${slot.contractType}::${slot.key}`
    )
  } catch (e) {
    throw new ChelErrorKvSlotInvalid(
      `[chelonia/kv] slot ${slot.contractType}::${slot.key} schema.parse ` +
      'produced an invalid defaultValue (reserved sentinel or non-JSON value)',
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
    if (!deepEqualJSONType(first, second)) {
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
// that escaped the registration-time async probe.
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
  return assertJsonShape(parsed, where)
}

function assertJsonShape (input: unknown, where: string): JSONType {
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} exceeded max depth (possible circular reference)`
      )
    }
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
    if (t !== 'object') {
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} has non-JSON type ${t}`
      )
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], `${path}[${i}]`, depth + 1)
      return
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ChelErrorKvValidation(
        `[chelonia/kv] ${where}: ${path} has non-plain object prototype`
      )
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(v, `${path}.${k}`, depth + 1)
    }
  }
  visit(input, 'value', 0)
  return input as JSONType
}

// Compute the reducer seed for `chelonia/kv/update`:
//  - `reloadRan`: the mirror pairs the reloaded (or kept) value with the
//    etag the write sends, so seed from it; the default only if `undefined`.
//  - otherwise: the normal happy path — seed from a non-error live
//    value, else the default (mirrors `read`'s error semantics for a
//    genuinely empty / errored slot).
function computeSeedValue (
  slot: SlotDefinition,
  mirrorEntry: KvMirrorEntry | undefined,
  reloadRan: boolean
): JSONType | undefined {
  const useMirror = reloadRan || (
    mirrorEntry != null &&
    mirrorEntry.status !== KV_LOAD_STATUS.ERROR &&
    mirrorEntry.value !== undefined
  )
  if (useMirror && mirrorEntry?.value !== undefined) {
    return cloneDeep(mirrorEntry.value as JSONType)
  }
  return slot.resolvedDefault !== undefined
    ? cloneDeep(slot.resolvedDefault)
    : undefined
}

// Validate the output of a reducer in `chelonia/kv/update`. Shared by
// the first-attempt path and the `onconflict` retry path so the symbol,
// null/undefined, and schema/shape checks cannot drift apart. `context`
// (e.g. `''` or `'on retry'`) is interpolated into the error messages.
//
// Returns `{ noop: true }` for `KV_NOOP` so each call site can apply its
// own semantics (the first attempt resolves with `undefined`; a retry
// throws `KvNoopAbort` to unwind the `kv/set` loop). All other invalid
// outputs reject with `ChelErrorKvUpdateInvalid` (reducer-contract
// violations) or `ChelErrorKvValidation` (schema/shape failures).
//
// Note on wrapping: `assertJsonShape` and `parseSyncSlotValue` throw
// `ChelErrorKvValidation` for their own structural checks, but a custom
// schema's `.parse` may throw an arbitrary error. The `try/catch` below
// normalizes both into `ChelErrorKvValidation` so a reducer-output
// validation failure is always the same error class regardless of
// whether the slot is schema-backed (§4.2 taxonomy).
function validateReducerOutput (
  slot: SlotDefinition,
  output: unknown,
  contractID: string,
  key: string,
  context: string
): { noop: true } | { noop: false, value: JSONType } {
  const ctx = context ? ` ${context}` : ''
  const where = `update${ctx} ${contractID}::${key}`
  if (typeof output === 'symbol') {
    if (output === KV_NOOP) return { noop: true }
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
      `an unexpected symbol${ctx}; use KV_NOOP to abort`
    )
  }
  if (output === null || output === undefined) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] update: ${contractID}::${key} reducer returned ` +
      `${String(output)}${ctx}; use chelonia/kv/clear or KV_NOOP instead`
    )
  }
  try {
    const value = slot.schema
      ? parseSyncSlotValue(slot, output, where)
      : assertJsonShape(output, where)
    return { noop: false, value }
  } catch (e) {
    // `assertJsonShape` / `parseSyncSlotValue` throw `ChelErrorKvValidation`
    // for their own structural checks, and a custom schema's `.parse` may
    // throw an arbitrary error. Normalize both into one message so a
    // reducer-output validation failure is always the same class and text
    // regardless of whether the slot is schema-backed (§4.2 taxonomy); the
    // structural detail is preserved on `cause`.
    throw new ChelErrorKvValidation(
      `[chelonia/kv] update: ${contractID}::${key} reducer output ` +
      `failed validation${ctx}`,
      { cause: e }
    )
  }
}

// Ensure `rootState._kv[contractID]` exists as a reactive object. Returns
// the per-contract record. Idempotent.
//
// PRECONDITION: callers MUST have already verified an active slot /
// subscription for `contractID` — this helper CREATES the
// `_kv[contractID]` record if absent, so calling it for a contract with
// no active slots would leave an orphaned, never-cleaned-up empty record
// in persisted state. A read-only caller that must not create the record
// should follow `patchEntry`'s non-destructive pattern
// (`rootState._kv?.[contractID]?.[key]`) instead.

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

type EntryPatch = {
  status?: KvLoadStatus;
  lastError?: { name: string; message: string };
  settled?: boolean;
  // `null` clears the marker
  heightAhead?: number | null;
}

// The only writer of an entry's status fields; one `CHELONIA_KV_STATUS_CHANGED`
// if any changed. `lastError` exists exactly while the status is `'error'`.
function patchEntry (
  ctx: CheloniaContext,
  contractID: string,
  slot: Pick<SlotDefinition, 'contractType' | 'key'>,
  patch: EntryPatch
): void {
  const { contractType, key } = slot
  // Read without creating `_kv[contractID]` (see `ensureContractKv`)
  const entry = (sbp(ctx.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[key]
  if (!entry) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(`[chelonia/kv] status patch for unseeded ${contractID}::${key}`)
    }
    return
  }
  const previousStatus = entry.status
  const previousError = entry.lastError
  const previousSettled = entry.settled === true
  const previousHeight = entry.heightAhead?.requiredHeight
  const status = patch.status ?? previousStatus
  const lastError = status === KV_LOAD_STATUS.ERROR ? patch.lastError ?? previousError : undefined
  const settled = patch.settled ?? previousSettled
  const height = patch.heightAhead === undefined ? previousHeight : patch.heightAhead ?? undefined
  const errorChanged = lastError?.name !== previousError?.name ||
    lastError?.message !== previousError?.message
  const { config } = ctx
  const fields = entry as unknown as Record<string, unknown>
  if (entry.settled !== settled) config.reactiveSet(entry, 'settled', settled)
  if (status === previousStatus && !errorChanged && settled === previousSettled &&
      height === previousHeight) return
  if (status !== previousStatus) config.reactiveSet(entry, 'status', status)
  if (errorChanged) {
    if (lastError) config.reactiveSet(entry, 'lastError', lastError)
    else config.reactiveDel(fields, 'lastError')
  }
  if (height !== previousHeight) {
    if (height === undefined) config.reactiveDel(fields, 'heightAhead')
    else config.reactiveSet(entry, 'heightAhead', { requiredHeight: height })
  }
  sbp('okTurtles.events/emit', CHELONIA_KV_STATUS_CHANGED, {
    contractID,
    contractType,
    key,
    status,
    previousStatus,
    lastError: lastError ?? null,
    settled,
    previousSettled,
    heightAhead: height === undefined ? null : { requiredHeight: height }
  })
  const waitKey = `${contractID}${KV_KEY_SEPARATOR}${key}`
  const waiters = ctx.kvSettleWaiters.get(waitKey)
  const settledStatus = waiters && settledStatusOf(ctx, contractID, key)
  if (settledStatus) {
    ctx.kvSettleWaiters.delete(waitKey)
    for (const waiter of waiters) waiter.resolve(settledStatus)
  }
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

// A load that never ran, or a height that never came, still ends the wait for a
// first outcome; a value in the mirror stays usable, a verified outcome stays.
function settleUnloaded (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  error: unknown,
  { replaceError = false } = {}
): void {
  const entry = (sbp(ctx.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[slot.key]
  if (!entry || !slotIsCurrent(ctx, contractID, slot)) return
  const replace = replaceError && entry.status === KV_LOAD_STATUS.ERROR && entry.value === undefined
  if (entry.settled && entry.status !== KV_LOAD_STATUS.LOADING && !replace) return
  patchEntry(ctx, contractID, slot, entry.value !== undefined
    ? { settled: true }
    : { status: KV_LOAD_STATUS.ERROR, lastError: normalizeError(error), settled: true })
}

// A load that found a value from a newer height is deferred, not failed
function logLoadRejection (message: string, e: unknown): void {
  console[isKvHeightAhead(e) ? 'debug' : 'error'](`[chelonia/kv] ${message}`, e)
}

const waitKeyOf = (contractID: string, key: string): string =>
  `${contractID}${KV_KEY_SEPARATOR}${key}`

const heightReached = (ctx: CheloniaContext, wait: KvHeightWait): boolean =>
  (localHeight(ctx, wait.contractID) ?? -1) >= wait.requiredHeight

function dropHeightWait (ctx: CheloniaContext, wait: KvHeightWait): void {
  clearTimeout(wait.timer)
  wait.off()
  const waitKey = waitKeyOf(wait.contractID, wait.key)
  if (ctx.kvHeightWaits.get(waitKey) === wait) ctx.kvHeightWaits.delete(waitKey)
}

// Leaves the entries' `heightAhead` markers as they are
function cancelHeightWaits (ctx: CheloniaContext, contractID: string, key?: string): void {
  for (const wait of ctx.kvHeightWaits.values()) {
    if (wait.contractID === contractID && (key ?? wait.key) === wait.key) dropHeightWait(ctx, wait)
  }
}

function armHeightFallback (ctx: CheloniaContext, wait: KvHeightWait): void {
  clearTimeout(wait.timer)
  wait.timer = setTimeout(() => {
    heightWaitFallback(ctx, wait).catch((e: unknown) => {
      console.error(`[chelonia/kv] Height wait for ${wait.contractID}::${wait.key} failed`, e)
    })
  }, kvHeightTimings.pendingFallbackMs)
  ;(wait.timer as unknown as { unref?: () => void }).unref?.()
}

// The server holds a value for the slot from contract height `requiredHeight`:
// reload the key once the contract gets there
function registerHeightWait (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  requiredHeight: number,
  reason: KvLoadReason
): void {
  const entry = (sbp(ctx.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[slot.key]
  if (!entry || !slotIsCurrent(ctx, contractID, slot)) return
  const waitKey = waitKeyOf(contractID, slot.key)
  const wait: KvHeightWait = ctx.kvHeightWaits.get(waitKey) ??
    { contractID, key: slot.key, reason, requiredHeight: -1, gen: 0, off: () => {} }
  ctx.kvHeightWaits.set(waitKey, wait)
  wait.gen++
  if (requiredHeight > wait.requiredHeight) {
    wait.requiredHeight = requiredHeight
    wait.off()
    wait.off = () => {}
    // Reached since the value was found: reload now, nothing to mark
    if (heightReached(ctx, wait)) return fireHeightWait(ctx, wait)
    wait.off = onHeight(ctx, contractID, requiredHeight, () => fireHeightWait(ctx, wait))
  }
  if (!wait.timer) armHeightFallback(ctx, wait)
  patchEntry(ctx, contractID, slot, {
    heightAhead: Math.max(entry.heightAhead?.requiredHeight ?? -1, requiredHeight),
    status: entry.status === KV_LOAD_STATUS.NON_INIT ? KV_LOAD_STATUS.LOADING : undefined
  })
}

function fireHeightWait (ctx: CheloniaContext, wait: KvHeightWait): void {
  const { contractID, key, gen } = wait
  const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key)
  if (!slot) return dropHeightWait(ctx, wait)
  // The height came; a newer value found by the reload gets a full fallback period
  clearTimeout(wait.timer)
  wait.timer = undefined
  const reload: NonNullable<KvHeightWait['reload']> = {}
  wait.reload = reload
  const current = () =>
    ctx.kvHeightWaits.get(waitKeyOf(contractID, key)) === wait && wait.reload === reload
  reload.done = sbp('chelonia/kv/_loadSlot', {
    contractID, slot, reason: wait.reason, suppressLoadingStatus: true, stale: () => !current()
  }) as Promise<void>
  reload.done.catch((e: unknown) => {
    logLoadRejection(`deferred reload rejected for ${contractID}::${key}`, e)
  }).finally(() => {
    if (!current()) return
    // A reload that failed or never ran leaves the marker for `update` to see
    if (wait.gen === gen) return dropHeightWait(ctx, wait)
    wait.reload = undefined
    // A fallback that ran during the reload left this newer finding to it
    if (!wait.timer) armHeightFallback(ctx, wait)
  })
}

const aheadOf = (ctx: CheloniaContext, { contractID, key, requiredHeight }: KvHeightWait) =>
  heightAheadError(ctx, contractID, key, {
    requiredHeight, exact: true, etag: null, httpStatus: 200
  })

// Settles the slot without the value. The wait keeps listening.
function giveUpHeightWait (ctx: CheloniaContext, wait: KvHeightWait): void {
  clearTimeout(wait.timer)
  wait.timer = undefined
  const { contractID, key } = wait
  const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key)
  if (!slot) return dropHeightWait(ctx, wait)
  console.warn(
    `[chelonia/kv] ${contractID}::${key}: settling without the server value, ` +
      `which needs contract height ${wait.requiredHeight}`
  )
  settleUnloaded(ctx, contractID, slot, aheadOf(ctx, wait), { replaceError: true })
}

// Syncs the contract once, then gives up if that didn't bring the height
async function heightWaitFallback (ctx: CheloniaContext, wait: KvHeightWait): Promise<void> {
  wait.timer = undefined
  const { contractID, key } = wait
  const { signal } = ctx.abortController
  await recoverContractHeight(ctx, contractID, aheadOf(ctx, wait), { signal }).catch(() => {})
  // Findings during the sync don't postpone giving up
  if (ctx.kvHeightWaits.get(waitKeyOf(contractID, key)) !== wait || wait.reload) return
  // `chelonia/reset` drops the waits once it tears down
  if (ctx.kvResetsInProgress) return armHeightFallback(ctx, wait)
  if (heightReached(ctx, wait)) return fireHeightWait(ctx, wait)
  giveUpHeightWait(ctx, wait)
}

type HeightWaitSnapshot = { wait?: KvHeightWait; gen?: number }

const heightWaitSnapshot = (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): HeightWaitSnapshot => {
  const wait = ctx.kvHeightWaits.get(waitKeyOf(contractID, key))
  return { wait, gen: wait?.gen }
}

// A verified empty outcome doesn't make a slot "empty" while the server is
// known to hold a newer value: it stays `loading`, with the fallback armed
function emptyStatus (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): typeof KV_LOAD_STATUS.LOADING | typeof KV_LOAD_STATUS.NON_INIT {
  const wait = ctx.kvHeightWaits.get(waitKeyOf(contractID, key))
  if (!wait) return KV_LOAD_STATUS.NON_INIT
  if (!wait.timer && !wait.reload) armHeightFallback(ctx, wait)
  return KV_LOAD_STATUS.LOADING
}

// For a load or write that verified the value: the wait it saw at its start
// is moot, but one for a value found since keeps an empty slot pending
function settleVerified (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  seen: HeightWaitSnapshot,
  status: typeof KV_LOAD_STATUS.LOADED | typeof KV_LOAD_STATUS.NON_INIT
): void {
  const wait = ctx.kvHeightWaits.get(waitKeyOf(contractID, slot.key))
  const remaining = wait && (wait !== seen.wait || wait.gen !== seen.gen) ? wait : undefined
  if (wait && !remaining) dropHeightWait(ctx, wait)
  if (!remaining) {
    return patchEntry(ctx, contractID, slot, { status, settled: true, heightAhead: null })
  }
  patchEntry(ctx, contractID, slot, {
    status: status === KV_LOAD_STATUS.NON_INIT ? emptyStatus(ctx, contractID, slot.key) : status,
    settled: true
  })
}

// Whether the server is known to hold a value for the key that the mirror
// may lack (being loaded, or from a height the contract hadn't reached)
function basisUnverified (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  entry: KvMirrorEntry
): boolean {
  return entry.status === KV_LOAD_STATUS.LOADING || entry.heightAhead != null ||
    ctx.kvHeightWaits.has(waitKeyOf(contractID, key)) ||
    (entry.status === KV_LOAD_STATUS.ERROR && entry.value === undefined &&
      isKvHeightAhead(entry.lastError))
}

// Status for consumers that must tell "empty" from "not known yet":
// `undefined` until the active slot has settled, and while it reloads.
function settledStatusOf (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): SettledStatus | undefined {
  if (!ctx.kvSlotsByContractID.get(contractID)?.has(key)) return
  const entry = (sbp(ctx.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[key]
  if (entry?.settled && entry.status !== KV_LOAD_STATUS.LOADING) return entry.status
}

// Whether a slot may still activate for `key`: one for the contract's type,
// or for any type while the contract's type isn't known
function slotDefinedFor (ctx: CheloniaContext, contractID: string, key: string): boolean {
  const contractType = getContractType(sbp(ctx.config.stateSelector), contractID)
  if (contractType !== undefined) return ctx.kvSlots.has(registryKey(contractType, key))
  for (const slot of ctx.kvSlots.values()) if (slot.key === key) return true
  return false
}

function rejectSettleWaits (ctx: CheloniaContext, waitKey: string, why: string): void {
  const waiters = ctx.kvSettleWaiters.get(waitKey)
  if (!waiters) return
  ctx.kvSettleWaiters.delete(waitKey)
  const error = new ChelErrorKvSlotUnknown(`[chelonia/kv] whenSettled: ${waitKey} ${why}`)
  for (const waiter of waiters) waiter.reject(error)
}

// Rejects the `whenSettled` calls waiting on a pair for which `ends` holds
function endSettleWaits (
  ctx: CheloniaContext,
  ends: (contractID: string, key: string) => boolean,
  why: string
): void {
  for (const waitKey of ctx.kvSettleWaiters.keys()) {
    const at = waitKey.indexOf(KV_KEY_SEPARATOR)
    if (ends(waitKey.slice(0, at), waitKey.slice(at + KV_KEY_SEPARATOR.length))) {
      rejectSettleWaits(ctx, waitKey, why)
    }
  }
}

// Ends the waits (of `contractID` only, if given) that no slot can settle
const endUndefinedSettleWaits = (ctx: CheloniaContext, contractID?: string): void =>
  endSettleWaits(ctx, (cID, key) =>
    (contractID === undefined || cID === contractID) && !slotDefinedFor(ctx, cID, key),
  "has no slot for its contract's type")

// Drops a key's mirror entry, and the contract's record once its last key is
// gone so that an emptied `{}` doesn't linger in persisted state
function dropEntry (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  key: string
): void {
  const perContract = rootState._kv?.[contractID]
  if (perContract?.[key]) ctx.config.reactiveDel(perContract, key)
  if (perContract && Object.keys(perContract).length === 0) {
    ctx.config.reactiveDel(rootState._kv!, contractID)
  }
  ctx.kvLocalEchoCIDs.delete(`${contractID}${KV_KEY_SEPARATOR}${key}`)
  cancelHeightWaits(ctx, contractID, key)
}

// Activates the matching slots of a contract once its type is known
function reconcileContract (ctx: CheloniaContext, contractID: string): void {
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  if (!rootState.contracts?.[contractID]) return
  const contractType = getContractType(rootState, contractID)
  if (!contractType) return
  for (const slot of ctx.kvSlots.values()) {
    if (slot.contractType === contractType) sbp('chelonia/kv/_reconcileForSlot', slot, contractID)
  }
  if (!ctx.subscriptionSet.has(contractID)) return
  ctx.kvReconciledContracts.add(contractID)
  // Entries kept through a resync whose slot was unregistered meanwhile
  if (ctx.kvResyncedContracts.delete(contractID)) {
    const active = ctx.kvSlotsByContractID.get(contractID)
    for (const key of Object.keys(rootState._kv?.[contractID] ?? {})) {
      if (!active?.has(key)) dropEntry(ctx, rootState, contractID, key)
    }
  }
  endUndefinedSettleWaits(ctx, contractID)
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

function purgeExpiredEchoCIDs (ctx: CheloniaContext, echoKey: string, now = nowMs()): void {
  const cids = ctx.kvLocalEchoCIDs.get(echoKey)
  if (!cids) return
  for (const [cid, entry] of cids) {
    if (entry.expiry <= now) cids.delete(cid)
  }
  if (cids.size === 0) ctx.kvLocalEchoCIDs.delete(echoKey)
}

// Track a server-issued data CID for self-echo suppression.
function recordEchoCID (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  cid: string | null | undefined,
  fromConflict: boolean
): void {
  if (typeof cid !== 'string' || cid.length === 0) return
  const echoKey = `${contractID}${KV_KEY_SEPARATOR}${key}`
  const now = nowMs()
  purgeExpiredEchoCIDs(ctx, echoKey, now)
  let cids = ctx.kvLocalEchoCIDs.get(echoKey)
  if (!cids) {
    cids = new Map()
    ctx.kvLocalEchoCIDs.set(echoKey, cids)
  }
  cids.set(cid, { expiry: now + KV_ECHO_TTL_MS, fromConflict })
  if (cids.size > KV_ECHO_CID_MAX) {
    const targets = Array.from(cids.entries())
      // Never evict the entry we just recorded: under a pathological
      // burst of conflict markers (a full bucket of `fromConflict:
      // true`), the sort below would rank this fresh non-conflict CID
      // ahead of them and slice it off immediately — so the current
      // write's own echo would arrive unsuppressed. Excluding `cid`
      // guarantees this write can always be self-echo-suppressed. The
      // eviction still brings the bucket back to the cap, but the
      // victim may be a conflict marker (the earliest-expiry one)
      // rather than the fresh CID — the right tradeoff, since an
      // unsuppressed self-echo is a definite bug while a lost conflict
      // marker only risks a self-healing last-write-wins regression
      // under a scenario the cap itself calls "not expected in normal
      // operation."
      .filter(([entryCID]) => entryCID !== cid)
      .sort((a, b) => {
        // Evict non-conflict entries before conflict markers: dropping a
        // `fromConflict` marker would let a competing frame regress the
        // mirror via last-write-wins. Within a class, evict earliest
        // expiry first.
        if (a[1].fromConflict !== b[1].fromConflict) {
          return a[1].fromConflict ? 1 : -1
        }
        return a[1].expiry - b[1].expiry
      })
      .slice(0, cids.size - KV_ECHO_CID_MAX)
    for (const [tCID] of targets) cids.delete(tCID)
  }
}

// Held by each `update` / `clear` call until it settles: `_waitInFlight`'s third
// source, for writes whose slot and echo CID were dropped mid-flight.
function incrementPending (ctx: CheloniaContext, contractID: string): void {
  ctx.kvPendingWrites.set(contractID, (ctx.kvPendingWrites.get(contractID) ?? 0) + 1)
}

function decrementPending (ctx: CheloniaContext, contractID: string): void {
  const n = (ctx.kvPendingWrites.get(contractID) ?? 1) - 1
  if (n <= 0) ctx.kvPendingWrites.delete(contractID)
  else ctx.kvPendingWrites.set(contractID, n)
}

// Per-contract pending-load counter. Incremented by both `_loadSlot`
// (on schedule, to cover the queued-but-not-started window) and
// `_loadSlotNow` (on entry, to cover direct callers like `_handleRemote`
// and `update`'s reload). A load that flows `_loadSlot` →
// `_loadSlotNow` therefore increments twice for one logical operation;
// this is intentional — the only consumer is `defineSlot`'s `> 0` gate,
// so the inflation is harmless. Do NOT rely on the exact count for
// "exactly one load in flight" assertions or telemetry.
// `defineSlot`'s post-reconcile gate consults it so a slot replaced
// while a load is queued-but-not-started (status still `loaded`, so the
// `unloaded` check misses it) schedules a fresh load for the replacement
// rather than revalidating a value the superseded load is about to
// discard at its staleness guard.
function incrementPendingLoad (ctx: CheloniaContext, contractID: string): void {
  ctx.kvPendingLoads.set(contractID, (ctx.kvPendingLoads.get(contractID) ?? 0) + 1)
}

function decrementPendingLoad (ctx: CheloniaContext, contractID: string): void {
  const n = (ctx.kvPendingLoads.get(contractID) ?? 1) - 1
  if (n <= 0) ctx.kvPendingLoads.delete(contractID)
  else ctx.kvPendingLoads.set(contractID, n)
}

type NormalizedKvConflictData =
  | { present: false }
  | { present: true; currentData: JSONType | undefined }

function kvConflictCause (e: unknown): KvConflictCause | undefined {
  const cause = (e as { cause?: unknown })?.cause
  return cause && typeof cause === 'object' ? cause as KvConflictCause : undefined
}

function normalizeKvConflictCurrentData (
  slot: SlotDefinition,
  contractID: string,
  key: string,
  cause: KvConflictCause | undefined
): NormalizedKvConflictData {
  if (!cause || !has(cause, 'currentData')) return { present: false }
  const currentData = cause.currentData
  if (currentData === undefined) return { present: true, currentData: undefined }
  if (currentData === null) {
    return {
      present: true,
      currentData: slot.resolvedDefault !== undefined
        ? cloneDeep(slot.resolvedDefault)
        : undefined
    }
  }
  if (slot.schema) {
    return {
      present: true,
      currentData: parseSyncSlotValue(slot, currentData, `conflict cause ${contractID}::${key}`)
    }
  }
  return {
    present: true,
    currentData: assertJsonShape(currentData, `conflict cause ${contractID}::${key}`)
  }
}

// Invoke `onUpdate` with the dispatcher's MUST-NOT-throw contract (both
// synchronous throws and rejected promises are caught and logged — see
// KV-REVAMPED §4.1) while guarding against same-contract re-entrancy.
//
// Every `onUpdate` runs inside the per-contract `chelonia/queueInvocation`
// lane, which is held until the callback settles. A KV write selector
// (`update`/`clear`/`sync`) for the SAME contract invoked from inside the
// callback would enqueue behind the lane that is blocked awaiting the
// callback — a permanent deadlock. To turn that hang into a clear error,
// the write selectors reject with `ChelErrorKvReentrant` while
// `kvOnUpdateActive[contractID] > 0`.
//
// The flag is held ONLY for the callback's *synchronous* execution (up
// to its first `await`). During that window JS cannot interleave any
// other task, so a same-contract write observed then is provably a
// re-entrant call from inside `onUpdate` — never an independent caller.
// This catches the overwhelmingly common deadlock pattern
// (`onUpdate: () => sbp('chelonia/kv/update', …)` and
// `async () => { await sbp('chelonia/kv/update', …) }`, since the call
// expression is evaluated before the `await` suspends).
//
// The flag is deliberately NOT held across the callback's own awaits.
// Holding it there would falsely reject INDEPENDENT concurrent writes
// that merely interleave with a slow async `onUpdate` (they queue safely
// behind the lane and must succeed — head-of-line blocking, §4.1). The
// tradeoff is that a re-entrant write issued *after* an await inside
// `onUpdate` is not detected and still deadlocks — but that is exactly
// the pre-guard behaviour, so it is an unfixed rare edge, not a
// regression. The callback's returned promise is still awaited by the
// caller (inside the lane), preserving the documented blocking
// semantics. Keyed by `contractID` to match the lane granularity
// (cross-contract writes from `onUpdate` are never rejected).
async function safeOnUpdateGuarded (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  value: JSONType | undefined,
  uctx: KvUpdateCtx
): Promise<void> {
  if (!slot.onUpdate) return
  let ret: unknown
  ctx.kvOnUpdateActive.set(contractID, (ctx.kvOnUpdateActive.get(contractID) ?? 0) + 1)
  try {
    // Synchronous portion of the callback. Any same-contract write
    // issued here is re-entrant and is rejected by `assertNotReentrant`.
    ret = slot.onUpdate(value, uctx)
  } catch (e) {
    console.error(
      `[chelonia/kv] onUpdate threw for ${uctx.contractID}::${uctx.key}`,
      e
    )
    return
  } finally {
    // Clear the flag as soon as the synchronous portion returns (or
    // suspends at its first await), BEFORE awaiting the callback's
    // promise below — so independent concurrent writes are not rejected.
    const n = (ctx.kvOnUpdateActive.get(contractID) ?? 1) - 1
    if (n <= 0) ctx.kvOnUpdateActive.delete(contractID)
    else ctx.kvOnUpdateActive.set(contractID, n)
  }
  if (ret && typeof (ret as { then?: unknown }).then === 'function') {
    try {
      await ret
    } catch (e) {
      console.error(
        `[chelonia/kv] onUpdate threw for ${uctx.contractID}::${uctx.key}`,
        e
      )
    }
  }
}

function slotIsCurrent (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition
): boolean {
  return ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) === slot
}

// Defensive clone for values leaving the mirror via events / onUpdate.
// `chelonia/kv/read` already clones on the way out; event payloads and
// `onUpdate` arguments must too, so a listener mutating `event.value`
// (or a retained `previousValue`) cannot corrupt the live mirror or any
// reactive observer downstream. Primitives pass through untouched.
function cloneForEmit (v: JSONType | undefined): JSONType | undefined {
  return (v === null || typeof v !== 'object') ? v : cloneDeep(v)
}

type SlotWriteAttempt = {
  heightWaitMs: 0 | undefined;
  recoveries: number;
  // Aborted by the caller's signal or by `chelonia/reset`
  signal: AbortSignal;
}

// Height recoveries run off the lane, so each attempt queues `body` anew. Giving
// up on a value the contract can't verify yet reloads the key once it can.
async function runSlotWrite<T> (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  options: KvHeightRecoveryOptions,
  label: string,
  body: (attempt: SlotWriteAttempt) => Promise<T>
): Promise<T> {
  // Captured now, as `chelonia/reset` replaces the controller it aborts
  const signal: ComposedAbortSignal = options.signal
    ? composeSignals([ctx.abortController.signal, options.signal])
    : ctx.abortController.signal
  const { onHeightAhead, maxHeightRecoveries } = options
  let aheadAt: number | undefined
  incrementPending(ctx, contractID)
  try {
    return await withHeightRecovery(ctx, contractID, ({ heightWaitMs, recoveries, queue }) =>
      queue(() => body({ heightWaitMs, recoveries, signal })).catch((e: unknown) => {
        const cause = kvHeightAheadCause(e)
        aheadAt = cause?.exact ? cause.requiredHeight : undefined
        throw e
      }), { onHeightAhead, maxHeightRecoveries, signal }, label)
  } catch (e) {
    const conflict = isKvConflict(e) ? kvConflictCause(e) : undefined
    const requiredHeight = aheadAt ??
      (conflict?.currentStatus === 'ahead' ? conflict.requiredHeight : undefined)
    if (typeof requiredHeight === 'number') {
      registerHeightWait(ctx, contractID, slot, requiredHeight, KV_UPDATE_REASON.LOAD)
    }
    throw e
  } finally {
    signal._cleanup?.()
    decrementPending(ctx, contractID)
  }
}

// On a value from a contract height not reached yet, gives incoming events a
// chance to bring the height, then syncs the contract and loads again
async function syncSlot (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  options: KvHeightRecoveryOptions
): Promise<void> {
  const label = `sync: ${contractID}::${slot.key}`
  const { onHeightAhead, maxHeightRecoveries } = resolveRecoveryOptions(options, label)
  const signal: ComposedAbortSignal = options.signal
    ? composeSignals([ctx.abortController.signal, options.signal])
    : ctx.abortController.signal
  const waitKey = waitKeyOf(contractID, slot.key)
  // The key's wait after the last finding, and its reload from before that
  let found: HeightWaitSnapshot & { reload?: KvHeightWait['reload'] } = {}
  const load = async (suppressLoadingStatus: boolean): Promise<void> => {
    // Loading again would repeat a reload the wait fired since
    const fired = found.wait?.reload !== found.reload ? found.wait?.reload?.done : undefined
    const before = ctx.kvHeightWaits.get(waitKey)
    const reloadBefore = before?.reload
    try {
      await abortable(fired ?? sbp('chelonia/kv/_loadSlot', {
        contractID, slot, reason: KV_UPDATE_REASON.LOAD, suppressLoadingStatus
      }), signal)
    } catch (e) {
      if (isKvHeightAhead(e)) {
        const wait = ctx.kvHeightWaits.get(waitKey)
        found = { wait, gen: wait?.gen, reload: wait === before ? reloadBefore : undefined }
      }
      throw e
    }
  }
  try {
    await withHeightRecovery(ctx, contractID, async ({ recoveries }) => {
      try {
        await load(recoveries > 0)
      } catch (e) {
        const requiredHeight = kvHeightAheadCause(e)?.requiredHeight
        // Once this brings the height, recovery reloads without syncing;
        // a recovery sync already running is joined at once
        if (typeof requiredHeight === 'number' && onHeightAhead === 'sync' &&
            recoveries < Math.max(1, maxHeightRecoveries)) {
          const timeoutMs = ctx.kvRecoveries.has(contractID) ? 0 : undefined
          await waitForHeight(ctx, contractID, requiredHeight, { timeoutMs, signal })
        }
        throw e
      }
    }, { onHeightAhead, maxHeightRecoveries, signal }, label)
  } catch (e) {
    const requiredHeight = kvHeightAheadCause(e)?.requiredHeight
    if (onHeightAhead === 'reject' || typeof requiredHeight !== 'number') throw e
    if ((localHeight(ctx, contractID) ?? -1) >= requiredHeight) return await load(true)
    // Give up unless a load verified the key since, or found a newer value
    const wait = ctx.kvHeightWaits.get(waitKey)
    if (maxHeightRecoveries > 0 && wait && wait === found.wait && wait.gen === found.gen) {
      giveUpHeightWait(ctx, wait)
    }
    throw e
  } finally {
    signal._cleanup?.()
  }
}

// The final conflict's server value as the slot reads it; left out if it
// doesn't decode or validate
function slotConflictError (
  slot: SlotDefinition,
  contractID: string,
  label: string,
  e: unknown
): Error {
  const cause = kvConflictCause(e)
  let data: NormalizedKvConflictData = { present: false }
  try {
    data = normalizeKvConflictCurrentData(slot, contractID, slot.key, cause)
  } catch {}
  return new ChelErrorKvConflict(`[chelonia/kv] ${label} ran out of attempts resolving conflicts`, {
    cause: {
      ...(cause?.currentStatus && { currentStatus: cause.currentStatus }),
      ...(typeof cause?.requiredHeight === 'number' && { requiredHeight: cause.requiredHeight }),
      ...(data.present && { currentData: data.currentData }),
      etag: cause?.etag ?? null
    }
  })
}

// Applies a write the server committed (`value` undefined: a clear). It
// stands even if the caller has aborted since.
async function commitSlotWrite (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  seen: HeightWaitSnapshot,
  { value, etag, sawConflict, operation }: {
    value: JSONType | undefined; etag: string | null; sawConflict: boolean; operation: string
  }
): Promise<void> {
  const { contractType, key } = slot
  if (etag == null) {
    console.warn(
      `[chelonia/kv] ${operation}: ${contractID}::${key} successful write returned no ` +
      'etag/x-cid header; self-echo suppression is inactive for this write'
    )
  }
  // Even with the slot gone, the write's echo mustn't apply as a remote change
  recordEchoCID(ctx, contractID, key, etag, sawConflict)
  const entry = (sbp(ctx.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[key]
  if (!entry || !slotIsCurrent(ctx, contractID, slot)) return
  const previousValue = entry.value
  ctx.config.reactiveSet(entry, 'value', cloneForEmit(value))
  ctx.config.reactiveSet(entry, 'etag', etag)
  sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
    contractID,
    contractType,
    key,
    value: cloneForEmit(value),
    previousValue: cloneForEmit(previousValue),
    reason: KV_UPDATE_REASON.LOCAL,
    etag
  })
  settleVerified(ctx, contractID, slot, seen,
    value === undefined ? KV_LOAD_STATUS.NON_INIT : KV_LOAD_STATUS.LOADED)
  if (!slotIsCurrent(ctx, contractID, slot)) return
  const delivered = value !== undefined
    ? cloneForEmit(value)
    : slot.resolvedDefault !== undefined ? cloneDeep(slot.resolvedDefault) : undefined
  await safeOnUpdateGuarded(ctx, contractID, slot, delivered, {
    contractID,
    contractType,
    key,
    reason: KV_UPDATE_REASON.LOCAL,
    etag,
    previousValue: cloneForEmit(previousValue)
  })
}

// ---------------------------------------------------------------------------
// Filter-flush coalescing (KV-REVAMPED §11.5)
// ---------------------------------------------------------------------------

// One `setFilter` frame per (contract, microtask) — even if N slots
// reconcile in the same tick. The flush snapshots
// `kvActiveFilters[cID]` at flush time, so any subsequent in-tick
// mutation is naturally folded into the single emitted frame.
//
// Known minor: the snapshot is taken just before the `setFilter` await
// in `flushDirtyFilters`. If a slot is removed (match→false / release)
// while that await is in flight, the already-sent frame still carries
// the removed key, so the server may emit one superfluous broadcast for
// it. That frame is harmlessly dropped by `_handleRemote` (no active
// slot), and the removal re-dirties the contract so the next drain pass
// re-sends the corrected filter. Wasted bandwidth only — no corruption.
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
  // Re-entrancy guard. `flushDirtyFilters` awaits a `setFilter` per
  // contract; the microtask queue is open during each await. Without
  // this guard, a `queueFilterFlush` for an already-flushing contract
  // would see an empty dirty set and schedule a *second* concurrent
  // flush, so two `setFilter` frames for the same contract could race
  // and arrive out of order — leaving the server pinned to a stale
  // filter. A single draining loop instead picks up any contract
  // re-dirtied mid-flush and re-sends it with the latest
  // `kvActiveFilters` snapshot, so the last write always wins.
  if (ctx.kvFlushInFlight) return
  ctx.kvFlushInFlight = true
  try {
    while (ctx.kvFilterDirty.size > 0) {
      const cID = ctx.kvFilterDirty.values().next().value as string
      ctx.kvFilterDirty.delete(cID)
      const active = ctx.kvActiveFilters.get(cID)
      try {
        // `undefined` (not `[]`) when the contract has no active filter:
        // `setKvFilter` treats `undefined` as filter-removal (delete from
        // client.kvFilter → "all keys" on re-SUB), whereas `[]` would
        // persist and silence KV frames for raw-API consumers after re-sync.
        await sbp('chelonia/kv/setFilter', cID, active ? [...active] : undefined)
      } catch (e) {
        console.warn(`[chelonia/kv] setFilter flush failed for ${cID}`, e)
        // Synchronous dispatch failure (e.g. `this.pubsub` unset, or an
        // SBP filter vetoing the selector). Note: server-side rejection
        // of a KV_FILTER request does NOT surface here — `setKvFilter`
        // is fire-and-forget and the pubsub ERR handler (pubsub/index.ts)
        // warn-and-drops it independently. Server-side failures are
        // healed on the next reconnect via `isKvFilterFresh`. This retry
        // covers the (rare) synchronous-dispatch case only.
        scheduleFilterRetry(ctx, cID)
      }
    }
  } finally {
    ctx.kvFlushInFlight = false
  }
}

// Schedule a single deferred re-flush for contracts whose `setFilter`
// failed transiently. Deduped via the was-empty check on `kvFilterRetry`
// so concurrent failures share one timer. When it fires, the pending
// contracts move back into `kvFilterDirty` and a fresh flush runs; if
// that flush fails again it re-enters here, giving unbounded but
// rate-limited retries until the server accepts the filter or the slot
// set changes.
function scheduleFilterRetry (ctx: CheloniaContext, contractID: string): void {
  const wasEmpty = ctx.kvFilterRetry.size === 0
  ctx.kvFilterRetry.add(contractID)
  if (!wasEmpty) return
  if (ctx.kvFilterRetryTimer != null) return
  const timer = setTimeout(() => {
    ctx.kvFilterRetryTimer = undefined
    if (ctx.kvFilterRetry.size === 0) return
    for (const cID of ctx.kvFilterRetry) ctx.kvFilterDirty.add(cID)
    ctx.kvFilterRetry.clear()
    flushDirtyFilters(ctx).catch((e: unknown) => {
      console.error('[chelonia/kv] setFilter retry flush failed', e)
    })
  }, filterRetryMs)
  // Node.js-specific: `.unref()` prevents this timer from keeping the
  // process alive. The optional chaining makes it a no-op in browsers.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  ctx.kvFilterRetryTimer = timer
}

export default (sbp('sbp/selectors/register', {
  ...(process.env.NODE_ENV !== 'production'
    ? {
        'chelonia/kv/_testSetNowMs': function (fn?: (() => number) | null) {
          nowMs = typeof fn === 'function' ? fn : defaultNowMs
          return { now: nowMs(), ttl: KV_ECHO_TTL_MS }
        },
        // Read the live echo-CID clock so test helpers that seed echo
        // entries derive their expiry from the SAME source production uses
        // (`nowMs`), staying consistent under `_testSetNowMs` overrides
        // instead of mixing in `Date.now()`.
        'chelonia/kv/_testNowMs': function () {
          return nowMs()
        },
        // Shrink (or restore) the transient-failure retry backoff so tests
        // can drive `scheduleFilterRetry` deterministically.
        'chelonia/kv/_testSetFilterRetryMs': function (ms?: number | null) {
          filterRetryMs = typeof ms === 'number' ? ms : KV_FILTER_RETRY_MS
          return filterRetryMs
        },
        // Exercises the real `recordEchoCID` (including its eviction
        // policy) from tests without going through a full write.
        'chelonia/kv/_recordEchoCIDForTest': function (
          this: CheloniaContext,
          contractID: string,
          key: string,
          cid: string,
          fromConflict: boolean
        ) {
          recordEchoCID(this, contractID, key, cid, fromConflict)
        }
      }
    : {}),

  // Dev-time invariant check. See KV-REVAMPED.md §11.2 ("Index
  // invariant"). Walks the various `kv*` objects + `rootState._kv` and verifies:
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
    if (def.key.includes(KV_KEY_SEPARATOR)) {
      throw new ChelErrorKvSlotInvalid(
        `[chelonia/kv] defineSlot: key must not contain '${KV_KEY_SEPARATOR}'`
      )
    }
    const types = Array.from(new Set(
      Array.isArray(def.contractType) ? def.contractType : [def.contractType]
    ))
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
        def.autoLoad !== KV_AUTO_LOAD.ON_SYNC &&
        def.autoLoad !== KV_AUTO_LOAD.ON_DEMAND &&
        def.autoLoad !== KV_AUTO_LOAD.NEVER) {
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
    for (const contractType of types) {
      const perTypeDefault: JSONType | undefined =
        resolvedDefault === undefined ? undefined : cloneDeep(resolvedDefault)
      const slot = resolveSlotDefinition(def, contractType, perTypeDefault, source)
      assertSchemaGuards(slot)
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
        // trips on `registered !== slot`). `wasPointed` records that the
        // slot was *already active* for this contract: in that case
        // `_reconcileForSlot` sees `wasActive` and deliberately skips its
        // own autoload, so the replacement load is ours to schedule.
        let wasPointed = false
        if (previous) {
          const perKey = this.kvSlotsByContractID.get(cID)
          if (perKey && perKey.get(def.key) === previous) {
            perKey.set(def.key, slot)
            wasPointed = true
          }
        }
        sbp('chelonia/kv/_reconcileForSlot', slot, cID)
        // Re-validate any persisted mirror entry *after* reconcile so
        // the index invariant holds; gate on the slot still being
        // registered (reconcile may have removed it if the contract was
        // released or the match filter changed). Surface failures via
        // status/event but keep the old value (§4.1).
        if (this.kvSlotsByContractID.get(cID)?.get(def.key) === slot) {
          // A replacement of an `on-sync` slot whose first load is still
          // in flight has an unresolved mirror entry: reconcile saw the
          // key already present (`wasActive`) and skipped its autoload,
          // the superseded load discards its GET at the staleness guard,
          // and `revalidateMirrorEntry` no-ops on the `undefined` value.
          // Nobody would ever fetch the value. Schedule a queued load so
          // it serialises behind any in-flight write and the replacement
          // slot resolves. Gated on `wasPointed` so we never double-load
          // a slot that reconcile just activated (and already scheduled
          // a load for); first-time activation keeps reconcile's path.
          //
          // The same queued-load path is taken when a write is in flight
          // for this contract (`kvPendingWrites`): the in-flight
          // `update`/`clear` will commit a value the current mirror does
          // not yet reflect AND its staleness guard will skip the mirror
          // write because the slot was replaced. Re-validating the stale
          // mirror here would re-seed it from the pre-write value and
          // diverge from the server (#1). A queued `_loadSlot` instead
          // serialises behind the in-flight write and fetches the
          // committed value, so the replacement slot converges on truth.
          //
          // A load already pending for this contract (`kvPendingLoads`)
          // forces the same path even when the mirror currently reads
          // `loaded`. Such a load can be (a) a sync / reconnect / autoload
          // fetch queued behind busy lane work but not yet started — its
          // status is still `loaded`, so `unloaded` misses it — or (b) the
          // authoritative GET `_handleRemote` runs for a conflict / no-cid
          // frame. In both cases the in-flight load will discard its GET at
          // its own staleness guard once it sees the replacement (#1/#3),
          // so revalidating the soon-to-be-stale value would strand the
          // mirror at the old value with a `loaded` status. Scheduling a
          // fresh load for the replacement re-fetches the server value.
          const e = rootState._kv?.[cID]?.[def.key]
          const unloaded = !e || e.value === undefined ||
            e.status === KV_LOAD_STATUS.NON_INIT ||
            e.status === KV_LOAD_STATUS.LOADING
          const hasPendingWrite = (this.kvPendingWrites.get(cID) ?? 0) > 0
          const hasPendingLoad = (this.kvPendingLoads.get(cID) ?? 0) > 0
          if ((unloaded || hasPendingWrite || hasPendingLoad) && wasPointed &&
              slot.autoLoad === KV_AUTO_LOAD.ON_SYNC) {
            sbp('chelonia/kv/_loadSlot', {
              contractID: cID, slot, reason: KV_UPDATE_REASON.LOAD
            }).catch((err: unknown) => {
              logLoadRejection(`_loadSlot rejected for ${cID}::${def.key}`, err)
            })
          } else {
            revalidateMirrorEntry(this, rootState, cID, slot)
          }
        }
      }
      // Also re-validate persisted mirror entries for contracts not
      // currently in subscriptionSet (e.g. not yet re-synced after a
      // reload). §4.1 requires re-validating every persisted entry whose
      // contract type can be resolved, not just currently-synced
      // contracts. Skip entries whose contract type cannot be confirmed
      // to match — re-validating against the wrong slot type would
      // spuriously flip foreign entries to 'error'. Released contracts
      // are validated by `_loadSlotNow` the next time they sync.
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
          // Claim filter ownership for this contract even when the first
          // attached slot is local-only; test 52 locks in the empty flush.
          queueFilterFlush(this, contractID)
        }
      }
      // Seed the mirror entry as 'non-init' if absent so consumers
      // can observe the slot before the first load resolves.
      const perContract = ensureContractKv(this, rootState, contractID)
      const existing = perContract[slot.key]
      if (!existing) {
        this.config.reactiveSet(perContract, slot.key, {
          value: undefined,
          etag: null,
          status: KV_LOAD_STATUS.NON_INIT,
          settled: false
        })
      } else if (!wasActive) {
        // A kept or persisted entry is unverified until this activation's
        // first outcome; a `'loading'` left over from before is stale.
        patchEntry(this, contractID, slot, {
          settled: false,
          status: existing.status !== KV_LOAD_STATUS.LOADING
            ? undefined
            : existing.value === undefined ? KV_LOAD_STATUS.NON_INIT : KV_LOAD_STATUS.LOADED
        })
      }
      // Schedule a load. The actual fetch is serialised against
      // updates via the per-contract queueInvocation lane.
      if (!wasActive && slot.autoLoad === KV_AUTO_LOAD.ON_SYNC) {
        // Fire-and-forget — `_loadSlot` manages its own status events and
        // may reject on GET or validation failure; the `.catch` here
        // keeps that rejection out of the reconcile dispatch path.
        sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: KV_UPDATE_REASON.LOAD })
          .catch((e: unknown) => {
            logLoadRejection(`_loadSlot rejected for ${contractID}::${slot.key}`, e)
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
      dropEntry(this, rootState, contractID, slot.key)
      rejectSettleWaits(this, `${contractID}${KV_KEY_SEPARATOR}${slot.key}`,
        "isn't active for its contract")
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
      reason,
      suppressLoadingStatus,
      stale
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
      suppressLoadingStatus?: boolean;
      // Checked when the load's turn comes: skips a load that became moot
      stale?: () => boolean;
    }
  ): Promise<void> {
    // Count the load as pending the moment it is *scheduled*, not when
    // its lane callback starts: a load queued behind busy lane work has
    // not yet flipped the slot to 'loading', so `defineSlot`'s gate
    // would otherwise miss it and revalidate a value this load is about
    // to discard at its staleness guard (#1).
    incrementPendingLoad(this, contractID)
    const instance = this._instance
    let started = false
    return (async () => {
      try {
        await sbp('chelonia/queueInvocation', contractID, () => {
          started = true
          if (stale?.()) return
          return sbp('chelonia/kv/_loadSlotNow', { contractID, slot, reason, suppressLoadingStatus })
        })
        if (started || this._instance !== instance) return
        throw new ChelErrorUnexpected(
          `[chelonia/kv] load of ${contractID}::${slot.key} was vetoed`
        )
      } catch (e) {
        // Work dropped by a reset belongs to the previous session
        if (!started && this._instance === instance) settleUnloaded(this, contractID, slot, e)
        throw e
      } finally {
        decrementPendingLoad(this, contractID)
      }
    })()
  },

  // Private unqueued implementation. Fetches via `chelonia/kv/get`,
  // validates, and writes the mirror. Callers must already hold the per-contract lane
  // or intentionally run outside it.
  'chelonia/kv/_loadSlotNow': function (
    this: CheloniaContext,
    {
      contractID,
      slot,
      reason,
      suppressLoadingStatus = false,
      preserveStatusOnError = false
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
      // Skip the transient `'loading'` status when the slot is already
      // `'loaded'` (a refresh, not a first load)
      suppressLoadingStatus?: boolean;
      // On failure, keep the prior status instead of `'error'`: the mirror
      // still holds a usable value (the error is still thrown)
      preserveStatusOnError?: boolean;
    }
  ): Promise<void> {
    incrementPendingLoad(this, contractID)
    return (async () => {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      // The contract may have been released between scheduling and
      // running — bail out cleanly.
      if (!this.subscriptionSet.has(contractID)) return
      // Non-destructive existence check FIRST: reconcile may have dropped
      // the mirror entry (and the now-empty `_kv[contractID]` record) while
      // we were queued behind other lane work. Calling `ensureContractKv`
      // here would re-create an orphaned empty `{}` record that lingers in
      // persisted state until contract release. The subscription guard
      // above doesn't cover this — the contract is still subscribed, only
      // the slot entry was removed. Matches the non-destructive read
      // pattern `patchEntry` uses.
      if (!rootState._kv?.[contractID]?.[slot.key]) {
        return
      }
      const perContract = ensureContractKv(this, rootState, contractID)
      if (!perContract[slot.key]) {
        // Reconcile dropped the entry while we were queued.
        return
      }
      const priorEntry = perContract[slot.key]
      const priorStatus = priorEntry.status
      const priorError = priorEntry.lastError
      const seen = heightWaitSnapshot(this, contractID, slot.key)
      const setStatus = (patch: EntryPatch) => patchEntry(this, contractID, slot, patch)
      const settle = (status: typeof KV_LOAD_STATUS.LOADED | typeof KV_LOAD_STATUS.NON_INIT) =>
        settleVerified(this, contractID, slot, seen, status)
      // Staleness teardown shared by all three guards below. Re-reads
      // the LIVE mirror (`rootState._kv`) rather than the `perContract`
      // captured above: `chelonia/kv/_cleanupContractRuntime` can run
      // (outside this lane) during the GET await and `reactiveDel` the
      // whole `_kv[contractID]` record. The captured `perContract` then
      // points at a detached object whose entry still reads
      // `'loading'`, so trusting it would call `patchEntry` →
      // `ensureContractKv` and silently re-create the deleted record
      // (orphan leak in prod, throw in dev, `_assertIndexConsistent`
      // trip). Re-reading live means a released contract yields no
      // entry and we return without resurrecting it; a *replaced* slot
      // yields the replacement's entry, which we only touch while it is
      // still `'loading'` so we never clobber a `'loaded'`/`'error'`
      // status the replacement already set (e.g. via
      // `revalidateMirrorEntry`).
      const restorePriorStatusIfStale = () => {
        const liveEntry = rootState._kv?.[contractID]?.[slot.key]
        if (!liveEntry) return
        if (liveEntry.status === KV_LOAD_STATUS.LOADING) {
          setStatus({ status: priorStatus, lastError: priorError })
        }
      }
      const slotReplacedOrReleased = () =>
        this.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot
      // Shared handling for a decode / schema / JSON-shape failure on an
      // otherwise-successful GET. Emits the validation event, then either
      // restores the prior status (conflict-resolution path) or stamps
      // `'error'`, and re-throws a wrapped `ChelErrorKvValidation`.
      // Honoring `preserveStatusOnError` here — not just on the GET-throw
      // path above — is essential: a conflict-resolved write already
      // committed a valid value to the mirror, so a malformed-but-200
      // authoritative GET must NOT flip the slot to `'error'` (which would
      // make `chelonia/kv/read` return the default and silently hide the
      // retained value). See the flag's definition above and §4.9.
      //
      // Event-vs-status contract: `CHELONIA_KV_VALIDATION_ERROR` is ALWAYS
      // emitted from this path, including when `preserveStatusOnError`
      // suppresses the `'error'` status transition. The event is diagnostic
      // ("the server returned something invalid") while `status` reflects
      // the mirror's actual usability. Consumers that need a "slot is in
      // trouble" signal MUST watch `CHELONIA_KV_STATUS_CHANGED` reaching a
      // terminal status, not infer health from the presence or absence of a
      // `CHELONIA_KV_VALIDATION_ERROR` event.
      const failLoadValidation = (e: unknown, wrappedMessage: string): never => {
        sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          error: e,
          reason
        })
        if (preserveStatusOnError) {
          restorePriorStatusIfStale()
        } else {
          setStatus({ status: KV_LOAD_STATUS.ERROR, lastError: normalizeError(e), settled: true })
        }
        throw new ChelErrorKvValidation(wrappedMessage, { cause: e })
      }
      if (!(suppressLoadingStatus && priorStatus === KV_LOAD_STATUS.LOADED)) {
        setStatus({ status: KV_LOAD_STATUS.LOADING })
      }
      let parsed: ChelKvGetResult | null
      try {
        parsed = await sbp('chelonia/kv/get', contractID, slot.key)
      } catch (e) {
        // Staleness guard (symmetric with the success paths below): if
        // `defineSlot` replaced this slot, or the contract was released,
        // while the GET was in flight, bail out before stamping an error
        // onto the (replacement or already-torn-down) mirror entry.
        if (slotReplacedOrReleased()) {
          restorePriorStatusIfStale()
          return
        }
        const requiredHeight = kvHeightAheadCause(e)?.requiredHeight
        if (typeof requiredHeight === 'number') {
          // Unverifiable for now: a slot with a usable status keeps it
          if (priorStatus === KV_LOAD_STATUS.LOADED || priorStatus === KV_LOAD_STATUS.ERROR) {
            restorePriorStatusIfStale()
          }
          registerHeightWait(this, contractID, slot, requiredHeight, reason)
          throw e
        }
        if (preserveStatusOnError) {
          // Conflict-resolution path: the committed value still lives in
          // the mirror. Restore the prior status (a no-op when
          // `suppressLoadingStatus` kept it at `'loaded'`) instead of
          // stamping `'error'`, then re-throw so the caller can log and
          // demote its conflict markers.
          restorePriorStatusIfStale()
          throw e
        }
        const lastError = normalizeError(e)
        setStatus({ status: KV_LOAD_STATUS.ERROR, lastError, settled: true })
        throw e
      }
      if (parsed === null) {
        // Staleness guard (symmetric with the non-null path below):
        // if `defineSlot` replaced this slot, or the contract was
        // released, while the GET was in flight, bail out before
        // mutating the mirror.
        if (slotReplacedOrReleased()) {
          restorePriorStatusIfStale()
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
        // Re-acquire the LIVE mirror entry (not the pre-await
        // `perContract` capture): if the contract was released and
        // re-synced during the GET await, `perContract` points at a
        // detached, dropped record. The slot-identity guard above does
        // not catch release+re-sync because the surviving slot object is
        // re-indexed unchanged. Writing the detached object would be lost
        // from the live mirror.
        const existingEntry = rootState._kv?.[contractID]?.[slot.key]
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
              previousValue: cloneForEmit(previousValue),
              reason,
              etag: null
            })
          }
        }
        // Transition to 'non-init' before onUpdate (matching the
        // success-path sequencing of patchEntry → safeOnUpdateGuarded).
        settle(KV_LOAD_STATUS.NON_INIT)
        if (existingEntry && previousValue !== undefined &&
            slotIsCurrent(this, contractID, slot)) {
          const defaultedValue = slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined
          await safeOnUpdateGuarded(this, contractID, slot, defaultedValue, {
            contractID,
            contractType: slot.contractType,
            key: slot.key,
            reason,
            etag: null,
            previousValue: cloneForEmit(previousValue)
          })
        }
        return
      }
      // Capture the etag from the GET response before any await point.
      const getEtag = parsed.etag ?? null
      // Staleness guard: if `defineSlot` replaced this slot, or the
      // contract was released, while the fetch was in flight, the
      // captured `slot` object is stale — its schema / defaults /
      // callbacks no longer match the registry. Restore the prior
      // status so the slot doesn't remain stuck at 'loading' (the
      // replacement slot will manage its own lifecycle). This runs
      // *before* decoding `parsed.data` so a replaced slot never pays
      // the decrypt/verify cost or stamps decode-failure side effects
      // onto the replacement's mirror entry. The decode/validation
      // branches below re-throw by design but run synchronously after
      // this guard with no intervening await, so a released contract
      // has already bailed here and they never stamp a torn-down entry.
      if (slotReplacedOrReleased()) {
        restorePriorStatusIfStale()
        return
      }
      // `parsed.data` is a lazy accessor that can throw on decrypt/signature
      // failure, so downgrade that failure through the same status path as
      // schema validation.
      let unwrapped: JSONType
      try {
        unwrapped = parsed.data
      } catch (e) {
        throw failLoadValidation(
          e, `[chelonia/kv] load: ${contractID}::${slot.key} decode failed`
        )
      }
      // Re-acquire the LIVE mirror entry (not the pre-await
      // `perContract` capture). If the contract was released and
      // re-synced during the GET await, `_cleanupContractRuntime`
      // dropped the original `_kv[contractID]` record and reconcile
      // seeded a fresh one; the slot-identity guard above passes
      // because the surviving slot object is re-indexed unchanged.
      // Writing the captured `perContract` entry would land on the
      // detached, dropped object — lost from the live mirror — while
      // `patchEntry` (which re-reads live) would stamp the fresh
      // entry 'loaded' with no value. Bail if no live entry exists
      // (released without re-sync, or reconcile dropped it).
      const entry = rootState._kv?.[contractID]?.[slot.key]
      if (!entry) return
      const previousValue = entry.value
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
          throw failLoadValidation(
            e, `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`
          )
        }
      } else {
        try {
          nextValue = assertJsonShape(unwrapped, `load ${contractID}::${slot.key}`)
        } catch (e) {
          throw failLoadValidation(
            e, `[chelonia/kv] load: ${contractID}::${slot.key} validation failed`
          )
        }
      }
      // Write mirror — entry definitely exists (we seeded it
      // upstream and bail out if reconcile dropped it). For a wire-null
      // clear the canonical 'non-init' mirror `value` is `undefined`
      // (§4.3/§4.5), matching local `clear` and the 404 branch; the
      // resolved default is still surfaced through `onUpdate` below.
      const mirrorValue = wasClear ? undefined : nextValue
      this.config.reactiveSet(entry, 'value', mirrorValue)
      this.config.reactiveSet(entry, 'etag', getEtag)
      // Emit order: `CHELONIA_KV_UPDATED` fires BEFORE `patchEntry`
      // below. Since `okTurtles.events/emit` is synchronous, a handler
      // reading `chelonia/kv/status` here sees the pre-transition status
      // (e.g. still `'loading'`). Consumers needing a settled status
      // must watch `CHELONIA_KV_STATUS_CHANGED` (see docs/kv.md
      // §Consumer caveats).
      sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
        contractID,
        contractType: slot.contractType,
        key: slot.key,
        value: cloneForEmit(mirrorValue),
        previousValue: cloneForEmit(previousValue),
        reason,
        etag: getEtag
      })
      settle(wasClear ? KV_LOAD_STATUS.NON_INIT : KV_LOAD_STATUS.LOADED)
      if (slotIsCurrent(this, contractID, slot)) {
        await safeOnUpdateGuarded(this, contractID, slot, cloneForEmit(nextValue), {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          reason,
          etag: getEtag,
          previousValue: cloneForEmit(previousValue)
        })
      }
    })().finally(() => {
      decrementPendingLoad(this, contractID)
    })
  },

  // Private listener for CONTRACTS_MODIFIED. Mounted from
  // `chelonia/connect` (see chelonia.ts) so that newly-synced
  // contracts automatically wire up every matching slot, and
  // removed contracts have their per-contract KV runtime state
  // cleaned up (KV-REVAMPED §11.4). Removal cleanup is also called
  // directly from `chelonia/private/removeImmediately`; both paths are
  // intentionally idempotent.
  'chelonia/kv/_onContractsModified': function (
    this: CheloniaContext,
    { added, removed, resync }: { added: string[]; removed: string[]; resync?: boolean }
  ): void {
    for (const cID of added ?? []) reconcileContract(this, cID)
    if (removed && removed.length > 0) {
      for (const cID of removed) {
        // Also invoked directly from `chelonia/private/removeImmediately`
        // as an idempotent fast path; calling twice is safe.
        sbp('chelonia/kv/_cleanupContractRuntime', cID, { resync })
      }
    }
  },

  // Private. See KV-REVAMPED §11.4 (contract-release / unsubscribe path).
  // Called from both `chelonia/private/removeImmediately` and the
  // `CONTRACTS_MODIFIED` listener; all operations below are idempotent.
  // Clears per-contract KV runtime state for `contractID`: removes
  // `rootState._kv[contractID]` (kept through a resync),
  // `kvSlotsByContractID[contractID]`,
  // `kvActiveFilters[contractID]`, and schedules an empty-filter
  // `setFilter` flush. The `kvFilterDirty` mark is intentionally
  // retained until the microtask fires so the flush sees this
  // contract in the dirty set. Keeps long-lived sessions from
  // accumulating stale mirror entries after refcount goes to zero. This
  // selector may run outside any per-contract queue lane, so it must
  // remain synchronous and idempotent.
  'chelonia/kv/_cleanupContractRuntime': function (
    this: CheloniaContext,
    contractID: string,
    { resync }: { resync?: boolean } = {}
  ): void {
    const slots = this.kvSlotsByContractID.get(contractID)
    this.kvReconciledContracts.delete(contractID)
    cancelHeightWaits(this, contractID)
    // A re-sync activates the slots again
    if (!resync) endSettleWaits(this, (cID) => cID === contractID, 'was removed with its contract')
    const hadFilter = this.kvActiveFilters.has(contractID)
    // Queue a filter flush for this contract *before* dropping state so
    // the server receives the filter-removal frame (§11.5 empty
    // transitions). The flush reads kvActiveFilters at microtask time;
    // deleting the entry below is what makes the emitted filter
    // `undefined` (filter-removal), not `[]` (silence-all). Deferring
    // to a microtask also ensures the frame is sent after
    // `subscriptionSet.delete` in `removeImmediately`, so the pubsub
    // subscription gate suppresses the wire frame (the UNSUB that
    // follows makes it redundant).
    // We intentionally do NOT delete from kvFilterDirty here — the
    // microtask must see this contract in the dirty set to send the
    // filter-removal frame.
    if (hadFilter) queueFilterFlush(this, contractID)
    this.kvSlotsByContractID.delete(contractID)
    this.kvActiveFilters.delete(contractID)
    this.kvFilterRetry.delete(contractID)
    this.kvReconnectRefresh.delete(contractID)
    const prefix = `${contractID}${KV_KEY_SEPARATOR}`
    this.kvLocalEchoCIDs.forEach((_cids, key) => {
      if (key.startsWith(prefix)) {
        this.kvLocalEchoCIDs.delete(key)
      }
    })
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const record = rootState._kv?.[contractID]
    if (!resync) {
      this.kvResyncedContracts.delete(contractID)
      if (record) this.config.reactiveDel(rootState._kv!, contractID)
    } else if (record) {
      // Kept for the slots to use once they activate again
      this.kvResyncedContracts.add(contractID)
      // The markers go with the waits; `slot` gives the events the contract
      // type, as the contract's state is gone
      slots?.forEach((slot, key) => {
        if (record[key]?.heightAhead) patchEntry(this, contractID, slot, { heightAhead: null })
      })
    }
  },

  'chelonia/kv/_flushDirtyFilters': function (
    this: CheloniaContext
  ): Promise<void> {
    return flushDirtyFilters(this)
  },

  // Private. Drain (not cancel) in-flight `chelonia/kv/update` /
  // `chelonia/kv/clear` writes before `chelonia/reset` tears down state.
  // KV writes run inside the per-contract `chelonia/queueInvocation`
  // lane, so enqueuing a noop behind them resolves only once they
  // settle — symmetric with `chelonia/contract/wait`. The contract set
  // is the union of three sources:
  //   1. contracts with an active slot index
  //      (`kvSlotsByContractID`),
  //   2. contracts that still own an echo-suppression CID
  //      (`kvLocalEchoCIDs` — an in-flight write whose slot index was
  //      already cleaned up but whose body has progressed far enough to
  //      record a CID), and
  //   3. contracts with a non-zero pending-write count
  //      (`kvPendingWrites` — a write whose body is still queued behind
  //      a prior operation and has not yet recorded a CID; the slot
  //      index and CID sources miss this window).
  // `chelonia/reset` awaits this before clearing the KV runtime maps so
  // continuations never run against a torn-down mirror or a swapped-out
  // `kvLocalEchoCIDs`. `_loadSlot` syncs are drained through source #1;
  // if the contract is released before a queued load runs, `_loadSlot`'s
  // subscription guard bails out before mutating state.
  'chelonia/kv/_waitInFlight': function (
    this: CheloniaContext
  ): Promise<unknown> {
    const ids = new Set<string>(this.kvSlotsByContractID.keys())
    this.kvLocalEchoCIDs.forEach((_cids, echoKey) => {
      const idx = echoKey.indexOf(KV_KEY_SEPARATOR)
      if (idx > 0) ids.add(echoKey.slice(0, idx))
    })
    this.kvPendingWrites.forEach((_n, cID) => ids.add(cID))
    return Promise.all([
      ...Array.from(ids, (cID) =>
        sbp('chelonia/queueInvocation', cID, ['chelonia/private/noop'])
      ),
      ...Array.from(this.kvRecoveries.values(), (sync) => sync.catch(() => {}))
    ])
  },

  // Private. See KV-REVAMPED §11.4 bullet 3 (reconnect hook).
  // Called from the pubsub reconnect-open path. Clears pending local
  // echo CIDs immediately; slot reloads with `refreshOnReconnect === true`
  // are marked here and run after the per-subscription forced resync.
  'chelonia/kv/_onReconnect': function (this: CheloniaContext): void {
    this.kvLocalEchoCIDs.clear()
    for (const [cID, perKey] of this.kvSlotsByContractID) {
      for (const [, slot] of perKey) {
        if (slot.refreshOnReconnect) {
          this.kvReconnectRefresh.add(cID)
          break
        }
      }
    }
  },

  // Private. Event processing calls it right after committing a height; tests
  // that set a height directly call it too.
  'chelonia/kv/_notifyHeight': function (
    this: CheloniaContext,
    contractID: string,
    height: number
  ): void {
    notifyContractHeight(this, contractID, height)
  },

  // Private. For pubsub frames that can't be verified: an ahead one
  // (`requiredHeight`) reloads the key at that height, a malformed one now
  'chelonia/kv/_onUnverifiableFrame': function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    requiredHeight?: number
  ): void {
    const slot = this.kvSlotsByContractID.get(contractID)?.get(key)
    if (!slot) return
    if (requiredHeight !== undefined) {
      return registerHeightWait(this, contractID, slot, requiredHeight, KV_UPDATE_REASON.REMOTE)
    }
    sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: KV_UPDATE_REASON.REMOTE })
      .catch((e: unknown) => {
        logLoadRejection(`reload after a malformed frame rejected for ${contractID}::${key}`, e)
      })
  },

  // Retries `attempt` (e.g. raw `kv/get` / `kv/set` calls) after syncing the
  // contract when it rejects with `ChelErrorKvHeightAhead`
  'chelonia/kv/withHeightRecovery': async function <T> (
    this: CheloniaContext,
    contractID: string,
    attempt: (args: KvHeightRecoveryAttempt) => T | Promise<T>,
    options?: KvHeightRecoveryOptions | null
  ): Promise<T> {
    if (typeof attempt !== 'function') {
      throw new TypeError('[chelonia/kv] withHeightRecovery: `attempt` must be a function')
    }
    assertNotReentrant(this, contractID, undefined, 'withHeightRecovery')
    return withHeightRecovery(this, contractID, attempt, options)
  },

  'chelonia/kv/_onContractResynced': function (this: CheloniaContext, contractID: string): void {
    if (!this.kvReconnectRefresh.has(contractID)) return
    this.kvReconnectRefresh.delete(contractID)
    if (!this.subscriptionSet.has(contractID)) return
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey) return
    for (const [, slot] of perKey) {
      if (slot.refreshOnReconnect) {
        sbp('chelonia/kv/_loadSlot', {
          contractID,
          slot,
          reason: KV_UPDATE_REASON.RECONNECT
        })
          .catch((e: unknown) => {
            logLoadRejection(`_loadSlot (reconnect) rejected for ${contractID}::${slot.key}`, e)
          })
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
  //     and the raw KV API still runs through the existing
  //     callback path. No regression.
  //   - Read the frame CID; if it matches a non-expired entry in
  //     `kvLocalEchoCIDs[${cID}::${key}]`, drop the frame silently
  //     (self-echo suppression — §4.9) and remove the CID from the bucket.
  //   - Wire `null` is the clear sentinel — write the
  //     deep-cloned `resolvedDefault` without running `schema.parse`.
  //   - On schema validation failure: **keep** the previous mirror
  //     `value`, flip `status: 'error'`, set `lastError`, fire
  //     `CHELONIA_KV_VALIDATION_ERROR` and `CHELONIA_KV_STATUS_CHANGED`.
  //     Never throw out of the dispatch path.
  'chelonia/kv/_handleRemote': function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    parsed: ParsedEncryptedOrUnencryptedMessage<JSONType>,
    cid?: string
  ): Promise<void> {
    const perKey = this.kvSlotsByContractID.get(contractID)
    const slot = perKey?.get(key)
    if (!slot) return Promise.resolve()
    const echoKey = `${contractID}${KV_KEY_SEPARATOR}${key}`
    // Treat an empty-string `cid` as "no cid", matching `recordEchoCID`
    // (which rejects empty strings). A malformed frame carrying `cid:
    // ''` must neither participate in echo suppression nor be written
    // into the mirror as an etag — an empty etag would later be sent as
    // `ifMatch: ''` and trigger a spurious 412 on the next local write.
    const hasCid = typeof cid === 'string' && cid.length > 0
    if (hasCid) {
      const now = nowMs()
      purgeExpiredEchoCIDs(this, echoKey, now)
      const pending = this.kvLocalEchoCIDs.get(echoKey)
      const pendingEntry = pending?.get(cid)
      if (pendingEntry && pendingEntry.expiry > now) {
        if (pendingEntry.fromConflict) {
          // Echo-first ordering: this is the conflict-resolved write's
          // own pubsub echo arriving BEFORE a still-pending competing
          // non-self frame. Suppress the echo (it is ours) but KEEP the
          // marker — and keep `fromConflict` set — so that when the
          // competing frame arrives it still enters the
          // authoritative-GET branch below instead of regressing the
          // mirror via last-write-wins. That GET then demotes the marker
          // (on success AND failure), so this cannot loop. The marker
          // otherwise self-expires via its TTL if no competing frame
          // ever arrives. Deleting here (the non-conflict path below)
          // would drop the marker and let a later stale frame win.
        } else {
          pending!.delete(cid)
          if (pending!.size === 0) this.kvLocalEchoCIDs.delete(echoKey)
        }
        return Promise.resolve()
      }
      const bucket = this.kvLocalEchoCIDs.get(echoKey)
      if (bucket) {
        let hasPendingConflict = false
        for (const entry of bucket.values()) {
          if (entry.fromConflict) {
            hasPendingConflict = true
            break
          }
        }
        if (hasPendingConflict) {
          const conflictCIDs = new Set<string>()
          for (const [pendingCID, pendingConflict] of bucket) {
            if (pendingConflict.fromConflict) conflictCIDs.add(pendingCID)
          }
          // Demote — do NOT delete — the conflict markers. Once the
          // authoritative GET below has reconciled the mirror against
          // the server's latest value, a future *non-self* frame no
          // longer needs to force another GET (hence clearing
          // `fromConflict`). But the conflict write's own pubsub echo
          // may still be in flight; deleting the CID here would let
          // that delayed echo fall through to the last-write-wins path
          // and regress the mirror to the older conflict-resolved
          // value. Keeping the (demoted) entry means the echo still
          // matches the suppressor at the top of `_handleRemote` and
          // is dropped. The entry self-expires via its TTL.
          //
          // Demotion runs unconditionally — on both fulfilment AND
          // rejection of the GET. If the GET fails (offline, decode /
          // validation failure on server data) and we left the markers
          // set, every subsequent non-self frame would re-enter this
          // branch and fire another GET — a GET-per-frame loop pinned
          // until the echo TTL expires (5 min). Demoting on failure
          // lets the next frame take the normal last-write-wins path
          // while the still-pending self-echo stays suppressed.
          const demoteConflictMarkers = () => {
            const currentBucket = this.kvLocalEchoCIDs.get(echoKey)
            if (currentBucket) {
              for (const pendingCID of conflictCIDs) {
                const pendingEntry = currentBucket.get(pendingCID)
                if (pendingEntry) pendingEntry.fromConflict = false
              }
            }
          }
          return sbp('chelonia/kv/_loadSlotNow', {
            contractID,
            slot,
            reason: KV_UPDATE_REASON.REMOTE,
            // Reconciling a conflict on an already-loaded slot must not
            // surface a cosmetic `loaded → loading → loaded` flicker.
            suppressLoadingStatus: true,
            // A failed authoritative GET must not flip the slot to
            // `'error'`: the conflict-resolved write already committed,
            // so the mirror still holds a valid value. See the flag's
            // definition in `_loadSlotNow`.
            preserveStatusOnError: true
          }).then((result: void) => {
            demoteConflictMarkers()
            return result
          }, (e: unknown) => {
            // Never throw out of the pubsub dispatch path (§4.9 / §6).
            // The authoritative GET failed; demote markers regardless
            // (see above) and resolve so the dispatcher keeps running.
            logLoadRejection(`conflict-resolution GET failed for ${contractID}::${key}`, e)
            demoteConflictMarkers()
          })
        }
      }
    }
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const perContract = ensureContractKv(this, rootState, contractID)
    const entry = perContract[key]
    if (!entry) {
      // Reconcile dropped the mirror entry — nothing to write into.
      // Resolved before decoding so the decode-failure branch never
      // calls `patchEntry` against a missing entry (which throws in
      // dev/test).
      return Promise.resolve()
    }
    // No-cid frame on an etag-bearing slot: we have no server CID to
    // pair with this frame, so applying it inline would write the new
    // value (or `undefined` for a clear) while keeping the OLD etag,
    // breaking the "value and etag move together" invariant and
    // guaranteeing a 412 on the next local write. Fetch authoritative
    // state instead so value + etag are re-paired from the server —
    // mirroring the conflict-reconciliation path. Only when `entry.etag`
    // is non-null is there a stale etag to protect; a never-loaded slot
    // (etag null) applies the frame inline below. Its next local write
    // will send `if-match: '""'` (key must not exist) and, if the key
    // now exists, receive a 412 that routes into `onconflict` — safe,
    // not a spurious failure. Per §4.9 a no-cid frame is already the
    // exceptional legacy/non-Chelonia-writer path, so the extra
    // round-trip is acceptable.
    if (!hasCid && entry.etag != null) {
      // If a conflict marker is pending for this slot, demote it on
      // completion of this GET (mirroring the conflict branch above):
      // otherwise successive no-cid frames would each re-trigger this
      // GET while the marker stays set — a GET-per-frame loop pinned
      // until the marker's TTL. Demoting lets the next no-cid frame on
      // a now-reconciled slot take the (harmless) inline path. Conflict
      // markers are only ever set alongside a cid, so a no-cid frame
      // seeing one is rare, but demoting keeps the two paths consistent.
      //
      // Scope note: this demotion clears `fromConflict` on EVERY marker
      // in the bucket, not just a single write's marker. Under burst
      // contention with two independent conflict-resolved writes for the
      // same (contractID, key), a later competing frame for the second
      // write would fall through to last-write-wins instead of forcing
      // its own GET. This is self-healing — the server is authoritative
      // and the next local write's `if-match` reconciles — so the
      // broader demotion is accepted to keep the common (single-write)
      // case loop-free.
      const demoteConflictMarkers = () => {
        const bucket = this.kvLocalEchoCIDs.get(echoKey)
        if (bucket) {
          for (const [, m] of bucket) {
            if (m.fromConflict) m.fromConflict = false
          }
        }
      }
      return sbp('chelonia/kv/_loadSlotNow', {
        contractID,
        slot,
        reason: KV_UPDATE_REASON.REMOTE,
        // Already-loaded slot: don't flash `loaded → loading → loaded`.
        suppressLoadingStatus: true,
        // A failed authoritative GET must not flip to `'error'`: the
        // mirror still holds its prior (consistent) value + etag pair.
        preserveStatusOnError: true
      }).then((result: void) => {
        demoteConflictMarkers()
        return result
      }, (e: unknown) => {
        // Never throw out of the pubsub dispatch path (§4.9 / §6).
        demoteConflictMarkers()
        logLoadRejection(`no-cid authoritative GET failed for ${contractID}::${key}`, e)
      })
    }
    const failRemoteValidation = (e: unknown): Promise<void> => {
      sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
        contractID,
        contractType: slot.contractType,
        key,
        error: e,
        reason: KV_UPDATE_REASON.REMOTE
      })
      patchEntry(this, contractID, slot, {
        status: KV_LOAD_STATUS.ERROR, lastError: normalizeError(e), settled: true
      })
      return Promise.resolve()
    }

    let unwrapped: JSONType
    try {
      unwrapped = parsed.data
    } catch (e) {
      return failRemoteValidation(e)
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
        // `parsed` is shared with the legacy KV handler (see chelonia.ts).
        // Clone the validated result so the mirror never aliases the
        // shared object — a legacy handler that retains and later mutates
        // it must not corrupt the mirror. (parseSyncSlotValue usually
        // returns a fresh object, but a custom `.parse` may not.)
        const validated = parseSyncSlotValue(slot, unwrapped, `remote ${contractID}::${key}`)
        nextValue = (validated !== null && typeof validated === 'object')
          ? cloneDeep(validated)
          : validated
      } catch (e) {
        // Deliberately leave `entry.etag` alone: validation failed, so
        // the mirror `value` is unchanged from the last successful
        // load/write — the etag still describes that value. Nulling
        // it here would diverge from the "value and etag move
        // together" invariant on the success path below (and on
        // §4.9's pubsub-success branch).
        return failRemoteValidation(e)
      }
    } else {
      try {
        // assertJsonShape returns its input (=== shared parsed.data)
        // unchanged; clone so the mirror does not alias it.
        const validated = assertJsonShape(unwrapped, `remote ${contractID}::${key}`)
        nextValue = (validated !== null && typeof validated === 'object')
          ? cloneDeep(validated)
          : validated
      } catch (e) {
        return failRemoteValidation(e)
      }
    }
    const remoteEtag = hasCid ? cid! : (entry.etag ?? null)
    if (!hasCid) {
      // Reaching here without a cid implies `entry.etag == null` (a
      // never-loaded slot): a no-cid frame on an *etag-bearing* slot was
      // already routed to the authoritative GET above. So there is no
      // stale etag to clobber — the frame applies inline with a null
      // etag, exactly as a first load would.
      console.warn(
        `[chelonia/kv] remote frame for ${contractID}::${key} carried no cid ` +
        'on a never-loaded slot; applying with null etag'
      )
    }
    // A remote clear (unwrapped === null) stores `undefined` as the
    // canonical 'non-init' mirror `value` (§4.3/§4.5), matching local
    // `clear` and the 404 branch; `onUpdate` below still receives the
    // resolved default via `nextValue`.
    const mirrorValue = unwrapped === null ? undefined : nextValue
    this.config.reactiveSet(entry, 'value', mirrorValue)
    this.config.reactiveSet(entry, 'etag', remoteEtag)
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
      contractID,
      contractType: slot.contractType,
      key,
      value: cloneForEmit(mirrorValue),
      previousValue: cloneForEmit(previousValue),
      reason: KV_UPDATE_REASON.REMOTE,
      etag: remoteEtag
    })
    // A remote clear (unwrapped === null) empties the slot, matching local
    // clear semantics (§4.5). Applied frames leave height waits and markers.
    patchEntry(this, contractID, slot, {
      status: unwrapped === null ? emptyStatus(this, contractID, key) : KV_LOAD_STATUS.LOADED,
      settled: true
    })
    if (!slotIsCurrent(this, contractID, slot)) {
      return Promise.resolve()
    }
    return safeOnUpdateGuarded(this, contractID, slot, cloneForEmit(nextValue), {
      contractID,
      contractType: slot.contractType,
      key,
      reason: KV_UPDATE_REASON.REMOTE,
      etag: remoteEtag,
      previousValue: cloneForEmit(previousValue)
    })
  },

  // Public. See KV-REVAMPED §4.2. Reduces the slot's value and writes it on the
  // contract's lane (rejections: docs/kv.md); a failed write never sets `'error'`.
  'chelonia/kv/update': async function (
    this: CheloniaContext,
    args: {
      contractID: string;
      key: string;
      updater?: KvUpdater<JSONType>;
      value?: JSONType;
      maxAttempts?: number | null;
      signal?: AbortSignal;
      ifMatch?: string;
    } & KvHeightRecoveryOptions
  ): Promise<JSONType | undefined> {
    const { contractID, key, updater, value, maxAttempts, ifMatch } = args
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'update')
    assertNotReentrant(this, contractID, key, 'update')
    // Which of `updater` / `value` was passed, not their values (`value:
    // undefined` counts as passed)
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
      // Built once: conflict retries re-run the same reducer
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
    const label = `update: ${contractID}::${key}`
    assertMaxAttempts(maxAttempts, label)
    const assertCurrent = () => {
      if (!slotIsCurrent(this, contractID, slot)) {
        throw new ChelErrorKvSlotUnknown(
          `[chelonia/kv] update: no active slot for ${contractID}::${key}`
        )
      }
    }
    // Read live: a release and resync may replace `_kv[contractID]`
    const liveEntry = () =>
      (sbp(this.config.stateSelector) as ChelRootState)._kv?.[contractID]?.[key]
    const reload = () => sbp('chelonia/kv/_loadSlotNow', {
      contractID,
      slot,
      reason: KV_UPDATE_REASON.LOAD,
      suppressLoadingStatus: true,
      preserveStatusOnError: true
    })
    // Left by the last failed attempt for the next one
    let afterClean409 = false
    let aheadEtag: string | undefined
    // Basis and write share one lane turn, so each write sees the etag the last
    // one left. `forced`: re-run after a `KV_NOOP` on a never-loaded basis.
    const write = async (
      attempt: SlotWriteAttempt,
      forced = false
    ): Promise<JSONType | undefined> => {
      const { heightWaitMs, recoveries, signal } = attempt
      assertCurrent()
      const entry = liveEntry()
      const holdsAheadValue = aheadEtag !== undefined &&
        entry?.status === KV_LOAD_STATUS.LOADED && entry.etag === aheadEtag
      // After a height recovery the mirror may lack the value found ahead; a
      // clean 409 only meant a stale stamp
      const recovered = recoveries > 0 && !afterClean409 && !holdsAheadValue
      afterClean409 = false
      const unverified = !!entry && basisUnverified(this, contractID, key, entry)
      const unsettled = !!entry && (entry.settled !== true ||
        (entry.status === KV_LOAD_STATUS.ERROR && entry.value === undefined))
      const needed = recovered || unverified || forced || (unsettled && ifMatch !== undefined)
      // Data-loss guard: the retained value may be outdated
      const reloaded = needed ||
        (entry?.status === KV_LOAD_STATUS.ERROR && entry.value !== undefined)
      let reloadFailure: { error: unknown } | undefined
      if (reloaded) {
        let foundAhead = false
        try {
          await reload().catch(async (e: unknown) => {
            const requiredHeight = kvHeightAheadCause(e)?.requiredHeight
            // Only the last 'sync' attempt waits, once, for the height
            if (typeof requiredHeight !== 'number' || heightWaitMs === 0) throw e
            foundAhead = true
            if (!(await waitForHeight(this, contractID, requiredHeight, { signal }))) throw e
            assertCurrent()
            await reload()
          })
        } catch (e) {
          if (signal.aborted) throw abortReason(signal)
          if (isKvHeightAhead(e) || !slotIsCurrent(this, contractID, slot) || unverified ||
              ifMatch !== undefined) throw e
          console.warn(`[chelonia/kv] ${label}: reload failed; the reducer runs on the mirror`, e)
          // A `KV_NOOP` on a basis known to be stale can't claim nothing needed writing
          if (needed || foundAhead) reloadFailure = { error: e }
        }
        if (signal.aborted) throw abortReason(signal)
        assertCurrent()
      }
      const mirrorEntry = liveEntry()
      const seedValue = computeSeedValue(slot, mirrorEntry, reloaded)
      let reducerOut: unknown
      try {
        reducerOut = reducer(seedValue)
      } catch (e) {
        throw new ChelErrorKvUpdateInvalid(
          `[chelonia/kv] update: ${contractID}::${key} reducer threw`,
          { cause: e }
        )
      }
      const firstResult = validateReducerOutput(slot, reducerOut, contractID, key, '')
      if (firstResult.noop) {
        // The server may hold a value the reducer would change
        if (unsettled && !reloaded) return write(attempt, true)
        if (reloadFailure) throw reloadFailure.error
        return undefined
      }
      let nextValue: JSONType = firstResult.value
      if (signal.aborted) throw abortReason(signal)
      let sawConflict = false
      const onconflict = async (conflictArgs: {
        currentData: JSONType | undefined;
        etag: string | null | undefined;
      }): Promise<[JSONType, string | undefined]> => {
        const { etag } = conflictArgs
        sawConflict = true
        if (signal.aborted) throw abortReason(signal)
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
        if (currentData == null) {
          basis = slot.resolvedDefault !== undefined
            ? cloneDeep(slot.resolvedDefault)
            : undefined
        } else if (slot.schema) {
          try {
            // Cloned so that a mutating reducer can't change `kv/set`'s cached
            // decode, which the conflict cause reuses
            basis = cloneDeep(
              parseSyncSlotValue(slot, currentData, `update onconflict currentData ${contractID}::${key}`)
            )
          } catch (e) {
            throw new ChelErrorKvValidation(
              `[chelonia/kv] update: ${contractID}::${key} server ` +
              'currentData failed schema.parse on conflict retry',
              { cause: e }
            )
          }
        } else {
          try {
            basis = cloneDeep(
              assertJsonShape(currentData, `update onconflict currentData ${contractID}::${key}`)
            )
          } catch (e) {
            throw new ChelErrorKvValidation(
                `[chelonia/kv] update: ${contractID}::${key} server ` +
                'currentData is not JSON-shaped on conflict retry',
                { cause: e }
            )
          }
        }
        let retried: unknown
        try {
          retried = reducer(basis)
        } catch (e) {
          throw new ChelErrorKvUpdateInvalid(
            `[chelonia/kv] update: ${contractID}::${key} reducer threw on retry`,
            { cause: e }
          )
        }
        const retryResult = validateReducerOutput(slot, retried, contractID, key, 'on retry')
        if (retryResult.noop) throw new KvNoopAbort()
        nextValue = retryResult.value
        return [nextValue, typeof etag === 'string' ? etag : undefined]
      }
      const seen = heightWaitSnapshot(this, contractID, key)
      let etag: string | null
      try {
        ;({ etag } = await sbp('chelonia/kv/set', contractID, key, nextValue, {
          // With no etag, `kv/set` sends `if-match: ""`: a value this client
          // never read then comes back as a 412 to merge, not overwritten
          ifMatch: ifMatch ?? mirrorEntry?.etag ?? undefined,
          // Resolved now, to use keys rotated while the write was queued
          ...resolveKvKeyIds(contractID, slot, label),
          onconflict,
          maxAttempts,
          heightWaitMs,
          signal
        }) as { etag: string | null })
      } catch (e) {
        // The reducer returned `KV_NOOP` on a conflict retry (marker, not
        // `instanceof`, to work across copies of this module)
        if (e && typeof e === 'object' && KV_NOOP_ABORT_SYMBOL in e) return undefined
        afterClean409 = kvHeightAheadCause(e)?.exact === false && !sawConflict
        throw isKvMaxAttempts(e) ? slotConflictError(slot, contractID, label, e) : e
      }
      await commitSlotWrite(this, contractID, slot, seen, {
        value: nextValue, etag, sawConflict, operation: 'update'
      })
      return nextValue
    }
    return runSlotWrite(this, contractID, slot, args, label, (attempt) =>
      write(attempt).catch((e: unknown) => {
        aheadEtag = kvHeightAheadCause(e)?.etag ?? undefined
        throw e
      })
    )
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
    if (!entry || entry.value === undefined || entry.status === KV_LOAD_STATUS.ERROR) {
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
  // the rejection semantics of `chelonia/kv/update`. Like `update`, it
  // recovers from a value the contract can't verify yet.
  //
  // Aggregate form (no `key`) — dispatches loads for every entry in the
  // last-reconciled active-slot index (`kvSlotsByContractID[contractID]`).
  // The loads are still serialized on the per-contract queue inside
  // `_loadSlot`, and per-slot failures surface via status/events while
  // the aggregate promise resolves after every load settles.
  'chelonia/kv/sync': async function (
    this: CheloniaContext,
    contractID: string,
    key?: string,
    options: KvHeightRecoveryOptions = {}
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (key !== undefined) {
      const slot = resolveActiveSlot(this, rootState, contractID, key, 'sync')
      // Reject a sync re-entered from this contract's own onUpdate
      // callback — `_loadSlot` enqueues on the same lane → deadlock.
      assertNotReentrant(this, contractID, key, 'sync')
      return syncSlot(this, contractID, slot, options)
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
    // Reject a re-entrant aggregate sync at the only point a deadlock
    // could occur (just before dispatching loads on the shared lane).
    // The early returns above can't deadlock — no load is dispatched.
    assertNotReentrant(this, contractID, '*', 'sync')
    const slots = Array.from(perKey.values())
    await Promise.all(slots.map((slot) =>
      sbp('chelonia/kv/_loadSlot', { contractID, slot, reason: KV_UPDATE_REASON.LOAD })
        .catch((e: unknown) => {
          // Aggregate form never rejects (§4.4), but log rejections so
          // failed syncs are debuggable — matching the fire-and-forget
          // loads in `_reconcileForSlot` / `_onContractResynced`.
          logLoadRejection(`aggregate sync: _loadSlot rejected for ${contractID}::${slot.key}`, e)
        })
    ))
  },

  // Public. See KV-REVAMPED §4.5. Writes the clear sentinel (`null`) on the
  // contract's lane over whatever the server holds, even an unverifiable value.
  'chelonia/kv/clear': async function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    options: { maxAttempts?: number | null; signal?: AbortSignal } & KvHeightRecoveryOptions = {}
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'clear')
    assertNotReentrant(this, contractID, key, 'clear')
    const label = `clear: ${contractID}::${key}`
    const { maxAttempts } = options
    assertMaxAttempts(maxAttempts, label)
    const write = async ({ heightWaitMs, signal }: SlotWriteAttempt): Promise<void> => {
      if (!slotIsCurrent(this, contractID, slot)) {
        throw new ChelErrorKvSlotUnknown(
          `[chelonia/kv] clear: no active slot for ${contractID}::${key}`
        )
      }
      let sawConflict = false
      // Never reads `currentData`: the server value doesn't matter
      const onconflict = async ({ etag }: { etag: string | null | undefined }) => {
        sawConflict = true
        return [null, typeof etag === 'string' ? etag : undefined] as [null, string | undefined]
      }
      const liveState = sbp(this.config.stateSelector) as ChelRootState
      const mirrorEtag = liveState._kv?.[contractID]?.[key]?.etag
      const seen = heightWaitSnapshot(this, contractID, key)
      let etag: string | null
      try {
        ;({ etag } = await sbp('chelonia/kv/set', contractID, key, null, {
          ifMatch: mirrorEtag ?? undefined,
          ...resolveKvKeyIds(contractID, slot, label),
          onconflict,
          allowUnverifiedConflict: true,
          maxAttempts,
          heightWaitMs,
          signal
        }) as { etag: string | null })
      } catch (e) {
        throw isKvMaxAttempts(e) ? slotConflictError(slot, contractID, label, e) : e
      }
      await commitSlotWrite(this, contractID, slot, seen, {
        value: undefined, etag, sawConflict, operation: 'clear'
      })
    }
    return runSlotWrite(this, contractID, slot, options, label, write)
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
      if (!active) return KV_LOAD_STATUS.NON_INIT
      const entry = rootState._kv?.[contractID]?.[key]
      return entry?.status ?? KV_LOAD_STATUS.NON_INIT
    }
    // Aggregate: precedence error > loading > non-init > loaded.
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey || perKey.size === 0) return KV_LOAD_STATUS.NON_INIT
    const perContract = rootState._kv?.[contractID]
    let sawLoading = false
    let sawNonInit = false
    for (const slotKey of perKey.keys()) {
      const status = perContract?.[slotKey]?.status ?? KV_LOAD_STATUS.NON_INIT
      if (status === KV_LOAD_STATUS.ERROR) return KV_LOAD_STATUS.ERROR
      if (status === KV_LOAD_STATUS.LOADING) sawLoading = true
      else if (status === KV_LOAD_STATUS.NON_INIT) sawNonInit = true
    }
    if (sawLoading) return KV_LOAD_STATUS.LOADING
    if (sawNonInit) return KV_LOAD_STATUS.NON_INIT
    return KV_LOAD_STATUS.LOADED
  },

  'chelonia/kv/settledStatus': function (
    this: CheloniaContext,
    contractID: string,
    key: string
  ): SettledStatus | undefined {
    return settledStatusOf(this, contractID, key)
  },

  // Resolves with what `settledStatus` reports once it is defined
  'chelonia/kv/whenSettled': async function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    { signal }: { signal?: AbortSignal | null } = {}
  ): Promise<SettledStatus> {
    if (signal?.aborted) throw abortReason(signal)
    const status = settledStatusOf(this, contractID, key)
    if (status) return status
    const target = `${contractID}${KV_KEY_SEPARATOR}${key}`
    if (!slotDefinedFor(this, contractID, key)) {
      throw new ChelErrorKvSlotUnknown(`[chelonia/kv] whenSettled: no slot is defined for ${target}`)
    }
    if (this.kvReconciledContracts.has(contractID) &&
        !this.kvSlotsByContractID.get(contractID)?.has(key)) {
      throw new ChelErrorKvSlotUnknown(
        `[chelonia/kv] whenSettled: ${target} isn't active for its contract`
      )
    }
    assertNotReentrant(this, contractID, key, 'whenSettled')
    // A reset replaces the map (rejecting this one's waiters)
    const settleWaiters = this.kvSettleWaiters
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const waiters = settleWaiters.get(target)
        waiters?.delete(waiter)
        if (waiters?.size === 0) settleWaiters.delete(target)
        reject(abortReason(signal!))
      }
      const waiter = {
        resolve: (settled: SettledStatus) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(settled)
        },
        reject: (e: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        }
      }
      let waiters = settleWaiters.get(target)
      if (!waiters) settleWaiters.set(target, (waiters = new Set()))
      waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },

  // Private convenience used by `chelonia/defineContract`. Accepts the
  // `kv: { ... }` block declared inline on a contract definition and
  // registers each entry as a `defineSlot` call scoped to the contract
  // type (the contract name stored in `state.contracts[cID].type`).
  // The manifest is retained as the ownership marker used by cleanup.
  // See KV-REVAMPED.md §4.8 / §11.3 step 7.
  'chelonia/kv/_registerContractSlots': function (
    this: CheloniaContext,
    contractType: string,
    manifest: string,
    kv: Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>
  ): void {
    for (const key of Object.keys(kv)) {
      const entry = kv[key]
      sbp('chelonia/kv/_defineSlotInternal', {
        ...entry,
        contractType,
        key
      }, { kind: 'defineContract' as const, manifest })
    }
  },

  // Private. See KV-REVAMPED.md §11.3 step 8. Diffs `prevKv` vs
  // `nextKv` for `manifest`; for every key present in `prevKv` but not
  // in `nextKv`, unregister the slot from `kvSlots`, scrub it from
  // every `kvSlotsByContractID[cID]` and `kvActiveFilters[cID]`,
  // queue a filter flush, and drop the corresponding
  // `rootState._kv[cID][key]` mirror entry. Two passes drop the mirror
  // entry: the index walk covers subscribed/reconciled contracts, and a
  // second `_kv` walk covers non-subscribed contracts whose persisted
  // entries were seeded by `_defineSlotInternal` and never entered the
  // index (skipping entries whose contract type can't be confirmed).
  // Keys present in both blocks are left to the normal `defineSlot`
  // re-registration path (which re-validates persisted mirror values
  // against the new schema — §4.1).
  'chelonia/kv/_cleanupContractSlots': function (
    this: CheloniaContext,
    contractType: string,
    manifest: string,
    prevKv: Record<string, unknown> | undefined,
    nextKv: Record<string, unknown> | undefined
  ): void {
    if (!prevKv) return
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const nextKeys = nextKv ? new Set(Object.keys(nextKv)) : new Set<string>()
    for (const key of Object.keys(prevKv)) {
      if (nextKeys.has(key)) continue
      const rKey = registryKey(contractType, key)
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
        this.kvLocalEchoCIDs.delete(`${cID}${KV_KEY_SEPARATOR}${key}`)
        cancelHeightWaits(this, cID, key)
      }
      // The index loop above only covers contracts in `kvSlotsByContractID`
      // (subscribed/reconciled ones). `_defineSlotInternal` also persists /
      // re-validates `_kv[cID][key]` entries for contracts NOT in
      // `subscriptionSet` (e.g. carried over from a prior session, not yet
      // re-synced); those never enter the index, so the loop above leaves
      // them behind. Walk the mirror directly and drop matching entries so
      // unregistering the slot doesn't leak persisted state (and doesn't
      // trip `_assertIndexConsistent` once the contract re-syncs).
      // Entries whose contract type can't be confirmed to match are left
      // alone — re-validating/deleting against the wrong type would clobber
      // foreign data; the next sync's load/reconcile reconciles them.
      if (rootState._kv) {
        for (const cID of Object.keys(rootState._kv)) {
          if (this.subscriptionSet.has(cID)) continue
          if (getContractType(rootState, cID) !== contractType) continue
          const perContract = rootState._kv[cID]
          if (!perContract || !perContract[key]) continue
          this.config.reactiveDel(perContract, key)
          if (Object.keys(perContract).length === 0) {
            this.config.reactiveDel(rootState._kv, cID)
          }
          this.kvLocalEchoCIDs.delete(`${cID}${KV_KEY_SEPARATOR}${key}`)
        }
      }
    }
    endUndefinedSettleWaits(this)
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
    const targets: string[] = contractID !== undefined
      ? (this.subscriptionSet.has(contractID) ? [contractID] : [])
      : Array.from(this.subscriptionSet)
    for (const cID of targets) reconcileContract(this, cID)
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
//
// Concurrency note: the synchronous re-parse + status flip below run
// directly from `_defineSlotInternal` (OUTSIDE the per-contract
// `chelonia/queueInvocation` lane) so a slot transitioning out of
// `'error'` clears promptly and the dev index invariant holds. But the
// *mirror value mutation* + `CHELONIA_KV_UPDATED` + `onUpdate` for a
// coercing schema (`changed === true`) are routed THROUGH the lane:
// re-seeding the mirror inline could clobber a value an in-flight
// `update`/`_handleRemote` is about to (or just did) write, diverging
// the mirror from the server and reordering `onUpdate`. Inside the lane
// we re-read the live entry and bail unless it still holds the value we
// re-parsed, so a write that landed first wins. The common idempotent
// case (`changed === false`) stays fully synchronous and emits nothing.
function revalidateMirrorEntry (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  slot: SlotDefinition
): void {
  const entry = rootState._kv?.[contractID]?.[slot.key]
  if (!entry || entry.value === undefined) return
  const previousValue = entry.value
  // Capture before any status flip below. §4.1 requires a successful
  // re-validation to fire CHELONIA_KV_UPDATED even when the value is
  // structurally unchanged, specifically so listeners observing
  // transitions out of 'error' can react.
  const priorStatus = entry.status
  // Clone before parse so a mutating custom `{ parse }` validator can't
  // corrupt the live mirror value in place (bypassing `reactiveSet` and
  // the "value and etag move together" invariant). Every other parse
  // call site already passes a non-mirror value; this is the lone
  // exception. The original `previousValue` reference is retained for the
  // change comparison and event payloads below.
  const parseInput = (previousValue !== null && typeof previousValue === 'object')
    ? cloneDeep(previousValue)
    : previousValue
  // Hoisted out of the `try` so the catch path can branch on it (Issue 4:
  // defer the ERROR stamp through the lane when a write is in flight,
  // symmetric with the success path's deferral of the LOADED flip).
  const hasInflight = (ctx.kvPendingWrites.get(contractID) ?? 0) > 0
  try {
    const parsed = slot.schema
      ? parseSyncSlotValue(slot, parseInput, `re-validate ${contractID}::${slot.key}`)
      : assertJsonShape(parseInput, `re-validate ${contractID}::${slot.key}`)
    // §4.1: a successful re-validation must fire CHELONIA_KV_UPDATED with
    // reason 'load' even when the parsed value is structurally identical
    // to the previous mirror value, so listeners observing transitions
    // out of 'error' can react. `recoveredFromError` distinguishes the
    // error-recovery case (emit) from the boot-idempotent case (status
    // was already 'loaded' → suppress, avoiding spurious events on every
    // boot re-validation). A coercing schema that genuinely transforms
    // the stored value still emits via `changed`. Status is always
    // restored to 'loaded' so a slot transitioning out of 'error' clears
    // its `lastError` (patchEntry suppresses the no-op event).
    const changed = !deepEqualJSONType(parsed, previousValue)
    const recoveredFromError = priorStatus === KV_LOAD_STATUS.ERROR
    const shouldEmit = changed || recoveredFromError
    // Status flip placement: when no write is in flight for this contract,
    // flip synchronously so a slot leaving 'error' clears its `lastError`
    // promptly (the common boot/HMR case). When a write IS in flight (paused
    // at an await inside the lane), a synchronous flip would interleave a
    // misleading 'loaded' between the in-flight op's own status transitions;
    // defer it into the lane so it serialises behind that op instead.
    //
    // Exception (Issue 5): when a coercion is pending for an INDEXED
    // contract with no in-flight write, the value mutation is routed
    // through the lane (atomicity with queued lane work, see the lane
    // branch below). Flipping status synchronously here while deferring
    // the value would open a microtask window where `read()` (keyed on
    // `status !== 'error'`) returns the pre-coercion value while `status`
    // already reports 'loaded'. `deferStatusFlip` makes the status flip
    // ride the same lane callback so the two move atomically. The
    // non-indexed inline branch applies both synchronously (atomic
    // already), and the `!changed` case has no value change to desync
    // against, so those keep the prompt sync flip.
    const isIndexed = ctx.kvSlotsByContractID.get(contractID)?.has(slot.key) === true
    const deferStatusFlip = changed && isIndexed
    if (!hasInflight && !deferStatusFlip) {
      patchEntry(ctx, contractID, slot, { status: KV_LOAD_STATUS.LOADED })
    }
    // A non-subscribed contract (persisted mirror entry from a prior session,
    // re-validated by the `_defineSlotInternal` non-subscribed loop) has no
    // lane and no possible in-flight write — writes require the slot to be
    // indexed. Route the coercion INLINE instead of through `queueInvocation`,
    // whose slot-identity guard (`kvSlotsByContractID.get(cID)?.get(key)`)
    // would always bail for a non-indexed contract and silently drop the
    // coerced value. The synchronous status flip above already ran; `onUpdate`
    // is intentionally skipped here (it is lane-serialised for indexed slots)
    // and will fire on the next sync when the contract re-indexes.
    if (shouldEmit && !isIndexed && !hasInflight) {
      const live = rootState._kv?.[contractID]?.[slot.key]
      if (live && deepEqualJSONType(live.value, previousValue)) {
        // Skip the reactiveSet when the value is structurally unchanged
        // (error-recovery with identical value) — avoid a spurious
        // reference swap in reactive systems while still emitting UPDATED.
        if (changed) ctx.config.reactiveSet(live, 'value', parsed)
        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          value: cloneForEmit(changed ? parsed : previousValue),
          previousValue: cloneForEmit(previousValue),
          reason: KV_UPDATE_REASON.LOAD,
          etag: live.etag
        })
      }
    } else if (shouldEmit || hasInflight) {
      // A coercing schema's mirror mutation + events go through the lane so
      // they serialise behind any in-flight write for this contract and
      // never clobber a newer value. Re-check slot identity and that the
      // live entry still holds `previousValue` before applying. A deferred
      // status flip (hasInflight, or deferStatusFlip for an indexed coercion)
      // also runs here, behind the in-flight op / alongside the value.
      sbp('chelonia/queueInvocation', contractID, () => {
        if (ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) return
        if (hasInflight || deferStatusFlip) {
          patchEntry(ctx, contractID, slot, { status: KV_LOAD_STATUS.LOADED })
        }
        if (!shouldEmit) return
        const live = rootState._kv?.[contractID]?.[slot.key]
        if (!live || !deepEqualJSONType(live.value, previousValue)) return
        if (changed) ctx.config.reactiveSet(live, 'value', parsed)
        const emitValue = changed ? parsed : previousValue
        sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          value: cloneForEmit(emitValue),
          previousValue: cloneForEmit(previousValue),
          reason: KV_UPDATE_REASON.LOAD,
          etag: live.etag
        })
        // safeOnUpdateGuarded catches its own errors, so awaiting it only
        // sequences the callback within the lane.
        return safeOnUpdateGuarded(ctx, contractID, slot, cloneForEmit(emitValue), {
          contractID,
          contractType: slot.contractType,
          key: slot.key,
          reason: KV_UPDATE_REASON.LOAD,
          etag: live.etag,
          previousValue: cloneForEmit(previousValue)
        })
      }).catch((e: unknown) => {
        console.error(
          `[chelonia/kv] re-validate enqueue failed for ${contractID}::${slot.key}`, e
        )
      })
    }
  } catch (e) {
    sbp('okTurtles.events/emit', CHELONIA_KV_VALIDATION_ERROR, {
      contractID,
      contractType: slot.contractType,
      key: slot.key,
      error: e,
      reason: KV_VALIDATION_REASON_REVALIDATE
    })
    // Symmetric with the success path's `hasInflight` deferral in
    // `revalidateMirrorEntry` (the `!hasInflight && !deferStatusFlip`
    // branch): when a write holds the lane, a synchronous ERROR flip
    // would interleave with the in-flight op's own status transitions.
    // Defer through the lane so the ERROR stamp serialises behind that
    // write, matching how the success path defers its LOADED flip. The
    // `VALIDATION_ERROR` event above still fires synchronously because it
    // is diagnostic and does not mutate state.
    if (hasInflight) {
      sbp('chelonia/queueInvocation', contractID, () => {
        if (ctx.kvSlotsByContractID.get(contractID)?.get(slot.key) !== slot) return
        // Re-check the LIVE mirror value before stamping ERROR (#5),
        // mirroring the success path's `deepEqualJSONType` guard. The
        // parse failed against `previousValue`; if an interleaving op on
        // this lane (e.g. `_handleRemote` writing a fresh, valid value)
        // changed the mirror while we awaited the lane, the value we
        // judged invalid is gone and stamping ERROR would wrongly mark a
        // now-valid slot. Only stamp when the live value still matches the
        // one that failed to parse.
        const live = rootState._kv?.[contractID]?.[slot.key]
        if (!live || !deepEqualJSONType(live.value, previousValue)) return
        patchEntry(ctx, contractID, slot, {
          status: KV_LOAD_STATUS.ERROR, lastError: normalizeError(e)
        })
      }).catch((err: unknown) => {
        console.error(
          `[chelonia/kv] re-validate ERROR flip enqueue failed for ${contractID}::${slot.key}`, err
        )
      })
    } else {
      patchEntry(ctx, contractID, slot, {
        status: KV_LOAD_STATUS.ERROR, lastError: normalizeError(e)
      })
    }
  }
}

// Public re-exports from kv-constants.js
export {
  KV_AUTO_LOAD,
  KV_DEFAULT_ENCRYPTION_KEY_NAME,
  KV_DEFAULT_SIGNING_KEY_NAME,
  KV_LOAD_STATUS,
  KV_NOOP,
  KV_UPDATE_REASON,
  KV_VALIDATION_REASON_REVALIDATE
} from './kv-constants.js'
export type { KvNoop } from './kv-constants.js'
