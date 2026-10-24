import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey, type Key } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { CONTRACTS_MODIFIED, EVENT_HANDLED } from './events.js'
import type { PubSubClient } from './pubsub/index.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { captureConsole, isPending, until, within } from './test-utils.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedQueue
)

const vetoError = { name: 'ChelErrorUnexpected', message: /vetoed/ }

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const CONTRACT_TYPE = 'test/sync-contract'

// A self-signed contract whose only event is its OP_CONTRACT. With
// `skipActionProcessing`, no contract source has to be served.
const makeContract = (CSK = keygen(EDWARDS25519SHA512BATCH)): SPMessage => {
  const payload: SPOpContract = {
    type: CONTRACT_TYPE,
    keys: [{
      id: keyId(CSK),
      name: '#csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      allowedActions: '*',
      data: serializeKey(CSK, false),
      _notBeforeHeight: 0,
      _notAfterHeight: undefined
    } as SPKey]
  }
  return SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, payload)],
    manifest: 'test-manifest'
  })
}

// An action signed with the contract's key; `skipActionProcessing` skips it
const makeAction = (CSK: Key, previous: SPMessage): SPMessage => {
  const contractID = previous.contractID()
  const action = signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, {
    action: `${CONTRACT_TYPE}/noop`, data: {}, meta: {}
  })
  return SPMessage.createV1_0({
    contractID,
    previousHEAD: previous.hash(),
    previousKeyOp: contractID,
    height: previous.height() + 1,
    op: [SPMessage.OP_ACTION_UNENCRYPTED, action],
    manifest: 'test-manifest'
  })
}

// `later` are events after the OP_CONTRACT
const server: { contract?: SPMessage; later: SPMessage[]; failEvents: boolean } = {
  later: [],
  failEvents: false
}

const stubFetch = async (url: string): Promise<Response> => {
  const { contract } = server
  const cid = contract?.hash()
  const events = contract ? [contract, ...server.later] : []
  const head = events[events.length - 1]
  if (contract && url.endsWith(`/latestHEADinfo/${cid}`)) {
    return Response.json({ HEAD: head.hash(), height: head.height() })
  }
  if (contract && url.includes(`/eventsAfter/${cid}/`) && !server.failEvents) {
    const body = events.map((event) =>
      Buffer.from(JSON.stringify({ message: event.serialize() })).toString('base64')
    )
    return new Response(JSON.stringify(body), {
      headers: { 'shelter-headinfo-height': String(head.height()) }
    })
  }
  return new Response('', { status: 500 })
}

describe('chelonia/queueInvocation', () => {
  afterEach(() => { vetoedQueue = undefined })

  it('rejects without running the body when the public lane is vetoed', async () => {
    let ran = false
    const body = () => { ran = true; return 'done' }
    assert.strictEqual(await sbp('chelonia/queueInvocation', 'cid-veto', body), 'done')

    ran = false
    vetoedQueue = 'public:cid-veto'
    await assert.rejects(sbp('chelonia/queueInvocation', 'cid-veto', body), vetoError)
    assert.strictEqual(ran, false)
  })

  it('returns a rejected promise when the internal lane is vetoed', async () => {
    let ran = false
    vetoedQueue = 'cid-veto'
    const result = sbp('chelonia/queueInvocation', 'cid-veto', () => { ran = true })
    assert.ok(result instanceof Promise)
    await assert.rejects(result, vetoError)
    assert.strictEqual(ran, false)
  })
})

describe('Contract sync and removal', () => {
  let logs: ReturnType<typeof captureConsole>
  const added: string[] = []
  const removed: string[] = []
  const removedPermanently: string[] = []
  const onModified = (
    _ids: string[],
    change: { added: string[]; removed: string[]; permanent?: boolean }
  ) => {
    added.push(...change.added)
    const removals = change.permanent ? removedPermanently : removed
    removals.push(...change.removed)
  }
  const errorsLogged = () => logs.logged.filter(({ method }) => method === 'error')

  beforeEach(() => {
    sbp('chelonia/_init')
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      skipActionProcessing: true,
      fetch: stubFetch
    } as Partial<CheloniaConfig>)
    server.contract = makeContract()
    server.later = []
    server.failEvents = false
    added.length = 0
    removed.length = 0
    removedPermanently.length = 0
    sbp('okTurtles.events/on', CONTRACTS_MODIFIED, onModified)
    logs = captureConsole()
  })

  afterEach(() => {
    logs.restore()
    sbp('okTurtles.events/off', CONTRACTS_MODIFIED, onModified)
    sbp('chelonia/_init')
  })

  it('ignores outside events after a first sync that failed before any event', async () => {
    const contract = server.contract!
    const cid = contract.hash()
    server.failEvents = true
    await assert.rejects(
      within(sbp('chelonia/contract/retain', cid, { ephemeral: true }), 'failed retain'),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )

    await within(
      sbp('chelonia/private/in/enqueueHandleEvent', cid, contract.serialize()),
      'outside event'
    )
    assert.deepStrictEqual(added, [])
    assert.strictEqual(rootState().contracts[cid], undefined)

    server.failEvents = false
    await within(sbp('chelonia/contract/retain', cid, { ephemeral: true }), 'retried retain')
    assert.deepStrictEqual(added, [cid])
    assert.strictEqual(rootState().contracts[cid]?.HEAD, cid)
  })

  // A leaked ephemeral reference would keep the contract after this release.
  const assertRemovedOnLastRelease = async (cid: string) => {
    server.failEvents = false
    await within(sbp('chelonia/contract/retain', cid, { ephemeral: true }), 'retain')
    assert.strictEqual(rootState().contracts[cid]?.HEAD, cid)
    await within(sbp('chelonia/contract/release', cid, { ephemeral: true }), 'release')
    assert.strictEqual(rootState().contracts[cid], undefined)
  }

  it('withRetained gives back its references when the first sync fails', async () => {
    const cid = server.contract!.hash()
    server.failEvents = true
    let ran = false
    await assert.rejects(
      within(sbp('chelonia/contract/withRetained', cid, () => { ran = true }), 'withRetained'),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    assert.strictEqual(ran, false)
    await assertRemovedOnLastRelease(cid)
  })

  it('withRetained gives back the references taken before a deleted contract', async () => {
    const cid = server.contract!.hash()
    const contracts: Record<string, unknown> = rootState().contracts
    contracts.gone = null
    await assert.rejects(
      within(sbp('chelonia/contract/withRetained', [cid, 'gone'], () => {}), 'withRetained'),
      { name: 'ChelErrorResourceGone' }
    )
    await assertRemovedOnLastRelease(cid)
  })

  // Leaves a KV mirror entry, so that its removal shows the KV cleanup ran
  const failFirstSync = async (cid: string, ephemeral: boolean) => {
    server.failEvents = true
    await assert.rejects(
      within(sbp('chelonia/contract/retain', cid, { ephemeral }), 'failed retain'),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    const state = rootState()
    state._kv = { ...state._kv, [cid]: {} }
    logs.logged.length = 0
  }

  for (const ephemeral of [false, true]) {
    describe(`after a first sync that failed (ephemeral: ${ephemeral})`, () => {
      it('release removes the contract quietly', async () => {
        const cid = server.contract!.hash()
        await failFirstSync(cid, ephemeral)
        await within(sbp('chelonia/contract/release', cid, { ephemeral }), 'release')
        assert.strictEqual(rootState().contracts[cid], undefined)
        assert.strictEqual(rootState()[cid], undefined)
        assert.strictEqual(rootState()._kv?.[cid], undefined)
        assert.deepStrictEqual(removed, [])
        assert.deepStrictEqual(errorsLogged(), [])
        await assertRemovedOnLastRelease(cid)
      })

      it('a permanent removal leaves a null entry and is announced', async () => {
        const cid = server.contract!.hash()
        await failFirstSync(cid, ephemeral)
        await within(sbp('chelonia/contract/remove', cid, { permanent: true }), 'remove')
        assert.strictEqual(rootState().contracts[cid], null)
        assert.strictEqual(rootState()._kv?.[cid], undefined)
        assert.deepStrictEqual(removedPermanently, [cid])
        assert.deepStrictEqual(errorsLogged(), [])
        await assert.rejects(
          within(sbp('chelonia/contract/retain', cid, { ephemeral: true }), 'retain'),
          { name: 'ChelErrorResourceGone' }
        )
      })
    })
  }

  it('a resync teardown keeps a never-synced contract and logs nothing', async () => {
    const cid = server.contract!.hash()
    await failFirstSync(cid, false)
    sbp('chelonia/private/removeImmediately', cid, { resync: true })
    assert.deepStrictEqual({ ...rootState().contracts[cid] }, { references: 1 })
    assert.strictEqual(rootState()._kv?.[cid], undefined)
    assert.deepStrictEqual([...removed, ...removedPermanently], [])
    assert.deepStrictEqual(errorsLogged(), [])
  })

  it('removing a contract that was never retained changes and logs nothing', async () => {
    await within(sbp('chelonia/contract/release', 'never-retained', { try: true }), 'release')
    await within(sbp('chelonia/contract/remove', 'never-retained'), 'remove')
    assert.ok(!('never-retained' in rootState().contracts))
    assert.deepStrictEqual([...removed, ...removedPermanently], [])
    assert.deepStrictEqual(errorsLogged(), [])
  })

  it('a second permanent removal queued behind the first logs nothing', async () => {
    const cid = server.contract!.hash()
    await within(sbp('chelonia/contract/retain', cid), 'retain')
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const blocked = sbp('chelonia/private/queueEvent', cid, () => gate)
    const removals = [1, 2].map(() => sbp('chelonia/contract/remove', cid, { permanent: true }))
    open()
    await within(Promise.all([blocked, ...removals]), 'removals')
    assert.strictEqual(rootState().contracts[cid], null)
    assert.deepStrictEqual(removedPermanently, [cid])
    assert.deepStrictEqual(errorsLogged(), [])
  })

  describe('when a filter vetoes the contract queue', () => {
    afterEach(() => { vetoedQueue = undefined })

    // Each of these used to resolve (or throw a TypeError) without the work
    const vetoedCalls: Array<[string, string, (cid: string) => Promise<unknown>]> = [
      ['retain of a subscribed contract', '', (cid) => sbp('chelonia/contract/retain', cid, { ephemeral: true })],
      ['a forced sync', '', (cid) => sbp('chelonia/contract/sync', cid)],
      ['the last release', '', (cid) => sbp('chelonia/contract/release', cid)],
      ['an incoming event', '', () => sbp('chelonia/handleEvent', server.contract!.serialize())],
      ['waitPublish', 'publish:', (cid) => sbp('chelonia/contract/waitPublish', cid)]
    ]
    for (const [name, lane, call] of vetoedCalls) {
      it(`${name} rejects`, async () => {
        const cid = server.contract!.hash()
        await within(sbp('chelonia/contract/retain', cid), 'retain')
        vetoedQueue = lane + cid
        await assert.rejects(within(call(cid), name), vetoError)
      })
    }

    it('publishing rejects', async () => {
      const entry = makeContract()
      vetoedQueue = entry.hash()
      await assert.rejects(
        within(sbp('chelonia/private/out/publishEvent', entry, {}, {}), 'publish'),
        vetoError
      )
    })
  })

  describe("the contract type's destructor", () => {
    const calls: Array<{ resync: boolean; state: unknown }> = []
    const resyncFlags = () => calls.map(({ resync }) => resync)
    sbp('sbp/selectors/register', {
      [`test-manifest/${CONTRACT_TYPE}/_cleanup`]: (
        { resync, state }: { resync: boolean; state: unknown }
      ) => { calls.push({ resync, state: structuredClone(state) }) }
    })

    beforeEach(async () => {
      // The manifest map is merged before its preload, which fails (no server)
      await sbp('chelonia/configure', {
        contracts: { manifests: { [CONTRACT_TYPE]: 'test-manifest' } }
      }).catch(() => {})
      calls.length = 0
    })

    const failResync = async (cid: string) => {
      server.failEvents = false
      await within(sbp('chelonia/contract/retain', cid), 'retain')
      server.failEvents = true
      await assert.rejects(
        within(sbp('chelonia/contract/sync', cid, { resync: true }), 'resync'),
        { name: 'ChelErrorUnexpectedHttpResponseCode' }
      )
      assert.deepStrictEqual(resyncFlags(), [true])
    }

    it('runs again at the final removal after a failed re-sync', async () => {
      const cid = server.contract!.hash()
      await failResync(cid)
      const left = structuredClone(rootState()[cid])
      await within(sbp('chelonia/contract/release', cid), 'release')
      assert.deepStrictEqual(resyncFlags(), [true, false])
      assert.deepStrictEqual(calls[1].state, left)
      assert.strictEqual(rootState().contracts[cid], undefined)
      assert.strictEqual(rootState()[cid], undefined)
      // Only the re-sync's teardown announced the removal
      assert.deepStrictEqual(removed, [cid])
    })

    it('runs again at a permanent removal after a failed re-sync, which is announced', async () => {
      const cid = server.contract!.hash()
      await failResync(cid)
      await within(sbp('chelonia/contract/remove', cid, { permanent: true }), 'remove')
      assert.deepStrictEqual(resyncFlags(), [true, false])
      assert.strictEqual(rootState().contracts[cid], null)
      assert.strictEqual(rootState()[cid], undefined)
      assert.deepStrictEqual(removedPermanently, [cid])
    })

    it('is not owed to a later contract with the same ID', async () => {
      const cid = server.contract!.hash()
      await failResync(cid)
      await within(sbp('chelonia/contract/release', cid), 'release')
      calls.length = 0
      await assert.rejects(
        within(sbp('chelonia/contract/retain', cid), 'failed retain'),
        { name: 'ChelErrorUnexpectedHttpResponseCode' }
      )
      await within(sbp('chelonia/contract/release', cid), 'release')
      assert.deepStrictEqual(calls, [])
    })

    it('is not called by a reset, nor after a restart', async () => {
      const cid = server.contract!.hash()
      await failResync(cid)
      const persisted = JSON.parse(JSON.stringify(rootState()))
      await within(sbp('chelonia/reset', persisted), 'reset')
      assert.deepStrictEqual(rootState().contracts[cid], { references: 1 })
      await within(sbp('chelonia/contract/release', cid), 'release')
      assert.deepStrictEqual(resyncFlags(), [true])
      assert.strictEqual(rootState().contracts[cid], undefined)
    })
  })

  describe('chelonia/kv/whenSettled', () => {
    const KEY = 'settles'
    const whenSettled = (cid: string) => sbp('chelonia/kv/whenSettled', cid, KEY)
    const slotUnknown = { name: 'ChelErrorKvSlotUnknown' }
    const httpError = { name: 'ChelErrorUnexpectedHttpResponseCode' }
    // What `chelonia/connect` installs
    const reconcile = (_ids: string[], change: { added: string[]; removed: string[] }) => {
      sbp('chelonia/kv/_onContractsModified', change)
    }
    const defineSlot = (autoLoad: string) => sbp('chelonia/kv/defineSlot', {
      contractType: CONTRACT_TYPE, key: KEY, defaultValue: 0, autoLoad
    })
    beforeEach(() => sbp('okTurtles.events/on', CONTRACTS_MODIFIED, reconcile))
    afterEach(() => sbp('okTurtles.events/off', CONTRACTS_MODIFIED, reconcile))

    it('waits through the first sync for the first load', async () => {
      defineSlot('on-sync')
      const cid = server.contract!.hash()
      const settled = whenSettled(cid)
      await within(sbp('chelonia/contract/retain', cid), 'retain')
      // The stub server has no KV store
      assert.strictEqual(await within(settled, 'whenSettled'), 'error')
    })

    it('rejects once a contract whose first sync failed is released', async () => {
      defineSlot('on-sync')
      const cid = server.contract!.hash()
      server.failEvents = true
      const settled = whenSettled(cid)
      await assert.rejects(within(sbp('chelonia/contract/retain', cid), 'retain'), httpError)
      assert.ok(await isPending(settled))
      await within(sbp('chelonia/contract/release', cid), 'release')
      await assert.rejects(within(settled, 'whenSettled'), slotUnknown)
    })

    it('rejects once withRetained gives back the references of a failed first sync', async () => {
      defineSlot('on-sync')
      const cid = server.contract!.hash()
      server.failEvents = true
      const settled = assert.rejects(within(whenSettled(cid), 'whenSettled'), slotUnknown)
      await assert.rejects(
        within(sbp('chelonia/contract/withRetained', cid, () => {}), 'withRetained'), httpError
      )
      await settled
    })

    it('keeps waiting through a re-sync', async () => {
      defineSlot('never')
      const cid = server.contract!.hash()
      await within(sbp('chelonia/contract/retain', cid), 'retain')
      const settled = whenSettled(cid)
      await within(sbp('chelonia/contract/sync', cid, { resync: true }), 'resync')
      assert.ok(await isPending(settled))
      await sbp('chelonia/kv/sync', cid, KEY).catch(() => {})
      assert.strictEqual(await within(settled, 'whenSettled'), 'error')
    })

    it('keeps waiting after a failed re-sync until the release', async () => {
      defineSlot('never')
      const cid = server.contract!.hash()
      await within(sbp('chelonia/contract/retain', cid), 'retain')
      const settled = whenSettled(cid)
      server.failEvents = true
      await assert.rejects(
        within(sbp('chelonia/contract/sync', cid, { resync: true }), 'resync'), httpError
      )
      assert.ok(await isPending(settled))
      await within(sbp('chelonia/contract/release', cid), 'release')
      await assert.rejects(within(settled, 'whenSettled'), slotUnknown)
    })
  })

  describe('committed heights', () => {
    // Heights passed to the hook that wakes KV height waits
    let notified: number[] | undefined
    let failProcessingAt: number | undefined
    sbp('sbp/filters/selector/add', 'chelonia/kv/_notifyHeight',
      (_domain: string, _selector: string, [, height]: unknown[]) => {
        notified?.push(height as number)
      }
    )
    sbp('sbp/filters/selector/add', 'chelonia/private/in/processMessage',
      (_domain: string, _selector: string, [message]: unknown[]) => {
        if ((message as SPMessage).height() === failProcessingAt) {
          throw new Error('processing failed')
        }
      }
    )
    const throwingListener = (_cid: string, message: SPMessage) => {
      if (message.height() === 1) throw new Error('app listener failed')
    }

    beforeEach(() => { notified = [] })

    afterEach(() => {
      notified = undefined
      failProcessingAt = undefined
      sbp('okTurtles.events/off', EVENT_HANDLED, throwingListener)
      // Restores the default error handler
      sbp('okTurtles.events/_init')
    })

    const syncThreeEvents = async () => {
      const CSK = keygen(EDWARDS25519SHA512BATCH)
      server.contract = makeContract(CSK)
      const action = makeAction(CSK, server.contract)
      server.later = [action, makeAction(CSK, action)]
      const cid = server.contract.hash()
      await within(sbp('chelonia/contract/retain', cid), 'retain')
      assert.strictEqual(rootState().contracts[cid]?.height, 2)
    }

    it('each reach the KV height hook', async () => {
      await syncThreeEvents()
      assert.deepStrictEqual(notified, [0, 1, 2])
      assert.deepStrictEqual(errorsLogged(), [])
    })

    it('reach it when an EVENT_HANDLED listener throws', async () => {
      sbp('okTurtles.events/setErrorHandler', (_event: string, e: unknown) => { throw e })
      sbp('okTurtles.events/on', EVENT_HANDLED, throwingListener)
      await syncThreeEvents()
      assert.deepStrictEqual(notified, [0, 1, 2])
      assert.match(
        String(errorsLogged()[0]?.args[0]),
        /marking the event as processed: app listener failed/
      )
    })

    it('reach it when processing the event fails', async () => {
      failProcessingAt = 1
      await syncThreeEvents()
      assert.deepStrictEqual(notified, [0, 1, 2])
      assert.ok(logs.logged.some(({ args }) => /processing failed/.test(String(args[0]))))
    })
  })
})

describe('chelonia/reset', () => {
  let timeRequests = 0
  let failTeardown = false
  let pubsub: PubSubClient | undefined
  let logs: ReturnType<typeof captureConsole>

  beforeEach(async () => {
    sbp('chelonia/_init')
    timeRequests = 0
    failTeardown = false
    server.contract = makeContract()
    server.later = []
    server.failEvents = false
    logs = captureConsole()
    await sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      connectionOptions: { manual: true },
      skipActionProcessing: true,
      fetch: async (url: string) => {
        if (!url.endsWith('/time')) return stubFetch(url)
        timeRequests++
        return new Response(new Date().toISOString())
      },
      reactiveDel: (obj: Record<string, unknown>, key: string) => {
        if (failTeardown) throw new Error('teardown failed')
        delete obj[key]
      }
    } as unknown as Partial<CheloniaConfig>)
    pubsub = sbp('chelonia/connect')
    await until(() => timeRequests === 1, 'first clock sync')
  })

  afterEach(() => {
    logs.restore()
    pubsub?.destroy()
    sbp('chelonia/private/stopClockSync')
    sbp('chelonia/_init')
  })

  const clockResynced = () => until(() => timeRequests > 1, 'clock sync restart')

  it('restarts clock sync after a reset', async () => {
    await within(sbp('chelonia/reset'), 'reset')
    await clockResynced()
  })

  it('restarts clock sync when postCleanupFn fails', async () => {
    const hook = () => { throw new Error('hook failed') }
    await assert.rejects(within(sbp('chelonia/reset', hook), 'reset'), /hook failed/)
    await clockResynced()
  })

  it('restarts clock sync when the teardown fails', async () => {
    failTeardown = true
    await assert.rejects(within(sbp('chelonia/reset'), 'reset'), /teardown failed/)
    await clockResynced()
  })

  it('lets overlapping resets both finish and restart clock sync', async () => {
    await within(Promise.all([sbp('chelonia/reset'), sbp('chelonia/reset')]), 'resets')
    await clockResynced()
  })

  it('starts a fresh KV session even when the teardown fails', async () => {
    const cid = server.contract!.hash()
    const read = () => sbp('chelonia/kv/read', cid, 'counter')
    sbp('chelonia/kv/defineSlot', {
      contractType: CONTRACT_TYPE, key: 'counter', defaultValue: 0, autoLoad: 'never'
    })
    await within(sbp('chelonia/contract/retain', cid), 'retain')
    assert.strictEqual(read(), 0)
    const settled = assert.rejects(
      within(sbp('chelonia/kv/whenSettled', cid, 'counter'), 'whenSettled'), { name: 'AbortError' }
    )

    failTeardown = true
    await assert.rejects(within(sbp('chelonia/reset'), 'reset'), /teardown failed/)
    assert.throws(read, { name: 'ChelErrorKvSlotUnknown' })
    await settled

    failTeardown = false
    await within(sbp('chelonia/reset'), 'second reset')
    await within(sbp('chelonia/contract/retain', cid), 'retain again')
    assert.strictEqual(read(), 0)
  })

  it('restores KV mirror entries from newState unsettled', async () => {
    const kept = { value: 1, etag: 'e', status: 'loaded', settled: true }
    await within(sbp('chelonia/reset', { _kv: { 'cid-kept': { counter: kept } } }), 'reset')
    assert.deepStrictEqual(rootState()._kv?.['cid-kept']?.counter,
      { value: 1, etag: 'e', status: 'loaded', settled: false })
  })
})
