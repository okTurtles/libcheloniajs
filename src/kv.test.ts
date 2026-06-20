// KV slot API tests — 67 cases total: 27 from KV-REVAMPED.md §11.6
// plus 40 implementation-specific (cases 28-67) covering REVIEW.md
// follow-ups and §11.3 step 3 exceptions.
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
import { KV_ECHO_CID_MAX, KV_ECHO_TTL_MS } from './kv-constants.js'
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
  await new Promise((_resolve) => setTimeout(_resolve, 0))
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

type SetFilterStub = (contractID: string, filter?: string[]) => void

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
    this.kvLocalEchoCIDs = new Map()
    this.kvPendingWrites = new Map()
    this.defContractKvByManifest = new Map()
  },

  'chelonia/configure': function (this: CheloniaContext) {
    if (!this.state) sbp('chelonia/_init')
  },

  'chelonia/reset': async function (this: CheloniaContext) {
    if (!this.state) return
    // Mirror production ordering: drain in-flight KV writes before
    // clearing the runtime maps.
    await sbp('chelonia/kv/_waitInFlight')
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
    this.kvLocalEchoCIDs.clear()
    this.kvPendingWrites.clear()
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
    return name
  },

  'chelonia/kv/setFilter': function (_contractID: string, _filter?: string[]) {
    stubSetFilter(_contractID, _filter)
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
  'chelonia/test/seedEchoCID': function (this: CheloniaContext, echoKey: string) {
    this.kvLocalEchoCIDs.set(echoKey, new Map([
      ['cid', { expiry: Date.now() + KV_ECHO_TTL_MS, fromConflict: false }]
    ]))
  },

  // Test helper: inspect active filters without exposing internals publicly.
  'chelonia/test/activeFilterKeys': function (this: CheloniaContext, contractID: string) {
    const filter = this.kvActiveFilters.get(contractID)
    return filter ? [...filter] : undefined
  },

  'chelonia/test/hasEchoCID': function (this: CheloniaContext, key: string) {
    return this.kvLocalEchoCIDs.has(key)
  },

  'chelonia/test/echoCIDExpiry': function (this: CheloniaContext, key: string, cid: string) {
    return this.kvLocalEchoCIDs.get(key)?.get(cid)?.expiry
  },

  // Test helper: simulate removeImmediately's KV cleanup for a contract.
  'chelonia/test/removeSubscription': function (this: CheloniaContext, contractID: string) {
    this.subscriptionSet.delete(contractID)
    this.kvSlotsByContractID.delete(contractID)
    this.kvActiveFilters.delete(contractID)
    this.kvFilterDirty.delete(contractID)
  }
})

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('KV slot API', () => {
  before(() => {
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    const calls = stubSetFilterCalls.filter((f) => f.contractID === c)
    assert.strictEqual(calls.length, 1)
    assert.ok(calls[0].keys.includes('a'))
    assert.ok(calls[0].keys.includes('b'))
  })

  // -----------------------------------------------------------------------
  // 7
  // -----------------------------------------------------------------------
  it('7: refreshOnReconnect re-fetches', async () => {
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
    stubGet = async () => { getCount++; return fakeParsed({ x: 42 }) }

    await sbp('chelonia/kv/sync', c, 'rc')
    assert.strictEqual(getCount, 1)
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

    assert.deepStrictEqual(entry.value, { x: 99 })
    assert.strictEqual(entry.status, 'non-init')
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

  // -----------------------------------------------------------------------
  // 10
  // -----------------------------------------------------------------------
  it('10: defineContract kv block registers slots', async () => {
    const manifest = 'ctr-v10'
    sbp('chelonia/kv/_registerContractSlots', manifest, {
      profile: { defaultValue: { name: '' }, schema: anySchema }
    })
    const c = 'cid-10'
    await setupContract(c, manifest)
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

    sbp('chelonia/kv/_handleRemote', c, 'rc2', fakeParsed(null))
    assert.deepStrictEqual(entry.value, { x: 77 })
  })

  // -----------------------------------------------------------------------
  // 16
  // -----------------------------------------------------------------------
  it('16: defineContract replacement unregisters removed keys', async () => {
    const m = 'ctr-v16'
    sbp('chelonia/kv/_registerContractSlots', m, {
      alpha: { defaultValue: 1 }, beta: { defaultValue: 2 }
    })
    const c = 'cid-16'
    await setupContract(c, m)

    const s = rootState()
    assert.ok(s._kv?.[c]?.alpha)
    assert.ok(s._kv?.[c]?.beta)

    const prev = { alpha: { defaultValue: 1 }, beta: { defaultValue: 2 } }
    const next = { alpha: { defaultValue: 10 } }
    sbp('chelonia/kv/_cleanupContractSlots', m, prev, next)
    sbp('chelonia/kv/_registerContractSlots', m, next)

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
    await new Promise((_resolve) => setTimeout(_resolve, 0))
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
  it('22: aggregate sync loads all slots', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'sa', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    sbp('chelonia/kv/defineSlot', {
      key: 'sb', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-22'
    await setupContract(c)

    const keys: string[] = []
    stubGet = async (_c, key) => { keys.push(key); return fakeParsed({ x: 1 }) }
    await sbp('chelonia/kv/sync', c)
    assert.ok(keys.includes('sa'))
    assert.ok(keys.includes('sb'))
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    let drainResolved = false
    const drainP = sbp('chelonia/kv/_waitInFlight').then(() => { drainResolved = true })
    await new Promise((_resolve) => setTimeout(_resolve, 0))
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))
    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((_resolve) => setTimeout(_resolve, 0))

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
    await new Promise((_resolve) => setTimeout(_resolve, 0))
    shouldMatch = false
    sbp('chelonia/kv/refreshFilters', c)
    await new Promise((_resolve) => setTimeout(_resolve, 0))

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
      (e: unknown) => e instanceof ChelErrorKvUpdateInvalid
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    // Simulate contract release: drop from contracts/subSet/index/nonces.
    // After this the contract is in none of the three documented sources
    // except the pending-writes counter.
    const s = rootState()
    reactiveDel(s.contracts as Record<string, unknown>, c)
    sbp('chelonia/test/removeSubscription', c)
    sbp('chelonia/kv/_cleanupContractRuntime', c)

    let drainResolved = false
    const drainP = sbp('chelonia/kv/_waitInFlight').then(() => { drainResolved = true })
    await new Promise((_resolve) => setTimeout(_resolve, 0))
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

    // Hold the GET so we can replace the slot while it is in flight.
    let releaseGet!: () => void
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve })
    stubGet = async () => {
      await getGate
      throw new Error('simulated GET failure')
    }

    // Drive a fresh load via single-slot sync (rejects on failure, so
    // swallow the rejection — we only care about the mirror side-effect).
    const syncP = sbp('chelonia/kv/sync', c, 'staleLoad').catch(() => {})
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    // Replace the slot definition while the GET is in flight. The
    // kvSlotsByContractID entry now points at a fresh slot object whose
    // status/lastError the stale load must not touch.
    sbp('chelonia/kv/defineSlot', {
      key: 'staleLoad', contractType: CTYPE, defaultValue: { x: 9 }, schema: schemaB
    })
    const entry = rootState()._kv![c]!.staleLoad as {
      status: string; lastError?: { name: string; message: string }
    }

    // Release the failing GET. The old load's catch path must see the
    // staleness and bail out without stamping 'error' or setting
    // lastError on the replacement slot.
    releaseGet()
    await syncP

    assert.notStrictEqual(entry.status, 'error',
      'replacement slot must not be marked error by the stale load failure')
    assert.strictEqual(entry.lastError, undefined,
      'replacement slot must not inherit lastError from the stale load failure')
    stubGet = async () => null
  })

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------

  it('43: stale successful update lets replacement slot process the echo', async () => {
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    sbp('chelonia/kv/defineSlot', {
      key: 'staleUpdate', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })
    const { log, offs } = collectEvents()
    releaseSet()
    assert.strictEqual(await updateP, undefined)

    await sbp('chelonia/kv/_handleRemote', c, 'staleUpdate', fakeParsed({ x: 1 }), echoCID)
    assert.deepStrictEqual(rootState()._kv![c]!.staleUpdate.value, { x: 1 })
    assert.ok(log.some((e) =>
      e.type === CHELONIA_KV_UPDATED &&
      (e.payload as { reason: string }).reason === 'remote'
    ))
    offs.forEach((off) => off())
  })

  it('44: stale successful clear lets replacement slot process the echo', async () => {
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
    await new Promise((_resolve) => setTimeout(_resolve, 0))

    sbp('chelonia/kv/defineSlot', {
      key: 'staleClear', contractType: CTYPE, defaultValue: { x: 9 }, schema: objectSchema
    })
    const { log, offs } = collectEvents()
    releaseSet()
    await clearP

    await sbp('chelonia/kv/_handleRemote', c, 'staleClear', fakeParsed(null), echoCID)
    assert.deepStrictEqual(rootState()._kv![c]!.staleClear.value, { x: 9 })
    assert.ok(log.some((e) =>
      e.type === CHELONIA_KV_UPDATED &&
      (e.payload as { reason: string }).reason === 'remote'
    ))
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
    const manifest = 'ctr-v48'
    sbp('chelonia/kv/_registerContractSlots', manifest, {
      hidden: { defaultValue: { x: 0 }, autoSubscribe: false }
    })
    const c = 'cid-48'
    await setupContract(c, manifest)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])

    sbp('chelonia/kv/_cleanupContractSlots', manifest, { hidden: {} }, {})
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
    const manifest = 'type-54'
    sbp('chelonia/kv/defineSlot', {
      key: 'localOnly',
      contractType: manifest,
      defaultValue: { x: 0 },
      autoSubscribe: false
    })
    sbp('chelonia/kv/_registerContractSlots', manifest, {
      alpha: { defaultValue: { x: 1 }, autoSubscribe: true }
    })
    const c = 'cid-54'
    await setupContract(c, manifest)
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), ['alpha'])

    sbp('chelonia/kv/_cleanupContractSlots', manifest, { alpha: {} }, {})
    sbp('chelonia/kv/_assertIndexConsistent')
    assert.deepStrictEqual(sbp('chelonia/test/activeFilterKeys', c), [])
  })

  it('54: manifest cleanup removes stale echo nonces only for removed slots', async () => {
    const manifest = 'type-55'
    sbp('chelonia/kv/_registerContractSlots', manifest, {
      removed: { defaultValue: { x: 0 } }
    })
    const c = 'cid-55'
    await setupContract(c, manifest)
    sbp('chelonia/test/seedEchoCID', `${c}::removed`)
    sbp('chelonia/test/seedEchoCID', 'other::removed')

    sbp('chelonia/kv/_cleanupContractSlots', manifest, { removed: {} }, {})
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::removed`), false)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', 'other::removed'), true)
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

  it('63c: clean update applies non-self remote frames without sync', async () => {
    sbp('chelonia/kv/defineSlot', {
      key: 'cleanRemote', contractType: CTYPE, defaultValue: { x: 0 }, schema: objectSchema
    })
    const c = 'cid-64c'
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

  it('63d: conflicted update self-echo clears force-sync marker', async () => {
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
    await sbp('chelonia/kv/_handleRemote', c, 'clearMarker', fakeParsed({ x: 2 }), 'e-local')
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)
    assert.strictEqual(sbp('chelonia/test/hasEchoCID', `${c}::clearMarker`), false)

    await sbp('chelonia/kv/_handleRemote', c, 'clearMarker', fakeParsed({ x: 4 }), 'e-remote')
    assert.strictEqual(getCalls, 0)
    assert.deepStrictEqual(rootState()._kv![c]!.clearMarker.value, { x: 4 })
    offs.forEach((off) => off())
  })

  it('63e: conflicted clear forces sync for non-self remote frames', async () => {
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
    assert.deepStrictEqual(rootState()._kv![c]!.clearForce.value, { x: 0 })
  })

  it('63f: expired conflicted echo marker does not force sync', async () => {
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
})
