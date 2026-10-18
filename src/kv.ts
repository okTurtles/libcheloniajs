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
  ChelErrorKvHeightAhead,
  ChelErrorKvReentrant,
  ChelErrorKvSlotInvalid,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorKvValidation,
  ChelErrorUnexpected,
  isKvConflict,
  isKvHeightAhead,
  kvHeightAheadCause
} from './errors.js'
import { objectCause } from './error-names.js'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
import { isKvMaxAttempts } from './internal-errors.js'
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
import {
  abortReason,
  addHeightListener,
  assertValidMaxAttempts,
  clearHeightWaits,
  clearWaitTimer,
  dropHeightWait,
  isHeightReached,
  kvHeightAheadMessage,
  kvHeightTimings,
  localContractHeight,
  notifyContractHeight,
  pubsubSocketNotOpen,
  queueAbortable,
  raceAbort,
  recoverContractHeight,
  resolveHeightRecoveryOptions,
  setKvHeightTimings,
  throwIfAborted,
  throwIfAnyAborted,
  waitForContractHeight,
  withHeightRecovery,
  type KvHeightTimingOverrides
} from './kv-height.js'
import type {
  ChelKvGetResult,
  CheloniaContext,
  ChelRootState,
  ContractsModifiedChange,
  JSONType,
  KvHeightAheadCause,
  KvHeightAheadMode,
  KvConflictCause,
  KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions,
  KvHeightWait,
  KvLoadStatus,
  KvMirrorEntry,
  KvServerValueStatus,
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

// `a::b`. Keys of different maps share this format: see `registryKey`
// (contract type and slot key), and the contract ID and slot key of
// `heightWaitKey`, `kvLocalEchoCIDs` and `kvSettleWaiters`.
const joinKey = (a: string, b: string): string => `${a}${KV_KEY_SEPARATOR}${b}`

const registryKey = (contractType: string, key: string): string =>
  joinKey(contractType, key)

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

function resolveSlotKeyIds (
  contractID: string,
  key: string,
  slot: SlotDefinition,
  operation: 'update' | 'clear'
): { encryptionKeyId: string | null; signingKeyId: string } {
  const encryptionKeyId = slot.encryptionKeyName === null
    ? null
    : sbp('chelonia/contract/currentKeyIdByName', contractID, slot.encryptionKeyName)
  const signingKeyId = sbp('chelonia/contract/currentKeyIdByName', contractID, slot.signingKeyName)
  if (slot.encryptionKeyName !== null && !encryptionKeyId) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${operation}: ${contractID}::${key} — encryption key ` +
      `'${slot.encryptionKeyName}' not found on contract; refusing to write plaintext`
    )
  }
  if (!signingKeyId) {
    throw new ChelErrorKvUpdateInvalid(
      `[chelonia/kv] ${operation}: ${contractID}::${key} — signing key ` +
      `'${slot.signingKeyName}' not found on contract`
    )
  }
  return { encryptionKeyId, signingKeyId }
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
//  - `reloadRan`: after a reload in `update` (e.g. the data-loss
//    guard's, which restores `'error'` if it fails), the
//    mirror holds the live server value (success) or the retained
//    value (failure), both paired with the etag the write will send —
//    so seed from it, falling back to the default only when `undefined`.
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
// should follow `setSlotStatus`'s non-destructive pattern
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

// Emit a `CHELONIA_KV_STATUS_CHANGED` event after writing status / lastError
// onto the mirror entry. Skips the emit only when status, lastError, the
// `settled` flag and the `heightAhead` marker are all unchanged. `lastError`
// is the entry's new one (none when omitted). `settle` marks a terminal
// outcome (see `KvMirrorEntry.settled`); once set, `settled` stays `true`
// until the slot is re-activated. `heightAhead` sets the entry's marker to
// that height (`null` clears it; `undefined`, the default, leaves it as
// is), see `setHeightAhead`.
type SlotStatusOptions = {
  lastError?: { name: string; message: string };
  settle?: boolean;
  heightAhead?: number | null;
}

function setSlotStatus (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  contractType: string,
  key: string,
  status: KvLoadStatus,
  { lastError, settle = false, heightAhead }: SlotStatusOptions = {}
): void {
  // Check-then-create: read the entry WITHOUT forcing creation of the
  // `_kv[contractID]` record. `ensureContractKv` would create that record
  // before the existence check below, leaving an orphaned empty record in
  // prod when the per-key entry is missing. Every legitimate caller seeds
  // the entry (and thus the record) first, so reading non-destructively is
  // safe here.
  const entry = rootState._kv?.[contractID]?.[key]
  if (!entry) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `[chelonia/kv] setSlotStatus called for ${contractID}::${key} before ` +
        'the mirror entry was seeded'
      )
    }
    return
  }
  const previousStatus = entry.status
  const statusUnchanged = previousStatus === status
  // `lastErrorChanged` detects a structural difference (name or message)
  // between the new and old error objects. It is false when both sides
  // carry an error with identical content AND when neither side has an
  // error. Those two cases are disambiguated by the early return below:
  // when the status is also unchanged we skip the event and reactivity
  // entirely (identical-error repeat or plain no-op); only a genuine
  // change in status or error content falls through to mutate the entry.
  const lastErrorChanged =
    !!lastError !== !!entry.lastError ||
    (lastError && entry.lastError &&
      (lastError.name !== entry.lastError.name ||
       lastError.message !== entry.lastError.message))
  const previousSettled = entry.settled === true
  const settled = previousSettled || settle
  const previousHeightAhead = entry.heightAhead?.requiredHeight
  const nextHeightAhead = heightAhead === undefined
    ? previousHeightAhead
    : heightAhead ?? undefined
  const heightAheadChanged = nextHeightAhead !== previousHeightAhead
  // Status, error content, `settled` and `heightAhead` all unchanged →
  // nothing to do. A repeated identical validation error therefore emits
  // no CHELONIA_KV_STATUS_CHANGED; the diagnostic
  // CHELONIA_KV_VALIDATION_ERROR is emitted separately by the caller and
  // still fires every time.
  if (
    statusUnchanged && !lastErrorChanged && settled === previousSettled && !heightAheadChanged
  ) return
  if (!statusUnchanged) {
    ctx.config.reactiveSet(entry, 'status', status)
  }
  if (!lastError && entry.lastError) {
    ctx.config.reactiveDel(entry as unknown as Record<string, unknown>, 'lastError')
  } else if (lastError) {
    ctx.config.reactiveSet(entry, 'lastError', lastError)
  }
  if (settled !== previousSettled) {
    ctx.config.reactiveSet(entry, 'settled', settled)
  }
  if (heightAheadChanged) {
    if (nextHeightAhead === undefined) {
      ctx.config.reactiveDel(entry as unknown as Record<string, unknown>, 'heightAhead')
    } else {
      ctx.config.reactiveSet(entry, 'heightAhead', { requiredHeight: nextHeightAhead })
    }
  }
  emitStatusChanged(contractID, contractType, key, {
    status, previousStatus, lastError, settled, previousSettled, heightAhead: nextHeightAhead
  })
}

// Emits the `CHELONIA_KV_STATUS_CHANGED` of a change that was just written
// onto a mirror entry.
function emitStatusChanged (
  contractID: string,
  contractType: string,
  key: string,
  {
    status, previousStatus, lastError, settled, previousSettled, heightAhead
  }: {
    status: KvLoadStatus;
    previousStatus: KvLoadStatus;
    lastError: { name: string; message: string } | undefined;
    settled: boolean;
    previousSettled: boolean;
    heightAhead: number | undefined;
  }
): void {
  sbp('okTurtles.events/emit', CHELONIA_KV_STATUS_CHANGED, {
    contractID,
    contractType,
    key,
    status,
    previousStatus,
    // Representation note: the EVENT always carries `lastError` —
    // normalized to `null` when there is no error — whereas the mirror
    // ENTRY omits the property entirely when absent (`lastError?` is
    // optional on `KvMirrorEntry`, and is `reactiveDel`'d above). This is
    // intentional and is asserted by tests: an event listener reads
    // `event.lastError === null` for "no error", while a mirror reader
    // sees `entry.lastError === undefined`. Code diffing the two
    // representations must treat `null` (event) and `undefined` (entry) as
    // equivalent "no error". `heightAhead` follows the same convention.
    ...(lastError ? { lastError } : { lastError: null }),
    settled,
    previousSettled,
    heightAhead: heightAhead === undefined ? null : { requiredHeight: heightAhead }
  })
}

// (Re)activation of a slot whose entry exists (e.g. persisted by a
// previous session): nothing has been confirmed from the server in this
// activation yet, so the entry is no longer `settled`. Announced, with its
// status unchanged, so that external stores (`chelonia/externalStateSetup`)
// don't keep `settled: true`. Silent for an entry that wasn't settled. An
// entry persisted mid-load (`'loading'`) first goes `'loaded'` when it
// holds a value, and `'non-init'` when it doesn't: no load of this
// activation can be running yet, and a `'loading'` slot that nothing loads
// would never settle (the paths that settle a slot leave a `'loading'` one
// to the load in flight).
function unsettleSlot (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  contractType: string,
  key: string
): void {
  const entry = rootState._kv?.[contractID]?.[key]
  if (!entry) return
  const previousSettled = entry.settled === true
  if (entry.settled !== false) ctx.config.reactiveSet(entry, 'settled', false)
  if (entry.status === KV_LOAD_STATUS.LOADING) {
    setSlotStatus(
      ctx, rootState, contractID, contractType, key,
      entry.value !== undefined ? KV_LOAD_STATUS.LOADED : KV_LOAD_STATUS.NON_INIT
    )
    return
  }
  if (!previousSettled) return
  emitStatusChanged(contractID, contractType, key, {
    status: entry.status,
    previousStatus: entry.status,
    lastError: entry.lastError,
    settled: false,
    previousSettled,
    heightAhead: entry.heightAhead?.requiredHeight
  })
}

// Records on the mirror entry that the server holds a value written at
// `requiredHeight`, which the local contract hasn't reached
// (`KvMirrorEntry.heightAhead`), or clears that (`undefined`). Only
// touches an existing entry, and only on change, keeping its status and
// `lastError`. The change is announced with `CHELONIA_KV_STATUS_CHANGED`,
// with the status unchanged: that event is what
// `chelonia/externalStateSetup` copies into an app's store.
function setHeightAhead (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  requiredHeight: number | undefined
): void {
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  const entry = rootState._kv?.[contractID]?.[key]
  if (!entry || entry.heightAhead?.requiredHeight === requiredHeight) return
  const contractType = ctx.kvSlotsByContractID.get(contractID)?.get(key)?.contractType ??
    getContractType(rootState, contractID) ?? ''
  setSlotStatus(ctx, rootState, contractID, contractType, key, entry.status, {
    lastError: entry.lastError, heightAhead: requiredHeight ?? null
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

// Throws `ChelErrorKvSlotUnknown` unless `slot` is still the active slot of
// `(contractID, key)`. A write checks it on the lane, and after each await
// there before it calls `kv/set`: the slot may have been replaced or
// deactivated meanwhile. Once `kv/set` resolved, the write committed and
// nothing throws: `commitSlotWrite` skips applying it to a slot that is no
// longer active.
function assertSlotActive (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  op: 'update' | 'clear'
): void {
  if (!slotIsCurrent(ctx, contractID, slot)) {
    throw new ChelErrorKvSlotUnknown(
      `[chelonia/kv] ${op}: no active slot for ${contractID}::${slot.key}`
    )
  }
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
  const echoKey = joinKey(contractID, key)
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

// Per-contract pending-write counter. `chelonia/kv/update` and
// `chelonia/kv/clear` increment this at call time (before their queued
// body runs), and `runSlotWrite` decrements it once the whole write has
// settled, height recoveries included (its `.finally`). The
// counter is the third source for `chelonia/kv/_waitInFlight` so a
// write whose slot index entry and echo CID have both been removed
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

// Per-contract pending-load counter. Incremented by both `_loadSlot`
// (on schedule, to cover the queued-but-not-started window) and
// `_loadSlotNow` (on entry, to cover direct callers like `_handleRemote`
// and `update`'s inline reloads). A load that flows `_loadSlot` →
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

// ---------------------------------------------------------------------------
// Height-deferred loads (KV-REVAMPED.md §3.4 / §4.9)
//
// A load or pubsub frame that returns a value written at a contract height
// the local contract has not reached is not a failure: the slot keeps its
// current value, and reloads once the contract reaches that height. A
// `'non-init'` slot goes `'loading'` meanwhile: its server value isn't
// absent. If the height isn't reached within `pendingFallbackMs`, the
// contract is force-synced; if it is still behind after that, the slot
// settles (a loaded slot keeps its value, any other slot goes to `'error'`)
// and its wait is parked, not dropped: the slot still reloads if the
// contract reaches the height later, and until then `update` doesn't use
// its mirror as a basis (see `parkHeightWait`, `mirrorBasisUnverified`).
// ---------------------------------------------------------------------------

const heightWaitKey = (contractID: string, key: string): string =>
  joinKey(contractID, key)

// Background loads (autoload, reconnect refresh, deferred reloads) only log
// their rejections. A height-ahead rejection is expected and already
// handled by a deferred reload, so it is logged at debug level.
function logBackgroundLoadRejection (message: string, e: unknown): void {
  if (isKvHeightAhead(e)) {
    console.debug(`${message} (deferred until the contract catches up)`, e)
    return
  }
  console.error(message, e)
}

type LoadSlotArgs = {
  contractID: string;
  slot: SlotDefinition;
  reason: KvLoadReason;
  suppressLoadingStatus?: boolean;
  heightReloadToken?: object;
}

// Starts a slot load (`chelonia/kv/_loadSlot`). A filter can veto it by
// throwing (this throws then) or by returning `false` for `_loadSlot`
// (`sbp` returns nothing): that throws `ChelErrorUnexpected`, whose message
// names the load as `what`, rather than resolving as if the slot had
// loaded.
function startSlotLoad (args: LoadSlotArgs, what = 'loading'): Promise<void> {
  const started = sbp('chelonia/kv/_loadSlot', args) as Promise<void> | undefined
  if (started === undefined) {
    throw new ChelErrorUnexpected(
      `[chelonia/kv] ${what} ${args.contractID}::${args.slot.key} was vetoed`
    )
  }
  return Promise.resolve(started)
}

// Starts a slot load in the background, logging its rejection with
// `message`, also when it can't start at all (a filter vetoed it, by
// throwing or by returning nothing): that settles the slot, as a failed
// load would (`settleUnstartedLoad`). Never rejects.
function loadSlotInBackground (
  ctx: CheloniaContext,
  args: { contractID: string; slot: SlotDefinition; reason: KvLoadReason },
  message: string
): Promise<void> {
  let loading: Promise<void>
  try {
    loading = startSlotLoad(args)
  } catch (e) {
    settleUnstartedLoad(ctx, args.contractID, args.slot, e)
    loading = Promise.reject(e)
  }
  return loading.catch((e: unknown) => logBackgroundLoadRejection(message, e))
}

// Cancels the height waits of `(contractID, key)`, or of every key of
// `contractID`. Leaves the mirror entries' `heightAhead` marker alone: the
// callers either remove the entries (the slot is going away, and a status
// event for an entry about to vanish would only be noise), or clear the
// markers themselves (a resync keeps the entries, see
// `chelonia/kv/_cleanupContractRuntime`).
function cancelHeightWaits (ctx: CheloniaContext, contractID: string, key?: string): void {
  if (!ctx.kvHeightWaits.size) return
  if (key !== undefined) {
    const waitKey = heightWaitKey(contractID, key)
    const wait = ctx.kvHeightWaits.get(waitKey)
    if (wait) dropHeightWait(ctx, waitKey, wait)
    return
  }
  for (const [waitKey, wait] of Array.from(ctx.kvHeightWaits)) {
    if (wait.contractID === contractID) dropHeightWait(ctx, waitKey, wait)
  }
}

// The status an active slot has settled with (`'loaded'`, `'non-init'` or
// `'error'`), or `undefined` while it hasn't (it isn't active, or hasn't
// settled in this activation, or a settled slot is reloading through
// `'loading'`). Only an active slot's `settled` counts: an entry persisted
// by a previous session may still carry it. See `chelonia/kv/settledStatus`.
function settledStatusOf (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): Exclude<KvLoadStatus, 'loading'> | undefined {
  if (!ctx.kvSlotsByContractID.get(contractID)?.has(key)) return undefined
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  const entry = rootState._kv?.[contractID]?.[key]
  if (entry?.settled !== true || entry.status === KV_LOAD_STATUS.LOADING) return undefined
  return entry.status
}

// Whether a slot is defined for `key` on `contractID`: for the contract's
// type when it is known, otherwise (the contract hasn't synced yet) for any
// type.
function slotDefinedFor (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  key: string
): boolean {
  const contractType = getContractType(rootState, contractID)
  if (contractType !== undefined) return ctx.kvSlots.has(registryKey(contractType, key))
  for (const slot of ctx.kvSlots.values()) {
    if (slot.key === key) return true
  }
  return false
}

// Rejects every `chelonia/kv/whenSettled` waiting for the slot of
// `(contractID, key)`, which can't settle any more: `why` says what
// happened to it (e.g. "was deactivated").
function rejectSettleWaiters (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  why: string
): void {
  const waitKey = joinKey(contractID, key)
  const waiters = ctx.kvSettleWaiters.get(waitKey)
  if (!waiters) return
  ctx.kvSettleWaiters.delete(waitKey)
  const error = new ChelErrorKvSlotUnknown(
    `[chelonia/kv] whenSettled: stopped waiting for ${waitKey} to settle: the slot ${why}`
  )
  for (const reject of waiters) reject(error)
}

// Rejects every `chelonia/kv/whenSettled` waiting for a key that no slot
// is defined for any more (see `slotDefinedFor`): for the contract's type,
// now that it is known, or for any type. Only for `contractID`'s waiters
// when given.
function rejectUndefinedSettleWaiters (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID?: string
): void {
  for (const waitKey of Array.from(ctx.kvSettleWaiters.keys())) {
    // Contract IDs and keys never contain the separator (`defineSlot`
    // rejects such keys).
    const at = waitKey.indexOf(KV_KEY_SEPARATOR)
    const cID = waitKey.slice(0, at)
    if (contractID !== undefined && cID !== contractID) continue
    const key = waitKey.slice(at + KV_KEY_SEPARATOR.length)
    if (slotDefinedFor(ctx, rootState, cID, key)) continue
    rejectSettleWaiters(ctx, cID, key, "isn't defined for this contract's type")
  }
}

// Deactivates the slot of `key` on `contractID` (its `match` turned false,
// or a manifest cleanup unregistered it): drops it from the active index
// and the pubsub filter, and cancels its height waits. Then, whether or
// not it was active, rejects the `whenSettled` calls waiting for it (so
// also when its `match` is false from the first reconcile: it would never
// settle), saying `why` when given, and deletes its mirror entry (also a
// stale persisted one), the contract's `_kv` record once emptied
// (`ensureContractKv` re-creates it on demand, and the load/remote paths
// re-acquire live entries and bail when absent) and its echo CIDs. A
// whole contract going away is `chelonia/kv/_cleanupContractRuntime`.
function deactivateSlotForContract (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  key: string,
  why?: string
): void {
  const perKey = ctx.kvSlotsByContractID.get(contractID)
  const wasActive = !!perKey?.has(key)
  if (perKey && wasActive) {
    perKey.delete(key)
    const contractEmptied = perKey.size === 0
    if (contractEmptied) ctx.kvSlotsByContractID.delete(contractID)
    const filter = ctx.kvActiveFilters.get(contractID)
    if (filter?.has(key)) {
      filter.delete(key)
      queueFilterFlush(ctx, contractID)
    }
    if (contractEmptied) ctx.kvActiveFilters.delete(contractID)
    cancelHeightWaits(ctx, contractID, key)
  }
  rejectSettleWaiters(
    ctx, contractID, key, why ?? (wasActive ? 'was deactivated' : "isn't active for this contract")
  )
  const perContract = rootState._kv?.[contractID]
  if (perContract?.[key]) ctx.config.reactiveDel(perContract, key)
  if (perContract && rootState._kv && Object.keys(perContract).length === 0) {
    ctx.config.reactiveDel(rootState._kv, contractID)
  }
  ctx.kvLocalEchoCIDs.delete(joinKey(contractID, key))
}

// Reconciles every slot of `contractType` for `contractID`
// (`chelonia/kv/_reconcileForSlot`), and records that the subscribed
// contract's slots have been reconciled (`kvReconciledContracts`, until
// the contract is removed): `whenSettled` then rejects at once for a slot
// of its type that isn't active, rather than wait for an activation that
// only a change of its `match` (and a `refreshFilters`) could bring. The
// `whenSettled` calls already waiting for a key its type defines no slot
// for reject (those whose slot's `match` is false already did, in
// `deactivateSlotForContract`).
function reconcileContract (
  ctx: CheloniaContext,
  rootState: ChelRootState,
  contractID: string,
  contractType: string
): void {
  for (const slot of ctx.kvSlots.values()) {
    if (slot.contractType !== contractType) continue
    sbp('chelonia/kv/_reconcileForSlot', slot, contractID)
  }
  if (ctx.subscriptionSet.has(contractID)) ctx.kvReconciledContracts.add(contractID)
  rejectUndefinedSettleWaiters(ctx, rootState, contractID)
}

// The height was reached: reload the slot (queued on the contract's lane).
// Runs synchronously from `notifyContractHeight`, i.e. possibly inside the
// contract's internal lane, so it only schedules work. Until the reload
// settles, `kvHeightReloadsQueued` marks the key, so that an `update`
// queued ahead of the reload still reloads first (`mirrorBasisUnverified`).
// The reload is kept on the wait (`wait.reload`, still rejecting for
// whoever awaits it there), for single-key `kv/sync`. The mirror entry's
// `heightAhead` stays until a load verifies the key: `_loadSlotNow` clears
// it then (`dropMootHeightWait`). A reload that fails, never starts, or is
// vetoed leaves it, since nothing verified the key: the next `update` then
// reloads first.
function fireHeightWait (ctx: CheloniaContext, wait: KvHeightWait): void {
  const waitKey = heightWaitKey(wait.contractID, wait.key)
  if (ctx.kvHeightWaits.get(waitKey) !== wait) return
  dropHeightWait(ctx, waitKey, wait)
  const slot = ctx.kvSlotsByContractID.get(wait.contractID)?.get(wait.key)
  if (!slot) return
  const token = {}
  ctx.kvHeightReloadsQueued.set(waitKey, token)
  let reload: Promise<void>
  try {
    reload = startSlotLoad({
      contractID: wait.contractID,
      slot,
      reason: wait.reason,
      // A slot that holds a value keeps presenting it while it reloads.
      // `_loadSlotNow` only skips `'loading'` when the slot is `'loaded'` as
      // the load runs (another load may have loaded it in the meantime).
      suppressLoadingStatus: true,
      heightReloadToken: token
    }, 'the deferred reload of')
  } catch (e) {
    // The load never started (a filter vetoed `queueInvocation`, by
    // throwing or by returning `false`, or vetoed `_loadSlot` itself): the
    // slot would never settle. Record the failure, as a load that failed
    // would. The rejection is logged below, and the queued-reload token is
    // cleared, as after any reload.
    reload = Promise.reject(e)
    settleUnstartedLoad(ctx, wait.contractID, slot, e)
  }
  wait.reload = reload
  reload.catch((e: unknown) => {
    logBackgroundLoadRejection(`[chelonia/kv] deferred reload rejected for ${waitKey}`, e)
  }).finally(() => {
    if (ctx.kvHeightReloadsQueued.get(waitKey) === token) {
      ctx.kvHeightReloadsQueued.delete(waitKey)
    }
  })
}

// A load that couldn't even start (a deferred reload or a background load
// that a filter vetoed) settles the slot as a failed load would. A slot
// without a value that is `'loading'`, or hasn't settled (an autoloaded
// `'non-init'` one, or a re-activated `'error'` one), goes `'error'`, with
// the error's name and message. A slot that holds a value keeps presenting
// it, with its status, and only settles (as `settleHeightAheadFailure`
// does): nothing else would settle a re-activated slot whose reload can't
// start.
function settleUnstartedLoad (
  ctx: CheloniaContext,
  contractID: string,
  slot: SlotDefinition,
  e: unknown
): void {
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  const entry = rootState._kv?.[contractID]?.[slot.key]
  if (!entry) return
  if (entry.value !== undefined) {
    if (entry.settled !== true) {
      setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, entry.status, {
        lastError: entry.lastError, settle: true
      })
    }
    return
  }
  if (entry.status !== KV_LOAD_STATUS.LOADING && entry.settled === true) return
  setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, KV_LOAD_STATUS.ERROR, {
    lastError: normalizeError(e), settle: true
  })
}

// The contract could not be brought to `requiredHeight`. A slot holding a
// value keeps it and settles `'loaded'` (or stays `'error'`, keeping its
// `lastError`, when it was in `'error'`). A slot holding a value that is
// `'loading'` has a reload in flight: it only settles, and that reload
// decides its status (an `'error'` slot whose reload fails must end up
// `'error'` again, not `'loaded'`). Any other slot (one that never loaded, a
// `'non-init'` one whose server value turned out to be ahead, or an
// `'error'` one without a value) settles to `'error'` with a
// `ChelErrorKvHeightAhead` `lastError`. Either way the slot settles: giving
// up is a terminal outcome, and a re-activated slot (e.g. restored from
// persisted state) may not have settled yet. The key's height wait is
// parked rather than dropped (see `parkHeightWait`), so the slot keeps
// knowing that the server holds a value it can't verify.
function settleHeightAheadFailure (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  requiredHeight: number
): void {
  const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key)
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  const entry = rootState._kv?.[contractID]?.[key]
  if (!slot || !entry) {
    // Nothing left to reload: a height wait only exists for an active slot.
    cancelHeightWaits(ctx, contractID, key)
    return
  }
  const message = kvHeightAheadMessage(ctx, contractID, key, { requiredHeight, exact: true })
  // Parked before the status changes, so that observers of the settled
  // status already find the mirror unverified. When the height has been
  // reached after all (e.g. pubsub brought the contract there while a
  // recovery sync failed or timed out), parking fires the reload at once:
  // the slot is about to load, so it doesn't settle as a failure.
  const reloading = parkHeightWait(ctx, {
    contractID,
    key,
    requiredHeight,
    // Only used when there is no wait to park; an existing wait keeps its
    // own reason.
    reason: KV_UPDATE_REASON.LOAD
  })?.reload !== undefined
  if (reloading) return
  if (entry.value !== undefined) {
    console.warn(`${message}; keeping the current mirror value`)
    if (entry.status === KV_LOAD_STATUS.LOADING) {
      setSlotStatus(ctx, rootState, contractID, slot.contractType, key, KV_LOAD_STATUS.LOADING, {
        settle: true
      })
      return
    }
    const keptError = entry.status === KV_LOAD_STATUS.ERROR
    setSlotStatus(
      ctx, rootState, contractID, slot.contractType, key,
      keptError ? KV_LOAD_STATUS.ERROR : KV_LOAD_STATUS.LOADED,
      { lastError: keptError ? entry.lastError : undefined, settle: true }
    )
    return
  }
  setSlotStatus(ctx, rootState, contractID, slot.contractType, key, KV_LOAD_STATUS.ERROR, {
    lastError: normalizeError(new ChelErrorKvHeightAhead(message)), settle: true
  })
}

// While `chelonia/reset` has ended the height session, no height wait can
// be registered (its fallback or a recovery would sync a contract into the
// next session). One that would have been is remembered with the waits the
// reset dropped (`kvSuspendedHeightWaits`): if the reset fails, the session
// goes on and `_resumeHeightSession` registers it; if it succeeds, the
// record is discarded with the rest. Records merge per key: the highest
// height, the first reason, and an unparked record wins over a parked one
// (a new registration un-parks a wait, see `registerHeightWait`).
function suspendHeightWait (
  ctx: CheloniaContext,
  record: CheloniaContext['kvSuspendedHeightWaits'][number]
): void {
  const existing = ctx.kvSuspendedHeightWaits.find((w) =>
    w.contractID === record.contractID && w.key === record.key
  )
  if (!existing) {
    ctx.kvSuspendedHeightWaits.push({ ...record })
    return
  }
  existing.requiredHeight = Math.max(existing.requiredHeight, record.requiredHeight)
  if (!record.parked) existing.parked = false
}

// What a height wait is registered (or parked) for.
type HeightWaitTarget = Pick<KvHeightWait, 'contractID' | 'key' | 'requiredHeight' | 'reason'>

// The steps shared by `registerHeightWait` and `parkHeightWait`. Returns
// the key's height wait, creating it (`created`, without a fallback timer or
// a listener) when there is none, along with the key's active slot. Returns
// `undefined` when there must be no wait: the key has no active slot, or
// `chelonia/reset` is tearing the session down (`kvHeightSession`), when the
// wait is only remembered, as `parked` or not (`suspendHeightWait`).
function getOrCreateHeightWait (
  ctx: CheloniaContext,
  { contractID, key, requiredHeight, reason }: HeightWaitTarget,
  parked: boolean
): { wait: KvHeightWait; created: boolean; slot: SlotDefinition } | undefined {
  const slot = ctx.kvSlotsByContractID.get(contractID)?.get(key)
  if (!slot) return undefined
  if (ctx.kvHeightSession.signal.aborted) {
    suspendHeightWait(ctx, { contractID, key, requiredHeight, reason, parked })
    return undefined
  }
  const waitKey = heightWaitKey(contractID, key)
  const existing = ctx.kvHeightWaits.get(waitKey)
  if (existing) return { wait: existing, created: false, slot }
  const wait: KvHeightWait = {
    contractID, key, requiredHeight, reason, off: () => {}, timer: undefined
  }
  ctx.kvHeightWaits.set(waitKey, wait)
  return { wait, created: true, slot }
}

// Parks the height wait of `(contractID, key)` once its fallback gave up,
// or while single-key `kv/sync` drives the recovery itself (creating it
// when there is none): the fallback timer goes, the height
// listener stays. So the slot still reloads if the contract ever reaches
// `requiredHeight`, and `mirrorBasisUnverified` keeps refusing its mirror
// as an `update` basis until then. The next registration for the key
// un-parks it (see `registerHeightWait`). At most one listener per key,
// removed when it fires, when a load verifies the key (`_loadSlotNow`),
// when the slot is deactivated, by
// `_cleanupContractRuntime`, and by `chelonia/reset`. A no-op for keys
// without an active slot. While `chelonia/reset` is tearing the session
// down (`kvHeightSession`), the parked wait is only remembered, merged
// into the key's record when one exists (`suspendHeightWait`: the record
// stays unparked if it was). Returns the wait, or
// `undefined` when there is none (no active slot, or the session is being
// torn down). When the height was already reached, the wait has fired
// instead of parking, and `wait.reload` is the reload it started.
function parkHeightWait (
  ctx: CheloniaContext,
  target: HeightWaitTarget
): KvHeightWait | undefined {
  const found = getOrCreateHeightWait(ctx, target, true)
  if (!found) return undefined
  const { wait, created } = found
  if (!created) {
    clearWaitTimer(wait)
    wait.off()
    wait.requiredHeight = Math.max(wait.requiredHeight, target.requiredHeight)
  }
  wait.parked = true
  listenForHeight(ctx, wait)
  return wait
}

// Listens for the local contract to reach `wait.requiredHeight` and fires
// the wait then (at once, when it already has). Until then, the mirror
// entry's `heightAhead` marker records the height.
function listenForHeight (ctx: CheloniaContext, wait: KvHeightWait): void {
  wait.off = addHeightListener(ctx, wait.contractID, wait.requiredHeight, () => {
    fireHeightWait(ctx, wait)
  })
  if (isHeightReached(ctx, wait.contractID, wait.requiredHeight)) fireHeightWait(ctx, wait)
  else setHeightAhead(ctx, wait.contractID, wait.key, wait.requiredHeight)
}

// Starts `wait`'s fallback timer (see `heightWaitFallback`).
function armHeightWaitFallback (ctx: CheloniaContext, wait: KvHeightWait): void {
  const timer = setTimeout(
    () => heightWaitFallback(ctx, wait), kvHeightTimings().pendingFallbackMs
  )
  // Node.js-specific: don't keep the process alive for this timer.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  wait.timer = timer
}

// Fallback timer: force a contract sync, then either reload (height now
// reached) or give up (see `settleHeightAheadFailure`, which parks the
// wait).
function heightWaitFallback (ctx: CheloniaContext, wait: KvHeightWait): void {
  const waitKey = heightWaitKey(wait.contractID, wait.key)
  if (ctx.kvHeightWaits.get(waitKey) !== wait) return
  wait.timer = undefined
  const conclude = () => {
    // Fired (height reached) or cancelled while the sync ran.
    if (ctx.kvHeightWaits.get(waitKey) !== wait) return
    // Parked meanwhile (single-key `kv/sync` drives the recovery itself, or
    // the slot has already settled as a failure), or parked and registered
    // again (the new fallback deadline decides; its timer has its own
    // sync).
    if (wait.parked || wait.timer !== undefined) return
    if (isHeightReached(ctx, wait.contractID, wait.requiredHeight)) {
      fireHeightWait(ctx, wait)
      return
    }
    settleHeightAheadFailure(ctx, wait.contractID, wait.key, wait.requiredHeight)
  }
  recoverContractHeight(
    ctx, wait.contractID, new Error(`height fallback for ${waitKey}`),
    { requiredHeight: wait.requiredHeight }
  ).catch(() => {}).then(conclude)
}

// Defers a reload of `(contractID, key)` until the local contract reaches
// `requiredHeight`. A no-op for keys without an active slot. While
// `chelonia/reset` is tearing the session down (`kvHeightSession`), the
// wait is only remembered, in case the reset fails (`suspendHeightWait`).
// Repeated registrations for the same key merge (highest height wins, the
// original fallback deadline is kept so the wait can't be postponed
// forever). A registration on a parked wait (whose fallback gave up)
// un-parks it with a new fallback deadline: the next load or frame that
// finds the value ahead tries again. A load that verifies the key (a value
// or a 404) drops a wait that existed when its GET started: the value it
// was waiting for is gone (`_loadSlotNow`).
//
// Every path that finds the server value ahead goes through here (the
// load path, the pubsub KV dispatch, `kv/sync`'s abort path, an `update`
// that gives up, a blind write that runs out of attempts on it, and
// `_resumeHeightSession`), so this is also where a
// `'non-init'` slot, settled or not, goes `'loading'`: its server value
// isn't absent. The mirror entry's `heightAhead` records the wait's height
// (see `setHeightAhead`).
function registerHeightWait (ctx: CheloniaContext, target: HeightWaitTarget): void {
  const found = getOrCreateHeightWait(ctx, target, false)
  if (!found) return
  const { wait, created, slot } = found
  const { contractID, key, requiredHeight } = target
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  if (rootState._kv?.[contractID]?.[key]?.status === KV_LOAD_STATUS.NON_INIT) {
    // The `heightAhead` marker goes with the status change, in one event.
    const markedHeight = Math.max(requiredHeight, wait.requiredHeight)
    setSlotStatus(ctx, rootState, contractID, slot.contractType, key, KV_LOAD_STATUS.LOADING, {
      heightAhead: isHeightReached(ctx, contractID, markedHeight) ? undefined : markedHeight
    })
  }
  if (created) {
    armHeightWaitFallback(ctx, wait)
  } else {
    if (wait.parked) {
      wait.parked = false
      armHeightWaitFallback(ctx, wait)
    }
    if (requiredHeight <= wait.requiredHeight) {
      if (!isHeightReached(ctx, contractID, wait.requiredHeight)) {
        setHeightAhead(ctx, contractID, key, wait.requiredHeight)
      }
      return
    }
    wait.off()
    wait.requiredHeight = requiredHeight
  }
  listenForHeight(ctx, wait)
}

// Whether the mirror entry can't serve as the basis of an `update` reducer
// because its server value is known to be unverifiable or stale: a load
// deferred on height is pending (status `'loading'`: any other load holds
// the lane until it settles), a height wait is registered for the key, or
// a wait fired and its reload is queued but hasn't run yet
// (`kvHeightReloadsQueued`: the height is reached, but the mirror still
// holds the value from before). A registered wait includes a parked one,
// whose fallback gave up: the slot keeps it until the value loads (any
// verified load of the key, see `_loadSlotNow`), the slot is deactivated,
// the contract's KV runtime is cleaned up, or `chelonia/reset`. The entry's
// `heightAhead` marker covers the same cases, and also outlives the
// session: an entry persisted with it refuses its stale value until a load
// verifies the key. The last clause covers an entry persisted as given up
// (`'error'` with a `ChelErrorKvHeightAhead` `lastError` and no value, from
// `settleHeightAheadFailure`) without the marker.
function mirrorBasisUnverified (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  entry: KvMirrorEntry | undefined
): boolean {
  if (!entry) return false
  if (entry.status === KV_LOAD_STATUS.LOADING || entry.heightAhead) return true
  const waitKey = heightWaitKey(contractID, key)
  if (ctx.kvHeightWaits.has(waitKey) || ctx.kvHeightReloadsQueued.has(waitKey)) return true
  return entry.status === KV_LOAD_STATUS.ERROR &&
    entry.value === undefined &&
    isKvHeightAhead(entry.lastError)
}

type NormalizedKvConflictData =
  | { present: false }
  | { present: true; currentData: JSONType | undefined }

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

// The `ChelErrorKvConflict` that `update` and `clear` reject with when
// `kv/set` runs out of attempts (`e`, an `isKvMaxAttempts` error). Its
// `.cause` is `{ currentStatus, currentData, requiredHeight, etag }` of the
// last response `kv/set` read (on exhaustion it reads the last `412`), as
// for `queuedSet`: `currentStatus` as `kv/set` reported it (`'ahead'` and
// `'malformed'` too; left out only when that response couldn't be read or
// decoded), `requiredHeight` for a value that is `'ahead'`, and
// `currentData` normalized for the slot, and omitted when the value is
// unknown (ahead, malformed, undecodable, or not valid for the slot).
// Nothing can mix two responses.
function kvConflictExhaustedError (
  op: 'update' | 'clear',
  slot: SlotDefinition,
  contractID: string,
  key: string,
  e: unknown
): Error {
  const cause = objectCause<KvConflictCause>(e)
  let carried: NormalizedKvConflictData = { present: false }
  try {
    carried = normalizeKvConflictCurrentData(slot, contractID, key, cause)
  } catch {}
  return new ChelErrorKvConflict(
    `[chelonia/kv] ${op}: ${contractID}::${key} ran out of attempts resolving conflicts`,
    {
      cause: {
        ...(cause?.currentStatus && { currentStatus: cause.currentStatus }),
        ...(typeof cause?.requiredHeight === 'number' && { requiredHeight: cause.requiredHeight }),
        ...(carried.present && { currentData: carried.currentData }),
        etag: cause?.etag ?? null
      }
    }
  )
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

// The error for a KV selector invoked from within an `onUpdate` callback
// for the *same* contract (`undefined` when it isn't): awaiting it there
// would deadlock the contract's lanes (see `safeOnUpdateGuarded`). `label`
// prefixes the message (e.g. `'update: cID::key'`), and `operation`, when
// given, names the selector to schedule instead. Guards the writes,
// single-key and aggregate `sync`, `whenSettled`, and `withHeightRecovery`
// (and so `queuedSet`).
// Only synchronous re-entrancy is detected (the flag is held just for the
// callback's synchronous portion), so the recommended way to trigger a
// same-contract write from `onUpdate` is to schedule it off the
// synchronous stack and NOT await it within the callback, e.g.
// `queueMicrotask(() => sbp('chelonia/kv/update', …))`. The scheduled
// write simply queues behind the lane and runs once it releases.
function reentrancyError (
  ctx: CheloniaContext,
  contractID: string,
  label: string,
  operation?: string
): Error | undefined {
  if ((ctx.kvOnUpdateActive.get(contractID) ?? 0) === 0) return undefined
  const scheduled = operation
    ? `queueMicrotask(() => sbp('chelonia/kv/${operation}', …))`
    : 'queueMicrotask(…)'
  const then = operation === 'whenSettled'
    ? 'continue in its `.then()`'
    : "don't await it from the callback"
  return new ChelErrorKvReentrant(
    `[chelonia/kv] ${label} was called synchronously from an onUpdate callback of the ` +
    "same contract; awaiting it there would deadlock the contract's lanes. Schedule it off " +
    `the synchronous stack, e.g. \`${scheduled}\`, and ${then}.`
  )
}

// Throws `reentrancyError`'s error, for `operation` on `key` (`'*'` for
// the aggregate `sync`).
function assertNotReentrant (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  operation: 'update' | 'clear' | 'sync' | 'whenSettled'
): void {
  const error = reentrancyError(ctx, contractID, `${operation}: ${contractID}::${key}`, operation)
  if (error) throw error
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

// ---------------------------------------------------------------------------
// Slot writes (`update`, `clear`)
// ---------------------------------------------------------------------------

// Runs a slot write's body on the contract's public lane, with height
// recovery outside the lane (KV-REVAMPED.md §4.2 step 5a): when an attempt
// rejects with `ChelErrorKvHeightAhead`, the lane has been released, the
// contract is synced from here, and the body is enqueued again (`runBody`
// receives the attempt's `KvHeightRecoveryAttempt`). Syncing inside the body would
// hold the public lane while waiting on the internal one.
//
// `queueAbortable` rejects when the body never ran: a `queueInvocation`
// that returned nothing (a filter vetoed it) as a veto, and lane work that
// `chelonia/reset` dropped as aborted; a synchronous throw (e.g. a filter
// vetoes the underlying `queueEvent`) surfaces as a rejection of the
// recovery loop. Either way the pending-write counter, which the caller
// incremented, is balanced here. The caller's signal and `chelonia/reset`
// also end the wait of an attempt whose lane work is still queued (it then
// writes nothing); once that work runs, the usual abort rules apply.
//
// Giving up on a server value this client can't verify yet (`'reject'`, no
// recoveries left, a recovery sync that failed or timed out, or an abort,
// the caller's or `chelonia/reset`'s, that ends the recovery), or a blind
// write that ran out of attempts on a value that is ahead (its conflict
// cause carries the value's height), is recorded as a load that found it
// ahead would record it (`registerHeightWait`): the
// slot stops presenting "no value", reloads once the contract reaches the
// height, and the next `update` doesn't run its reducer on the stale mirror
// (`mirrorBasisUnverified`). The value is the one the most recent failed
// attempt found ahead, whatever error ends the write. Not recorded for each
// attempt: after a successful recovery, the next attempt reloads anyway, so
// that would only make the slot flicker through `'loading'`. A `409`
// (`exact: false`) says nothing about the stored value.
function runSlotWrite<T> (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  label: string,
  options: KvHeightRecoveryOptions,
  runBody: (info: KvHeightRecoveryAttempt) => Promise<T>
): Promise<T> {
  let lastAhead: KvHeightAheadCause | undefined
  // The lane work of the latest attempt. The caller's signal (or
  // `chelonia/reset`) can end the write while that work is still queued,
  // e.g. behind a busy lane or a recovery sync: the work then writes
  // nothing, but still runs, so the pending-write count waits for it.
  let lastQueued: Promise<void> = Promise.resolve()
  // Captured once, as `withHeightRecovery` does: `chelonia/reset` aborts
  // this controller and replaces it.
  const sessionSignal = ctx.abortController.signal
  return withHeightRecovery(ctx, contractID, (info) => {
    const { result, queued } = queueAbortable(
      contractID, [options.signal, sessionSignal], () => runBody(info)
    )
    lastQueued = queued
    return result.catch((e: unknown) => {
      const cause = kvHeightAheadCause(e)
      lastAhead = cause?.exact ? cause : undefined
      throw e
    })
  }, options, label).catch((e: unknown) => {
    const conflict = isKvConflict(e) ? e.cause : undefined
    const requiredHeight = lastAhead?.requiredHeight ??
      (conflict?.currentStatus === 'ahead' ? conflict.requiredHeight : undefined)
    if (requiredHeight !== undefined) {
      registerHeightWait(ctx, { contractID, key, requiredHeight, reason: KV_UPDATE_REASON.LOAD })
    }
    throw e
  }).finally(() => {
    lastQueued.finally(() => decrementPending(ctx, contractID))
  })
}

// The key's height wait as a write or a load starts. See
// `dropMootHeightWait`.
type HeightWaitSnapshot = { wait: KvHeightWait | undefined; requiredHeight: number | undefined }

function snapshotHeightWait (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): HeightWaitSnapshot {
  const wait = ctx.kvHeightWaits.get(heightWaitKey(contractID, key))
  return { wait, requiredHeight: wait?.requiredHeight }
}

// An outcome that verifies the key (a load that finds a value or a 404, or
// a write that commits) makes the height wait the key had when it started
// (`before`) moot: the server value it was waiting for is gone. Drops that
// wait if it is still the same one, at the same height; a wait registered
// or raised meanwhile is kept. Frames can't do that while a load runs (they
// run on the lane it holds); `runSlotWrite`'s catch, `kv/sync`'s park and
// abort paths and `_resumeHeightSession` register waits off the lane.
// Returns whether a wait remains for the key.
function dropMootHeightWait (
  ctx: CheloniaContext,
  contractID: string,
  key: string,
  before: HeightWaitSnapshot
): boolean {
  const waitKey = heightWaitKey(contractID, key)
  const wait = ctx.kvHeightWaits.get(waitKey)
  if (wait && wait === before.wait && wait.requiredHeight === before.requiredHeight) {
    dropHeightWait(ctx, waitKey, wait)
  }
  return ctx.kvHeightWaits.has(waitKey)
}

// The status of a verified empty outcome for `key` (a 404, a cleared
// value, a remote clear, a committed clear): `'non-init'`, unless a height
// wait remains for the key (one registered while the request was in
// flight). The server is then known to hold a value this client can't
// verify yet, so the slot reports `'loading'` rather than "no value". A
// parked wait is un-parked, so that its fallback runs again and the slot
// can't stay `'loading'` for good.
function emptyOutcomeStatus (
  ctx: CheloniaContext,
  contractID: string,
  key: string
): typeof KV_LOAD_STATUS.NON_INIT | typeof KV_LOAD_STATUS.LOADING {
  const wait = ctx.kvHeightWaits.get(heightWaitKey(contractID, key))
  if (!wait) return KV_LOAD_STATUS.NON_INIT
  if (wait.parked) {
    wait.parked = false
    armHeightWaitFallback(ctx, wait)
  }
  return KV_LOAD_STATUS.LOADING
}

// Applies a slot write that committed on the server (`kv/set` resolved) to
// the mirror: `value` (`undefined` for `clear`) with the write's etag, a
// `reason: 'local'` `CHELONIA_KV_UPDATED`, the settled `status`, and
// `onUpdate` (with `onUpdateValue`). Nothing is applied when the slot was
// replaced (`defineSlot`/HMR) or dropped (reconcile) meanwhile; the write
// still committed, so callers resolve as if it had been.
//
// The caller's `signal` isn't checked here: once `kv/set` resolved, an
// abort can't cancel anything, and reporting "nothing written" for a write
// the server holds would invite a retry that applies it twice. An abort
// after the commit is ignored (KV-REVAMPED.md §4.2).
//
// The echo CID is recorded first, unconditionally: the write committed, so
// its pubsub echo must be dropped whatever happens next. An echo arriving
// unsuppressed would be re-validated as a `'remote'` frame (spuriously
// flipping a replacement slot to `'error'`, or applying the write a second
// time). `kvLocalEchoCIDs` is keyed by (contractID, key), not slot
// identity, so the entry stays valid across slot replacement.
//
// A committed write is a terminal outcome: the slot settles, leaving any
// `'error'` / `'non-init'` / `'loading'` status. The server now holds this
// write, so the height wait the key had when the write started (`before`)
// is moot, and so is the `heightAhead` marker: both go, as after a load
// that verifies the key. A wait registered or raised meanwhile (off the
// lane, see `dropMootHeightWait`) is kept, with its marker, and a write
// that cleared the value then settles `'loading'` (`emptyOutcomeStatus`).
async function commitSlotWrite (
  ctx: CheloniaContext,
  {
    op, contractID, key, slot, setResult, sawConflict, before, value, status, onUpdateValue
  }: {
    op: 'update' | 'clear';
    contractID: string;
    key: string;
    slot: SlotDefinition;
    setResult: { etag: string | null };
    sawConflict: boolean;
    before: HeightWaitSnapshot;
    value: JSONType | undefined;
    status: typeof KV_LOAD_STATUS.LOADED | typeof KV_LOAD_STATUS.NON_INIT;
    onUpdateValue: JSONType | undefined;
  }
): Promise<void> {
  if (setResult.etag == null) {
    console.warn(
      `[chelonia/kv] ${op}: ${contractID}::${key} successful write returned no ` +
      'etag/x-cid header; self-echo suppression is inactive for this write'
    )
  }
  recordEchoCID(ctx, contractID, key, setResult.etag, sawConflict)
  if (!slotIsCurrent(ctx, contractID, slot)) return
  const rootState = sbp(ctx.config.stateSelector) as ChelRootState
  const entry = rootState._kv?.[contractID]?.[key]
  if (!entry) return
  const previousValue = entry.value
  // Clone before the mirror write so neither the caller (via the resolved
  // promise) nor the reducer author holds a live alias into the mirror;
  // same invariant as `_handleRemote`. `read` clones on the way out.
  ctx.config.reactiveSet(entry, 'value', cloneForEmit(value))
  ctx.config.reactiveSet(entry, 'etag', setResult.etag)
  sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, {
    contractID,
    contractType: slot.contractType,
    key,
    value: cloneForEmit(value),
    previousValue: cloneForEmit(previousValue),
    reason: KV_UPDATE_REASON.LOCAL,
    etag: setResult.etag
  })
  const waitRemains = dropMootHeightWait(ctx, contractID, key, before)
  const settledAs = waitRemains && status === KV_LOAD_STATUS.NON_INIT
    ? emptyOutcomeStatus(ctx, contractID, key)
    : status
  setSlotStatus(ctx, rootState, contractID, slot.contractType, key, settledAs, {
    settle: true, heightAhead: waitRemains ? undefined : null
  })
  if (slotIsCurrent(ctx, contractID, slot)) {
    await safeOnUpdateGuarded(ctx, contractID, slot, onUpdateValue, {
      contractID,
      contractType: slot.contractType,
      key,
      reason: KV_UPDATE_REASON.LOCAL,
      etag: setResult.etag,
      previousValue: cloneForEmit(previousValue)
    })
  }
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
        },
        // Shrink (or restore) the height-related wait, pending-load fallback
        // and recovery timeouts (see `setKvHeightTimings` in kv-height.ts:
        // the given fields are merged; no argument restores all three).
        'chelonia/kv/_testSetHeightTimings': function (
          timings?: KvHeightTimingOverrides | null
        ) {
          return setKvHeightTimings(timings)
        },
        // Signals that the local height of `contractID` advanced, as
        // `handleEvent` does after processing an event. Lets tests that set
        // `rootState.contracts[cID].height` directly wake up height waits.
        'chelonia/kv/_testNotifyHeight': function (
          this: CheloniaContext,
          contractID: string
        ) {
          const height = localContractHeight(this, contractID)
          if (height !== undefined) notifyContractHeight(this, contractID, height)
        },
        // Test-only. Drops every height-deferred load and height listener
        // without ending the height session.
        'chelonia/kv/_testClearHeightWaits': function (this: CheloniaContext): void {
          clearHeightWaits(this)
        },
        // Test-only. A snapshot of the height-deferred load of
        // `(contractID, key)` (see "Height-deferred loads"), if any.
        'chelonia/kv/_testHeightWait': function (
          this: CheloniaContext,
          contractID: string,
          key: string
        ) {
          const wait = this.kvHeightWaits.get(heightWaitKey(contractID, key))
          return wait && {
            requiredHeight: wait.requiredHeight,
            reason: wait.reason,
            parked: !!wait.parked,
            fallbackArmed: wait.timer !== undefined
          }
        }
      }
    : {}),

  // Private. Defers a reload of `(contractID, key)` until the local
  // contract reaches `requiredHeight` (see "Height-deferred loads" above).
  // Called from the pubsub KV dispatch in `chelonia.ts` for frames that
  // are ahead of the local contract.
  'chelonia/kv/_registerHeightWait': function (
    this: CheloniaContext,
    params: HeightWaitTarget
  ): void {
    registerHeightWait(this, params)
  },

  // Private. Called from `chelonia/reset` right after it aborts the old
  // session. Ends the height session (see `kvHeightSession`): no height
  // wait can be registered and no height-recovery sync can start until
  // `reset` starts a new one, so a deferred-load fallback firing while
  // `reset` drains can't sync a contract into the next session. Also
  // drops the old session's height waits and listeners, remembering the
  // waits in case the reset fails (see `_resumeHeightSession`). Waits that
  // would be registered or parked while the height session is ended are
  // remembered with them (`suspendHeightWait`). Merged into the records
  // already there: overlapping resets happen (a second `chelonia/reset`
  // while the first drains), and the second must not discard what the
  // first saved, in case it fails. Counts the resets in progress
  // (`kvHeightSessionHolds`).
  'chelonia/kv/_endHeightSession': function (this: CheloniaContext): void {
    this.kvHeightSessionHolds++
    for (const { contractID, key, requiredHeight, reason, parked } of this.kvHeightWaits.values()) {
      suspendHeightWait(this, { contractID, key, requiredHeight, reason, parked: !!parked })
    }
    this.kvHeightSession.abort(new DOMException('Aborted by chelonia/reset', 'AbortError'))
    clearHeightWaits(this)
  },

  // Private. Called from `chelonia/reset` when it fails before tearing the
  // session down (e.g. its persistence hook threw): the session goes on, so
  // it gets a new height session, and the deferred reloads that
  // `_endHeightSession` dropped, or that were registered while the reset
  // ran, are registered again (with a new fallback deadline). Parked ones
  // (whose fallback already gave up) are parked again, without a fallback.
  // A no-op while the height session is running, and while another reset
  // is still in progress (`kvHeightSessionHolds`): that one may still tear
  // the session down, or resume it if it fails too.
  'chelonia/kv/_resumeHeightSession': function (this: CheloniaContext): void {
    this.kvHeightSessionHolds = Math.max(0, this.kvHeightSessionHolds - 1)
    if (this.kvHeightSessionHolds > 0 || !this.kvHeightSession.signal.aborted) return
    this.kvHeightSession = new AbortController()
    const suspended = this.kvSuspendedHeightWaits
    this.kvSuspendedHeightWaits = []
    for (const { parked, ...wait } of suspended) {
      if (parked) parkHeightWait(this, wait)
      else registerHeightWait(this, wait)
    }
  },

  // Private. Called from `chelonia/reset` right after it has torn the old
  // session down (`resetKvSession`, which starts a new height session):
  // this reset is done, so it releases its hold (`kvHeightSessionHolds`).
  // While another reset is still in progress (resets can overlap), the new
  // height session starts ended: that reset may still fail and resume it
  // (`_resumeHeightSession`).
  'chelonia/kv/_finishHeightSession': function (this: CheloniaContext): void {
    this.kvHeightSessionHolds = Math.max(0, this.kvHeightSessionHolds - 1)
    if (this.kvHeightSessionHolds > 0) {
      this.kvHeightSession.abort(new DOMException('Aborted by chelonia/reset', 'AbortError'))
    }
  },

  // Public. The height recovery of `update`, `clear` and `queuedSet`, for
  // raw `chelonia/kv/get` / `chelonia/kv/set` callers (see docs/kv.md,
  // "Replacing an app-level height guard"). Runs `attempt` and, while it
  // rejects with `ChelErrorKvHeightAhead`, waits (holding no lane) for a
  // sync of the contract, which runs on its internal lane (one sync shared
  // by concurrent callers; `signal` and `chelonia/reset` end this caller's
  // wait, not the sync), and runs it again, up to
  // `maxHeightRecoveries` times, also when that sync fails but the contract
  // reaches the height anyway (see `recoverContractHeight`). `attempt` must
  // queue its lane work with the `queue` it is handed (a body that never
  // runs then rejects, rather than resolving `undefined`), pass
  // `heightWaitMs` on to `chelonia/kv/set` (`0` while a recovery follows,
  // or with `onHeightAhead: 'reject'`; the default wait on the last
  // attempt: see `KvHeightRecoveryAttempt` in types.ts), and only read
  // or write keys of `contractID`, since the recovery syncs that contract.
  // Never await it from code that contract's lanes await (a `sideEffect`,
  // a `queueInvocation` body, an `onconflict`, an `onUpdate`): see
  // docs/kv.md, "How height recovery runs".
  // A non-function `attempt` rejects with `TypeError`, and invalid options
  // with `ChelErrorKvUpdateInvalid`, before `attempt`
  // runs; `label` (e.g. `'queuedSet: cID::key'`) prefixes that error's
  // message. Called synchronously from an `onUpdate` callback of one of the
  // contract's slots, it rejects with `ChelErrorKvReentrant`, as `update`
  // does; its message tells to schedule `chelonia/kv/${operation}` instead
  // (`operation` defaults to `withHeightRecovery` without a `label`, so a
  // wrapper such as `queuedSet` passes its own name). It doesn't check
  // that `attempt` touches `contractID` only.
  'chelonia/kv/withHeightRecovery': function <T> (
    this: CheloniaContext,
    contractID: string,
    attempt: (info: KvHeightRecoveryAttempt) => Promise<T>,
    opts?: (KvHeightRecoveryOptions & { label?: string; operation?: string }) | null
  ): Promise<T> {
    const { label, operation, ...options } = opts ?? {}
    if (typeof attempt !== 'function') {
      return Promise.reject(new TypeError(
        '[chelonia/kv] withHeightRecovery: `attempt` must be a function'
      ))
    }
    const fullLabel = label ?? `withHeightRecovery: ${contractID}`
    const reentrant = reentrancyError(
      this, contractID, fullLabel,
      operation ?? (label === undefined ? 'withHeightRecovery' : undefined)
    )
    if (reentrant) return Promise.reject(reentrant)
    return withHeightRecovery(this, contractID, attempt, options, fullLabel)
  },

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
    // Height-deferred loads only exist for active slots: every removal path
    // (match→false, contract release, manifest cleanup, reset) cancels them.
    for (const wait of this.kvHeightWaits.values()) {
      if (!this.kvSlotsByContractID.get(wait.contractID)?.has(wait.key)) {
        throw new Error(
          `[chelonia/kv] index invariant: kvHeightWaits has ${wait.contractID}::${wait.key} ` +
          'but no active slot in kvSlotsByContractID'
        )
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
            loadSlotInBackground(
              this,
              { contractID: cID, slot, reason: KV_UPDATE_REASON.LOAD },
              `[chelonia/kv] _loadSlot rejected for ${cID}::${def.key}`
            )
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
      if (!perContract[slot.key]) {
        this.config.reactiveSet(perContract, slot.key, {
          value: undefined,
          etag: null,
          status: KV_LOAD_STATUS.NON_INIT,
          settled: false
        })
      } else if (!wasActive) {
        unsettleSlot(this, rootState, contractID, slot.contractType, slot.key)
      }
      // Schedule a load. The actual fetch is serialised against
      // updates via the per-contract queueInvocation lane.
      if (!wasActive && slot.autoLoad === KV_AUTO_LOAD.ON_SYNC) {
        // Fire-and-forget — `_loadSlot` manages its own status events and
        // may reject on GET or validation failure; logging it here keeps
        // that rejection out of the reconcile dispatch path.
        loadSlotInBackground(
          this,
          { contractID, slot, reason: KV_UPDATE_REASON.LOAD },
          `[chelonia/kv] _loadSlot rejected for ${contractID}::${slot.key}`
        )
      }
    } else {
      // match returned false — tear down if active, and clean up any
      // stale persisted mirror entry regardless of prior active state.
      deactivateSlotForContract(this, rootState, contractID, slot.key)
    }
  },

  // Private queued wrapper. See KV-REVAMPED §11.3 step 3. Routes
  // `_loadSlotNow` through `chelonia/queueInvocation` keyed on
  // `contractID` so explicit loads serialize against in-flight
  // `chelonia/kv/update` writes.
  // Private: `loadSlotInBackground`, for `chelonia.ts`'s pubsub handler.
  'chelonia/kv/_loadSlotInBackground': function (
    this: CheloniaContext,
    args: { contractID: string; slot: SlotDefinition; reason: KvLoadReason },
    message: string
  ): Promise<void> {
    return loadSlotInBackground(this, args, message)
  },

  'chelonia/kv/_loadSlot': function (
    this: CheloniaContext,
    {
      contractID,
      slot,
      reason,
      suppressLoadingStatus,
      heightReloadToken
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
      // See `_loadSlotNow`. Used by reloads of a slot that may already
      // hold a value: height-deferred reloads, and single-key `kv/sync`'s
      // rounds after the first.
      suppressLoadingStatus?: boolean;
      heightReloadToken?: object;
    }
  ): Promise<void> {
    // Count the load as pending the moment it is *scheduled*, not when
    // its lane callback starts: a load queued behind busy lane work has
    // not yet flipped the slot to 'loading', so `defineSlot`'s gate
    // would otherwise miss it and revalidate a value this load is about
    // to discard at its staleness guard (#1). Balanced in `finally`, and
    // when the load can't be queued.
    incrementPendingLoad(this, contractID)
    let queued: Promise<void> | undefined
    try {
      queued = sbp('chelonia/queueInvocation', contractID, () =>
        sbp('chelonia/kv/_loadSlotNow', { contractID, slot, reason, suppressLoadingStatus, heightReloadToken })
      ) as Promise<void>
    } catch (e) {
      decrementPendingLoad(this, contractID)
      throw e
    }
    // A filter that returns `false` for `queueInvocation` vetoes it without
    // a throw: nothing is queued, so nothing would ever load. Fail as a
    // throwing filter does, rather than resolve as if the slot had loaded.
    if (queued === undefined) {
      decrementPendingLoad(this, contractID)
      throw new ChelErrorUnexpected(
        `[chelonia/kv] loading ${contractID}::${slot.key} was vetoed ` +
        '(queueInvocation returned nothing)'
      )
    }
    return Promise.resolve(queued).finally(() => {
      decrementPendingLoad(this, contractID)
    })
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
      preserveStatusOnError = false,
      heightReloadToken
    }: {
      contractID: string;
      slot: SlotDefinition;
      reason: KvLoadReason;
      // A fired height wait's reload (`fireHeightWait`): the key's
      // `kvHeightReloadsQueued` token it was started with. The reload
      // doesn't run once a load that started after the fire has verified
      // the key, which drops the token (see `dropMootWait` below).
      heightReloadToken?: object;
      // Internal flag: skip the transient `'loading'` status when the
      // slot is already `'loaded'`, so a reload of a value the slot holds
      // doesn't surface a cosmetic `loaded → loading → loaded` flicker to
      // consumers observing `CHELONIA_KV_STATUS_CHANGED`. Used by
      // conflict resolution (`_handleRemote`), height-deferred reloads,
      // `update`'s reloads and single-key `kv/sync`. A non-loaded baseline
      // still transitions through `'loading'` so genuine loads stay
      // observable; the error/success branches below still set
      // `'error'`/`'loaded'` normally.
      suppressLoadingStatus?: boolean;
      // Internal flag (conflict resolution and `update`'s pre-reducer
      // reloads): on GET failure,
      // restore the prior status instead of stamping `'error'`. The
      // conflict-resolved write already committed to the server, so the
      // mirror still holds a valid value; flipping to `'error'` would
      // make `chelonia/kv/read` return the default and silently hide
      // that retained value. The error is still re-thrown so the caller
      // can log it (and `_handleRemote` demote its conflict markers).
      preserveStatusOnError?: boolean;
    }
  ): Promise<void> {
    incrementPendingLoad(this, contractID)
    return (async () => {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      // The contract may have been released between scheduling and
      // running — bail out cleanly.
      if (!this.subscriptionSet.has(contractID)) return
      // A fired height wait's reload whose token a load that started after
      // the fire dropped (it verified the key): nothing left to reload.
      if (
        heightReloadToken &&
        this.kvHeightReloadsQueued.get(heightWaitKey(contractID, slot.key)) !== heightReloadToken
      ) return
      // Non-destructive existence check FIRST: reconcile may have dropped
      // the mirror entry (and the now-empty `_kv[contractID]` record) while
      // we were queued behind other lane work. Calling `ensureContractKv`
      // here would re-create an orphaned empty `{}` record that lingers in
      // persisted state until contract release. The subscription guard
      // above doesn't cover this — the contract is still subscribed, only
      // the slot entry was removed. Matches the non-destructive read
      // pattern `setSlotStatus` uses.
      if (!rootState._kv?.[contractID]?.[slot.key]) {
        return
      }
      const perContract = ensureContractKv(this, rootState, contractID)
      if (!perContract[slot.key]) {
        // Reconcile dropped the entry while we were queued.
        return
      }
      const priorStatus = perContract[slot.key]?.status
      // Restored with an `'error'` status (see `restorePriorStatusIfStale`):
      // a reload that ends without an outcome of its own (deferred on
      // height, superseded) doesn't change why the slot is in `'error'`.
      const priorLastError = perContract[slot.key]?.lastError
      // The key's height wait as this load starts. A verified outcome (a
      // value, or a 404) shows that the server value it was waiting to
      // verify is gone, so the wait is moot: dropping it lets the next
      // `update` use the mirror again (`mirrorBasisUnverified`) and keeps
      // its fallback from settling the slot as a failure. A wait
      // registered or raised while the GET was in flight is kept. Frames
      // can't register one (they run on the lane this load holds); the
      // waits registered off the lane can: `runSlotWrite`'s catch,
      // `kv/sync`'s park and abort paths, and `_resumeHeightSession`.
      const waitBefore = snapshotHeightWait(this, contractID, slot.key)
      // Likewise, the token of a fired height wait's reload that was
      // queued as this load started: the verified outcome makes that
      // reload moot too. A token set while the GET was in flight is kept:
      // this load may have read an older value than the one it reloads.
      const reloadTokenBefore = this.kvHeightReloadsQueued.get(heightWaitKey(contractID, slot.key))
      // Returns the `heightAhead` argument of the settling `setStatus`, so
      // that the marker is cleared (also one persisted by an earlier
      // session) with the status change, in one event: `null` unless a
      // wait remains.
      const dropMootWait = (): null | undefined => {
        const reloadKey = heightWaitKey(contractID, slot.key)
        if (reloadTokenBefore && this.kvHeightReloadsQueued.get(reloadKey) === reloadTokenBefore) {
          this.kvHeightReloadsQueued.delete(reloadKey)
        }
        if (dropMootHeightWait(this, contractID, slot.key, waitBefore)) return undefined
        return null
      }
      const setStatus = (
        status: KvLoadStatus,
        options?: SlotStatusOptions & { heightAhead?: null }
      ) => setSlotStatus(
        this, rootState, contractID, slot.contractType, slot.key, status, options
      )
      // Staleness teardown shared by all three guards below. Re-reads
      // the LIVE mirror (`rootState._kv`) rather than the `perContract`
      // captured above: `chelonia/kv/_cleanupContractRuntime` can run
      // (outside this lane) during the GET await and `reactiveDel` the
      // whole `_kv[contractID]` record. The captured `perContract` then
      // points at a detached object whose entry still reads
      // `'loading'`, so trusting it would call `setSlotStatus` →
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
        if (liveEntry.status === KV_LOAD_STATUS.LOADING && priorStatus != null) {
          setStatus(priorStatus, {
            lastError: priorStatus === KV_LOAD_STATUS.ERROR ? priorLastError : undefined
          })
        }
      }
      const slotReplacedOrReleased = () => !slotIsCurrent(this, contractID, slot)
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
          setStatus(KV_LOAD_STATUS.ERROR, { lastError: normalizeError(e), settle: true })
        }
        throw new ChelErrorKvValidation(wrappedMessage, { cause: e })
      }
      if (!(suppressLoadingStatus && priorStatus === KV_LOAD_STATUS.LOADED)) {
        setStatus(KV_LOAD_STATUS.LOADING)
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
        const heightAhead = kvHeightAheadCause(e)
        if (heightAhead) {
          // The server value was written at a contract height the local
          // contract hasn't reached, so it can't be verified yet
          // (KV-REVAMPED.md §3.4). That is not a load failure: keep the
          // mirror value and etag, and reload once the contract catches up.
          // A slot that holds a value (or is in 'error') goes back to that
          // status; any other slot stays 'loading' (pending), without a
          // terminal status event. That includes a slot that settled as
          // 'non-init': the server value it found absent is there after all.
          // `update`, which rethrows this error to recover, reloads first on
          // its next attempt (`mirrorBasisUnverified`).
          registerHeightWait(this, {
            contractID,
            key: slot.key,
            requiredHeight: heightAhead.requiredHeight,
            reason
          })
          if (
            priorStatus === KV_LOAD_STATUS.LOADED ||
            priorStatus === KV_LOAD_STATUS.ERROR
          ) {
            restorePriorStatusIfStale()
          }
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
        setStatus(KV_LOAD_STATUS.ERROR, { lastError, settle: true })
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
        // success-path sequencing of setSlotStatus → safeOnUpdateGuarded).
        // The 404 is a server confirmation that no value exists, so the
        // slot settles, as 'loading' while a height wait registered during
        // the GET remains (`emptyOutcomeStatus`).
        const heightAhead = dropMootWait()
        setStatus(emptyOutcomeStatus(this, contractID, slot.key), { settle: true, heightAhead })
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
      // `setSlotStatus` (which re-reads live) would stamp the fresh
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
      // Emit order: `CHELONIA_KV_UPDATED` fires BEFORE `setSlotStatus`
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
      // A cleared value settles as a 404 does (see `emptyOutcomeStatus`).
      const heightAhead = dropMootWait()
      setStatus(wasClear ? emptyOutcomeStatus(this, contractID, slot.key) : KV_LOAD_STATUS.LOADED, {
        settle: true, heightAhead
      })
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
  // intentionally idempotent. Once an added contract is reconciled, the
  // `whenSettled` calls waiting for a key its type defines no slot for
  // reject (`reconcileContract`, as for `refreshFilters`). A removal for a
  // resync (`resync`) keeps the contract's `whenSettled` calls waiting: its
  // slots come back once it has re-synced.
  'chelonia/kv/_onContractsModified': function (
    this: CheloniaContext,
    { added, removed, resync }: ContractsModifiedChange
  ): void {
    if (added && added.length > 0) {
      const rootState = sbp(this.config.stateSelector) as ChelRootState
      for (const cID of added) {
        const meta = rootState.contracts?.[cID]
        if (!meta) continue
        const contractType = getContractType(rootState, cID)
        if (!contractType) continue
        reconcileContract(this, rootState, cID, contractType)
      }
    }
    if (removed && removed.length > 0) {
      for (const cID of removed) {
        // Also invoked directly from `chelonia/private/removeImmediately`
        // as an idempotent fast path; calling twice is safe.
        sbp('chelonia/kv/_cleanupContractRuntime', cID, { resync: !!resync })
      }
    }
  },

  // Private. See KV-REVAMPED §11.4 (contract-release / unsubscribe path).
  // Called from both `chelonia/private/removeImmediately` and the
  // `CONTRACTS_MODIFIED` listener; all operations below are idempotent.
  // Clears per-contract KV runtime state for `contractID`: removes
  // `rootState._kv[contractID]` (except for a resync, see below),
  // `kvSlotsByContractID[contractID]`,
  // `kvActiveFilters[contractID]`, and schedules an empty-filter
  // `setFilter` flush. Every `whenSettled` call waiting for one of its
  // keys rejects, whether or not the slot was active, unless the contract
  // is only removed for a resync (`resync`): its slots are reconciled
  // again once it has re-synced, and the calls settle then (if the resync
  // fails, they wait until the contract is released, or their `signal`
  // aborts). A resync also keeps the mirror entries, values included, so
  // that the reload after it reports a value that went away meanwhile; the
  // re-activated slots still unsettle until that reload. The
  // `kvFilterDirty` mark is intentionally
  // retained until the microtask fires so the flush sees this
  // contract in the dirty set. Keeps long-lived sessions from
  // accumulating stale mirror entries after refcount goes to zero. This
  // selector may run outside any per-contract queue lane, so it must
  // remain synchronous and idempotent.
  'chelonia/kv/_cleanupContractRuntime': function (
    this: CheloniaContext,
    contractID: string,
    { resync = false }: { resync?: boolean } = {}
  ): void {
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
    this.kvReconciledContracts.delete(contractID)
    this.kvActiveFilters.delete(contractID)
    this.kvFilterRetry.delete(contractID)
    this.kvReconnectRefresh.delete(contractID)
    cancelHeightWaits(this, contractID)
    const prefix = joinKey(contractID, '')
    if (!resync) {
      for (const waitKey of Array.from(this.kvSettleWaiters.keys())) {
        if (!waitKey.startsWith(prefix)) continue
        rejectSettleWaiters(
          this, contractID, waitKey.slice(prefix.length), 'was removed with its contract'
        )
      }
    }
    this.kvLocalEchoCIDs.forEach((_cids, key) => {
      if (key.startsWith(prefix)) {
        this.kvLocalEchoCIDs.delete(key)
      }
    })
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const record = rootState._kv?.[contractID]
    if (record && resync) {
      // A resync re-activates the same slots: keep their entries, so that a
      // reload that finds a value gone reports it, as a reconnect reload
      // does. The waits behind their `heightAhead` markers were cancelled.
      for (const key of Object.keys(record)) setHeightAhead(this, contractID, key, undefined)
    } else if (record) {
      this.config.reactiveDel(rootState._kv!, contractID)
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
      ...Array.from(ids).map((cID) =>
        sbp('chelonia/queueInvocation', cID, ['chelonia/private/noop'])
      ),
      // Contract syncs started to recover from `ChelErrorKvHeightAhead`.
      // Their failure is reported by the operation that started them.
      ...Array.from(this.kvRecoveries.values()).map((sync) =>
        sync.catch(() => {})
      )
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

  'chelonia/kv/_onContractResynced': function (this: CheloniaContext, contractID: string): void {
    if (!this.kvReconnectRefresh.has(contractID)) return
    this.kvReconnectRefresh.delete(contractID)
    if (!this.subscriptionSet.has(contractID)) return
    const perKey = this.kvSlotsByContractID.get(contractID)
    if (!perKey) return
    for (const [, slot] of perKey) {
      if (slot.refreshOnReconnect) {
        loadSlotInBackground(
          this,
          { contractID, slot, reason: KV_UPDATE_REASON.RECONNECT },
          `[chelonia/kv] _loadSlot (reconnect) rejected for ${contractID}::${slot.key}`
        )
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
    const echoKey = joinKey(contractID, key)
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
            logBackgroundLoadRejection(
              `[chelonia/kv] conflict-resolution GET failed for ${contractID}::${key}`,
              e
            )
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
      // calls `setSlotStatus` against a missing entry (which throws in
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
        logBackgroundLoadRejection(
          `[chelonia/kv] no-cid authoritative GET failed for ${contractID}::${key}`,
          e
        )
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
      setSlotStatus(this, rootState, contractID, slot.contractType, key, KV_LOAD_STATUS.ERROR, {
        lastError: normalizeError(e), settle: true
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
    // A remote clear (unwrapped === null) transitions to 'non-init',
    // matching local clear semantics (§4.5). A successful remote update
    // always calls setSlotStatus('loaded') so that any stale `lastError`
    // is cleared (setSlotStatus internally skips the event when both
    // status and lastError are unchanged).
    if (unwrapped === null) {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key,
        emptyOutcomeStatus(this, contractID, key), { settle: true }
      )
    } else {
      setSlotStatus(
        this, rootState, contractID, slot.contractType, key, KV_LOAD_STATUS.LOADED,
        { settle: true }
      )
    }
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

  // Public. See KV-REVAMPED §4.2, §11.3 step 5. The ergonomic write
  // path: resolves the slot, runs the reducer, validates, and writes via
  // `chelonia/kv/set` directly inside
  // the same per-contract queueInvocation lane used by `_handleRemote`.
  //
  // Resolves with the stored value (the reducer's last accepted
  // output), or `undefined` when the reducer returned `KV_NOOP` (which
  // rejects instead when a reload `update` needed failed: nothing then
  // confirmed that there was nothing to write).
  //
  // Rejection taxonomy (§4.2):
  //   - `ChelErrorKvSlotUnknown`   — contract not synced, or no slot
  //                                  registered for `(contractType, key)`.
  //   - `ChelErrorKvUpdateInvalid` — `updater`/`value` misuse; thrown
  //                                  synchronously before any I/O.
  //                                  Also covers reducer throws and
  //                                  reducer returns of `null` /
  //                                  `undefined` (use `KV_NOOP` to
  //                                  abort explicitly), and invalid
  //                                  height-recovery options. The
  //                                  original thrown value is preserved
  //                                  on `.cause`.
  //   - `ChelErrorKvValidation`    — reducer output (or server
  //                                  `currentData` on retry) fails
  //                                  `schema.parse`. Original Zod
  //                                  error attached on `.cause`.
  //   - `ChelErrorKvConflict`      — `maxAttempts` exhausted on real
  //                                  412 contention (409s don't count).
  //                                  `.cause` is `{ currentStatus,
  //                                  currentData, requiredHeight, etag }`
  //                                  of the last response
  //                                  (`kvConflictExhaustedError`).
  //   - `ChelErrorKvHeightAhead`   — the server value is ahead of the
  //                                  local contract, and the height
  //                                  recovery couldn't help (or
  //                                  `onHeightAhead: 'reject'`).
  //   - `ChelErrorKvHeightMalformed` — the server value's height stamp
  //                                  is malformed (`clear` the key).
  //   - `AbortError`               — `signal` (or `chelonia/reset`)
  //                                  aborted. Nothing is written and no
  //                                  value is applied, but when an
  //                                  attempt had found the server value
  //                                  ahead, the abort records it as a
  //                                  load would (`runSlotWrite`): the
  //                                  slot reloads once the contract
  //                                  reaches that height.
  //   - the error of a reload `update` needed, for a `KV_NOOP` (above), on
  //     a basis known to be unverifiable, or under the caller's own
  //     `ifMatch`.
  //   - other errors propagated verbatim from `chelonia/kv/set` (called
  //     directly inside the per-contract queue; not via `queuedSet`) for
  //     non-409/412 HTTP failures (5xx, offline). `status` is NOT flipped
  //     to `'error'` (that state is reserved for load failures — §4.9).
  //
  // A write that recovers from a height error is enqueued again, so a
  // later write to the same key can commit before it (as with an
  // app-level retry). Awaited from code that the contract's lanes await
  // (one of its `sideEffect`s, a `queueInvocation` body for it, an
  // `onconflict`, an `onUpdate`), it never settles: its body queues behind
  // that code. `signal` ends
  // the write at once while its body is still queued (see docs/kv.md,
  // "How height recovery runs").
  'chelonia/kv/update': async function (
    this: CheloniaContext,
    args: {
      contractID: string;
      key: string;
      updater?: KvUpdater<JSONType>;
      value?: JSONType;
      // `null` options, like omitted ones, take their defaults.
      maxAttempts?: number | null;
      signal?: AbortSignal;
      ifMatch?: string;
      // See KV-REVAMPED.md §4.2 step 5a.
      onHeightAhead?: KvHeightAheadMode | null;
      maxHeightRecoveries?: number | null;
    }
  ): Promise<JSONType | undefined> {
    const {
      contractID, key, updater, value, maxAttempts, signal, ifMatch,
      onHeightAhead, maxHeightRecoveries
    } = args
    // ----- Step 1: resolve the slot via active index. -----
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'update')
    // Reject a write re-entered from this contract's own onUpdate
    // callback before any state mutation — it would deadlock the lane.
    assertNotReentrant(this, contractID, key, 'update')
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
    assertValidMaxAttempts(`update: ${contractID}::${key}`, maxAttempts)
    // Honour a pre-aborted signal before touching the network. (Invalid
    // height-recovery options are rejected by `withHeightRecovery` below,
    // before the first attempt.)
    throwIfAborted(signal)
    // Captured once: `chelonia/reset` aborts this controller and replaces it.
    const sessionSignal = this.abortController.signal
    // Track this operation on the pending-writes counter so
    // `chelonia/kv/_waitInFlight` can drain the contract even if the
    // slot index / nonce sources miss it (slot torn down mid-flight,
    // nonce not yet recorded). The increment runs at call time — before
    // the body is enqueued — so a concurrent `reset` cannot escape the
    // gate; `runSlotWrite` decrements it (`.finally`) once every attempt
    // and height recovery has settled.
    incrementPending(this, contractID)
    // The mirror read, reducer, and network write must all run inside the
    // per-contract serial queue so that each write sees the etag left by
    // the preceding one. Reading the mirror outside the queue means
    // concurrent calls all snapshot the same stale etag → guaranteed 412
    // → ONCONFLICT thrashing.
    //
    // After a height recovery (`recoveries > 0`), the mirror is reloaded
    // before the reducer runs, so the reducer's first input is the server
    // value that just became verifiable rather than the stale mirror value
    // (against which it might return `KV_NOOP` and drop the write). Not
    // after an attempt that failed on a clean `409` (a stale height stamp
    // with no `412` before it): its `if-match` held, so the mirror still
    // matches the server.
    let lastAttemptClean409 = false
    // The etag of the value the last failed attempt found ahead.
    let aheadEtag: string | undefined
    const runBody = async (
      attempt: KvHeightRecoveryAttempt,
      forceReload = false
    ): Promise<JSONType | undefined> => {
      const { recoveries, heightWaitMs } = attempt
      const afterClean409 = lastAttemptClean409
      lastAttemptClean409 = false
      throwIfAborted(signal)
      // Re-read rootState inside the queue for fresh mirror state.
      const liveState = sbp(this.config.stateSelector) as ChelRootState
      // Checked on entry and after each reload: the slot may have been
      // replaced or deactivated meanwhile.
      assertSlotActive(this, contractID, slot, 'update')
      const entryBefore = liveState._kv?.[contractID]?.[key]
      // The mirror's server value is known to be unverifiable (see
      // `mirrorBasisUnverified`): seeding the reducer from the mirror or
      // the default would let a reducer that returns `KV_NOOP` drop the
      // write silently (KV-REVAMPED.md §3.3).
      const mirrorKnownStale = mirrorBasisUnverified(this, contractID, key, entryBefore)
      // Nothing tells what the server holds: a slot that hasn't settled in
      // this activation (one that never loaded, or an entry persisted by an
      // earlier session), or an 'error' slot without a value. An 'error'
      // slot that holds a value keeps the data-loss guard below
      // (KV-REVAMPED.md §3.3, §4.2 step 2). Such a basis is reloaded
      // lazily: the reducer runs on the mirror (or the default) first, and
      // the write carries the mirror's etag (`""` for a slot without a
      // value), so a server value this client never read comes back as a
      // `412` and is merged in `onconflict`. Only a `KV_NOOP`, which writes
      // nothing, reloads and runs the reducer again, so that it never drops
      // a write on a wrong basis. A caller's own `ifMatch` (e.g. `'*'`)
      // gives no such protection: the basis is then reloaded first, and the
      // call rejects with that reload's error if it fails.
      const basisUnsettled = entryBefore !== undefined && (
        entryBefore.status === KV_LOAD_STATUS.ERROR
          ? entryBefore.value === undefined
          : entryBefore.settled !== true
      )
      // The one reload this attempt runs before its reducer, if any:
      //  - `'basis'`: the mirror can't serve as the reducer's basis. After a
      //    height recovery (unless `afterClean409`), when its server value
      //    is known to be unverifiable (`mirrorKnownStale`), after a
      //    `KV_NOOP` on an unsettled basis (`forceReload`), and for an
      //    unsettled basis (`basisUnsettled`) that the caller's own
      //    `ifMatch` wouldn't protect.
      //  - `'retained'`: the data-loss guard. When the slot is in 'error'
      //    but still holds a retained value + etag (e.g. a transient
      //    load-network failure that didn't change server state), seeding
      //    the reducer from the default while the write carries
      //    `ifMatch: mirrorEtag` would silently overwrite the real server
      //    value if that etag still matches. One authoritative reload makes
      //    the reducer seed from, and the write guard against, the live
      //    server state instead. If it fails we must NOT fall back to the
      //    default (a default-seeded write could match the retained etag):
      //    the reducer seeds from the retained value, which is exactly what
      //    the retained etag describes, keeping the basis and the
      //    precondition paired (a server value that actually changed
      //    produces a 412 → onconflict re-seed).
      // After a height recovery, the reload is skipped when the mirror
      // already holds, loaded, the value the failed attempt found ahead
      // (`aheadEtag`): the height wait's own reload, queued ahead of this
      // attempt, loaded it. Reloading it again would add a GET, a `'load'`
      // event and an `onUpdate` call (KV-REVAMPED.md §4.2 step 5a). A newer
      // wait or a reload still queued makes `mirrorKnownStale` true.
      const holdsAheadValue = aheadEtag !== undefined &&
        entryBefore?.status === KV_LOAD_STATUS.LOADED && entryBefore.etag === aheadEtag
      const reload: 'basis' | 'retained' | undefined = (
        (recoveries > 0 && !afterClean409 && !holdsAheadValue) ||
        mirrorKnownStale ||
        forceReload ||
        (basisUnsettled && ifMatch !== undefined)
      )
        ? 'basis'
        : entryBefore?.status === KV_LOAD_STATUS.ERROR && entryBefore.value !== undefined
          ? 'retained'
          : undefined
      const recordBefore = liveState._kv?.[contractID]
      // Set when a `'basis'` reload failed (other than on height): the
      // reducer still runs, but nothing confirmed its basis, so a
      // `KV_NOOP` rejects with that failure instead of resolving.
      let failedBasisReload: { error: unknown } | undefined
      if (reload) {
        // Inline (un-queued) load: this body already holds the lane, so
        // awaiting it doesn't deadlock. Both reloads report their outcome
        // as any load does (a `'load'` event and `onUpdate` when they find
        // a value), so a guard reload that verifies the server value takes
        // the slot out of `'error'` even when the reducer then returns
        // `KV_NOOP`. On failure, the prior status is restored.
        const loadBasis = () => sbp('chelonia/kv/_loadSlotNow', {
          contractID,
          slot,
          reason: KV_UPDATE_REASON.LOAD,
          suppressLoadingStatus: true,
          preserveStatusOnError: true
        }) as Promise<void>
        try {
          try {
            await loadBasis()
          } catch (e) {
            // The reload failed (e.g. the server value is still ahead).
            // When it failed on height on the last attempt of `'sync'`
            // (`heightWaitMs` undefined), wait for the height
            // passively first, with the lane held, as `kv/set` would on
            // the same attempt: `maxHeightRecoveries: 0` means "wait, never
            // sync". Reached: reload once more, and handle its failure
            // below, without another wait.
            const required = kvHeightAheadCause(e)?.requiredHeight
            if (
              heightWaitMs !== undefined || required === undefined ||
              !await waitForContractHeight(this, contractID, required, {
                timeoutMs: pubsubSocketNotOpen(this) ? 0 : undefined,
                signals: [signal, sessionSignal]
              })
            ) throw e
            assertSlotActive(this, contractID, slot, 'update')
            await loadBasis()
          }
        } catch (e) {
          // Still unverifiable, or (for the data-loss guard) known to be
          // stale: hand the error to `withHeightRecovery`, which syncs the
          // contract outside the lane and runs this body again (or rejects,
          // with `onHeightAhead: 'reject'` or once the recoveries run out).
          // The reload registered a height wait, so the next attempt
          // reloads first. An abort (also during the wait above) ends the
          // write.
          if (isKvHeightAhead(e)) throw e
          throwIfAnyAborted(signal, sessionSignal)
          if (reload === 'retained') {
            console.warn(
              '[chelonia/kv] update: authoritative reload failed for ' +
              `${contractID}::${key}; seeding reducer from retained value`,
              e
            )
          } else {
            // Any other failure on a mirror known to be stale rejects too:
            // falling back to the default is what this avoids. So does one
            // under the caller's own `ifMatch`: no `412` would catch a
            // reducer that ran on the wrong basis (e.g. `ifMatch: '*'`).
            if (mirrorKnownStale || ifMatch !== undefined) throw e
            // Otherwise not fatal: the write below still carries the
            // mirror etag (`""` for a slot without a value), so a changed
            // server value surfaces as a 412 and is merged in `onconflict`.
            // But a `KV_NOOP` can't be told apart from a write dropped on a
            // wrong basis, so it rejects with this error.
            failedBasisReload = { error: e }
            console.warn(
              `[chelonia/kv] update: reloading ${contractID}::${key} failed; running the ` +
              'reducer on the current mirror value (a KV_NOOP rejects with this error)',
              e
            )
          }
        }
        throwIfAnyAborted(signal, sessionSignal)
        assertSlotActive(this, contractID, slot, 'update')
      }
      // ----- Step 2: read current mirror value. -----
      // From live state, after the reload: a concurrent release+resync could
      // have replaced the `_kv[contractID]` record while the reload awaited
      // (the data-loss guard then falls back to the record it started from).
      const mirrorEntry = ensureContractKv(this, liveState, contractID)[key] ??
        (reload === 'retained' ? recordBefore?.[key] : undefined)
      // Seed precedence. A failed reload restores the prior status (e.g.
      // `'error'`, `preserveStatusOnError`), so we branch on whether a
      // reload ran, NOT on `status`, to
      // know what the (refreshed or retained) mirror value represents:
      //  - reload ran: the mirror value is now either the live server
      //    value (reload success) or the retained value (reload failure).
      //    Both are correctly paired with the etag the write will send, so
      //    seed from it; fall back to the default only when it is
      //    `undefined` (a 404'd reload on a slot with no retained value).
      //    A failed reload leaves the retained value+etag untouched,
      //    keeping the reducer basis and `ifMatch` paired so a no-conflict
      //    commit cannot overwrite live data from a stale default basis.
      //  - no reload: the normal happy path — seed from a non-error live
      //    value, else the default (mirrors `read`'s error semantics for a
      //    genuinely empty / errored slot).
      const seedValue = computeSeedValue(slot, mirrorEntry, reload !== undefined)
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
      const firstResult = validateReducerOutput(slot, reducerOut, contractID, key, '')
      if (firstResult.noop) {
        // A `KV_NOOP` on a basis nothing confirmed: reload it and run the
        // reducer again (once; the reloaded slot has settled).
        if (basisUnsettled && !reload) return runBody(attempt, true)
        if (failedBasisReload) throw failedBasisReload.error
        return undefined
      }
      let nextValue: JSONType = firstResult.value
      // ----- Step 5: kv/set with onconflict. -----
      throwIfAnyAborted(signal, sessionSignal)
      let sawConflict = false
      const onconflict = async (conflictArgs: {
        currentData: JSONType | undefined;
        etag: string | null | undefined;
      }): Promise<[JSONType, string | undefined]> => {
        const { etag } = conflictArgs
        sawConflict = true
        throwIfAborted(signal)
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
            // Clone the parsed result before it reaches the reducer: a
            // mutating reducer must not corrupt the server's cached
            // decode (currentValue.data in kv/set), which the
            // conflict-exhaustion error cause re-reads.
            // Mirrors the first-attempt seed clone (step 2).
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
            // assertJsonShape returns its input unchanged, so clone to
            // detach the reducer's basis from the cached server decode.
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
        const validated: JSONType = retryResult.value
        nextValue = validated
        return [validated, typeof etag === 'string' ? etag : undefined] as [JSONType, string | undefined]
      }
      const mirrorEtag = mirrorEntry?.etag ?? undefined
      const waitBefore = snapshotHeightWait(this, contractID, key)
      let setResult: { etag: string | null }
      try {
        // Call chelonia/kv/set directly (not via queuedSet) since we are
        // already inside the per-contract serial queue. Resolving key IDs
        // here (not at call-site) ensures key rotation that landed before
        // this write is seen; the IDs are fixed for kv/set's retries.
        const keyIds = resolveSlotKeyIds(contractID, key, slot, 'update')
        setResult = await sbp('chelonia/kv/set', contractID, key,
          nextValue,
          {
            // Slots without a value (a 404, or a pre-reducer load that
            // failed): a `non-init` slot has `etag: null`, so
            // `mirrorEtag` is `undefined` and `kv/set` falls back to
            // `if-match: '""'` ("key must not exist"). If the server
            // already holds a value this client never read, the write
            // gets a 412 (not a silent overwrite) and `onconflict`
            // merges against the server's current value as usual.
            ifMatch: ifMatch ?? mirrorEtag,
            encryptionKeyId: keyIds.encryptionKeyId,
            signingKeyId: keyIds.signingKeyId,
            onconflict,
            maxAttempts,
            // `runSlotWrite` recovers: no passive wait with the lane held,
            // except on the last attempt of `'sync'` (`KvHeightRecoveryAttempt`).
            heightWaitMs,
            signal
          }
        ) as { etag: string | null }
      } catch (e) {
        // KV_NOOP abort: onconflict threw KvNoopAbort to signal that the
        // reducer chose not to write. The lower-level kv/set propagates
        // this throw, breaking the retry loop. Resolve as a no-op.
        // Use the Symbol.for marker (not instanceof) for realm safety.
        if (e && typeof e === 'object' && KV_NOOP_ABORT_SYMBOL in (e as object)) {
          return undefined
        }
        // A stale height stamp (`exact: false`, a `409`) without a `412`
        // before it: `if-match` held, so the next attempt needs no reload.
        if (kvHeightAheadCause(e)?.exact === false && !sawConflict) lastAttemptClean409 = true
        // Map the lower-level conflict-exhaustion Error to the public
        // taxonomy (§4.2 step 6 / rejection table).
        if (isKvMaxAttempts(e)) {
          throw kvConflictExhaustedError('update', slot, contractID, key, e)
        }
        throw e
      }
      // ----- Step 6: write mirror + emit events. -----
      await commitSlotWrite(this, {
        op: 'update',
        contractID,
        key,
        slot,
        setResult,
        sawConflict,
        before: waitBefore,
        value: nextValue,
        status: KV_LOAD_STATUS.LOADED,
        onUpdateValue: cloneForEmit(nextValue)
      })
      // Also when the slot was replaced or dropped mid-write, so that no
      // mirror received it, or the caller aborted after the commit: the
      // value DID commit to the server, and `undefined` is reserved for
      // `KV_NOOP`, i.e. "no write happened". Returning the committed value
      // lets callers distinguish a persisted write from a genuine no-op.
      return nextValue
    }
    return runSlotWrite(
      this, contractID, key, `update: ${contractID}::${key}`,
      { onHeightAhead, maxHeightRecoveries, signal },
      (attempt) => runBody(attempt).catch((e: unknown) => {
        const etag = kvHeightAheadCause(e)?.etag
        aheadEtag = typeof etag === 'string' ? etag : undefined
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
  // the rejection semantics of `chelonia/kv/update`. Takes the same height
  // options as `update` (`signal`, `onHeightAhead` and
  // `maxHeightRecoveries`), except that `maxHeightRecoveries: 0`, like
  // `'reject'`, rejects after the first load (the slot is left to its
  // deferred reload) rather than wait passively. Awaited from code that the
  // contract's lanes await (a `sideEffect`, a `queueInvocation` body, an
  // `onconflict`, an `onUpdate`), it never settles (its loads queue behind
  // that code; see docs/kv.md, "How height recovery runs").
  //
  // Aggregate form (no `key`) — dispatches loads for every entry in the
  // last-reconciled active-slot index (`kvSlotsByContractID[contractID]`).
  // The loads are still serialized on the per-contract queue inside
  // `_loadSlot`, and per-slot failures surface via status/events while
  // the aggregate promise resolves after every load settles. It never
  // rejects, and ignores the options.
  'chelonia/kv/sync': async function (
    this: CheloniaContext,
    contractID: string,
    key?: string,
    { signal, onHeightAhead, maxHeightRecoveries }: KvHeightRecoveryOptions = {}
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (key !== undefined) {
      const slot = resolveActiveSlot(this, rootState, contractID, key, 'sync')
      // Reject a sync re-entered from this contract's own onUpdate
      // callback — `_loadSlot` enqueues on the same lane → deadlock.
      assertNotReentrant(this, contractID, key, 'sync')
      // `signal`, then the options: checked after the slot, as in `update`
      // and `clear`, and before any network access.
      throwIfAborted(signal)
      const { mode, maxRecoveries } = resolveHeightRecoveryOptions(
        `sync: ${contractID}::${key}`, { onHeightAhead, maxHeightRecoveries }
      )
      // _loadSlot rethrows GET failures verbatim, and wraps decode /
      // validation failures in ChelErrorKvValidation with the original
      // error on cause. Let the error propagate for the single-slot
      // rejection semantics.
      //
      // A server value that is ahead of the local contract is not a
      // failure (KV-REVAMPED.md §4.4): wait briefly for the contract to
      // catch up, otherwise force-sync it (outside the lane), then load
      // again, up to `maxHeightRecoveries` times. The passive wait is
      // skipped while the pubsub socket isn't open (no contract event can
      // arrive) and while a recovery sync of the contract is running
      // (`recoverContractHeight` joins it at once). This call drives the
      // recovery itself, so it parks the deferred reload `_loadSlotNow`
      // registers (no fallback timer, see `parkHeightWait`) instead of
      // dropping it: `update` keeps refusing the stale mirror as a basis
      // meanwhile, and the slot still reloads at the height if a later
      // round fails for another reason. It un-parks it (a new fallback)
      // when it stops early (abort), and leaves it in place with
      // `onHeightAhead: 'reject'` or `maxHeightRecoveries: 0`, so the slot
      // isn't stranded. Once the recoveries are exhausted the slot loads
      // once more if the height was reached meanwhile; otherwise it
      // settles, its deferred reload stays parked (see
      // `settleHeightAheadFailure`), and the call rejects with
      // `ChelErrorKvHeightAhead`. When the height is reached, the parked
      // wait fires and reloads the slot; the next round awaits that reload
      // (`wait.reload`) instead of loading the key again, so there is no
      // extra GET. The resulting event carries the parked wait's `reason`
      // (`'load'`, or `'remote'` when a frame registered the wait first).
      // Captured once: `chelonia/reset` aborts this controller and replaces it.
      const sessionSignal = this.abortController.signal
      let lastHeightError: unknown
      let requiredHeight = 0
      // The wait the last round parked.
      let parked: KvHeightWait | undefined
      // The reload the parked wait fired, if it has, or else a new load.
      // Raced against the caller's signal and reset's, so that an abort
      // rejects the call at once, also while the GET is in flight or the
      // load waits for the contract's lane; the load goes on, and records
      // its outcome on the slot.
      const load = (suppressLoadingStatus: boolean): Promise<void> => {
        const reload = parked?.reload
        parked = undefined
        return raceAbort(reload ?? startSlotLoad({
          contractID, slot, reason: KV_UPDATE_REASON.LOAD, suppressLoadingStatus
        }), [signal, sessionSignal])
      }
      for (let recoveries = 0; ; recoveries++) {
        try {
          // After the first round, the parked reload may have loaded the
          // slot already (it fires when the height is reached): don't
          // flicker it through `'loading'` again.
          await load(recoveries > 0)
          return
        } catch (e) {
          const cause = kvHeightAheadCause(e)
          if (!cause) throw e
          // The wait `_loadSlotNow` registered keeps its fallback.
          if (mode === 'reject' || maxRecoveries === 0) throw e
          lastHeightError = e
          requiredHeight = cause.requiredHeight
          parked = parkHeightWait(this, {
            contractID, key, requiredHeight, reason: KV_UPDATE_REASON.LOAD
          })
          if (recoveries >= maxRecoveries) break
          try {
            const reached = await waitForContractHeight(this, contractID, requiredHeight, {
              timeoutMs: pubsubSocketNotOpen(this) || this.kvRecoveries.has(contractID)
                ? 0
                : undefined,
              signals: [sessionSignal, signal]
            })
            if (!reached) {
              await recoverContractHeight(this, contractID, e, {
                callerSignal: signal, sessionSignal
              })
            }
            // An abort that lands as the wait or the sync succeeds.
            throwIfAnyAborted(signal, sessionSignal)
          } catch (recoveryError) {
            // A failed or timed-out sync ends the recovery (unless the
            // height was reached meanwhile: `recoverContractHeight` then
            // resolves, and the next round loads). An abort (the
            // caller's, or reset's) propagates as is, after handing the
            // slot back to its deferred reload (only remembered, in case
            // the reset fails, once reset ended the height session),
            // unless that reload has started already, or the wait this
            // round parked is gone (a load that verified the key dropped
            // it, or a newer wait replaced it).
            if (isKvHeightAhead(recoveryError)) break
            if (
              parked?.reload === undefined && (
                this.kvHeightSession.signal.aborted ||
                this.kvHeightWaits.get(heightWaitKey(contractID, key)) === parked
              )
            ) {
              registerHeightWait(this, {
                contractID, key, requiredHeight, reason: KV_UPDATE_REASON.LOAD
              })
            }
            throw recoveryError
          }
        }
      }
      // The height may have been reached since the last load (e.g. pubsub
      // delivered the missing events while the recovery sync ran): the
      // value is verifiable, so report the outcome of loading it. That
      // load is queued behind a recovery sync that is still running on the
      // contract's lane (one that timed out), so the call then settles
      // when that sync ends (or at an abort), not at the recovery timeout. The parked wait
      // fired too: its reload is the load.
      if (isHeightReached(this, contractID, requiredHeight)) {
        await load(true)
        return
      }
      settleHeightAheadFailure(this, contractID, key, requiredHeight)
      throw lastHeightError
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
      // Aggregate form never rejects (§4.4), but log rejections so
      // failed syncs are debuggable — matching the fire-and-forget
      // loads in `_reconcileForSlot` / `_onContractResynced`. A slot
      // whose value is ahead of the local contract stays pending and
      // reloads by itself (§4.9).
      loadSlotInBackground(
        this,
        { contractID, slot, reason: KV_UPDATE_REASON.LOAD },
        `[chelonia/kv] aggregate sync: _loadSlot rejected for ${contractID}::${slot.key}`
      )
    ))
  },

  // Public. See KV-REVAMPED §4.5. Resets a slot to its declared
  // default by writing `null` through the per-contract serial queue via
  // `chelonia/kv/set`. The `null` value is the wire-level clear sentinel; `_handleRemote`
  // on other clients maps it back to the declared default before
  // any `schema.parse`.
  //
  // Local-side behaviour after the network write resolves:
  //   - mirror.value ← undefined (canonical 'non-init'; §4.3/§4.5).
  //     The deep-cloned default is surfaced only via `read`/`onUpdate`,
  //     never written into the raw mirror.
  //   - mirror.etag  ← setResult.etag
  //   - status       ← 'non-init'
  //   - CHELONIA_KV_UPDATED fires with `reason: 'local'` and `value`
  //     set to `undefined` (matching the mirror); `onUpdate` receives
  //     the cloned default
  //   - safeOnUpdateGuarded dispatched
  //
  // Throws `ChelErrorKvSlotUnknown` on the same conditions as
  // `chelonia/kv/update`. Running out of attempts on `412`s rejects with
  // `ChelErrorKvConflict` (`kvConflictExhaustedError`), also when the last
  // conflicting value is ahead (a blind write: nothing to recover). A
  // `ChelErrorKvHeightAhead` (a `409` the contract can't catch up with) is
  // recovered from like `update`'s (`runSlotWrite`). Other errors from
  // `chelonia/kv/set` (called directly inside the per-contract queue; not
  // via `queuedSet`) propagate verbatim. A failed `clear` leaves the
  // mirror's value untouched. When it ran out of attempts on a value that
  // is ahead, the slot still records that value as a load would (the
  // conflict's cause carries its height): the `heightAhead` marker, a
  // settled `'non-init'` slot goes `'loading'`, and it reloads once the
  // height arrives. As with `update`, a `clear` that recovers is enqueued
  // again (a later write to the key can commit before it), and awaiting it
  // from code that the contract's lanes await never settles (see
  // docs/kv.md, "How height recovery runs").
  'chelonia/kv/clear': async function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    {
      maxAttempts,
      signal,
      onHeightAhead,
      maxHeightRecoveries
    }: {
      // `null` options, like omitted ones, take their defaults.
      maxAttempts?: number | null;
      signal?: AbortSignal;
      // See KV-REVAMPED.md §4.5 / §4.2 step 5a.
      onHeightAhead?: KvHeightAheadMode | null;
      maxHeightRecoveries?: number | null;
    } = {}
  ): Promise<void> {
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    const slot = resolveActiveSlot(this, rootState, contractID, key, 'clear')
    // Reject a clear re-entered from this contract's own onUpdate
    // callback before any state mutation — it would deadlock the lane.
    assertNotReentrant(this, contractID, key, 'clear')
    assertValidMaxAttempts(`clear: ${contractID}::${key}`, maxAttempts)
    // (Invalid height-recovery options are rejected by `withHeightRecovery`
    // below, before the first attempt.)
    throwIfAborted(signal)
    // Track on the pending-writes counter (see `update` / `_waitInFlight`).
    incrementPending(this, contractID)
    // One attempt. `withHeightRecovery` below may run it more than once, so
    // the conflict bookkeeping is per attempt (as in `update`): an earlier
    // attempt's conflict must not mark this attempt's echo CID as
    // conflict-resolved.
    const runBody = async ({ heightWaitMs }: KvHeightRecoveryAttempt): Promise<void> => {
      throwIfAborted(signal)
      let sawConflict = false
      const onconflict = async (conflictArgs: {
        currentData: JSONType;
        currentStatus?: KvServerValueStatus;
        etag: string | null;
      }): Promise<[JSONType, string | undefined]> => {
        // Read `etag` (a plain value), but NEVER `currentData`: the real
        // `chelonia/kv/set` passes it as a getter that throws on
        // decrypt/signature failure (chelonia.ts), and clear doesn't depend
        // on the server value. (A conflict-exhaustion rejection reports the
        // value `kv/set` read last; see `kvConflictExhaustedError`.)
        const etag = conflictArgs.etag
        sawConflict = true
        throwIfAborted(signal)
        return [null, typeof etag === 'string' ? etag : undefined] as [JSONType, string | undefined]
      }
      const liveState = sbp(this.config.stateSelector) as ChelRootState
      assertSlotActive(this, contractID, slot, 'clear')
      const mirrorEtag = liveState._kv?.[contractID]?.[key]?.etag ?? undefined
      const waitBefore = snapshotHeightWait(this, contractID, key)
      let setResult: { etag: string | null }
      try {
        // Resolve key IDs inside the queue so rotations that landed
        // before this clear are seen; they stay fixed for kv/set's retries.
        const keyIds = resolveSlotKeyIds(contractID, key, slot, 'clear')
        setResult = await sbp('chelonia/kv/set', contractID, key,
          null,
          {
            ifMatch: mirrorEtag,
            encryptionKeyId: keyIds.encryptionKeyId,
            signingKeyId: keyIds.signingKeyId,
            onconflict,
            maxAttempts,
            // Clearing is a blind write: the current server value doesn't
            // matter, so one that can't be verified yet must not stop it,
            // nor one whose height stamp is malformed (clearing is how such
            // a key is recovered).
            allowUnverifiedConflict: true,
            // `runSlotWrite` recovers: no passive wait with the lane held,
            // except on the last attempt of `'sync'` (`KvHeightRecoveryAttempt`).
            heightWaitMs,
            signal
          }
        ) as { etag: string | null }
      } catch (e) {
        if (isKvMaxAttempts(e)) {
          throw kvConflictExhaustedError('clear', slot, contractID, key, e)
        }
        throw e
      }
      // §4.3/§4.5: a 'non-init' mirror `value` is always `undefined` (the
      // canonical "nothing server-confirmed" representation), matching the
      // 404 branch in `_loadSlotNow`. `read` and `onUpdate` still surface
      // the deep-cloned default; only the raw mirror + event payload carry
      // `undefined` so direct `rootState._kv` observers see one shape.
      await commitSlotWrite(this, {
        op: 'clear',
        contractID,
        key,
        slot,
        setResult,
        sawConflict,
        before: waitBefore,
        value: undefined,
        status: KV_LOAD_STATUS.NON_INIT,
        onUpdateValue: slot.resolvedDefault !== undefined
          ? cloneDeep(slot.resolvedDefault)
          : undefined
      })
    }
    return runSlotWrite(
      this, contractID, key, `clear: ${contractID}::${key}`,
      { onHeightAhead, maxHeightRecoveries, signal }, runBody
    )
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

  // Public. See KV-REVAMPED §4.10. The status the slot of `(contractID,
  // key)` has settled with (`'loaded'`, `'non-init'` or `'error'`), or
  // `undefined` while it hasn't: the slot isn't active, hasn't settled in
  // this activation, or is reloading through `'loading'` after settling.
  // The synchronous counterpart of `whenSettled`. Unlike `status`, it tells
  // "empty" (`'non-init'`) from "not loaded yet" (`undefined`). A copy of
  // the mirror entry (e.g. in a store) has settled when
  // `settled && status !== 'loading'`, on an active slot.
  'chelonia/kv/settledStatus': function (
    this: CheloniaContext,
    contractID: string,
    key: string
  ): Exclude<KvLoadStatus, 'loading'> | undefined {
    return settledStatusOf(this, contractID, key)
  },

  // Public. See KV-REVAMPED §4.10. Resolves with the slot's status once it
  // has settled (`chelonia/kv/settledStatus`), i.e. once the current
  // activation has reached a terminal outcome. Unlike `status`, this tells
  // a settled `'non-init'` (the last verifiable read found no value) apart
  // from a pending one. While a settled slot reloads (status `'loading'`),
  // it waits for the reload to finish, so it never resolves with
  // `'loading'`. That includes a `'non-init'` slot whose server value turns
  // out to be ahead of the local contract: it goes `'loading'` until the
  // value loads (`'loaded'`) or the deferred load gives up (`'error'`).
  //
  // Does not require the slot to be active yet: it waits for activation
  // too, so it can be called before the contract has synced. But it
  // rejects with `ChelErrorKvSlotUnknown` when the slot can't settle: at
  // once when no slot is defined for `key` (for the contract's type, once
  // known), or when the contract's slots have been reconciled and this one
  // isn't active (its `match` is false); and while it waits, when the
  // contract's type turns out to have no such slot, or the slot doesn't
  // activate (its `match` is false), is deactivated (its `match` turned
  // false, or it was unregistered), or the contract is removed. A removal
  // for a resync (e.g. a dirty contract) keeps it waiting: it settles once
  // the slot reloads after the resync (if the resync fails, it waits until
  // the contract is released, or `signal` aborts). Whether `match` holds is
  // only re-evaluated by `chelonia/kv/refreshFilters`; this doesn't wait
  // for a slot whose `match` might turn true later.
  // Rejects with the abort reason when `signal` aborts (also when it
  // already has, even for a settled slot), and with an `AbortError` on
  // `chelonia/reset` (a later session's slots must not resolve it). A slot
  // that is never loaded (`autoLoad: 'never'` / `'on-demand'` without a
  // `sync`, `update` or `clear`, or a pubsub frame) never settles: pass a
  // `signal` (e.g. `AbortSignal.timeout(…)`) when that can happen.
  //
  // Like `update` and `sync`, a `whenSettled` that has to wait can't be
  // awaited by code that the contract's lanes await (a `sideEffect`, a
  // `queueInvocation` body, an `onconflict`, an `onUpdate` after its first
  // `await`): the load it waits for queues behind that code, so it never
  // resolves (see docs/kv.md, "How height recovery runs"). Only the
  // synchronous part of an `onUpdate` is detected: waiting there rejects
  // with `ChelErrorKvReentrant` (a settled slot still resolves, since
  // nothing is waited for). There is no portable way to tell which lane
  // the caller runs in otherwise.
  'chelonia/kv/whenSettled': function (
    this: CheloniaContext,
    contractID: string,
    key: string,
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<Exclude<KvLoadStatus, 'loading'>> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const current = settledStatusOf(this, contractID, key)
    if (current !== undefined) return Promise.resolve(current)
    const rootState = sbp(this.config.stateSelector) as ChelRootState
    if (!slotDefinedFor(this, rootState, contractID, key)) {
      return Promise.reject(new ChelErrorKvSlotUnknown(
        `[chelonia/kv] whenSettled: no slot is defined for ${contractID}::${key}`
      ))
    }
    if (
      this.kvReconciledContracts.has(contractID) &&
      this.subscriptionSet.has(contractID) &&
      !this.kvSlotsByContractID.get(contractID)?.has(key)
    ) {
      return Promise.reject(new ChelErrorKvSlotUnknown(
        `[chelonia/kv] whenSettled: the slot for ${contractID}::${key} isn't active for ` +
        'this contract (its `match` is false)'
      ))
    }
    try {
      assertNotReentrant(this, contractID, key, 'whenSettled')
    } catch (e) {
      return Promise.reject(e)
    }
    return new Promise<Exclude<KvLoadStatus, 'loading'>>((resolve, reject) => {
      const waitKey = joinKey(contractID, key)
      // Captured: `chelonia/reset` replaces the map (and rejects this call).
      const settleWaiters = this.kvSettleWaiters
      const cleanup = () => {
        offStatus()
        signal?.removeEventListener('abort', onAbort)
        const waiters = settleWaiters.get(waitKey)
        waiters?.delete(onDeactivated)
        if (waiters?.size === 0) settleWaiters.delete(waitKey)
      }
      const onAbort = () => {
        cleanup()
        reject(abortReason(signal!))
      }
      // Called by `rejectSettleWaiters` when the slot can't settle any more.
      const onDeactivated = (e: Error) => {
        cleanup()
        reject(e)
      }
      // Re-checks the mirror rather than trusting the event's `settled`,
      // which also covers inactive entries (e.g. persisted ones revalidated
      // by `defineSlot`) and the start of a settled slot's reload.
      const offStatus = sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, (payload: {
        contractID: string; key: string
      }) => {
        if (payload.contractID !== contractID || payload.key !== key) return
        const status = settledStatusOf(this, contractID, key)
        if (status === undefined) return
        cleanup()
        resolve(status)
      }) as () => void
      signal?.addEventListener('abort', onAbort, { once: true })
      let waiters = settleWaiters.get(waitKey)
      if (!waiters) {
        waiters = new Set()
        settleWaiters.set(waitKey, waiters)
      }
      waiters.add(onDeactivated)
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
      // Deactivate it on every contract whose index entry points at it.
      for (const [cID, perKey] of Array.from(this.kvSlotsByContractID)) {
        if (perKey.get(key) !== slot) continue
        deactivateSlotForContract(this, rootState, cID, key, 'was unregistered')
      }
      // The index loop above only covers contracts in `kvSlotsByContractID`
      // (subscribed/reconciled ones). `_defineSlotInternal` also persists /
      // re-validates `_kv[cID][key]` entries for contracts NOT in
      // `subscriptionSet` (e.g. carried over from a prior session, not yet
      // re-synced); those never enter the index, so the loop above leaves
      // them behind. Walk the mirror directly and deactivate the slot on
      // those holding an entry for it, dropping that entry, so
      // unregistering the slot doesn't leak persisted state (and doesn't
      // trip `_assertIndexConsistent` once the contract re-syncs).
      // Entries whose contract type can't be confirmed to match are left
      // alone — re-validating/deleting against the wrong type would clobber
      // foreign data; the next sync's load/reconcile reconciles them.
      if (rootState._kv) {
        for (const cID of Object.keys(rootState._kv)) {
          if (this.subscriptionSet.has(cID)) continue
          if (getContractType(rootState, cID) !== contractType) continue
          if (!rootState._kv[cID]?.[key]) continue
          deactivateSlotForContract(this, rootState, cID, key, 'was unregistered')
        }
      }
    }
    // A `whenSettled` waiting for a slot that was never active (e.g. its
    // contract hasn't synced yet) and that no definition covers any more.
    rejectUndefinedSettleWaiters(this, rootState)
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
  // `_reconcileForSlot` walk itself. Like the reconcile of an added
  // contract, it rejects the `whenSettled` calls waiting for a key that the
  // contract's type defines no slot for.
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
      reconcileContract(this, rootState, cID, contractType)
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
    // its `lastError` (setSlotStatus suppresses the no-op event).
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
      setSlotStatus(ctx, rootState, contractID, slot.contractType, slot.key, KV_LOAD_STATUS.LOADED)
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
          setSlotStatus(
            ctx, rootState, contractID, slot.contractType, slot.key, KV_LOAD_STATUS.LOADED
          )
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
        setSlotStatus(
          ctx, rootState, contractID, slot.contractType, slot.key,
          KV_LOAD_STATUS.ERROR, { lastError: normalizeError(e) }
        )
      }).catch((err: unknown) => {
        console.error(
          `[chelonia/kv] re-validate ERROR flip enqueue failed for ${contractID}::${slot.key}`, err
        )
      })
    } else {
      setSlotStatus(
        ctx, rootState, contractID, slot.contractType, slot.key,
        KV_LOAD_STATUS.ERROR, { lastError: normalizeError(e) }
      )
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
