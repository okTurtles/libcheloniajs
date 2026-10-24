import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import { ChelErrorKvHeightAhead, ChelErrorKvReentrant } from './errors.js'
import {
  activate, CONTRACT_ID, defineSlot, drainLanes, gateLane, holdSyncs, installKvHarness, keys,
  mirror, rootState, server, serverValue, setLocalHeight, START_HEIGHT, syncs, writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { until, waitMicrotasks, within } from './test-utils.js'
import type {
  ChelKvGetResult, JSONType, KvHeightRecoveryAttempt, KvHeightRecoveryOptions
} from './types.js'

const update = (key: string, updater: (value: JSONType) => JSONType) =>
  within(
    sbp('chelonia/kv/update', { contractID: CONTRACT_ID, key, updater }) as Promise<JSONType>,
    `update of ${key}`
  )

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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(server.posts().length, 1)
    release()
    await within(write, 'kv/set')
    await within(sync, 'the sync')
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [409, String(START_HEIGHT)], [204, String(START_HEIGHT + 1)]
    ])
    assert.deepStrictEqual(serverValue('prefs'), { lang: 'en' })
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
    controller.abort('stop')
    await assert.rejects(within(first, 'the aborted caller'), (e) => e === 'stop')
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
    const result = await within(recover(() => {
      if (calls++ > 1) return 'done'
      setLocalHeight(START_HEIGHT + 1)
      throw copy
    }), 'a height error that is no longer ahead')
    assert.strictEqual(result, 'done')
    assert.strictEqual(calls, 3)
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

    kvHeightTimings.waitMs = 60_000
    const waiting = needs(START_HEIGHT + 1)
    const pending = recover(waiting.attempt)
    await until(syncEnded(before + 2), 'the second failed sync')
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

    const queuedDuring = recover(({ queue }) => queue(body), null, other)
    await waitMicrotasks()
    finishCleanup()
    await within(reset, 'the reset')
    open()
    await assert.rejects(within(queuedDuring, 'work the reset dropped'), { name: 'AbortError' })
    assert.strictEqual(ran, false)
  })

  it('validates the attempt and options before the first attempt', async () => {
    await assert.rejects(recover(undefined as unknown as () => void), TypeError)
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
    await assert.rejects(recover(attempt, { signal: AbortSignal.abort('gone') }), (e) => e === 'gone')
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
