import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { CONTRACTS_MODIFIED } from './events.js'
import type { PubSubClient } from './pubsub/index.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { captureConsole, until, within } from './test-utils.js'
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
const makeContract = (): SPMessage => {
  const CSK = keygen(EDWARDS25519SHA512BATCH)
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

const server: { contract?: SPMessage; failEvents: boolean } = { failEvents: false }

const stubFetch = async (url: string): Promise<Response> => {
  const { contract } = server
  const cid = contract?.hash()
  if (contract && url.endsWith(`/latestHEADinfo/${cid}`)) {
    return Response.json({ HEAD: cid, height: 0 })
  }
  if (contract && url.includes(`/eventsAfter/${cid}/`) && !server.failEvents) {
    const event = Buffer.from(JSON.stringify({ message: contract.serialize() })).toString('base64')
    return new Response(JSON.stringify([event]), { headers: { 'shelter-headinfo-height': '0' } })
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
})

describe('chelonia/reset and clock sync', () => {
  let timeRequests = 0
  let failTeardown = false
  let pubsub: PubSubClient | undefined

  beforeEach(async () => {
    sbp('chelonia/_init')
    timeRequests = 0
    failTeardown = false
    await sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      connectionOptions: { manual: true },
      fetch: async (url: string) => {
        if (!url.endsWith('/time')) return new Response('', { status: 500 })
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
})
