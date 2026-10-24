// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// `chelonia/reset` while KV work is under way, writes whose queueing a
// filter vetoes, and aborted writes.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import { ChelErrorUnexpected } from './errors.js'
import { CHELONIA_KV_UPDATED } from './events.js'
import {
  CONTRACT_ID,
  NS_CACHE,
  OTHER_CONTRACT_ID,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  addTeardown,
  advanceLocalHeightOnInternalLane,
  cekId,
  cskId,
  deferFirstLoad,
  defineSlot,
  drainLanes,
  errors,
  gateLane,
  heightWrites,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  kvGetsRequested,
  later,
  loadV0At40,
  loadedRefreshGivesUp,
  localHeight,
  mergeNames,
  mirror,
  onEvent,
  publicLaneQueued,
  room,
  rootState,
  server,
  setLocalHeight,
  setupContract,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  until,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { logged, settledOr, type KvFetchOptions } from './test-utils.js'
import type { CheloniaConfig, JSONType, KvHeightRecoveryAttempt } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

describe('chelonia/reset', () => {
  const contractSyncsSince = (at: number) => server.requests
    .filter((r) => r.at >= at && /^\/(latestHEADinfo|eventsAfter)\//.test(r.path))
    .map((r) => r.path)

  it('a deferred-load fallback due while reset drains starts no contract sync', async () => {
    // Deferred: the 300 ms fallback is armed.
    await deferFirstLoad()
    const resetStartedAt = Date.now()
    // The fallback falls due while the persistence hook runs.
    await within(sbp('chelonia/reset', () => sleep(500)), 'chelonia/reset')
    await sleep(400)
    assert.deepStrictEqual(contractSyncsSince(resetStartedAt), [])
    // The next session doesn't expect events for the torn-down contract
    // (a sync started for it would have put it back in `pending`).
    warnings.length = 0
    await within(
      sbp('chelonia/private/in/handleEvent', CONTRACT_ID, 'not-a-message'), 'handleEvent'
    )
    assert.ok(logged(warnings, 'ignoring unexpected event'))
  })

  it('work started while reset drains marks no slot and starts no sync', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const resetStartedAt = Date.now()
    let updateError: unknown
    await within(sbp('chelonia/reset', async () => {
      // Outside a reset, this load would defer the key (with a 300 ms
      // fallback sync) and the update would sync the contract to recover.
      await sbp('chelonia/kv/sync', CONTRACT_ID)
      // The height wait is only remembered, in case the reset fails: no
      // marker, and no fallback.
      assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      updateError = await sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }).then(() => undefined, (e: unknown) => e)
      await sleep(500)
    }), 'chelonia/reset')
    assert.strictEqual((updateError as Error | undefined)?.name, 'AbortError')
    assert.deepStrictEqual(contractSyncsSince(resetStartedAt), [])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it('the next session defers and recovers again', async () => {
    await within(sbp('chelonia/reset'), 'chelonia/reset')
    setupContract(40)
    await deferFirstLoad()
    server.catchUpOnSync = true
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  // A reset whose persistence hook throws doesn't tear the session down, so
  // the session goes on and its height machinery must keep working.
  const failedReset = () => assert.rejects(
    within(sbp('chelonia/reset', () => { throw new Error('persist failed') }), 'the failed reset'),
    /persist failed/
  )

  it('after a failed reset, a new deferred load still falls back and loads', async () => {
    await failedReset()
    await deferFirstLoad()
    server.catchUpOnSync = true
    // The fallback sync (after 300 ms) brings the contract up to date.
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps the deferred loads it found', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    await failedReset()
    // Only the height notification can reload the slot within the test.
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('two overlapping failed resets keep the deferred loads the first found', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await deferFirstLoad()
    server.log.length = 0
    const failingReset = (ms: number) => sbp('chelonia/reset', async () => {
      await sleep(ms)
      throw new Error('persistence hook failed')
    })
    const outcomes = await within(
      Promise.allSettled([failingReset(50), failingReset(10)]), 'the failed resets'
    )
    assert.deepStrictEqual(outcomes.map((o) => o.status), ['rejected', 'rejected'])
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
  })

  // Reset A fails while reset B still drains: the height session must stay
  // ended until B is done, or a fallback could sync a contract that B is
  // about to tear down.
  for (const bFails of [false, true]) {
    it(`a reset that fails while another drains doesn't resume the height session (B ${bFails ? 'fails' : 'succeeds'})`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 100 })
      await loadV0At40()
      let failA: ((e: Error) => void) | undefined
      const resetA = sbp('chelonia/reset', () => new Promise<void>((_resolve, reject) => {
        failA = reject
      }))
      let finishB: (() => void) | undefined
      const resetB = sbp('chelonia/reset', () => new Promise<void>((resolve, reject) => {
        finishB = bFails ? () => reject(new Error('B failed')) : resolve
      }))
      // A failing assertion below must not leave either persistence hook
      // pending after the test, nor either reset's rejection unhandled.
      addTeardown(() => {
        resetA.catch(() => {})
        resetB.catch(() => {})
        failA?.(new Error('released after the test'))
        finishB?.()
      })
      await until(() => !!failA && !!finishB, 'both persistence hooks run')
      failA!(new Error('A failed'))
      await assert.rejects(within(resetA, 'reset A'), /A failed/)
      // A value that is ahead turns up while B still drains (e.g. a frame).
      const syncsBefore = server.syncs
      sbp('chelonia/kv/_registerHeightWait', {
        contractID: CONTRACT_ID, key: UNREAD, requiredHeight: 42, reason: 'load'
      })
      // Only remembered, in case B fails too: no marker, no fallback.
      assert.strictEqual(mirror(UNREAD).heightAhead, undefined)
      await sleep(300) // a 100 ms fallback would have synced by now
      assert.strictEqual(server.syncs, syncsBefore)
      finishB!()
      if (!bFails) {
        await within(resetB, 'reset B')
        assert.strictEqual(rootState()._kv?.[CONTRACT_ID], undefined)
        await sleep(300)
        assert.strictEqual(server.syncs, syncsBefore)
        return
      }
      await assert.rejects(within(resetB, 'reset B'), /B failed/)
      // B failed too: the session goes on, with the wait registered again.
      assert.deepStrictEqual(mirror(UNREAD).heightAhead, { requiredHeight: 42 })
      await until(() => server.syncs === syncsBefore + 1, 'the fallback syncs', 2000)
      await sleep(300)
      assert.strictEqual(server.syncs, syncsBefore + 1)
    })
  }

  it('a failed reset keeps a deferred load that gave up, without a new fallback', async () => {
    await loadedRefreshGivesUp()
    const syncsBefore = server.syncs
    await failedReset()
    await sleep(400) // a new 300 ms fallback would have synced by now
    assert.strictEqual(server.syncs, syncsBefore)
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps the deferred reload of a single-key kv/sync it aborted', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000, pendingFallbackMs: 10000 })
    await writeAsDeviceB(UNREAD, VB, 42)
    defineSlot({ key: UNREAD, autoLoad: 'on-demand' })
    await activateContract()
    const syncing = sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    await until(() => server.gets().length >= 1, 'kv/sync never issued its GET')
    // Its load registers the key's height wait, which marks the slot, right
    // before the call waits.
    await until(() => mirror(UNREAD)?.heightAhead !== undefined, 'kv/sync never waited')
    await failedReset()
    await assert.rejects(syncing, { name: 'AbortError' })
    assert.strictEqual(slotStatus(UNREAD), 'loading')
    const getsBefore = server.gets().length
    setLocalHeight(42)
    assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    await drainLanes()
    assert.strictEqual(server.gets().length, getsBefore + 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  it('a failed reset keeps a deferred reload registered while it ran', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await assert.rejects(
      within(sbp('chelonia/reset', async () => {
        // The refresh finds VB ahead, so the key's reload is deferred.
        await sbp('chelonia/kv/sync', CONTRACT_ID)
        throw new Error('persist failed')
      }), 'the failed reset'),
      /persist failed/
    )
    assert.strictEqual(server.gets().length, 1)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length, 2)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  // A slot load queued behind busy lane work when the reset tears the
  // session down never runs: `chelonia/private/invoke` drops work queued
  // before the reset. Unlike a load that a filter keeps from running, it
  // belongs to the old session, so it must not settle the entry that the
  // new state restores for the key.
  it("a slot load that the reset drops leaves the next session's entry alone", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD })
    await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
    server.log.length = 0
    const restored = { value: undefined, etag: null, status: 'non-init', settled: true }
    let open!: () => void
    await within(sbp('chelonia/reset', { _kv: { [CONTRACT_ID]: { [UNREAD]: restored } } }, async () => {
      ;({ open } = gateLane())
      await until(() => publicLaneQueued() === 1, 'the lane was never held')
      // Autoloads the slot: its load queues behind the held lane.
      sbp('chelonia/kv/_onContractsModified', { added: [CONTRACT_ID], removed: [] })
      await until(() => publicLaneQueued() === 2, 'the load never queued')
    }), 'chelonia/reset')
    // As the reset restored it, unsettled (no slot is active yet).
    const before = { ...mirror(UNREAD) }
    assert.deepStrictEqual(before, { ...restored, settled: false })
    open()
    await drainLanes()
    assert.deepStrictEqual({ ...mirror(UNREAD) }, before)
    assert.ok(!logged(errors, '_loadSlot rejected'))
    assert.strictEqual(server.gets().length, 0)
  })

  // Filters can't be removed: each is armed by its test, and disarmed by
  // the test's teardown.
  let onContractWait: (() => void) | undefined
  sbp('sbp/filters/selector/add', 'chelonia/contract/wait', () => { onContractWait?.() })
  let onWaitInFlight: (() => void) | undefined
  sbp('sbp/filters/selector/add', 'chelonia/kv/_waitInFlight', () => { onWaitInFlight?.() })
  let onEndHeightSession: (() => void) | undefined
  sbp('sbp/filters/selector/add', 'chelonia/kv/_endHeightSession', () => { onEndHeightSession?.() })

  // A deferred load's height arrives during the reset's second drain, and
  // its wait fires while other work holds the contract's lane: the wait's
  // reload is still queued as the height session ends. The failed reset
  // must keep it, or the slot stays 'loading'. Control: the height arrives
  // before the reset. (Without the lane work, the reload's GET may be in
  // flight when the reset aborts the session, which fails that load.)
  for (const beforeReset of [false, true]) {
    it(beforeReset
      ? 'a failed reset after a wait fired leaves the slot to its reload (control)'
      : 'a failed reset keeps the reload of a wait that fired while it drained, queued behind other lane work', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 60000 })
      await deferFirstLoad()
      addTeardown(() => {
        onContractWait = undefined
        onEndHeightSession = undefined
      })
      const getsBefore = kvGetsRequested()
      let atSessionEnd: { gets: number; height: number } | undefined
      if (beforeReset) {
        setLocalHeight(42)
      } else {
        let calls = 0
        onContractWait = () => {
          // The reset's second drain, once it has queued its own lane work
          // (the filter runs before the selector).
          if (++calls !== 2) return
          onContractWait = undefined
          queueMicrotask(() => {
            sbp('chelonia/private/queueEvent', CONTRACT_ID, () => {
              sbp('chelonia/queueInvocation', CONTRACT_ID, () => sleep(50))
              setLocalHeight(42)
            })
          })
        }
        onEndHeightSession = () => {
          atSessionEnd = { gets: kvGetsRequested() - getsBefore, height: localHeight() }
        }
      }
      await failedReset()
      if (!beforeReset) {
        // The wait had fired, and its reload hadn't run yet.
        assert.deepStrictEqual(atSessionEnd, { gets: 0, height: 42 })
      }
      assert.strictEqual(await whenSettledWithin(UNREAD, 2000), 'loaded')
      await drainLanes()
      assert.strictEqual(kvGetsRequested() - getsBefore, 1)
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
    })
  }

  it('after a failed reset, writes still recover from a value that is ahead', async () => {
    await failedReset()
    await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
    await writeAsDeviceB(NS_CACHE, ['alice', 'bob'], 42)
    server.catchUpOnSync = true
    await within(sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['alice', 'carol'],
      onconflict: mergeNames(['alice', 'carol'])
    }), 'queuedSet')
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('a reset whose teardown throws still lets later sessions recover', async () => {
    let throwOnce = true
    sbp('chelonia/configure', {
      reactiveDel: (obj: Record<string, unknown>, key: string) => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('reactiveDel threw')
        }
        delete obj[key]
      }
    } as unknown as Partial<CheloniaConfig>)
    await assert.rejects(within(sbp('chelonia/reset'), 'the failing reset'), /reactiveDel threw/)
    await within(sbp('chelonia/reset'), 'the next reset')
    setupContract(40)
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'update')
    assert.deepStrictEqual(
      Object.keys(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD) as object).sort(), ['roomA', 'roomB']
    )
  })

  // Such a reset never emits CHELONIA_RESET, but it still replaces the KV
  // session, whose slots then can't settle the old session's waiters.
  it('a reset whose teardown throws rejects a pending whenSettled', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD)
    settling.catch(() => {})
    let failDeletes = true
    addTeardown(() => { failDeletes = false })
    sbp('chelonia/configure', {
      reactiveDel: (obj: Record<string, unknown>, key: string) => {
        if (failDeletes) throw new Error('reactiveDel threw')
        delete obj[key]
      }
    } as unknown as Partial<CheloniaConfig>)
    await assert.rejects(within(sbp('chelonia/reset'), 'the failing reset'), /reactiveDel threw/)
    failDeletes = false
    await assert.rejects(within(settling, 'whenSettled', 300), {
      name: 'AbortError',
      message: `[chelonia/kv] whenSettled: chelonia/reset while waiting for ${CONTRACT_ID}::${UNREAD} to settle`
    })
    // The state is partly torn down: reset again, as an app should.
    await within(sbp('chelonia/reset'), 'the next reset')
  })

  // The writes of UNREAD that recover from a height error, and a raw write
  // that `withHeightRecovery` wraps, queued through the attempt's `queue`.
  const resetWrites = (): Array<[string, () => Promise<unknown>]> => [
    ...heightWrites().map(
      ([name, write]): [string, () => Promise<unknown>] => [name, () => write()]
    ),
    ['a raw write', () => sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (
      { heightWaitMs, queue }: KvHeightRecoveryAttempt
    ) => queue(() => sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, VB, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId, heightWaitMs
    })))]
  ]

  // Queued before reset's abort, behind a task on the contract's public
  // lane that ends once reset drains: the write's lane work runs after the
  // abort.
  for (const [name, write] of resetWrites()) {
    it(`${name} queued before reset aborts, and run while it drains, rejects and writes nothing`, async () => {
      await loadV0At40()
      server.log.length = 0
      addTeardown(() => {
        onContractWait = undefined
        onWaitInFlight = undefined
      })
      let writing: Promise<unknown> | undefined
      let waits = 0
      // Reset's last wait before the abort queues its work synchronously:
      // queue the write right after it.
      onContractWait = () => {
        if (++waits !== 2) return
        onContractWait = undefined
        queueMicrotask(() => {
          const lane = gateLane()
          onWaitInFlight = () => {
            onWaitInFlight = undefined
            lane.open()
          }
          writing = write()
          writing.catch(() => {})
        })
      }
      await within(sbp('chelonia/reset'), 'chelonia/reset')
      assert.ok(writing, 'the write never started')
      await assert.rejects(within(writing, name), { name: 'AbortError' })
      assert.deepStrictEqual(server.posts(), [])
    })
  }

  // Started from the persistence hook: the reset's teardown drops the lane
  // work that is still queued then, and a write on a free lane runs before
  // the teardown.
  for (const [name, write] of resetWrites()) {
    for (const busy of [true, false]) {
      it(busy
        ? `${name} started from the persistence hook behind a busy lane rejects, aborted by the reset`
        : `${name} started from the persistence hook on a free lane completes`, async () => {
        await loadV0At40()
        server.log.length = 0
        let lane: { open: () => void } | undefined
        let writing: Promise<unknown> | undefined
        await within(sbp('chelonia/reset', async () => {
          if (busy) lane = gateLane()
          writing = write()
          writing.catch(() => {})
          if (!busy) await within(writing, name)
          // Queued behind the held task before the teardown.
          else await until(() => publicLaneQueued() >= 2, 'the write queued its lane work')
        }), 'chelonia/reset')
        assert.ok(writing, 'the write never started')
        if (!busy) {
          assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
          return
        }
        lane!.open()
        await assert.rejects(
          within(writing, name),
          { name: 'AbortError', message: /never ran \(chelonia\/reset dropped it/ }
        )
        assert.deepStrictEqual(server.posts(), [])
      })
    }
  }

  // Reset aborts the session while `update`'s inline reload awaits a slow
  // `onUpdate`: the write must not go out once the reload returns.
  it('an update whose inline reload is running when reset aborts rejects, and writes nothing', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    let inOnUpdate: (() => void) | undefined
    const onUpdateStarted = new Promise<void>((resolve) => { inOnUpdate = resolve })
    // Never loaded: with the caller's own `ifMatch`, the update loads the
    // slot first.
    defineSlot({
      key: UNREAD,
      autoLoad: 'never',
      onUpdate: async () => {
        inOnUpdate?.()
        await sleep(300)
      }
    })
    await activateContract()
    // Another contract's lane holds reset in its last wait before the
    // abort: `chelonia/contract/wait` waits for every contract's lanes.
    rootState().contracts[OTHER_CONTRACT_ID] = { HEAD: 'h0', height: 0 } as any
    let held: { open: () => void } | undefined
    let waits = 0
    addTeardown(() => {
      onContractWait = undefined
      delete rootState().contracts[OTHER_CONTRACT_ID]
    })
    onContractWait = () => {
      if (++waits !== 2) return
      onContractWait = undefined
      held = gateLane({ contractID: OTHER_CONTRACT_ID })
    }
    const resetting = sbp('chelonia/reset')
    resetting.catch(() => {})
    await until(() => !!held, 'reset reached its last wait before the abort')
    server.log.length = 0
    const updating = sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      ifMatch: '*',
      updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    updating.catch(() => {})
    await within(onUpdateStarted, 'the reload reached onUpdate')
    assert.deepStrictEqual(server.log.map((e) => `${e.method} ${e.status}`), ['GET 200'])
    held!.open()
    await assert.rejects(within(updating, 'the update'), { name: 'AbortError' })
    await within(resetting, 'chelonia/reset')
    assert.deepStrictEqual(server.log.map((e) => `${e.method} ${e.status}`), ['GET 200'])
  })
})

describe('a write whose queueing a filter vetoes', () => {
  // Filters can't be removed: armed by the test, disarmed by its teardown.
  const veto = {
    queueInvocation: false, withHeightRecovery: false, publicLane: false, internalLane: false
  }
  const disarm = () => {
    veto.queueInvocation = false
    veto.withHeightRecovery = false
    veto.publicLane = false
    veto.internalLane = false
  }
  sbp('sbp/filters/selector/add', 'chelonia/queueInvocation', () => {
    if (veto.queueInvocation) return false
  })
  sbp('sbp/filters/selector/add', 'chelonia/kv/withHeightRecovery', () => {
    if (veto.withHeightRecovery) return false
  })
  // The selectors `chelonia/queueInvocation` calls: the queueing on the
  // internal lane that it waits for, and of its body on the public lane.
  sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent', (
    _domain: string, _selector: string, data: unknown[]
  ) => {
    if (veto.publicLane && String(data[0]).startsWith('public:')) return false
    if (veto.internalLane && data[0] === CONTRACT_ID) return false
  })

  for (const [name, write] of heightWrites()) {
    it(`${name} rejects as vetoed, and writes nothing`, async () => {
      await loadV0At40()
      server.log.length = 0
      addTeardown(disarm)
      veto.queueInvocation = true
      await assert.rejects(
        within(write(), name),
        (e: unknown) => e instanceof ChelErrorUnexpected &&
          e.message === `[chelonia/kv] queueing work for ${CONTRACT_ID} was vetoed`
      )
      disarm()
      assert.deepStrictEqual(server.posts(), [])
    })

    // Indistinguishable from a reset dropping the queued work, so the
    // message names both.
    it(`${name} rejects as never run when a lane selector is vetoed, and writes nothing`, async () => {
      await loadV0At40()
      server.log.length = 0
      addTeardown(disarm)
      veto.publicLane = true
      await assert.rejects(within(write(), name), {
        name: 'AbortError',
        message: `[chelonia/kv] the queued work for ${CONTRACT_ID} never ran ` +
          '(chelonia/reset dropped it, or a filter vetoed a lane selector)'
      })
      disarm()
      assert.deepStrictEqual(server.posts(), [])
    })
  }

  it('queuedSet rejects as vetoed when its withHeightRecovery is vetoed', async () => {
    await loadV0At40()
    server.log.length = 0
    addTeardown(disarm)
    veto.withHeightRecovery = true
    const queuedSet = heightWrites().find(([name]) => name === 'queuedSet')![1]
    await assert.rejects(
      within(queuedSet(), 'queuedSet'),
      (e: unknown) => e instanceof ChelErrorUnexpected &&
        e.message === `[chelonia/kv] queuedSet: ${CONTRACT_ID}::${UNREAD}: withHeightRecovery was vetoed`
    )
    disarm()
    assert.deepStrictEqual(server.posts(), [])
  })

  // `chelonia/queueInvocation` rejects, rather than throw a `TypeError`.
  it('update and single-key sync reject as vetoed when the internal-lane queueing is vetoed', async () => {
    await loadV0At40()
    server.log.length = 0
    addTeardown(disarm)
    veto.internalLane = true
    const isVetoed = (e: unknown) => e instanceof ChelErrorUnexpected &&
      e.message === `[chelonia] queueInvocation: queueing on ${CONTRACT_ID} was vetoed`
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update'), isVetoed)
    await assert.rejects(within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'the key sync'), isVetoed)
    disarm()
    assert.deepStrictEqual(server.posts(), [])
  })
})

// Once `kv/set` resolved, an abort can't cancel anything: the write is
// applied and the call resolves (KV-REVAMPED.md §4.2).
describe('abort after the write committed', () => {
  // A loaded slot, whose next POST aborts `controller` once the server has
  // answered it with a 204: the write has committed, and its call has
  // received the response.
  const loadedThenAbortOnPost = async (value: JSONType) => {
    await writeAsDeviceB(UNREAD, value, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    const controller = new AbortController()
    server.log.length = 0
    sbp('chelonia/configure', {
      fetch: async (url: string, opts: KvFetchOptions = {}) => {
        const response = await server.fetch(url, opts)
        if (opts.method === 'POST' && response.status === 204) controller.abort()
        return response
      }
    } as unknown as Partial<CheloniaConfig>)
    return controller
  }

  it('update resolves with the stored value, and the mirror has it', async () => {
    const controller = await loadedThenAbortOnPost(V0)
    const reasons: string[] = []
    onEvent(CHELONIA_KV_UPDATED, (p: any) => { if (p.key === UNREAD) reasons.push(p.reason) })
    const result = await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      signal: controller.signal,
      updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    }), 'the update')
    const written = { roomA: room('a1', 1, [{ messageHash: 'a2', createdHeight: 5 }]) }
    assert.deepStrictEqual(result, written)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), written)
    assert.deepStrictEqual(mirror(UNREAD).value, written)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
    assert.deepStrictEqual(reasons, ['local'])
  })

  it("a caller that retries after it doesn't apply a non-idempotent reducer twice", async () => {
    const controller = await loadedThenAbortOnPost({ n: 0 })
    const increment = (prev: any) => ({ n: prev.n + 1 })
    const update = (signal?: AbortSignal) => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, signal, updater: increment
    })
    // A caller that retries what rejects.
    await within(update(controller.signal).catch(() => update()), 'the update')
    assert.deepStrictEqual(server.value(UNREAD), { n: 1 })
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it("clear resolves, and the mirror is 'non-init'", async () => {
    const controller = await loadedThenAbortOnPost(V0)
    assert.strictEqual(
      await within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { signal: controller.signal }), 'the clear'),
      undefined
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).value, undefined)
    assert.strictEqual(mirror(UNREAD).etag, server.etagOf(UNREAD))
  })

  it('queuedSet resolves with the etag of the stored value', async () => {
    const controller = await loadedThenAbortOnPost(V0)
    const result = await within(sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: UNREAD, data: VB, ifMatch: '*', signal: controller.signal
    }), 'the queuedSet')
    assert.deepStrictEqual(result, { etag: server.etagOf(UNREAD) })
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })
})

// The caller's signal ends a write whose work is still queued on the
// contract's lanes (behind a busy lane, or a recovery sync), rather than
// when that work finally runs. The work then writes nothing.
describe('abortable writes', () => {
  const update = (signal: AbortSignal) => sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5), signal
  })

  it('a retry queued behind a recovery sync that timed out rejects at the abort', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const controller = new AbortController()
    const started = Date.now()
    const updating = update(controller.signal)
    await within(held.started, 'the recovery sync')
    // The height arrives some other way: the recovery's timeout then
    // queues the retry, behind the held sync.
    later(() => setLocalHeight(42), 100)
    later(() => controller.abort(), 1000)
    await assert.rejects(within(updating, 'the update'), { name: 'AbortError' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `rejected after ${elapsed} ms`)
    held.release()
    await drainLanes()
    // The retry's work ran once the sync ended, and wrote nothing.
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it("a write awaited on another contract's lane ends at its abort, and writes nothing later", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    let escape!: () => void
    const escaped = new Promise<void>((resolve) => { escape = resolve })
    addTeardown(escape)
    let syncEnded = false
    // The recovery sync needs the other contract's lane (e.g. it processes
    // an event whose handling waits for it), whose side effect awaits the
    // write: a lane cycle, with or without a height error.
    server.onSync = async () => {
      server.onSync = null
      setLocalHeight(42)
      await Promise.race([
        sbp('chelonia/private/queueEvent', OTHER_CONTRACT_ID, () => {}), escaped
      ])
      syncEnded = true
    }
    const controller = new AbortController()
    later(() => controller.abort(), 1000)
    const started = Date.now()
    const sideEffect = sbp(
      'chelonia/private/queueEvent', OTHER_CONTRACT_ID, () => update(controller.signal)
    )
    await assert.rejects(
      within(sideEffect, "the other contract's side effect"), { name: 'AbortError' }
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `rejected after ${elapsed} ms`)
    // With the side effect done, the cycle is broken: the sync ends, and
    // the retry's work runs without writing.
    await until(() => syncEnded, 'the recovery sync ended')
    await drainLanes()
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    assert.strictEqual(localHeight(), 42)
  })

  for (const [name, write] of heightWrites()) {
    it(`${name} queued behind a busy lane rejects at the abort, and writes nothing`, async () => {
      await loadV0At40()
      server.log.length = 0
      const busy = gateLane({ lane: 'internal' })
      const controller = new AbortController()
      const started = Date.now()
      const writing = write({ signal: controller.signal })
      later(() => controller.abort(), 100)
      await assert.rejects(within(writing, name), { name: 'AbortError' })
      const elapsed = Date.now() - started
      assert.ok(elapsed < 600, `rejected after ${elapsed} ms`)
      busy.open()
      await drainLanes()
      assert.deepStrictEqual(server.posts(), [])
    })
  }

  it('chelonia/reset still waits for the work of a write aborted while queued', async () => {
    let matches = true
    await writeAsDeviceB(UNREAD, V0, 40)
    defineSlot({ key: UNREAD, match: () => matches })
    await activateContract()
    server.log.length = 0
    const busy = gateLane({ lane: 'internal' })
    const controller = new AbortController()
    const updating = update(controller.signal)
    controller.abort()
    await assert.rejects(within(updating, 'the update'), { name: 'AbortError' })
    // With the slot deactivated, only the pending-write count covers the queued work.
    matches = false
    sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    const draining = sbp('chelonia/kv/_waitInFlight')
    assert.strictEqual(await settledOr(draining, 200, 'pending'), 'pending')
    busy.open()
    await within(draining, '_waitInFlight')
    await within(sbp('chelonia/reset'), 'chelonia/reset')
    assert.deepStrictEqual(server.posts(), [])
  })
})
