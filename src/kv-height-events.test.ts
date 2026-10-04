// Height-aware KV handling driven by real contract events (KV-REVAMPED.md
// §3.4). The other height tests move the local height by hand and signal
// it through a test hook; here the height advances only because
// `chelonia/private/in/handleEvent` processes a real `SPMessage`, so these
// tests fail if its height notification (`notifyContractHeight` in
// `applyProcessResult`) is removed or runs before the height is committed.
//
// `skipActionProcessing` keeps `processMessage` from loading a manifest,
// so no contract source has to be served, and `acceptAllMessages` lets the
// contract be created without syncing it from a server.

import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { makeKvServer, sleep, whenSettledWithin, withLocalHeight } from './test-utils.js'
import type { ChelRootState, CheloniaConfig, JSONType } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CTYPE = 'test/kv-height-events'
const MANIFEST = 'test-manifest'
const KEY = 'profile'

const rootState = (): ChelRootState & Record<string, any> => sbp('chelonia/private/state')

let server: ReturnType<typeof makeKvServer>
let csk: ReturnType<typeof keygen>
let contractID: string

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

// Events are handled on the contract's internal queue, as the pubsub and
// sync paths do.
const handle = (message: SPMessage): Promise<void> =>
  sbp('chelonia/private/queueEvent', message.contractID(), [
    'chelonia/private/in/handleEvent', message.contractID(), message.serialize()
  ])

// Creates the contract (a self-signed OP_CONTRACT with a `#csk` and a
// `#sak`) and processes its first message: the local height is 0.
const createContract = async (): Promise<SPMessage> => {
  csk = keygen(EDWARDS25519SHA512BATCH)
  const sak = keygen(EDWARDS25519SHA512BATCH)
  const payload: SPOpContract = {
    type: CTYPE,
    keys: [
      contractKey(csk, '#csk', ['sig'], '*'),
      // A server accounting key may not have permissions.
      contractKey(sak, '#sak', ['sak'], [])
    ]
  }
  const first = SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(csk, payload)],
    manifest: MANIFEST
  })
  contractID = first.contractID()
  rootState().secretKeys = {
    [keyId(csk)]: serializeKey(csk, true),
    [keyId(sak)]: serializeKey(sak, true)
  }
  await handle(first)
  assert.strictEqual(rootState().contracts[contractID]?.height, 0)
  return first
}

// The event after `first`: an (unprocessed) unencrypted action.
const nextEvent = (first: SPMessage): SPMessage => SPMessage.createV1_0({
  contractID,
  previousHEAD: first.hash(),
  previousKeyOp: first.hash(),
  height: first.height() + 1,
  op: [
    SPMessage.OP_ACTION_UNENCRYPTED,
    signedOutgoingDataWithRawKey<SPOpValue, object>(
      csk, { action: `${CTYPE}/noop`, data: {}, meta: {} } as unknown as SPOpValue
    )
  ],
  manifest: MANIFEST
})

// Another device of the same user, which has processed events up to
// `atHeight`, writes `value` (the server's contract is at that height).
const writeAsOtherDevice = async (value: JSONType, atHeight: number) => {
  server.height = atHeight
  await withLocalHeight(contractID, atHeight, () =>
    sbp('chelonia/kv/set', contractID, KEY, value, {
      ifMatch: '*', signingKeyId: keyId(csk)
    })
  )
  server.log.length = 0
}

const originalWarn = console.warn
const originalDebug = console.debug
const originalInfo = console.info
const originalLog = console.log

beforeEach(() => {
  sbp('chelonia/_init')
  server = makeKvServer(0)
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    skipActionProcessing: true,
    acceptAllMessages: true,
    fetch: async (url: string, opts: Parameters<typeof server.handleKv>[1]) =>
      await server.handleKv(new URL(url).pathname, opts) ?? new Response('', { status: 404 })
  } as unknown as Partial<CheloniaConfig>)
  console.warn = () => {}
  console.debug = () => {}
  console.info = () => {}
  console.log = () => {}
})

afterEach(() => {
  sbp('chelonia/kv/_clearHeightWaits')
  sbp('chelonia/kv/_testSetHeightTimings')
  console.warn = originalWarn
  console.debug = originalDebug
  console.info = originalInfo
  console.log = originalLog
})

describe('height waits woken by processed events', () => {
  it('a kv/set waiting on a stale height stamp is re-signed once the event is processed', async () => {
    // Long enough that a wait resolved by its timeout (rather than by the
    // height notification) fails the timing assertion below.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const first = await createContract()
    // The server has processed the next event; this device hasn't yet.
    server.height = 1
    const event = nextEvent(first)
    // The event arrives while the write is in flight.
    let handled: Promise<void> | undefined
    server.onPost = (n) => {
      if (n === 1) setTimeout(() => { handled = handle(event) }, 20)
    }
    const startedAt = Date.now()
    await sbp('chelonia/kv/set', contractID, KEY, { name: 'alice' }, {
      ifMatch: '""', signingKeyId: keyId(csk)
    })
    const elapsed = Date.now() - startedAt
    await handled
    assert.strictEqual(rootState().contracts[contractID].height, 1)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '0'], [204, '1']
    ])
    assert.ok(elapsed < 1500, `the write waited ${elapsed} ms: it wasn't woken by the event`)
  })

  it('a deferred slot load reloads once the event reaching its height is processed', async () => {
    // Keep the fallback sync out of the picture: only the height
    // notification can trigger the reload within the test.
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    const first = await createContract()
    await writeAsOtherDevice({ name: 'bob' }, 1)
    sbp('chelonia/kv/defineSlot', { contractType: CTYPE, key: KEY, defaultValue: {} })
    sbp('chelonia/kv/_onContractsModified', { added: [contractID], removed: [] })
    await sbp('chelonia/queueInvocation', contractID, () => {})
    await sleep(10)
    // The value was written at height 1: the load is deferred.
    assert.strictEqual(sbp('chelonia/kv/status', contractID, KEY), 'loading')
    await handle(nextEvent(first))
    assert.strictEqual(await whenSettledWithin(contractID, KEY, 2000), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', contractID, KEY), { name: 'bob' })
  })
})
