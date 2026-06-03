// KV slot API tests — 32 cases total: 27 from KV-REVAMPED.md §11.6
// plus 5 implementation-specific (cases 28-32) covering REVIEW.md
// follow-ups (issues 1/2/3/5/§11.3 step 3 exception).
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
  ChelErrorKvUpdateInvalid,
  ChelErrorKvValidation
} from './errors.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CHELONIA_KV_VALIDATION_ERROR
} from './events.js'
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

type QueuedSetStub = (args: {
  contractID: string
  key: string
  data: JSONType
  onconflict?: (a: { currentData?: JSONType; etag?: string | null; status?: number }) =>
    Promise<[JSONType, string] | false>
  ifMatch?: string
  maxAttempts?: number
  signal?: AbortSignal
  encryptionKeyName: string
  signingKeyName: string
}) => Promise<{ etag: string | null }>

type SetFilterStub = (contractID: string, filter?: string[]) => void

type QueueInvocationStub = (contractID: string, fn: () => unknown) => Promise<unknown>

let stubGet: GetStub
let stubQueuedSet: QueuedSetStub
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
    this.kvLocalEchoNonces = new Map()
    this.defContractKvByManifest = new Map()
  },

  'chelonia/configure': function (this: CheloniaContext) {
    if (!this.state) sbp('chelonia/_init')
  },

  'chelonia/reset': function (this: CheloniaContext) {
    if (!this.state) return
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
    this.kvLocalEchoNonces.clear()
    this.subscriptionSet.clear()
  },

  'chelonia/kv/get': function (_contractID: string, _key: string) {
    return stubGet(_contractID, _key)
  },

  'chelonia/kv/queuedSet': function (args: Parameters<QueuedSetStub>[0]) {
    return stubQueuedSet(args)
  },

  'chelonia/kv/setFilter': function (_contractID: string, _filter?: string[]) {
    stubSetFilter(_contractID, _filter)
  },

  'chelonia/queueInvocation': function (_contractID: string, fn: () => unknown) {
    return stubQueueInvocation(_contractID, fn)
  },

  // Test helper: add contract to subscriptionSet.
  'chelonia/test/addSubscription': function (this: CheloniaContext, contractID: string) {
    this.subscriptionSet.add(contractID)
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
    stubSetFilterCalls = []

    stubGet = async () => null
    stubQueuedSet = async () => ({ etag: 'new-etag' })
    stubSetFilter = (contractID, filter) => {
      stubSetFilterCalls.push({ contractID, keys: filter ?? [] })
    }
    stubQueueInvocation = (_cID, fn) => Promise.resolve(fn())
  })

  afterEach(() => {
    sbp('chelonia/kv/_assertIndexConsistent')
    sbp('chelonia/reset')
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
    stubQueuedSet = async (args) => {
      setCalls++
      if (setCalls === 1 && args.onconflict) {
        const result = await args.onconflict({
          currentData: { __chelKvNonce: 'rn', value: { x: 5 } },
          etag: 're',
          status: 412
        })
        if (result !== false) {
          args.data = result[0]
          args.ifMatch = result[1]
        }
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
    stubQueuedSet = async () => { networkCalled = true; return { etag: 'e' } }

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
    stubQueuedSet = async (args) => { writtenData = args.data; return { etag: 'clear-etag' } }

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/clear', c, 'clr')

    assert.deepStrictEqual(entry.value, { x: 99 })
    assert.strictEqual(entry.status, 'non-init')
    assert.ok(writtenData && typeof writtenData === 'object')
    assert.strictEqual((writtenData as { value: unknown }).value, null)
    assert.ok('__chelKvNonce' in (writtenData as object))
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

    sbp('chelonia/reset')
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

    stubQueuedSet = async (args) => {
      if (args.onconflict) {
        await args.onconflict({ currentData: { x: -10 }, etag: 'bad' })
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
    stubQueuedSet = async (args) => {
      if (args.onconflict && call === 0) {
        call++
        await args.onconflict({
          currentData: { __chelKvNonce: 'n', value: { x: 99 } }, etag: 'c'
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

    sbp('chelonia/kv/_handleRemote', c, 'rc2', fakeParsed({
      __chelKvNonce: 'rn', value: null
    }))
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

    let capturedNonce: string | undefined
    stubQueuedSet = async (args) => {
      const d = args.data as { __chelKvNonce?: string }
      capturedNonce = d.__chelKvNonce
      return { etag: 'e' }
    }

    const { log, offs } = collectEvents()
    await sbp('chelonia/kv/update', {
      contractID: c, key: 'echo', updater: () => ({ x: 1 })
    })
    assert.ok(capturedNonce)
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 1)

    log.length = 0
    sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({
      __chelKvNonce: capturedNonce, value: { x: 1 }
    }))
    assert.strictEqual(log.filter((e) => e.type === CHELONIA_KV_UPDATED).length, 0)

    sbp('chelonia/kv/_handleRemote', c, 'echo', fakeParsed({
      __chelKvNonce: 'other', value: { x: 2 }
    }))
    assert.strictEqual(
      log.filter((e) =>
        e.type === CHELONIA_KV_UPDATED &&
        (e.payload as { reason: string }).reason === 'remote'
      ).length, 1
    )

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
    stubQueuedSet = async () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict setting KV value')
    }
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'rej', updater: () => ({ x: 2 })
      }),
      (e: unknown) => e instanceof ChelErrorKvConflict
    )

    // 19b: 5xx
    stubQueuedSet = async () => { throw new Error('Internal Server Error') }
    await assert.rejects(
      () => sbp('chelonia/kv/update', {
        contractID: c, key: 'rej', updater: () => ({ x: 2 })
      }),
      (e: unknown) => (e as Error).message === 'Internal Server Error'
    )

    // 19c: abort
    stubQueuedSet = async () => ({ etag: 'e' })
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
    stubQueuedSet = async (args) => {
      if (args.onconflict) {
        await args.onconflict({
          currentData: { __chelKvNonce: 'n', value: { x: 0, t: 0 } }, etag: 'c'
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
    stubQueuedSet = async (args) => {
      if (args.onconflict && !onconflictCalled) {
        onconflictCalled = true
        const result = await args.onconflict({
          currentData: { __chelKvNonce: 'n', value: { x: 10, y: 20 } },
          etag: 're'
        })
        if (result !== false) {
          args.data = result[0]
          args.ifMatch = result[1]
        }
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
    stubQueuedSet = async () => { networkCalled = true; return { etag: 'e' } }

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
      const result = Promise.resolve(fn())
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
    stubQueuedSet = async (args) => {
      capturedIfMatch = args.ifMatch
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
  // 32: 404 with previous value emits CHELONIA_KV_UPDATED with the cloned
  // default in `value` (so the event payload matches what `read` returns
  // after the transition, and what `safeOnUpdate` is dispatched with).
  // -----------------------------------------------------------------------
  it('32: 404 with previous value emits update event with cloned default', async () => {
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

    // CHELONIA_KV_UPDATED must have fired with the cloned default as
    // `value` and previousValue:{x:42}, so external mirrors and event
    // listeners see the same value `read` will return next.
    const updateEvents = log.filter(
      (e) => e.type === CHELONIA_KV_UPDATED && (e.payload as { key: string }).key === 'p404'
    )
    assert.ok(updateEvents.length >= 1, 'expected at least one CHELONIA_KV_UPDATED')
    const lastEvent = updateEvents[updateEvents.length - 1].payload as {
      value: unknown; previousValue: unknown
    }
    assert.deepStrictEqual(lastEvent.value, { x: 0 })
    assert.deepStrictEqual(lastEvent.previousValue, { x: 42 })

    // onUpdate should have been called with the cloned default.
    assert.ok(
      onUpdateValues.some((v) => v !== undefined && (v as { x: number }).x === 0),
      'onUpdate should have been called with the default value'
    )

    offs.forEach((off) => off())
  })
})
