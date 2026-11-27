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
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, handledEvents,
  keepQueueBusy, kvConflict, localHeight, retainedContract, staleContract, subscribed, waitFor
} from './pubsub/test-harness.js'
import type { RelayRequest, TestContract } from './pubsub/test-harness.js'
import { within } from './test-utils.js'
import type { ChelKvGetResult, JSONType } from './types.js'

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

// `onconflict` like Group Income's read markers: the same value is written
// again (with the etag from the conflict)
const writeAgain = (data: JSONType) =>
  async ({ etag }: { etag: string | null | undefined }) => [data, etag ?? undefined]

const isKvWrite = ({ method, path }: RelayRequest) => method === 'POST' && path.startsWith('/kv/')

// The statuses of the KV writes among the requests from position `from`, in
// order
const writeStatuses = (from: number) => relay.requests.slice(from)
  .filter(isKvWrite)
  .map(({ status }) => status)

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

// Holds the next `GET /latestHEADinfo/<contractID>` (i.e. the next sync of the
// contract) until `release()`
function holdSync (contractID: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let held = false
  relay.onRequest = (request) => {
    if (held || request.path !== `/latestHEADinfo/${contractID}`) return
    held = true
    return released.then(() => Response.json(relay.headInfo(contractID)))
  }
  return { release, isHeld: () => held }
}

// How `promise` has settled so far
function settlement (promise: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown } = { settled: false }
  promise.then(() => { state.settled = true }, (e) => {
    state.settled = true
    state.error = e
  })
  return state
}

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
    relay.onRequest = (request) => {
      if (!first || !isKvWrite(request)) return
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
  it('does not sync on a 412 (the If-Match etag is stale, not the height)', async () => {
    const { contract } = await staleContract(relay, pubsub)
    relay.onRequest = (request) => {
      if (isKvWrite(request)) return new Response('', { status: 412 })
    }
    const result = await kvSet(contract, { messageHash: 'x' }, { maxAttempts: 2 })
    assert.ok(result.error instanceof ChelErrorKvMaxAttempts, describeError(result.error))
    assert.deepEqual(result.statuses, [412, 412])
    assert.equal(result.syncs, 0)
  })
})

describe('kv/set on a contract that Chelonia does not want', () => {
  it('does not sync one released while its queue is busy (the removal waits in the queue)', async (t) => {
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    // No back-off, so that the 409 is handled while the removal waits
    t.mock.method(Math, 'random', () => 0)
    let first = true
    relay.onRequest = (request) => {
      if (!first || !isKvWrite(request)) return
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
    await within(sbp('chelonia/kv/update', {
      contractID: contract.contractID, key: SLOT, updater: () => ({ n: 1 })
    }), 'update')
    assert.deepEqual(writeStatuses(from), [409, 204])
    assert.equal(relay.syncsOf(contract.contractID, from, subAt()), 1)
    assert.ok(await waitFor(subscribed(pubsub, [contract.contractID])), 'not re-subscribed')
  })
})

describe('a signal that aborts while kv/set waits for the sync after a 409', () => {
  const SLOT = 'queuedValue'

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

  // A raw `kv/set` on a stale contract, aborted with `reason` while its sync
  // is held. Checks that it ends at once, and that the sync goes on and
  // subscribes the pubsub client again. Returns the error of the write.
  async function abortDuringSync (reason: unknown): Promise<unknown> {
    const { contract } = await staleContract(relay, pubsub)
    const { contractID } = contract
    const hold = holdSync(contractID)
    const from = relay.requests.length
    const controller = new AbortController()
    let outcome: Awaited<ReturnType<typeof kvSet>> | undefined
    kvSet(contract, { messageHash: 'a' }, { signal: controller.signal }).then((result) => {
      outcome = result
    })
    let error: unknown
    try {
      assert.ok(await waitFor(hold.isHeld), 'did not sync')
      controller.abort(reason)
      const result = await waitFor(() => outcome, { timeout: 500 })
      assert.ok(result, 'still waiting for the sync')
      assert.deepEqual(result.statuses, [409])
      error = result.error
    } finally {
      hold.release()
    }
    await sbp('chelonia/contract/wait', contractID)
    assert.equal(localHeight(contractID), relay.headInfo(contractID)!.height, 'not synced')
    assert.deepEqual(writeStatuses(from), [409], 'wrote again after the abort')
    assert.ok(await waitFor(subscribed(pubsub, [contractID])), 'not re-subscribed')
    return error
  }

  it('rejects kv/set before the sync ends, with the signal\'s reason', async (t) => {
    t.mock.method(Math, 'random', () => 0) // No back-off
    const reason = new DOMException('caller abort', 'AbortError')
    const error = await abortDuringSync(reason)
    assert.equal(error, reason, describeError(error))
  })

  it('rejects with an AbortError for a reason that is not an Error', async (t) => {
    t.mock.method(Math, 'random', () => 0)
    const error = await abortDuringSync('stop')
    assert.equal((error as Error)?.name, 'AbortError', describeError(error))
    assert.equal((error as Error)?.message, 'Aborted')
  })

  it('frees the public queue for the next kv/update', async (t) => {
    t.mock.method(Math, 'random', () => 0)
    const { contract } = await staleContract(relay, pubsub)
    const { contractID } = contract
    const hold = holdSync(contractID)
    const from = relay.requests.length
    const controller = new AbortController()
    const first = settlement(sbp('chelonia/kv/update', {
      contractID, key: SLOT, updater: () => ({ n: 1 }), signal: controller.signal
    }))
    const second = settlement(sbp('chelonia/kv/update', {
      contractID, key: SLOT, updater: () => ({ n: 2 })
    }))
    try {
      assert.ok(await waitFor(hold.isHeld), 'did not sync')
      controller.abort()
      assert.ok(await waitFor(() => first.settled, { timeout: 500 }), 'still waiting for the sync')
      assert.equal((first.error as Error)?.name, 'AbortError', describeError(first.error))
      // The next update runs (its write gets a 409 too: the sync is held)
      assert.ok(
        await waitFor(() => writeStatuses(from).length === 2, { timeout: 500 }),
        `the next update did not write: ${JSON.stringify(writeStatuses(from))}`
      )
    } finally {
      hold.release()
    }
    assert.ok(await waitFor(() => second.settled), 'the next update did not end')
    assert.equal(second.error, undefined, describeError(second.error))
    assert.deepEqual(writeStatuses(from), [409, 409, 204])
  })

  it('does not sync if the signal aborts while the sync waits in the queue', async (t) => {
    t.mock.method(Math, 'random', () => 0)
    const contract = await retainedContract(relay, pubsub)
    const { contractID } = contract
    let queueFree = false
    let first = true
    relay.onRequest = (request) => {
      if (!first || !isKvWrite(request)) return
      first = false
      keepQueueBusy(contractID, 300)
      sbp('chelonia/private/queueEvent', contractID, () => { queueFree = true })
      return kvConflict()
    }
    const from = relay.requests.length
    const controller = new AbortController()
    let outcome: Awaited<ReturnType<typeof kvSet>> | undefined
    kvSet(contract, { messageHash: 'q' }, { signal: controller.signal }).then((result) => {
      outcome = result
    })
    assert.ok(await waitFor(() => writeStatuses(from)[0] === 409), 'no 409')
    controller.abort()
    const result = await waitFor(() => outcome)
    assert.equal((result?.error as Error)?.name, 'AbortError', describeError(result?.error))
    assert.ok(!queueFree, 'waited for the queue')
    await sbp('chelonia/contract/wait', contractID)
    assert.equal(relay.syncsOf(contractID, from), 0)
  })
})
