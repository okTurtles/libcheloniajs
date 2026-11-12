// `chelonia/kv/set` signs the value with Chelonia's local height of the
// contract, and the server answers 409 unless that is the contract's current
// height (okTurtles/group-income#3176). If Chelonia missed events (e.g.
// the pubsub client lost the contract), every retry used to fail the same way
// and `kv/set` gave up with "kv/set conflict setting KV value" (Group Income's
// read markers and `lastLoggedIn`). Now it syncs the contract (once per call)
// and the retry succeeds.
//
// The relay is the fake from `./pubsub/test-harness.ts` with real `SPMessage`
// chains and a KV store that checks heights like the server.
import { serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { SPMessage } from './SPMessage.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import { REQUEST_TYPE } from './pubsub/index.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, createTestContract,
  handledEvents, keepQueueBusy, kvConflict, localHeight, retainedContract, sleep, staleContract,
  storeSecretKeys, subscribed, waitFor
} from './pubsub/test-harness.js'
import type { TestContract } from './pubsub/test-harness.js'
import type { ChelKvGetResult, ChelRootState, JSONType } from './types.js'

const KEY = 'readUntil'
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient
const handled = handledEvents()

before(async () => {
  server.install()
  logs = captureConsole()
  sbp('chelonia/_init')
  pubsub = await connectChelonia(relay, {
    skipActionProcessing: true,
    // No periodic reconcile: a contract that the pubsub client lost stays
    // lost until a `kv/set` that syncs it subscribes to it again, or the next
    // `chelonia/pubsub/update` (e.g. the next retain)
    pubsubReconcileInterval: 0
  })
})

afterEach(() => {
  relay.onRequest = undefined
  server.onRequest = undefined
})

after(() => {
  // Destroy the client first, so that it doesn't reconnect
  pubsub?.destroy()
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

const rootState = () => sbp('chelonia/private/state') as ChelRootState

// A stale copy of a contract that Chelonia does not want (not retained, so
// not in its subscription set), e.g. state left over from a previous session
function unwantedContract (): TestContract {
  const contract = createTestContract()
  const { contractID } = contract
  assert.equal(relay.append(contract.first), 200)
  relay.postAction(contract, { text: 'missed' })
  storeSecretKeys(contract)
  const key = (id: string, name: string, purpose: string[], data: string) =>
    ({ id, name, purpose, ringLevel: 0, permissions: '*', data, _notBeforeHeight: 0 })
  rootState().contracts[contractID] = {
    HEAD: contractID, height: 0, previousKeyOp: contractID, type: 'test/contract'
  }
  ;(rootState() as unknown as Record<string, unknown>)[contractID] = {
    _vm: {
      authorizedKeys: {
        [contract.CSKid]: key(contract.CSKid, '#csk', ['sig'], serializeKey(contract.CSK, false)),
        [contract.SAKid]: key(contract.SAKid, '#sak', ['sak'], serializeKey(contract.SAK, false))
      }
    }
  }
  return contract
}

// `onconflict` like Group Income's read markers: the same value is written
// again (with the etag from the conflict)
const writeAgain = (data: JSONType) =>
  async ({ etag }: { etag: string | null | undefined }) => [data, etag ?? undefined]

// The statuses of the KV writes among the requests from position `from`, in
// order
const writeStatuses = (from: number) => relay.requests.slice(from)
  .filter(({ method, path }) => method === 'POST' && path.startsWith('/kv/'))
  .map(({ status }) => status)

// The relay answers the next KV write with a 409, and the ones after it as
// usual
function conflictOnce () {
  let first = true
  relay.onRequest = ({ method, path }) => {
    if (!first || method !== 'POST' || !path.startsWith('/kv/')) return
    first = false
    return kvConflict()
  }
}

// The position in `relay.requests` when the pubsub client sends its next SUB
// for `contractID`: `kv/set` syncs before it subscribes again, and the sync
// that the new subscription starts comes after it
function subscribedAgainAt (contractID: string): () => number {
  let at: number | undefined
  server.onRequest = (_conn, msg) => {
    if (msg.type === REQUEST_TYPE.SUB && msg.channelID === contractID) at ??= relay.requests.length
    return undefined
  }
  return () => at ?? relay.requests.length
}

// `chelonia/kv/set`, with the outcome, the statuses of the writes and the
// number of syncs of the contract
async function kvSet (
  contract: TestContract, data: JSONType, options: Record<string, unknown> = {}
) {
  const from = relay.requests.length
  const subAt = subscribedAgainAt(contract.contractID)
  let error: unknown
  try {
    await sbp('chelonia/kv/set', contract.contractID, KEY, data, {
      signingKeyId: contract.CSKid,
      onconflict: writeAgain(data),
      ...options
    })
  } catch (e) {
    error = e
  }
  return {
    error,
    statuses: writeStatuses(from),
    // Number of syncs of the contract before the pubsub client subscribes to
    // it again
    syncs: relay.syncsOf(contract.contractID, from, subAt())
  }
}

const describeError = (e: unknown) =>
  e ? `${(e as Error).name}: ${(e as Error).message}` : 'no error'

const kvValue = async (contractID: string) =>
  ((await sbp('chelonia/kv/get', contractID, KEY)) as ChelKvGetResult | null)?.data

describe('kv/set on a contract whose subscription was lost', () => {
  const data = { messageHash: 'x' }
  let contractID: string
  let reply: SPMessage
  let result: Awaited<ReturnType<typeof kvSet>>

  before(async () => {
    const stale = await staleContract(relay, pubsub)
    contractID = stale.contract.contractID
    reply = stale.reply
    result = await kvSet(stale.contract, data)
  })

  it('succeeds by syncing the contract instead of failing with "kv/set conflict setting KV value"', () => {
    assert.ok(!result.error, `${describeError(result.error)}; statuses ${JSON.stringify(result.statuses)}`)
    assert.deepEqual(result.statuses, [409, 204])
  })

  it('syncs the contract once and processes the event that it missed', () => {
    assert.equal(result.syncs, 1)
    assert.ok(handled.has(reply.hash()))
    assert.equal(localHeight(contractID), relay.headInfo(contractID)!.height)
  })

  it('subscribes the pubsub client to the contract again', async () => {
    assert.ok(await waitFor(subscribed(pubsub, [contractID])), 'not re-subscribed')
  })

  it('has stored the value', async () => {
    assert.deepEqual(await kvValue(contractID), data)
  })
})

describe('kv/set on a contract that Chelonia is up to date with', () => {
  it('writes without syncing', async () => {
    const contract = await retainedContract(relay, pubsub)
    const result = await kvSet(contract, { messageHash: 'y' })
    assert.ok(!result.error, describeError(result.error))
    assert.deepEqual(result.statuses, [204])
    assert.equal(result.syncs, 0)
  })

  it('does not sync if pubsub delivers the missed event before the retry', async () => {
    const contract = await retainedContract(relay, pubsub)
    let first = true
    relay.onRequest = ({ method, path }) => {
      if (!first || method !== 'POST' || !path.startsWith('/kv/')) return
      first = false
      // Another participant posted right before us; the 409 arrives once
      // pubsub has delivered (and Chelonia has processed) that event
      const reply = relay.postAction(contract, { text: 'just before' })
      return waitFor(() => handled.has(reply.hash())).then(kvConflict)
    }
    const result = await kvSet(contract, { messageHash: 'z' })
    assert.ok(!result.error, describeError(result.error))
    assert.deepEqual(result.statuses, [409, 204])
    assert.equal(result.syncs, 0)
  })
})

describe('kv/set when syncing does not help', () => {
  // On a subscribed contract: once the pubsub client lost it, the sync that
  // follows the new subscription would add to the count
  it('syncs at most once per call', async () => {
    const contract = await retainedContract(relay, pubsub)
    // The server keeps answering 409 (e.g. it keeps getting new events)
    relay.onRequest = ({ method, path }) => {
      if (method === 'POST' && path.startsWith('/kv/')) return kvConflict()
    }
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 3 })
    assert.ok(result.error instanceof ChelErrorKvMaxAttempts, describeError(result.error))
    assert.deepEqual(result.statuses, [409, 409, 409])
    assert.equal(result.syncs, 1)
  })

  it('keeps the outcome when the sync fails, and logs it', async () => {
    const contract = await retainedContract(relay, pubsub)
    const logged = logs.fromNow()
    relay.onRequest = ({ method, path }) => {
      if (method === 'POST' && path.startsWith('/kv/')) return kvConflict()
      if (path === `/latestHEADinfo/${contract.contractID}`) {
        return new Response('', { status: 500 })
      }
    }
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 3 })
    assert.ok(result.error instanceof ChelErrorKvMaxAttempts, describeError(result.error))
    assert.deepEqual(result.statuses, [409, 409, 409])
    assert.equal(result.syncs, 1)
    assert.equal(logged.grep(/\[kv\/set\] .*sync/).length, 1)
  })

  it('does not sync on a 412 (the If-Match etag is stale, not the height)', async () => {
    const { contract } = await staleContract(relay, pubsub)
    relay.onRequest = ({ method, path }) => {
      if (method === 'POST' && path.startsWith('/kv/')) return new Response('', { status: 412 })
    }
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 2 })
    assert.ok(result.error instanceof ChelErrorKvMaxAttempts, describeError(result.error))
    assert.deepEqual(result.statuses, [412, 412])
    assert.equal(result.syncs, 0)
  })
})

describe('kv/set on a contract that Chelonia does not want', () => {
  it('does not sync (which would subscribe to it)', async () => {
    const contract = unwantedContract()
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 2 })
    assert.ok(result.error instanceof ChelErrorKvMaxAttempts, describeError(result.error))
    assert.deepEqual(result.statuses, [409, 409])
    assert.equal(result.syncs, 0)
    await sleep(50)
    assert.ok(!pubsub.subscriptionSet.has(contract.contractID))
    assert.ok(!pubsub.pendingOperations.tHas(REQUEST_TYPE.SUB, contract.contractID))
  })

  it('does not sync one released while its queue is busy (the removal waits in the queue)', async (t) => {
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    // No back-off, so that the 409 is handled while the removal waits
    t.mock.method(Math, 'random', () => 0)
    let first = true
    relay.onRequest = ({ method, path }) => {
      if (!first || method !== 'POST' || !path.startsWith('/kv/')) return
      first = false
      keepQueueBusy(contractID, 300)
      sbp('chelonia/contract/release', contractID).catch(() => {})
      return kvConflict()
    }
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 2 })
    await sbp('chelonia/contract/wait', contractID)
    assert.equal(result.syncs, 0)
    assert.equal(localHeight(contractID), undefined, 'the contract is back')
  })
})

describe('chelonia/kv/queuedSet on a contract whose subscription was lost', () => {
  // A deadlock fails it with a timeout
  it('succeeds (the sync runs on the internal queue, the write on the public one)', { timeout: 5000 }, async () => {
    const { contract } = await staleContract(relay, pubsub)
    const from = relay.requests.length
    const subAt = subscribedAgainAt(contract.contractID)
    const data = { messageHash: 'q' }
    await sbp('chelonia/kv/queuedSet', {
      contractID: contract.contractID,
      key: KEY,
      data,
      signingKeyName: '#csk',
      // The test contract has no encryption key, so the value is stored
      // unencrypted
      encryptionKeyName: 'none',
      onconflict: writeAgain(data)
    })
    assert.equal(relay.syncsOf(contract.contractID, from, subAt()), 1)
    assert.deepEqual(await kvValue(contract.contractID), data)
  })
})

describe('chelonia/kv/update (slot API) on a contract whose subscription was lost', () => {
  const SLOT = 'slotValue'

  before(() => {
    sbp('chelonia/kv/defineSlot', {
      contractType: 'test/contract',
      key: SLOT,
      defaultValue: {},
      encryptionKeyName: null,
      signingKeyName: '#csk',
      autoLoad: 'never'
    })
  })

  it('syncs the contract once and writes', async () => {
    const { contract } = await staleContract(relay, pubsub)
    const from = relay.requests.length
    const subAt = subscribedAgainAt(contract.contractID)
    await sbp('chelonia/kv/update', {
      contractID: contract.contractID, key: SLOT, updater: () => ({ n: 1 })
    })
    assert.deepEqual(writeStatuses(from), [409, 204])
    assert.equal(relay.syncsOf(contract.contractID, from, subAt()), 1)
  })
})

describe('a signal that aborts during the back-off after a 409', () => {
  const SLOT = 'abortedValue'

  before(() => {
    sbp('chelonia/kv/defineSlot', {
      contractType: 'test/contract',
      key: SLOT,
      defaultValue: {},
      encryptionKeyName: null,
      signingKeyName: '#csk',
      autoLoad: 'never'
    })
  })

  it('stops kv/update before it syncs, with an AbortError also for a reason that is not an Error', async (t) => {
    const contract = await retainedContract(relay, pubsub)
    conflictOnce()
    t.mock.method(Math, 'random', () => 0.5) // 750 ms back-off
    const from = relay.requests.length
    const controller = new AbortController()
    const update = sbp('chelonia/kv/update', {
      contractID: contract.contractID,
      key: SLOT,
      updater: () => ({ n: 1 }),
      signal: controller.signal
    })
    assert.ok(await waitFor(() => writeStatuses(from)[0] === 409), 'no 409')
    controller.abort('stop')
    await assert.rejects(update, (e) => (e as Error)?.name === 'AbortError')
    assert.equal(relay.syncsOf(contract.contractID, from), 0, 'synced after the abort')
  })
})

// Last: the reset clears the state that the tests above share
describe('chelonia/reset during the back-off of a raw kv/set', () => {
  it('does not sync once chelonia/reset aborted it during the back-off', async (t) => {
    const contract = await retainedContract(relay, pubsub)
    conflictOnce()
    t.mock.method(Math, 'random', () => 0.5) // 750 ms back-off
    const from = relay.requests.length
    const write = kvSet(contract, { messageHash: 'r' })
    assert.ok(await waitFor(() => writeStatuses(from)[0] === 409), 'no 409')
    await sbp('chelonia/reset', () => sleep(1500))
    assert.equal(((await write).error as Error | undefined)?.name, 'AbortError')
    assert.equal(relay.syncsOf(contract.contractID, from), 0, 'synced after the abort')
  })
})
