import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  ChelErrorKvHeightAhead, ChelErrorKvReentrant, isKvConflict, isKvHeightAhead
} from './errors.js'
import {
  activate, CONTRACT_ID, defineSlot, drainLanes, failedSyncGiveUps, filterCalls,
  gateLane, holdGets, holdSyncs, installKvHarness, keys, logs, mirror, rootState,
  server, serverValue, setLocalHeight, sleep, START_HEIGHT, syncs, update, type UpdateOptions,
  vetoQueue, writeAsDeviceB
} from './kv-height-harness.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import { kvHeightTimings } from './kv-height.js'
import { until, waitMicrotasks, within } from './test-utils.js'
import type {
  ChelContractState, ChelKvGetResult, ChelKvOnConflictCallback, JSONType, KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions
} from './types.js'

// An abort rejects with its reason if that is an Error (STOP, GONE below); with a
// non-Error reason, or none (chelonia/reset aborts without one), with an AbortError
const STOP = new Error('stop')
const GONE = new Error('gone')

describe('KV slot writes against the server', () => {
  installKvHarness()

  it('loads a value another device wrote and writes over it under its etag', async () => {
    const etag = writeAsDeviceB('prefs', { theme: 'dark' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'prefs'), { theme: 'dark' })
    assert.strictEqual(mirror('prefs')?.etag, etag)

    await update('prefs', (prefs) => ({ ...(prefs as object), lang: 'en' }))
    assert.deepStrictEqual(
      server.posts().map(({ ifMatch, status, height }) => ({ ifMatch, status, height })),
      [{ ifMatch: etag, status: 204, height: String(server.height) }]
    )
    assert.deepStrictEqual(serverValue('prefs'), { theme: 'dark', lang: 'en' })
    assert.strictEqual(mirror('prefs')?.etag, server.etagOf('prefs'))
  })

  it('merges a value another device wrote just before the write (412)', async () => {
    writeAsDeviceB('names', ['a'])
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    server.onPost = () => {
      server.onPost = undefined
      writeAsDeviceB('names', ['a', 'b'])
    }

    const merged = await update('names', (names) => [...(names as string[]), 'c'])
    assert.deepStrictEqual(merged, ['a', 'b', 'c'])
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [412, 204])
    assert.deepStrictEqual(serverValue('names'), ['a', 'b', 'c'])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'names'), ['a', 'b', 'c'])
  })

  it('re-signs a write with a stale stamp only once a running sync ends (409)', async () => {
    // Not the 1.5 s default: the sync is held for as long as the test takes
    kvHeightTimings.waitMs = 60_000
    const release = holdSyncs()
    const sync = sbp('chelonia/private/in/sync', CONTRACT_ID) as Promise<void>
    await until(() => sbp('chelonia/contract/isSyncing', CONTRACT_ID), 'the sync to start')
    server.height = START_HEIGHT + 1
    server.onPost = () => {
      server.onPost = undefined
      // The sync reaches the server's height but hasn't ended yet
      setLocalHeight(START_HEIGHT + 1)
    }

    const write = sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', { lang: 'en' }, {
      signingKeyId: keys.cskId, encryptionKeyId: keys.cekId
    }) as Promise<unknown>
    await until(() => server.posts().length === 1, 'the first POST')
    await sleep(20)
    assert.strictEqual(server.posts().length, 1)
    release()
    await within(write, 'kv/set')
    await within(sync, 'the sync')
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [409, String(START_HEIGHT)], [204, String(START_HEIGHT + 1)]
    ])
    assert.deepStrictEqual(serverValue('prefs'), { lang: 'en' })
  })

  it('says only to retry once the contract reaches the height of a value onconflict reads', async () => {
    writeAsDeviceB('prefs', { theme: 'dark' }, START_HEIGHT + 2)
    const messages: string[] = []
    const readCurrentData = (args: { currentData: unknown }) => {
      try {
        return args.currentData
      } catch (e) {
        messages.push((e as Error).message)
      }
    }
    const onconflict: ChelKvOnConflictCallback = async (args) => {
      readCurrentData(args)
      // The app synced the contract before reading the value again
      setLocalHeight(START_HEIGHT + 2)
      readCurrentData(args)
      return false
    }
    const result = await within(sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', { lang: 'en' }, {
      signingKeyId: keys.cskId,
      encryptionKeyId: keys.cekId,
      ifMatch: '"stale"',
      allowUnverifiedConflict: true,
      onconflict
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: null })
    const found = `[chelonia/kv] ${CONTRACT_ID}::prefs: the server value was written at contract ` +
      `height ${START_HEIGHT + 2}`
    assert.deepStrictEqual(messages, [
      `${found}, but the local contract is at height ${START_HEIGHT}; sync the contract and retry`,
      `${found}, which the local contract has reached since; retry`
    ])
  })

  it('a request that a server hook aborts rejects with the abort reason', async () => {
    const fetch: typeof globalThis.fetch = sbp('chelonia/config').fetch
    for (const method of ['GET', 'POST']) {
      const controller = new AbortController()
      const reason = new Error(`${method} aborted`)
      server.onGet = server.onPost = () => { controller.abort(reason) }
      const request = fetch(`https://example.test/kv/${CONTRACT_ID}/names`, {
        method, body: method === 'POST' ? '{}' : undefined, signal: controller.signal
      })
      const error = await within(request.then(() => undefined, (e) => e), `the aborted ${method}`)
      assert.strictEqual(error, reason)
    }
    assert.deepStrictEqual(server.log.map(({ method }) => method), ['GET', 'POST'])
  })
})

const recover = <T>(
  attempt: (args: KvHeightRecoveryAttempt) => T,
  options?: KvHeightRecoveryOptions | null,
  contractID = CONTRACT_ID
) => sbp('chelonia/kv/withHeightRecovery', contractID, attempt, options) as Promise<Awaited<T>>

const localHeight = () => rootState().contracts[CONTRACT_ID]?.height ?? -1

const ahead = (requiredHeight: number) => new ChelErrorKvHeightAhead('ahead', {
  cause: { requiredHeight, exact: true, localHeight: localHeight(), etag: null, httpStatus: 200 }
})

// An attempt that throws a new HeightAhead until the contract reaches `height`
const needs = (height: number) => {
  const calls: Pick<KvHeightRecoveryAttempt, 'recoveries' | 'heightWaitMs'>[] = []
  const errors: Error[] = []
  const attempt = ({ recoveries, heightWaitMs }: KvHeightRecoveryAttempt) => {
    calls.push({ recoveries, heightWaitMs })
    if (localHeight() >= height) return 'done'
    errors.push(ahead(height))
    throw errors[errors.length - 1]
  }
  return { calls, errors, attempt }
}

const syncEnded = (count: number) => () =>
  syncs.count === count && !sbp('chelonia/contract/isSyncing', CONTRACT_ID)

describe('chelonia/kv/withHeightRecovery', () => {
  installKvHarness()

  it('syncs the contract and retries a kv/get of a value from a newer height', async () => {
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, START_HEIGHT + 2)
    syncs.catchUp = true
    const before = syncs.count
    const calls: unknown[] = []
    const result = await within(recover(async ({ recoveries, heightWaitMs }) => {
      calls.push({ recoveries, heightWaitMs })
      return (await sbp('chelonia/kv/get', CONTRACT_ID, 'prefs') as ChelKvGetResult).data
    }), 'the recovered kv/get')
    assert.deepStrictEqual(result, { theme: 'dark' })
    assert.deepStrictEqual(calls, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: 0 }
    ])
    assert.strictEqual(syncs.count, before + 1)
  })

  it('takes a null signal as no signal, as update and clear do', async () => {
    defineSlot({ key: 'prefs' })
    await activate()
    assert.strictEqual(await within(recover(() => 'ran', { signal: null }), 'the call'), 'ran')
    assert.deepStrictEqual(await update('prefs', () => ({ v: 1 }), { signal: null }), { v: 1 })
    await within(sbp('chelonia/kv/clear', CONTRACT_ID, 'prefs', { signal: null }), 'the clear')
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204, 204])
  })

  it('shares one sync between callers, and a signal ends only its own wait', async () => {
    await activate()
    server.height = START_HEIGHT + 1
    syncs.catchUp = true
    const release = holdSyncs()
    const before = syncs.count
    const controller = new AbortController()
    const first = recover(needs(START_HEIGHT + 1).attempt, { signal: controller.signal })
    const second = recover(needs(START_HEIGHT + 1).attempt)
    await until(() => syncs.count === before + 1, 'the recovery sync')
    controller.abort(STOP)
    await assert.rejects(within(first, 'the aborted caller'), (e) => e === STOP)
    release()
    assert.strictEqual(await within(second, 'the other caller'), 'done')
    assert.strictEqual(syncs.count, before + 1)
  })

  it('gives up with the last error once out of recoveries, or at once in other modes', async () => {
    await activate()
    const before = syncs.count
    const limited = needs(START_HEIGHT + 1)
    await assert.rejects(
      within(recover(limited.attempt, { maxHeightRecoveries: 1 }), 'one recovery'),
      (e) => e === limited.errors[1]
    )
    assert.deepStrictEqual(limited.calls, [
      { recoveries: 0, heightWaitMs: 0 }, { recoveries: 1, heightWaitMs: undefined }
    ])
    assert.strictEqual(syncs.count, before + 1)

    const rejecting = needs(START_HEIGHT + 1)
    await assert.rejects(
      within(recover(rejecting.attempt, { onHeightAhead: 'reject' }), 'reject mode'),
      (e) => e === rejecting.errors[0]
    )
    assert.deepStrictEqual(rejecting.calls, [{ recoveries: 0, heightWaitMs: 0 }])
    // A single attempt that may wait for the height, but no sync
    const passive = needs(START_HEIGHT + 1)
    await assert.rejects(
      within(recover(passive.attempt, { maxHeightRecoveries: 0 }), 'no recoveries'),
      (e) => e === passive.errors[0]
    )
    assert.deepStrictEqual(passive.calls, [{ recoveries: 0, heightWaitMs: undefined }])
    assert.strictEqual(syncs.count, before + 1)
  })

  it('recovers only unwrapped height errors, without syncing once the height arrived', async () => {
    await activate()
    const before = syncs.count
    const wrapped = new Error('wrapped', { cause: ahead(START_HEIGHT + 1) })
    let calls = 0
    await assert.rejects(within(recover(() => {
      calls++
      throw wrapped
    }), 'a wrapped error'), (e) => e === wrapped)
    assert.strictEqual(calls, 1)

    // Recognised by name, as for a copy from another build of the library
    const copy = { name: 'ChelErrorKvHeightAhead', cause: { requiredHeight: START_HEIGHT + 1 } }
    let attempts = 0
    const result = await within(recover(() => {
      if (attempts++ > 0) return 'done'
      setLocalHeight(START_HEIGHT + 1)
      throw copy
    }), 'a height error that is no longer ahead')
    assert.strictEqual(result, 'done')
    assert.strictEqual(attempts, 2)
    assert.strictEqual(syncs.count, before)
  })

  it('gives up with the original error if it can\'t sync, unless the height arrives', async () => {
    const unsubscribed = needs(START_HEIGHT + 1)
    await assert.rejects(
      within(recover(unsubscribed.attempt), 'an unsubscribed contract'),
      (e) => e === unsubscribed.errors[0]
    )
    assert.strictEqual(syncs.count, 0)

    await activate()
    const before = syncs.count
    syncs.fail = true
    kvHeightTimings.waitMs = 20
    const failed = needs(START_HEIGHT + 1)
    await assert.rejects(within(recover(failed.attempt), 'a failed sync'), (e) => e === failed.errors[0])
    assert.strictEqual(failed.calls.length, 1)

    // The passive wait after a failed sync stays within the recovery deadline.
    // The sync fails well before the deadline: this is not the "too long" branch.
    kvHeightTimings.waitMs = 60_000
    kvHeightTimings.recoveryTimeoutMs = 250
    const warned = failedSyncGiveUps()
    const late = needs(START_HEIGHT + 1)
    await assert.rejects(within(recover(late.attempt), 'the deadline', 2000), (e) => e === late.errors[0])
    assert.strictEqual(failedSyncGiveUps() - warned, 1, 'gave up after the failed sync')
    await until(syncEnded(before + 2), 'the second failed sync')
    kvHeightTimings.recoveryTimeoutMs = 60_000

    const waiting = needs(START_HEIGHT + 1)
    const pending = recover(waiting.attempt)
    await until(syncEnded(before + 3), 'the third failed sync')
    setLocalHeight(START_HEIGHT + 1)
    assert.strictEqual(await within(pending, 'the height after a failed sync'), 'done')
  })

  it('stops waiting for a slow sync, and retries if the height arrived anyway', async () => {
    await activate()
    kvHeightTimings.recoveryTimeoutMs = 50
    holdSyncs()
    const before = syncs.count
    const first = needs(START_HEIGHT + 1)
    await assert.rejects(within(recover(first.attempt), 'a slow sync'), (e) => e === first.errors[0])

    const second = needs(START_HEIGHT + 1)
    const pending = recover(second.attempt)
    setLocalHeight(START_HEIGHT + 1)
    assert.strictEqual(await within(pending, 'the height during a slow sync'), 'done')
    assert.strictEqual(second.calls.length, 2)
    assert.strictEqual(syncs.count, before + 1)
    // No sync error to print after either warning
    const warnings = logs.entries.filter(({ level, args }) => level === 'warn' &&
      /gave up|reached the height/.test(String(args[0])))
    assert.deepStrictEqual(warnings.map(({ args }) => args.length), [1, 1])
  })

  it('counts a recovery sync that a filter vetoes as a failed one', async () => {
    await activate()
    kvHeightTimings.waitMs = 20
    writeAsDeviceB('prefs', { v: 1 }, START_HEIGHT + 2)
    const before = syncs.count
    const attempts = {
      'kv/get': () => sbp('chelonia/kv/get', CONTRACT_ID, 'prefs'),
      'kv/set': ({ heightWaitMs }: KvHeightRecoveryAttempt) =>
        sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', { v: 2 }, {
          ifMatch: '"stale"',
          heightWaitMs,
          onconflict: async () => [{ v: 2 }, server.etagOf('prefs')],
          signingKeyId: keys.cskId,
          encryptionKeyId: keys.cekId
        })
    }
    for (const [via, attempt] of Object.entries(attempts)) {
      let calls = 0
      const warned = failedSyncGiveUps()
      const lift = vetoQueue(CONTRACT_ID)
      await assert.rejects(within(recover((args) => {
        calls++
        return attempt(args)
      }), via), (e) => isKvHeightAhead(e))
      lift()
      assert.deepStrictEqual([calls, failedSyncGiveUps() - warned], [1, 1], via)
    }
    assert.strictEqual(syncs.count, before)
  })

  it('syncs once more for a caller whose joined sync stopped short of its height', async () => {
    await activate()
    syncs.catchUp = true
    const release = holdSyncs()
    const before = syncs.count
    const low = needs(START_HEIGHT + 1)
    const high = needs(START_HEIGHT + 2)
    const first = recover(low.attempt)
    await until(() => syncs.count === before + 1, 'the first recovery sync')
    const second = recover(high.attempt)
    server.height = START_HEIGHT + 1
    release()
    const releaseFresh = holdSyncs()
    assert.strictEqual(await within(first, 'the first caller'), 'done')
    await until(() => syncs.count === before + 2, 'the fresh sync')
    server.height = START_HEIGHT + 2
    releaseFresh()
    assert.strictEqual(await within(second, 'the second caller'), 'done')
    assert.deepStrictEqual([low.calls.length, high.calls.length], [2, 2])
    assert.strictEqual(syncs.count, before + 2)
  })

  it('ends recovery waits on reset, and starts no recovery sync until it is done', async () => {
    await activate()
    syncs.fail = true
    kvHeightTimings.waitMs = 60_000
    const before = syncs.count
    const waiting = recover(needs(START_HEIGHT + 1).attempt)
    await until(syncEnded(before + 1), 'the failed sync')
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
    const reset = sbp('chelonia/reset', () => cleanup) as Promise<void>
    await assert.rejects(within(waiting, 'the reset caller'), { name: 'AbortError' })

    syncs.fail = false
    await assert.rejects(
      within(recover(needs(START_HEIGHT + 1).attempt), 'a recovery during the reset'),
      { name: 'AbortError' }
    )
    assert.strictEqual(syncs.count, before + 1)
    finishCleanup()
    await within(reset, 'the reset')
  })

  // Queues `start()`'s sync behind a contract sync that hangs (a dead link), in
  // the window before `chelonia/reset` aborts: the reset's second
  // `chelonia/contract/wait` holds its public noop meanwhile. The abort ends the
  // hung sync, and the queued one must not start with the new controller.
  const queueBeforeResetAbort = async (start: () => Promise<unknown>, what: string) => {
    await activate()
    holdSyncs()
    const before = syncs.count
    let calls = 0
    let openPublic!: () => void
    // Each `chelonia/contract/wait` calls this before it queues its noops
    const draining = new Promise<void>((resolve) => {
      const lift = filterCalls('chelonia/contract/wait', () => {
        if (++calls !== 2) return
        lift()
        openPublic = gateLane('public')
        resolve()
      })
    })
    const reset = sbp('chelonia/reset') as Promise<void>
    await within(draining, "the reset's last drain before its abort")
    const queued = () => sbp('okTurtles.eventQueue/queuedInvocations', CONTRACT_ID).length
    await until(() => queued() === 0, 'its internal noop')
    const other = (sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }) as Promise<void>)
      .catch(() => {})
    await until(() => syncs.count === before + 1, 'the other sync')
    const work = start()
    await until(() => queued() === 2, `${what} to be queued`)
    openPublic()
    await assert.rejects(within(work, what), { name: 'AbortError' })
    await within(reset, 'the reset')
    await within(other, 'the other sync')
    assert.strictEqual(syncs.count, before + 1)
  }

  it('skips a recovery sync that a reset aborted while it was queued', () =>
    queueBeforeResetAbort(() => recover(needs(START_HEIGHT + 1).attempt), 'the recovery sync'))

  // Not specific to KV, but this harness can hold the lanes
  it('skips a contract sync that a reset aborted while it was queued', () =>
    queueBeforeResetAbort(
      () => sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the contract sync'
    ))

  it('queues work on the public lane; an abort while queued rejects and skips it', async () => {
    const open = gateLane('public')
    const ran: string[] = []
    const done = recover(({ queue }) => queue(async () => ran.push('done')))
    const controller = new AbortController()
    const aborted = recover(({ queue }) => queue(async () => ran.push('aborted')), {
      signal: controller.signal
    })
    await waitMicrotasks()
    assert.deepStrictEqual(ran, [])
    controller.abort(new Error('stop'))
    await assert.rejects(within(aborted, 'the aborted body'), /stop/)
    open()
    assert.strictEqual(await within(done, 'the queued body'), 1)
    await drainLanes()
    assert.deepStrictEqual(ran, ['done'])
  })

  it('rejects queued work that a reset aborts or drops', async () => {
    // A contract the reset doesn't wait for
    const other = 'zKvOtherContract'
    const open = gateLane('public', other)
    let ran = false
    const body = async () => { ran = true }
    const queuedBefore = recover(({ queue }) => queue(body), null, other)
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
    const reset = sbp('chelonia/reset', () => cleanup) as Promise<void>
    await assert.rejects(within(queuedBefore, 'work queued before the reset'), { name: 'AbortError' })

    const queuedDuring = assert.rejects(
      within(recover(({ queue }) => queue(body), null, other), 'work queued during the reset'),
      { name: 'AbortError' }
    )
    await waitMicrotasks()
    finishCleanup()
    await within(reset, 'the reset')
    open()
    await queuedDuring
    assert.strictEqual(ran, false)
  })

  it('validates the attempt and options before the first attempt', async () => {
    await assert.rejects(recover(undefined as unknown as () => void), {
      name: 'ChelErrorKvUpdateInvalid', message: /`attempt` must be a function/
    })
    let calls = 0
    const attempt = () => ++calls
    for (const options of [
      { onHeightAhead: 'never' }, { maxHeightRecoveries: -1 }, { maxHeightRecoveries: 1.5 },
      { maxHeightRecoveries: '2' }
    ]) {
      await assert.rejects(
        recover(attempt, options as KvHeightRecoveryOptions),
        { name: 'ChelErrorKvUpdateInvalid' }
      )
    }
    await assert.rejects(recover(attempt, { signal: AbortSignal.abort(GONE) }), (e) => e === GONE)
    assert.strictEqual(calls, 0)
    // `null` means the default, and unknown keys are ignored
    const options = { onHeightAhead: null, maxHeightRecoveries: null, label: 'x' }
    assert.strictEqual(await within(recover(attempt, options), 'defaults'), 1)
  })

  it('rejects a synchronous call from the same contract\'s onUpdate', async () => {
    const results: Promise<unknown>[] = []
    defineSlot({
      key: 'prefs',
      defaultValue: {},
      onUpdate: (_value, { reason }) => {
        if (reason !== 'local') return
        results.push(recover(() => 'direct').catch((e) => e))
        queueMicrotask(() => results.push(recover(() => 'deferred')))
      }
    })
    await activate()
    await update('prefs', () => ({ lang: 'en' }))
    await until(() => results.length === 2, 'both calls')
    const [direct, deferred] = await within(Promise.all(results), 'both calls')
    assert.ok(direct instanceof ChelErrorKvReentrant)
    assert.strictEqual(deferred, 'deferred')
  })
})

const queuedSet = (args: Record<string, unknown>) =>
  sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, ...args }) as Promise<{
    etag: string | null
  }>

const renameKey = (id: string, name: string) => {
  const state = rootState() as unknown as Record<string, ChelContractState>
  state[CONTRACT_ID]._vm.authorizedKeys[id].name = name
}

describe('chelonia/kv/queuedSet', () => {
  installKvHarness()

  it('refuses to write plaintext unless asked to, and needs its signing key', async () => {
    renameKey(keys.cekId, 'old-cek')
    await assert.rejects(within(queuedSet({ key: 'note', data: 'secret' }), 'no cek'), {
      name: 'ChelErrorKvUpdateInvalid', message: /refusing to write plaintext/
    })
    await assert.rejects(within(queuedSet({
      key: 'note', data: 'secret', encryptionKeyName: null, signingKeyName: 'nope'
    }), 'no signing key'), { name: 'ChelErrorKvUpdateInvalid', message: /signing key 'nope'/ })
    assert.deepStrictEqual(server.log, [])

    await within(queuedSet({ key: 'note', data: 'in the clear', encryptionKeyName: null }), 'plaintext')
    assert.ok(server.store.get('note')!.body.includes('in the clear'))
    assert.strictEqual(serverValue('note'), 'in the clear')
  })

  it("needs its signing key's secret key, but not its encryption key's", async () => {
    const { secretKeys } = rootState()
    const cskSecret = secretKeys[keys.cskId]
    delete secretKeys[keys.cskId]
    await assert.rejects(within(queuedSet({ key: 'note', data: 'x' }), 'no csk secret'), {
      name: 'ChelErrorKvUpdateInvalid',
      message: `[chelonia/kv] queuedSet: ${CONTRACT_ID}::note: signing key 'csk' ` +
        `(${keys.cskId}) is on the contract, but its secret key is not available`
    })
    assert.deepStrictEqual(server.log, [])

    // Encrypting needs only the public key
    secretKeys[keys.cskId] = cskSecret
    delete secretKeys[keys.cekId]
    await within(queuedSet({ key: 'note', data: 'x' }), 'no cek secret')
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204])
  })

  it('rejects a contract that is not in local state, also one removed while queued', async () => {
    const notLoaded = { name: 'ChelErrorKvUpdateInvalid', message: /is not in local state/ }
    await assert.rejects(
      within(queuedSet({ contractID: 'zKvOtherContract', key: 'note', data: 1 }), 'not loaded'),
      notLoaded
    )
    await activate()
    const open = gateLane('public')
    const removed = assert.rejects(within(queuedSet({ key: 'note', data: 1 }), 'removed'), notLoaded)
    await waitMicrotasks()
    sbp('chelonia/private/removeImmediately', CONTRACT_ID)
    open()
    await removed
    assert.deepStrictEqual(server.posts(), [])
  })

  it('resolves key names when its turn comes; an abort while queued writes nothing', async () => {
    renameKey(keys.cekId, 'old-cek')
    const open = gateLane('public')
    const write = queuedSet({ key: 'note', data: 'secret' })
    const controller = new AbortController()
    const aborted = queuedSet({ key: 'other', data: 'x', signal: controller.signal })
    await waitMicrotasks()
    renameKey(keys.cekId, 'cek')
    controller.abort(STOP)
    await assert.rejects(within(aborted, 'the aborted write'), (e) => e === STOP)
    open()
    await within(write, 'the queued write')
    assert.deepStrictEqual(server.posts().map(({ key, status }) => [key, status]), [['note', 204]])
    assert.ok(!server.store.get('note')!.body.includes('secret'))
    assert.strictEqual(serverValue('note'), 'secret')
  })

  it('reports conflicts as ChelErrorKvConflict, with kv/set\'s cause', async () => {
    const etag = writeAsDeviceB('names', ['a'])
    const conflict = (message: RegExp) => (e: Error) => {
      assert.ok(isKvConflict(e))
      assert.strictEqual(e.name, 'ChelErrorKvConflict')
      assert.match(e.message, message)
      assert.deepStrictEqual(e.cause, { currentStatus: 'present', currentData: ['a'], etag })
      return true
    }
    await assert.rejects(
      within(queuedSet({ key: 'names', data: ['b'], maxAttempts: 5 }), 'no onconflict'),
      conflict(/no onconflict handler/)
    )
    assert.strictEqual(server.posts().length, 1)

    let calls = 0
    const onconflict: ChelKvOnConflictCallback = async () => {
      calls++
      return [['b'], '"stale"']
    }
    await assert.rejects(
      within(queuedSet({ key: 'names', data: ['b'], maxAttempts: null, onconflict }), 'retries'),
      conflict(/ran out of attempts/)
    )
    assert.strictEqual(calls, 2)
    assert.strictEqual(server.posts().length, 4)
  })

  it("says when a conflict's value can't be read, rather than that attempts ran out", async () => {
    let etag = ''
    server.onPost = (key) => { server.onPost = undefined; etag = server.put(key, 'not json') }
    let calls = 0
    const onconflict: ChelKvOnConflictCallback = async () => {
      calls++
      return [['b'], '"stale"']
    }
    await assert.rejects(
      within(queuedSet({ key: 'names', data: ['b'], maxAttempts: 5, onconflict }), 'queuedSet'),
      (e: Error) => {
        assert.ok(isKvConflict(e))
        assert.strictEqual(e.name, 'ChelErrorKvConflict')
        assert.strictEqual(e.message,
          `[chelonia/kv] queuedSet: ${CONTRACT_ID}::names got a conflict whose value can't be read`)
        assert.deepStrictEqual(e.cause, { etag })
        return true
      }
    )
    assert.deepStrictEqual([calls, server.posts().length], [0, 1])
  })

  it('says that attempts ran out for a kv/set conflict error without a reason', async () => {
    filterCalls('chelonia/kv/set', () => {
      throw new ChelErrorKvMaxAttempts('kv/set conflict', { cause: { etag: null } })
    })
    const ranOut = {
      name: 'ChelErrorKvConflict',
      message: `[chelonia/kv] queuedSet: ${CONTRACT_ID}::names ran out of attempts resolving conflicts`
    }
    const onconflict: ChelKvOnConflictCallback = async () => [['b'], '"stale"']
    for (const options of [{ onconflict }, {}]) {
      const write = queuedSet({ key: 'names', data: ['b'], ...options })
      await assert.rejects(within(write, 'queuedSet'), ranOut)
    }
  })

  it('gives onconflict a value from a newer height with allowUnverifiedConflict', async () => {
    writeAsDeviceB('names', ['a'], START_HEIGHT + 2)
    const seen: unknown[] = []
    const onconflict: ChelKvOnConflictCallback = async ({ currentStatus, requiredHeight }) => {
      seen.push([currentStatus, requiredHeight])
      return false
    }
    const args = { key: 'names', data: ['b'], onconflict, onHeightAhead: 'reject' }
    await assert.rejects(within(queuedSet(args), 'a verified write'), (e) => isKvHeightAhead(e))
    assert.deepStrictEqual(seen, [])
    const unverified = queuedSet({ ...args, allowUnverifiedConflict: true })
    assert.deepStrictEqual(await within(unverified, 'an unverified write'), { etag: null })
    assert.deepStrictEqual(seen, [['ahead', START_HEIGHT + 2]])
    assert.strictEqual(syncs.count, 0)
  })

  it('validates its options before any request', async () => {
    for (const options of [
      { maxAttempts: 0 }, { maxAttempts: 1.5 }, { maxAttempts: '3' }, { onHeightAhead: 'never' },
      { maxHeightRecoveries: -1 }
    ]) {
      await assert.rejects(queuedSet({ key: 'note', data: 'x', ...options }), {
        name: 'ChelErrorKvUpdateInvalid', message: /queuedSet: /
      })
    }
    const gone = queuedSet({ key: 'note', data: 'x', signal: AbortSignal.abort(GONE) })
    await assert.rejects(gone, (e) => e === GONE)
    assert.deepStrictEqual(server.log, [])
    // `null` means the default
    const defaults = { maxAttempts: null, onHeightAhead: null, maxHeightRecoveries: null }
    await within(queuedSet({ key: 'note', data: 'x', ...defaults }), 'defaults')
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204])
  })

  it('rejects a synchronous call from the same contract\'s onUpdate', async () => {
    const results: Promise<unknown>[] = []
    defineSlot({
      key: 'prefs',
      defaultValue: {},
      onUpdate: (_value, { reason }) => {
        if (reason !== 'local') return
        results.push(queuedSet({ key: 'note', data: 'direct' }).catch((e) => e))
        queueMicrotask(() => results.push(queuedSet({ key: 'note', data: 'deferred' })))
      }
    })
    await activate()
    await update('prefs', () => ({ lang: 'en' }))
    await until(() => results.length === 2, 'both calls')
    const [direct] = await within(Promise.all(results), 'both calls')
    assert.ok(direct instanceof ChelErrorKvReentrant)
    assert.match(direct.message, /sbp\('chelonia\/kv\/queuedSet'/)
    assert.strictEqual(serverValue('note'), 'deferred')
  })
})

const AHEAD = START_HEIGHT + 2
const appendX = (value: JSONType) => [...(value as string[]), 'x']
const updateWith = (key: string, options: UpdateOptions = {}) =>
  update(key, appendX, options)
const clear = (key: string, options?: Omit<UpdateOptions, 'updater' | 'ifMatch'>) =>
  within(sbp('chelonia/kv/clear', CONTRACT_ID, key, options) as Promise<void>, `clear of ${key}`)

describe('Slot writes and contract heights', () => {
  installKvHarness()

  it('update re-signs once after a sync running when its 409 lands, syncing no more', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    syncs.catchUp = true
    const before = syncs.count
    const release = holdSyncs()
    let sync: Promise<unknown> | undefined
    server.onPost = async () => {
      server.onPost = undefined
      server.height = AHEAD
      sync = sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true })
      await until(() => syncs.count === before + 1, 'the catch-up sync')
      // Partway through its replay
      setLocalHeight(START_HEIGHT + 1)
    }
    const write = updateWith('names')
    await until(() => server.posts()[0]?.status === 409, 'the 409')
    await sleep(20)
    assert.strictEqual(server.posts().length, 1)
    release()
    assert.deepStrictEqual(await write, ['x'])
    await within(sync!, 'the sync')
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [409, String(START_HEIGHT)], [204, String(AHEAD)]
    ])
    assert.strictEqual(syncs.count, before + 1)
  })

  it("update syncs when its 409's stored value is ahead of a height the contract reached meanwhile", async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    syncs.catchUp = true
    const before = syncs.count
    server.onPost = () => {
      server.onPost = undefined
      writeAsDeviceB('names', ['b'], AHEAD)
      // An event arrives, but not up to the stored value's height
      setLocalHeight(START_HEIGHT + 1)
    }
    assert.deepStrictEqual(await updateWith('names', { ifMatch: '*' }), ['x'])
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [409, String(START_HEIGHT)], [204, String(AHEAD)]
    ])
    assert.strictEqual(syncs.count, before + 1)
  })

  it('an abort during its POST rejects at once, and the server may still store the write', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    let answer!: () => void
    const answered = new Promise<void>((resolve) => { answer = resolve })
    server.onPost = () => answered
    const controller = new AbortController()
    const updating = updateWith('names', { signal: controller.signal })
    try {
      await until(() => server.posts().length, 'the POST')
      controller.abort(STOP)
      const error = await within(updating.then(() => undefined, (e) => e), 'the aborted update', 1000)
      assert.strictEqual(error, STOP)
    } finally {
      answer()
    }
    await drainLanes()
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204])
    assert.deepStrictEqual(serverValue('names'), ['x'])
  })

  it("update and clear need their signing key's secret key, and write nothing without it", async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    delete rootState().secretKeys[keys.cskId]
    const noSecret = (label: string) => ({
      name: 'ChelErrorKvUpdateInvalid',
      message: `[chelonia/kv] ${label}: ${CONTRACT_ID}::names: signing key 'csk' ` +
        `(${keys.cskId}) is on the contract, but its secret key is not available`
    })
    await assert.rejects(updateWith('names'), noSecret('update'))
    await assert.rejects(clear('names'), noSecret('clear'))
    assert.deepStrictEqual(server.posts(), [])
  })
})

describe('update\'s reducer basis', () => {
  installKvHarness()

  it("a raw kv/get's signal aborts its own GET only, and a reset aborts it too", async () => {
    writeAsDeviceB('prefs', { theme: 'dark' })
    await activate()
    const get = (options: unknown) => sbp('chelonia/kv/get', CONTRACT_ID, 'prefs', options)
    let hung = holdGets('prefs')
    try {
      const controller = new AbortController()
      const aborted = get({ signal: controller.signal })
      const others = [get(null), get({ signal: new AbortController().signal })]
      await until(() => hung.requests.length === 3, 'the GETs')
      controller.abort(STOP)
      await assert.rejects(within(aborted, 'the aborted kv/get', 1000), (e) => e === STOP)
      assert.deepStrictEqual(hung.requests.map(({ aborted }) => aborted), [true, false, false])
      hung.open()
      for (const other of others) {
        const result = await within(other, 'the other kv/get') as ChelKvGetResult
        assert.deepStrictEqual(result.data, { theme: 'dark' })
      }
      hung = holdGets('prefs')
      const cut = get({ signal: new AbortController().signal })
      await until(() => hung.requests.length, 'the GET')
      await within(sbp('chelonia/reset') as Promise<void>, 'the reset')
      await assert.rejects(within(cut, 'the kv/get cut by the reset', 1000), { name: 'AbortError' })
      assert.ok(hung.requests[0].aborted)
    } finally {
      hung.open()
    }
  })
})

// Each KV request a caller's signal aborts, by the selector that sends it
const inFlight: {
  name: string; method: 'GET' | 'POST'; key: string; call: (signal: AbortSignal) => unknown
}[] = [
  {
    name: 'kv/get',
    method: 'GET',
    key: 'prefs',
    call: (signal) => sbp('chelonia/kv/get', CONTRACT_ID, 'prefs', { signal })
  },
  {
    name: 'kv/set',
    method: 'POST',
    key: 'prefs',
    call: (signal) => sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', { theme: 'x' }, {
      signingKeyId: keys.cskId, encryptionKeyId: keys.cekId, signal
    })
  },
  {
    name: 'kv/set without data',
    method: 'GET',
    key: 'prefs',
    call: (signal) => sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', undefined, {
      signingKeyId: keys.cskId,
      encryptionKeyId: keys.cekId,
      onconflict: () => [{ theme: 'x' }, undefined],
      signal
    })
  },
  {
    name: 'update',
    method: 'POST',
    key: 'prefs',
    call: (signal) => sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: 'prefs', updater: () => ({ theme: 'x' }), signal
    })
  },
  {
    name: 'clear',
    method: 'POST',
    key: 'prefs',
    call: (signal) => sbp('chelonia/kv/clear', CONTRACT_ID, 'prefs', { signal })
  },
  {
    name: 'queuedSet',
    method: 'POST',
    key: 'prefs',
    call: (signal) => queuedSet({ key: 'prefs', data: { theme: 'x' }, signal })
  },
  {
    name: 'withHeightRecovery',
    method: 'GET',
    key: 'prefs',
    call: (signal) => recover(() => sbp('chelonia/kv/get', CONTRACT_ID, 'prefs', { signal }), {
      signal
    })
  }
]

const abortError = (e: unknown) => e instanceof Error && e.name === 'AbortError'

describe('KV requests in flight that the caller aborts', () => {
  installKvHarness()

  for (const { name, method, key, call } of inFlight) {
    it(`${name}: rejects with an Error reason, else with an AbortError`, async () => {
      defineSlot({ key: 'prefs', defaultValue: {} })
      defineSlot({ key: 'lazy', defaultValue: {}, autoLoad: 'never' })
      writeAsDeviceB('prefs', { theme: 'dark' })
      writeAsDeviceB('lazy', { theme: 'dark' })
      await activate()
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      const heldGets = method === 'GET' ? holdGets(key) : undefined
      if (method === 'POST') server.onPost = () => released
      const arrived = () => heldGets ? heldGets.requests.length : server.posts().length
      try {
        for (const [reason, value, expected] of [
          ['an Error reason', STOP, (e: unknown) => e === STOP],
          ['a string reason', 'stop', abortError],
          ['no reason', undefined, abortError]
        ] as const) {
          const before = arrived()
          const controller = new AbortController()
          const settled = Promise.resolve(call(controller.signal)).then(() => 'resolved', (e) => e)
          await until(() => arrived() > before, `the ${method} of ${name} (${reason})`)
          controller.abort(value)
          const error = await within(settled, `${name} aborted with ${reason}`, 1000)
          assert.ok(expected(error), `${name} aborted with ${reason} rejected with ${String(error)}`)
        }
      } finally {
        heldGets?.open()
        release()
      }
    })
  }

  it('kv/set: an abort while the body of the 409 after its last re-sign downloads rejects with its reason', async () => {
    // Each POST finds the server one height ahead, which an event brings the contract to
    server.onPost = () => {
      server.height++
      setLocalHeight(server.height)
    }
    let reading = false
    const handle = server.handle
    server.handle = async (url, init) => {
      const response = await handle(url, init)
      if (server.posts().length < 6 || response?.status !== 409) return response
      const signal = init!.signal!
      const body = new ReadableStream({
        // As a real fetch's body, it fails when the request aborts
        start: (stream) => {
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true })
        },
        pull: () => {
          reading = true
          return new Promise(() => {})
        }
      }, { highWaterMark: 0 })
      return new Response(body, { status: 409, headers: response.headers })
    }
    const controller = new AbortController()
    const settled = (sbp('chelonia/kv/set', CONTRACT_ID, 'prefs', { theme: 'x' }, {
      signingKeyId: keys.cskId, encryptionKeyId: keys.cekId, signal: controller.signal
    }) as Promise<unknown>).then(() => 'resolved', (e) => e)
    await until(() => reading, "the last 409's body to download")
    controller.abort(STOP)
    assert.strictEqual(await within(settled, 'the aborted kv/set', 1000), STOP)
    assert.deepStrictEqual(server.posts().map(({ status }) => status), Array(6).fill(409))
  })
})
