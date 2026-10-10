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

import { keyId, serializeKey } from '@chelonia/crypto'
import type { keygen } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { SPMessage } from './SPMessage.js'
import type { SPOpValue } from './SPMessage.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import {
  captureConsole,
  makeKvServer,
  makeSelfSignedContract,
  sleep,
  until,
  whenSettledWithin,
  withLocalHeight
} from './test-utils.js'
import type { ChelRootState, CheloniaConfig, JSONType } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CTYPE = 'test/kv-height-events'
const MANIFEST = 'test-manifest'
const KEY = 'profile'

const rootState = (): ChelRootState & Record<string, any> => sbp('chelonia/private/state')

let server: ReturnType<typeof makeKvServer>
let csk: ReturnType<typeof keygen>
let contractID: string
let restoreConsole: () => void

// Events are handled on the contract's internal queue, as the pubsub and
// sync paths do.
const handle = (message: SPMessage): Promise<void> =>
  sbp('chelonia/private/queueEvent', message.contractID(), [
    'chelonia/private/in/handleEvent', message.contractID(), message.serialize()
  ])

// Creates the contract (a self-signed OP_CONTRACT with a `#csk` and a
// `#sak`) and processes its first message: the local height is 0.
const createContract = async (): Promise<SPMessage> => {
  const created = makeSelfSignedContract({ type: CTYPE, manifest: MANIFEST })
  const first = created.message
  csk = created.csk
  contractID = first.contractID()
  rootState().secretKeys = {
    [keyId(csk)]: serializeKey(csk, true),
    [keyId(created.sak)]: serializeKey(created.sak, true)
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
  restoreConsole = captureConsole().restore
})

afterEach(() => {
  sbp('chelonia/kv/_clearHeightWaits')
  sbp('chelonia/kv/_testSetHeightTimings')
  restoreConsole()
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
    await until(() => server.gets().length === 1, 'the first load never issued its GET')
    // The value was written at height 1: the load is deferred. A load that
    // is merely in flight is 'loading' too, so check that it ran once and
    // isn't retried until the height is reached.
    assert.strictEqual(sbp('chelonia/kv/status', contractID, KEY), 'loading')
    // Only for the negative check: give a retry the time to show up.
    await sleep(100)
    assert.strictEqual(server.gets().length, 1)
    await handle(nextEvent(first))
    assert.strictEqual(await whenSettledWithin(contractID, KEY, 2000), 'loaded')
    assert.strictEqual(server.gets().length, 2)
    assert.deepStrictEqual(sbp('chelonia/kv/read', contractID, KEY), { name: 'bob' })
  })
})
