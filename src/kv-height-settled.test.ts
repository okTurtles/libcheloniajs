// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// a slot's `settled` flag and `chelonia/kv/whenSettled`, across height
// waits, re-activations, resyncs and slot deactivation.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import { ChelErrorKvSlotUnknown, isKvHeightAhead } from './errors.js'
import {
  CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED, CHELONIA_RESET, CONTRACTS_MODIFIED, EVENT_HANDLED
} from './events.js'
import {
  CONTRACT_ID,
  CTYPE,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  assertAwaitsValueAhead,
  collectStatusEvents,
  defineSlot,
  drainLanes,
  heightWait,
  holdGets,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  kvGetsRequested,
  loadV0At40,
  mirror,
  onEvent,
  persistLoadedV0,
  recordingUpdate,
  room,
  rootState,
  server,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  subscribeContract,
  until,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { KV_NOOP } from './kv.js'
import { settledOr } from './test-utils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

describe('settled / whenSettled', () => {
  it('seeding does not settle; a first-load 404 settles without onUpdate', async () => {
    const onUpdateCalls: unknown[] = []
    const { events, off } = collectStatusEvents('absent')
    defineSlot({ key: 'seedOnly', autoLoad: 'never' })
    defineSlot({ key: 'absent', onUpdate: (v: unknown) => { onUpdateCalls.push(v) } })
    await activateContract()
    off()
    assert.strictEqual(mirror('seedOnly').settled, false)
    assert.strictEqual(slotStatus('absent'), 'non-init')
    assert.strictEqual(mirror('absent').settled, true)
    assert.deepStrictEqual(events.map((e) => [e.status, e.settled, e.previousSettled]), [
      ['loading', false, false], ['non-init', true, false]
    ])
    assert.deepStrictEqual(onUpdateCalls, [])
    assert.strictEqual(await whenSettledWithin('absent'), 'non-init')
  })

  it('an abandoned load does not settle the slot', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const gets = holdGets()
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD })
    const settledAs = whenSettledWithin(UNREAD)
    settledAs.catch(() => {})
    await subscribeContract()
    await until(() => kvGetsRequested() === 1, 'the first GET never started')
    // Slot replaced (HMR / re-registration) while its first GET is in flight.
    defineSlot({ key: UNREAD })
    gets.release()
    assert.strictEqual(await settledAs, 'loaded')
    await drainLanes()
    off()
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loading', false],
      ['loading', 'non-init', false],
      ['non-init', 'loading', false],
      ['loading', 'loaded', true]
    ])
  })

  it('whenSettled rejects a signal that has already aborted, even for a settled slot', async () => {
    await loadV0At40()
    assert.strictEqual(mirror(UNREAD).settled, true)
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    controller.abort(reason)
    await assert.rejects(
      sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD, { signal: controller.signal }),
      (e: unknown) => e === reason
    )
  })

  it('whenSettled called from inside onUpdate rejects instead of hanging', async () => {
    const OTHER_KEY = 'otherKey'
    await writeAsDeviceB(UNREAD, V0, 40)
    await writeAsDeviceB(OTHER_KEY, V0, 40)
    const inner: unknown[] = []
    const outcome = (p: Promise<unknown>) => p.then((v) => v, (e: unknown) => e)
    defineSlot({ key: OTHER_KEY, autoLoad: 'on-demand' })
    defineSlot({
      key: UNREAD,
      onUpdate: () => {
        // The settled slot resolves; the pending one would wait for a load
        // queued behind this callback.
        inner.push(outcome(sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)))
        inner.push(outcome(sbp('chelonia/kv/whenSettled', CONTRACT_ID, OTHER_KEY)))
      }
    })
    await activateContract()
    const [settled, pending] = await within(Promise.all(inner), 'the whenSettled calls settle')
    assert.strictEqual(settled, 'loaded')
    assert.strictEqual((pending as Error | undefined)?.name, 'ChelErrorKvReentrant')
  })

  it('re-activating a persisted entry resets settled until the next load', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    const gets = holdGets()
    defineSlot({ key: UNREAD })
    await subscribeContract()
    await until(() => kvGetsRequested() === 1, 'the reload never started')
    assert.strictEqual(mirror(UNREAD).settled, false)
    gets.release()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
  })

  it('re-activation announces settled: false, and an external store follows', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status: 'loaded', settled: true }
    }
    const external: any = {}
    sbp('sbp/selectors/register', { 'test/kvHeight/externalState': () => external })
    addTeardown(sbp('chelonia/externalStateSetup', {
      stateSelector: 'test/kvHeight/externalState'
    }))
    const projected = () => within(
      sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, () => {}),
      'the external store projection'
    )
    await activateContract()
    await projected()
    assert.strictEqual(external._kv?.[CONTRACT_ID]?.[UNREAD]?.settled, true)
    const { events, off } = collectStatusEvents(UNREAD)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await drainLanes()
    await projected()
    off()
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.previousSettled, e.settled]),
      [['loaded', 'loaded', true, false]]
    )
    assert.strictEqual(external._kv[CONTRACT_ID][UNREAD].settled, false)
  })

  // `persistLoadedV0`: an entry persisted as `{ status: 'loaded', settled:
  // true }` holding V0, while the server holds VB written at height 42 and
  // the local contract stays at 40 (a sync doesn't catch it up).
  it('a re-activated loaded entry settles when its deferred load gives up', async () => {
    const persistedEtag = await persistLoadedV0()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    const { events, off } = collectStatusEvents(UNREAD)
    const syncsBefore = server.syncs
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    off()
    assert.strictEqual(server.syncs, syncsBefore + 1) // the fallback sync
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.previousSettled, e.settled]),
      [['loaded', 'loaded', false, true]]
    )
  })

  // E.g. persisted while a load was in flight, and restored by
  // `chelonia/reset`: no load of this session is running, so re-activating
  // the slot makes it 'loaded' (it holds a value), and it settles as the
  // entry above does.
  it("a re-activated entry persisted 'loading' settles when its deferred load gives up", async () => {
    await setupStaleDeviceA()
    const rs = rootState()
    const persisted = JSON.parse(JSON.stringify({
      contracts: rs.contracts,
      [CONTRACT_ID]: rs[CONTRACT_ID],
      secretKeys: rs.secretKeys,
      _kv: rs._kv
    }))
    persisted._kv[CONTRACT_ID][UNREAD].status = 'loading'
    await within(sbp('chelonia/reset', persisted), 'chelonia/reset')
    assert.strictEqual(mirror(UNREAD).status, 'loading')
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
  })

  it('single-key kv/sync that gives up settles a re-activated loaded entry', async () => {
    const persistedEtag = await persistLoadedV0()
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    await assert.rejects(
      within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'kv/sync'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(await whenSettledWithin(UNREAD, 100), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    assert.strictEqual(mirror(UNREAD).etag, persistedEtag)
  })

  it('the first update of a never-loaded slot writes without loading it, and settles it', async () => {
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    server.log.length = 0
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomA', 'a1', 1)
    }), 'the update')
    off()
    // No GET: the write carries `if-match: ""`, and its commit settles the
    // slot.
    assert.strictEqual(server.gets().length, 0)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.ifMatch]), [[204, '""']])
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loaded', true]
    ])
  })

  it('a committed local write settles the slot, also after merging a value it never read', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const { events, off } = collectStatusEvents(UNREAD)
    server.log.length = 0
    const result = await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    }), 'the update')
    off()
    assert.deepStrictEqual(result, { ...V0, roomC: room('c1', 3) })
    assert.strictEqual(server.gets().length, 0)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 204])
    assert.deepStrictEqual(events.map((e) => [e.previousStatus, e.status, e.settled]), [
      ['non-init', 'loaded', true]
    ])
  })

  it('whenSettled waits for activation and rejects on abort and on reset', async () => {
    defineSlot({ key: 'absent' })
    const early = whenSettledWithin('absent')
    early.catch(() => {})
    await activateContract()
    assert.strictEqual(await early, 'non-init')

    defineSlot({ key: 'never', autoLoad: 'never' })
    await drainLanes()
    const controller = new AbortController()
    const aborted = sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'never', { signal: controller.signal })
    controller.abort(new Error('stop waiting'))
    await assert.rejects(within(aborted, 'the aborted whenSettled'), (e: any) => e.message === 'stop waiting')

    const pending = sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'never')
    await within(sbp('chelonia/reset'), 'chelonia/reset')
    await assert.rejects(within(pending, 'whenSettled across reset'), (e: any) => e.name === 'AbortError')
  })

  it("waits for a settled slot's reload instead of resolving with 'loading'", async () => {
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(slotStatus('absent'), 'non-init')
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, 'absent')
    await until(() => slotStatus('absent') === 'loading', "the refresh never went 'loading'")
    let settledAs: unknown
    const settling = whenSettledWithin('absent').then((s: unknown) => { settledAs = s })
    settling.catch(() => {})
    // Only for the negative check below.
    await sleep(20)
    assert.strictEqual(settledAs, undefined)
    gets.release()
    await within(syncing, 'the sync')
    await settling
    assert.strictEqual(settledAs, 'non-init')
  })

  it("a settled 'non-init' slot whose server value turns out to be ahead is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: 'absent' })
    await activateContract()
    assert.strictEqual(slotStatus('absent'), 'non-init')
    await writeAsDeviceB('absent', V0, 42)
    const { events, off } = collectStatusEvents('absent')
    // An aggregate refresh finds a value written at a height not reached:
    // the server value isn't absent after all.
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    await drainLanes()
    assert.strictEqual(slotStatus('absent'), 'loading')
    assert.strictEqual(mirror('absent').settled, true)
    await assert.rejects(whenSettledWithin('absent', 100), (e: any) => e.name === 'TimeoutError')
    const settling = whenSettledWithin('absent')
    settling.catch(() => {})
    await advanceLocalHeightOnInternalLane(42)
    assert.strictEqual(await settling, 'loaded')
    off()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'absent'), V0)
    assert.deepStrictEqual(
      events.map((e) => [e.previousStatus, e.status, e.heightAhead?.requiredHeight ?? null]),
      [['non-init', 'loading', null], ['loading', 'loading', 42], ['loading', 'loaded', null]]
    )
  })

  it("a settled 'non-init' slot whose deferred refresh gives up settles to 'error'", async () => {
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    await writeAsDeviceB(UNREAD, VB, 42)
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    const syncsBefore = server.syncs
    // The 300 ms fallback sync doesn't catch the contract up.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    assert.strictEqual(server.syncs, syncsBefore + 1)
    assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightAhead')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), {})
    // KV_NOOP on the default, but writes on VB: the reducer must not run
    // on the default.
    const reducer = addChatRoomUnreadMessage('roomA', 'a2', 5)
    assert.strictEqual(reducer({}), KV_NOOP)
    assert.notStrictEqual(reducer(VB), KV_NOOP)
    server.log.length = 0
    const bases: any[] = []
    await assert.rejects(
      within(recordingUpdate(bases, { reducer }), 'the update'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("a persisted entry's revalidation doesn't resolve whenSettled before the slot is active", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: {
        value: V0,
        etag: server.etagOf(UNREAD),
        status: 'error',
        settled: true,
        lastError: { name: 'Error', message: 'previous session' }
      }
    }
    let settledAs: unknown
    const settling = whenSettledWithin(UNREAD).then((s: unknown) => { settledAs = s })
    settling.catch(() => {})
    // Defining the slot again revalidates the persisted entry ('error' ->
    // 'loaded'): the contract hasn't synced, so nothing is settled in this
    // session yet.
    defineSlot({ key: UNREAD })
    await until(() => mirror(UNREAD).status === 'loaded', 'the persisted entry was never revalidated')
    assert.strictEqual(settledAs, undefined)
    await activateContract()
    await settling
    assert.strictEqual(settledAs, 'loaded')
    assert.strictEqual(server.gets().length, 1)
  })

  it("settledStatus and a gate that checks status don't take a reloading slot's default for its value", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    defineSlot({ key: 'absent' })
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), undefined)
    await activateContract()
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), 'non-init')
    await writeAsDeviceB('absent', V0, 42)
    const flushed: unknown[] = []
    onEvent(CHELONIA_KV_STATUS_CHANGED, (p: any) => {
      if (
        p.contractID === CONTRACT_ID && p.key === 'absent' && p.settled && p.status !== 'loading'
      ) {
        flushed.push(sbp('chelonia/kv/read', CONTRACT_ID, 'absent'))
      }
    })
    // An aggregate refresh finds a value written at a height not reached.
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    await drainLanes()
    assert.strictEqual(slotStatus('absent'), 'loading')
    assert.strictEqual(mirror('absent').settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), undefined)
    assert.deepStrictEqual(flushed, [])
    await advanceLocalHeightOnInternalLane(42)
    await until(() => slotStatus('absent') === 'loaded', 'the slot never loaded')
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, 'absent'), 'loaded')
    assert.deepStrictEqual(flushed, [V0])
  })

  it('chelonia/reset(newState) restores KV entries unsettled, until their slots load again', async () => {
    await loadV0At40()
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'loaded')
    const persisted = JSON.parse(JSON.stringify(rootState()))
    assert.strictEqual(persisted._kv[CONTRACT_ID][UNREAD].settled, true)
    await within(sbp('chelonia/reset', persisted), 'chelonia/reset')
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.strictEqual(mirror(UNREAD).status, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), undefined)
    await activateContract()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.strictEqual(mirror(UNREAD).settled, true)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), 'loaded')
  })
})

// An outcome that finds no value (a 404, a cleared value, a committed
// `clear`) while a height wait for the key remains: one registered off the
// lane while the request was in flight (here directly, as `runSlotWrite`'s
// catch or `_resumeHeightSession` do). The server is then known to hold a
// value this client can't verify yet, so the slot waits for it rather than
// settle "no value", and loads it once the contract catches up. (A remote
// clear frame: `kv-height-pubsub.test.ts`.)
describe('a verified empty outcome while a height wait remains', () => {
  const registerWait = () => sbp('chelonia/kv/_registerHeightWait', {
    contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'remote'
  })
  // Device B writes VB at 42, and this device then reaches 42.
  const loadsVBOnceCaughtUp = async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    const settling = whenSettledWithin(UNREAD)
    settling.catch(() => {})
    await within(advanceLocalHeightOnInternalLane(42), 'the height move')
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
  }
  // A load of the settled 'non-init' slot, with its GET held until `during`
  // has run.
  const reloadWith = async (during: () => Promise<void> | void) => {
    const gets = holdGets()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID)
    await until(() => kvGetsRequested() === 2, 'the reload started')
    await during()
    gets.release()
    await within(syncing, 'the sync')
    await drainLanes()
  }

  for (const serverHolds of ['nothing (404)', 'a cleared value'] as const) {
    it(`a load that finds ${serverHolds}`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      if (serverHolds === 'a cleared value') await writeAsDeviceB(UNREAD, null, 40)
      defineSlot({ key: UNREAD })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
      await reloadWith(registerWait)
      await assertAwaitsValueAhead(UNREAD, 42)
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), {})
      await loadsVBOnceCaughtUp()
    })
  }

  it('a committed clear', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await loadV0At40()
    server.log.length = 0
    server.onPost = (n) => { if (n === 1) registerWait() }
    addTeardown(() => { server.onPost = null })
    await within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD), 'the clear')
    server.onPost = null
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    await assertAwaitsValueAhead(UNREAD, 42)
    await loadsVBOnceCaughtUp()
  })

  // The wait's fallback gave up (it is parked, with no fallback) before
  // the GET returned. The slot waits for the value again, so the fallback
  // runs again too, rather than leave the slot 'loading' for good.
  it('a load that finds nothing while a parked wait remains re-arms its fallback', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 50 })
    defineSlot({ key: UNREAD })
    await activateContract()
    let syncsBefore = 0
    await reloadWith(async () => {
      registerWait()
      await until(() => heightWait(UNREAD)?.parked === true, 'the fallback gave up')
      await writeAsDeviceB(UNREAD, VB, 42)
      server.catchUpOnSync = true
      // Counted from here: the re-armed fallback may sync before the
      // reload's call returns.
      syncsBefore = server.syncs
    })
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(mirror(UNREAD).value, VB)
    assert.strictEqual(server.syncs - syncsBefore, 1)
  })
})

// An entry persisted while it reloaded (`{ status: 'loading', settled:
// true }`), and hydrated directly rather than through
// `chelonia/reset(newState)`. Its activation unsettles it before anything
// else, so `whenSettled` waits for the load rather than resolve with the
// persisted status.
describe('re-activating an entry persisted while it reloaded', () => {
  const hydrate = (withValue: boolean) => {
    rootState()._kv![CONTRACT_ID] = {
      [UNREAD]: withValue
        ? { value: { stale: true }, etag: '"stale-etag"', status: 'loading', settled: true }
        : { value: undefined, etag: null, status: 'loading', settled: true }
    }
  }
  const variants = [
    'without a value',
    'without a value, autoLoad never',
    'without a value, slot defined after hydration',
    'with a value'
  ] as const
  for (const variant of variants) {
    it(`${variant}: whenSettled waits for the load`, async () => {
      await writeAsDeviceB(UNREAD, V0, 40)
      const withValue = variant === 'with a value'
      const autoLoadNever = variant.endsWith('autoLoad never')
      const definedAfter = variant.endsWith('after hydration')
      if (definedAfter) hydrate(withValue)
      defineSlot({ key: UNREAD, ...(autoLoadNever && { autoLoad: 'never' }) })
      if (!definedAfter) hydrate(withValue)
      const settling = whenSettledWithin(UNREAD)
      settling.catch(() => {})
      const gets = holdGets()
      const { events } = collectStatusEvents(UNREAD)
      await subscribeContract()
      assert.strictEqual(await settledOr(settling, 100, 'pending'), 'pending')
      assert.strictEqual(events[0]?.settled, false)
      gets.release()
      if (autoLoadNever) await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync')
      assert.strictEqual(await settling, 'loaded')
      assert.deepStrictEqual(mirror(UNREAD).value, V0)
    })
  }

  // A settled entry is re-activated with one event that reports the flag
  // as it was: a 'loading' one also goes 'loaded' in it (control: an entry
  // persisted 'loaded'). The contract is active before the slot is defined,
  // so that the definition's reconciliation re-activates the entry: defined
  // first, the definition would revalidate a 'loading' entry before that.
  for (const status of ['loading', 'loaded'] as const) {
    it(`a settled entry persisted '${status}' is re-activated with one event, previousSettled: true${status === 'loaded' ? ' (control)' : ''}`, async () => {
      await writeAsDeviceB(UNREAD, V0, 40)
      rootState()._kv![CONTRACT_ID] = {
        [UNREAD]: { value: V0, etag: server.etagOf(UNREAD), status, settled: true }
      }
      const { events } = collectStatusEvents(UNREAD)
      await activateContract()
      defineSlot({ key: UNREAD, autoLoad: 'never' })
      await drainLanes()
      assert.deepStrictEqual(
        events.map((e) => [e.previousStatus, e.status, e.previousSettled, e.settled]),
        [[status, 'loaded', true, false]]
      )
      assert.strictEqual(mirror(UNREAD).settled, false)
    })
  }
})

// A resync as `syncContract` runs one (`chelonia/private/in/sync` with
// `resync`): the contract's state and KV runtime are cleared and its
// removal announced; the sync then replays the contract (here: the harness
// contract's state is put back while `/latestHEADinfo` is answered, after
// `hold`), which subscribes it again and announces the addition. The
// CONTRACTS_MODIFIED listener is the one `chelonia/connect` mounts. The
// slot mirror is kept, so that the reload after the resync reports what
// changed meanwhile.
describe('a contract resync', () => {
  const resync = (hold: Promise<void> = Promise.resolve()) => {
    onEvent(CONTRACTS_MODIFIED, ((_ids: unknown, change: unknown) => {
      sbp('chelonia/kv/_onContractsModified', change)
    }) as (payload: unknown) => void)
    const rs = rootState()
    const meta = JSON.parse(JSON.stringify(rs.contracts[CONTRACT_ID]))
    const state = JSON.parse(JSON.stringify(rs[CONTRACT_ID]))
    server.onSync = async () => {
      server.onSync = null
      await hold
      Object.assign(rs.contracts[CONTRACT_ID], meta)
      rs[CONTRACT_ID]._vm = state._vm
    }
    return within(
      sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true, resync: true }), 'the resync'
    )
  }

  it('reports a value removed meanwhile once the slot reloads', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const onUpdates: unknown[] = []
    defineSlot({ key: UNREAD, onUpdate: (v: unknown, c: any) => { onUpdates.push([c.reason, v]) } })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    onUpdates.length = 0
    const updated: unknown[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => {
      if (p.key === UNREAD) updated.push([p.reason, p.value, p.previousValue])
    })
    server.store.delete(UNREAD)
    await resync()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'non-init')
    assert.deepStrictEqual(onUpdates, [['load', {}]])
    assert.deepStrictEqual(updated, [['load', undefined, V0]])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), {})
  })

  it("keeps a 'loaded' slot's value, and unsettles the slot until its reload", async () => {
    await loadV0At40()
    const { events } = collectStatusEvents(UNREAD)
    let open!: () => void
    const held = new Promise<void>((resolve) => { open = resolve })
    addTeardown(() => open())
    const syncing = resync(held)
    await until(() => server.onSync === null, 'the resync reached /latestHEADinfo')
    // Kept, but its slot is inactive until the contract is subscribed again.
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.throws(() => sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), ChelErrorKvSlotUnknown)
    const gets = holdGets()
    open()
    await syncing
    await until(() => kvGetsRequested() === 2, 'the reload started')
    assert.deepStrictEqual(mirror(UNREAD).value, V0)
    assert.strictEqual(mirror(UNREAD).settled, false)
    assert.strictEqual(sbp('chelonia/kv/settledStatus', CONTRACT_ID, UNREAD), undefined)
    gets.release()
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(events.map((e) => [e.status, e.settled]), [
      ['loaded', false], ['loading', false], ['loaded', true]
    ])
  })

  // The resync clears the marker while the contract's state (and so its
  // type) is gone: the event still names the contract type.
  it("clears a slot's heightAhead marker with an event that names the contract type", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
    await setupStaleDeviceA()
    await within(sbp('chelonia/kv/sync', CONTRACT_ID), 'the aggregate sync')
    await drainLanes()
    assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
    const { events } = collectStatusEvents(UNREAD)
    await resync()
    await drainLanes()
    assert.ok(events.some((e) => e.heightAhead === null), 'the marker was never cleared')
    assert.deepStrictEqual(events.filter((e) => e.contractType !== CTYPE), [])
  })

  // A manifest cleanup that unregisters the slot while the resync runs
  // (the contract unsubscribed, and its type unknown) can't drop the kept
  // entry: the reconcile after the resync does. Control: the same cleanup
  // outside a resync.
  for (const duringResync of [true, false]) {
    it(duringResync
      ? 'drops the entry of a slot unregistered while it ran'
      : 'drops the entry of a slot unregistered outside it, too (control)', async () => {
      await writeAsDeviceB(UNREAD, V0, 40)
      sbp('chelonia/kv/_registerContractSlots', CTYPE, 'manifest-1', { [UNREAD]: { defaultValue: {} } })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'loaded')
      const cleanup = () =>
        sbp('chelonia/kv/_cleanupContractSlots', CTYPE, 'manifest-1', { [UNREAD]: {} }, {})
      if (duringResync) {
        let open!: () => void
        const held = new Promise<void>((resolve) => { open = resolve })
        addTeardown(() => open())
        const syncing = resync(held)
        await until(() => server.onSync === null, 'the resync reached /latestHEADinfo')
        cleanup()
        // Kept: no cleanup can tell whose entry it is.
        assert.ok(mirror(UNREAD))
        open()
        await syncing
      } else {
        cleanup()
      }
      await drainLanes()
      assert.strictEqual(mirror(UNREAD), undefined)
      assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
      sbp('chelonia/kv/_assertIndexConsistent')
    })
  }
})

describe('whenSettled and slot deactivation', () => {
  const listeners = (event: string): number =>
    (sbp('okTurtles.data/get', `events/${event}/listeners`) ?? []).length
  // Each pending call adds one status listener, which goes when it settles
  // (a reset rejects it through `kvSettleWaiters`, without a listener).
  const listenerCounts = () => [listeners(CHELONIA_KV_STATUS_CHANGED), listeners(CHELONIA_RESET)]
  // The slot's first load is held, so that it hasn't settled.
  const definedAndLoading = async (def: Record<string, unknown> = {}) => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, ...def })
    const gets = holdGets()
    addTeardown(() => gets.release())
    await subscribeContract()
    await until(() => kvGetsRequested() >= 1, 'the first load never sent its GET')
    return gets
  }

  it('rejects at once for a key that no slot defines', async () => {
    await loadV0At40()
    const before = listenerCounts()
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'unreadMesages'), 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes('unreadMesages')
    )
    // Also for a contract that hasn't synced (its type isn't known yet).
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', 'zOtherContract', 'unreadMesages'), 'whenSettled'),
      ChelErrorKvSlotUnknown
    )
    assert.deepStrictEqual(listenerCounts(), before)
  })

  it('rejects when the contract is released while it waits, leaving no listener', async () => {
    const gets = await definedAndLoading()
    await within(sbp('chelonia/contract/retain', CONTRACT_ID), 'the retain')
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(listenerCounts(), [before[0] + 1, before[1]])
    await within(sbp('chelonia/contract/release', CONTRACT_ID), 'the release')
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.deepStrictEqual(listenerCounts(), before)
    gets.release()
  })

  it('rejects when its match turns false while it waits', async () => {
    let matches = true
    const gets = await definedAndLoading({ match: () => matches })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(listenerCounts(), [before[0] + 1, before[1]])
    matches = false
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.deepStrictEqual(listenerCounts(), before)
    gets.release()
  })

  it('rejects when a manifest cleanup unregisters its slot, which leaves no empty record', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    sbp('chelonia/kv/_registerContractSlots', CTYPE, 'manifest-1', {
      [UNREAD]: { defaultValue: {} }
    })
    const gets = holdGets()
    addTeardown(() => gets.release())
    await subscribeContract()
    await until(() => kvGetsRequested() >= 1, 'the first load never sent its GET')
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    sbp('chelonia/kv/_cleanupContractSlots', CTYPE, 'manifest-1', { [UNREAD]: {} }, {})
    await assert.rejects(within(settling, 'whenSettled'), ChelErrorKvSlotUnknown)
    assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
    gets.release()
  })

  // Called before the contract's type is known, it waits: a slot of
  // another type defines the key. Once the type is known, a reconcile shows
  // that it never will.
  for (const via of ['refreshFilters', '_onContractsModified'] as const) {
    it(`rejects once the contract's type turns out to define no such slot (${via})`, async () => {
      defineSlot({ key: UNREAD })
      defineSlot({ contractType: 'test-other-type', key: 'otherKey' })
      const meta = rootState().contracts[CONTRACT_ID]
      const vm = rootState()[CONTRACT_ID]._vm
      const type = meta.type
      delete meta.type
      delete vm.type
      const settling = whenSettledWithin('otherKey', 1000)
      settling.catch(() => {})
      assert.strictEqual(await settledOr(settling, 20, 'pending'), 'pending')
      meta.type = type
      vm.type = type
      // No `chelonia/connect`, so nothing reconciles on CONTRACTS_MODIFIED:
      // the app does.
      await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
      if (via === 'refreshFilters') sbp('chelonia/kv/refreshFilters')
      else sbp('chelonia/kv/_onContractsModified', { added: [CONTRACT_ID], removed: [] })
      await assert.rejects(
        settling,
        (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes("isn't defined")
      )
    })
  }

  it("rejects when its match is false once the contract's slots are reconciled, then at once", async () => {
    let matches = false
    defineSlot({ key: UNREAD, match: () => matches })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(listenerCounts(), [before[0] + 1, before[1]])
    const rejected = assert.rejects(
      within(settling, 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes("isn't active")
    )
    await activateContract()
    await rejected
    assert.deepStrictEqual(listenerCounts(), before)
    await assert.rejects(
      within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD), 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes('`match` is false')
    )
    assert.deepStrictEqual(listenerCounts(), before)
    // Its match turns true: refreshFilters activates it, and it loads.
    matches = true
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'non-init')
  })

  it('rejects when a manifest cleanup unregisters its slot before it activated', async () => {
    sbp('chelonia/kv/_registerContractSlots', CTYPE, 'manifest-1', {
      [UNREAD]: { defaultValue: {} }
    })
    const before = listenerCounts()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(listenerCounts(), [before[0] + 1, before[1]])
    sbp('chelonia/kv/_cleanupContractSlots', CTYPE, 'manifest-1', { [UNREAD]: {} }, {})
    await assert.rejects(
      within(settling, 'whenSettled'),
      (e: unknown) => e instanceof ChelErrorKvSlotUnknown && e.message.includes("isn't defined")
    )
    assert.deepStrictEqual(listenerCounts(), before)
  })
})
