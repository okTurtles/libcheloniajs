// Tests for what a contract sync leaves behind when it doesn't complete.
//
// A sync adds a contract that isn't subscribed yet to `pending`, so that
// `handleEvent` accepts the events it fetches. Once the sync ends, however
// it ends, `handleEvent` must again only accept events for subscribed
// contracts: otherwise an event delivered from outside (e.g. a web push,
// through `chelonia/handleEvent`) could subscribe a contract nobody
// retains. And a contract whose first sync failed must not leave an empty
// entry in `state.contracts` once it is released.
//
// Runs the real selectors against a stubbed server that serves one
// contract: a self-signed OP_CONTRACT (`skipActionProcessing` keeps
// `processMessage` from loading a manifest).

import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { CONTRACTS_MODIFIED } from './events.js'
import { strToB64 } from './functions.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const contractKey = (
  key: ReturnType<typeof keygen>,
  name: string,
  purpose: string[],
  permissions: '*' | string[]
) => ({
  id: keyId(key),
  name,
  purpose,
  ringLevel: 0,
  permissions,
  ...(permissions === '*' && { allowedActions: '*' }),
  data: serializeKey(key, false)
}) as SPKey

const firstMessage = (): SPMessage => {
  const csk = keygen(EDWARDS25519SHA512BATCH)
  const sak = keygen(EDWARDS25519SHA512BATCH)
  const payload: SPOpContract = {
    type: 'test/sync-contract',
    keys: [
      contractKey(csk, '#csk', ['sig'], '*'),
      // A server accounting key may not have permissions.
      contractKey(sak, '#sak', ['sak'], [])
    ]
  }
  return SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(csk, payload)],
    manifest: 'test-manifest'
  })
}

let first: SPMessage
let contractID: string
// Status of `/eventsAfter` responses: 200 serves the contract's events.
let eventsAfterStatus: number
let warnings: string[]
let added: string[]
let removed: string[]
let offModified: () => void

const originalWarn = console.warn
const originalError = console.error
const originalDebug = console.debug
const originalInfo = console.info
const originalLog = console.log

beforeEach(() => {
  sbp('chelonia/_init')
  first = firstMessage()
  contractID = first.contractID()
  eventsAfterStatus = 200
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    skipActionProcessing: true,
    fetch: async (url: string) => {
      const { pathname } = new URL(url)
      if (pathname.startsWith('/latestHEADinfo/')) {
        return new Response(JSON.stringify({ HEAD: first.hash(), height: 0 }), { status: 200 })
      }
      if (pathname.startsWith('/eventsAfter/')) {
        if (eventsAfterStatus !== 200) {
          return new Response('Internal Server Error', { status: eventsAfterStatus })
        }
        const event = strToB64(JSON.stringify({ message: first.serialize() }))
        return new Response(`[${JSON.stringify(event)}]`, {
          status: 200, headers: { 'shelter-headinfo-height': '0' }
        })
      }
      return new Response('', { status: 404 })
    }
  } as unknown as Partial<CheloniaConfig>)
  warnings = []
  added = []
  removed = []
  offModified = sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (
    _: string[], change: { added: string[]; removed: string[] }
  ) => {
    added.push(...change.added)
    removed.push(...change.removed)
  })
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])) }
  console.error = () => {}
  console.debug = () => {}
  console.info = () => {}
  console.log = () => {}
})

afterEach(() => {
  offModified()
  console.warn = originalWarn
  console.error = originalError
  console.debug = originalDebug
  console.info = originalInfo
  console.log = originalLog
  sbp('chelonia/private/stopClockSync')
})

// The contract's first message, delivered from outside Chelonia's own
// connection. Only a subscribed contract (or one being synced) may accept
// it.
const deliverFromOutside = async () => {
  warnings.length = 0
  added.length = 0
  await sbp('chelonia/handleEvent', first.serialize())
  return {
    ignored: warnings.some((w) => w.includes('ignoring unexpected event')),
    subscribed: added.includes(contractID)
  }
}

// `retain` whose first sync fails fetching the contract's events, after
// `latestHEADinfo` succeeded.
const failedRetain = async () => {
  eventsAfterStatus = 500
  await assert.rejects(
    sbp('chelonia/contract/retain', contractID),
    { name: 'ChelErrorUnexpectedHttpResponseCode' }
  )
  eventsAfterStatus = 200
}

describe('a first sync that fails', () => {
  it('leaves nothing pending', async () => {
    await failedRetain()
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
    assert.strictEqual(rootState().contracts[contractID]?.type, undefined)
  })

  it('leaves no entry once the contract is released', async () => {
    await failedRetain()
    assert.deepStrictEqual({ ...rootState().contracts[contractID] }, { references: 1 })
    await sbp('chelonia/contract/release', contractID)
    assert.ok(!(contractID in rootState().contracts))
    assert.ok(!(contractID in rootState()))
    // It was never announced as added, so its removal isn't announced.
    assert.deepStrictEqual(removed, [])
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
    assert.ok(!(contractID in rootState().contracts))
  })

  it('leaves a null entry once the contract is removed permanently', async () => {
    await failedRetain()
    await sbp('chelonia/contract/remove', contractID, { permanent: true })
    assert.strictEqual(rootState().contracts[contractID], null)
    await assert.rejects(
      sbp('chelonia/contract/retain', contractID), { name: 'ChelErrorResourceGone' }
    )
  })

  it('can be retried', async () => {
    await failedRetain()
    await sbp('chelonia/contract/sync', contractID)
    assert.strictEqual(rootState().contracts[contractID]?.HEAD, first.hash())
    assert.deepStrictEqual(added, [contractID])
  })
})

describe('a re-sync that fails', () => {
  it('keeps the reference count of a contract whose first sync failed', async () => {
    await failedRetain()
    eventsAfterStatus = 500
    await assert.rejects(
      sbp('chelonia/contract/sync', contractID, { resync: true }),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    eventsAfterStatus = 200
    // Still retained: releasing it removes it.
    assert.deepStrictEqual({ ...rootState().contracts[contractID] }, { references: 1 })
    await sbp('chelonia/contract/release', contractID)
    assert.ok(!(contractID in rootState().contracts))
  })
  it('leaves no state once the contract is released', async () => {
    await sbp('chelonia/contract/retain', contractID)
    eventsAfterStatus = 500
    await assert.rejects(
      sbp('chelonia/contract/sync', contractID, { resync: true }),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    // The re-sync cleared the contract (keeping its reference count) and
    // unsubscribed it.
    assert.strictEqual(rootState().contracts[contractID]?.type, undefined)
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
    await sbp('chelonia/contract/release', contractID)
    assert.ok(!(contractID in rootState().contracts))
    assert.ok(!(contractID in rootState()))
  })
})

describe('a sync that succeeds', () => {
  it('subscribes the contract, and releasing it unsubscribes it', async () => {
    await sbp('chelonia/contract/retain', contractID)
    assert.strictEqual(rootState().contracts[contractID]?.HEAD, first.hash())
    assert.deepStrictEqual(added, [contractID])
    await sbp('chelonia/contract/release', contractID)
    assert.deepStrictEqual(removed, [contractID])
    assert.ok(!(contractID in rootState().contracts))
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
  })

  // The contract is restored from persisted state, e.g. at login, and the
  // server has nothing new: the sync subscribes it without fetching events.
  it('leaves nothing pending when the contract was already up to date', async () => {
    await sbp('chelonia/contract/retain', contractID)
    const persisted = JSON.parse(JSON.stringify({
      contracts: { [contractID]: rootState().contracts[contractID] },
      [contractID]: rootState()[contractID]
    }))
    await sbp('chelonia/reset', persisted)
    added.length = 0
    // Up to date: the sync must subscribe the contract without fetching
    // events (an `/eventsAfter` request would fail).
    eventsAfterStatus = 500
    await sbp('chelonia/contract/sync', contractID)
    eventsAfterStatus = 200
    assert.deepStrictEqual(added, [contractID])
    await sbp('chelonia/contract/release', contractID)
    assert.ok(!(contractID in rootState().contracts))
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
  })
})
