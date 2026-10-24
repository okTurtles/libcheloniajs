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
import { Secret } from './Secret.js'
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
import type { ChelRootState, CheloniaConfig, ContractsModifiedChange } from './types.js'

const rootState = (): ChelRootState => sbp('chelonia/private/state')
const CONTRACT_TYPE = 'test/sync-contract'

let first: SPMessage
// The contract's server accounting key, which signs KV requests.
let sak: ReturnType<typeof makeSelfSignedContract>['sak']
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
  ;({ message: first, sak } = makeSelfSignedContract({ type: CONTRACT_TYPE }))
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
    _: string[], change: ContractsModifiedChange
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
  await within(sbp('chelonia/handleEvent', first.serialize()), 'the delivered event')
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
    within(sbp('chelonia/contract/retain', contractID), 'the failed retain'),
    { name: 'ChelErrorUnexpectedHttpResponseCode' }
  )
  eventsAfterStatus = 200
}

// Whether a warning was logged with `text` in any of its arguments (e.g. in
// the error that follows the message).
const warnedWith = (text: string): boolean =>
  warnings.some((args) => args.some((arg) => String(arg).includes(text)))

// The awaits below fail rather than hang the file.
const retain = (options?: object) =>
  within(sbp('chelonia/contract/retain', contractID, options), 'the retain')
const release = (options?: object) =>
  within(sbp('chelonia/contract/release', contractID, options), 'the release')
const sync = () => within(sbp('chelonia/contract/sync', contractID), 'the sync')

// A re-sync of a retained contract that fails fetching the contract's
// events.
const failedResync = async () => {
  eventsAfterStatus = 500
  await assert.rejects(
    within(sbp('chelonia/contract/sync', contractID, { resync: true }), 'the failed resync'),
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
    await release()
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
    await release()
    assert.deepStrictEqual(kvCleanups, [contractID])
  })

  it('leaves a null entry once the contract is removed permanently, and announces it', async () => {
    await failedRetain()
    await within(sbp('chelonia/contract/remove', contractID, { permanent: true }), 'the removal')
    assert.strictEqual(rootState().contracts[contractID], null)
    // A store copy of `state.contracts` records the `null` too.
    assert.deepStrictEqual(removedPermanently, [contractID])
    await assert.rejects(retain(), { name: 'ChelErrorResourceGone' })
  })

  // An ephemeral retain creates no entry: the permanent removal still
  // records `null`, and announces it, as for a persistent retain.
  it('leaves a null entry once an ephemerally retained contract is removed permanently', async () => {
    eventsAfterStatus = 500
    await assert.rejects(retain({ ephemeral: true }), { name: 'ChelErrorUnexpectedHttpResponseCode' })
    eventsAfterStatus = 200
    assert.ok(!(contractID in rootState().contracts))
    await within(sbp('chelonia/contract/remove', contractID, { permanent: true }), 'the removal')
    assert.strictEqual(rootState().contracts[contractID], null)
    assert.deepStrictEqual(removedPermanently, [contractID])
    assert.ok(!logged(errors, 'Missing contract name'))
    await assert.rejects(retain({ ephemeral: true }), { name: 'ChelErrorResourceGone' })
  })

  it('can be retried', async () => {
    await failedRetain()
    await sync()
    assert.strictEqual(rootState().contracts[contractID]?.HEAD, first.hash())
    assert.deepStrictEqual(added, [contractID])
  })
})

describe('a re-sync that fails', () => {
  it('keeps the reference count of a contract whose first sync failed', async () => {
    await failedRetain()
    await failedResync()
    // Still retained: releasing it removes it.
    assert.deepStrictEqual({ ...rootState().contracts[contractID] }, { references: 1 })
    // An entry without a type is expected here: nothing is reported.
    assert.ok(!logged(errors, 'Missing contract name'))
    await release()
    assert.ok(!(contractID in rootState().contracts))
    assert.ok(!(contractID in rootState()))
  })

  it('leaves no state once the contract is released', async () => {
    await retain()
    await failedResync()
    // The re-sync cleared the contract (keeping its reference count),
    // unsubscribed it, and announced its removal.
    assert.strictEqual(rootState().contracts[contractID]?.type, undefined)
    assert.deepStrictEqual(removed, [contractID])
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
    await release()
    assert.ok(!(contractID in rootState().contracts))
    assert.ok(!(contractID in rootState()))
    // The release doesn't announce it a second time.
    assert.deepStrictEqual(removed, [contractID])
  })

  it('announces a permanent removal once the contract is removed for good', async () => {
    await retain()
    await failedResync()
    assert.deepStrictEqual(removedPermanently, [])
    await within(sbp('chelonia/contract/remove', contractID, { permanent: true }), 'the removal')
    assert.strictEqual(rootState().contracts[contractID], null)
    assert.deepStrictEqual(removedPermanently, [contractID])
  })
})

describe('a sync that succeeds', () => {
  it('subscribes the contract, and releasing it unsubscribes it', async () => {
    await retain()
    assert.strictEqual(rootState().contracts[contractID]?.HEAD, first.hash())
    assert.deepStrictEqual(added, [contractID])
    await release()
    assert.deepStrictEqual(removed, [contractID])
    assert.ok(!(contractID in rootState().contracts))
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
  })

  // The contract is restored from persisted state, e.g. at login, and the
  // server has nothing new: the sync subscribes it without fetching events.
  it('leaves nothing pending when the contract was already up to date', async () => {
    await retain()
    const persisted = JSON.parse(JSON.stringify({
      contracts: { [contractID]: rootState().contracts[contractID] },
      [contractID]: rootState()[contractID]
    }))
    await within(sbp('chelonia/reset', persisted), 'chelonia/reset')
    added.length = 0
    // Up to date: the sync must subscribe the contract without fetching
    // events (an `/eventsAfter` request would fail).
    eventsAfterStatus = 500
    await sync()
    eventsAfterStatus = 200
    assert.deepStrictEqual(added, [contractID])
    await release()
    assert.ok(!(contractID in rootState().contracts))
    assert.deepStrictEqual(await deliverFromOutside(), { ignored: true, subscribed: false })
  })
})

// A contract with no `state.contracts` entry (one that was never retained
// here, or only ephemerally) is removed quietly.
describe('a removal of a contract that has no entry', () => {
  const OTHER_ID = 'zSyncContractTestNeverRetained'
  const lane = () =>
    within(sbp('chelonia/private/queueEvent', OTHER_ID, () => {}), 'the lane')

  it('logs nothing for a `try` release of a contract that was never retained', async () => {
    await within(sbp('chelonia/contract/release', [OTHER_ID], { try: true }), 'the release')
    await lane()
    assert.deepStrictEqual(errors, [])
  })

  it('logs nothing for the removal of a contract that was never retained', async () => {
    await within(sbp('chelonia/contract/remove', OTHER_ID), 'the removal')
    await lane()
    assert.deepStrictEqual(errors, [])
    assert.ok(!(OTHER_ID in rootState().contracts))
  })
})

// The `_cleanup` destructor of the contract's type, as `removeImmediately`
// looks it up (`${manifestHash}/${contractName}/_cleanup`), with a made-up
// manifest hash, configured once the first sync is done (that sync then
// needs no manifest). A re-sync calls it with `resync: true`; the final
// removal with `resync: false`, also after a re-sync that failed.
const MANIFEST = 'zSyncContractTestManifest'
// `chelonia/configure` preloads the manifests it is given: there is none to
// load here.
let skipManifestLoads = false
sbp('sbp/filters/selector/add', 'chelonia/private/loadManifest', () => {
  if (skipManifestLoads) return false
})
const destructorCalls: Array<{ resync: boolean; state: unknown }> = []
sbp('sbp/selectors/register', {
  [`${MANIFEST}/${CONTRACT_TYPE}/_cleanup`]: (
    { resync, state }: { resync: boolean; state: unknown }
  ) => {
    destructorCalls.push({ resync, state: JSON.parse(JSON.stringify(state ?? null)) })
  }
})

describe("a contract's destructor", () => {
  const retainWithDestructor = async () => {
    await retain()
    skipManifestLoads = true
    try {
      await sbp('chelonia/configure', { contracts: { manifests: { [CONTRACT_TYPE]: MANIFEST } } })
    } finally {
      skipManifestLoads = false
    }
    destructorCalls.length = 0
  }
  const resyncs = (statuses: number[]) => statuses.reduce(async (previous, status) => {
    await previous
    if (status === 200) {
      await within(sbp('chelonia/contract/sync', contractID, { resync: true }), 'the resync')
    } else {
      await failedResync()
    }
  }, Promise.resolve())
  const resyncCalls = () => destructorCalls.map(({ resync }) => ({ resync }))

  it('is called with resync: false when the contract is released', async () => {
    await retainWithDestructor()
    await release()
    assert.deepStrictEqual(resyncCalls(), [{ resync: false }])
  })

  // After a re-sync that failed, the state the re-sync left (only
  // `_volatile.watch` would remain), not the one before it: a destructor
  // that releases the contracts it finds in its state would otherwise
  // release them twice.
  it('is called again, with resync: false, on the final removal after a failed re-sync', async () => {
    await retainWithDestructor()
    await resyncs([500])
    assert.deepStrictEqual(resyncCalls(), [{ resync: true }])
    assert.deepStrictEqual({ ...rootState().contracts[contractID] }, { references: 1 })
    await release()
    assert.deepStrictEqual(resyncCalls(), [{ resync: true }, { resync: false }])
    // Here `_volatile` holds no `watch`.
    assert.deepStrictEqual(destructorCalls[1].state, { _volatile: {} })
    assert.ok(!(contractID in rootState().contracts))
    // Nothing is remembered: a later contract of the same ID whose first
    // sync fails has no destructor to call.
    destructorCalls.length = 0
    await failedRetain()
    await release()
    assert.deepStrictEqual(resyncCalls(), [])
  })

  for (const statuses of [[200], [500, 200]]) {
    it(`is called with resync: true, then false, after re-syncs answered ${statuses.join(', then ')} (control)`, async () => {
      await retainWithDestructor()
      await resyncs(statuses)
      await release()
      // A re-sync of a contract whose re-sync failed has nothing to clean up.
      assert.deepStrictEqual(resyncCalls(), [{ resync: true }, { resync: false }])
    })
  }

  it("isn't called by chelonia/reset, also after a failed re-sync", async () => {
    await retainWithDestructor()
    await resyncs([500])
    await within(sbp('chelonia/reset'), 'chelonia/reset')
    assert.deepStrictEqual(resyncCalls(), [{ resync: true }])
    await failedRetain()
    await release()
    assert.deepStrictEqual(resyncCalls(), [{ resync: true }])
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
    await retain()
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
    let thrown: unknown
    const recovering = sbp('chelonia/kv/withHeightRecovery', contractID, async () => {
      attempts++
      throw (thrown = new ChelErrorKvHeightAhead('[test] ahead', {
        cause: { requiredHeight: 5, exact: true, localHeight: 0, etag: null, httpStatus: 412 }
      }))
    })
    await sleep(20)
    lane.open()
    await within(releasing, 'the release')
    await assert.rejects(within(recovering, 'the recovery'), (e: unknown) => {
      assert.ok(isKvHeightAhead(e))
      assert.strictEqual(e, thrown)
      return true
    })
    assert.strictEqual(attempts, 1)
    // The recovery ran, and its sync refused the removed contract.
    assert.ok(logged(warnings, `contract sync for ${contractID} failed; giving up`))
    assert.ok(warnedWith(`${contractID} is no longer subscribed`))
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
    await within(sbp('chelonia/queueInvocation', contractID, () => {}), 'the public lane')
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
    await until(
      () => logged(warnings, `contract sync for ${contractID} failed; giving up`),
      'the refusal warning'
    )
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
    await retain()
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

  // The contract is still retained, but not subscribed: the recovery gives
  // up, saying so rather than that the contract was removed.
  it('gives up when the resync fails, saying the contract is no longer subscribed', async () => {
    await retain()
    let releaseResync!: () => void
    const resyncHeld = new Promise<void>((resolve) => { releaseResync = resolve })
    let resyncStarted = false
    onLatestHEADinfo = async () => {
      onLatestHEADinfo = undefined
      resyncStarted = true
      await resyncHeld
    }
    // The resync fails once it fetches the contract's events.
    eventsAfterStatus = 500
    const resyncing = sbp('chelonia/contract/sync', contractID, { resync: true })
    resyncing.catch(() => {})
    try {
      await until(() => resyncStarted, 'the resync started')
      let attempts = 0
      const recovering = sbp('chelonia/kv/withHeightRecovery', contractID, async () => {
        attempts++
        throw new ChelErrorKvHeightAhead('[test] ahead', {
          cause: { requiredHeight: 5, exact: true, localHeight: 0, etag: null, httpStatus: 412 }
        })
      })
      releaseResync()
      await assert.rejects(within(recovering, 'the recovery'), isKvHeightAhead)
      await assert.rejects(within(resyncing, 'the resync'), {
        name: 'ChelErrorUnexpectedHttpResponseCode'
      })
      assert.strictEqual(attempts, 1)
      assert.deepStrictEqual({ ...rootState().contracts[contractID] }, { references: 1 })
      assert.ok(warnedWith(
        `${contractID} is no longer subscribed (released, or its re-sync failed)`
      ))
    } finally {
      releaseResync()
      eventsAfterStatus = 200
    }
    await release()
  })
})

// `chelonia/kv/whenSettled` called before the contract has synced, or
// while its slot hasn't settled, across what happens to the contract.
describe("whenSettled across a contract's lifecycle", () => {
  let offReconcile: () => void

  // What `chelonia/connect` mounts: slots are reconciled as contracts are
  // added, and cleaned up as they are removed.
  beforeEach(() => {
    offReconcile = sbp('okTurtles.events/on', CONTRACTS_MODIFIED, (
      _: string[], change: ContractsModifiedChange
    ) => {
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
    await retain()
    const { error } = await outcome
    assert.strictEqual(error?.name, 'ChelErrorKvSlotUnknown')
    assert.match(error.message, /isn't defined for this contract's type/)
    await release()
  })

  it('rejects when the contract is released before its first sync succeeded', async () => {
    defineSlot(CONTRACT_TYPE)
    const outcome = settling()
    await failedRetain()
    // Only the release ends the wait.
    assert.strictEqual(await settledOr(outcome, 100, 'pending'), 'pending')
    await release()
    const { error } = await outcome
    assert.strictEqual(error?.name, 'ChelErrorKvSlotUnknown')
    assert.match(error.message, /was removed with its contract/)
  })

  // The same with an ephemeral reference, which `withRetained` gives back
  // itself when its retain fails. Afterwards no ephemeral reference is left:
  // a retain and a release remove the contract again.
  for (const how of ['an ephemeral retain', 'withRetained'] as const) {
    it(`rejects when ${how} whose first sync failed is released`, async () => {
      defineSlot(CONTRACT_TYPE)
      const outcome = settling()
      eventsAfterStatus = 500
      let callbackRan = false
      const retaining = how === 'withRetained'
        ? sbp('chelonia/contract/withRetained', contractID, () => { callbackRan = true })
        : sbp('chelonia/contract/retain', contractID, { ephemeral: true })
      await assert.rejects(within(retaining, how), { name: 'ChelErrorUnexpectedHttpResponseCode' })
      eventsAfterStatus = 200
      assert.strictEqual(callbackRan, false)
      if (how === 'an ephemeral retain') {
        // Only the release ends the wait.
        assert.strictEqual(await settledOr(outcome, 100, 'pending'), 'pending')
        await release({ ephemeral: true })
      }
      const { error } = await outcome
      assert.strictEqual(error?.name, 'ChelErrorKvSlotUnknown')
      assert.match(error.message, /was removed with its contract/)
      assert.ok(!(contractID in rootState().contracts))
      // The contract had no entry to remove: that is expected.
      assert.ok(!logged(errors, 'Missing contract name'))
      await retain()
      await release()
      assert.ok(!(contractID in rootState().contracts))
    })
  }

  it('keeps waiting across a resync, and settles once the slot loads again', async () => {
    // Loaded explicitly below, once the resync is done. The KV GET is
    // signed with the contract's `#sak`, and the server has no value (404).
    sbp('chelonia/storeSecretKeys', new Secret([{ key: sak, transient: true }]))
    defineSlot(CONTRACT_TYPE, { autoLoad: 'never' })
    await retain()
    assert.strictEqual(sbp('chelonia/kv/status', contractID, 'k'), 'non-init')
    const outcome = settling()
    await within(sbp('chelonia/contract/sync', contractID, { resync: true }), 'the resync')
    assert.ok(removed.includes(contractID))
    assert.strictEqual(await settledOr(outcome, 20, 'pending'), 'pending')
    // The slot is active again.
    await within(sbp('chelonia/kv/sync', contractID, 'k'), 'the key sync')
    const { status } = await outcome
    assert.strictEqual(status, sbp('chelonia/kv/settledStatus', contractID, 'k'))
    assert.strictEqual(status, 'non-init')
    await release()
  })
})
