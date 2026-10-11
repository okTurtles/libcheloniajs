// Tests for what a contract sync leaves behind, however it ends.
//
// A sync adds a contract that isn't subscribed yet to `pending`, so that
// `handleEvent` accepts the events it fetches. Once the sync ends, however
// it ends, `handleEvent` must again only accept events for subscribed
// contracts: otherwise an event delivered from outside (e.g. a web push,
// through `chelonia/handleEvent`) could subscribe a contract nobody
// retains. A contract whose first sync failed must not leave an empty
// entry in `state.contracts` once it is released. A successful sync
// subscribes the contract until it is released. And a KV height recovery
// racing a release must not sync (and so subscribe again) the contract
// that the release removed.
//
// Runs the real selectors against a stubbed server that serves one
// contract: a self-signed OP_CONTRACT (`skipActionProcessing` keeps
// `processMessage` from loading a manifest).

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { ChelErrorKvHeightAhead, isKvHeightAhead } from './errors.js'
import { CONTRACTS_MODIFIED } from './events.js'
import { strToB64 } from './functions.js'
import type { SPMessage } from './SPMessage.js'
import { captureConsole, logged, makeSelfSignedContract, sleep, until, within } from './test-utils.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

const rootState = (): ChelRootState => sbp('chelonia/private/state')
const CONTRACT_TYPE = 'test/sync-contract'

let first: SPMessage
let contractID: string
// Status of `/eventsAfter` responses: 200 serves the contract's events.
let eventsAfterStatus: number
let warnings: unknown[][]
let errors: unknown[][]
let restoreConsole: () => void
let added: string[]
let removed: string[]
let offModified: () => void

// Every `chelonia/kv/_cleanupContractRuntime` call, by contract ID (SBP
// filters can't be removed, so this one is registered once).
const kvCleanups: string[] = []
sbp('sbp/filters/selector/add', 'chelonia/kv/_cleanupContractRuntime', (
  _domain: string, _selector: string, data: unknown[]
) => {
  kvCleanups.push(data[0] as string)
})

beforeEach(() => {
  sbp('chelonia/_init')
  first = makeSelfSignedContract({ type: CONTRACT_TYPE }).message
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
  kvCleanups.length = 0
  added = []
  removed = []
  offModified = sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (
    _: string[], change: { added: string[]; removed: string[] }
  ) => {
    added.push(...change.added)
    removed.push(...change.removed)
  })
  ;({ warnings, errors, restore: restoreConsole } = captureConsole())
})

afterEach(() => {
  offModified()
  restoreConsole()
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
    ignored: logged(warnings, 'ignoring unexpected event'),
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

  it("cleans up the contract's KV runtime once it is released", async () => {
    await failedRetain()
    kvCleanups.length = 0
    await sbp('chelonia/contract/release', contractID)
    assert.deepStrictEqual(kvCleanups, [contractID])
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
    // An entry without a type is expected here: nothing is reported.
    assert.ok(!logged(errors, 'Missing contract name'))
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
    // Its removal is announced once, by the failed re-sync or the release.
    assert.deepStrictEqual(removed, [contractID])
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

// `chelonia/contract/release` drops the reference count at once, but only
// queues the removal on the contract's lane. A KV height recovery (of a
// write, or of a slot's deferred load) that starts in between must not
// sync the contract after the removal ran: that would subscribe it again,
// with no reference left to release it.
describe('a KV height recovery racing a release', () => {
  beforeEach(() => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 50, pendingFallbackMs: 100 })
  })

  afterEach(() => {
    sbp('chelonia/kv/_clearHeightWaits')
    sbp('chelonia/kv/_testSetHeightTimings')
  })

  // Holds the contract's internal lane (e.g. an event being processed), so
  // that the removal `release` queues waits behind it.
  const holdLane = () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    sbp('chelonia/private/queueEvent', contractID, () => gate)
    return { open }
  }

  const retainAndForgetChanges = async () => {
    await sbp('chelonia/contract/retain', contractID)
    added.length = 0
    removed.length = 0
  }

  const assertRemoved = () => {
    assert.deepStrictEqual(removed, [contractID])
    assert.deepStrictEqual(added, [])
    assert.ok(!(contractID in rootState().contracts))
  }

  it("rejects a write's recovery with the original error", async () => {
    await retainAndForgetChanges()
    const lane = holdLane()
    const releasing = sbp('chelonia/contract/release', contractID)
    let attempts = 0
    const recovering = sbp('chelonia/kv/withHeightRecovery', contractID, async () => {
      attempts++
      throw new ChelErrorKvHeightAhead('[test] ahead', {
        cause: { requiredHeight: 5, exact: true, localHeight: 0, etag: null, httpStatus: 412 }
      })
    })
    await sleep(20)
    lane.open()
    await releasing
    await assert.rejects(within(recovering, 'the recovery'), (e: unknown) => isKvHeightAhead(e))
    assert.strictEqual(attempts, 1)
    // The recovery ran, and its sync refused the removed contract.
    assert.ok(logged(warnings, 'failed during height recovery'))
    assertRemoved()
  })

  it("doesn't let a deferred slot load's fallback sync it", async () => {
    // `'never'`: no autoload runs (it would fail for want of the `#sak`
    // secret key, and only the fallback below is under test).
    sbp('chelonia/kv/defineSlot', {
      contractType: CONTRACT_TYPE, key: 'k', defaultValue: {}, autoLoad: 'never'
    })
    await retainAndForgetChanges()
    sbp('chelonia/kv/_onContractsModified', { added: [contractID], removed: [] })
    await sbp('chelonia/queueInvocation', contractID, () => {})
    sbp('chelonia/kv/_registerHeightWait', {
      contractID, key: 'k', requiredHeight: 99, reason: 'load'
    })
    const lane = holdLane()
    const releasing = sbp('chelonia/contract/release', contractID)
    // The 100 ms fallback starts its sync while the removal waits.
    await sleep(200)
    lane.open()
    await releasing
    // Its sync refused the removed contract.
    await until(
      () => logged(warnings, 'failed during height recovery'), 'the fallback never ran its recovery'
    )
    assertRemoved()
  })
})
