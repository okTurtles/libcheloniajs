import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  keygen,
  keyId,
  serializeKey
} from '@chelonia/crypto'
import type { Key } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { encryptedOutgoingDataWithRawKey } from './encryptedData.js'
import { CONTRACT_HAS_RECEIVED_KEYS } from './events.js'
import { Secret } from './Secret.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue, ProtoSPOpKeyShare } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { captureConsole, until, waitMicrotasks, within } from './test-utils.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

// Decides, for each `chelonia/private/queueEvent` call, whether to veto it
let veto: (queueName: string, invocation: unknown) => boolean = () => false
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName, invocation]: unknown[]) =>
    !veto(queueName as string, invocation)
)

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const CSK = keygen(EDWARDS25519SHA512BATCH)
const CEK = keygen(CURVE25519XSALSA20POLY1305)
// An encryption key of the contract whose secret this client doesn't have
const OTHER_CEK = keygen(CURVE25519XSALSA20POLY1305)

const contractKey = (key: Key, name: string, purpose: SPKey['purpose']): SPKey => ({
  id: keyId(key),
  name,
  purpose,
  ringLevel: 0,
  permissions: '*',
  allowedActions: '*',
  data: serializeKey(key, false),
  _notBeforeHeight: 0,
  _notAfterHeight: undefined
} as SPKey)

const contract = SPMessage.createV1_0({
  contractID: null,
  height: 0,
  op: [
    SPMessage.OP_CONTRACT,
    signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, {
      type: 'test/key-share-veto',
      keys: [
        contractKey(CSK, '#csk', ['sig']),
        contractKey(CEK, '#cek', ['enc']),
        contractKey(OTHER_CEK, '#other', ['enc'])
      ]
    } as SPOpContract)
  ],
  manifest: 'test-manifest'
})
const cid = contract.hash()

const keyShare = (targetContractID: string): SPMessage => {
  const payload: ProtoSPOpKeyShare = {
    contractID: targetContractID,
    keys: [{
      id: keyId(OTHER_CEK),
      meta: {
        private: {
          content: encryptedOutgoingDataWithRawKey(CEK, serializeKey(OTHER_CEK, true))
        }
      }
    } as SPKey]
  }
  return SPMessage.createV1_0({
    contractID: cid,
    previousHEAD: cid,
    previousKeyOp: cid,
    height: 1,
    op: [SPMessage.OP_KEY_SHARE, signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, payload)],
    manifest: 'test-manifest'
  })
}

// Another contract that this client is subscribed to, which the server
// reports as up to date
const subscribedOther = 'subscribed-other-contract'
const subscribedOtherHead = { HEAD: `head-of-${subscribedOther}`, height: 1 }

const stubFetch = async (url: string): Promise<Response> => {
  if (url.endsWith(`/latestHEADinfo/${subscribedOther}`)) {
    return Response.json(subscribedOtherHead)
  }
  if (url.endsWith(`/latestHEADinfo/${cid}`)) {
    return Response.json({ HEAD: cid, height: 0 })
  }
  if (url.includes(`/eventsAfter/${cid}/`)) {
    const event = Buffer.from(JSON.stringify({ message: contract.serialize() })).toString('base64')
    return new Response(JSON.stringify([event]), { headers: { 'shelter-headinfo-height': '0' } })
  }
  return new Response('', { status: 500 })
}

const isInvocationOf = (invocation: unknown, selector: string) =>
  Array.isArray(invocation) && invocation[0] === selector

describe('OP_KEY_SHARE when a filter vetoes the follow-up work', () => {
  let logs: ReturnType<typeof captureConsole>
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  // The CONTRACT_HAS_RECEIVED_KEYS events emitted
  const keysReceived: { contractID: string; sharedWithContractID: string }[] = []
  const onKeysReceived = (
    { contractID, sharedWithContractID }: { contractID: string; sharedWithContractID: string }
  ) => { keysReceived.push({ contractID, sharedWithContractID }) }

  beforeEach(async () => {
    sbp('chelonia/_init')
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      skipActionProcessing: true,
      fetch: stubFetch
    } as Partial<CheloniaConfig>)
    sbp('chelonia/storeSecretKeys', new Secret([{ key: CEK, transient: true }]))
    unhandled.length = 0
    keysReceived.length = 0
    process.on('unhandledRejection', onUnhandled)
    sbp('okTurtles.events/on', CONTRACT_HAS_RECEIVED_KEYS, onKeysReceived)
    logs = captureConsole()
    await within(sbp('chelonia/contract/retain', cid), 'retain')
  })

  afterEach(() => {
    veto = () => false
    logs.restore()
    process.off('unhandledRejection', onUnhandled)
    sbp('okTurtles.events/off', CONTRACT_HAS_RECEIVED_KEYS, onKeysReceived)
    sbp('chelonia/_init')
  })

  // `onQueued` runs once the handling of `message` is queued
  const receive = async (message: SPMessage, onQueued?: () => void) => {
    const handled = sbp('chelonia/private/in/enqueueHandleEvent', cid, message.serialize())
    onQueued?.()
    await within(handled, 'event')
    await waitMicrotasks()
    assert.strictEqual(rootState().contracts[cid]?.HEAD, message.hash())
  }

  it('logs a vetoed postKeyShare for another contract', async () => {
    const other = 'other-contract'
    veto = (queueName) => queueName === other
    await receive(keyShare(other))
    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(
      logs.grep(new RegExp(`postKeyShare for ${other} during OP_KEY_SHARE for ${cid}.*vetoed`))
        .length,
      1
    )
  })

  it('logs a vetoed re-sync of the current contract', async () => {
    rootState().contracts[cid]!.missingDecryptionKeyIds = [keyId(OTHER_CEK)]
    veto = (queueName, invocation) =>
      queueName === cid && isInvocationOf(invocation, 'chelonia/private/in/syncContract')
    await receive(keyShare(cid))
    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(
      logs.grep(new RegExp(`Error during sync for ${cid} during OP_KEY_SHARE.*vetoed`)).length,
      1
    )
  })

  it('logs a vetoed postKeyShare for the current contract', async () => {
    veto = (queueName, invocation) =>
      queueName === cid && isInvocationOf(invocation, 'chelonia/private/postKeyShare')
    await receive(keyShare(cid))
    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(
      logs.grep(new RegExp(`postKeyShare for ${cid} during OP_KEY_SHARE.*vetoed`)).length,
      1
    )
  })

  // Unlike for the current contract, the side effect waits for this re-sync
  it('logs a vetoed re-sync of another contract and goes on with the key share', async () => {
    // This client is subscribed to the other contract and couldn't decrypt
    // part of it without the shared key, so receiving the key re-syncs it
    rootState().contracts[subscribedOther] = {
      ...subscribedOtherHead, previousKeyOp: '', type: 'test/other'
    }
    await within(sbp('chelonia/private/in/sync', subscribedOther), 'sync')
    rootState().contracts[subscribedOther]!.missingDecryptionKeyIds = [keyId(OTHER_CEK)]
    rootState()[subscribedOther] = { _vm: { authorizedKeys: {}, type: 'test/other' } }
    veto = (queueName, invocation) => queueName === subscribedOther &&
      isInvocationOf(invocation, 'chelonia/private/in/syncContract')
    await receive(keyShare(subscribedOther))
    await until(() => keysReceived.length > 0 || unhandled.length > 0, 'the keys event')
    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(
      logs.grep(new RegExp(
        `Error during sync for ${subscribedOther} during OP_KEY_SHARE for ${cid}.*vetoed`
      )).length,
      1
    )
    // The rest of the side effect still ran
    assert.deepStrictEqual(keysReceived, [
      { contractID: subscribedOther, sharedWithContractID: cid }
    ])
    // and the contract wasn't re-synced
    assert.strictEqual(rootState()[subscribedOther]?._volatile?.dirty, true)
  })

  it('logs a vetoed CONTRACT_HAS_RECEIVED_KEYS event', async () => {
    const other = 'other-contract'
    // The event is the only function queued on the current contract's queue
    // after the handling of the message
    await receive(keyShare(other), () => {
      veto = (queueName, invocation) => queueName === cid && typeof invocation === 'function'
    })
    const log = new RegExp(`emitting the CONTRACT_HAS_RECEIVED_KEYS event for ${cid}.*vetoed`)
    await until(() => logs.grep(log).length > 0 || unhandled.length > 0, 'the log')
    assert.deepStrictEqual(unhandled, [])
    assert.strictEqual(logs.grep(log).length, 1)
    assert.deepStrictEqual(logs.grep(/postKeyShare/), [])
    assert.deepStrictEqual(keysReceived, [])
  })
})
