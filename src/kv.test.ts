// KV slot API tests — 82 cases total: 27 from KV-REVAMPED.md §11.6
// plus 55 implementation-specific cases covering KV hardening follow-ups
// and §11.3 step 3 exceptions.
//
// We register simplified infrastructure selectors once (mutable stub
// closures) and swap the stub targets per-test in beforeEach. No
// sbp/selectors/overwrite — the domain is never re-registered.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, before, beforeEach, describe, it } from 'node:test'

import '@sbp/okturtles.events'
import {
  ChelErrorKvConflict,
  ChelErrorKvReentrant,
  ChelErrorKvSlotInvalid,
  ChelErrorKvSlotUnknown,
  ChelErrorKvUpdateInvalid,
  ChelErrorKvValidation
} from './errors.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
import { KV_ECHO_CID_MAX, KV_ECHO_TTL_MS, KV_KEY_SEPARATOR } from './kv-constants.js'
import { KV_NOOP } from './kv.js'
import type {
  ChelKvGetResult,
  ChelRootState,
  CheloniaConfig,
  CheloniaContext,
  JSONType,
  ParsedEncryptedOrUnencryptedMessage
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const objectSchema = {
  parse (v: unknown): { x: number } {
    if (v === null || v === undefined) throw new Error('schema rejected')
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('schema rejected')
    return v as { x: number }
  }
}

const strictSchema = {
  parse (v: unknown): { x: number } {
    if (v === null || v === undefined) throw new Error('strict schema rejected')
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('strict schema rejected')
    const obj = v as { x: unknown }
    if (typeof obj.x !== 'number' || obj.x <= 0) {
      throw new Error('strict schema: x must be positive number')
    }
    return obj as { x: number }
  }
}

const anySchema = {
  parse (v: unknown): unknown {
    if (v === null || v === undefined) throw new Error('any schema rejected')
    return v
  }
}

const CTYPE = 'test-contract'

const fakeParsed = (
  data: JSONType
): ParsedEncryptedOrUnencryptedMessage<JSONType> & { etag: string | null } => ({
  data,
  encryptionKeyId: 'ek',
  signingKeyId: 'sk',
  etag: 'etag-fake',
  get: () => undefined
}) as unknown as ParsedEncryptedOrUnencryptedMessage<JSONType> & { etag: string | null }

type EventLogEntry = { type: string; payload: unknown }
const collectEvents = (): { log: EventLogEntry[]; offs: Array<() => void> } => {
  const log: EventLogEntry[] = []
  const types = [CHELONIA_KV_UPDATED, CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_VALIDATION_ERROR]
  const offs = types.map((t) =>
    sbp('okTurtles.events/on', t, (payload: unknown) => {
      log.push({ type: t, payload })
    })
  )
  return { log, offs }
}

const setupContract = async (contractID: string, contractType = CTYPE): Promise<void> => {
  const s = rootState()
  if (!s.contracts) {
    ;(s as { contracts?: unknown }).contracts = Object.create(null)
  }
  ;(s.contracts as Record<string, unknown>)[contractID] = {
    HEAD: '', height: 0, type: contractType
  }
  // Add to subscriptionSet (normally done by chelonia.ts sync path).
  sbp('chelonia/test/addSubscription', contractID)
  sbp('chelonia/kv/_onContractsModified', { added: [contractID], removed: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const reactiveSet = <T>(obj: T, key: keyof T, value: T[keyof T]) => {
  ;(obj as Record<string, unknown>)[key as string] = value
}
const reactiveDel = <T>(obj: T, key: keyof T) => {
  delete (obj as Record<string, unknown>)[key as string]
}

// ---------------------------------------------------------------------------
// Mutable stub targets — swapped per-test via assignment
// ---------------------------------------------------------------------------

type GetResult = ChelKvGetResult

type GetStub = (contractID: string, key: string) =>
  Promise<GetResult | null>

type SetStub = (
  contractID: string,
  key: string,
  data: JSONType | undefined,
  opts: {
    ifMatch?: string
    encryptionKeyId?: string | null | undefined
    signingKeyId: string
    maxAttempts?: number | null | undefined
    onconflict?: (a: { currentData?: JSONType; etag?: string | null; status?: number }) =>
      Promise<[JSONType, string] | false>
    signal?: AbortSignal
  }
) => Promise<{ etag: string | null }>

type SetFilterStub = (contractID: string, filter?: string[]) => void | Promise<void>

type QueueInvocationStub = (contractID: string, fn: unknown) => Promise<unknown>

// Normalises the value `chelonia/queueInvocation` is called with: kv/update
// passes a function; `_waitInFlight` passes an sbp invocation array.
const runQueued = (fn: unknown): unknown =>
  typeof fn === 'function'
    ? (fn as () => unknown)()
    : sbp(...(fn as Parameters<typeof sbp>))

let stubGet: GetStub
let stubSet: SetStub
let stubSetFilter: SetFilterStub
let stubQueueInvocation: QueueInvocationStub
let stubCurrentKeyIdByName: (contractID: string, name: string) => string | undefined

let stubSetFilterCalls: Array<{ contractID: string; keys: string[] }>

// ---------------------------------------------------------------------------
// Register infrastructure selectors once — delegates to mutable stubs
// ---------------------------------------------------------------------------

sbp('sbp/selectors/register', {
  'chelonia/private/state': function (this: CheloniaContext) {
    return this.state
  },

  'chelonia/_init': function (this: CheloniaContext) {
    this.state = Object.create(null) as CheloniaContext['state']
    this.config = {
      stateSelector: 'chelonia/private/state',
      connectionURL: '',
      fetch: (() => {}) as unknown as typeof fetch,
      reactiveSet,
      reactiveDel
    } as unknown as CheloniaConfig
    this.abortController = new AbortController()
    this.subscriptionSet = new Set()
    this.kvSlots = new Map()
    this.kvSlotsByContractID = new Map()
    this.kvActiveFilters = new Map()
    this.kvFilterDirty = new Set()
    this.kvFilterRetry = new Set()
    this.kvLocalEchoCIDs = new Map()
    this.kvReconnectRefresh = new Set()
    this.kvPendingWrites = new Map()
    this.kvPendingLoads = new Map()
    this.kvOnUpdateActive = new Map()
    this.defContractKvByManifest = new Map()
  },

  'chelonia/configure': function (this: CheloniaContext) {
    if (!this.state) sbp('chelonia/_init')
  },

  'chelonia/reset': async function (
    this: CheloniaContext,
    _newState?: unknown,
    postCleanupFn?: () => Promise<void> | void
  ) {
    if (!this.state) return
    // Mirror production ordering: abort stuck KV writes, then drain them
    // before the post-cleanup hook observes state and runtime maps clear.
    this.abortController.abort()
    this.abortController = new AbortController()
    await sbp('chelonia/kv/_waitInFlight')
    await postCleanupFn?.()
    const s = this.state as Record<string, unknown>
    reactiveDel(s, 'contracts')
    reactiveSet(s, 'contracts', Object.create(null))
    reactiveDel(s, 'secretKeys')
    reactiveSet(s, 'secretKeys', Object.create(null))
    reactiveDel(s, '_kv')
    reactiveSet(s, '_kv', Object.create(null))
    this.kvSlotsByContractID.clear()
    this.kvActiveFilters.clear()
    this.kvFilterDirty.clear()
    this.kvFilterRetry.clear()
    if (this.kvFilterRetryTimer != null) {
      clearTimeout(this.kvFilterRetryTimer)
      this.kvFilterRetryTimer = undefined
    }
    this.kvLocalEchoCIDs.clear()
    this.kvReconnectRefresh.clear()
    this.kvPendingWrites.clear()
    this.kvPendingLoads.clear()
    this.kvOnUpdateActive.clear()
    this.subscriptionSet.clear()
  },

  'chelonia/kv/get': function (_contractID: string, _key: string) {
    return stubGet(_contractID, _key)
  },

  'chelonia/kv/set': function (
    contractID: string,
    key: string,
    data: JSONType | undefined,
    opts: Parameters<SetStub>[3]
  ) {
    return stubSet(contractID, key, data, opts)
  },

  'chelonia/contract/currentKeyIdByName': function (
    _contractID: string,
    name: string
  ) {
    return stubCurrentKeyIdByName(_contractID, name)
  },

  'chelonia/kv/setFilter': function (_contractID: string, _filter?: string[]) {
    return stubSetFilter(_contractID, _filter)
  },

  'chelonia/queueInvocation': function (_contractID: string, fn: unknown) {
    return stubQueueInvocation(_contractID, fn as () => unknown)
  },

  // Real chelonia registers this; _waitInFlight enqueues it as a noop.
  'chelonia/private/noop': function () {},

  // Test helper: add contract to subscriptionSet.
  'chelonia/test/addSubscription': function (this: CheloniaContext, contractID: string) {
    this.subscriptionSet.add(contractID)
  },

  // Test helper: seed an echo CID for a contract with no slot index.
  // Derives expiry from the live echo-CID clock (`nowMs`) — the same
  // source production uses — so seeded entries stay consistent under
  // `_testSetNowMs` overrides instead of mixing in `Date.now()`.
  'chelonia/test/seedEchoCID': function (this: CheloniaContext, echoKey: string) {
    this.kvLocalEchoCIDs.set(echoKey, new Map([
      ['cid', { expiry: sbp('chelonia/kv/_testNowMs') + KV_ECHO_TTL_MS, fromConflict: false }]
    ]))
  },

  'chelonia/test/addEchoCID': function (
    this: CheloniaContext,
    echoKey: string,
    cid: string,
    fromConflict: boolean
  ) {
    let bucket = this.kvLocalEchoCIDs.get(echoKey)
    if (!bucket) {
      bucket = new Map()
      this.kvLocalEchoCIDs.set(echoKey, bucket)
    }
    bucket.set(cid, {
      expiry: sbp('chelonia/kv/_testNowMs') + KV_ECHO_TTL_MS, fromConflict
    })
  },

  // Test helper: inspect active filters without exposing internals publicly.
  'chelonia/test/activeFilterKeys': function (this: CheloniaContext, contractID: string) {
    const filter = this.kvActiveFilters.get(contractID)
    return filter ? [...filter] : undefined
  },

  'chelonia/test/dirtyFilter': function (this: CheloniaContext, contractID: string) {
    this.kvFilterDirty.add(contractID)
  },

  'chelonia/test/filterRetrySize': function (this: CheloniaContext, contractID?: string) {
    return contractID === undefined
      ? this.kvFilterRetry.size
      : (this.kvFilterRetry.has(contractID) ? 1 : 0)
  },

  'chelonia/test/filterRetryTimerPending': function (this: CheloniaContext) {
    return this.kvFilterRetryTimer != null
  },

  'chelonia/test/hasEchoCID': function (this: CheloniaContext, key: string) {
    return this.kvLocalEchoCIDs.has(key)
  },

  'chelonia/test/echoCIDExpiry': function (this: CheloniaContext, key: string, cid: string) {
    return this.kvLocalEchoCIDs.get(key)?.get(cid)?.expiry
  },

  'chelonia/test/echoCIDFromConflict': function (
    this: CheloniaContext, key: string, cid: string
  ) {
    return this.kvLocalEchoCIDs.get(key)?.get(cid)?.fromConflict
  },

  // Test helpers: drive the pending-writes counter directly.
  'chelonia/test/incPending': function (this: CheloniaContext, contractID: string) {
    this.kvPendingWrites.set(contractID, (this.kvPendingWrites.get(contractID) ?? 0) + 1)
  },

  'chelonia/test/decPending': function (this: CheloniaContext, contractID: string) {
    const n = (this.kvPendingWrites.get(contractID) ?? 0) - 1
    if (n <= 0) this.kvPendingWrites.delete(contractID)
    else this.kvPendingWrites.set(contractID, n)
  },

  'chelonia/test/pendingCount': function (this: CheloniaContext, contractID: string) {
    return this.kvPendingWrites.get(contractID) ?? 0
  },

  'chelonia/test/pendingLoadCount': function (this: CheloniaContext, contractID: string) {
    return this.kvPendingLoads.get(contractID) ?? 0
  },

  'chelonia/test/incPendingLoad': function (this: CheloniaContext, contractID: string) {
    this.kvPendingLoads.set(contractID, (this.kvPendingLoads.get(contractID) ?? 0) + 1)
  },

  'chelonia/test/decPendingLoad': function (this: CheloniaContext, contractID: string) {
    const n = (this.kvPendingLoads.get(contractID) ?? 0) - 1
    if (n <= 0) this.kvPendingLoads.delete(contractID)
    else this.kvPendingLoads.set(contractID, n)
  },

  'chelonia/test/echoBucketSize': function (this: CheloniaContext, echoKey: string) {
    return this.kvLocalEchoCIDs.get(echoKey)?.size ?? 0
  },

  'chelonia/test/echoCIDPresent': function (
    this: CheloniaContext, echoKey: string, cid: string
  ) {
    return this.kvLocalEchoCIDs.get(echoKey)?.has(cid) ?? false
  },

  'chelonia/test/abortSignal': function (this: CheloniaContext) {
    return this.abortController.signal
  },

  // Test helper: simulate removeImmediately's KV cleanup for a contract.
  'chelonia/test/removeSubscription': function (this: CheloniaContext, contractID: string) {
    this.subscriptionSet.delete(contractID)
    this.kvSlotsByContractID.delete(contractID)
    this.kvActiveFilters.delete(contractID)
    this.kvFilterDirty.delete(contractID)
    this.kvReconnectRefresh.delete(contractID)
  },

  // Test helper: return the registry-current SlotDefinition the index
  // points at for (contractID, key) — i.e. the object a freshly
  // re-synced contract re-indexes after release.
  'chelonia/test/activeSlot': function (
    this: CheloniaContext, contractID: string, key: string
  ) {
    return this.kvSlotsByContractID.get(contractID)?.get(key)
  },

  // Test helper: return the SlotDefinition registered in `kvSlots` for a
  // given (contractType, key) registryKey, or undefined. Used to verify
  // `defineSlot` registration counts and dedup behaviour.
  'chelonia/test/registrySlot': function (
    this: CheloniaContext, contractType: string, key: string
  ) {
    return this.kvSlots.get(`${contractType}${KV_KEY_SEPARATOR}${key}`)
  }
})

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('KV slot API', () => {
  before(() => {
    if (!sbp('sbp/selectors/fn', 'chelonia/kv/set')) {
      throw new Error('kv.test.ts stubs failed to register; is the chelonia SBP domain locked?')
    }
    sbp('chelonia/configure')
  })

  beforeEach(() => {
    sbp('chelonia/kv/_testSetNowMs')
    stubSetFilterCalls = []

    stubGet = async () => null
    stubSet = async () => ({ etag: 'new-etag' })
    stubSetFilter = (contractID, filter) => {
      stubSetFilterCalls.push({ contractID, keys: filter ?? [] })
    }
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
    stubCurrentKeyIdByName = (_cID, name) => name
  })

  afterEach(async () => {
    sbp('chelonia/kv/_assertIndexConsistent')
    await sbp('chelonia/reset')
  })

  // -----------------------------------------------------------------------
  // 1
  // -----------------------------------------------------------------------
  it('1: defineSlot idempotent; schema accepting null rejected', () => {
    const badSchema = { parse: (v: unknown) => v }
    assert.throws(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'bad', contractType: CTYPE, defaultValue: { x: 1 }, schema: badSchema
      }),
      (e: unknown) => e instanceof ChelErrorKvSlotInvalid
    )

    sbp('chelonia/kv/defineSlot', {
      key: 's1', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 's1', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
  })

  // -----------------------------------------------------------------------
  // 1b: defineSlot deduplicates contractType array entries
  // -----------------------------------------------------------------------
  it('1b: defineSlot deduplicates duplicate contractType array entries', () => {
    // Duplicate entries collapse to a single registration under the same
    // registryKey, so reconcile/schema-guard work runs once, not N times.
    const CT_DEDUP = 'test-dedup'
    sbp('chelonia/kv/defineSlot', {
      key: 'dd',
      contractType: [CT_DEDUP, CT_DEDUP, CT_DEDUP],
      defaultValue: { x: 1 },
      schema: objectSchema
    })
    const slot = sbp('chelonia/test/registrySlot', CT_DEDUP, 'dd')
    assert.ok(slot, 'deduped contractType should register exactly one slot')
    assert.strictEqual(slot.contractType, CT_DEDUP)

    // A multi-type array with distinct entries still registers one slot
    // per distinct type.
    const CT_A = 'test-multi-a'
    const CT_B = 'test-multi-b'
    sbp('chelonia/kv/defineSlot', {
      key: 'mm',
      contractType: [CT_A, CT_B],
      defaultValue: { x: 2 },
      schema: objectSchema
    })
    assert.ok(sbp('chelonia/test/registrySlot', CT_A, 'mm'))
    assert.ok(sbp('chelonia/test/registrySlot', CT_B, 'mm'))
  })

  // -----------------------------------------------------------------------
  // 1c: assertJsonShape rejects circular references with a depth cap
  // -----------------------------------------------------------------------
  it('1c: defineSlot rejects a schema whose parse output is circular', () => {
    // A buggy or malicious schema could produce a cyclic structure from a
    // valid input. `assertJsonShape` must reject it via the depth guard
    // rather than infinite-looping the walker and hanging the realm.
    const cyclicSchema = {
      parse (v: unknown): unknown {
        if (v === null || v === undefined) throw new Error('rejected')
        const obj: Record<string, unknown> = { x: 1 }
        obj.self = obj // create a cycle
        return obj
      }
    }
    assert.throws(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'cyc',
        contractType: CTYPE,
        defaultValue: { x: 1 },
        schema: cyclicSchema
      }),
      (e: unknown) => e instanceof ChelErrorKvSlotInvalid
    )
  })

  // -----------------------------------------------------------------------
  // 2
  // -----------------------------------------------------------------------
  it('2: match predicate controls filter entries', async () => {
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'cond',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => shouldMatch
    })

    const c = 'cid-2'
    await setupContract(c)

    assert.ok(
      stubSetFilterCalls.some((f) => f.contractID === c && f.keys.includes('cond'))
    )

    shouldMatch = false
    stubSetFilterCalls.length = 0
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(
      stubSetFilterCalls.some((f) => f.contractID === c && !f.keys.includes('cond'))
    )
  })

  // -----------------------------------------------------------------------
  // 3
  // -----------------------------------------------------------------------
  it('3: update, 412 retry, KV_NOOP', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'ctr', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-3'
    await setupContract(c)

    let setCalls = 0
    stubSet = async (_cID, _key, _data, opts) => {
      setCalls++
      if (setCalls === 1 && opts.onconflict) {
        await opts.onconflict({
          currentData: { x: 5 },
          etag: 're',
          status: 412
        })
      }
      return { etag: 'final-etag' }
    }

    let reducerCalls = 0
    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'ctr',
      updater: (prev: JSONType) => {
        reducerCalls++
        return { x: (prev as { x: number }).x + 1 }
      }
    })
    assert.strictEqual(reducerCalls, 2)
    assert.deepStrictEqual(result, { x: 6 })

    setCalls = 0
    const noopResult = await sbp('chelonia/kv/update', {
      contractID: c, key: 'ctr', updater: () => KV_NOOP
    })
    assert.strictEqual(noopResult, undefined)
    assert.strictEqual(setCalls, 0)
  })

  // -----------------------------------------------------------------------
  // 4
  // -----------------------------------------------------------------------
  it('4: schema rejection on update throws ChelErrorKvValidation', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'strict', contractType: CTYPE, defaultValue: { x: 1 }, schema: strictSchema
    })
    const c = 'cid-4'
    await setupContract(c)

    let networkCalled = false
    stubSet = async () => { networkCalled = true; return { etag: 'e' } }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'strict',
        updater: () => ({ x: -1 }) as unknown as JSONType
      }),
      (e: unknown) => e instanceof ChelErrorKvValidation
    )
    assert.strictEqual(networkCalled, false)
  })

  // -----------------------------------------------------------------------
  // 5
  // -----------------------------------------------------------------------
  it('5: remote schema rejection keeps old value', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rt', contractType: CTYPE, defaultValue: { x: 1 }, schema: strictSchema
    })
    const c = 'cid-5'
    await setupContract(c)

    const entry = rootState()._kv![c]!.rt as {
      value: unknown; status: string; lastError?: unknown
    }
    entry.value = { x: 10 }
    entry.status = 'loaded'

    const { log, offs } = collectEvents()
    sbp('chelonia/kv/_handleRemote', c, 'rt', fakeParsed({ x: -5 }))

    assert.deepStrictEqual(entry.value, { x: 10 })
    assert.strictEqual(entry.status, 'error')
    assert.ok(entry.lastError)
    assert.ok(log.some((e) => e.type === CHELONIA_KV_VALIDATION_ERROR))
    assert.ok(log.some((e) => e.type === CHELONIA_KV_STATUS_CHANGED))

    log.length = 0
    sbp('chelonia/kv/_handleRemote', c, 'rt', fakeParsed({ x: 20 }))
    assert.deepStrictEqual(entry.value, { x: 20 })
    assert.strictEqual(entry.status, 'loaded')
    assert.strictEqual(entry.lastError, undefined)

    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 6
  // -----------------------------------------------------------------------
  it('6: coalesced setFilter', async () => {
    const c = 'cid-6'
    await setupContract(c)
    stubSetFilterCalls.length = 0

    sbp('chelonia/kv/defineSlot', {
      key: 'a', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'b', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })

    assert.strictEqual(stubSetFilterCalls.length, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const calls = stubSetFilterCalls.filter((f) => f.contractID === c)
    assert.strictEqual(calls.length, 1)
    assert.ok(calls[0].keys.includes('a'))
    assert.ok(calls[0].keys.includes('b'))
  })

  // -----------------------------------------------------------------------
  // 7
  // -----------------------------------------------------------------------
  it('7: refreshOnReconnect re-fetches after contract resync', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rc',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      refreshOnReconnect: true
    })
    const c = 'cid-7'
    await setupContract(c)

    let getCount = 0
    stubGet = async (_cID, key) => {
      if (key === 'rc') getCount++
      return fakeParsed({ x: 42 })
    }

    sbp('chelonia/kv/_onReconnect')
    assert.strictEqual(getCount, 0)
    await sbp('chelonia/kv/_onContractResynced', c)
    assert.strictEqual(getCount, 1)
  })

  it('7b: reconnect refresh is skipped if contract is released before resync', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rc-skip',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      refreshOnReconnect: true
    })
    const c = 'cid-7b'
    await setupContract(c)

    let getCount = 0
    stubGet = async () => { getCount++; return fakeParsed({ x: 42 }) }

    sbp('chelonia/kv/_onReconnect')
    sbp('chelonia/test/removeSubscription', c)
    await sbp('chelonia/kv/_onContractResynced', c)
    assert.strictEqual(getCount, 0)
  })

  // -----------------------------------------------------------------------
  // 8
  // -----------------------------------------------------------------------
  it('8: clear resets mirror to default', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clr', contractType: CTYPE, defaultValue: { x: 99 }
    })
    const c = 'cid-8'
    await setupContract(c)

    const entry = rootState()._kv![c]!.clr as {
      value: unknown; status: string
    }
    entry.value = { x: 42 }
    entry.status = 'loaded'

    let writtenData: JSONType | undefined
    stubSet = async (_cID, _key, data) => { writtenData = data; return { etag: 'clear-etag' } }

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/clear', c, 'clr')

    // Canonical 'non-init' representation (§4.3/§4.5): the raw mirror
    // `value` is `undefined`; the cloned default is surfaced via `read`.
    assert.strictEqual(entry.value, undefined)
    assert.strictEqual(entry.status, 'non-init')
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'clr'), { x: 99 })
    assert.strictEqual(writtenData, null)
    assert.ok(log.some((e) => e.type === CHELONIA_KV_UPDATED))

    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 9
  // -----------------------------------------------------------------------
  it('9: reset keeps definitions', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'pers', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-9'
    await setupContract(c)
    assert.ok(rootState()._kv?.[c]?.pers)

    await sbp('chelonia/reset')
    const kv = rootState()._kv
    assert.ok(!kv || Object.keys(kv).length === 0, '_kv should be empty after reset')

    await setupContract(c)
    assert.ok(rootState()._kv?.[c]?.pers)
  })

  it('9b: reset clears dirty filters without flushing', async () => {
    const c = 'cid-9b'
    sbp('chelonia/test/dirtyFilter', c)
    await sbp('chelonia/reset')

    assert.deepStrictEqual(stubSetFilterCalls, [])
  })

  it('9c: cleanup without active filter does not restore a stale empty filter', async () => {
    const c = 'cid-9c'
    sbp('chelonia/kv/_cleanupContractRuntime', c)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepStrictEqual(stubSetFilterCalls, [])
  })

  it('9d: reset aborts stuck writes before waiting for the KV drain', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'abort-reset', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-9d'
    await setupContract(c)

    const abortSignal = sbp('chelonia/test/abortSignal') as AbortSignal
    stubSet = async () => new Promise<{ etag: string }>((resolve) => {
      abortSignal.addEventListener('abort', () => resolve({ etag: 'aborted-etag' }), { once: true })
    })

    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'abort-reset', updater: () => ({ x: 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await sbp('chelonia/reset')
    await updateP
  })

  it('9e: reset post-cleanup hook observes drained KV writes', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'save-reset', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-9e'
    await setupContract(c)

    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: 'saved-etag' }
    }

    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'save-reset', updater: () => ({ x: 7 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSet()

    let observed: unknown
    await sbp('chelonia/reset', undefined, () => {
      observed = rootState()._kv?.[c]?.['save-reset']?.value
    })
    await updateP
    assert.deepStrictEqual(observed, { x: 7 })
  })

  // -----------------------------------------------------------------------
  // 10
  // -----------------------------------------------------------------------
  it('10: defineContract kv block registers slots', async () => {
    const contractType = 'type-v10'
    const manifest = 'manifest-v10'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      profile: { defaultValue: { name: '' }, schema: anySchema }
    })
    const c = 'cid-10'
    await setupContract(c, contractType)
    assert.ok(rootState()._kv?.[c]?.profile)
  })

  // -----------------------------------------------------------------------
  // 11
  // -----------------------------------------------------------------------
  it('11: conflict retry invalid currentData', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rb', contractType: CTYPE, defaultValue: { x: 1 }, schema: strictSchema
    })
    const c = 'cid-11'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict) {
        await opts.onconflict({ currentData: { x: -10 }, etag: 'bad' })
      }
      return { etag: 'e' }
    }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'rb', updater: () => ({ x: 5 })
      }),
      (e: unknown) => e instanceof ChelErrorKvValidation
    )
  })

  // -----------------------------------------------------------------------
  // 12
  // -----------------------------------------------------------------------
  it('12: conflict retry KV_NOOP resolves undefined', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rn', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-12'
    await setupContract(c)

    let call = 0
    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict && call === 0) {
        call++
        await opts.onconflict({
          currentData: { x: 99 }, etag: 'c'
        })
      }
      return { etag: 'e' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'rn',
      updater: (prev: JSONType) => {
        if ((prev as { x: number }).x > 50) return KV_NOOP
        return { x: (prev as { x: number }).x + 1 }
      }
    })
    assert.strictEqual(result, undefined)
  })

  // -----------------------------------------------------------------------
  // 13
  // -----------------------------------------------------------------------
  it('13: stricter schema replacement', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rep', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-13'
    await setupContract(c)

    const entry = rootState()._kv![c]!.rep as {
      value: unknown; status: string
    }
    entry.value = { x: -5 }
    entry.status = 'loaded'

    const { log, offs } = collectEvents()
    sbp('chelonia/kv/defineSlot', {
      key: 'rep', contractType: CTYPE, defaultValue: { x: 1 }, schema: strictSchema
    })

    assert.deepStrictEqual(entry.value, { x: -5 })
    assert.strictEqual(entry.status, 'error')
    assert.ok(log.some((e) => e.type === CHELONIA_KV_VALIDATION_ERROR))

    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 14
  // -----------------------------------------------------------------------
  it('14: events carry contractID and contractType', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'ev', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-14'
    await setupContract(c)

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'ev', updater: () => ({ x: 42 })
    })

    const evt = log.find((e) => e.type === CHELONIA_KV_UPDATED)
    assert.ok(evt)
    const p = evt!.payload as Record<string, unknown>
    assert.strictEqual(p.contractID, c)
    assert.strictEqual(p.contractType, CTYPE)

    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 15
  // -----------------------------------------------------------------------
  it('15: remote null is clear-to-default', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rc2', contractType: CTYPE, defaultValue: { x: 77 }
    })
    const c = 'cid-15'
    await setupContract(c)

    const entry = rootState()._kv![c]!.rc2 as { value: unknown; status: string }
    entry.value = { x: 42 }
    entry.status = 'loaded'

    await sbp('chelonia/kv/_handleRemote', c, 'rc2', fakeParsed(null))
    // Canonical 'non-init' shape: raw mirror `value` is `undefined`;
    // the default is surfaced through `read`.
    assert.strictEqual(entry.value, undefined)
    assert.strictEqual(entry.status, 'non-init')
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'rc2'), { x: 77 })
  })

  // -----------------------------------------------------------------------
  // 16
  // -----------------------------------------------------------------------
  it('16: defineContract replacement unregisters removed keys', async () => {
    const contractType = 'type-v16'
    const manifest = 'manifest-v16'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      alpha: { defaultValue: 1 }, beta: { defaultValue: 2 }
    })
    const c = 'cid-16'
    await setupContract(c, contractType)

    const s = rootState()
    assert.ok(s._kv?.[c]?.alpha)
    assert.ok(s._kv?.[c]?.beta)

    const prev = { alpha: { defaultValue: 1 }, beta: { defaultValue: 2 } }
    const next = { alpha: { defaultValue: 10 } }
    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, prev, next)
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, next)

    assert.strictEqual(s._kv?.[c]?.beta, undefined)
    assert.ok(s._kv?.[c]?.alpha)
  })

  // -----------------------------------------------------------------------
  // 17
  // -----------------------------------------------------------------------
  it('17: contract release removes per-contract KV state', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rl', contractType: CTYPE, defaultValue: { x: 1 }
    })
    const c = 'cid-17'
    await setupContract(c)
    assert.ok(rootState()._kv?.[c]?.rl)

    const entry = rootState()._kv![c]!.rl as { status: string }
    assert.strictEqual(entry.status, 'non-init')

    // Simulate removeImmediately's KV cleanup path
    const s = rootState()
    reactiveDel(s._kv!, c)
    sbp('chelonia/test/removeSubscription', c)
    sbp('chelonia/kv/_onContractsModified', { added: [], removed: [c] })

    assert.strictEqual(s._kv?.[c], undefined)
    assert.strictEqual(
      sbp('chelonia/kv/status', c),
      'non-init',
      'status should be non-init after removal'
    )
  })

  // -----------------------------------------------------------------------
  // 18
  // -----------------------------------------------------------------------
  it('18: self-echo suppression', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'echo', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-18'
    await setupContract(c)

    stubSet = async () => ({ etag: 'e' })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'echo', updater: () => ({ x: 1 })
    })
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1)

    log.length = 0
    await sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({ x: 1 }), 'e')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::echo`), false)

    await sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({ x: 2 }), 'e')
    assert.deepStrictEqual(rootState()._kv![c]!.echo.value, { x: 2 })
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length, 1
    )

    log.length = 0
    await sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({ x: 3 }), 'other')
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length, 1
    )

    let clock = 1000
    sbp('chelonia/kv/_testSetNowMs', () => clock)
    stubSet = async () => ({ etag: 'late' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'echo', updater: () => ({ x: 4 })
    })
    log.length = 0
    clock += KV_ECHO_TTL_MS + 1
    await sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({ x: 5 }), 'late')
    assert.deepStrictEqual(rootState()._kv![c]!.echo.value, { x: 5 })
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length, 1
    )
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::echo`), false)
    sbp('chelonia/kv/_testSetNowMs')

    offs.forEach((off) => off())
  })

  it('18b: self-echo suppression skips payload decoding', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'echoDecode', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-18b'
    await setupContract(c)

    stubSet = async () => ({ etag: 'decode-echo' })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'echoDecode', updater: () => ({ x: 1 })
    })
    log.length = 0

    const decodeErr = new Error('should not decode')
    const throwingParsed = {
      get data () { throw decodeErr }
    } as unknown as ParsedEncryptedOrUnencryptedMessage<JSONType>
    await sbp('chelonia/kv/_handleRemote', c, 'echoDecode', throwingParsed, 'decode-echo')

    assert.strictEqual(log.length, 0)
    assert.strictEqual(rootState()._kv![c]!.echoDecode.status, 'loaded')
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::echoDecode`), false)
    offs.forEach((off) => off())
  })

  it('18c: missing encryption key rejects unless explicitly disabled', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'missingCek', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'plain',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      encryptionKeyName: null
    })
    const c = 'cid-18c'
    await setupContract(c)

    let writes = 0
    stubSet = async (_cID, _key, _data, opts) => {
      writes++
      assert.strictEqual(opts.encryptionKeyId, null)
      assert.strictEqual(opts.signingKeyId, 'csk')
      return { etag: 'plain-etag' }
    }
    stubCurrentKeyIdByName = (_cID, name) => name === 'cek' ? undefined : name

    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: c, key: 'missingCek', updater: () => ({ x: 1 })
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
        /refusing to write plaintext/.test((e as Error).message)
    )
    assert.strictEqual(writes, 0)

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'plain', updater: () => ({ x: 2 })
    })
    assert.strictEqual(writes, 1)
  })

  it('18d: missing signing key rejects before writing', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'missingCsk', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-18d'
    await setupContract(c)

    let writes = 0
    stubSet = async () => {
      writes++
      return { etag: 'unused' }
    }
    stubCurrentKeyIdByName = (_cID, name) => name === 'csk' ? undefined : name

    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: c, key: 'missingCsk', updater: () => ({ x: 1 })
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid &&
        /signing key/.test((e as Error).message)
    )
    assert.strictEqual(writes, 0)
  })

  // -----------------------------------------------------------------------
  // 19
  // -----------------------------------------------------------------------
  it('19: rejection taxonomy', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rej', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-19'
    await setupContract(c)

    // 19a: conflict exhaustion
    stubSet = async () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value')
    }
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'rej', updater: () => ({ x: 2 })
      }),
      (e: unknown) => e instanceof ChelErrorKvConflict
    )

    // 19b: 5xx
    stubSet = async () => { throw new Error('Internal Server Error') }
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'rej', updater: () => ({ x: 2 })
      }),
      (e: unknown) => (e as Error).message === 'Internal Server Error'
    )

    // 19c: abort
    stubSet = async () => ({ etag: 'e' })
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'rej',
        updater: () => ({ x: 2 }),
        signal: ac.signal
      }),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
    )
  })

  // -----------------------------------------------------------------------
  // 20
  // -----------------------------------------------------------------------
  it('20: index invariant lifecycle', async () => {
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'lc',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => shouldMatch
    })
    const c = 'cid-20'
    await setupContract(c)
    sbp('chelonia/kv/_assertIndexConsistent')

    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((resolve) => setTimeout(resolve, 0))
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  // -----------------------------------------------------------------------
  // 21
  // -----------------------------------------------------------------------
  it('21: defaultValue round-trip guard', () => {
    // A schema whose parse is not idempotent — each invocation appends
    // a new element to an array field, so parse(parse(x)) !== parse(x).
    const nonIdempotent = {
      parse: (v: unknown): { xs: number[] } => {
        if (v === null || v === undefined) throw new Error('no')
        const obj = v as { xs: number[] }
        return { xs: [...(obj.xs ?? []), 0] }
      }
    }
    assert.throws(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'cg',
        contractType: CTYPE,
        defaultValue: { xs: [] },
        schema: nonIdempotent
      }),
      (e: unknown) => e instanceof ChelErrorKvSlotInvalid
    )
  })

  // -----------------------------------------------------------------------
  // 22
  // -----------------------------------------------------------------------
  it('22: aggregate sync loads all matching slots through the contract queue', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'sa', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'sb', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'sx',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => false
    })
    const c = 'cid-22'
    await setupContract(c)

    const keys: string[] = []
    stubGet = async (_c, key) => { keys.push(key); return fakeParsed({ x: 1 }) }
    await sbp('chelonia/kv/sync', c)
    assert.ok(keys.includes('sa'))
    assert.ok(keys.includes('sb'))
    assert.ok(!keys.includes('sx'))

    const lanes = new Map<string, Promise<unknown>>()
    stubQueueInvocation = (cID, fn) => {
      const prev = lanes.get(cID) ?? Promise.resolve()
      const next = prev.then(() => runQueued(fn))
      lanes.set(cID, next.catch(() => {}))
      return next
    }

    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: 'post-write' }
    }
    const observedEtags: Array<{ key: string; etag: unknown }> = []
    stubGet = async (_c, key) => {
      observedEtags.push({ key, etag: rootState()._kv![c]![key]!.etag })
      return fakeParsed({ x: 2 })
    }

    const updateP = sbp('chelonia/kv/update', {
      contractID: c,
      key: 'sa',
      updater: (prev: JSONType | undefined) => ({
        x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const syncP = sbp('chelonia/kv/sync', c)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.strictEqual(observedEtags.length, 0)

    releaseSet()
    await Promise.all([updateP, syncP])
    assert.ok(observedEtags.some((entry) => entry.key === 'sa' && entry.etag === 'post-write'))
  })

  // -----------------------------------------------------------------------
  // 23
  // -----------------------------------------------------------------------
  it('23: wall-clock reducer values differ', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clk',
      contractType: CTYPE,
      defaultValue: { x: 0, t: 0 },
      schema: objectSchema
    })
    const c = 'cid-23'
    await setupContract(c)

    const ts: number[] = []
    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict) {
        await opts.onconflict({
          currentData: { x: 0, t: 0 }, etag: 'c'
        })
      }
      return { etag: 'e' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'clk',
      updater: (prev: JSONType) => {
        const t = Date.now()
        ts.push(t)
        return { ...(prev as Record<string, unknown>), t }
      }
    }) as { t: number }

    assert.strictEqual(ts.length, 2)
    assert.strictEqual(result.t, ts[1])
  })

  // -----------------------------------------------------------------------
  // 24
  // -----------------------------------------------------------------------
  it('24: async onUpdate rejection caught', async () => {
    const origError = console.error
    const errs: unknown[] = []
    console.error = (...a: unknown[]) => errs.push(a)

    sbp('chelonia/kv/defineSlot', {
      key: 'bc',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: async () => { throw new Error('boom') }
    })
    const c = 'cid-24'
    await setupContract(c)

    sbp('chelonia/kv/_handleRemote', c, 'bc', fakeParsed({ x: 5 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepStrictEqual(
      (rootState()._kv![c]!.bc as { value: unknown }).value, { x: 5 }
    )
    assert.ok(errs.length > 0)

    console.error = origError
  })

  // -----------------------------------------------------------------------
  // 25
  // -----------------------------------------------------------------------
  it('25: defaultUpdater merges and retries', async () => {
    let factoryCalls = 0
    let reducerCalls = 0

    sbp('chelonia/kv/defineSlot', {
      key: 'dh',
      contractType: CTYPE,
      defaultValue: { x: 0, y: 0 },
      schema: objectSchema,
      defaultUpdater: (patch: JSONType) => {
        factoryCalls++
        return (prev: JSONType) => {
          reducerCalls++
          return {
            ...(prev as Record<string, unknown>),
            ...(patch as Record<string, unknown>)
          }
        }
      }
    })
    const c = 'cid-25'
    await setupContract(c)

    ;(rootState()._kv![c]!.dh as { value: unknown }).value = { x: 1, y: 2 }

    let onconflictCalled = false
    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict && !onconflictCalled) {
        onconflictCalled = true
        await opts.onconflict({
          currentData: { x: 10, y: 20 },
          etag: 're'
        })
      }
      return { etag: 'f' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c, key: 'dh', value: { y: 99 }
    })

    assert.strictEqual(factoryCalls, 1)
    assert.strictEqual(reducerCalls, 2)
    assert.deepStrictEqual(result, { x: 10, y: 99 })
  })

  // -----------------------------------------------------------------------
  // 26
  // -----------------------------------------------------------------------
  it('26: defaultUpdater rejects on bad input', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'de', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-26'
    await setupContract(c)

    // 26a: neither updater nor value
    await assert.rejects(
      () => sbp('chelonia/kv/update', { contractID: c, key: 'de' }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid
    )

    // 26b: both updater and value
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'de',
        updater: () => ({ x: 1 }),
        value: { x: 2 }
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid
    )

    // 26c: value without defaultUpdater
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'de', value: { x: 2 }
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid
    )
  })

  // -----------------------------------------------------------------------
  // 27
  // -----------------------------------------------------------------------
  it('27: defaultUpdater + KV_NOOP skips network', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'dn',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      defaultUpdater: () => () => KV_NOOP
    })
    const c = 'cid-27'
    await setupContract(c)

    let networkCalled = false
    stubSet = async () => { networkCalled = true; return { etag: 'e' } }

    const result = await sbp('chelonia/kv/update', {
      contractID: c, key: 'dn', value: { x: 1 }
    })
    assert.strictEqual(result, undefined)
    assert.strictEqual(networkCalled, false)
  })

  // -----------------------------------------------------------------------
  // 28: issue 1 – reconnect does not double-queue _loadSlot
  // -----------------------------------------------------------------------
  it('28: reconnect _loadSlot not double-queued', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rq',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      refreshOnReconnect: true
    })
    const c = 'cid-28'
    await setupContract(c)

    let queueDepth = 0
    let maxDepth = 0
    stubQueueInvocation = (_cID, fn) => {
      queueDepth++
      if (queueDepth > maxDepth) maxDepth = queueDepth
      const result = Promise.resolve(runQueued(fn))
      queueDepth--
      return result
    }

    let getCount = 0
    stubGet = async () => { getCount++; return fakeParsed({ x: 42 }) }

    await sbp('chelonia/kv/sync', c, 'rq')
    assert.strictEqual(getCount, 1)
    assert.strictEqual(maxDepth, 1, '_loadSlot should only queue once (no deadlock)')
  })

  // -----------------------------------------------------------------------
  // 29: issue 2 – update uses mirror etag when ifMatch omitted
  // -----------------------------------------------------------------------
  it('29: update sends mirror etag by default', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'et',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema
    })
    const c = 'cid-29'
    await setupContract(c)

    const entry = rootState()._kv![c]!.et as {
      value: unknown; etag: string | null; status: string
    }
    entry.value = { x: 10 }
    entry.etag = 'mirror-etag-123'
    entry.status = 'loaded'

    let capturedIfMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      capturedIfMatch = opts.ifMatch
      return { etag: 'new-etag' }
    }

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'et', updater: () => ({ x: 20 })
    })
    assert.strictEqual(capturedIfMatch, 'mirror-etag-123')

    // Explicit ifMatch overrides mirror etag
    capturedIfMatch = undefined
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'et',
      updater: () => ({ x: 30 }),
      ifMatch: 'explicit-etag'
    })
    assert.strictEqual(capturedIfMatch, 'explicit-etag')
  })

  // -----------------------------------------------------------------------
  // 30: issue 3 – autoSubscribe:false passes index invariant
  // -----------------------------------------------------------------------
  it('30: autoSubscribe:false passes index invariant', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'ns',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      autoSubscribe: false
    })
    const c = 'cid-30'
    await setupContract(c)

    const s = rootState()
    assert.ok(s._kv?.[c]?.ns, 'mirror entry exists')

    const filterCalls = stubSetFilterCalls.filter((f) => f.contractID === c)
    assert.ok(
      !filterCalls.some((f) => f.keys.includes('ns')),
      'autoSubscribe:false key should not be in setFilter'
    )

    // Must not throw
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  // -----------------------------------------------------------------------
  // 31: issue 5 – schema that alters the resolved default on first parse
  // is rejected (§4.1 guard 3 fidelity check). Idempotent coercion of
  // the *parsed* output is not sufficient; the default itself must
  // survive parsing unchanged. Schemas like
  // `NotificationsSchema.transform(applyStorageRules)` are fine because
  // they don't alter an empty default — the transform only affects
  // non-empty loaded values.
  // -----------------------------------------------------------------------
  it('31: schema transforming default on first parse is normalised', async () => {
    const schema = {
      parse (value: unknown): { x: number } {
        if (value === null || value === undefined) throw new Error('reserved')
        return { x: Number((value as { x: unknown }).x) }
      }
    }

    // A schema that transforms the default on first parse is accepted
    // (idempotence check: parse(parse(x)) === parse(x)). The resolved
    // default is normalised to the schema-parsed output.
    assert.doesNotThrow(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'sc',
        contractType: CTYPE,
        defaultValue: { x: '1', extra: true },
        schema
      })
    )

    // Verify the resolved default was normalised to the schema output
    // by setting up a contract and reading the default.
    const c = 'cid-31'
    await setupContract(c)
    const val = sbp('chelonia/kv/read', c, 'sc')
    assert.deepStrictEqual(val, { x: 1 })

    // Same schema is also fine when the default survives parse unchanged.
    assert.doesNotThrow(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'sc2',
        contractType: CTYPE,
        defaultValue: { x: 1 },
        schema
      })
    )
  })

  // -----------------------------------------------------------------------
  // 32: 404 with previous value emits CHELONIA_KV_UPDATED with the mirror
  // value (`undefined`) while `safeOnUpdate` receives the cloned default.
  // -----------------------------------------------------------------------
  it('32: 404 with previous value emits update event with undefined', async () => {
    const onUpdateValues: unknown[] = []
    sbp('chelonia/kv/defineSlot', {
      key: 'p404',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: (value: unknown) => { onUpdateValues.push(value) }
    })
    const c = 'cid-32'
    await setupContract(c)

    // First load returns a value so the mirror has one.
    stubGet = async () => fakeParsed({ x: 42 })
    await sbp('chelonia/kv/sync', c, 'p404')
    assert.deepStrictEqual(
      (rootState()._kv![c]!.p404 as { value: unknown }).value, { x: 42 }
    )

    // Second load returns null (404) — server key was deleted.
    const { log, offs } = collectEvents()
    stubGet = async () => null

    await sbp('chelonia/kv/sync', c, 'p404')

    // The mirror itself holds undefined (status: 'non-init'); `read`
    // substitutes the default at access time.
    assert.strictEqual(
      (rootState()._kv![c]!.p404 as { value: unknown }).value, undefined
    )

    // CHELONIA_KV_UPDATED must have fired with the mirror value
    // (`undefined`) and previousValue:{x:42}.
    const updateEvents = log.filter(
      (e) => e.type === CHELONIA_KV_UPDATED && (e.payload as { key: string }).key === 'p404'
    )
    assert.ok(updateEvents.length >= 1, 'expected at least one CHELONIA_KV_UPDATED')
    const lastEvent = updateEvents[updateEvents.length - 1].payload as {
      value: unknown; previousValue: unknown
    }
    assert.strictEqual(lastEvent.value, undefined)
    assert.deepStrictEqual(lastEvent.previousValue, { x: 42 })

    // onUpdate should have been called with the cloned default.
    assert.ok(
      onUpdateValues.some((v) => v !== undefined && (v as { x: number }).x === 0),
      'onUpdate should have been called with the default value'
    )

    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 33: _waitInFlight drains active per-contract queueInvocation lanes
  // -----------------------------------------------------------------------
  it('33: _waitInFlight drains in-flight update before resolving', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'drain', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-33'
    await setupContract(c)

    // Make the per-contract lane serial so the noop enqueued by
    // _waitInFlight resolves only after the in-flight set settles.
    const lanes = new Map<string, Promise<unknown>>()
    stubQueueInvocation = (cID, fn) => {
      const prev = lanes.get(cID) ?? Promise.resolve()
      const next = prev.then(() => runQueued(fn))
      lanes.set(cID, next.catch(() => {}))
      return next
    }

    // Gate the network write on a deferred promise.
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    let setResolved = false
    stubSet = async () => {
      await setGate
      setResolved = true
      return { etag: 'new-etag' }
    }

    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'drain', updater: (prev: { x: number }) => ({ x: prev.x + 1 })
    })
    // Let the update reach the gated set.
    await new Promise((resolve) => setTimeout(resolve, 0))

    let drainResolved = false
    const drainP = sbp('chelonia/kv/_waitInFlight').then(() => { drainResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.strictEqual(drainResolved, false, 'drain must not resolve while set is gated')
    assert.strictEqual(setResolved, false)

    releaseSet()
    await Promise.all([updateP, drainP])
    assert.strictEqual(setResolved, true)
    assert.strictEqual(drainResolved, true, 'drain resolves once the in-flight write settles')
  })

  // -----------------------------------------------------------------------
  // 34: _waitInFlight covers contracts that only own an echo CID
  // -----------------------------------------------------------------------
  it('34: _waitInFlight includes contracts with only echo CIDs', async () => {
    // Seed an echo CID for a contract that has no slot index entry
    // (in-flight write whose slot index was already cleaned up).
    const cid = 'cid-34'
    const queued: string[] = []
    stubQueueInvocation = (cID, fn) => { queued.push(cID); return Promise.resolve(runQueued(fn)) }
    sbp('chelonia/test/seedEchoCID', `${cid}::k`)
    await sbp('chelonia/kv/_waitInFlight')
    assert.ok(queued.includes(cid), 'drain must enqueue a noop for the CID-only contract')
  })

  // -----------------------------------------------------------------------
  // 35: _waitInFlight is a no-op when nothing is in flight
  // -----------------------------------------------------------------------
  it('35: _waitInFlight resolves immediately with no active KV state', async () => {
    const queued: string[] = []
    stubQueueInvocation = (cID, fn) => { queued.push(cID); return Promise.resolve(runQueued(fn)) }
    await sbp('chelonia/kv/_waitInFlight')
    assert.strictEqual(queued.length, 0)
  })

  // -----------------------------------------------------------------------
  // 36: queued writes re-check slot liveness before network I/O
  // -----------------------------------------------------------------------
  it('36: queued update rejects before write when slot became inactive', async () => {
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'stale-up',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      match: () => shouldMatch
    })
    const c = 'cid-36'
    await setupContract(c)

    let queuedRun!: () => void
    let held = false
    stubQueueInvocation = (_cID, fn) => {
      if (held) return Promise.resolve(runQueued(fn))
      held = true
      return new Promise((resolve, reject) => {
        queuedRun = () => { Promise.resolve(runQueued(fn)).then(resolve, reject) }
      })
    }
    let networkCalled = false
    stubSet = async () => { networkCalled = true; return { etag: 'e' } }

    const p = sbp('chelonia/kv/update', {
      contractID: c, key: 'stale-up', updater: () => ({ x: 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((resolve) => setTimeout(resolve, 0))

    queuedRun()
    await assert.rejects(
      () => p,
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown
    )
    assert.strictEqual(networkCalled, false)
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
  })

  // -----------------------------------------------------------------------
  // 37: queued clear re-checks slot liveness before network I/O
  // -----------------------------------------------------------------------
  it('37: queued clear rejects before write when slot became inactive', async () => {
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'stale-clear',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      match: () => shouldMatch
    })
    const c = 'cid-37'
    await setupContract(c)

    let queuedRun!: () => void
    let held = false
    stubQueueInvocation = (_cID, fn) => {
      if (held) return Promise.resolve(runQueued(fn))
      held = true
      return new Promise((resolve, reject) => {
        queuedRun = () => { Promise.resolve(runQueued(fn)).then(resolve, reject) }
      })
    }
    let networkCalled = false
    stubSet = async () => { networkCalled = true; return { etag: 'e' } }

    const p = sbp('chelonia/kv/clear', c, 'stale-clear')
    await new Promise((resolve) => setTimeout(resolve, 0))
    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((resolve) => setTimeout(resolve, 0))

    queuedRun()
    await assert.rejects(
      () => p,
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown
    )
    assert.strictEqual(networkCalled, false)
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
  })

  // -----------------------------------------------------------------------
  // 38: JSON-shape guard covers schemaless values and first activation
  // -----------------------------------------------------------------------
  it('38: schemaless slots reject non-JSON and first activation validates persisted mirrors', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'json', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-38'
    await setupContract(c)

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'json',
        updater: () => new Date() as unknown as JSONType
      }),
      // Schemaless reducer-output shape failures route to
      // ChelErrorKvValidation per §4.2 (consistent with the schema-backed
      // path and the onconflict currentData shape check).
      (e: unknown) => e instanceof ChelErrorKvValidation &&
        /reducer output failed validation$/.test((e as Error).message)
    )

    const entry = rootState()._kv![c]!.json as { value: unknown; status: string }
    entry.value = { x: 1 }
    entry.status = 'loaded'
    sbp('chelonia/kv/_handleRemote', c, 'json', fakeParsed(new Date() as unknown as JSONType))
    assert.deepStrictEqual(entry.value, { x: 1 })
    assert.strictEqual(entry.status, 'error')

    const persisted = 'cid-38-persisted'
    await setupContract(persisted)
    const s = rootState()
    s._kv![persisted] = Object.create(null)
    s._kv![persisted]!.strictPersisted = {
      value: { x: -1 }, etag: 'old', status: 'loaded'
    }
    sbp('chelonia/kv/defineSlot', {
      key: 'strictPersisted',
      contractType: CTYPE,
      defaultValue: { x: 9 },
      schema: strictSchema,
      autoLoad: 'never'
    })
    assert.deepStrictEqual(s._kv![persisted]!.strictPersisted.value, { x: -1 })
    assert.strictEqual(s._kv![persisted]!.strictPersisted.status, 'error')
    assert.deepStrictEqual(sbp('chelonia/kv/read', persisted, 'strictPersisted'), { x: 9 })
  })

  // -----------------------------------------------------------------------
  // 38b: schemaless reducer-output shape failure on the onconflict retry
  // path must also route to ChelErrorKvValidation (mirrors the first-attempt
  // path and the schema-backed currentData check).
  // -----------------------------------------------------------------------
  it('38b: schemaless reducer shape failure on conflict retry is ChelErrorKvValidation', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'jsonRetry', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-38b'
    await setupContract(c)

    let call = 0
    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict && call === 0) {
        call++
        await opts.onconflict({ currentData: { x: 1 }, etag: 'c' })
      }
      return { etag: 'e' }
    }

    // Reducer returns non-JSON only on the retry (after seeing prev={x:1}).
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'jsonRetry',
        updater: (prev: { x: number }) => prev.x === 1
          ? (new Date() as unknown as JSONType)
          : ({ x: 2 } as JSONType)
      }),
      (e: unknown) => e instanceof ChelErrorKvValidation &&
        /reducer output failed validation on retry/.test((e as Error).message)
    )
  })

  // -----------------------------------------------------------------------
  // 39: issue 1 – `_waitInFlight` drains a contract whose slot index and
  // nonce sources were both removed mid-flight, via the pending-writes
  // counter. The contract is released (dropped from `rootState.contracts`
  // and `subscriptionSet`) while an `update` body is still queued, so
  // neither `kvSlotsByContractID` nor `kvLocalEchoCIDs` covers it.
  // -----------------------------------------------------------------------
  it('39: _waitInFlight drains released-contract writes via the pending counter', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'pend', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-39'
    await setupContract(c)

    // Serial per-contract lane so the noop enqueued by _waitInFlight
    // resolves only after the in-flight update body settles.
    const lanes = new Map<string, Promise<unknown>>()
    stubQueueInvocation = (cID, fn) => {
      const prev = lanes.get(cID) ?? Promise.resolve()
      const next = prev.then(() => runQueued(fn))
      lanes.set(cID, next.catch(() => {}))
      return next
    }

    // Gate the network write so the update body stays in flight.
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: 'e' }
    }

    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'pend', updater: (prev: { x: number }) => ({ x: prev.x + 1 })
    })
    // Let the update reach the gated set (nonce now recorded, but we
    // remove the nonce source below to simulate the worst case).
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Simulate contract release: drop from contracts/subSet/index/nonces.
    // After this the contract is in none of the three documented sources
    // except the pending-writes counter.
    const s = rootState()
    reactiveDel(s.contracts as Record<string, unknown>, c)
    sbp('chelonia/test/removeSubscription', c)
    sbp('chelonia/kv/_cleanupContractRuntime', c)

    let drainResolved = false
    const drainP = sbp('chelonia/kv/_waitInFlight').then(() => { drainResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.strictEqual(drainResolved, false, 'drain must block on the pending write')

    releaseSet()
    await Promise.all([updateP.catch(() => {}), drainP])
    assert.strictEqual(drainResolved, true, 'drain resolves once the released write settles')
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
  })

  // -----------------------------------------------------------------------
  // 40: issue 1 – pending counter decrements on KV_NOOP and on errors so
  // it never leaks (which would wedge subsequent resets on a phantom gate).
  // -----------------------------------------------------------------------
  it('40: pending counter decrements on KV_NOOP and on reducer errors', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'noop', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-40'
    await setupContract(c)

    // KV_NOOP path — resolves cleanly, counter must return to zero.
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'noop', updater: () => KV_NOOP
    })
    await sbp('chelonia/kv/_waitInFlight')

    // Error path — reducer throws, queued body rejects, counter must
    // still decrement.
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'noop',
        updater: () => { throw new Error('reducer boom') }
      }),
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid
    )
    // Remove the slot from the active index and clear nonces so the
    // ONLY remaining source for _waitInFlight is the pending-writes
    // counter. If the counter leaked on noop/error, _waitInFlight
    // would still enqueue a noop for c.
    sbp('chelonia/test/removeSubscription', c)
    const queued: string[] = []
    stubQueueInvocation = (cID, fn) => { queued.push(cID); return Promise.resolve(runQueued(fn)) }
    await sbp('chelonia/kv/_waitInFlight')
    assert.strictEqual(queued.length, 0, 'pending counter must not leak on noop or error')
  })

  // -----------------------------------------------------------------------
  // 41: issue 2 – schema transforming the default to a reserved sentinel
  // (undefined) or a non-JSON value (Date) is rejected at registration.
  // -----------------------------------------------------------------------
  it('41: schema transforming default to reserved sentinel or non-JSON is rejected', () => {
    // Transforms any non-null input to undefined — a reserved sentinel.
    const toUndefined = {
      parse (v: unknown): unknown {
        if (v === null || v === undefined) throw new Error('reserved')
        return undefined
      }
    }
    assert.throws(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'badUndef', contractType: CTYPE, defaultValue: { x: 1 }, schema: toUndefined
      }),
      (e: unknown) => e instanceof ChelErrorKvSlotInvalid
    )

    // Transforms any non-null input to a Date instance — non-JSON-shaped.
    const toDate = {
      parse (v: unknown): unknown {
        if (v === null || v === undefined) throw new Error('reserved')
        return new Date()
      }
    }
    assert.throws(
      () => sbp('chelonia/kv/defineSlot', {
        key: 'badDate', contractType: CTYPE, defaultValue: { x: 1 }, schema: toDate
      }),
      (e: unknown) => e instanceof ChelErrorKvSlotInvalid
    )
  })

  // -----------------------------------------------------------------------
  // 42: issue 3 – stale `_loadSlot` GET failure does not stamp an error
  // onto a replacement slot. The success paths already guard; the catch
  // path now guards too.
  // -----------------------------------------------------------------------
  it('42: stale _loadSlot GET failure leaves the replacement slot untouched', async () => {
    const schemaA = { parse (v: unknown): unknown { if (v == null) throw new Error('r'); return v } }
    const schemaB = { parse (v: unknown): unknown { if (v == null) throw new Error('r'); return v } }
    sbp('chelonia/kv/defineSlot', {
      key: 'staleLoad', contractType: CTYPE, defaultValue: { x: 0 }, schema: schemaA
    })
    const c = 'cid-42'
    await setupContract(c)

    // Hold only the first (stale) GET so we can replace the slot while
    // it is in flight; the replacement slot's own queued load (fix for
    // issue 1) then succeeds. Real Chelonia serialises these on the
    // per-contract lane; the test harness runs them eagerly, so we
    // discriminate by call order rather than relying on serialisation.
    let releaseGet!: () => void
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve })
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      if (getCalls === 1) {
        await getGate
        throw new Error('simulated GET failure')
      }
      return fakeParsed({ x: 9 })
    }

    // Drive a fresh load via single-slot sync (rejects on failure, so
    // swallow the rejection — we only care about the mirror side-effect).
    const syncP = sbp('chelonia/kv/sync', c, 'staleLoad').catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Replace the slot definition while the GET is in flight. The
    // kvSlotsByContractID entry now points at a fresh slot object whose
    // status/lastError the stale load must not touch.
    sbp('chelonia/kv/defineSlot', {
      key: 'staleLoad', contractType: CTYPE, defaultValue: { x: 9 }, schema: schemaB
    })
    const entry = rootState()._kv![c]!.staleLoad as {
      value: unknown; status: string; lastError?: { name: string; message: string }
    }

    // Release the failing GET. The old load's catch path must see the
    // staleness and bail out without stamping 'error' or setting
    // lastError on the replacement slot; the replacement's own load
    // resolves the value.
    releaseGet()
    await syncP
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.notStrictEqual(entry.status, 'error',
      'replacement slot must not be marked error by the stale load failure')
    assert.strictEqual(entry.lastError, undefined,
      'replacement slot must not inherit lastError from the stale load failure')
    assert.deepStrictEqual(entry.value, { x: 9 },
      'replacement slot must load its own value, unaffected by the stale failure')
    stubGet = async () => null
  })

  // -----------------------------------------------------------------------
  // 42b: issue 1 – replacing a slot whose first load is still in flight
  // must still fetch the value for the replacement slot. Without the
  // fix, reconcile sees the key already active and skips autoload, the
  // superseded load discards its GET, and the value never loads.
  // -----------------------------------------------------------------------
  it('42b: replacing a slot mid first-load still loads the replacement value', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'replaceLoad', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-42b'

    // Gate the initial autoload GET so we can replace the slot while it
    // is in flight.
    let releaseGet!: () => void
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve })
    stubGet = async () => {
      await getGate
      return fakeParsed({ x: 7 })
    }
    await setupContract(c)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Replace the slot while the first load is in flight.
    sbp('chelonia/kv/defineSlot', {
      key: 'replaceLoad', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })

    // Subsequent (replacement) load returns the server value.
    stubGet = async () => fakeParsed({ x: 7 })
    releaseGet()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entry = rootState()._kv![c]!.replaceLoad as { value: unknown; status: string }
    assert.deepStrictEqual(entry.value, { x: 7 },
      'replacement slot must load the server value, not stay at the default')
    assert.strictEqual(entry.status, 'loaded',
      'replacement slot must reach loaded, not stay non-init')
    stubGet = async () => null
  })

  // -----------------------------------------------------------------------
  // 42c: issue 1 – replacing a slot while a load is pending on an
  // already-`loaded` slot. The pending load's status is still 'loaded'
  // (so the `unloaded` check misses it); the pending-load counter makes
  // the gate schedule a fresh load for the replacement instead of
  // revalidating the value the superseded load will discard.
  // -----------------------------------------------------------------------
  it('42c: replacing a slot with a pending load on a loaded slot refetches', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'queuedLoad', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-42c'
    await setupContract(c)
    // Drive the slot to 'loaded' with { x: 1 }.
    await sbp('chelonia/kv/_handleRemote', c, 'queuedLoad', fakeParsed({ x: 1 }), 'e1')
    assert.strictEqual(rootState()._kv![c]!.queuedLoad.status, 'loaded')

    // Simulate a load queued-but-not-started: status is still 'loaded'
    // (so `unloaded` is false) but the pending-load counter is non-zero.
    sbp('chelonia/test/incPendingLoad', c)
    let getCalls = 0
    stubGet = async () => { getCalls++; return { ...fakeParsed({ x: 2 }), etag: 'e2' } }

    // Replace the slot. Without the pending-load gate this would
    // revalidate the stale { x: 1 }; with it, a fresh load is scheduled.
    sbp('chelonia/kv/defineSlot', {
      key: 'queuedLoad', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    sbp('chelonia/test/decPendingLoad', c)

    const entry = rootState()._kv![c]!.queuedLoad as { value: unknown; status: string }
    assert.strictEqual(getCalls, 1,
      'a pending load on a loaded slot must trigger a fresh load on replacement')
    assert.deepStrictEqual(entry.value, { x: 2 },
      'replacement must refetch the server value, not retain the stale loaded value')
    assert.strictEqual(entry.status, 'loaded')
    stubGet = async () => null
  })

  // -----------------------------------------------------------------------
  // 42d: issue 3 – the authoritative GET `_handleRemote` runs to reconcile
  // a conflict is counted as a pending load for the contract while it is in
  // flight, so a `defineSlot` replacement landing mid-GET takes the
  // fresh-load gate (42c) rather than revalidating a soon-to-be-stale value.
  // -----------------------------------------------------------------------
  it('42d: a conflict-resolution GET registers as a pending load while in flight', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cflR', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-42d'
    await setupContract(c)
    await sbp('chelonia/kv/_handleRemote', c, 'cflR', fakeParsed({ x: 1 }), 'e1')

    // A pending conflict marker forces an authoritative GET when a
    // competing non-self frame arrives.
    sbp('chelonia/test/addEchoCID', `${c}::cflR`, 'conflict-cid', true)

    // Gate the conflict GET so we can observe the pending-load counter
    // while it is in flight.
    let releaseGet!: () => void
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve })
    let loadDuringGet = -1
    stubGet = async () => {
      loadDuringGet = sbp('chelonia/test/pendingLoadCount', c)
      await getGate
      return { ...fakeParsed({ x: 2 }), etag: 'e2' }
    }

    const remoteP = sbp('chelonia/kv/_handleRemote', c, 'cflR', fakeParsed({ x: 9 }), 'remote-cid')
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseGet()
    await remoteP

    assert.ok(loadDuringGet > 0,
      'the conflict-resolution GET must register as a pending load in flight')
    assert.strictEqual(sbp('chelonia/test/pendingLoadCount', c), 0,
      'pending-load counter is balanced after the conflict GET settles')
    stubGet = async () => null
  })

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------

  it('43: stale successful update still echo-suppresses the committed write', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'staleUpdate', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-44'
    await setupContract(c)

    const echoCID = 'old-slot-etag'
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: echoCID }
    }

    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'staleUpdate', updater: () => ({ x: 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    sbp('chelonia/kv/defineSlot', {
      key: 'staleUpdate', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })
    const { log, offs } = collectEvents()
    releaseSet()
    // The write committed to the server, so `update` resolves with the
    // committed value (not `undefined`, which is reserved for KV_NOOP).
    assert.deepStrictEqual(await updateP, { x: 1 })

    // The committed write's echo must be suppressed even though the slot
    // was replaced mid-write — otherwise it would be re-validated through
    // the replacement slot and could spuriously flip it to 'error'.
    await sbp('chelonia/kv/_handleRemote', c, 'staleUpdate', fakeParsed({ x: 1 }), echoCID)
    assert.ok(!log.some((e) =>
      e.type === CHELONIA_KV_UPDATED &&
      (e.payload as { reason: string }).reason === 'remote'
    ), 'echo of committed write should be suppressed, not processed as remote')
    offs.forEach((off) => off())
  })

  it('43a: post-success abort still echo-suppresses the committed write (update)', async () => {
    // An abort that lands between `kv/set` resolving (write committed)
    // and the post-success `throwIfSignalAborted` check must
    // NOT leave the committed write's pubsub echo unsuppressed. The
    // documented AbortError contract (§4.2: "Mirror is unchanged; no
    // event fires") requires the echo-suppression recording to run
    // before the abort check; otherwise the unsuppressed echo would
    // later re-validate as a 'remote' frame, mutating the mirror and
    // firing CHELONIA_KV_UPDATED against an AbortError the contract
    // promises leaves the mirror untouched.
    sbp('chelonia/kv/defineSlot', {
      key: 'abortUpdate', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-43a'
    await setupContract(c)

    const echoCID = 'post-success-abort-update'
    const ac = new AbortController()
    stubSet = async () => {
      // The POST just committed (we're about to return the etag); the
      // caller aborts inside this window before update's step-6 runs.
      ac.abort()
      return { etag: echoCID }
    }

    const { log, offs } = collectEvents()
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'abortUpdate', signal: ac.signal, updater: () => ({ x: 1 })
      }),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
    )

    // (a) AbortError contract holds: no events fired, mirror untouched.
    assert.strictEqual(log.length, 0, 'no events should fire on abort')
    assert.strictEqual(rootState()._kv![c]!.abortUpdate.value, undefined)
    assert.strictEqual(rootState()._kv![c]!.abortUpdate.status, 'non-init')

    // (b) Echo CID was recorded DESPITE the abort — the write committed,
    // so its echo must be suppressed. Pre-fix this entry was missing
    // because the abort check ran before recordEchoCID.
    assert.ok(
      sbp('chelonia/test/echoCIDPresent', `${c}${KV_KEY_SEPARATOR}abortUpdate`, echoCID),
      'echo CID must be recorded before the abort check'
    )

    // (c) The committed write's pubsub echo arrives: it must be
    // suppressed, not re-validated as 'remote' (which would breach the
    // abort contract by mutating the mirror after the AbortError).
    await sbp('chelonia/kv/_handleRemote', c, 'abortUpdate', fakeParsed({ x: 1 }), echoCID)
    assert.ok(!log.some((e) =>
      e.type === CHELONIA_KV_UPDATED
    ), 'echo of aborted-but-committed write should be suppressed')
    assert.strictEqual(rootState()._kv![c]!.abortUpdate.value, undefined)
    offs.forEach((off) => off())
  })

  it('44: stale successful clear still echo-suppresses the committed write', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'staleClear', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-45'
    await setupContract(c)
    rootState()._kv![c]!.staleClear.value = { x: 5 }
    rootState()._kv![c]!.staleClear.status = 'loaded'

    const echoCID = 'clear-etag'
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: echoCID }
    }

    const clearP = sbp('chelonia/kv/clear', c, 'staleClear')
    await new Promise((resolve) => setTimeout(resolve, 0))

    sbp('chelonia/kv/defineSlot', {
      key: 'staleClear', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })
    const { log, offs } = collectEvents()
    releaseSet()
    await clearP

    await sbp('chelonia/kv/_handleRemote', c, 'staleClear', fakeParsed(null), echoCID)
    assert.ok(!log.some((e) =>
      e.type === CHELONIA_KV_UPDATED &&
      (e.payload as { reason: string }).reason === 'remote'
    ), 'echo of committed clear should be suppressed, not processed as remote')
    offs.forEach((off) => off())
  })

  it('44a1: replaced-slot committed write resolves with the value, not undefined', async () => {
    // #3: a write that commits to the server but whose slot was replaced
    // mid-flight must resolve with the committed value — `undefined` is
    // reserved for KV_NOOP/abort, so callers can distinguish a persisted
    // write from a genuine no-op.
    sbp('chelonia/kv/defineSlot', {
      key: 'committed', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-44a1'
    await setupContract(c)

    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: 'committed-cid' }
    }
    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'committed', updater: () => ({ x: 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Replace the slot while the set is in flight.
    sbp('chelonia/kv/defineSlot', {
      key: 'committed',
      contractType: CTYPE,
      defaultValue: { x: 9 },
      schema: objectSchema,
      autoLoad: 'never'
    })
    releaseSet()

    assert.deepStrictEqual(await updateP, { x: 1 })
  })

  it('44a2: replaced-slot committed write is echo-suppressed (no spurious error)', async () => {
    // #2: a stricter replacement schema must not flip the slot to 'error'
    // when the committed write's own echo arrives — the echo is
    // suppressed even though the slot was replaced after the set.
    sbp('chelonia/kv/defineSlot', {
      key: 'noError', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-44a2'
    await setupContract(c)

    const echoCID = 'committed-cid-2'
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: echoCID }
    }
    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'noError', updater: () => ({ x: -5 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Replacement schema rejects the value the client just wrote.
    sbp('chelonia/kv/defineSlot', {
      key: 'noError',
      contractType: CTYPE,
      defaultValue: { x: 1 },
      schema: strictSchema,
      autoLoad: 'never'
    })
    releaseSet()
    await updateP

    // The committed write's echo arrives; it must be dropped, not
    // re-validated through strictSchema (which would reject x: -5).
    await sbp('chelonia/kv/_handleRemote', c, 'noError', fakeParsed({ x: -5 }), echoCID)
    assert.notStrictEqual(rootState()._kv![c]!.noError.status, 'error')
  })

  it('44b: remote after slot replacement validates against replacement schema', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'remoteReplace', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-44b'
    await setupContract(c)
    assert.strictEqual(rootState()._kv![c]!.remoteReplace.status, 'non-init')

    sbp('chelonia/kv/defineSlot', {
      key: 'remoteReplace',
      contractType: CTYPE,
      defaultValue: { x: 9 },
      schema: strictSchema,
      autoLoad: 'never'
    })
    await sbp('chelonia/kv/_handleRemote', c, 'remoteReplace', fakeParsed({ x: -1 }), 'bad-cid')

    assert.strictEqual(rootState()._kv![c]!.remoteReplace.status, 'error')
    assert.deepStrictEqual(rootState()._kv![c]!.remoteReplace.value, undefined)
  })

  it('44c: stale remote update skips replaced slot onUpdate', async () => {
    let oldCalls = 0
    sbp('chelonia/kv/defineSlot', {
      key: 'remoteStale',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: async () => { oldCalls++ }
    })
    const c = 'cid-44c'
    await setupContract(c)

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, () => {
      sbp('chelonia/kv/defineSlot', {
        key: 'remoteStale',
        contractType: CTYPE,
        defaultValue: { x: 9 },
        schema: objectSchema,
        autoLoad: 'never'
      })
    })
    try {
      await sbp('chelonia/kv/_handleRemote', c, 'remoteStale', fakeParsed({ x: 1 }), 'remote-cid')
    } finally {
      off()
    }

    assert.strictEqual(oldCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.remoteStale.value, { x: 1 })
  })

  it('44d: stale load skips replaced slot onUpdate', async () => {
    let oldCalls = 0
    sbp('chelonia/kv/defineSlot', {
      key: 'loadStale',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      autoLoad: 'never',
      onUpdate: async () => { oldCalls++ }
    })
    const c = 'cid-44d'
    await setupContract(c)
    stubGet = async () => ({
      data: { x: 1 },
      encryptionKeyId: 'ek',
      signingKeyId: 'sk',
      etag: 'load-cid'
    }) as unknown as ChelKvGetResult

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, () => {
      sbp('chelonia/kv/defineSlot', {
        key: 'loadStale',
        contractType: CTYPE,
        defaultValue: { x: 9 },
        schema: objectSchema,
        autoLoad: 'never'
      })
    })
    try {
      await sbp('chelonia/kv/sync', c, 'loadStale')
    } finally {
      off()
    }

    assert.strictEqual(oldCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.loadStale.value, { x: 1 })
  })

  it('44e: stale local update skips replaced slot onUpdate', async () => {
    let oldCalls = 0
    sbp('chelonia/kv/defineSlot', {
      key: 'updateStaleOnUpdate',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: async () => { oldCalls++ }
    })
    const c = 'cid-44e'
    await setupContract(c)

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, () => {
      sbp('chelonia/kv/defineSlot', {
        key: 'updateStaleOnUpdate',
        contractType: CTYPE,
        defaultValue: { x: 9 },
        schema: objectSchema,
        autoLoad: 'never'
      })
    })
    try {
      await sbp('chelonia/kv/update', {
        contractID: c,
        key: 'updateStaleOnUpdate',
        updater: () => ({ x: 1 })
      })
    } finally {
      off()
    }

    assert.strictEqual(oldCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.updateStaleOnUpdate.value, { x: 1 })
  })

  it('44f: stale local clear skips replaced slot onUpdate', async () => {
    let oldCalls = 0
    sbp('chelonia/kv/defineSlot', {
      key: 'clearStaleOnUpdate',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: async () => { oldCalls++ }
    })
    const c = 'cid-44f'
    await setupContract(c)
    rootState()._kv![c]!.clearStaleOnUpdate.value = { x: 5 }
    rootState()._kv![c]!.clearStaleOnUpdate.status = 'loaded'

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, () => {
      sbp('chelonia/kv/defineSlot', {
        key: 'clearStaleOnUpdate',
        contractType: CTYPE,
        defaultValue: { x: 9 },
        schema: objectSchema,
        autoLoad: 'never'
      })
    })
    try {
      await sbp('chelonia/kv/clear', c, 'clearStaleOnUpdate')
    } finally {
      off()
    }

    assert.strictEqual(oldCalls, 0)
    // Canonical 'non-init' shape after clear: raw mirror `value` is
    // `undefined`. The active slot is now the replacement, so `read`
    // surfaces the replacement's default.
    assert.strictEqual(rootState()._kv![c]!.clearStaleOnUpdate.value, undefined)
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'clearStaleOnUpdate'), { x: 9 })
  })

  it('44g: local writes without etags warn about disabled self-echo suppression', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'noEtag', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-44d'
    await setupContract(c)

    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    stubSet = async () => ({ etag: null })
    try {
      await sbp('chelonia/kv/update', {
        contractID: c, key: 'noEtag', updater: () => ({ x: 1 })
      })
      await sbp('chelonia/kv/clear', c, 'noEtag')
    } finally {
      console.warn = originalWarn
    }

    assert.strictEqual(warnings.length, 2)
    assert.ok(String(warnings[0][0]).includes('update:'))
    assert.ok(String(warnings[1][0]).includes('clear:'))
  })

  it('44h: post-success abort still echo-suppresses the committed write (clear)', async () => {
    // Clear analog of 43a: an abort that lands between
    // `kv/set` resolving (clear committed) and the post-success
    // `throwIfSignalAborted` check must NOT leave the committed clear's
    // pubsub echo unsuppressed. The AbortError contract (§4.2) requires
    // "Mirror is unchanged; no event fires" — `recordEchoCID` must run
    // before the abort check, otherwise the unsuppressed echo would
    // re-validate as a 'remote' frame and mutate the mirror after the
    // AbortError was already thrown.
    sbp('chelonia/kv/defineSlot', {
      key: 'abortClear', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-44h'
    await setupContract(c)
    rootState()._kv![c]!.abortClear.value = { x: 5 }
    rootState()._kv![c]!.abortClear.status = 'loaded'

    const echoCID = 'post-success-abort-clear'
    const ac = new AbortController()
    stubSet = async () => {
      ac.abort()
      return { etag: echoCID }
    }

    const { log, offs } = collectEvents()
    await assert.rejects(
      () => sbp('chelonia/kv/clear', c, 'abortClear', { signal: ac.signal }),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
    )

    // (a) AbortError contract holds: no events fired, mirror untouched
    //     (the pre-existing { x: 5 } value remains).
    assert.strictEqual(log.length, 0, 'no events should fire on abort')
    assert.deepStrictEqual(rootState()._kv![c]!.abortClear.value, { x: 5 })

    // (b) Echo CID was recorded DESPITE the abort. Pre-fix this entry
    //     was missing because the abort check ran before recordEchoCID.
    assert.ok(
      sbp('chelonia/test/echoCIDPresent', `${c}${KV_KEY_SEPARATOR}abortClear`, echoCID),
      'echo CID must be recorded before the abort check'
    )

    // (c) The committed clear's pubsub echo arrives: it must be
    //     suppressed, not re-validated as 'remote'.
    await sbp('chelonia/kv/_handleRemote', c, 'abortClear', fakeParsed(null), echoCID)
    assert.ok(!log.some((e) =>
      e.type === CHELONIA_KV_UPDATED
    ), 'echo of aborted-but-committed clear should be suppressed')
    assert.deepStrictEqual(rootState()._kv![c]!.abortClear.value, { x: 5 })
    offs.forEach((off) => off())
  })

  it('45: local echo CIDs are bounded to the configured cap', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'burst', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-46'
    await setupContract(c)

    const writes: JSONType[] = []
    const cids: string[] = []
    stubSet = async (_cID, _key, data) => {
      writes.push(data as JSONType)
      const etag = `e-${writes.length}`
      cids.push(etag)
      return { etag }
    }

    for (let i = 0; i < KV_ECHO_CID_MAX + 1; i++) {
      await sbp('chelonia/kv/update', {
        contractID: c,
        key: 'burst',
        updater: (prev: JSONType | undefined) => ({
          x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
        })
      })
    }
    assert.deepStrictEqual(rootState()._kv![c]!.burst.value, { x: KV_ECHO_CID_MAX + 1 })

    const { log, offs } = collectEvents()
    for (let i = 0; i < writes.length; i++) {
      await sbp('chelonia/kv/_handleRemote', c, 'burst', fakeParsed(writes[i]), cids[i])
    }
    assert.deepStrictEqual(rootState()._kv![c]!.burst.value, { x: 1 })
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1)
    offs.forEach((off) => off())
  })

  it('45b: expired echo CIDs are purged and handled as remote', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'expiredEcho', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-46b'
    await setupContract(c)

    let clock = 1000
    sbp('chelonia/kv/_testSetNowMs', () => clock)
    stubSet = async () => ({ etag: 'expired-cid' })
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'expiredEcho',
      updater: () => ({ x: 1 })
    })
    assert.strictEqual(
      sbp('chelonia/test/echoCIDExpiry', `${c}::expiredEcho`, 'expired-cid'),
      clock + KV_ECHO_TTL_MS
    )

    clock += KV_ECHO_TTL_MS + 1
    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'expiredEcho', fakeParsed({ x: 2 }), 'expired-cid')
    assert.deepStrictEqual(rootState()._kv![c]!.expiredEcho.value, { x: 2 })
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::expiredEcho`), false)
    sbp('chelonia/kv/_testSetNowMs')
    offs.forEach((off) => off())
  })

  it('46: autoSubscribe false match teardown removes empty filter buckets', async () => {
    let shouldMatch = true
    const contractType = 'type-47'
    sbp('chelonia/kv/defineSlot', {
      key: 'emptyFilter',
      contractType,
      defaultValue: { x: 0 },
      autoSubscribe: false,
      match: () => shouldMatch
    })
    const c = 'cid-47'
    await setupContract(c, contractType)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])

    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    assert.strictEqual(sbp('chelonia/test/activeFilterKeys', c), undefined)
  })

  it('47: autoSubscribe false manifest cleanup removes empty filter buckets', async () => {
    const contractType = 'type-v48'
    const manifest = 'manifest-v48'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      hidden: { defaultValue: { x: 0 }, autoSubscribe: false }
    })
    const c = 'cid-48'
    await setupContract(c, contractType)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])

    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, { hidden: {} }, {})
    assert.strictEqual(sbp('chelonia/test/activeFilterKeys', c), undefined)
  })

  // -----------------------------------------------------------------------
  // 48: _loadSlot decode failure sets error status
  // -----------------------------------------------------------------------
  it('48: _loadSlot decode failure flips slot to error', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'decLoad', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-49'
    await setupContract(c)

    const decodeErr = new Error('decrypt failed')
    stubGet = async () => {
      return {
        get data () { throw decodeErr },
        encryptionKeyId: 'ek',
        signingKeyId: 'sk',
        etag: 'etag-49'
      } as unknown as ChelKvGetResult
    }

    const { log, offs } = collectEvents()
    await assert.rejects(
      () => sbp('chelonia/kv/sync', c, 'decLoad'),
      (e: unknown) => e instanceof ChelErrorKvValidation
    )
    const entry = rootState()._kv![c]!.decLoad as {
      status: string;
      lastError?: { name: string; message: string };
    }
    assert.strictEqual(entry.status, 'error')
    assert.strictEqual(entry.lastError?.name, 'Error')
    assert.strictEqual(entry.lastError?.message, 'decrypt failed')
    assert.ok(log.some((e) => e.type === CHELONIA_KV_VALIDATION_ERROR))

    log.length = 0
    stubGet = async () => fakeParsed({ x: 3 })
    await sbp('chelonia/kv/sync', c, 'decLoad')
    const statusEvents = log.filter((e) =>
      e.type === CHELONIA_KV_STATUS_CHANGED &&
      (e.payload as { key: string }).key === 'decLoad'
    )
    const lastStatus = statusEvents[statusEvents.length - 1].payload as { lastError: unknown }
    assert.strictEqual(lastStatus.lastError, null)
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 49: _handleRemote decode failure resolves without throwing
  // -----------------------------------------------------------------------
  it('49: _handleRemote decode failure resolves and flips to error', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'decRemote', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-50'
    await setupContract(c)
    const entry = rootState()._kv![c]!.decRemote as {
      value: unknown;
      status: string;
      lastError?: { name: string; message: string };
    }
    entry.value = { x: 5 }
    entry.status = 'loaded'

    const decodeErr = new Error('signature failed')
    const throwingParsed = {
      get data () { throw decodeErr }
    } as unknown as ParsedEncryptedOrUnencryptedMessage<JSONType>

    const { log, offs } = collectEvents()
    // Must resolve (not reject)
    await sbp('chelonia/kv/_handleRemote', c, 'decRemote', throwingParsed)
    assert.strictEqual(entry.status, 'error')
    assert.deepStrictEqual(entry.value, { x: 5 })
    assert.strictEqual(entry.lastError?.name, 'Error')
    assert.strictEqual(entry.lastError?.message, 'signature failed')
    assert.ok(log.some((e) => e.type === CHELONIA_KV_VALIDATION_ERROR))
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 50: multiple autoSubscribe:false slots keep filter bucket on partial teardown
  // -----------------------------------------------------------------------
  it('50: partial autoSubscribe:false teardown preserves filter bucket', async () => {
    const contractType = 'type-51'
    let matchA = true
    let matchB = true
    sbp('chelonia/kv/defineSlot', {
      key: 'slotA',
      contractType,
      defaultValue: { x: 0 },
      autoSubscribe: false,
      match: () => matchA
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'slotB',
      contractType,
      defaultValue: { x: 0 },
      autoSubscribe: false,
      match: () => matchB
    })
    const c = 'cid-51'
    await setupContract(c, contractType)

    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])
    sbp('chelonia/kv/_assertIndexConsistent')

    matchA = false
    sbp('chelonia/kv/refreshFilters', c)
    sbp('chelonia/kv/_assertIndexConsistent')
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])

    matchB = false
    sbp('chelonia/kv/refreshFilters', c)
    sbp('chelonia/kv/_assertIndexConsistent')
    assert.strictEqual(sbp('chelonia/test/activeFilterKeys', c), undefined)
  })

  // -----------------------------------------------------------------------
  // 51: echo CID eviction — more than max writes evicts earliest-expiry CID
  // -----------------------------------------------------------------------
  it('51: writes past the echo CID max evict the earliest-expiry CID', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'evict', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-52'
    await setupContract(c)

    const writes: JSONType[] = []
    const cids: string[] = []
    stubSet = async (_cID, _key, data) => {
      writes.push(data as JSONType)
      const etag = `e-${writes.length}`
      cids.push(etag)
      return { etag }
    }

    for (let i = 0; i < KV_ECHO_CID_MAX + 1; i++) {
      await sbp('chelonia/kv/update', {
        contractID: c,
        key: 'evict',
        updater: (prev: JSONType | undefined) => ({
          x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
        })
      })
    }
    assert.deepStrictEqual(rootState()._kv![c]!.evict.value, { x: KV_ECHO_CID_MAX + 1 })

    // First write's echo should NOT be suppressed (CID evicted)
    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'evict', fakeParsed(writes[0]), cids[0])
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1)
    assert.deepStrictEqual(rootState()._kv![c]!.evict.value, { x: 1 })

    // Last write's echo IS still suppressed
    log.length = 0
    await sbp(
      'chelonia/kv/_handleRemote',
      c,
      'evict',
      fakeParsed(writes[KV_ECHO_CID_MAX]),
      cids[KV_ECHO_CID_MAX]
    )
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    offs.forEach((off) => off())
  })

  it('52: first autoSubscribe:false slot flushes an empty filter', async () => {
    const contractType = 'type-53'
    sbp('chelonia/kv/defineSlot', {
      key: 'onlyHidden',
      contractType,
      defaultValue: { x: 0 },
      autoSubscribe: false
    })
    const c = 'cid-53'
    await setupContract(c, contractType)

    sbp('chelonia/kv/_assertIndexConsistent')
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])
    assert.ok(
      stubSetFilterCalls.some((f) => f.contractID === c && f.keys.length === 0),
      'expected setFilter(c, []) to be queued for autoSubscribe:false first slot'
    )
  })

  it('53: manifest cleanup preserves filter bucket for standalone local-only slots', async () => {
    const contractType = 'type-54'
    const manifest = 'manifest-54'
    sbp('chelonia/kv/defineSlot', {
      key: 'localOnly',
      contractType,
      defaultValue: { x: 0 },
      autoSubscribe: false
    })
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      alpha: { defaultValue: { x: 1 }, autoSubscribe: true }
    })
    const c = 'cid-54'
    await setupContract(c, contractType)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), ['alpha'])

    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, { alpha: {} }, {})
    sbp('chelonia/kv/_assertIndexConsistent')
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])
  })

  it('54: manifest cleanup removes stale echo nonces only for removed slots', async () => {
    const contractType = 'type-55'
    const manifest = 'manifest-55'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      removed: { defaultValue: { x: 0 } }
    })
    const c = 'cid-55'
    await setupContract(c, contractType)
    sbp('chelonia/test/seedEchoCID', `${c}::removed`)
    sbp('chelonia/test/seedEchoCID', 'other::removed')

    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, { removed: {} }, {})
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::removed`), false)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', 'other::removed'), true)
  })

  it('54b: manifest ownership mismatch does not remove inline slots', async () => {
    const contractType = 'type-55b'
    const manifest = 'manifest-55b'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      keep: { defaultValue: { x: 0 } }
    })
    const c = 'cid-55b'
    await setupContract(c, contractType)

    sbp('chelonia/kv/_cleanupContractSlots', contractType, 'other-manifest-55b', { keep: {} }, {})
    assert.ok(rootState()._kv?.[c]?.keep)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), ['keep'])
  })

  it('55: update seeds error-status mirror entries from the default', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'errSeed', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-56'
    await setupContract(c)

    const entry = rootState()._kv![c]!.errSeed as {
      value: unknown; status: string
    }
    entry.value = { x: -5 }
    entry.status = 'loaded'

    sbp('chelonia/kv/defineSlot', {
      key: 'errSeed', contractType: CTYPE, defaultValue: { x: 1 }, schema: strictSchema
    })

    assert.deepStrictEqual(entry.value, { x: -5 })
    assert.strictEqual(entry.status, 'error')
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'errSeed'), { x: 1 })

    let reducerSeed: JSONType | undefined
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'errSeed',
      updater: (prev: JSONType | undefined) => {
        reducerSeed = prev
        return { x: 2 }
      }
    })
    assert.deepStrictEqual(reducerSeed, { x: 1 })
  })

  it('56: queued abort rejects before reducer invocation', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'abortQueued', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-57'
    await setupContract(c)

    let runBody!: () => void
    stubQueueInvocation = (_cID, fn) => new Promise((resolve, reject) => {
      runBody = () => {
        Promise.resolve(runQueued(fn)).then(resolve, reject)
      }
    })
    let reducerCalls = 0
    const ac = new AbortController()
    const update = sbp('chelonia/kv/update', {
      contractID: c,
      key: 'abortQueued',
      signal: ac.signal,
      updater: () => {
        reducerCalls++
        return { x: 2 }
      }
    })
    ac.abort()
    runBody()
    await assert.rejects(
      () => update,
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
    )
    stubQueueInvocation = (_cID, fn) => Promise.resolve(runQueued(fn))
    assert.strictEqual(reducerCalls, 0)
  })

  it('57: conflict currentData getter decode failures map to validation', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'decodeConflict', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-58'
    await setupContract(c)

    const decodeErr = new Error('decode boom')
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!(Object.defineProperty({ etag: 'e-decode' }, 'currentData', {
        get () { throw decodeErr }
      }) as { currentData?: JSONType; etag?: string | null })
      return { etag: 'unused' }
    }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'decodeConflict', updater: () => ({ x: 2 })
      }),
      (e: unknown) => e instanceof ChelErrorKvValidation && e.cause === decodeErr
    )
  })

  it('58: conflict exhaustion preserves carried final server state', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'finalConflict', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-59'
    await setupContract(c)

    stubSet = async () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value', {
        cause: { currentData: { x: 99 }, etag: 'e-final' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'finalConflict', updater: () => ({ x: 2 })
      }),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        assert.deepStrictEqual(e.cause, { currentData: { x: 99 }, etag: 'e-final' })
        return true
      }
    )
  })

  it('59: ambiguous write failure can reconcile later as remote', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'ambiguous', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-60'
    await setupContract(c)

    let committed: JSONType | undefined
    stubSet = async (_cID, _key, data) => {
      committed = data as JSONType
      throw new Error('network after commit')
    }
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'ambiguous', updater: () => ({ x: 2 })
      }),
      /network after commit/
    )
    assert.deepStrictEqual(rootState()._kv![c]!.ambiguous.value, undefined)

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'ambiguous', fakeParsed(committed!))
    assert.deepStrictEqual(rootState()._kv![c]!.ambiguous.value, { x: 2 })
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length,
      1
    )
    offs.forEach((off) => off())
  })

  it('60: conflicted update records the successful response CID', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'ordered', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-61'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-r' })
      return { etag: 'e-l' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'ordered',
      updater: (prev: JSONType | undefined) => ({
        x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
      })
    })
    assert.deepStrictEqual(rootState()._kv![c]!.ordered.value, { x: 2 })
    assert.strictEqual(rootState()._kv![c]!.ordered.etag, 'e-l')
  })

  it('61: remote cid keeps mirror etag authoritative', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'serial', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-62'
    await setupContract(c)

    await sbp('chelonia/kv/_handleRemote', c, 'serial', fakeParsed({ x: 7 }), 'remote-cid')
    assert.deepStrictEqual(rootState()._kv![c]!.serial.value, { x: 7 })
    assert.strictEqual(rootState()._kv![c]!.serial.etag, 'remote-cid')

    let ifMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      ifMatch = opts.ifMatch
      return { etag: 'local-cid' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'serial', updater: () => ({ x: 10 })
    })
    assert.strictEqual(ifMatch, 'remote-cid')
  })

  it('61b: value-bearing no-cid remote frame triggers an authoritative GET to re-pair value+etag', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'noCid', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-62b'
    await setupContract(c)

    // Seed an etag-bearing mirror via a cid frame.
    await sbp('chelonia/kv/_handleRemote', c, 'noCid', fakeParsed({ x: 1 }), 'known-cid')
    assert.strictEqual(rootState()._kv![c]!.noCid.etag, 'known-cid')

    // A no-cid frame on the now-etag-bearing slot must NOT apply inline
    // (which would pair a new value with the stale 'known-cid' etag).
    // Instead it forces an authoritative GET; the mirror takes the
    // server's value AND etag together.
    let getCalled = 0
    stubGet = async () => { getCalled++; return fakeParsed({ x: 99 }) }
    await sbp('chelonia/kv/_handleRemote', c, 'noCid', fakeParsed({ x: 2 }))

    assert.strictEqual(getCalled, 1, 'no-cid frame should force an authoritative GET')
    assert.deepStrictEqual(rootState()._kv![c]!.noCid.value, { x: 99 },
      'mirror value comes from the GET, not the un-trackable frame')
    assert.strictEqual(rootState()._kv![c]!.noCid.etag, 'etag-fake',
      'mirror etag comes from the GET — paired with the GET value')
  })

  it('61c: no-cid remote frame on a never-loaded slot applies inline with null etag', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'noCid2', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-62c'
    await setupContract(c)

    // Mirror entry exists (seeded on sync) but has never loaded: etag null.
    assert.strictEqual(rootState()._kv![c]!.noCid2.etag, null)

    let getCalled = 0
    stubGet = async () => { getCalled++; return fakeParsed({ x: 1 }) }
    await sbp('chelonia/kv/_handleRemote', c, 'noCid2', fakeParsed({ x: 5 }))

    assert.strictEqual(getCalled, 0, 'never-loaded slot applies inline; no GET')
    assert.deepStrictEqual(rootState()._kv![c]!.noCid2.value, { x: 5 })
    assert.strictEqual(rootState()._kv![c]!.noCid2.etag, null,
      'inline apply keeps null etag (no stale etag to clobber)')
  })

  it('62: conflicted write self-echo is suppressed by CID', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'awaitEcho', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-63'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-old' })
      return { etag: 'e-local' }
    }
    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'awaitEcho',
      updater: (prev: JSONType | undefined) => ({
        x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
      })
    })
    log.length = 0
    await sbp('chelonia/kv/_handleRemote', c, 'awaitEcho', fakeParsed({ x: 2 }), 'e-local')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    offs.forEach((off) => off())
  })

  it('63: consecutive conflicted writes track CIDs separately', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'awaitMany', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64'
    await setupContract(c)

    let count = 0
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: count }, etag: `e-old-${count}` })
      count++
      return { etag: `e-local-${count}` }
    }

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'awaitMany', updater: () => ({ x: 1 })
    })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'awaitMany', updater: () => ({ x: 2 })
    })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'awaitMany', fakeParsed({ x: 1 }), 'e-local-1')
    await sbp('chelonia/kv/_handleRemote', c, 'awaitMany', fakeParsed({ x: 2 }), 'e-local-2')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    offs.forEach((off) => off())
  })

  it('63b: conflicted update forces sync for non-self remote frames', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'forceSync', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64b'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed({ x: 2 }), etag: 'e-local' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'forceSync',
      updater: (prev: JSONType | undefined) => ({
        x: ((prev as { x: number } | undefined)?.x ?? 0) + 1
      })
    })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'forceSync', fakeParsed({ x: 1 }), 'e-remote')
    assert.strictEqual(getCalls, 1)
    assert.deepStrictEqual(rootState()._kv![c]!.forceSync.value, { x: 2 })
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length,
      1
    )
    offs.forEach((off) => off())
  })

  it('63c: force sync demotes (keeps) conflicted echo markers', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'lostEcho', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64c'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed({ x: 2 }), etag: 'e-sync' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'lostEcho', updater: () => ({ x: 3 })
    })

    await sbp('chelonia/kv/_handleRemote', c, 'lostEcho', fakeParsed({ x: 1 }), 'e-remote-1')
    assert.strictEqual(getCalls, 1)
    // The conflict CID is demoted, not deleted, so a delayed self-echo
    // can still be suppressed; but it no longer forces a second GET.
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', `${c}::lostEcho`, 'e-local'), false
    )
    assert.deepStrictEqual(rootState()._kv![c]!.lostEcho.value, { x: 2 })

    await sbp('chelonia/kv/_handleRemote', c, 'lostEcho', fakeParsed({ x: 4 }), 'e-remote-2')
    assert.strictEqual(getCalls, 1)
    assert.deepStrictEqual(rootState()._kv![c]!.lostEcho.value, { x: 4 })
  })

  it('63c1: delayed conflict echo after force sync does not regress mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'delayedEcho', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64c1'
    await setupContract(c)

    // Conflict-resolved write commits {x:3} as `cid-B`.
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'cid-B' }
    }
    // A third party supersedes it server-side; the authoritative GET
    // returns the latest value {x:9}.
    stubGet = async () => ({ ...fakeParsed({ x: 9 }), etag: 'cid-C' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'delayedEcho', updater: () => ({ x: 3 })
    })

    // Superseding non-self frame forces the GET; mirror = latest {x:9}.
    await sbp('chelonia/kv/_handleRemote', c, 'delayedEcho', fakeParsed({ x: 9 }), 'cid-C')
    assert.deepStrictEqual(rootState()._kv![c]!.delayedEcho.value, { x: 9 })

    // The conflict write's own (delayed) echo `cid-B` finally arrives.
    // It must be suppressed — not applied last-write-wins — so the
    // mirror stays at {x:9} and no spurious update fires.
    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'delayedEcho', fakeParsed({ x: 3 }), 'cid-B')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.delayedEcho.value, { x: 9 })
    offs.forEach((off) => off())
  })

  it('63c2: force sync preserves conflict markers recorded after dispatch', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'laterEcho', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64c2'
    await setupContract(c)

    const echoKey = `${c}::laterEcho`
    sbp('chelonia/test/addEchoCID', echoKey, 'e-local-1', true)
    stubGet = async () => {
      sbp('chelonia/test/addEchoCID', echoKey, 'e-local-2', true)
      return { ...fakeParsed({ x: 3 }), etag: 'e-sync' }
    }

    await sbp('chelonia/kv/_handleRemote', c, 'laterEcho', fakeParsed({ x: 1 }), 'e-remote')
    assert.deepStrictEqual(rootState()._kv![c]!.laterEcho.value, { x: 3 })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'laterEcho', fakeParsed({ x: 4 }), 'e-local-2')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    // `e-local-2` (a conflict marker recorded during the GET) suppressed
    // its own echo but is KEPT — and stays `fromConflict` — so a later
    // competing non-self frame still forces an authoritative GET rather
    // than regressing the mirror via last-write-wins (echo-first
    // ordering fix). `e-local-1` was demoted by the earlier forced GET.
    assert.notStrictEqual(sbp('chelonia/test/echoCIDExpiry', echoKey, 'e-local-2'), undefined)
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', echoKey, 'e-local-2'), true
    )
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', echoKey, 'e-local-1'), false
    )
    // A subsequent competing non-self frame must force a GET (marker
    // preserved), not apply the stale value last-write-wins.
    log.length = 0
    stubGet = async () => ({ ...fakeParsed({ x: 7 }), etag: 'e-sync2' })
    await sbp('chelonia/kv/_handleRemote', c, 'laterEcho', fakeParsed({ x: 99 }), 'e-other')
    assert.deepStrictEqual(rootState()._kv![c]!.laterEcho.value, { x: 7 })
    offs.forEach((off) => off())
  })

  it('63d: clean update applies non-self remote frames without sync', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cleanRemote', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64d'
    await setupContract(c)

    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed({ x: 99 }), etag: 'unused' }
    }
    stubSet = async () => ({ etag: 'e-local' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'cleanRemote', updater: () => ({ x: 1 })
    })

    await sbp('chelonia/kv/_handleRemote', c, 'cleanRemote', fakeParsed({ x: 3 }), 'e-remote')
    assert.strictEqual(getCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.cleanRemote.value, { x: 3 })
  })

  it('63e: conflicted update self-echo keeps force-sync marker', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clearMarker', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64d'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed({ x: 99 }), etag: 'unused' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'clearMarker', updater: () => ({ x: 2 })
    })

    const { log, offs } = collectEvents()
    // The conflict-resolved write's own echo arrives first (echo-first
    // ordering): it is suppressed, but the conflict marker is KEPT so a
    // later competing frame still forces an authoritative GET.
    await sbp('chelonia/kv/_handleRemote', c, 'clearMarker', fakeParsed({ x: 2 }), 'e-local')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::clearMarker`), true)
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', `${c}::clearMarker`, 'e-local'), true
    )

    // A subsequent competing non-self frame must force a GET rather than
    // regress the mirror to the stale x:4 via last-write-wins.
    await sbp('chelonia/kv/_handleRemote', c, 'clearMarker', fakeParsed({ x: 4 }), 'e-remote')
    assert.strictEqual(getCalls, 1)
    assert.deepStrictEqual(rootState()._kv![c]!.clearMarker.value, { x: 99 })
    offs.forEach((off) => off())
  })

  it('63f: conflicted clear forces sync for non-self remote frames', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clearForce', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64e'
    await setupContract(c)

    stubSet = async () => ({ etag: 'e-seed' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'clearForce', updater: () => ({ x: 9 })
    })
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 8 }, etag: 'e-remote' })
      return { etag: 'e-clear' }
    }
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed(null), etag: 'e-clear' }
    }
    await sbp('chelonia/kv/clear', c, 'clearForce')

    await sbp('chelonia/kv/_handleRemote', c, 'clearForce', fakeParsed({ x: 8 }), 'e-remote')
    assert.strictEqual(getCalls, 1)
    // The forced GET returned a wire-null clear → canonical 'non-init'
    // mirror `value` is `undefined`; the default surfaces via `read`.
    assert.strictEqual(rootState()._kv![c]!.clearForce.value, undefined)
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'clearForce'), { x: 0 })
  })

  it('63g: expired conflicted echo marker does not force sync', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'expiredConflict', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64f'
    await setupContract(c)

    let clock = 1000
    sbp('chelonia/kv/_testSetNowMs', () => clock)
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed({ x: 99 }), etag: 'unused' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'expiredConflict', updater: () => ({ x: 2 })
    })

    clock += KV_ECHO_TTL_MS + 1
    await sbp('chelonia/kv/_handleRemote', c, 'expiredConflict', fakeParsed({ x: 5 }), 'e-remote')
    assert.strictEqual(getCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.expiredConflict.value, { x: 5 })
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::expiredConflict`), false)
    sbp('chelonia/kv/_testSetNowMs')
  })

  it('64: conflict exhaustion preserves carried server state', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'wrappedConflict', contractType: CTYPE, defaultValue: { x: 1 }, schema: objectSchema
    })
    const c = 'cid-65'
    await setupContract(c)

    stubSet = async () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value', {
        cause: { currentData: { x: 99 }, etag: 'e-final' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'wrappedConflict', updater: () => ({ x: 2 })
      }),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        assert.deepStrictEqual(e.cause, { currentData: { x: 99 }, etag: 'e-final' })
        return true
      }
    )
  })

  it('64a: conflict-resolution GET failure preserves loaded status and value', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'preserveErr', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65a'
    await setupContract(c)

    // Conflict-resolved write commits {x:3}.
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    stubGet = async () => ({ ...fakeParsed({ x: 3 }), etag: 'e-local' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'preserveErr', updater: () => ({ x: 3 })
    })
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErr'), 'loaded')

    // A non-self frame forces the authoritative GET, which now fails.
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      throw new Error('network down')
    }
    const errs: unknown[][] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { errs.push(args) }
    try {
      await sbp('chelonia/kv/_handleRemote', c, 'preserveErr', fakeParsed({ x: 1 }), 'e-remote')
    } finally {
      console.error = origError
    }

    assert.strictEqual(getCalls, 1)
    // Status must stay 'loaded' (NOT flipped to 'error') and the
    // committed value must remain readable rather than the default.
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErr'), 'loaded')
    assert.deepStrictEqual(rootState()._kv![c]!.preserveErr.value, { x: 3 })
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'preserveErr'), { x: 3 })
    // The failure was logged and the conflict markers demoted.
    assert.ok(errs.some((a) => String(a[0]).includes('conflict-resolution GET failed')))
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', `${c}::preserveErr`, 'e-local'), false
    )
  })

  it('64a-schema: conflict-resolution GET schema failure preserves loaded status/value', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'preserveErrSchema', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65a-schema'
    await setupContract(c)

    // Conflict-resolved write commits {x:3}.
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    stubGet = async () => ({ ...fakeParsed({ x: 3 }), etag: 'e-local' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'preserveErrSchema', updater: () => ({ x: 3 })
    })
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErrSchema'), 'loaded')

    // A non-self frame forces the authoritative GET, which now returns
    // well-formed-but-unvalidatable data (a string fails objectSchema).
    let getCalls = 0
    let validationErr = false
    const offV = sbp('okTurtles.events/on', CHELONIA_KV_VALIDATION_ERROR, () => {
      validationErr = true
    })
    stubGet = async () => {
      getCalls++
      return { ...fakeParsed('not-an-object' as unknown as JSONType), etag: 'e-other' }
    }
    try {
      await sbp('chelonia/kv/_handleRemote', c, 'preserveErrSchema', fakeParsed({ x: 1 }), 'e-remote')
    } finally {
      offV()
    }

    assert.strictEqual(getCalls, 1)
    // Status must stay 'loaded' (NOT flipped to 'error') and the committed
    // value must remain readable rather than the default.
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErrSchema'), 'loaded')
    assert.deepStrictEqual(rootState()._kv![c]!.preserveErrSchema.value, { x: 3 })
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'preserveErrSchema'), { x: 3 })
    // The validation failure was still surfaced.
    assert.ok(validationErr)
  })

  it('64a-decode: conflict-resolution GET decode failure preserves loaded status/value', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'preserveErrDecode', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65a-decode'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 1 }, etag: 'e-remote' })
      return { etag: 'e-local' }
    }
    stubGet = async () => ({ ...fakeParsed({ x: 3 }), etag: 'e-local' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'preserveErrDecode', updater: () => ({ x: 3 })
    })
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErrDecode'), 'loaded')

    // A non-self frame forces the authoritative GET, whose `data` accessor
    // throws (decrypt/signature failure on server data).
    let getCalls = 0
    stubGet = async () => {
      getCalls++
      return {
        encryptionKeyId: 'ek',
        signingKeyId: 'sk',
        etag: 'e-other',
        get () { return undefined },
        get data (): JSONType { throw new Error('decrypt failed') }
      } as unknown as ParsedEncryptedOrUnencryptedMessage<JSONType> & { etag: string | null }
    }
    await sbp('chelonia/kv/_handleRemote', c, 'preserveErrDecode', fakeParsed({ x: 1 }), 'e-remote')

    assert.strictEqual(getCalls, 1)
    assert.strictEqual(sbp('chelonia/kv/status', c, 'preserveErrDecode'), 'loaded')
    assert.deepStrictEqual(rootState()._kv![c]!.preserveErrDecode.value, { x: 3 })
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'preserveErrDecode'), { x: 3 })
  })

  it('64b: re-validate with a mutating custom schema does not corrupt the mirror', async () => {
    let parseCalls = 0
    const mutatingSchema = {
      parse (v: unknown): { x: number; seen: boolean } {
        if (v === null || v === undefined || typeof v !== 'object') {
          throw new Error('mutating schema rejected')
        }
        parseCalls++
        ;(v as { seen?: boolean }).seen = true
        return v as { x: number; seen: boolean }
      }
    }
    sbp('chelonia/kv/defineSlot', {
      key: 'mut', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65b'
    await setupContract(c)

    // Seed a loaded mirror value via a remote frame.
    await sbp('chelonia/kv/_handleRemote', c, 'mut', fakeParsed({ x: 7 }), 'e-seed')
    const seededEntry = rootState()._kv![c]!.mut
    const seededValue = seededEntry.value
    assert.deepStrictEqual(seededValue, { x: 7 })

    // Re-define with the mutating schema → triggers revalidateMirrorEntry.
    sbp('chelonia/kv/defineSlot', {
      key: 'mut', contractType: CTYPE, defaultValue: { x: 0 }, schema: mutatingSchema
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(parseCalls > 0)
    // The original mirror object the schema would have mutated in place
    // must be untouched — the parse ran against a clone.
    assert.strictEqual((seededValue as { seen?: boolean }).seen, undefined)
    assert.deepStrictEqual(seededValue, { x: 7 })
    // The coerced value reached the mirror through reactiveSet/the lane.
    assert.deepStrictEqual(rootState()._kv![c]!.mut.value, { x: 7, seen: true })
  })

  it('64c: aggregate sync logs per-slot load failures', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'aggFail', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65c'
    await setupContract(c)

    stubGet = async () => { throw new Error('agg load down') }
    const errs: unknown[][] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { errs.push(args) }
    try {
      // Aggregate form (no key) must resolve even though the load fails.
      await sbp('chelonia/kv/sync', c)
    } finally {
      console.error = origError
    }
    assert.ok(errs.some((a) => String(a[0]).includes('aggregate sync')))
  })

  it('64d: clear conflict exhaustion reports server currentData', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clearConflict', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65d'
    await setupContract(c)

    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!({ currentData: { x: 42 }, etag: 'e-server' })
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value', {
        cause: { currentData: { x: 42 }, etag: 'e-server' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/clear', c, 'clearConflict'),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        // currentData now reflects the server's observed state, not the
        // hardcoded clear write value (null).
        assert.deepStrictEqual(e.cause, { currentData: { x: 42 }, etag: 'e-server' })
        return true
      }
    )
  })

  it('64e: clear conflict exhaustion falls back to null without server data', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clearNoData', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65e'
    await setupContract(c)

    stubSet = async () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value', {
        cause: { etag: 'e-final' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/clear', c, 'clearNoData'),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        assert.deepStrictEqual(e.cause, { currentData: null, etag: 'e-final' })
        return true
      }
    )
  })

  it('64f: clear survives a conflict whose server currentData fails to decode', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clrDecode', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65f'
    await setupContract(c)

    const decodeErr = new Error('decode boom on clear')
    let returnedFromConflict: [JSONType, string] | false | undefined
    let setCalls = 0
    stubSet = async (_cID, _key, _data, opts) => {
      setCalls++
      if (setCalls === 1) {
        // Server returns a 409 whose `currentData` getter throws on
        // decode. The clear onconflict must swallow it and still write
        // `null` (the clear sentinel).
        returnedFromConflict = await opts.onconflict!(Object.defineProperty(
          { etag: 'e-clr' }, 'currentData', { get () { throw decodeErr }, enumerable: true }
        ) as { currentData?: JSONType; etag?: string | null })
      }
      return { etag: 'after-clear' }
    }

    // Must resolve, not reject.
    await sbp('chelonia/kv/clear', c, 'clrDecode')

    // onconflict produced the clear sentinel with the server etag.
    assert.deepStrictEqual(returnedFromConflict, [null, 'e-clr'])
    // Mirror settled to the canonical 'non-init' shape.
    const entry = rootState()._kv![c]!.clrDecode as { value: unknown; status: string }
    assert.strictEqual(entry.value, undefined)
    assert.strictEqual(entry.status, 'non-init')
    // read() surfaces the deep-cloned default.
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'clrDecode'), { x: 0 })
  })

  it('64g: clear conflict exhaustion with undecodable server data falls back to null', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'clrDecodeExhaust', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-65g'
    await setupContract(c)

    const decodeErr = new Error('decode boom on clear exhaust')
    stubSet = async (_cID, _key, _data, opts) => {
      await opts.onconflict!(Object.defineProperty(
        { etag: 'e-clr' }, 'currentData', { get () { throw decodeErr }, enumerable: true }
      ) as { currentData?: JSONType; etag?: string | null })
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value', {
        cause: { etag: 'e-final' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/clear', c, 'clrDecodeExhaust'),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvConflict)
        // Server data couldn't be captured (getter threw), so currentData
        // falls back to null — clear's intended write value.
        assert.deepStrictEqual(e.cause, { currentData: null, etag: 'e-final' })
        return true
      }
    )
  })

  it('65: CID echo state clears on teardown and reconnect', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'awaitCleanup', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-66'
    await setupContract(c)

    stubSet = async () => ({ etag: 'e-local' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'awaitCleanup', updater: () => ({ x: 1 })
    })
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::awaitCleanup`), true)
    sbp('chelonia/kv/_onReconnect')
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::awaitCleanup`), false)
  })

  it('66: refreshFilters match teardown clears stale echo state', async () => {
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'matchEcho',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => shouldMatch
    })
    const c = 'cid-67'
    await setupContract(c)

    stubSet = async () => ({ etag: 'match-etag' })
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'matchEcho', updater: () => ({ x: 1 })
    })
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::matchEcho`), true)

    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::matchEcho`), false)
  })

  it('67: conflict-path GET failure resolves and demotes markers', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'failSync', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-68'
    await setupContract(c)

    // Seed a pending conflict marker as if a conflict-resolved write
    // committed but its echo is still in flight.
    sbp('chelonia/test/addEchoCID', `${c}::failSync`, 'e-local', true)

    let getCalls = 0
    stubGet = async () => {
      getCalls++
      throw new Error('network down')
    }

    // A non-self frame must NOT throw out of the dispatch path even
    // though the authoritative GET rejects.
    await assert.doesNotReject(
      () => sbp('chelonia/kv/_handleRemote', c, 'failSync', fakeParsed({ x: 1 }), 'e-remote-1')
    )
    assert.strictEqual(getCalls, 1)
    // Marker demoted despite the failure, so a subsequent non-self
    // frame does not trigger another GET (no GET-per-frame loop).
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', `${c}::failSync`, 'e-local'), false
    )
    await assert.doesNotReject(
      () => sbp('chelonia/kv/_handleRemote', c, 'failSync', fakeParsed({ x: 2 }), 'e-remote-2')
    )
    assert.strictEqual(getCalls, 1)
  })

  it('68: contract released mid-GET leaves no orphan _kv record (reject)', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'orphanReject',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      autoLoad: 'never'
    })
    const c = 'cid-69'
    await setupContract(c)

    stubGet = async () => {
      // Simulate _cleanupContractRuntime running (outside the lane)
      // during the GET await — drops the whole _kv[contractID] record.
      sbp('chelonia/kv/_cleanupContractRuntime', c)
      throw new Error('network down')
    }

    await assert.doesNotReject(
      () => sbp('chelonia/kv/_loadSlotNow', {
        contractID: c, slot: { key: 'orphanReject' }, reason: 'load'
      }).catch(() => {})
    )
    // The mirror record must NOT have been resurrected as an empty
    // Object.create(null) by the staleness teardown.
    assert.strictEqual(rootState()._kv?.[c], undefined)
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  it('68b: contract released mid-GET leaves no orphan _kv record (resolve)', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'orphanResolve',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      autoLoad: 'never'
    })
    const c = 'cid-69b'
    await setupContract(c)

    stubGet = async () => {
      sbp('chelonia/kv/_cleanupContractRuntime', c)
      return { ...fakeParsed({ x: 1 }), etag: 'e-late' }
    }

    await sbp('chelonia/kv/_loadSlotNow', {
      contractID: c, slot: { key: 'orphanResolve' }, reason: 'load'
    })
    assert.strictEqual(rootState()._kv?.[c], undefined)
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  it('69: remote frame with empty-string cid forces an authoritative GET', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'emptyCid', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-70'
    await setupContract(c)

    // Seed a known etag via a real-cid frame.
    await sbp('chelonia/kv/_handleRemote', c, 'emptyCid', fakeParsed({ x: 1 }), 'real-cid')
    assert.strictEqual(rootState()._kv![c]!.emptyCid.etag, 'real-cid')

    // An empty-string cid is treated as "no cid": rather than pairing a
    // new value with the stale 'real-cid' etag, it forces an
    // authoritative GET so value + etag are re-paired from the server.
    let getCalled = 0
    stubGet = async () => { getCalled++; return fakeParsed({ x: 2 }) }
    await sbp('chelonia/kv/_handleRemote', c, 'emptyCid', fakeParsed({ x: 9 }), '')
    assert.strictEqual(getCalled, 1, 'empty-cid frame should force an authoritative GET')
    assert.deepStrictEqual(rootState()._kv![c]!.emptyCid.value, { x: 2 })
    assert.strictEqual(rootState()._kv![c]!.emptyCid.etag, 'etag-fake')

    // The GET-paired etag flows through as ifMatch on the next write.
    let ifMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      ifMatch = opts.ifMatch
      return { etag: 'local-cid' }
    }
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'emptyCid', updater: () => ({ x: 3 })
    })
    assert.strictEqual(ifMatch, 'etag-fake')
  })

  it('70: conflict resolution does not emit loaded→loading→loaded', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'noFlicker', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-71'
    await setupContract(c)

    // Drive the slot to 'loaded'.
    await sbp('chelonia/kv/_handleRemote', c, 'noFlicker', fakeParsed({ x: 1 }), 'first-cid')
    assert.strictEqual(rootState()._kv![c]!.noFlicker.status, 'loaded')

    sbp('chelonia/test/addEchoCID', `${c}::noFlicker`, 'e-local', true)
    stubGet = async () => ({ ...fakeParsed({ x: 2 }), etag: 'e-sync' })

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/_handleRemote', c, 'noFlicker', fakeParsed({ x: 9 }), 'e-remote')
    offs.forEach((off) => off())

    const loadingEvents = log.filter((e) =>
      e.type === CHELONIA_KV_STATUS_CHANGED &&
      (e.payload as { status: string }).status === 'loading'
    )
    assert.strictEqual(loadingEvents.length, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.noFlicker.value, { x: 2 })
  })

  it('71: re-dirtying a filter mid-flush sends the latest filter once', async () => {
    const c = 'cid-72'
    sbp('chelonia/kv/defineSlot', {
      key: 'k1', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    await setupContract(c)

    const calls: Array<{ contractID: string; keys: string[] }> = []
    let release: (() => void) | null = null
    let firstStarted: (() => void) | null = null
    const firstStartedP = new Promise<void>((resolve) => { firstStarted = resolve })
    let isFirst = true
    stubSetFilter = (contractID, filter) => {
      calls.push({ contractID, keys: filter ?? [] })
      if (isFirst) {
        isFirst = false
        firstStarted!()
        return new Promise<void>((resolve) => { release = resolve })
      }
      return undefined
    }

    // Kick off the flush; it parks awaiting the gated first setFilter.
    sbp('chelonia/test/dirtyFilter', c)
    const flushP = sbp('chelonia/kv/_flushDirtyFilters')
    await firstStartedP

    // Re-dirty the same contract with a new active filter while the
    // first setFilter is still in flight. This must NOT spawn a second
    // concurrent flush; the single draining loop picks it up.
    sbp('chelonia/test/dirtyFilter', c)
    release!()
    await flushP

    const cCalls = calls.filter((x) => x.contractID === c)
    // Exactly two serialized sends (not interleaved concurrent flushes),
    // and the loop drained the re-dirtied entry within the same flush.
    assert.strictEqual(cCalls.length, 2)
  })

  // -----------------------------------------------------------------------
  // 71b: issue #4 — a transient setFilter failure is retried after a
  // backoff so the server's filter set converges without waiting for the
  // next slot change to re-dirty the contract.
  // -----------------------------------------------------------------------
  it('71b: a transiently failed setFilter flush is retried', async () => {
    const c = 'cid-71b'
    sbp('chelonia/kv/defineSlot', {
      key: 'fk', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    await setupContract(c)

    // Shrink the retry backoff so the deferred re-flush fires promptly.
    sbp('chelonia/kv/_testSetFilterRetryMs', 0)

    const calls: Array<{ contractID: string; keys: string[] }> = []
    let attempt = 0
    stubSetFilter = (contractID, filter) => {
      if (contractID !== c) return
      attempt++
      calls.push({ contractID, keys: filter ?? [] })
      // Fail the first send (transient), succeed on the retry.
      if (attempt === 1) throw new Error('transient setFilter failure')
    }

    sbp('chelonia/test/dirtyFilter', c)
    await sbp('chelonia/kv/_flushDirtyFilters')
    assert.strictEqual(calls.length, 1, 'first flush attempt ran and failed')

    // Let the scheduled (0 ms) retry timer fire and re-flush.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.strictEqual(calls.length, 2, 'the failed flush is retried after backoff')
    assert.deepStrictEqual(calls[1].keys, calls[0].keys,
      'the retry re-sends the same cached active filter as the failed attempt')
    assert.ok(calls[1].keys.includes('fk'),
      'the cached active filter includes this slot key')
    assert.strictEqual(sbp('chelonia/test/filterRetrySize', c), 0,
      'the retry set is drained after a successful re-flush')
    sbp('chelonia/kv/_testSetFilterRetryMs')
  })

  // -----------------------------------------------------------------------
  // 71c: chelonia/reset cancels the pending filter-retry timer so the
  // closure pinning ctx is released immediately rather than waiting for
  // the timer to fire (harmlessly) against the now-empty retry set.
  // -----------------------------------------------------------------------
  it('71c: reset cancels the pending filter-retry timer', async () => {
    const c = 'cid-71c'
    sbp('chelonia/kv/defineSlot', {
      key: 'fk', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    await setupContract(c)

    // Use a large backoff so the timer stays pending across the reset.
    sbp('chelonia/kv/_testSetFilterRetryMs', 60000)

    stubSetFilter = () => {
      throw new Error('transient setFilter failure')
    }

    sbp('chelonia/test/dirtyFilter', c)
    await sbp('chelonia/kv/_flushDirtyFilters')
    assert.ok(sbp('chelonia/test/filterRetryTimerPending'),
      'a retry timer should be pending after a transient setFilter failure')

    await sbp('chelonia/reset')
    assert.ok(!sbp('chelonia/test/filterRetryTimerPending'),
      'reset must cancel the pending filter-retry timer')
    assert.strictEqual(sbp('chelonia/test/filterRetrySize'), 0,
      'reset must clear the retry set')

    // After reset, no deferred flush should fire (the timer was canceled).
    stubSetFilterCalls.length = 0
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepStrictEqual(stubSetFilterCalls, [],
      'no setFilter call should occur after reset canceled the timer')
    sbp('chelonia/kv/_testSetFilterRetryMs')
  })

  it('72: release+re-sync mid-GET writes the fetched value to the live mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'reSync',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      autoLoad: 'never'
    })
    const c = 'cid-73'
    await setupContract(c)

    // Capture the registry-current slot so slotReplacedOrReleased() is
    // false after re-sync (reconcile re-indexes this same object).
    const slot = sbp('chelonia/test/activeSlot', c, 'reSync')

    stubGet = async () => {
      // Release the contract (drops the original _kv[c] record) and
      // immediately re-sync just this slot (reconcile re-seeds a fresh
      // _kv[c] record and re-indexes the SAME surviving slot object) —
      // all while the GET is in flight. Reconciling only this slot
      // avoids re-triggering every other CTYPE slot's on-sync load. The
      // slot-identity guard does not bail because the slot object is
      // unchanged, so the success path must target the LIVE mirror
      // entry, not the detached pre-await capture.
      sbp('chelonia/kv/_cleanupContractRuntime', c)
      sbp('chelonia/kv/_reconcileForSlot', slot, c)
      return { ...fakeParsed({ x: 7 }), etag: 'e-late' }
    }

    await sbp('chelonia/kv/_loadSlotNow', { contractID: c, slot, reason: 'load' })

    // The live mirror entry must carry BOTH the fetched value and the
    // 'loaded' status (the bug stamped 'loaded' with value: undefined).
    assert.deepStrictEqual(rootState()._kv![c]!.reSync.value, { x: 7 })
    assert.strictEqual(rootState()._kv![c]!.reSync.etag, 'e-late')
    assert.strictEqual(rootState()._kv![c]!.reSync.status, 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'reSync'), { x: 7 })
    sbp('chelonia/kv/_assertIndexConsistent')
  })

  it('73: re-validation of an unchanged value does not re-fire update/onUpdate', async () => {
    let onUpdateCalls = 0
    sbp('chelonia/kv/defineSlot', {
      key: 'reval',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: () => { onUpdateCalls++ }
    })
    const c = 'cid-74'
    await setupContract(c)

    // Drive the slot to a loaded value via a remote frame.
    await sbp('chelonia/kv/_handleRemote', c, 'reval', fakeParsed({ x: 5 }), 'cid-a')
    assert.strictEqual(rootState()._kv![c]!.reval.status, 'loaded')
    const callsAfterLoad = onUpdateCalls

    // Re-defining the same idempotent slot re-validates the persisted
    // entry. Since the re-parsed value is unchanged, no CHELONIA_KV_UPDATED
    // event should fire and onUpdate must not run again.
    const { log, offs } = collectEvents()
    sbp('chelonia/kv/defineSlot', {
      key: 'reval',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: () => { onUpdateCalls++ }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    offs.forEach((off) => off())

    assert.strictEqual(
      log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0,
      'unchanged re-validation must not emit CHELONIA_KV_UPDATED'
    )
    assert.strictEqual(onUpdateCalls, callsAfterLoad, 'onUpdate must not re-fire')
    // Status stays loaded and the value is intact.
    assert.strictEqual(rootState()._kv![c]!.reval.status, 'loaded')
    assert.deepStrictEqual(rootState()._kv![c]!.reval.value, { x: 5 })
  })

  it('73b: re-validation with a normalizing schema that changes the value still emits', async () => {
    let onUpdateCalls = 0
    const lastValues: unknown[] = []
    // Seed a stored value that lacks the `tag` field the normalizing
    // schema derives, using a plain (schemaless) slot so the stored
    // value round-trips untouched.
    sbp('chelonia/kv/defineSlot', {
      key: 'coerce', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-74b'
    await setupContract(c)
    await sbp('chelonia/kv/_handleRemote', c, 'coerce', fakeParsed({ x: 5 }), 'cid-a')
    assert.deepStrictEqual(rootState()._kv![c]!.coerce.value, { x: 5 })

    // An idempotent normalizing schema: it derives `tag` from `x`.
    // parse(parse(v)) is stable (idempotent — satisfies the registration
    // guard), but re-validating the previously stored `{ x: 5 }` adds the
    // derived field, so the value genuinely changes.
    const normalizingSchema = {
      parse (v: unknown) {
        const obj = v as { x: number }
        return { x: obj.x, tag: `x=${obj.x}` }
      }
    }
    const { log, offs } = collectEvents()
    sbp('chelonia/kv/defineSlot', {
      key: 'coerce',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: normalizingSchema,
      onUpdate: (value: unknown) => { onUpdateCalls++; lastValues.push(value) }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    offs.forEach((off) => off())

    assert.strictEqual(
      log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1,
      'a genuinely changed re-validation must emit exactly one update'
    )
    assert.strictEqual(onUpdateCalls, 1)
    assert.deepStrictEqual(lastValues[0], { x: 5, tag: 'x=5' })
    assert.deepStrictEqual(rootState()._kv![c]!.coerce.value, { x: 5, tag: 'x=5' })
  })

  it('74c: coercing re-validation is lane-routed and never clobbers an in-flight write', async () => {
    // The actual #1 scenario: an `update` holds the per-contract lane
    // (its `kv/set` is awaiting the server) while `defineSlot` replaces
    // the slot with a coercing schema. The re-validation must run BEHIND
    // the in-flight write on the same lane and bail when the live mirror
    // has already advanced past the value it re-parsed — so it never
    // clobbers the committed write nor diverges the mirror from the
    // server.
    sbp('chelonia/kv/defineSlot', {
      key: 'lane', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-74c'
    await setupContract(c)
    await sbp('chelonia/kv/_handleRemote', c, 'lane', fakeParsed({ x: 5 }), 'cid-seed')
    assert.deepStrictEqual(rootState()._kv![c]!.lane.value, { x: 5 })

    // Gate the write so it holds the lane while we replace the slot.
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve })
    stubSet = async () => {
      await setGate
      return { etag: 'committed-etag' }
    }
    // The server now holds the committed { x: 6 }; the queued reload the
    // replacement schedules must converge on it.
    stubGet = async () => ({ ...fakeParsed({ x: 6 }), etag: 'committed-etag' })
    const updateP = sbp('chelonia/kv/update', {
      contractID: c, key: 'lane', updater: () => ({ x: 6 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const normalizingSchema = {
      parse (v: unknown) {
        const obj = v as { x: number }
        return { x: obj.x, tag: `x=${obj.x}` }
      }
    }
    const { offs } = collectEvents()
    // Replace the slot mid-write: this enqueues a reload on the same
    // lane, behind the in-flight update, instead of re-validating the
    // stale mirror.
    sbp('chelonia/kv/defineSlot', {
      key: 'lane', contractType: CTYPE, defaultValue: { x: 0 }, schema: normalizingSchema
    })

    releaseSet()
    await updateP
    // Drain the lane so the queued reload runs.
    await sbp('chelonia/queueInvocation', c, () => {})
    offs.forEach((off) => off())

    // The reload converged on the committed { x: 6 } (coerced by the new
    // schema), never re-seeding the stale pre-write { x: 5 }.
    assert.deepStrictEqual(rootState()._kv![c]!.lane.value, { x: 6, tag: 'x=6' })
  })

  // -----------------------------------------------------------------------
  // Event/onUpdate payloads must be detached clones, not live mirror refs
  // -----------------------------------------------------------------------
  it('70a: mutating CHELONIA_KV_UPDATED value (load) cannot corrupt mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cloneLoad', contractType: CTYPE, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-70a'
    await setupContract(c)
    stubGet = async () => ({ ...fakeParsed({ x: 1, nested: { a: 1 } }), etag: 'e1' })

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, (payload: unknown) => {
      const v = (payload as { value: { x: number; nested: { a: number } } }).value
      v.x = 999
      v.nested.a = 999
    })
    try {
      await sbp('chelonia/kv/sync', c, 'cloneLoad')
    } finally {
      off()
    }
    assert.deepStrictEqual(rootState()._kv![c]!.cloneLoad.value, { x: 1, nested: { a: 1 } })
    assert.deepStrictEqual(sbp('chelonia/kv/read', c, 'cloneLoad'), { x: 1, nested: { a: 1 } })
  })

  it('70b: mutating CHELONIA_KV_UPDATED value (remote) cannot corrupt mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cloneRemote', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-70b'
    await setupContract(c)

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, (payload: unknown) => {
      const v = (payload as { value: { x: number } }).value
      if (v) v.x = 999
    })
    try {
      await sbp('chelonia/kv/_handleRemote', c, 'cloneRemote', fakeParsed({ x: 2 }), 'e-remote')
    } finally {
      off()
    }
    assert.deepStrictEqual(rootState()._kv![c]!.cloneRemote.value, { x: 2 })
  })

  it('70c: mutating CHELONIA_KV_UPDATED value (update) cannot corrupt mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cloneUpdate', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-70c'
    await setupContract(c)
    stubSet = async () => ({ etag: 'e-up' })

    const off = sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, (payload: unknown) => {
      const v = (payload as { value: { x: number } }).value
      if (v) v.x = 999
    })
    try {
      await sbp('chelonia/kv/update', {
        contractID: c, key: 'cloneUpdate', updater: () => ({ x: 3 })
      })
    } finally {
      off()
    }
    assert.deepStrictEqual(rootState()._kv![c]!.cloneUpdate.value, { x: 3 })
  })

  it('70d: mutating onUpdate value (update) cannot corrupt mirror', async () => {
    let onUpdateRan = false
    sbp('chelonia/kv/defineSlot', {
      key: 'cloneCb',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: (value: unknown) => {
        const v = value as { x: number } | undefined
        if (v) v.x = 999
        onUpdateRan = true
      }
    })
    const c = 'cid-70d'
    await setupContract(c)
    stubSet = async () => ({ etag: 'e-cb' })

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'cloneCb', updater: () => ({ x: 4 })
    })
    assert.strictEqual(onUpdateRan, true)
    assert.deepStrictEqual(rootState()._kv![c]!.cloneCb.value, { x: 4 })
  })

  // -----------------------------------------------------------------------
  // 75: issue #1 — a mutating reducer on the conflict-retry path must not
  // corrupt the server's cached decode reported in the exhaustion cause.
  // -----------------------------------------------------------------------
  it('75: conflict-retry reducer mutation does not corrupt reported currentData', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cm', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-75'
    await setupContract(c)

    // Stable server value object reused across every onconflict call,
    // exactly as kv/set's cached `currentValue.data` getter would return.
    const serverValue = { x: 100 }
    stubSet = async (_cID, _key, _data, opts) => {
      if (opts.onconflict) {
        // Reducer mutates `prev` in place (contract violation) and the
        // write keeps conflicting → exhaustion.
        await opts.onconflict({ currentData: serverValue, etag: 'srv' })
      }
      throw new ChelErrorKvMaxAttempts('exhausted', {
        cause: { currentData: serverValue, etag: 'srv' }
      })
    }

    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c,
        key: 'cm',
        maxAttempts: 1,
        updater: (prev: JSONType) => {
          ;(prev as { x: number }).x = -1
          return prev
        }
      }),
      (e: unknown) => e instanceof ChelErrorKvConflict
    )
    // The shared server value must be untouched by the mutating reducer.
    assert.deepStrictEqual(serverValue, { x: 100 })
  })

  // -----------------------------------------------------------------------
  // 76: issue #2 — _handleRemote must not alias a shared decoded value, so
  // an external mutation of `parsed.data` cannot corrupt the mirror.
  // -----------------------------------------------------------------------
  it('76: _handleRemote clones decoded value so shared parsed cannot corrupt mirror', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'shared', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-76'
    await setupContract(c)

    const shared = { x: 7 }
    const parsed = fakeParsed(shared as unknown as JSONType)
    await sbp('chelonia/kv/_handleRemote', c, 'shared', parsed, 'cid-remote-76')
    assert.deepStrictEqual(rootState()._kv![c]!.shared.value, { x: 7 })

    // Simulate the shared raw-handler retaining and mutating parsed.data.
    shared.x = 999
    assert.deepStrictEqual(
      rootState()._kv![c]!.shared.value, { x: 7 },
      'mirror must not alias the shared parsed object'
    )
  })

  // -----------------------------------------------------------------------
  // 77: issue #3 — updating a slot stuck in 'error' (with a retained value
  // + etag) forces an authoritative reload so a default-seeded write cannot
  // silently overwrite live server data.
  // -----------------------------------------------------------------------
  it('77: update on error status reloads before seeding to avoid overwrite', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rl', contractType: CTYPE, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-77'
    await setupContract(c)

    // Slot is in 'error' but retains a stale value + etag.
    const entry = rootState()._kv![c]!.rl as {
      value: unknown; etag: string | null; status: string
    }
    entry.value = { x: 5 }
    entry.etag = 'stale-etag'
    entry.status = 'error'

    // The authoritative reload returns the live server value + etag.
    let getCount = 0
    stubGet = async () => {
      getCount++
      return { ...fakeParsed({ x: 42 }), etag: 'live-etag' }
    }

    let seenSeed: unknown
    let capturedIfMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      capturedIfMatch = opts.ifMatch
      return { etag: 'written' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'rl',
      updater: (prev: JSONType) => {
        seenSeed = prev
        return { x: (prev as { x: number }).x + 1 }
      }
    })

    assert.strictEqual(getCount, 1, 'authoritative reload should run once')
    // Reducer seeds from the live server value (42), not the default (0).
    assert.deepStrictEqual(seenSeed, { x: 42 })
    assert.deepStrictEqual(result, { x: 43 })
    // The write guards against the refreshed etag, not the stale one.
    assert.strictEqual(capturedIfMatch, 'live-etag')
  })

  // -----------------------------------------------------------------------
  // 77b: issue #3 — the data-loss-guard reload inside `update` must NOT
  // fire CHELONIA_KV_UPDATED / onUpdate with reason 'load'. A single
  // `update` call should produce only one event (reason 'local') after the
  // write commits, not a 'load' + 'local' pair that double-triggers
  // non-idempotent onUpdate handlers.
  // -----------------------------------------------------------------------
  it('77b: update on error slot fires only local event (silent reload)', async () => {
    const onUpdateCalls: Array<{ reason?: string; value?: unknown }> = []
    sbp('chelonia/kv/defineSlot', {
      key: 'silentReload',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: (value: unknown, ctx: { reason?: string }) => {
        onUpdateCalls.push({ reason: ctx.reason, value })
      }
    })
    const c = 'cid-77b'
    await setupContract(c)
    // Seed a loaded mirror value + etag, then force into 'error' (the
    // data-loss-guard precondition).
    await sbp('chelonia/kv/_handleRemote', c, 'silentReload', fakeParsed({ x: 5 }), 'e-seed')
    const entry = rootState()._kv![c]!.silentReload as { status: string }
    entry.status = 'error'

    // The authoritative reload GETs the server value.
    stubGet = async () => fakeParsed({ x: 5 })

    const { log, offs } = collectEvents()
    // Reset the onUpdate log so only calls from the `update` below are counted.
    onUpdateCalls.length = 0
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'silentReload', updater: (prev: { x: number }) => ({ x: prev.x + 1 })
    })

    const updatedEvents = log.filter((e) => e.type === CHELONIA_KV_UPDATED) as
      Array<{ payload: { reason?: string } }>
    const loadEvents = updatedEvents.filter((e) => e.payload.reason === 'load')
    const localEvents = updatedEvents.filter((e) => e.payload.reason === 'local')

    assert.strictEqual(loadEvents.length, 0, 'no load event from the silent data-loss-guard reload')
    assert.strictEqual(localEvents.length, 1, 'exactly one local event from the write')
    assert.strictEqual(onUpdateCalls.length, 1, 'onUpdate called once (local only)')
    assert.strictEqual(onUpdateCalls[0].reason, 'local')
    assert.deepStrictEqual(rootState()._kv![c]!.silentReload.value, { x: 6 })
    assert.strictEqual(sbp('chelonia/kv/status', c, 'silentReload'), 'loaded')
    // Issue #2: the silent reload must not surface its internal status
    // churn. A single `update` from an 'error' baseline previously leaked
    // `error → loading → loaded` STATUS_CHANGED events; now the only
    // status event is the terminal `loaded` the write itself emits.
    const statusEvents = log.filter((e) => e.type === CHELONIA_KV_STATUS_CHANGED) as
      Array<{ payload: { status: string } }>
    assert.strictEqual(
      statusEvents.filter((e) => e.payload.status === 'loading').length, 0,
      'no transient loading status event from the silent reload')
    assert.deepStrictEqual(
      statusEvents.map((e) => e.payload.status), ['loaded'],
      'the only status event from a silent-reload update is the terminal loaded')
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 77c: issue #3 edge case — the data-loss-guard reload returns 404 (server
  // value was cleared while the slot was in 'error'). The silent flag must
  // suppress the 404 path's UPDATED + onUpdate too, not just the success
  // path's. The write then seeds from the default.
  // -----------------------------------------------------------------------
  it('77c: silent 404 reload suppresses UPDATED; write seeds from default', async () => {
    const onUpdateCalls: Array<{ reason?: string; value?: unknown }> = []
    sbp('chelonia/kv/defineSlot', {
      key: 'silent404',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: objectSchema,
      onUpdate: (value: unknown, ctx: { reason?: string }) => {
        onUpdateCalls.push({ reason: ctx.reason, value })
      }
    })
    const c = 'cid-77c'
    await setupContract(c)
    // Seed a loaded mirror, then force into 'error' (data-loss-guard
    // precondition: retained value + etag with status 'error').
    await sbp('chelonia/kv/_handleRemote', c, 'silent404', fakeParsed({ x: 5 }), 'e-seed')
    const entry = rootState()._kv![c]!.silent404 as { status: string }
    entry.status = 'error'

    // The reload GETs 404 (server value was cleared).
    stubGet = async () => null

    const { log, offs } = collectEvents()
    onUpdateCalls.length = 0
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'silent404', updater: (prev: { x: number }) => ({ x: prev.x + 1 })
    })

    const updatedEvents = log.filter((e) => e.type === CHELONIA_KV_UPDATED) as
      Array<{ payload: { reason?: string } }>
    const loadEvents = updatedEvents.filter((e) => e.payload.reason === 'load')

    assert.strictEqual(loadEvents.length, 0, 'no load event from the silent 404 reload')
    assert.strictEqual(onUpdateCalls.length, 1, 'onUpdate called once (local only)')
    assert.strictEqual(onUpdateCalls[0].reason, 'local')
    // Reducer seeded from the default ({x:0}), so result is {x:1}.
    assert.deepStrictEqual(rootState()._kv![c]!.silent404.value, { x: 1 })
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 78: issue #5 — when the last slot for a contract goes match:false, the
  // emptied _kv[contractID] record must not linger.
  // -----------------------------------------------------------------------
  it('78: emptied _kv[contractID] record removed when last slot deactivates', async () => {
    const contractType = 'type-78-isolated'
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'only',
      contractType,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => shouldMatch
    })
    const c = 'cid-78'
    await setupContract(c, contractType)
    assert.ok(rootState()._kv?.[c]?.only, 'slot seeded')

    shouldMatch = false
    sbp('chelonia/kv/refreshFilters')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.strictEqual(
      rootState()._kv?.[c], undefined,
      'emptied per-contract record should be removed, not left as {}'
    )
  })

  // -----------------------------------------------------------------------
  // 89: issue #1 — when reconcile drops a mirror entry (match→false) while
  // a `_loadSlot` is queued behind other lane work, the deferred
  // `_loadSlotNow` must NOT re-create an orphaned empty `_kv[contractID]`
  // record via `ensureContractKv`. The non-destructive existence check
  // (matching `setSlotStatus`'s pattern) bails before the destructive call.
  // -----------------------------------------------------------------------
  it('89: _loadSlotNow does not re-create an orphaned empty _kv record', async () => {
    const savedQI = stubQueueInvocation
    const contractType = 'type-89-isolated'
    let shouldMatch = true
    sbp('chelonia/kv/defineSlot', {
      key: 'orph',
      contractType,
      defaultValue: { x: 0 },
      schema: objectSchema,
      match: () => shouldMatch
    })

    // Defer the `_loadSlot` lane callback so we can flip match→false before
    // it runs, exactly as if the queue were occupied by other work.
    const deferredQueue: Array<{ fn: () => unknown; resolve: (v: unknown) => void }> = []
    stubQueueInvocation = (_cID, fn) => {
      return new Promise((resolve) => {
        deferredQueue.push({ fn: fn as () => unknown, resolve })
      })
    }

    try {
      const c = 'cid-89'
      // Set up the contract manually to control timing precisely.
      const s = rootState()
      ;(s as { contracts?: unknown }).contracts = Object.create(null)
      ;(s.contracts as Record<string, unknown>)[c] = {
        HEAD: '', height: 0, type: contractType
      }
      sbp('chelonia/test/addSubscription', c)

      // Trigger reconcile(match=true): seeds the mirror entry and schedules
      // a deferred _loadSlot behind our captured queue.
      sbp('chelonia/kv/_onContractsModified', { added: [c], removed: [] })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.ok(rootState()._kv?.[c]?.orph, 'mirror entry should be seeded')
      const loadDeferred = deferredQueue.splice(0)
      assert.ok(loadDeferred.length > 0, 'a _loadSlot should have been queued')

      // Flip match→false and reconcile synchronously. This deletes the
      // mirror entry AND the now-empty `_kv[c]` record (issue #5 path).
      shouldMatch = false
      sbp('chelonia/kv/refreshFilters', c)
      assert.strictEqual(
        rootState()._kv?.[c], undefined,
        'reconcile should have removed the emptied _kv[c] record'
      )

      // Flush the deferred _loadSlotNow. Before the fix this re-created
      // an orphaned empty `{}` record via `ensureContractKv`; after the
      // fix the non-destructive read bails out cleanly.
      stubQueueInvocation = savedQI
      for (const item of loadDeferred) {
        item.resolve(runQueued(item.fn))
      }
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.strictEqual(
        rootState()._kv?.[c], undefined,
        'deferred _loadSlotNow must not re-create an orphaned empty _kv[c] record'
      )
    } finally {
      stubQueueInvocation = savedQI
    }
  })

  // -----------------------------------------------------------------------
  // 79: issue #6 — echo-CID eviction prefers non-conflict entries so a
  // fromConflict marker survives the per-bucket cap even when it has the
  // earliest expiry (which a pure expiry policy would evict first).
  // -----------------------------------------------------------------------
  it('79: echo-CID eviction keeps fromConflict markers over plain entries', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'evc', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-79'
    await setupContract(c)
    const echoKey = `${c}::evc`

    // Controllable clock so the first (conflict) write gets the earliest
    // expiry and later writes get strictly greater expiries.
    let clock = 1000
    sbp('chelonia/kv/_testSetNowMs', () => clock)

    const cids: string[] = []
    let writeNo = 0
    stubSet = async (_cID, _key, _data, opts) => {
      writeNo++
      // First write conflicts → recorded as a fromConflict marker.
      if (writeNo === 1 && opts.onconflict) {
        await opts.onconflict({ currentData: { x: 0 }, etag: 'srv' })
      }
      const etag = `e-${writeNo}`
      cids.push(etag)
      return { etag }
    }

    // Conflict write at the earliest time.
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'evc', updater: (p: JSONType) => ({ x: (p as { x: number }).x + 1 })
    })
    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', echoKey, cids[0]), true,
      'first write recorded as conflict marker'
    )

    // Fill the bucket past the cap with later-expiry non-conflict writes.
    for (let i = 0; i < KV_ECHO_CID_MAX; i++) {
      clock += 10
      await sbp('chelonia/kv/update', {
        contractID: c, key: 'evc', updater: (p: JSONType) => ({ x: (p as { x: number }).x + 1 })
      })
    }

    assert.strictEqual(
      sbp('chelonia/test/echoCIDFromConflict', echoKey, cids[0]), true,
      'conflict marker must survive eviction despite earliest expiry'
    )
  })

  // -----------------------------------------------------------------------
  // 80: issue #4 — when a write holds the lane, revalidateMirrorEntry must
  // defer its 'loaded' status flip into the lane (behind the in-flight op)
  // instead of firing it synchronously and interleaving a misleading
  // status transition.
  // -----------------------------------------------------------------------
  it('80: revalidate defers status flip when a write is in flight', async () => {
    const contractType = 'type-80-isolated'
    sbp('chelonia/kv/defineSlot', {
      key: 'def', contractType, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-80'
    await setupContract(c, contractType)
    // Seed a loaded value so revalidate has a non-undefined value to act on.
    await sbp('chelonia/kv/_handleRemote', c, 'def', fakeParsed({ x: 5 }), 'cid-seed-80')

    // Force the slot into 'error' so a deferred flip to 'loaded' is
    // observable, and simulate an in-flight write via the pending counter
    // (the exact signal revalidateMirrorEntry checks).
    const entry = rootState()._kv![c]!.def as { status: string }
    entry.status = 'error'

    const deferred: Array<() => unknown> = []
    stubQueueInvocation = (_cID, fn) => {
      // Capture the lane callback instead of running it immediately, so we
      // can assert the synchronous status BEFORE the deferred flip runs.
      deferred.push(() => runQueued(fn))
      return Promise.resolve()
    }
    // Mark a write in flight for this contract.
    sbp('chelonia/test/incPending', c)

    // Replace the slot → revalidateMirrorEntry runs with a pending write.
    // The status flip must be deferred (queued), not synchronous.
    sbp('chelonia/kv/defineSlot', {
      key: 'def', contractType, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    assert.strictEqual(
      rootState()._kv![c]!.def.status, 'error',
      'status flip must be deferred while a write holds the lane'
    )
    assert.ok(deferred.length > 0, 'a lane callback should have been queued')

    // Drain the captured lane callback(s); the deferred flip now applies.
    sbp('chelonia/test/decPending', c)
    for (const run of deferred) run()
    assert.strictEqual(
      rootState()._kv![c]!.def.status, 'loaded',
      'deferred status flip applies once the lane runs'
    )
  })

  // -----------------------------------------------------------------------
  // 73c: issue #2 — a coercing schema applied via `revalidateMirrorEntry`
  // must coerce the value INLINE for contracts NOT in subscriptionSet
  // (persisted mirror entries from a prior session). The lane-routed path's
  // slot-identity guard would bail for non-indexed contracts and silently
  // drop the coercion; the inline branch applies it directly.
  // -----------------------------------------------------------------------
  it('73c: coercing re-validation applies inline for non-subscribed contracts', async () => {
    // Idempotent normalizing schema: derives a `tag` field from `x`.
    // parse(parse(v)) is stable (satisfies the registration guard), but
    // re-validating the stored `{ x: 1 }` adds the derived field so the
    // value genuinely changes.
    const normalizingSchema = {
      parse (v: unknown) {
        const obj = v as { x: number }
        if (typeof obj.x !== 'number') throw new Error('x must be a number')
        return { x: obj.x, tag: `x=${obj.x}` }
      }
    }

    // Seed a persisted mirror entry for a NON-subscribed contract (e.g. a
    // contract not yet re-synced after a reload). The plain schemaless slot
    // stores the value untouched.
    const s = rootState()
    const c = 'cid-73c-nonsub'
    reactiveSet(s, '_kv', Object.create(null))
    reactiveSet(s._kv!, c, Object.create(null))
    reactiveSet(s._kv![c]!, 'cslot', {
      value: { x: 1 }, etag: 'old-etag', status: 'loaded'
    })
    reactiveSet(s, 'contracts', Object.create(null))
    ;(s.contracts as Record<string, unknown>)[c] = {
      HEAD: '', height: 0, type: CTYPE
    }
    // NOT added to subscriptionSet — simulates a pre-sync persisted entry.

    const { log, offs } = collectEvents()
    sbp('chelonia/kv/defineSlot', {
      key: 'cslot',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      schema: normalizingSchema
    })

    // The coercion must apply INLINE (synchronous) for a non-indexed
    // contract, not be dropped by the lane callback's slot-identity guard.
    assert.deepStrictEqual(
      rootState()._kv?.[c]?.cslot?.value,
      { x: 1, tag: 'x=1' },
      'coercing schema should apply inline for non-subscribed contracts'
    )
    assert.strictEqual(
      rootState()._kv?.[c]?.cslot?.status, 'loaded',
      'status should be loaded after successful re-validation'
    )
    assert.ok(
      log.some((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'load'
      ),
      'CHELONIA_KV_UPDATED should fire for the coerced value'
    )
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 73d: issue #5 — for an indexed contract with a coercing schema and no
  // in-flight write, revalidateMirrorEntry must NOT flip status to 'loaded'
  // synchronously while deferring the coerced value through the lane. That
  // would open a window where read() (keyed on status !== 'error') returns
  // the pre-coercion value. The fix defers both through the same lane
  // callback so they move atomically.
  // -----------------------------------------------------------------------
  it('73d: coercing re-validate defers status flip alongside value for indexed contracts', async () => {
    // Coercing schema: derives a `tag` field from `x`. parse(parse(v)) is
    // stable (satisfies the registration guard), but re-validating {x:7}
    // genuinely transforms it to {x:7,tag:'x=7'}.
    const coercingSchema = {
      parse (v: unknown) {
        const obj = v as { x: number }
        if (typeof obj?.x !== 'number') throw new Error('x must be a number')
        return { x: obj.x, tag: `x=${obj.x}` }
      }
    }
    sbp('chelonia/kv/defineSlot', {
      key: 'coerceIdx', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-73d'
    await setupContract(c)
    // Seed {x:7}; re-validation will coerce to {x:7,tag:'x=7'}.
    await sbp('chelonia/kv/_handleRemote', c, 'coerceIdx', fakeParsed({ x: 7 }), 'e-seed')

    // Force the slot into 'error' so the revalidation has a real status flip
    // to perform — this is where the mismatch window was observable (status
    // would flip to 'loaded' synchronously while the value coercion was
    // deferred through the lane).
    const entry = rootState()._kv![c]!.coerceIdx as { status: string }
    entry.status = 'error'

    // Capture (do NOT run) the lane callback so we can observe the window
    // between revalidateMirrorEntry's synchronous portion and the deferred
    // lane work.
    const deferred: Array<() => unknown> = []
    stubQueueInvocation = (_cID, fn) => {
      deferred.push(() => runQueued(fn))
      return Promise.resolve()
    }

    sbp('chelonia/kv/defineSlot', {
      key: 'coerceIdx', contractType: CTYPE, defaultValue: { x: 0 }, schema: coercingSchema
    })

    // Before the lane drains: status must still be 'error' (not flipped
    // synchronously), so read() returns the default — consistent with the
    // not-yet-coerced mirror. The fix defers both status + value to the lane.
    const statusBeforeLane = sbp('chelonia/kv/status', c, 'coerceIdx')
    const readBeforeLane = sbp('chelonia/kv/read', c, 'coerceIdx')
    assert.strictEqual(
      statusBeforeLane, 'error',
      'status must NOT flip synchronously when the value coercion is deferred'
    )
    assert.deepStrictEqual(
      readBeforeLane, { x: 0, tag: 'x=0' },
      'read() returns the (coerced) default while status is still error (pre-coercion)'
    )

    // Drain the deferred lane callback: status + coerced value land together.
    for (const run of deferred) run()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.strictEqual(sbp('chelonia/kv/status', c, 'coerceIdx'), 'loaded')
    assert.deepStrictEqual(
      sbp('chelonia/kv/read', c, 'coerceIdx'),
      { x: 7, tag: 'x=7' },
      'coerced value must reach read() after the lane drains'
    )
  })

  // -----------------------------------------------------------------------
  // 73e: issue #1 — error-recovery re-validation with a structurally
  // unchanged value must STILL fire CHELONIA_KV_UPDATED with reason 'load'
  // so listeners observing transitions out of 'error' can react. The
  // boot-idempotent case (status already 'loaded') stays suppressed.
  // (KV-REVAMPED.md §4.1 lines 536-540)
  // -----------------------------------------------------------------------
  it('73e: re-validate unchanged value recovering from error fires UPDATED', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'recoverErr', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-73e'
    await setupContract(c)
    await sbp('chelonia/kv/_handleRemote', c, 'recoverErr', fakeParsed({ x: 5 }), 'e-seed')
    assert.strictEqual(sbp('chelonia/kv/status', c, 'recoverErr'), 'loaded')

    // Force into 'error' (simulating a prior validation failure).
    const entry = rootState()._kv![c]!.recoverErr as { status: string }
    entry.status = 'error'

    const { log, offs } = collectEvents()
    // Re-define with the SAME schema → revalidateMirrorEntry runs; value
    // {x:5} is structurally identical so changed === false, but the slot
    // is recovering from 'error'.
    sbp('chelonia/kv/defineSlot', {
      key: 'recoverErr', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const updatedEvents = log.filter((e) => e.type === CHELONIA_KV_UPDATED) as
      Array<{ payload: { reason?: string; value?: unknown; previousValue?: unknown } }>
    const statusEvents = log.filter((e) => e.type === CHELONIA_KV_STATUS_CHANGED)

    assert.strictEqual(updatedEvents.length, 1, 'UPDATED must fire once for error recovery')
    assert.strictEqual(updatedEvents[0].payload.reason, 'load')
    assert.deepStrictEqual(updatedEvents[0].payload.value, { x: 5 })
    assert.deepStrictEqual(updatedEvents[0].payload.previousValue, { x: 5 })
    assert.ok(
      statusEvents.some((e) => (e.payload as { status?: string }).status === 'loaded'),
      'STATUS_CHANGED to loaded must fire'
    )
    assert.strictEqual(sbp('chelonia/kv/status', c, 'recoverErr'), 'loaded')
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 73f: issue #1 regression — boot-idempotent re-validation (status already
  // 'loaded', unchanged value) must NOT fire CHELONIA_KV_UPDATED.
  // -----------------------------------------------------------------------
  it('73f: boot-idempotent re-validate with unchanged value suppresses UPDATED', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'bootIdem', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-73f'
    await setupContract(c)
    await sbp('chelonia/kv/_handleRemote', c, 'bootIdem', fakeParsed({ x: 5 }), 'e-seed')
    assert.strictEqual(sbp('chelonia/kv/status', c, 'bootIdem'), 'loaded')

    const { log, offs } = collectEvents()
    // Re-define with the same schema on an already-loaded slot with an
    // unchanged value — the common boot case. No UPDATED should fire.
    sbp('chelonia/kv/defineSlot', {
      key: 'bootIdem', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const updatedEvents = log.filter((e) => e.type === CHELONIA_KV_UPDATED)
    assert.strictEqual(updatedEvents.length, 0, 'UPDATED must NOT fire on boot-idempotent re-validation')
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 80a: issue #4 — the catch path of `revalidateMirrorEntry` (schema parse
  // failure → ERROR) must defer its status flip through the lane when a
  // write is in flight, symmetric with the success path's LOADED deferral
  // locked in by test 80. The `VALIDATION_ERROR` event still fires
  // synchronously (it is diagnostic); only the status mutation is deferred.
  // -----------------------------------------------------------------------
  it('80a: revalidate defers ERROR status flip when a write is in flight', async () => {
    const contractType = 'type-80a-isolated'
    sbp('chelonia/kv/defineSlot', {
      key: 'asym',
      contractType,
      defaultValue: { x: 1 },
      schema: strictSchema,
      autoLoad: 'never'
    })
    const c = 'cid-80a'
    await setupContract(c, contractType)
    // Seed a loaded value so revalidate has a non-undefined value to act on.
    await sbp('chelonia/kv/_handleRemote', c, 'asym', fakeParsed({ x: 5 }), 'cid-seed-80a')
    // Now corrupt the value to something the replacement schema will reject.
    rootState()._kv![c]!.asym.value = { x: -1 }

    const deferred: Array<() => unknown> = []
    stubQueueInvocation = (_cID, fn) => {
      deferred.push(() => runQueued(fn))
      return Promise.resolve()
    }
    // Mark a write in flight for this contract.
    sbp('chelonia/test/incPending', c)

    const { log, offs } = collectEvents()
    // Replace the slot with a schema that rejects x <= 0 → triggers the
    // catch path in revalidateMirrorEntry with hasInflight = true.
    // defaultValue { x: 1 } passes strictSchema.parse at registration.
    sbp('chelonia/kv/defineSlot', {
      key: 'asym',
      contractType,
      defaultValue: { x: 1 },
      schema: strictSchema,
      autoLoad: 'never'
    })

    // The VALIDATION_ERROR event fires synchronously (diagnostic).
    assert.strictEqual(
      log.filter((e) => e.type === CHELONIA_KV_VALIDATION_ERROR).length, 1,
      'VALIDATION_ERROR should fire synchronously even with hasInflight'
    )
    // But the ERROR status flip must be deferred (not yet applied).
    assert.strictEqual(
      rootState()._kv![c]!.asym.status, 'loaded',
      'ERROR status flip must be deferred while a write holds the lane'
    )
    assert.ok(deferred.length > 0, 'a lane callback should have been queued')

    // Drain the captured lane callback; the deferred ERROR flip applies.
    sbp('chelonia/test/decPending', c)
    for (const run of deferred) run()
    assert.strictEqual(
      rootState()._kv![c]!.asym.status, 'error',
      'deferred ERROR status flip applies once the lane runs'
    )
    offs.forEach((off) => off())
  })

  // -----------------------------------------------------------------------
  // 80b: issue #5 — the deferred ERROR stamp must re-check the LIVE mirror
  // value before applying. If an interleaving op writes a fresh, valid
  // value to the mirror while the lane is held, the value the revalidate
  // judged invalid is gone, so the slot must NOT be stamped ERROR.
  // -----------------------------------------------------------------------
  it('80b: deferred ERROR stamp is skipped when the mirror value changed', async () => {
    const contractType = 'type-80b-isolated'
    sbp('chelonia/kv/defineSlot', {
      key: 'asym', contractType, defaultValue: { x: 1 }, schema: strictSchema, autoLoad: 'never'
    })
    const c = 'cid-80b'
    await setupContract(c, contractType)
    await sbp('chelonia/kv/_handleRemote', c, 'asym', fakeParsed({ x: 5 }), 'seed-80b')
    // Corrupt the value so the re-validation's parse rejects it.
    rootState()._kv![c]!.asym.value = { x: -1 }

    const deferred: Array<() => unknown> = []
    stubQueueInvocation = (_cID, fn) => {
      deferred.push(() => runQueued(fn))
      return Promise.resolve()
    }
    sbp('chelonia/test/incPending', c)

    // Replace the slot → catch path defers the ERROR stamp behind the lane.
    sbp('chelonia/kv/defineSlot', {
      key: 'asym', contractType, defaultValue: { x: 1 }, schema: strictSchema, autoLoad: 'never'
    })
    assert.strictEqual(rootState()._kv![c]!.asym.status, 'loaded',
      'ERROR stamp deferred while the write holds the lane')

    // Simulate an interleaving op committing a fresh, valid value to the
    // mirror before the deferred ERROR stamp runs.
    rootState()._kv![c]!.asym.value = { x: 7 }

    // Drain the lane: the deferred ERROR stamp must see the changed value
    // and skip, leaving the slot 'loaded' rather than wrongly 'error'.
    sbp('chelonia/test/decPending', c)
    for (const run of deferred) run()
    assert.strictEqual(rootState()._kv![c]!.asym.status, 'loaded',
      'a now-valid value must not be stamped ERROR by the stale deferred flip')
  })

  // -----------------------------------------------------------------------
  // 81: issue #1 — when the authoritative reload fails, the reducer must
  // seed from the RETAINED value (paired with the retained etag the write
  // sends), not the default, so a no-conflict commit cannot overwrite the
  // live server value from a stale default basis.
  // -----------------------------------------------------------------------
  it('81: failed reload seeds from retained value, guards with retained etag', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rl', contractType: CTYPE, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-81'
    await setupContract(c)

    const entry = rootState()._kv![c]!.rl as {
      value: unknown; etag: string | null; status: string
    }
    entry.value = { x: 5 }
    entry.etag = 'stale-etag'
    entry.status = 'error'

    // The authoritative reload fails (transient 5xx / brief offline).
    let getCount = 0
    stubGet = async () => { getCount++; throw new Error('reload failed') }

    let seenSeed: unknown
    let capturedIfMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      capturedIfMatch = opts.ifMatch
      return { etag: 'written' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'rl',
      updater: (prev: JSONType) => {
        seenSeed = prev
        return { x: (prev as { x: number }).x + 1 }
      }
    })

    assert.strictEqual(getCount, 1, 'authoritative reload should be attempted')
    // Reducer seeds from the retained value (5), NOT the default (0).
    assert.deepStrictEqual(seenSeed, { x: 5 })
    assert.deepStrictEqual(result, { x: 6 })
    // The write guards against the retained etag the value is paired with.
    assert.strictEqual(capturedIfMatch, 'stale-etag')
  })

  // -----------------------------------------------------------------------
  // 82: issue #1 — failed reload with NO retained value still falls back to
  // the default (read's error semantics for a genuinely empty slot).
  // -----------------------------------------------------------------------
  it('82: failed reload with no retained value falls back to default', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rl', contractType: CTYPE, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-82'
    await setupContract(c)

    // Never-loaded slot: non-init, no retained value/etag. The data-loss
    // guard does not even fire (it requires value !== undefined), so this
    // exercises the plain default-seed path with no precondition.
    let seenSeed: unknown
    let capturedIfMatch: string | undefined
    stubSet = async (_cID, _key, _data, opts) => {
      capturedIfMatch = opts.ifMatch
      return { etag: 'written' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'rl',
      updater: (prev: JSONType) => {
        seenSeed = prev
        return { x: (prev as { x: number }).x + 1 }
      }
    })

    assert.deepStrictEqual(seenSeed, { x: 0 }, 'seeds from default')
    assert.deepStrictEqual(result, { x: 1 })
    assert.strictEqual(capturedIfMatch, undefined, 'no precondition without etag')
  })

  // -----------------------------------------------------------------------
  // 83: issue #1 — a failed reload that seeds from the retained value must
  // still honour conflict protection: if the server value actually changed,
  // the ifMatch precondition 412s and onconflict re-seeds from live data.
  // -----------------------------------------------------------------------
  it('83: failed reload still recovers via onconflict on a real change', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'rl', contractType: CTYPE, defaultValue: { x: 0 }, autoLoad: 'never'
    })
    const c = 'cid-83'
    await setupContract(c)

    const entry = rootState()._kv![c]!.rl as {
      value: unknown; etag: string | null; status: string
    }
    entry.value = { x: 5 }
    entry.etag = 'stale-etag'
    entry.status = 'error'

    stubGet = async () => { throw new Error('reload failed') }

    // First set attempt conflicts (server moved on to {x:9}); onconflict
    // re-seeds from live currentData and the retry succeeds.
    let attempts = 0
    stubSet = async (_cID, _key, _data, opts) => {
      attempts++
      if (attempts === 1) {
        const next = await opts.onconflict!({ currentData: { x: 9 }, etag: 'live-etag' })
        return { etag: 'written', _resolved: next } as { etag: string }
      }
      return { etag: 'written' }
    }

    const result = await sbp('chelonia/kv/update', {
      contractID: c,
      key: 'rl',
      updater: (prev: JSONType) => ({ x: (prev as { x: number }).x + 1 })
    })

    // onconflict re-seeded from the live {x:9}, so the committed value is
    // {x:10}, NOT {x:6} from the stale retained basis.
    assert.deepStrictEqual(result, { x: 10 })
  })

  // -----------------------------------------------------------------------
  // 84: issue #2 — _cleanupContractSlots must drop persisted _kv mirror
  // entries for NON-subscribed contracts (seeded by _defineSlotInternal),
  // which never enter kvSlotsByContractID and so the index walk misses.
  // -----------------------------------------------------------------------
  it('84: cleanup drops persisted mirror entry for non-subscribed contract', async () => {
    const contractType = 'type-84-isolated'
    const manifest = 'manifest-84'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      gamma: { defaultValue: 1 }
    })
    const c = 'cid-84'

    // Persisted-from-prior-session entry: a _kv mirror entry + a resolvable
    // contract type, but NOT in subscriptionSet (never re-synced).
    const s = rootState()
    if (!s.contracts) (s as { contracts?: unknown }).contracts = Object.create(null)
    ;(s.contracts as Record<string, unknown>)[c] = { HEAD: '', height: 0, type: contractType }
    if (!s._kv) (s as { _kv?: unknown })._kv = Object.create(null)
    ;(s._kv as Record<string, unknown>)[c] = { gamma: { value: { v: 1 }, etag: 'e', status: 'loaded' } }
    sbp('chelonia/test/seedEchoCID', `${c}::gamma`)

    assert.ok(s._kv?.[c]?.gamma, 'persisted entry present')

    const prev = { gamma: { defaultValue: 1 } }
    const next = {}
    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, prev, next)

    assert.strictEqual(
      s._kv?.[c], undefined,
      'emptied per-contract record removed for non-subscribed contract'
    )
    assert.strictEqual(
      sbp('chelonia/test/hasEchoCID', `${c}::gamma`), false,
      'echo bucket cleared'
    )
  })

  // -----------------------------------------------------------------------
  // 85: issue #2 — cleanup must NOT touch a persisted entry whose contract
  // type cannot be confirmed to match (foreign/un-synced data is left for
  // the next sync to reconcile, never clobbered).
  // -----------------------------------------------------------------------
  it('85: cleanup leaves unconfirmable-type persisted entry untouched', async () => {
    const contractType = 'type-85-isolated'
    const manifest = 'manifest-85'
    sbp('chelonia/kv/_registerContractSlots', contractType, manifest, {
      gamma: { defaultValue: 1 }
    })
    const c = 'cid-85'

    // Persisted entry whose contract type is NOT resolvable (no contracts
    // metadata) and which is not subscribed.
    const s = rootState()
    if (!s._kv) (s as { _kv?: unknown })._kv = Object.create(null)
    ;(s._kv as Record<string, unknown>)[c] = { gamma: { value: { v: 1 }, etag: 'e', status: 'loaded' } }

    const prev = { gamma: { defaultValue: 1 } }
    const next = {}
    sbp('chelonia/kv/_cleanupContractSlots', contractType, manifest, prev, next)

    assert.ok(
      s._kv?.[c]?.gamma,
      'foreign/unconfirmable-type entry must be left in place'
    )
  })

  // -----------------------------------------------------------------------
  // 86: onUpdate re-entrancy guard (Issue #1)
  //
  // These use a *serializing* queue stub (the "lanes" pattern from test
  // 33) so the per-contract lane actually blocks — the default inline
  // stub can't exercise the deadlock. The synchronous guard rejects a
  // same-contract write re-entered from onUpdate before it can wedge the
  // lane; cross-contract writes and the queueMicrotask escape hatch are
  // unaffected.
  // -----------------------------------------------------------------------
  const installSerializingQueue = (): void => {
    const lanes = new Map<string, Promise<unknown>>()
    stubQueueInvocation = (cID, fn) => {
      const prev = lanes.get(cID) ?? Promise.resolve()
      const next = prev.then(() => runQueued(fn))
      lanes.set(cID, next.catch(() => {}))
      return next
    }
  }

  it('86: update re-entered from same-contract onUpdate rejects ChelErrorKvReentrant', async () => {
    installSerializingQueue()
    let reentrantError: unknown
    sbp('chelonia/kv/defineSlot', {
      key: 'k',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: async (_value: unknown, ctx: { reason: string }) => {
        if (ctx.reason === 'local') {
          try {
            await sbp('chelonia/kv/update', {
              contractID: c, key: 'k', updater: () => ({ x: 2 })
            })
          } catch (e) {
            reentrantError = e
          }
        }
      }
    })
    const c = 'cid-86'
    await setupContract(c)

    const result = await sbp('chelonia/kv/update', {
      contractID: c, key: 'k', updater: () => ({ x: 1 })
    })
    // The outer write completes (no deadlock) and the inner write was
    // rejected synchronously instead of hanging the lane.
    assert.deepStrictEqual(result, { x: 1 })
    assert.ok(reentrantError instanceof ChelErrorKvReentrant,
      'inner same-contract update must reject ChelErrorKvReentrant')
  })

  it('86b: clear and sync re-entered synchronously from same-contract onUpdate reject', async () => {
    installSerializingQueue()
    const errors: unknown[] = []
    sbp('chelonia/kv/defineSlot', {
      key: 'k',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: (_value: unknown, ctx: { reason: string }) => {
        if (ctx.reason !== 'local') return undefined
        // Both calls are issued synchronously (the call expressions are
        // evaluated before any await), so both fall inside the guard's
        // synchronous window and are rejected. Returning the combined
        // promise lets the lane await their (already-caught) settlement.
        return Promise.all([
          sbp('chelonia/kv/clear', c, 'k').catch((e: unknown) => errors.push(e)),
          sbp('chelonia/kv/sync', c, 'k').catch((e: unknown) => errors.push(e))
        ])
      }
    })
    const c = 'cid-86b'
    await setupContract(c)

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'k', updater: () => ({ x: 1 })
    })
    assert.strictEqual(errors.length, 2, 'both clear and sync must reject')
    assert.ok(errors.every((e) => e instanceof ChelErrorKvReentrant),
      'both clear and sync must reject ChelErrorKvReentrant')
  })

  it('86c: cross-contract write from onUpdate is allowed', async () => {
    installSerializingQueue()
    let crossResult: unknown = 'NOT_SET'
    let crossError: unknown
    sbp('chelonia/kv/defineSlot', {
      key: 'k',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: async (_value: unknown, ctx: { reason: string; contractID: string }) => {
        if (ctx.reason === 'local' && ctx.contractID === cA) {
          try {
            crossResult = await sbp('chelonia/kv/update', {
              contractID: cB, key: 'k', updater: () => ({ x: 9 })
            })
          } catch (e) {
            crossError = e
          }
        }
      }
    })
    const cA = 'cid-86c-A'
    const cB = 'cid-86c-B'
    await setupContract(cA)
    await setupContract(cB)

    await sbp('chelonia/kv/update', {
      contractID: cA, key: 'k', updater: () => ({ x: 1 })
    })
    assert.strictEqual(crossError, undefined, 'cross-contract write must not reject')
    assert.deepStrictEqual(crossResult, { x: 9 })
  })

  it('86d: queueMicrotask-deferred same-contract write from onUpdate succeeds', async () => {
    installSerializingQueue()
    let deferredResult: unknown = 'NOT_SET'
    let fired = false
    sbp('chelonia/kv/defineSlot', {
      key: 'k',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: (_value: unknown, ctx: { reason: string }) => {
        if (ctx.reason === 'local' && !fired) {
          fired = true
          // Scheduling the write off the synchronous stack (and not
          // awaiting it here) takes it out of the guard's synchronous
          // window. It simply queues behind the lane and runs once the
          // lane releases — no deadlock, no rejection.
          queueMicrotask(() => {
            sbp('chelonia/kv/update', {
              contractID: c, key: 'k', updater: () => ({ x: 2 })
            }).then((r: unknown) => { deferredResult = r })
          })
        }
      }
    })
    const c = 'cid-86d'
    await setupContract(c)

    await sbp('chelonia/kv/update', {
      contractID: c, key: 'k', updater: () => ({ x: 1 })
    })
    // Let the deferred microtask-enqueued write run on the freed lane.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepStrictEqual(deferredResult, { x: 2 },
      'deferred write runs after the lane is released')
  })

  it('86e: independent concurrent same-contract write during async onUpdate is NOT rejected', async () => {
    // Regression guard: the re-entrancy flag must only cover onUpdate's
    // synchronous window. An independent caller that interleaves with a
    // slow async onUpdate must queue and succeed, not be falsely rejected.
    installSerializingQueue()
    let releaseOnUpdate!: () => void
    const gate = new Promise<void>((resolve) => { releaseOnUpdate = resolve })
    let onUpdateStarted = false
    sbp('chelonia/kv/defineSlot', {
      key: 'k',
      contractType: CTYPE,
      defaultValue: { x: 0 },
      onUpdate: async (_value: unknown, ctx: { reason: string }) => {
        if (ctx.reason === 'local' && !onUpdateStarted) {
          onUpdateStarted = true
          await gate // hold the lane like a slow async onUpdate
        }
      }
    })
    const c = 'cid-86e'
    await setupContract(c)

    const first = sbp('chelonia/kv/update', {
      contractID: c, key: 'k', updater: () => ({ x: 1 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.strictEqual(onUpdateStarted, true)

    // Independent write while the first onUpdate is mid-await.
    let secondError: unknown = null
    const second = sbp('chelonia/kv/update', {
      contractID: c, key: 'k', updater: () => ({ x: 2 })
    }).catch((e: unknown) => { secondError = e; return undefined })

    releaseOnUpdate()
    const [, secondResult] = await Promise.all([first, second])
    assert.strictEqual(secondError, null,
      'independent concurrent same-contract write must NOT be rejected')
    assert.deepStrictEqual(secondResult, { x: 2 })
  })

  // -----------------------------------------------------------------------
  // 87: pending-counter balance on synchronous queueInvocation throw (Issue #3)
  // -----------------------------------------------------------------------
  it('87: update balances the pending counter when queueInvocation throws synchronously', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'k', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-87'
    await setupContract(c)

    const savedQI = stubQueueInvocation
    stubQueueInvocation = () => { throw new Error('synchronous QI failure') }

    try {
      await assert.rejects(
        () => sbp('chelonia/kv/update', { contractID: c, key: 'k', updater: () => ({ x: 1 }) }),
        (e: unknown) => e instanceof Error && e.message === 'synchronous QI failure'
      )
      // The increment ran before the throw; without the try/catch balance
      // the counter would leak. It must be back to 0.
      assert.strictEqual(sbp('chelonia/test/pendingCount', c), 0,
        'pending counter must not leak on synchronous queueInvocation throw')
    } finally {
      // Restore so afterEach's chelonia/reset → _waitInFlight can drain.
      stubQueueInvocation = savedQI
    }
  })

  it('87b: clear balances the pending counter when queueInvocation throws synchronously', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'k', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-87b'
    await setupContract(c)

    const savedQI = stubQueueInvocation
    stubQueueInvocation = () => { throw new Error('synchronous QI failure') }

    try {
      await assert.rejects(
        () => sbp('chelonia/kv/clear', c, 'k'),
        (e: unknown) => e instanceof Error && e.message === 'synchronous QI failure'
      )
      assert.strictEqual(sbp('chelonia/test/pendingCount', c), 0,
        'pending counter must not leak on synchronous queueInvocation throw')
    } finally {
      stubQueueInvocation = savedQI
    }
  })

  it('87c: pending counter does not leak when queueInvocation returns undefined (filter veto)', async () => {
    // A more insidious failure mode than 87/87b: an SBP filter vetoes
    // `chelonia/queueInvocation` itself, so `sbp(...)` returns undefined
    // (no throw). `queued.finally` would then throw a TypeError and the
    // increment would leak. `Promise.resolve(queued)` neutralises this.
    sbp('chelonia/kv/defineSlot', {
      key: 'k', contractType: CTYPE, defaultValue: { x: 0 }
    })
    const c = 'cid-87c'
    await setupContract(c)

    const savedQI = stubQueueInvocation
    stubQueueInvocation = (() => undefined) as unknown as typeof stubQueueInvocation

    try {
      // The write resolves (Promise.resolve(undefined) → fulfilled),
      // not rejects. The assertion is really about the counter.
      await sbp('chelonia/kv/update', { contractID: c, key: 'k', updater: () => ({ x: 1 }) })
      assert.strictEqual(sbp('chelonia/test/pendingCount', c), 0,
        'pending counter must not leak when queueInvocation returns undefined')
    } finally {
      stubQueueInvocation = savedQI
    }
  })

  // -----------------------------------------------------------------------
  // 88: fresh non-conflict echo CID survives conflict-marker saturation (Issue #5)
  // -----------------------------------------------------------------------
  it('88: a freshly recorded non-conflict echo CID is not evicted under conflict saturation', async () => {
    const c = 'cid-88'
    const echoKey = `${c}::k`
    // Saturate the bucket with KV_ECHO_CID_MAX conflict markers.
    for (let i = 0; i < KV_ECHO_CID_MAX; i++) {
      sbp('chelonia/test/addEchoCID', echoKey, `conflict-${i}`, true)
    }
    assert.strictEqual(sbp('chelonia/test/echoBucketSize', echoKey), KV_ECHO_CID_MAX)

    // Record one fresh non-conflict CID through the real recorder.
    sbp('chelonia/kv/_recordEchoCIDForTest', c, 'k', 'fresh-noconflict', false)

    assert.strictEqual(
      sbp('chelonia/test/echoCIDPresent', echoKey, 'fresh-noconflict'), true,
      'freshly recorded CID must survive eviction even when the bucket is ' +
      'saturated with conflict markers'
    )
  })
})
