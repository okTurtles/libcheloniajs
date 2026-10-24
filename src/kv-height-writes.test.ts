import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  ChelErrorKvHeightAhead, ChelErrorKvReentrant, isKvConflict, isKvHeightAhead, isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import {
  activate, CONTRACT_ID, defineSlot, drainLanes, gateLane, holdSyncs, installKvHarness, keys,
  mirror, restamp, rootState, server, serverValue, setLocalHeight, START_HEIGHT, syncs,
  writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { until, waitMicrotasks, within } from './test-utils.js'
import type {
  ChelContractState, ChelKvGetResult, ChelKvOnConflictCallback, JSONType, KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions
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

  it('resolves key names when its turn comes; an abort while queued writes nothing', async () => {
    renameKey(keys.cekId, 'old-cek')
    const open = gateLane('public')
    const write = queuedSet({ key: 'note', data: 'secret' })
    const controller = new AbortController()
    const aborted = queuedSet({ key: 'other', data: 'x', signal: controller.signal })
    await waitMicrotasks()
    renameKey(keys.cekId, 'cek')
    controller.abort('stop')
    await assert.rejects(within(aborted, 'the aborted write'), (e) => e === 'stop')
    open()
    await within(write, 'the queued write')
    assert.deepStrictEqual(server.posts().map(({ key, status }) => [key, status]), [['note', 204]])
    assert.ok(!server.store.get('note')!.body.includes('secret'))
    assert.strictEqual(serverValue('note'), 'secret')
  })

  it('syncs at once a contract that is behind and retries, holding no lane meanwhile', async () => {
    await activate()
    server.height = START_HEIGHT + 2
    syncs.catchUp = true
    kvHeightTimings.waitMs = 60_000
    const release = holdSyncs()
    const before = syncs.count
    const write = queuedSet({ key: 'note', data: 'x' })
    await until(() => syncs.count === before + 1, 'the recovery sync')
    const probe = sbp('chelonia/private/queueEvent', `public:${CONTRACT_ID}`, () => 'free')
    assert.strictEqual(await within(probe, 'the public lane'), 'free')
    release()
    await within(write, 'the write')
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [409, String(START_HEIGHT)], [204, String(START_HEIGHT + 2)]
    ])
    assert.strictEqual(syncs.count, before + 1)
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
    const gone = queuedSet({ key: 'note', data: 'x', signal: AbortSignal.abort('gone') })
    await assert.rejects(gone, (e) => e === 'gone')
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
const names = (value: JSONType) => [...(value as string[]), 'x']
const updateWith = (key: string, options: Record<string, unknown> = {}) => within(
  sbp('chelonia/kv/update', { contractID: CONTRACT_ID, key, updater: names, ...options }) as
    Promise<JSONType | undefined>,
  `update of ${key}`
)
const clear = (key: string, options?: Record<string, unknown>) =>
  within(sbp('chelonia/kv/clear', CONTRACT_ID, key, options) as Promise<void>, `clear of ${key}`)
const aheadAt = (height: number) => (e: unknown) => kvHeightAheadCause(e)?.requiredHeight === height
const gets = (key: string) =>
  server.log.filter((request) => request.method === 'GET' && request.key === key).length
const slotState = (key: string) => {
  const entry = mirror(key)
  return [entry?.status, entry?.heightAhead?.requiredHeight, entry?.settled]
}

describe('Slot writes and contract heights', () => {
  installKvHarness()

  it('update syncs a contract behind a newer value and retries, holding no lane meanwhile', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    writeAsDeviceB('names', ['a'], AHEAD)
    syncs.catchUp = true
    kvHeightTimings.waitMs = 60_000
    const release = holdSyncs()
    const write = updateWith('names')
    await until(() => syncs.count === 2, 'the recovery sync')
    const probe = sbp('chelonia/private/queueEvent', `public:${CONTRACT_ID}`, () => 'free')
    assert.strictEqual(await within(probe, 'the public lane'), 'free')
    release()
    assert.deepStrictEqual(await write, ['a', 'x'])
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [412, 412, 204])
    assert.strictEqual(syncs.count, 2)
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])
  })

  it('gives up on a value from a newer height and reloads the key once the height arrives', async () => {
    const keys = ['reject', 'passive', 'failed', 'aborted']
    for (const key of keys) defineSlot({ key, defaultValue: [] })
    await activate()
    for (const key of keys) writeAsDeviceB(key, [key], AHEAD)
    kvHeightTimings.waitMs = 20
    await assert.rejects(updateWith('reject', { onHeightAhead: 'reject' }), aheadAt(AHEAD))
    await assert.rejects(updateWith('passive', { maxHeightRecoveries: 0 }), aheadAt(AHEAD))
    assert.strictEqual(syncs.count, 1)
    syncs.fail = true
    await assert.rejects(updateWith('failed'), aheadAt(AHEAD))
    syncs.fail = false
    const release = holdSyncs()
    const controller = new AbortController()
    const aborted = updateWith('aborted', { signal: controller.signal })
    await until(() => syncs.count === 3, 'the recovery sync')
    controller.abort('stop')
    await assert.rejects(aborted, (e) => e === 'stop')
    for (const key of keys) assert.deepStrictEqual(slotState(key), ['loading', AHEAD, true], key)
    release()
    // A stale stamp (409) reveals no value
    defineSlot({ key: 'stale', defaultValue: [] })
    await drainLanes()
    await assert.rejects(updateWith('stale', { maxHeightRecoveries: 0 }), (e) =>
      isKvHeightAhead(e) && e.cause?.exact === false)
    assert.deepStrictEqual(slotState('stale'), ['non-init', undefined, true])

    setLocalHeight(AHEAD)
    await until(() => keys.every((key) => mirror(key)?.status === 'loaded'), 'the reloads')
    for (const key of keys) {
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, key), [key])
      assert.deepStrictEqual(slotState(key), ['loaded', undefined, true], key)
    }
    assert.strictEqual(server.posts().filter(({ status }) => status === 204).length, 0)
  })

  it('clear overwrites values it can\'t verify without waiting; giving up marks the slot', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    kvHeightTimings.waitMs = 60_000
    writeAsDeviceB('names', ['a'])
    restamp('names', 'not a height')
    await assert.rejects(updateWith('names'), (e) => isKvHeightMalformed(e))
    await clear('names')
    assert.strictEqual(serverValue('names'), null)
    assert.deepStrictEqual(slotState('names'), ['non-init', undefined, true])

    const etag = writeAsDeviceB('names', ['b'], AHEAD)
    await assert.rejects(clear('names', { maxAttempts: 1 }), (e: Error) => {
      assert.strictEqual(e.name, 'ChelErrorKvConflict')
      assert.deepStrictEqual(e.cause, { currentStatus: 'ahead', requiredHeight: AHEAD, etag })
      return true
    })
    assert.deepStrictEqual(slotState('names'), ['loading', AHEAD, true])
    assert.strictEqual(syncs.count, 1)
  })

  it('reports the final conflict\'s value, as the slot reads it', async () => {
    const schema = {
      parse: (value: unknown) => {
        if (!Array.isArray(value)) throw new Error('not a list')
        return value.map(String)
      }
    }
    defineSlot({ key: 'names', defaultValue: [], schema })
    await activate()
    const conflict = (cause: unknown) => (e: Error) => {
      assert.strictEqual(e.name, 'ChelErrorKvConflict')
      assert.deepStrictEqual(e.cause, cause)
      return true
    }
    let etag = writeAsDeviceB('names', [1])
    await assert.rejects(updateWith('names', { maxAttempts: 1 }), conflict({
      currentStatus: 'present', currentData: ['1'], etag
    }))
    // An invalid final value is left out, even after a valid one
    server.onPost = () => {
      if (server.posts().length === 3) etag = writeAsDeviceB('names', 'oops')
    }
    await assert.rejects(updateWith('names', { maxAttempts: 2 }), (e: Error) =>
      conflict({ currentStatus: 'present', etag })(e))
  })

  it('a committed write drops the key\'s wait it saw, but not one for a value found meanwhile', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    writeAsDeviceB('names', ['a'], AHEAD)
    kvHeightTimings.waitMs = 60_000
    await assert.rejects(updateWith('names', { onHeightAhead: 'reject' }), aheadAt(AHEAD))
    // The clear waits for the height after a stale stamp (409); the height
    // arriving then also fires the key's reload, behind the clear
    const cleared = clear('names', { maxHeightRecoveries: 0 })
    await until(() => server.posts().some(({ status }) => status === 409), 'the stale stamp')
    let before = gets('names')
    setLocalHeight(AHEAD)
    await cleared
    await drainLanes()
    assert.strictEqual(gets('names'), before)
    assert.deepStrictEqual(slotState('names'), ['non-init', undefined, true])

    // Found meanwhile: an update gives up while the clear waits after a 409
    writeAsDeviceB('names', ['b'], AHEAD + 1)
    syncs.fail = true
    const controller = new AbortController()
    const stopped = updateWith('names', { signal: controller.signal })
    // Waiting for the height after its sync failed: the lanes are free
    await until(syncEnded(2), 'the failed recovery sync')
    const clearing = clear('names', { maxHeightRecoveries: 0 })
    await until(() => server.posts().filter(({ status }) => status === 409).length === 2, '409')
    controller.abort('stop')
    await assert.rejects(stopped, (e) => e === 'stop')
    assert.deepStrictEqual(slotState('names'), ['loading', AHEAD + 1, true])
    before = gets('names')
    setLocalHeight(AHEAD + 1)
    await clearing
    await drainLanes()
    assert.strictEqual(gets('names'), before + 1)
    assert.deepStrictEqual(slotState('names'), ['non-init', undefined, true])
    assert.strictEqual(serverValue('names'), null)
  })

  it('an abort while queued rejects at once; one after the write committed is ignored', async () => {
    const late = new AbortController()
    defineSlot({ key: 'names', defaultValue: [], onUpdate: () => late.abort('late') })
    await activate()
    const open = gateLane('public')
    const controller = new AbortController()
    const updating = updateWith('names', { signal: controller.signal })
    const clearing = clear('names', { signal: controller.signal })
    await waitMicrotasks()
    controller.abort('stop')
    await assert.rejects(updating, (e) => e === 'stop')
    await assert.rejects(clearing, (e) => e === 'stop')
    open()
    await drainLanes()
    assert.deepStrictEqual(server.posts(), [])

    assert.deepStrictEqual(await updateWith('names', { signal: late.signal }), ['x'])
    assert.ok(late.signal.aborted)
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])
  })

  it('validates its options before any request', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    const requests = server.log.length
    for (const options of [
      { maxAttempts: 0 }, { maxAttempts: '3' }, { onHeightAhead: 'never' }, { maxHeightRecoveries: -1 }
    ]) {
      await assert.rejects(updateWith('names', options), {
        name: 'ChelErrorKvUpdateInvalid', message: /update: /
      })
      await assert.rejects(clear('names', options), {
        name: 'ChelErrorKvUpdateInvalid', message: /clear: /
      })
    }
    await assert.rejects(updateWith('other', { maxAttempts: 0 }), { name: 'ChelErrorKvSlotUnknown' })
    assert.strictEqual(server.log.length, requests)
    // `null` means the default
    const defaults = { maxAttempts: null, onHeightAhead: null, maxHeightRecoveries: null }
    await updateWith('names', defaults)
    await clear('names', defaults)
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204, 204])
  })
})
