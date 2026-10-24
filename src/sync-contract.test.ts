import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { CONTRACTS_MODIFIED } from './events.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { captureConsole, within } from './test-utils.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedQueue
)

const vetoError = { name: 'ChelErrorUnexpected', message: /vetoed/ }

const rootState = (): ChelRootState => sbp('chelonia/private/state')

// A self-signed contract whose only event is its OP_CONTRACT. With
// `skipActionProcessing`, no contract source has to be served.
const makeContract = (): SPMessage => {
  const CSK = keygen(EDWARDS25519SHA512BATCH)
  const payload: SPOpContract = {
    type: 'test/sync-contract',
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
  const onModified = (_ids: string[], change: { added: string[] }) => added.push(...change.added)

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
})
