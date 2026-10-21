// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// the writes' passive height wait, `chelonia/kv/withHeightRecovery`, an
// update that gives up on a value that is ahead, and the guarantees that
// replace an app-level height guard.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import { ChelErrorKvHeightAhead, isKvHeightAhead } from './errors.js'
import {
  CONTRACT_ID,
  INVALID_HEIGHT_RECOVERY_OPTIONS,
  MERGED_A2,
  NS_CACHE,
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
  deleteChatRoomUnreadMessages,
  drainLanes,
  gateLane,
  heightWait,
  heightWrites,
  holdNextSync,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  isAheadAt42,
  isInvalidOptions,
  later,
  loadV0At40,
  localHeight,
  mergeNames,
  mirror,
  namesWrittenAhead,
  probePublicLaneOnSync,
  server,
  setLocalHeight,
  setupStaleDeviceA,
  sleep,
  slotStatus,
  subscribeContract,
  until,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { logged, settledOr } from './test-utils.js'
import type { JSONType, KvHeightRecoveryAttempt } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

// `update`, `clear` and `queuedSet` sync and retry when the server requires
// a height the local contract hasn't reached, so they don't let `kv/set`
// wait passively for it first (with the contract's lane held), except on
// their last attempt; with `onHeightAhead: 'reject'` they never wait.
//
// The setup restores the production `waitMs`. Only the "last attempt waits
// passively" tests keep it; the others set a wait long enough that
// waiting would show in their timings.
describe('the passive height wait, with the production `waitMs`', () => {
  // The slot is loaded at 40, and the server has processed contract events
  // (no KV change) up to 42, which a recovery sync delivers.
  const loadedThenServerMovesOn = async () => {
    await loadV0At40()
    server.height = 42
    server.catchUpOnSync = true
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: null })
    server.log.length = 0
  }
  // Queues a task on the contract's public lane 50 ms after `started`, and
  // records when (relative to `started`) it ran.
  const probeLane = (started: number) => {
    const probe: { ranAt?: number } = {}
    later(() => {
      sbp('chelonia/queueInvocation', CONTRACT_ID, () => { probe.ranAt = Date.now() - started })
    }, 50)
    return probe
  }

  for (const [name, write] of heightWrites()) {
    it(`${name} on a client that is behind syncs at once, without holding the lane`, async () => {
      await loadedThenServerMovesOn()
      // A passive wait would take 2 s. (Not skipped for a closed socket:
      // this file never connects, so only the write's own choice, no wait
      // while recoveries are left, skips it.)
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
      const started = Date.now()
      const lane = probeLane(started)
      await write()
      assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
      await until(() => lane.ranAt !== undefined, 'the lane probe never ran')
      assert.ok(lane.ranAt! < 1000, `the lane probe ran after ${lane.ranAt} ms`)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
      assert.strictEqual(server.syncs, 2) // activation + one recovery
    })
  }

  it('a server that keeps moving costs one sync per stale stamp, not a wait', async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 2000 })
    // The first POST (stamped 40) finds the server at 42 (409). The second,
    // stamped 42 after a recovery, finds it one event further on (43): a
    // 409 again. The third, after a second recovery, goes through.
    server.onPost = (n) => { if (n === 2) server.height = 43 }
    const started = Date.now()
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
    })
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '40'], [409, '42'], [204, '43']
    ])
    assert.strictEqual(server.syncs, 3) // activation + two recoveries
  })

  // Each of the first three POSTs finds the server one event further on (a
  // 409), and pubsub brings that event 20 ms later: the recoveries keep
  // falling one event short, and only the last attempt's passive wait lets
  // the write through.
  for (const [name, write] of heightWrites()) {
    it(`${name}'s last attempt waits passively for a height that is about to arrive`, async () => {
      await loadedThenServerMovesOn()
      server.height = 40
      server.onPost = (n) => {
        if (n > 3) return
        const height = ++server.height
        later(() => { if (localHeight() < height) setLocalHeight(height) }, 20)
      }
      await within(write(), `${name} settles`, 5000)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
        [409, '40'], [409, '41'], [409, '42'], [204, '43']
      ])
      assert.strictEqual(server.syncs, 3) // activation + two recoveries
    })
  }

  for (const [name, write] of heightWrites({ onHeightAhead: 'reject' })) {
    it(`${name} with onHeightAhead: 'reject' rejects without waiting, and frees the lane`, async () => {
      await loadedThenServerMovesOn()
      // A passive wait would take 3 s.
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
      const started = Date.now()
      const lane = probeLane(started)
      await assert.rejects(within(write(), `${name} settles`, 5000), (e: unknown) => isKvHeightAhead(e))
      assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
      await until(() => lane.ranAt !== undefined, 'the lane probe never ran')
      assert.ok(lane.ranAt! < 1000, `the lane probe ran after ${lane.ranAt} ms`)
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40']])
      assert.strictEqual(server.syncs, 1) // activation only
    })
  }

  it('raw kv/set waits passively, unless given heightWaitMs: 0', async () => {
    await loadedThenServerMovesOn()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1000 })
    const set = (options: Record<string, unknown> = {}) => sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId, ...options
    })
    // Fires before the 1 s wait of the call below, which starts later.
    let waited = false
    later(() => { waited = true }, 1000)
    await assert.rejects(set(), (e: unknown) => isKvHeightAhead(e))
    assert.ok(waited, 'the write rejected before its passive wait ended')
    const started = Date.now()
    await assert.rejects(set({ heightWaitMs: 0 }), (e: unknown) => isKvHeightAhead(e))
    assert.ok(Date.now() - started < 500)
    // A height already reached needs no wait.
    setLocalHeight(42)
    await set({ heightWaitMs: 0 })
    for (const heightWaitMs of [-1, NaN, Infinity, '0']) {
      await assert.rejects(set({ heightWaitMs }), TypeError)
    }
  })

  // `setTimeout` fires at once (with a `TimeoutOverflowWarning`) for a
  // delay above 2 ** 31 - 1 ms, so a longer wait is capped at that.
  for (const heightWaitMs of [Number.MAX_SAFE_INTEGER, 2 ** 31, 2 ** 31 - 1]) {
    it(`raw kv/set with heightWaitMs: ${heightWaitMs} keeps waiting for the height`, async () => {
      await loadedThenServerMovesOn()
      const warned: string[] = []
      // Only this warning: others (e.g. a deprecation) aren't the point.
      const onWarning = (w: Error) => {
        if (w.name === 'TimeoutOverflowWarning') warned.push(w.name)
      }
      process.on('warning', onWarning)
      addTeardown(() => { process.off('warning', onWarning) })
      const controller = new AbortController()
      addTeardown(() => controller.abort())
      const setting = sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
        ifMatch: '*',
        signingKeyId: cskId,
        encryptionKeyId: cekId,
        heightWaitMs,
        signal: controller.signal
      }) as Promise<unknown>
      setting.catch(() => {})
      assert.strictEqual(await settledOr(setting, 300, 'pending'), 'pending')
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepStrictEqual(warned, [])
      // The wait still ends once the height arrives, and the write commits.
      setLocalHeight(42)
      await within(setting, 'kv/set')
      assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
        [409, '40'], [204, '42']
      ])
    })
  }

  // The contract is removed while the recovery's sync waits on the busy
  // internal lane: no event can arrive for it any more, so the recovery
  // gives up without the passive wait.
  it('a recovery for a contract removed while its sync was queued rejects without waiting', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 1500 })
    await loadV0At40()
    const busy = gateLane({ lane: 'internal' })
    const removing = sbp('chelonia/contract/remove', CONTRACT_ID)
    let attempts = 0
    const recovering = sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, async () => {
      attempts++
      throw new ChelErrorKvHeightAhead('[test] ahead', {
        cause: { requiredHeight: 42, exact: true, localHeight: 40, etag: null, httpStatus: 412 }
      })
    })
    recovering.catch(() => {})
    await sleep(20)
    const started = Date.now()
    busy.open()
    await within(removing, 'the removal')
    await assert.rejects(within(recovering, 'the recovery'), isAheadAt42)
    assert.ok(Date.now() - started < 500, `rejected after ${Date.now() - started} ms`)
    assert.strictEqual(attempts, 1)
  })
})

// The height recovery docs/kv.md suggests to raw `kv/set` callers.
describe('chelonia/kv/withHeightRecovery', () => {
  type AttemptInfo = Pick<KvHeightRecoveryAttempt, 'recoveries' | 'heightWaitMs'>
  // A raw `kv/set` of `data` under `key`, wrapped as docs/kv.md shows: the
  // key IDs resolved inside the attempt, the write queued with `queue`, and
  // `signal` passed on to `kv/set` too. Each attempt's info is pushed to
  // `seen`.
  const recoveredSet = (
    key: string,
    data: JSONType,
    options: { signal?: AbortSignal } & Record<string, unknown> = {},
    seen: AttemptInfo[] = []
  ): Promise<{ etag: string | null }> => {
    const ifMatch = server.etagOf(key)
    const { signal } = options
    return sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (
      { recoveries, heightWaitMs, queue }: KvHeightRecoveryAttempt
    ) => {
      seen.push({ recoveries, heightWaitMs })
      return queue(() => {
        const encryptionKeyId = sbp('chelonia/contract/currentKeyIdByName', CONTRACT_ID, 'cek')
        if (!encryptionKeyId) throw new Error(`${CONTRACT_ID} has no 'cek' key`)
        return sbp('chelonia/kv/set', CONTRACT_ID, key, data, {
          ifMatch,
          signingKeyId: sbp('chelonia/contract/currentKeyIdByName', CONTRACT_ID, 'csk'),
          encryptionKeyId,
          heightWaitMs,
          signal
        })
      })
    }, options)
  }
  // The server has processed contract events (no KV change) that this
  // client hasn't: its next write of each of `keys` gets a 409. (A
  // recovery racing a release is in `sync-contract.test.ts`.)
  const behind = async ({ keys = [UNREAD] } = {}) => {
    for (const key of keys) await writeAsDeviceB(key, V0, 40)
    await subscribeContract()
    await sbp('chelonia/contract/retain', CONTRACT_ID)
    server.height = 42
    server.log.length = 0
  }

  it('recovers once the sync brings the contract up to date', async () => {
    await behind()
    server.catchUpOnSync = true
    const seen: AttemptInfo[] = []
    await within(recoveredSet(UNREAD, VB, {}, seen), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [[409, '40'], [204, '42']])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    assert.deepStrictEqual(seen, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: 0 }
    ])
  })

  // The replacement for an app's guard around a raw `kv/get` (docs/kv.md).
  it('recovers a raw kv/get of a value that is ahead after one sync', async () => {
    await behind()
    await writeAsDeviceB(UNREAD, VB, 42)
    server.catchUpOnSync = true
    const syncsBefore = server.syncs
    const got = await within(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (
      { queue }: KvHeightRecoveryAttempt
    ) => queue(() => sbp('chelonia/kv/get', CONTRACT_ID, UNREAD))), 'the read') as { data: unknown }
    assert.deepStrictEqual(got.data, VB)
    assert.strictEqual(server.syncs - syncsBefore, 1)
    assert.deepStrictEqual(server.gets().map((g) => g.status), [200, 200])
  })

  // Without it, the attempt's passive wait would go on, and write once the
  // height arrives.
  it("passes its signal on to kv/set, which ends the attempt's passive wait", async () => {
    await behind()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const controller = new AbortController()
    const writing = recoveredSet(UNREAD, VB, { maxHeightRecoveries: 0, signal: controller.signal })
    await until(() => server.posts().length === 1, 'the first POST')
    later(() => controller.abort(), 50)
    later(() => setLocalHeight(42), 150)
    await assert.rejects(within(writing, 'the write settles'), { name: 'AbortError' })
    await sleep(250)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
  })

  it('retries when its sync fails but the contract reached the height anyway', async () => {
    await behind()
    server.onSync = () => {
      setLocalHeight(42)
      throw new Error('sync failed (503)')
    }
    await within(recoveredSet(UNREAD, VB), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    assert.ok(logged(warnings, 'retrying, since the contract reached height'))
  })

  it("rejects with the write's error when the sync fails", async () => {
    await behind()
    server.onSync = () => { throw new Error('sync failed (503)') }
    await assert.rejects(
      within(recoveredSet(UNREAD, VB), 'the write settles'), (e: unknown) => isKvHeightAhead(e)
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409])
    assert.ok(logged(warnings, 'giving up on height recovery'))
  })

  it('retries when its sync fails but the height arrives within the passive wait after it', async () => {
    await behind()
    server.onSync = () => {
      // E.g. pubsub delivers the missing events shortly after the sync
      // failed (within the 50 ms test wait).
      later(() => setLocalHeight(42), 20)
      throw new Error('sync failed (503)')
    }
    await within(recoveredSet(UNREAD, VB), 'the write settles')
    assert.deepStrictEqual(server.posts().map((p) => p.status), [409, 204])
    assert.deepStrictEqual(server.value(UNREAD), VB)
    // (A 409's required height is a lower bound: 41.)
    assert.ok(logged(warnings, 'retrying, since the contract reached height 41 anyway'))
  })

  it('runs no sync when the contract reached the height after the attempt failed', async () => {
    await behind()
    const syncsBefore = server.syncs
    let attempts = 0
    const result = await within(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, () => {
      if (++attempts > 1) return Promise.resolve('done')
      // E.g. pubsub brought the contract there after the server rejected
      // the write.
      setLocalHeight(42)
      return Promise.reject(new ChelErrorKvHeightAhead('ahead', {
        cause: { requiredHeight: 42, exact: true }
      }))
    }), 'the recovery')
    assert.strictEqual(result, 'done')
    assert.strictEqual(attempts, 2)
    assert.strictEqual(server.syncs, syncsBefore)
  })

  it('an already-aborted signal rejects before the first attempt', async () => {
    await behind()
    const controller = new AbortController()
    controller.abort()
    const requestsBefore = server.requests.length
    const seen: AttemptInfo[] = []
    await assert.rejects(
      within(recoveredSet(UNREAD, VB, { signal: controller.signal }, seen), 'the write settles'),
      { name: 'AbortError' }
    )
    assert.deepStrictEqual(seen, [])
    // queuedSet, which passes its signal on to `kv/set` too, sends nothing.
    await assert.rejects(
      within(sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID, key: UNREAD, data: VB, signal: controller.signal
      }), 'queuedSet'),
      { name: 'AbortError' }
    )
    assert.strictEqual(server.requests.length, requestsBefore)
  })

  it('concurrent writes share one sync', async () => {
    const keys = ['k1', 'k2', 'k3']
    await behind({ keys })
    server.catchUpOnSync = true
    server.onSync = () => sleep(200)
    const syncsBefore = server.syncs
    await within(
      Promise.all(keys.map((key) => recoveredSet(key, VB))), 'the writes settle', 5000
    )
    assert.strictEqual(server.syncs - syncsBefore, 1)
    for (const key of keys) assert.deepStrictEqual(server.value(key), VB)
  })

  it('passes heightWaitMs: 0 until the last attempt, which waits passively', async () => {
    await behind()
    // The recovery sync doesn't bring the contract up to date; the height
    // arrives (e.g. through pubsub) during the last attempt's passive wait.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const seen: AttemptInfo[] = []
    server.onPost = (n) => {
      if (n === 2) later(() => setLocalHeight(42), 50)
    }
    await within(
      recoveredSet(UNREAD, VB, { maxHeightRecoveries: 1 }, seen), 'the write settles', 2000
    )
    assert.deepStrictEqual(seen, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: undefined }
    ])
    assert.deepStrictEqual(server.posts().map((p) => [p.status, p.height]), [
      [409, '40'], [409, '40'], [204, '42']
    ])
  })

  it("with onHeightAhead: 'reject', runs one attempt, without waiting or syncing", async () => {
    await behind()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const seen: AttemptInfo[] = []
    const syncsBefore = server.syncs
    const started = Date.now()
    await assert.rejects(
      within(recoveredSet(UNREAD, VB, { onHeightAhead: 'reject' }, seen), 'the write settles'),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
    assert.deepStrictEqual(seen, [{ recoveries: 0, heightWaitMs: 0 }])
    assert.strictEqual(server.syncs, syncsBefore)
  })

  it('rejects invalid options, and an attempt that is not a function, before running it', async () => {
    let attempts = 0
    const attempt = () => { attempts++; return Promise.resolve() }
    for (const options of INVALID_HEIGHT_RECOVERY_OPTIONS) {
      await assert.rejects(
        sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, attempt, options),
        isInvalidOptions(`withHeightRecovery: ${CONTRACT_ID}`)
      )
    }
    await assert.rejects(
      sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, attempt, {
        maxHeightRecoveries: -1, label: 'myWrite'
      }),
      isInvalidOptions('myWrite')
    )
    await assert.rejects(sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, null), TypeError)
    assert.strictEqual(attempts, 0)
  })

  it('takes null options as the defaults', async () => {
    const seen: KvHeightRecoveryAttempt[] = []
    const recovering = sbp('chelonia/kv/withHeightRecovery', CONTRACT_ID, (
      info: KvHeightRecoveryAttempt
    ) => {
      seen.push(info)
      return Promise.resolve('done')
    }, null)
    assert.ok(recovering instanceof Promise)
    assert.strictEqual(await within(recovering, 'the recovery'), 'done')
    assert.strictEqual(seen.length, 1)
    const { queue, ...info } = seen[0]
    assert.deepStrictEqual(info, { recoveries: 0, heightWaitMs: 0 })
    assert.strictEqual(typeof queue, 'function')
  })

  // Awaited there, they would deadlock the contract's lanes (the update that
  // ran the callback holds the public lane), as `update` and `clear` would.
  describe('called synchronously from an onUpdate of the same contract', () => {
    // `call` runs from the onUpdate of UNREAD's next local update, and its
    // outcome is pushed to `seen` (its rejection to `rejections`). With
    // `awaited`, the callback waits for it, as an app awaiting it would (but
    // only until the end of the test).
    const fromOnUpdate = async (call: () => Promise<unknown>, { awaited = true } = {}) => {
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      addTeardown(release)
      let armed = false
      const seen: unknown[] = []
      const rejections: unknown[] = []
      defineSlot({
        key: UNREAD,
        onUpdate: (_value: unknown, uctx: any) => {
          if (!armed || uctx.reason !== 'local') return
          armed = false
          const p = call()
          p.then(() => seen.push('resolved'), (e: any) => {
            seen.push(e?.name)
            rejections.push(e)
          })
          if (awaited) return Promise.race([p, released])
        }
      })
      await writeAsDeviceB(UNREAD, V0, 40)
      await activateContract()
      server.log.length = 0
      armed = true
      const updating = sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      })
      return { seen, rejections, updating }
    }
    const queuedSet = () => sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID, key: NS_CACHE, data: ['x'], ifMatch: '*'
    })

    for (const [name, call] of [
      ['queuedSet', queuedSet],
      ['withHeightRecovery', () => recoveredSet(NS_CACHE, ['x'])]
    ] as const) {
      it(`${name} rejects with ChelErrorKvReentrant, whose hint names ${name}`, async () => {
        const { seen, rejections, updating } = await fromOnUpdate(call)
        await within(updating, 'the outer update')
        await until(() => seen.length > 0, `${name} settled`)
        assert.deepStrictEqual(seen, ['ChelErrorKvReentrant'])
        assert.ok(
          (rejections[0] as Error).message.includes(`queueMicrotask(() => sbp('chelonia/kv/${name}'`),
          (rejections[0] as Error).message
        )
        assert.deepStrictEqual(server.posts().map((p) => p.key), [UNREAD])
      })
    }

    it('queuedSet scheduled with queueMicrotask, and not awaited there, succeeds', async () => {
      const { seen, updating } = await fromOnUpdate(() => new Promise((resolve, reject) => {
        queueMicrotask(() => { queuedSet().then(resolve, reject) })
      }), { awaited: false })
      await within(updating, 'the outer update')
      await until(() => seen.length > 0, 'queuedSet settled')
      assert.deepStrictEqual(seen, ['resolved'])
      assert.deepStrictEqual(server.value(NS_CACHE), ['x'])
    })
  })
})

// An `update` that gives up on a server value it can't verify records it as
// a load that found it would: the slot stops presenting "no value", a
// `KV_NOOP` can't resolve against the stale mirror, and the slot reloads
// once the contract reaches the height.
describe('an update that gives up on a value that is ahead', () => {
  // A slot whose first load found no value (settled 'non-init'); then
  // device B writes VB at height 42 while this device stays at 40.
  const settledEmptySlotThenBWrites = async () => {
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(mirror(UNREAD).settled, true)
    await writeAsDeviceB(UNREAD, VB, 42)
    assert.strictEqual(localHeight(), 40)
    server.log.length = 0
  }

  const settledWithin100ms = async () => {
    const controller = new AbortController()
    const settling = sbp('chelonia/kv/whenSettled', CONTRACT_ID, UNREAD, {
      signal: controller.signal
    }) as Promise<string>
    settling.catch(() => {})
    const outcome = await settledOr(settling, 100, 'pending')
    controller.abort()
    return outcome
  }

  const assertRecorded = async (status: 'loading' | 'loaded') => {
    assert.strictEqual(slotStatus(UNREAD), status)
    assert.strictEqual(await settledWithin100ms(), status === 'loading' ? 'pending' : 'loaded')
    // Deleting roomB is a KV_NOOP on the stale mirror: the update reloads
    // first, finds VB still ahead, and rejects instead of resolving.
    const requestsBefore = server.requests.length
    await assert.rejects(
      sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        onHeightAhead: 'reject',
        updater: deleteChatRoomUnreadMessages('roomB')
      }),
      (e: unknown) => isKvHeightAhead(e)
    )
    assert.strictEqual(server.requests.length - requestsBefore, 1)
    const getsBefore = server.gets().length
    setLocalHeight(42)
    await drainLanes()
    assert.strictEqual(server.gets().length - getsBefore, 1)
    assert.strictEqual(slotStatus(UNREAD), 'loaded')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  }

  const write = (options: Record<string, unknown> = {}) => within(sbp('chelonia/kv/update', {
    contractID: CONTRACT_ID,
    key: UNREAD,
    updater: initChatRoomUnreadMessages('roomC', 'c1', 1),
    ...options
  }), 'the update never settled', 5000)

  const failures: Array<[string, () => Promise<void>]> = [
    ["onHeightAhead: 'reject'", async () => {
      await assert.rejects(write({ onHeightAhead: 'reject' }), isAheadAt42)
    }],
    ['maxHeightRecoveries: 0', async () => {
      await assert.rejects(write({ maxHeightRecoveries: 0 }), isAheadAt42)
      assert.strictEqual(server.syncs, 1) // activation only
    }],
    ['a recovery sync that fails', async () => {
      server.onSync = () => { throw new Error('sync failed') }
      await assert.rejects(write(), isAheadAt42)
      server.onSync = null
    }],
    ['a recovery sync that times out', async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 200 })
      const held = holdNextSync()
      await assert.rejects(write(), isAheadAt42)
      held.release()
      await drainLanes()
    }]
  ]

  for (const [name, giveUp] of failures) {
    it(`after ${name}, a settled 'non-init' slot is 'loading' until it loads`, async () => {
      // Keep the deferred-reload fallback out of the way.
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await settledEmptySlotThenBWrites()
      await giveUp()
      assert.deepStrictEqual(server.value(UNREAD), VB)
      await assertRecorded('loading')
    })
  }

  it("after onHeightAhead: 'reject', a loaded slot stays 'loaded' and the next update reloads first", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await setupStaleDeviceA()
    await assert.rejects(write({ onHeightAhead: 'reject' }), isAheadAt42)
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), V0)
    await assertRecorded('loaded')
  })

  // An abort ends the recovery of a write whose value was ahead: that value
  // is recorded all the same.
  it("after an abort during the recovery, a settled 'non-init' slot is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
    await settledEmptySlotThenBWrites()
    const held = holdNextSync()
    const controller = new AbortController()
    const writing = write({ signal: controller.signal })
    await held.started
    controller.abort()
    await assert.rejects(writing, { name: 'AbortError' })
    assert.strictEqual(heightWait(UNREAD)?.requiredHeight, 42)
    held.release()
    await drainLanes()
    assert.deepStrictEqual(server.value(UNREAD), VB)
    await assertRecorded('loading')
  })

  // While the reset runs, the wait is only remembered; the failed reset
  // registers it again, as the session goes on. (The reset first waits for
  // the contract's lanes, so it aborts the recovery in the passive wait
  // that follows a failed sync, outside the lanes.)
  it("after a failed reset during the recovery, a settled 'non-init' slot is 'loading' until it loads", async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000, waitMs: 10000 })
    await settledEmptySlotThenBWrites()
    const syncsBefore = server.syncs
    server.onSync = () => { throw new Error('sync failed (503)') }
    const writing = write()
    await until(() => server.syncs === syncsBefore + 1, 'the recovery sync')
    let outcome: string | undefined
    await assert.rejects(within(sbp('chelonia/reset', async () => {
      outcome = await writing.then(() => 'resolved', (e: any) => e.name)
      assert.strictEqual(heightWait(UNREAD), undefined)
      throw new Error('persist failed')
    }), 'the reset'), /persist failed/)
    server.onSync = null
    assert.strictEqual(outcome, 'AbortError')
    assert.strictEqual(heightWait(UNREAD)?.requiredHeight, 42)
    await drainLanes()
    await assertRecorded('loading')
  })
})

// What an app-level height guard (e.g. Group Income's `kv-guard.js`) did,
// and which the library now does instead: these must keep holding for such
// a guard to stay deleted.
describe('guarantees that replace an app-level height guard', () => {
  it('queuedSet recovers with the queue lane released', async () => {
    await namesWrittenAhead()
    server.catchUpOnSync = true
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: NS_CACHE,
      data: ['carol'],
      onconflict: mergeNames(['carol'])
    })
    assert.deepStrictEqual(laneState, ['free'])
    assert.deepStrictEqual(server.value(NS_CACHE), ['alice', 'bob', 'carol'])
  })

  it('single-key kv/sync recovers with the queue lane released', async () => {
    await setupStaleDeviceA()
    server.catchUpOnSync = true
    const laneState = probePublicLaneOnSync()
    await sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD)
    assert.deepStrictEqual(laneState, ['free'])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, UNREAD), VB)
  })

  // E.g. a chatroom contract's side effect (internal lane), or a
  // `queueInvocation` body for it (public lane), that updates an identity
  // slot: it holds the chatroom's lane for the whole recovery, but
  // completes (docs/kv.md, "How height recovery runs").
  const recoveringWriteOutcome: Record<string, { posts: number[]; value: unknown }> = {
    // The value that is ahead (412); after the recovery, the write.
    update: { posts: [412, 204], value: MERGED_A2 },
    // A blind write: it resolves the 412 at once, but its retry's stamp is
    // stale (409). After the recovery, its basis (the mirror's etag) is
    // still stale (412), and the retry goes through.
    clear: { posts: [412, 409, 412, 204], value: null },
    // `ifMatch: '*'`: only the stamp is stale (409); then the write.
    queuedSet: { posts: [409, 204], value: V0 }
  }
  for (const [lane, selector] of [
    ['internal', 'chelonia/private/queueEvent'],
    ['public', 'chelonia/queueInvocation']
  ] as const) {
    for (const [name, write] of heightWrites()) {
      it(`a recovering ${name} awaited on another contract's ${lane} lane completes`, async () => {
        await setupStaleDeviceA()
        server.catchUpOnSync = true
        const syncsBefore = server.syncs
        await within(
          sbp(selector, 'zKvHeightTestChatroomContract', () => write()),
          `the ${name} awaited on the other ${lane} lane`
        )
        // One recovery sync.
        assert.strictEqual(server.syncs - syncsBefore, 1)
        const { posts, value } = recoveringWriteOutcome[name]
        assert.deepStrictEqual(server.posts().map((p) => p.status), posts)
        assert.deepStrictEqual(server.value(UNREAD), value)
      })
    }
  }

  it('a KV_NOOP on a verified, loaded slot makes no request', async () => {
    await loadV0At40()
    const before = server.requests.length
    assert.strictEqual(await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), undefined)
    assert.strictEqual(server.requests.length, before)
  })

  it('a write while the contract is up to date runs no contract sync', async () => {
    await loadV0At40()
    const syncsBefore = server.syncs
    server.log.length = 0
    await sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
    })
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [204])
  })

  it('concurrent recovering writes share one contract sync', async () => {
    const keys = ['a', 'b', 'c']
    for (const key of keys) await writeAsDeviceB(key, { v: 0 }, 40)
    for (const key of keys) defineSlot({ key })
    await activateContract()
    for (const key of keys) await writeAsDeviceB(key, { v: 1 }, 42)
    server.catchUpOnSync = true
    // Slow enough that all three writes (serialized on the lane, each
    // rejecting at once, with no passive wait) fail before the first
    // recovery sync ends, so their recoveries overlap.
    server.onSync = () => sleep(200)
    const syncsBefore = server.syncs
    await Promise.all(keys.map((key) => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key, updater: (prev: any) => ({ ...prev, w: key })
    })))
    assert.strictEqual(server.syncs, syncsBefore + 1)
    for (const key of keys) assert.deepStrictEqual(server.value(key), { v: 1, w: key })
  })

  it('a recovery that times out while still behind rejects with the original error', async () => {
    sbp('chelonia/kv/_testSetHeightTimings', { recoveryTimeoutMs: 300 })
    await setupStaleDeviceA()
    const held = holdNextSync()
    const started = Date.now()
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
      }), 'the update never settled', 2000),
      isAheadAt42
    )
    assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`)
    held.release()
    await drainLanes()
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it('a deferred first load calls onUpdate once, with the server value', async () => {
    const calls: unknown[] = []
    await deferFirstLoad({ onUpdate: (value: unknown) => { calls.push(value) } })
    await advanceLocalHeightOnInternalLane(42)
    await drainLanes()
    assert.deepStrictEqual(calls, [VB])
  })

  it('a deferred first load that gives up never calls onUpdate', async () => {
    const calls: unknown[] = []
    await deferFirstLoad({ onUpdate: (value: unknown) => { calls.push(value) } })
    assert.strictEqual(await whenSettledWithin(UNREAD), 'error')
    await drainLanes()
    assert.deepStrictEqual(calls, [])
  })
})
