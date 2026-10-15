// Tests for what a contract sync leaves behind, however it ends.
//
// A sync adds a contract that isn't subscribed yet to `pending`, so that
// `handleEvent` accepts the events it fetches. Once the sync ends, however
// it ends, `handleEvent` must again only accept events for subscribed
// contracts: otherwise an event delivered from outside (e.g. a web push,
// through `chelonia/handleEvent`) could subscribe a contract nobody
// retains. A contract whose first sync failed must not leave an empty
// entry in `state.contracts` once it is released. A successful sync
// subscribes the contract until it is released. A KV height recovery
// racing a release must not sync (and so subscribe again) the contract
// that the release removed, and one racing a re-sync must wait for it.
// `chelonia/kv/whenSettled` keeps waiting across a re-sync, and rejects
// once the contract turns out to have no such slot, or is removed.
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
import {
  captureConsole,
  logged,
  makeSelfSignedContract,
  settledOr,
  sleep,
  until,
  whenContractSlotSettledWithin,
  within
} from './test-utils.js'
import type { ChelRootState, CheloniaConfig } from './types.js'

const rootState = (): ChelRootState => sbp('chelonia/private/state')
const CONTRACT_TYPE = 'test/sync-contract'

let first: SPMessage
let contractID: string
// Status of `/eventsAfter` responses: 200 serves the contract's events.
let eventsAfterStatus: number
// Awaited before each `/latestHEADinfo` response, when set.
let onLatestHEADinfo: (() => Promise<void>) | undefined
let warnings: unknown[][]
let errors: unknown[][]
let restoreConsole: () => void
let added: string[]
let removed: string[]
// The removals announced as permanent.
let removedPermanently: string[]
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
  onLatestHEADinfo = undefined
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    skipActionProcessing: true,
    fetch: async (url: string) => {
      const { pathname } = new URL(url)
      if (pathname.startsWith('/latestHEADinfo/')) {
        await onLatestHEADinfo?.()
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
  removedPermanently = []
  offModified = sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (
    _: string[], change: { added: string[]; removed: string[]; permanent?: boolean }
  ) => {
    added.push(...change.added)
    removed.push(...change.removed)
    if (change.permanent) removedPermanently.push(...change.removed)
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

  it('leaves a null entry once the contract is removed permanently, and announces it', async () => {
    await failedRetain()
    await sbp('chelonia/contract/remove', contractID, { permanent: true })
    assert.strictEqual(rootState().contracts[contractID], null)
    // A store copy of `state.contracts` records the `null` too.
    assert.deepStrictEqual(removedPermanently, [contractID])
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
    assert.ok(!(contractID in rootState()))
  })

  it('leaves no state once the contract is released', async () => {
    await sbp('chelonia/contract/retain', contractID)
    eventsAfterStatus = 500
    await assert.rejects(
      sbp('chelonia/contract/sync', contractID, { resync: true }),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    // The re-sync cleared the contract (keeping its reference count),
    // unsubscribed it, and announced its removal.
    assert.strictEqual(rootState().contracts[contractID]?.type, undefined)
    assert.deepStrictEqual(removed, [contractID])
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
    await sbp('chelonia/contract/release', contractID)
    assert.ok(!(contractID in rootState().contracts))
    assert.ok(!(contractID in rootState()))
    // The release doesn't announce it a second time.
    assert.deepStrictEqual(removed, [contractID])
  })

  it('announces a permanent removal once the contract is removed for good', async () => {
    await sbp('chelonia/contract/retain', contractID)
    eventsAfterStatus = 500
    await assert.rejects(
      sbp('chelonia/contract/sync', contractID, { resync: true }),
      { name: 'ChelErrorUnexpectedHttpResponseCode' }
    )
    eventsAfterStatus = 200
    assert.deepStrictEqual(removedPermanently, [])
    await sbp('chelonia/contract/remove', contractID, { permanent: true })
    assert.strictEqual(rootState().contracts[contractID], null)
    assert.deepStrictEqual(removedPermanently, [contractID])
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
    sbp('chelonia/kv/_testClearHeightWaits')
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
    await within(releasing, 'the release')
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
    // Once the fallback has fired, its recovery sync is queued behind the
    // removal.
    await until(
      () => sbp('chelonia/kv/_testHeightWait', contractID, 'k')?.fallbackArmed === false,
      'the fallback fired'
    )
    lane.open()
    await within(releasing, 'the release')
    // Runs after the recovery's sync task, queued earlier on the same lane.
    await within(sbp('chelonia/private/queueEvent', contractID, () => {}), 'the lane')
    assertRemoved()
    // Its sync refused the removed contract.
    await until(() => logged(warnings, 'failed during height recovery'), 'the refusal warning')
  })
})

// A resync (`chelonia/contract/sync` with `resync`, or a dirty contract)
// clears the contract and unsubscribes it until its first event is applied
// again, though the contract is still retained. A height recovery that
// starts meanwhile must wait for it rather than give up on a released
// contract.
describe('a KV height recovery racing a resync', () => {
  beforeEach(() => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 50 })
  })

  afterEach(() => {
    sbp('chelonia/kv/_testSetHeightTimings')
  })

  it('syncs after the resync, and retries', async () => {
    await sbp('chelonia/contract/retain', contractID)
    // Holds the resync once it has unsubscribed the contract.
    let releaseResync!: () => void
    const resyncHeld = new Promise<void>((resolve) => { releaseResync = resolve })
    let resyncStarted = false
    onLatestHEADinfo = async () => {
      onLatestHEADinfo = undefined
      resyncStarted = true
      await resyncHeld
    }
    const resyncing = sbp('chelonia/contract/sync', contractID, { resync: true })
    try {
      await until(() => resyncStarted, 'the resync started')
      assert.ok(!rootState().contracts[contractID]?.type)
      let attempts = 0
      const recovering = sbp('chelonia/kv/withHeightRecovery', contractID, async () => {
        if (++attempts > 1) return 'written'
        throw new ChelErrorKvHeightAhead('[test] ahead', {
          cause: { requiredHeight: 0, exact: false, localHeight: 0, etag: null, httpStatus: 409 }
        })
      })
      releaseResync()
      assert.strictEqual(await within(recovering, 'the recovery'), 'written')
      assert.strictEqual(attempts, 2)
      await within(resyncing, 'the resync')
      assert.strictEqual(rootState().contracts[contractID]?.HEAD, first.hash())
    } finally {
      releaseResync()
      await within(resyncing, 'the resync').catch(() => {})
    }
  })
})

// `chelonia/kv/whenSettled` called before the contract has synced, or
// while its slot hasn't settled, across what happens to the contract.
describe("whenSettled across a contract's lifecycle", () => {
  let offReconcile: () => void

  // What `chelonia/connect` mounts: slots are reconciled as contracts are
  // added, and cleaned up as they are removed.
  beforeEach(() => {
    offReconcile = sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (_: string[], change: unknown) => {
      sbp('chelonia/kv/_onContractsModified', change)
    })
  })

  afterEach(() => {
    offReconcile()
  })

  const defineSlot = (contractType: string, def: Record<string, unknown> = {}) =>
    sbp('chelonia/kv/defineSlot', { contractType, key: 'k', defaultValue: {}, ...def })

  // How `whenSettled` ends, within 3 s (a missed deadline is a
  // `TimeoutError`).
  const settling = (): Promise<{ status?: string; error?: Error }> =>
    whenContractSlotSettledWithin(contractID, 'k')
      .then((status) => ({ status }), (error: Error) => ({ error }))

  it("rejects once the contract's type turns out to have no such slot", async () => {
    defineSlot('test/other-type')
    const outcome = settling()
    await sbp('chelonia/contract/retain', contractID)
    const { error } = await outcome
    assert.strictEqual(error?.name, 'ChelErrorKvSlotUnknown')
    assert.match(error.message, /isn't defined for this contract's type/)
    await sbp('chelonia/contract/release', contractID)
  })

  it('rejects when the contract is released before its first sync succeeded', async () => {
    defineSlot(CONTRACT_TYPE)
    const outcome = settling()
    await failedRetain()
    await sbp('chelonia/contract/release', contractID)
    const { error } = await outcome
    assert.strictEqual(error?.name, 'ChelErrorKvSlotUnknown')
    assert.match(error.message, /was removed with its contract/)
  })

  it('keeps waiting across a resync, and settles once the slot loads again', async () => {
    // Loaded explicitly below, once the resync is done.
    defineSlot(CONTRACT_TYPE, { autoLoad: 'never' })
    await sbp('chelonia/contract/retain', contractID)
    assert.strictEqual(sbp('chelonia/kv/status', contractID, 'k'), 'non-init')
    const outcome = settling()
    await sbp('chelonia/contract/sync', contractID, { resync: true })
    assert.ok(removed.includes(contractID))
    assert.strictEqual(await settledOr(outcome, 20, 'pending'), 'pending')
    // The slot is active again. (Its load fails here, for want of the
    // contract's `#sak` key: that settles it too.)
    await sbp('chelonia/kv/sync', contractID, 'k').catch(() => {})
    const { status } = await outcome
    assert.strictEqual(status, sbp('chelonia/kv/settledStatus', contractID, 'k'))
    assert.strictEqual(status, 'error')
    await sbp('chelonia/contract/release', contractID)
  })
})
