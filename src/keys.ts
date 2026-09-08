// Declarative, name-addressed key API.
//
// This module layers a spec-driven vocabulary on top of the existing
// `chelonia/out/*` key operations without changing the Shelter wire format
// (see docs/keys.md for the guide).
//
// Everything in the first half of this file (types, markers, normalization,
// `expandKeySpecs`, `expandKeyUpdateSpecs`, reference resolution) is pure
// with respect to Chelonia/SBP: contract state is passed in explicitly and
// no selector is called. The `EncryptedData` wrappers it produces are lazy,
// so encryption (and any state lookup it needs) happens at serialization
// time, not at expansion time. The selectors at the bottom (`chelonia/key/
// generate`, `chelonia/key/rotate`) wire the pure engine into Chelonia's
// root state and secret storage.

import type { Key } from '@chelonia/crypto'
import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  deserializeKey,
  keyId,
  keygen,
  keygenOfSameType,
  serializeKey
} from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import type {
  SPKey,
  SPKeyMeta,
  SPKeyPurpose,
  SPKeyType,
  SPKeyUpdate,
  SPOpKeyUpdate
} from './SPMessage.js'
import { SPMessage } from './SPMessage.js'
import { isValidInviteQuantity } from './constants.js'
import {
  encryptedDataKeyId,
  encryptedOutgoingData,
  encryptedOutgoingDataWithRawKey,
  isEncryptedData
} from './encryptedData.js'
import {
  ChelErrorKeyNameNotFound,
  ChelErrorKeySpecInvalid,
  ChelErrorKeyWrapCycle
} from './errors.js'
import type { PublishOptions } from './internals.js'
import { Secret } from './Secret.js'
import type {
  ChelContractKey,
  ChelContractState,
  CheloniaContext,
  SendMessageHooks
} from './types.js'
import { copiedExistingData, findKeyIdByName, findSuitableSecretKeyId } from './utils.js'
import type {
  ChelActionParams,
  ChelKeyAddParams,
  ChelKeyDelParams,
  ChelKeyRequestResponseParams,
  ChelKeyShareParams,
  ChelKeyUpdateParams,
  ChelShareKeysParams,
  NestedInvocationParams
} from './chelonia.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Explicit marker for an invite key that may be used any number of times.
// Omitting `quantity` means the same thing (processing only decrements and
// exhausts an invite that carries `meta.quantity`), but reaching 'unlimited'
// by omission is easy to do by accident, so this symbol lets a caller say it
// on purpose. It never reaches the wire: both spellings produce an `SPKey`
// without `meta.quantity`.
export const UNLIMITED_INVITE_USES: unique symbol = Symbol.for(
  'chelonia/keys/unlimitedInviteUses'
) as never

// What `encryptWith` may reference:
//   - a plain string: another key in the same spec set (alias or final wire
//     name), or — in `keyAdd` contexts — an active key name in the
//     target contract
//   - `{ contractID, name }`: an active key in a specific loaded contract
//   - `{ key }`: a raw key (e.g. a just-derived replacement wrapper)
export type KeySpecWrapTarget =
  | string
  | { contractID: string, name: string }
  | { key: Key }

// A partial, name-addressed description of a key. Everything else (id, data,
// curve type, wrapping, conventions) is derived by `expandKeySpecs`.
export type KeySpec = {
  // The final wire name. In object form the record key is the alias and
  // `name` overrides the wire name; in array form the alias is carried
  // separately by `keySpec(alias, spec)` and `name` has the same meaning.
  // Omit to use the alias as the wire name.
  name?: string
  // Use this raw key (e.g. a password-derived IPK/IEK) instead of generating.
  key?: Key
  // Generate a new key of this type. Default: inferred from `purpose` or
  // taken from `key`/`data`.
  type?: SPKeyType
  // Omit = public half only (no `meta.private.content`).
  encryptWith?: KeySpecWrapTarget
  // Default: inferred from type/key.
  purpose?: SPKeyPurpose[]
  // Required for ordinary names; `#sak` → 0 and `#inviteKey*` →
  // Number.MAX_SAFE_INTEGER by convention.
  ringLevel?: number
  // Default: [] (fail-closed).
  permissions?: '*' | string[]
  // Default: [] (fail-closed).
  allowedActions?: '*' | string[]
  // `meta.private.transient`: password-derived, never persisted on processing.
  transient?: boolean
  // `meta.private.shareable`.
  shareable?: boolean
  // Invite keys: how many times the key may be used, as a positive safe
  // integer. Omit — or pass `UNLIMITED_INVITE_USES` for an explicit,
  // self-documenting declaration — for an invite with unlimited uses.
  quantity?: number | typeof UNLIMITED_INVITE_USES
  expires?: number
  // Build a foreign key entry from an active key in another (loaded)
  // contract: `shelter:<contractID>?keyName=<name>` URI plus copied public
  // data. Default final wire name: `<originContractID>/<originKeyId>`.
  foreignKeyFrom?: [contractID: string, keyName: string]
  // Or provide the foreign key URI directly (requires `data`).
  foreignKey?: string
  // Merged over generated meta. Cannot override generated `content` or
  // convention invariants.
  meta?: SPKeyMeta
  // Provide the public half directly (implies: no generation, no secret).
  data?: string
}

// A `KeySpec` marked with the `keySpec()` prototype tag, for use in arrays
// alongside raw `SPKey` / `EncryptedData<SPKey>` entries. `alias` is the
// caller-chosen label (the record-key equivalent in map form); it may differ
// from the spec's wire `name`, mirroring `MarkedKeyUpdateSpec`.
export type MarkedKeySpec = KeySpec & { alias: string }

// Object form: record key is the caller alias.
export type KeySpecMap = Record<string, KeySpec>

// One expanded key. `key` is `undefined` for data-only / foreign entries,
// which have no local secret material (and are therefore never passed to
// transient secret storage).
export type GeneratedKey = {
  // The final wire name (`#inviteKey-<id>` for invite keys).
  name: string
  id: string
  // Raw key — treat as sensitive. Callers needing the serialized secret
  // (invite links, recovery metadata) call `serializeKey(k.key, true)`
  // explicitly.
  key?: Key
  // The assembled, ready-to-publish key.
  spkey: SPKey
}

// Keyed by caller alias. Sensitive: never log or serialize a `KeyMap`.
export type KeyMap = Record<string, GeneratedKey>

// Explicit state access for the pure expansion engine. No SBP calls are
// made during expansion; contract state must be supplied by the caller.
export type KeyExpansionContext = {
  contractID?: string
  contractState?: ChelContractState
  getContractState?: (contractID: string) => ChelContractState | undefined
}

// An update to an existing key. Exactly one of `oldKeyId` / `oldKeyName` is
// required (both may be given, in which case they must agree). `rotate: true`
// generates a same-type replacement; `key` supplies a replacement directly;
// neither means a policy/meta-only update that emits no `id`/`data`.
// `name` is an optional consistency assertion: when given, it must equal the
// existing key's wire name (names cannot be updated).
export type KeyUpdateSpec = {
  name?: string
  oldKeyId?: string
  oldKeyName?: string
  key?: Key
  rotate?: boolean
  encryptWith?: KeySpecWrapTarget
  purpose?: SPKeyPurpose[]
  permissions?: '*' | string[]
  allowedActions?: '*' | string[]
  transient?: boolean
  shareable?: boolean
  meta?: SPKeyMeta
}

// Array-form marker: `alias` is a caller-chosen label (the record-key
// equivalent in map form), used for deduplication and as the default
// `oldKeyName`. It may differ from the existing key's wire name.
export type MarkedKeyUpdateSpec = KeyUpdateSpec & { alias: string }

export type KeyUpdateSpecMap = Record<string, KeyUpdateSpec>

// Raw replacement keys produced by `expandKeyUpdateSpecs`, keyed by the
// (existing) key wire name.
export type RotationKeyMap = Record<string, { id: string, key: Key }>

export type KeyUpdateExpansionResult = {
  updates: SPOpKeyUpdate
  newKeys: RotationKeyMap
}

// A `[selector, params]` pair allowed inside `chelonia/out/atomic`. The batch
// supplies the target contract, and signer-less entries inherit the batch's
// signing reference, so those fields are optional per entry.
export type AtomicInvocation =
  | ['chelonia/out/actionEncrypted', NestedInvocationParams<ChelActionParams>]
  | ['chelonia/out/actionUnencrypted', NestedInvocationParams<ChelActionParams>]
  | ['chelonia/out/keyAdd', NestedInvocationParams<ChelKeyAddParams>]
  | ['chelonia/out/keyDel', NestedInvocationParams<ChelKeyDelParams>]
  | ['chelonia/out/keyUpdate', NestedInvocationParams<ChelKeyUpdateParams>]
  | [
    'chelonia/out/keyRequestResponse',
    NestedInvocationParams<ChelKeyRequestResponseParams>
  ]
  | ['chelonia/out/keyShare', NestedInvocationParams<ChelKeyShareParams>]
  | ['chelonia/out/shareKeys', NestedInvocationParams<ChelShareKeysParams>]

// ---------------------------------------------------------------------------
// Markers (prototype tags, same technique as EncryptedData — never instanceof)
// ---------------------------------------------------------------------------

const keySpecProto = Object.create(null, {
  _isKeySpec: { value: true }
})

const keyUpdateSpecProto = Object.create(null, {
  _isKeyUpdateSpec: { value: true }
})

// Marker factory for the array form of key specs. The alias is a
// caller-chosen label (the record-key equivalent in map form), used in the
// returned `KeyMap`, `encryptWith`, and name-based registration fields; it
// may differ from the spec's wire `name`.
export const keySpec = (alias: string, spec: KeySpec = {}): MarkedKeySpec => {
  if (!alias || typeof alias !== 'string') {
    throw new TypeError('keySpec: alias must be a non-empty string')
  }
  return Object.setPrototypeOf({ ...spec, alias }, keySpecProto) as MarkedKeySpec
}

export const isKeySpec = (value: unknown): value is MarkedKeySpec =>
  !!value && !!(Object.getPrototypeOf(value) as { _isKeySpec?: boolean } | null)?._isKeySpec

// Marker factory for the array form of key update specs. The alias is a
// caller-chosen label, not the wire name; use `oldKeyName`/`oldKeyId` (or
// rely on the alias defaulting to `oldKeyName`) to select the key.
export const keyUpdateSpec = (
  alias: string,
  spec: KeyUpdateSpec = {}
): MarkedKeyUpdateSpec => {
  if (!alias || typeof alias !== 'string') {
    throw new TypeError('keyUpdateSpec: alias must be a non-empty string')
  }
  return Object.setPrototypeOf(
    { ...spec, alias },
    keyUpdateSpecProto
  ) as MarkedKeyUpdateSpec
}

export const isKeyUpdateSpec = (value: unknown): value is MarkedKeyUpdateSpec =>
  !!value && !!(Object.getPrototypeOf(value) as { _isKeyUpdateSpec?: boolean } | null)
    ?._isKeyUpdateSpec

// ---------------------------------------------------------------------------
// Reserved names / conventions
// ---------------------------------------------------------------------------

// Module-private: the conventional names are referenced by string literal in
// the rest of the library (`utils.ts`, `internals.ts`) and are not part of the
// published surface.
const SAK_NAME = '#sak'
const INVITE_KEY_NAME = '#inviteKey'
// Key-request response keys. Only the suffixed form exists: the ids are
// generated by `chelonia/out/keyRequest` as `#krrk-<replyKeyId>`.
const KRRK_NAME_PREFIX = '#krrk-'
// Human-readable form of the reserved namespace, for error messages.
const RESERVED_NAME_FORMS = [
  SAK_NAME,
  INVITE_KEY_NAME,
  INVITE_KEY_NAME + '-*',
  KRRK_NAME_PREFIX + '*'
]

const isReservedName = (name: string): boolean => name.startsWith('#')

const isInviteName = (name: string): boolean =>
  name === INVITE_KEY_NAME || name.startsWith(INVITE_KEY_NAME + '-')

// Only the exact conventional names and their documented suffixed forms are
// recognized. Near misses (`#sak-1`, a bare `#krrk`) are almost always typos,
// and accepting them would silently produce an ordinary key that none of the
// convention handling in `utils.ts` / `internals.ts` matches.
const isKnownReservedName = (name: string): boolean =>
  name === SAK_NAME || isInviteName(name) || name.startsWith(KRRK_NAME_PREFIX)

const typeSupportsPurpose = (type: string, purpose: SPKeyPurpose): boolean => {
  if (purpose === 'enc') return type === CURVE25519XSALSA20POLY1305
  return type === EDWARDS25519SHA512BATCH
}

const inferTypeFromPurpose = (purpose: SPKeyPurpose[]): SPKeyType => {
  const hasEnc = purpose.includes('enc')
  const hasSigOrSak = purpose.includes('sig') || purpose.includes('sak')
  if (hasEnc && hasSigOrSak) {
    throw new ChelErrorKeySpecInvalid(
      `Cannot infer a key type for purpose ${JSON.stringify(purpose)}: ` +
        "'enc' requires a curve key and 'sig'/'sak' require an edwards key"
    )
  }
  if (hasEnc) return CURVE25519XSALSA20POLY1305
  if (hasSigOrSak) return EDWARDS25519SHA512BATCH
  throw new ChelErrorKeySpecInvalid(
    `Cannot infer a key type for empty purpose ${JSON.stringify(purpose)}`
  )
}

const defaultPurposeForType = (type: string): SPKeyPurpose[] =>
  type === CURVE25519XSALSA20POLY1305 ? ['enc'] : ['sig']

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export type NormalizedKeySpec = { alias: string, spec: KeySpec }

// Normalize the object and (marked) array forms into an ordered list of
// `{ alias, spec }` entries. Rejects duplicate aliases and unmarked array
// entries. Shared by the addition and update spec forms, which differ only in
// their marker predicate and the wording of their errors.
const normalizeSpecs = <S>(
  input: Record<string, S> | { alias: string }[],
  isMarked: (value: unknown) => boolean,
  kind: {
    noun: string
    // The selector parameter the input came from, used in error messages.
    paramName: string
    mapType: string
    factory: string
    arrayHint?: string
  }
): { alias: string, spec: S }[] => {
  const entries: { alias: string, spec: S }[] = []
  const seen = new Set<string>()

  const add = (alias: string, spec: S): void => {
    if (!alias) {
      throw new ChelErrorKeySpecInvalid(`Empty ${kind.noun} alias`)
    }
    // Without this, a `null` / `undefined` entry (easy to produce from a
    // conditional in an object literal) would reach field access during
    // expansion and surface as a bare 'cannot read properties of undefined'
    // instead of one of the pointed errors this API otherwise produces.
    if (spec == null || typeof spec !== 'object') {
      throw new ChelErrorKeySpecInvalid(
        `${kind.paramName}: '${alias}' must be a ${kind.noun} object`
      )
    }
    // Object input cannot yield duplicate aliases, so this only ever fires
    // for the array form. Applied to both so they behave identically.
    if (seen.has(alias)) {
      throw new ChelErrorKeySpecInvalid(`Duplicate ${kind.noun} alias: ${alias}`)
    }
    seen.add(alias)
    entries.push({ alias, spec })
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isMarked(item)) {
        throw new ChelErrorKeySpecInvalid(
          `Array ${kind.noun}s must be created with ${kind.factory}(alias, spec)` +
            (kind.arrayHint != null ? `; ${kind.arrayHint}` : '')
        )
      }
      add(item.alias, item as unknown as S)
    }
  } else {
    if (input == null || typeof input !== 'object') {
      throw new TypeError(
        `${kind.paramName} must be a ${kind.mapType} object or an array of ` +
          `${kind.factory}() entries`
      )
    }
    for (const [alias, spec] of Object.entries(input)) {
      add(alias, spec)
    }
  }

  return entries
}

export const normalizeKeySpecs = (input: KeySpecMap | MarkedKeySpec[]): NormalizedKeySpec[] =>
  normalizeSpecs<KeySpec>(input as Record<string, KeySpec> | { alias: string }[], isKeySpec, {
    noun: 'key spec',
    paramName: 'keys',
    mapType: 'KeySpecMap',
    factory: 'keySpec',
    arrayHint:
      'found an unmarked entry. Raw SPKey objects may be mixed in at the ' +
      'selector level, not inside the spec list.'
  })

export type NormalizedKeyUpdateSpec = { alias: string, spec: KeyUpdateSpec }

export const normalizeKeyUpdateSpecs = (
  input: KeyUpdateSpecMap | MarkedKeyUpdateSpec[]
): NormalizedKeyUpdateSpec[] =>
  normalizeSpecs<KeyUpdateSpec>(
    input as Record<string, KeyUpdateSpec> | { alias: string }[],
    isKeyUpdateSpec,
    {
      noun: 'key update spec',
      paramName: 'updates',
      mapType: 'KeyUpdateSpecMap',
      factory: 'keyUpdateSpec'
    }
  )

// ---------------------------------------------------------------------------
// Key-reference resolution: every `*KeyId` parameter has a `*KeyName` twin,
// and at least one of each pair is required (see docs/keys.md).
// ---------------------------------------------------------------------------

const findGeneratedKeyByAliasOrName = (
  keyMap: KeyMap,
  name: string,
  label: string
): string => {
  // Wire name first, so that a name resolves to the same key here as it does
  // in `encryptWith` resolution and in on-chain lookups (`findKeyIdByName`).
  // The alias is only a local label and is the fallback. The two coincide
  // unless a spec set deliberately uses one key's alias as another key's
  // wire name.
  const byWireName = Object.values(keyMap).find((k) => k.name === name)
  if (byWireName) return byWireName.id
  const byAlias = keyMap[name]
  if (byAlias) return byAlias.id
  throw new ChelErrorKeyNameNotFound(`${label}: unknown key name '${name}'`)
}

// Resolve an id/name pair against a generated `KeyMap`. Names resolve against
// both the caller aliases and the final wire names. Returns the key id, or
// the passed-through id value (`string | null | undefined`) when no reference
// was given and none is required.
export const resolveGeneratedKeyReference = (
  keyMap: KeyMap,
  id: string | null | undefined,
  name: string | null | undefined,
  label: string,
  required = true
): string | null | undefined => {
  if (id == null && name == null) {
    if (required) {
      throw new TypeError(`${label}: either a key ID or a key name must be provided`)
    }
    return id
  }
  if (id != null) {
    if (name != null) {
      const resolved = findGeneratedKeyByAliasOrName(keyMap, name, label)
      if (resolved !== id) {
        throw new ChelErrorKeyNameNotFound(
          `${label}: key name '${name}' resolves to ${resolved} but key ID ${id} was given`
        )
      }
    }
    return id
  }
  return findGeneratedKeyByAliasOrName(keyMap, name!, label)
}

// Resolve an id/name pair against a contract state. Names resolve to the
// current unrevoked key with that name. A mismatch between a provided id and
// the resolved name is an error (almost certainly a stale key or a bug).
export const resolveStateKeyReference = (
  state: ChelContractState | undefined,
  id: string | null | undefined,
  name: string | null | undefined,
  label: string,
  required = true
): string | null | undefined => {
  if (id == null && name == null) {
    if (required) {
      throw new TypeError(`${label}: either a key ID or a key name must be provided`)
    }
    return id
  }
  if (id != null) {
    if (name != null) {
      const currentId = state && findKeyIdByName(state, name)
      if (currentId !== id) {
        throw new ChelErrorKeyNameNotFound(
          `${label}: key name '${name}' resolves to ${String(currentId)} ` +
            `but key ID ${id} was given`
        )
      }
    }
    return id
  }
  if (!state) {
    throw new ChelErrorKeyNameNotFound(
      `${label}: cannot resolve key name '${name}' because the contract state ` +
        'is not loaded'
    )
  }
  const currentId = findKeyIdByName(state, name!)
  if (!currentId) {
    throw new ChelErrorKeyNameNotFound(
      `${label}: no active key with name '${name}' in contract state`
    )
  }
  return currentId
}

// ---------------------------------------------------------------------------
// Pure expansion engine
// ---------------------------------------------------------------------------

type MaterializedSpec = {
  alias: string
  spec: KeySpec
  wireName: string
  finalName: string
  isSak: boolean
  isInvite: boolean
  type?: string
  purpose: SPKeyPurpose[]
  ringLevel: number
  permissions: '*' | string[]
  allowedActions: '*' | string[]
  key?: Key
  id: string
  data: string
  foreignKey?: string
  wrapWith?: KeySpecWrapTarget
  hasSecret: boolean
}

// Extract the wrapping key id from a `meta.private.content` value, which may
// be a live `EncryptedData` wrapper (outgoing direction) or its serialized
// tuple form (processed contract state).
const contentWrapperId = (content: unknown): string | undefined => {
  if (content == null) return undefined
  const raw = isEncryptedData(content) ? content.serialize() : content
  if (raw == null) return undefined
  return encryptedDataKeyId(raw)
}

export const expandKeySpecs = (params: {
  keys: KeySpecMap | MarkedKeySpec[]
  context?: KeyExpansionContext
}): KeyMap => {
  const { context } = params
  const entries = normalizeKeySpecs(params.keys)
  const getContractState = context?.getContractState

  const materialized: MaterializedSpec[] = []
  const byFinalName = new Map<string, MaterializedSpec>()
  const byId = new Map<string, MaterializedSpec>()

  const register = (m: MaterializedSpec): void => {
    if (byFinalName.has(m.finalName)) {
      throw new ChelErrorKeySpecInvalid(`Duplicate final key name: ${m.finalName}`)
    }
    if (byId.has(m.id)) {
      throw new ChelErrorKeySpecInvalid(
        `Duplicate key ID ${m.id} (generated for both '${byId.get(m.id)!.alias}' ` +
          `and '${m.alias}')`
      )
    }
    byFinalName.set(m.finalName, m)
    byId.set(m.id, m)
  }

  // --- stages 1-5: normalize, apply conventions, materialize keys ---------
  for (const { alias, spec } of entries) {
    const wireName = spec.name ?? alias
    if (!wireName || typeof wireName !== 'string') {
      throw new ChelErrorKeySpecInvalid(`Invalid key name for alias '${alias}'`)
    }
    if (isReservedName(wireName) && !isKnownReservedName(wireName)) {
      throw new ChelErrorKeySpecInvalid(
        `Unknown reserved key name '${wireName}': the '#' namespace is ` +
          `limited to ${RESERVED_NAME_FORMS.join(', ')}`
      )
    }

    const isSak = wireName === SAK_NAME
    const isInvite = isInviteName(wireName)

    if (spec.key != null && spec.type != null) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': 'key' and 'type' are mutually exclusive`
      )
    }
    if (spec.key != null && spec.data != null) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': 'key' and 'data' are mutually exclusive ` +
          '(the public half is derived from the raw key)'
      )
    }
    if (spec.data != null && spec.type != null) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': 'data' and 'type' are mutually exclusive ` +
          '(the type is derived from the public key material in \'data\')'
      )
    }
    // `encryptWith` is the only declared way to produce wrapped secret
    // material: it validates the wrapper's purpose, resolves it against the
    // spec set or the target contract, and rejects cycles. Content supplied
    // directly here would bypass all of that and, since it is never checked
    // against the key it is attached to, can only be redundant (when
    // `encryptWith` is also given, where the generated content wins anyway)
    // or wrong — `keyAdditionProcessor` would decrypt it and persist the
    // result as this key's secret. Hand-crafted entries belong in the raw
    // `SPKey` form accepted by `chelonia/out/keyAdd`.
    if (spec.meta?.private?.content != null) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': 'meta.private.content' cannot be set on a key ` +
          "spec; use 'encryptWith' to declare how the secret is wrapped"
      )
    }

    // Conventional names carry processing-time invariants a foreign key can
    // never satisfy: '#sak' must be a contract-local, policy-free accounting
    // key, and invite accounting needs a locally held secret and local
    // invite bookkeeping.
    // Both foreign branches return before the convention checks below, so
    // reject the combination here rather than emitting a key that only
    // misbehaves once every client processes it.
    if (isReservedName(wireName) && (spec.foreignKey != null || spec.foreignKeyFrom != null)) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': reserved name '${wireName}' cannot be declared as a foreign key`
      )
    }

    // ---- foreign key built from another contract ---------------------------
    if (spec.foreignKeyFrom != null) {
      const [originID, originKeyName] = spec.foreignKeyFrom
      if (!originID || !originKeyName) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': foreignKeyFrom must be [contractID, keyName]`
        )
      }
      if (spec.key != null || spec.type != null || spec.data != null) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': foreignKeyFrom cannot be combined with 'key', ` +
            "'type' or 'data' (the public half is copied from the origin contract)"
        )
      }
      if (spec.encryptWith != null) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': foreignKeyFrom produces no secret material, so ` +
            "'encryptWith' cannot be used"
        )
      }
      if (!getContractState) {
        throw new ChelErrorKeyNameNotFound(
          `Key spec '${alias}': foreignKeyFrom requires contract state access ` +
            `(no state lookup was provided for origin contract ${originID})`
        )
      }
      const originState = getContractState(originID)
      if (!originState?._vm?.authorizedKeys) {
        throw new ChelErrorKeyNameNotFound(
          `Key spec '${alias}': origin contract ${originID} is not loaded; ` +
            'retain and sync it before building foreign keys from it'
        )
      }
      const originKeyId = findKeyIdByName(originState, originKeyName)
      if (!originKeyId) {
        throw new ChelErrorKeyNameNotFound(
          `Key spec '${alias}': no active key named '${originKeyName}' in ` +
            `origin contract ${originID}`
        )
      }
      const originKey = originState._vm.authorizedKeys[originKeyId] as ChelContractKey
      const m: MaterializedSpec = {
        alias,
        spec,
        wireName,
        finalName: spec.name ?? `${originID}/${originKeyId}`,
        isSak: false,
        isInvite: false,
        purpose: spec.purpose ?? (originKey.purpose as SPKeyPurpose[]),
        ringLevel: requireRingLevel(spec, alias, false, false),
        permissions: spec.permissions ?? [],
        allowedActions: spec.allowedActions ?? [],
        id: originKeyId,
        data: originKey.data,
        foreignKey:
          `shelter:${encodeURIComponent(originID)}` +
          `?keyName=${encodeURIComponent(originKeyName)}`,
        hasSecret: false
      }
      materialized.push(m)
      register(m)
      continue
    }

    // ---- foreign key given directly as a URI --------------------------------
    if (spec.foreignKey != null) {
      if (spec.data == null) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': a direct 'foreignKey' declaration requires 'data' ` +
            '(the public half of the origin key)'
        )
      }
      if (spec.encryptWith != null) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': a foreign key declaration has no secret material, ` +
            "so 'encryptWith' cannot be used"
        )
      }
      const foreignType = deserializeTypeOf(spec.data, alias)
      const m: MaterializedSpec = {
        alias,
        spec,
        wireName,
        finalName: wireName,
        isSak: false,
        isInvite: false,
        type: foreignType,
        purpose: spec.purpose ?? defaultPurposeForType(foreignType),
        ringLevel: requireRingLevel(spec, alias, false, false),
        permissions: spec.permissions ?? [],
        allowedActions: spec.allowedActions ?? [],
        id: keyId(spec.data),
        data: spec.data,
        foreignKey: spec.foreignKey,
        hasSecret: false
      }
      materialized.push(m)
      register(m)
      continue
    }

    // ---- #sak convention invariants (fail at authoring time) ---------------
    if (isSak) validateSakPolicy(spec)

    // ---- invite conventions --------------------------------------------------
    // `quantity` is optional: an invite without `meta.quantity` is an
    // unlimited invite, which `OP_KEY_REQUEST` processing supports on
    // purpose (it only decrements and exhausts invites that carry one).
    // `UNLIMITED_INVITE_USES` declares that explicitly and expands to the
    // same wire form. What is rejected is a numeric quantity that no invite
    // can honour.
    validateQuantity(spec, alias)

    // ---- determine type / key / purpose --------------------------------------
    let type: string | undefined
    let key: Key | undefined
    let data: string | undefined

    if (spec.key != null) {
      key = spec.key
      type = key.type
    } else if (spec.data != null) {
      data = spec.data
      type = deserializeTypeOf(data, alias)
    } else if (spec.type != null) {
      type = spec.type
    } else if (spec.purpose != null && spec.purpose.length > 0) {
      type = inferTypeFromPurpose(spec.purpose)
    } else if (isSak || isInvite) {
      // Convention names default to edwards keys (`#sak` is always an
      // edwards server-accounting key; invite keys are edwards signing keys).
      type = EDWARDS25519SHA512BATCH
    } else {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': nothing to derive the key from — provide one of ` +
          "'key', 'type', 'purpose' or 'data'"
      )
    }

    if (
      type !== EDWARDS25519SHA512BATCH &&
      type !== CURVE25519XSALSA20POLY1305
    ) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': unsupported contract key type '${type}' ` +
          `(expected ${EDWARDS25519SHA512BATCH} or ${CURVE25519XSALSA20POLY1305})`
      )
    }

    const purpose: SPKeyPurpose[] = isSak
      ? ['sak']
      : (spec.purpose ?? defaultPurposeForType(type))

    for (const p of purpose) {
      if (!typeSupportsPurpose(type, p)) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': purpose '${p}' is not compatible with key type '${type}'`
        )
      }
    }

    if (key == null && data == null) {
      key = keygen(type)
    }

    const id = key != null ? keyId(key) : keyId(data!)
    const finalName = isInvite && wireName === INVITE_KEY_NAME
      ? `${INVITE_KEY_NAME}-${id}`
      : wireName

    const m: MaterializedSpec = {
      alias,
      spec,
      wireName,
      finalName,
      isSak,
      isInvite,
      type,
      purpose,
      ringLevel: requireRingLevel(spec, alias, isSak, isInvite),
      permissions: spec.permissions ?? [],
      allowedActions: spec.allowedActions ?? [],
      ...(key != null && { key }),
      id,
      data: data ?? serializeKey(key!, false),
      ...(spec.encryptWith != null && { wrapWith: spec.encryptWith }),
      hasSecret: key != null
    }
    materialized.push(m)
    register(m)
  }

  // --- stage 6: wrapping resolution + cycle detection ----------------------
  type WrapResolution =
    | { kind: 'set', target: MaterializedSpec }
    | { kind: 'rawKey', target: Key }
    | { kind: 'contract', contractID: string, keyId: string }

  // Same precedence as `findGeneratedKeyByAliasOrName`: wire name first,
  // alias as the fallback.
  const findInSet = (name: string): MaterializedSpec | undefined =>
    byFinalName.get(name) ?? materialized.find((m) => m.alias === name)

  const assertEncPurpose = (
    key: ChelContractKey | undefined,
    label: string
  ): void => {
    if (!key || !Array.isArray(key.purpose) || !key.purpose.includes('enc')) {
      throw new ChelErrorKeySpecInvalid(
        `encryptWith references '${label}', which is not an encryption key`
      )
    }
  }

  const resolveWrapTarget = (
    alias: string,
    wrapWith: KeySpecWrapTarget
  ): WrapResolution => {
    if (typeof wrapWith === 'string') {
      const inSet = findInSet(wrapWith)
      if (inSet) {
        assertEncPurpose(
          { purpose: inSet.purpose } as ChelContractKey,
          wrapWith
        )
        return { kind: 'set', target: inSet }
      }
      // Not in the set: an active key in the target contract (keyAdd
      // contexts; update specs only accept `{ key }`).
      if (context?.contractID != null) {
        const state = context.contractState ?? getContractState?.(context.contractID)
        if (state) {
          const wrapperId = findKeyIdByName(state, wrapWith)
          if (wrapperId != null) {
            assertEncPurpose(state._vm?.authorizedKeys?.[wrapperId], wrapWith)
            return { kind: 'contract', contractID: context.contractID, keyId: wrapperId }
          }
        }
      }
      throw new ChelErrorKeyNameNotFound(
        `Key spec '${alias}': encryptWith references '${wrapWith}', which is ` +
          'neither another key in the same set nor an active key in the target contract'
      )
    }
    if ('key' in wrapWith) {
      if (!wrapWith.key) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${alias}': encryptWith was given an empty raw key`
        )
      }
      return { kind: 'rawKey', target: wrapWith.key }
    }
    // { contractID, name }
    const state = getContractState?.(wrapWith.contractID)
    if (!state?._vm?.authorizedKeys) {
      throw new ChelErrorKeyNameNotFound(
        `Key spec '${alias}': encryptWith references contract ` +
          `${wrapWith.contractID}, which is not loaded`
      )
    }
    const wrapperId = findKeyIdByName(state, wrapWith.name)
    if (!wrapperId) {
      throw new ChelErrorKeyNameNotFound(
        `Key spec '${alias}': no active key named '${wrapWith.name}' in contract ` +
          wrapWith.contractID
      )
    }
    assertEncPurpose(state._vm.authorizedKeys[wrapperId], wrapWith.name)
    return { kind: 'contract', contractID: wrapWith.contractID, keyId: wrapperId }
  }

  // Build in-set edges and detect multi-node cycles (self-wrap is valid).
  const edges = new Map<string, string>()
  for (const m of materialized) {
    if (m.wrapWith == null || typeof m.wrapWith !== 'string') continue
    const target = findInSet(m.wrapWith)
    if (target) {
      if (!target.hasSecret) {
        throw new ChelErrorKeySpecInvalid(
          `Key spec '${m.alias}': encryptWith references '${m.wrapWith}', which ` +
            'has no secret material to wrap with'
        )
      }
      edges.set(m.alias, target.alias)
    }
  }
  detectWrapCycles(edges)

  const wrapTargets = new Map<string, WrapResolution>()
  for (const m of materialized) {
    if (m.wrapWith == null) continue
    if (!m.hasSecret) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${m.alias}': 'encryptWith' requires secret material, but this ` +
          'spec produces a public-half-only key'
      )
    }
    wrapTargets.set(m.alias, resolveWrapTarget(m.alias, m.wrapWith))
  }

  // --- stages 7-9: assemble -------------------------------------------------
  const keyMap: KeyMap = Object.create(null) as KeyMap
  for (const m of materialized) {
    const meta = buildMeta(m, wrapTargets.get(m.alias))
    const spkey: SPKey = {
      id: m.id,
      name: m.finalName,
      purpose: m.purpose,
      ringLevel: m.ringLevel,
      permissions: m.permissions,
      allowedActions: m.allowedActions,
      ...(meta != null && { meta }),
      data: m.data,
      ...(m.foreignKey != null && { foreignKey: m.foreignKey })
    }
    keyMap[m.alias] = {
      name: m.finalName,
      id: m.id,
      ...(m.key != null && { key: m.key }),
      spkey
    }
  }
  return keyMap
}

const deserializeTypeOf = (data: string, alias: string): string => {
  try {
    return deserializeKey(data).type
  } catch (e) {
    throw new ChelErrorKeySpecInvalid(
      `Key spec '${alias}': 'data' is not a valid serialized public key`, { cause: e }
    )
  }
}

const requireRingLevel = (
  spec: KeySpec,
  alias: string,
  isSak: boolean,
  isInvite: boolean
): number => {
  if (spec.ringLevel != null) return spec.ringLevel
  if (isSak) return 0
  if (isInvite) return Number.MAX_SAFE_INTEGER
  throw new ChelErrorKeySpecInvalid(
    `Key spec '${alias}': 'ringLevel' is required for ordinary key names — ` +
      'it is a security decision, not a detail'
  )
}

// `keyAdditionProcessor` (src/utils.ts) rejects any #sak that violates these
// invariants at processing time; validating here surfaces the same error at
// authoring time, at the right stack trace.
const validateSakPolicy = (spec: KeySpec): void => {
  if (
    spec.purpose != null &&
    (spec.purpose.length !== 1 || spec.purpose[0] !== 'sak')
  ) {
    throw new ChelErrorKeySpecInvalid("#sak must have exactly one purpose: 'sak'")
  }
  if (spec.ringLevel != null && spec.ringLevel !== 0) {
    throw new ChelErrorKeySpecInvalid('#sak must have ringLevel 0')
  }
  if (
    spec.permissions === '*' ||
    (Array.isArray(spec.permissions) && spec.permissions.length > 0)
  ) {
    throw new ChelErrorKeySpecInvalid('#sak may not have permissions')
  }
  if (
    spec.allowedActions === '*' ||
    (Array.isArray(spec.allowedActions) && spec.allowedActions.length > 0)
  ) {
    throw new ChelErrorKeySpecInvalid('#sak may not have allowedActions')
  }
  if (spec.type != null && spec.type !== EDWARDS25519SHA512BATCH) {
    throw new ChelErrorKeySpecInvalid('#sak must be an edwards key')
  }
}

// Reject a `quantity` no invite can honour, on the spec or in caller-supplied
// `meta`. Absent (or `UNLIMITED_INVITE_USES`) is valid and means unlimited;
// `0`, fractions, `NaN`, negatives and unsafe integers are not, since such a
// key is either dead on arrival or indistinguishable from corruption once
// every client processes it.
const validateQuantity = (spec: KeySpec, alias: string): void => {
  const check = (quantity: unknown, where: string) => {
    if (quantity == null || quantity === UNLIMITED_INVITE_USES) return
    if (!isValidInviteQuantity(quantity)) {
      throw new ChelErrorKeySpecInvalid(
        `Key spec '${alias}': '${where}' must be a positive safe integer or ` +
          'UNLIMITED_INVITE_USES (omit it for an invite with unlimited uses)'
      )
    }
  }
  check(spec.quantity, 'quantity')
  check(spec.meta?.quantity, 'meta.quantity')
}

// Build the final `meta` for a materialized spec, merging caller-provided
// meta under the generated fields (caller meta may add unrelated fields but
// cannot override generated `content`, `transient` or `shareable`).
// `meta.private.content` in particular is rejected during validation, so the
// wrapped secret below is always the one this function derived.
const buildMeta = (
  m: MaterializedSpec,
  wrap:
    | { kind: 'set', target: MaterializedSpec }
    | { kind: 'rawKey', target: Key }
    | { kind: 'contract', contractID: string, keyId: string }
    | undefined
): SPKeyMeta | undefined => {
  const callerMeta = m.spec.meta ?? {}
  const generated: SPKeyMeta = {}

  // `UNLIMITED_INVITE_USES` is an authoring-time marker for 'no quantity',
  // so it is dropped here rather than emitted: the wire form of an
  // unlimited invite is simply an `SPKey` without `meta.quantity`.
  if (m.spec.quantity != null && m.spec.quantity !== UNLIMITED_INVITE_USES) {
    generated.quantity = m.spec.quantity as number
  }
  if (m.spec.expires != null) generated.expires = m.spec.expires

  if (m.hasSecret) {
    const secret = serializeKey(m.key!, true)
    const priv: NonNullable<SPKeyMeta['private']> = {}
    if (wrap != null) {
      if (wrap.kind === 'set') {
        priv.content = encryptedOutgoingDataWithRawKey(wrap.target.key!, secret)
      } else if (wrap.kind === 'rawKey') {
        priv.content = encryptedOutgoingDataWithRawKey(wrap.target, secret)
      } else {
        priv.content = encryptedOutgoingData(wrap.contractID, wrap.keyId, secret)
      }
    }
    if (m.spec.transient === true) priv.transient = true
    if (m.spec.shareable === true) priv.shareable = true
    if (Object.keys(priv).length > 0) generated.private = priv
  }

  if (
    Object.keys(generated).length === 0 &&
    Object.keys(callerMeta).length === 0
  ) {
    return undefined
  }

  const merged: SPKeyMeta = { ...callerMeta }
  // A caller that spelled the marker inside `meta` (only reachable from
  // plain JavaScript) gets the same treatment as the spec-level field.
  if ((merged.quantity as unknown) === UNLIMITED_INVITE_USES) delete merged.quantity
  if (generated.quantity != null) merged.quantity = generated.quantity
  if (generated.expires != null) merged.expires = generated.expires
  if (generated.private != null || callerMeta.private != null) {
    merged.private = {
      ...callerMeta.private,
      ...(generated.private ?? {})
    } as SPKeyMeta['private']
  }
  if (merged.private != null && Object.keys(merged.private).length === 0) {
    delete merged.private
  }
  if (Object.keys(merged).length === 0) return undefined
  return merged
}

// Detect wrapping cycles involving two or more distinct aliases. Self-wrap
// (`a -> a`, common for self-encrypted CEKs) is a valid terminal edge: the
// key's own secret half is encrypted under itself.
const detectWrapCycles = (edges: Map<string, string>): void => {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): void => {
    const status = state.get(node)
    if (status === 'done') return
    if (status === 'visiting') {
      const cycleStart = stack.indexOf(node)
      const cycle = [...stack.slice(cycleStart), node].join(' -> ')
      throw new ChelErrorKeyWrapCycle(`Key wrapping cycle detected: ${cycle}`)
    }
    state.set(node, 'visiting')
    stack.push(node)
    const next = edges.get(node)
    // A self-edge is terminal and valid; only follow edges to other nodes.
    if (next != null && next !== node) visit(next)
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of edges.keys()) visit(node)
}

// ---------------------------------------------------------------------------
// Update-spec expansion (work package 7)
// ---------------------------------------------------------------------------

export const expandKeyUpdateSpecs = (params: {
  updates: KeyUpdateSpecMap | MarkedKeyUpdateSpec[]
  contractID: string
  contractState: ChelContractState
}): KeyUpdateExpansionResult => {
  const { contractID, contractState } = params
  const entries = normalizeKeyUpdateSpecs(params.updates)
  const authorizedKeys = contractState._vm?.authorizedKeys ?? {}

  type ResolvedUpdate = {
    alias: string
    spec: KeyUpdateSpec
    existing: ChelContractKey
    oldKeyId: string
    newKey?: Key
    newId?: string
    newData?: string
  }

  const resolved: ResolvedUpdate[] = []

  for (const { alias, spec } of entries) {
    // The spec alias (record key or `keyUpdateSpec(alias, ...)` name) is the
    // natural name of the key being updated: when neither `oldKeyId` nor
    // `oldKeyName` is given, the alias serves as `oldKeyName`. Kept in a
    // local — expansion must not mutate caller-provided spec objects. The
    // normalizers guarantee a non-empty alias, so the key being updated is
    // always identified by this point and there is nothing left to validate.
    const oldKeyName = spec.oldKeyName ?? (spec.oldKeyId == null ? alias : undefined)

    let oldKeyId: string
    if (spec.oldKeyId != null) {
      oldKeyId = spec.oldKeyId
      if (oldKeyName != null) {
        const byName = findKeyIdByName(contractState, oldKeyName)
        if (byName !== oldKeyId) {
          throw new ChelErrorKeyNameNotFound(
            `Key update spec '${alias}': oldKeyName '${oldKeyName}' resolves ` +
              `to ${String(byName)} but oldKeyId ${oldKeyId} was given`
          )
        }
      }
    } else {
      oldKeyId = findKeyIdByName(contractState, oldKeyName!)!
      if (!oldKeyId) {
        throw new ChelErrorKeyNameNotFound(
          `Key update spec '${alias}': no active key named '${oldKeyName}' ` +
            `in contract ${contractID}`
        )
      }
    }

    const existing = authorizedKeys[oldKeyId]
    if (!existing) {
      throw new ChelErrorKeyNameNotFound(
        `Key update spec '${alias}': old key ${oldKeyId} does not exist in ` +
          `contract ${contractID}`
      )
    }
    if (existing._notAfterHeight != null) {
      throw new ChelErrorKeyNameNotFound(
        `Key update spec '${alias}': old key ${oldKeyId} has been revoked`
      )
    }

    if (spec.name != null && spec.name !== existing.name) {
      throw new ChelErrorKeyNameNotFound(
        `Key update spec '${alias}': 'name' is an optional consistency assertion ` +
          `and '${spec.name}' does not match the existing key name ` +
          `'${existing.name}' (names cannot be updated; the alias is a label, ` +
          'select the key with oldKeyName/oldKeyId)'
      )
    }

    let newKey: Key | undefined
    if (spec.rotate === true) {
      if (spec.key != null) {
        throw new ChelErrorKeySpecInvalid(
          `Key update spec '${alias}': 'rotate' and 'key' are mutually exclusive`
        )
      }
      newKey = keygenOfSameType(existing.data)
    } else if (spec.key != null) {
      newKey = spec.key
      if (newKey.type !== deserializeKey(existing.data).type) {
        throw new ChelErrorKeySpecInvalid(
          `Key update spec '${alias}': replacement key type '${newKey.type}' ` +
            'does not match the existing key type'
        )
      }
    }

    resolved.push({
      alias,
      spec,
      existing,
      oldKeyId,
      newKey,
      newId: newKey != null ? keyId(newKey) : undefined,
      newData: newKey != null ? serializeKey(newKey, false) : undefined
    })
  }

  // Second pass: re-wrap secrets. If a key's current wrapper is itself being
  // replaced in this same set, wrap with the NEW raw key; otherwise wrap
  // by-id against the contract so a concurrent rotation of the wrapper
  // still decrypts (the two-case rule, one implementation).
  const oldIdToNewKey = new Map<string, Key>()
  for (const r of resolved) {
    if (r.newKey != null) oldIdToNewKey.set(r.oldKeyId, r.newKey)
  }

  const updates: SPOpKeyUpdate = resolved.map((r) => {
    const { existing, spec } = r
    const update: SPKeyUpdate = {
      name: existing.name,
      oldKeyId: r.oldKeyId
    }

    if (r.newKey != null) {
      update.id = r.newId
      update.data = r.newData
    }

    const existingPriv = existing.meta?.private
    const existingContent = existingPriv?.content
    const wrapperId = contentWrapperId(existingContent)
    const secret = r.newKey != null ? serializeKey(r.newKey, true) : undefined

    // Explicit `encryptWith` in update specs only accepts a raw key
    // ({ key }); wrapping under another contract or by name is not
    // supported for replacements.
    const explicitRawWrapper =
      spec.encryptWith != null && typeof spec.encryptWith !== 'string' && 'key' in spec.encryptWith
        ? spec.encryptWith.key
        : undefined
    if (spec.encryptWith != null && explicitRawWrapper == null) {
      throw new ChelErrorKeySpecInvalid(
        `Key update spec '${r.alias}': 'encryptWith' in update specs only ` +
          'supports { key } targets'
      )
    }
    if (spec.encryptWith != null && secret == null) {
      throw new ChelErrorKeySpecInvalid(
        `Key update spec '${r.alias}': 'encryptWith' requires a replacement key ` +
          "('rotate' or 'key')"
      )
    }
    // Mirrors the addition-spec rejection: `encryptWith` is the only declared
    // way to produce wrapped secret material, and content supplied here is
    // never validated against the key it is attached to.
    if (spec.meta?.private?.content != null) {
      throw new ChelErrorKeySpecInvalid(
        `Key update spec '${r.alias}': 'meta.private.content' cannot be set on an ` +
          "update spec; use 'encryptWith: { key }' to wrap the replacement secret"
      )
    }

    const mergedMeta = { ...existing.meta, ...(spec.meta ?? {}) } as SPKeyUpdate['meta']
    if (secret != null) {
      const priv = {
        ...existingPriv,
        ...(spec.meta?.private ?? {})
      } as NonNullable<NonNullable<SPKeyUpdate['meta']>['private']>
      const transient = spec.transient ?? priv.transient === true
      if (transient) priv.transient = true
      else delete priv.transient
      const shareable = spec.shareable ?? priv.shareable === true
      if (shareable) priv.shareable = true
      else delete priv.shareable

      let wrapped = false
      if (explicitRawWrapper != null) {
        priv.content = encryptedOutgoingDataWithRawKey(explicitRawWrapper, secret)
        wrapped = true
      } else {
        const rotatingWrapper = wrapperId != null ? oldIdToNewKey.get(wrapperId) : undefined
        if (rotatingWrapper != null) {
          priv.content = encryptedOutgoingDataWithRawKey(rotatingWrapper, secret)
          wrapped = true
        } else if (wrapperId != null) {
          priv.content = encryptedOutgoingData(contractID, wrapperId, secret)
          wrapped = true
        }
      }
      if (!wrapped) {
        // No wrapper was applied, so any `content` copied from the existing
        // key would encrypt the old secret. Drop it.
        delete priv.content
        // Without a wrapper the new secret lives only in transient storage.
        // Nothing goes on-chain, and `keyAdditionProcessor` only persists
        // secrets it can decrypt from `meta.private.content`, so the key
        // would be lost after reload. Transient keys (password-derived
        // roots, invite keys whose secret travels out of band) legitimately
        // have no wrapper.
        if (!transient) {
          throw new ChelErrorKeySpecInvalid(
            `Key update spec '${r.alias}': the existing key has no wrapped secret. A ` +
              "replacement requires 'encryptWith: { key }', or the new secret becomes " +
              "unrecoverable after reload. Set 'transient: true' if the secret is managed " +
              'by the caller (e.g. an invite link).'
          )
        }
      }
      if (Object.keys(priv).length > 0) mergedMeta!.private = priv
      else if (mergedMeta != null) delete mergedMeta.private
    } else if (mergedMeta != null) {
      // Policy-only update: preserve existing private meta (including the
      // encrypted content, copied verbatim) unless the caller overrides it.
      if (existingPriv != null || spec.meta?.private != null) {
        mergedMeta.private = {
          ...existingPriv,
          ...(spec.meta?.private ?? {})
        } as NonNullable<SPKeyUpdate['meta']>['private']
      }
      // The copied content is the serialized tuple from processed state, not
      // a live EncryptedData. Without this marker the sender's local
      // processing (keyAdditionProcessor) would treat it as fresh content
      // and throw when the sender lacks the target key's secret — the
      // legacy raw path avoids this by omitting `meta` entirely. Symbols
      // don't serialize, so remote receivers are unaffected.
      if (existingPriv?.content != null) {
        Object.defineProperty(mergedMeta, copiedExistingData, { value: true })
      }
    }

    if (mergedMeta != null && Object.keys(mergedMeta).length > 0) {
      update.meta = mergedMeta
    }

    if (spec.purpose != null) update.purpose = spec.purpose
    if (spec.permissions != null) update.permissions = spec.permissions
    if (spec.allowedActions != null) update.allowedActions = spec.allowedActions

    return update
  })

  const newKeys: RotationKeyMap = Object.create(null) as RotationKeyMap
  for (const r of resolved) {
    if (r.newKey != null) {
      newKeys[r.existing.name] = { id: r.newId!, key: r.newKey }
    }
  }

  return { updates, newKeys }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

// Shared helper: store every generated/provided raw key as transient. The
// storage invocation is transient regardless of `KeySpec.transient`; the
// spec flag only controls `meta.private.transient` (and therefore eventual
// persistence when the operation is processed by `keyAdditionProcessor`).
export const storeGeneratedSecretKeys = (
  ctx: CheloniaContext,
  keys: Iterable<{ key?: Key }>
): void => {
  const rawKeys = Array.from(keys)
    .filter((k) => k.key != null)
    .map((k) => ({ key: k.key!, transient: true }))
  if (rawKeys.length > 0) {
    sbp('chelonia/storeSecretKeys', new Secret(rawKeys))
  }
}

export default sbp('sbp/selectors/register', {
  // Two-phase, composable key generation. Expands the given specs against
  // the (optional) target contract, stores every raw key transiently, and
  // returns the `KeyMap`. No messages are created or sent.
  'chelonia/key/generate': function (
    this: CheloniaContext,
    params: {
      contractID?: string
      keys: KeySpecMap | MarkedKeySpec[]
    }
  ): KeyMap {
    const rootState = sbp(this.config.stateSelector)
    const contractState = params.contractID != null
      ? rootState[params.contractID] as ChelContractState | undefined
      : undefined
    const keyMap = expandKeySpecs({
      keys: params.keys,
      context: {
        contractID: params.contractID,
        ...(contractState != null && { contractState }),
        getContractState: (contractID: string) =>
          rootState[contractID] as ChelContractState | undefined
      }
    })
    storeGeneratedSecretKeys(this, Object.values(keyMap))
    return keyMap
  },
  // Generic key rotation, promoted from Group Income's rotateKeysInternal.
  // See docs/keys.md.
  'chelonia/key/rotate': async function (
    this: CheloniaContext,
    params: {
      contractID: string
      contractName: string
      names: string[] | '*' | 'pending'
      signingKeyId?: string
      signingKeyName?: string
      additionalOperations?: (
        newKeys: RotationKeyMap,
        context: { lastAttempt?: boolean }
      ) => Promise<{ before?: AtomicInvocation[], after?: AtomicInvocation[] } | void>
      lastAttempt?: boolean
      hooks?: SendMessageHooks
      publishOptions?: PublishOptions
    }
  ): Promise<(KeyUpdateExpansionResult & { msg?: SPMessage }) | undefined> {
    const { contractID, contractName, names, additionalOperations } = params
    const rootState = sbp(this.config.stateSelector)
    const state = rootState[contractID] as ChelContractState | undefined
    if (!state?._vm?.authorizedKeys) {
      throw new Error(`chelonia/key/rotate: contract ${contractID} is not loaded`)
    }

    // --- select the keys to rotate -----------------------------------------
    const pendingRevocations = state._volatile?.pendingKeyRevocations ?? {}
    const activeKeys = Object.values(state._vm.authorizedKeys).filter(
      (k) => k._notAfterHeight == null
    )

    let selected: ChelContractKey[]
    if (names === '*') {
      selected = activeKeys
    } else if (names === 'pending') {
      // Entries whose revocation marker is exactly `true` (not 'del')
      selected = activeKeys.filter((k) => pendingRevocations[k.id] === true)
    } else {
      selected = names.map((name) => {
        const keyId = findKeyIdByName(state, name)
        if (!keyId) {
          throw new ChelErrorKeyNameNotFound(
            `chelonia/key/rotate: no active key named '${name}' in ${contractID}`
          )
        }
        return state._vm.authorizedKeys[keyId]
      })
    }

    // Only keys whose secret is recoverable (wrapped) and locally available
    // can be rotated.
    selected = selected.filter(
      (k) => k.meta?.private?.content != null && sbp('chelonia/haveSecretKey', k.id)
    )

    if (selected.length === 0) return undefined

    // --- expand one update set (two-case wrapper handling inside) ----------
    const updateSpecs: KeyUpdateSpecMap = Object.create(null) as KeyUpdateSpecMap
    for (const k of selected) {
      if (updateSpecs[k.name] == null) updateSpecs[k.name] = { rotate: true }
    }
    const { updates, newKeys } = expandKeyUpdateSpecs({
      updates: updateSpecs,
      contractID,
      contractState: state
    })
    storeGeneratedSecretKeys(this, Object.values(newKeys))

    // --- extra operations around the OP_KEY_UPDATE -------------------------
    // Invoked before signer selection so the required permissions match what
    // is actually published: a callback that returns nothing publishes a bare
    // OP_KEY_UPDATE, which a key without OP_ATOMIC can sign. The callback only
    // builds invocations (nothing is published), so running it before the
    // signer is validated is safe.
    const extraOps = await additionalOperations?.(newKeys, {
      ...(params.lastAttempt != null && { lastAttempt: params.lastAttempt })
    })
    const extraBefore = extraOps?.before ?? []
    const extraAfter = extraOps?.after ?? []
    const hasExtraOps = extraBefore.length > 0 || extraAfter.length > 0

    // --- choose the signing key (for what will actually be published) ------
    const requiredOps = hasExtraOps
      ? [SPMessage.OP_ATOMIC, SPMessage.OP_KEY_UPDATE]
      : [SPMessage.OP_KEY_UPDATE]
    const hasExplicitSigner = params.signingKeyId != null || params.signingKeyName != null
    let signingKeyId: string | undefined = hasExplicitSigner
      ? resolveStateKeyReference(
        state,
        params.signingKeyId ?? null,
        params.signingKeyName ?? null,
        'chelonia/key/rotate signingKey'
      ) as string | undefined
      : undefined
    if (signingKeyId == null) {
      // Sign at the minimum ringLevel of the rotated set so the
      // OP_KEY_UPDATE passes validateKeyAddPermissions for every rotated key.
      const minRingLevel = Math.min(...selected.map((k) => k.ringLevel))
      signingKeyId = findSuitableSecretKeyId(
        state,
        requiredOps,
        ['sig'],
        minRingLevel
      ) ?? undefined
    }
    if (!signingKeyId) {
      throw new Error(
        `chelonia/key/rotate: no suitable signing key with ${requiredOps.join(' + ')} ` +
          `permission in ${contractID}`
      )
    }

    // --- publish -------------------------------------------------------------
    const oldKeyIds = updates.map((u) => (u as SPKeyUpdate).oldKeyId)
    const callerPreSendCheck = params.hooks?.preSendCheck
    const hooks: SendMessageHooks = {
      ...params.hooks,
      preSendCheck: async (entry, currentState) => {
        if (callerPreSendCheck != null && !(await callerPreSendCheck(entry, currentState))) {
          return false
        }
        // Stale-update suppression: if every old key has already been
        // revoked by the time we are about to send, skip publishing.
        const allRevoked = oldKeyIds.every(
          (id) => currentState?._vm?.authorizedKeys?.[id]?._notAfterHeight != null
        )
        return !allRevoked
      }
    }

    let msg: SPMessage | undefined
    if (!hasExtraOps) {
      msg = (await sbp('chelonia/out/keyUpdate', {
        contractID,
        contractName,
        data: updates,
        signingKeyId,
        hooks,
        publishOptions: params.publishOptions,
        atomic: false
      })) as SPMessage
    } else {
      const data: AtomicInvocation[] = [
        ...extraBefore,
        ['chelonia/out/keyUpdate', {
          contractID,
          contractName,
          data: updates,
          signingKeyId,
          atomic: true
        }] as AtomicInvocation,
        ...extraAfter
      ]
      msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName,
        signingKeyId,
        data,
        hooks,
        publishOptions: params.publishOptions
      })) as SPMessage
    }

    return { updates, newKeys, msg }
  }
}) as string[]
