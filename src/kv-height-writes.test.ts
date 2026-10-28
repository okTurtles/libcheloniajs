import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  ChelErrorKvHeightAhead, ChelErrorKvReentrant, isKvConflict, isKvHeightAhead, isKvHeightMalformed
} from './errors.js'
import {
  activate, aheadAt, CONTRACT_ID, defineSlot, drainLanes, gateLane, gets, holdSyncs,
  installKvHarness, keys, logs, mirror, restamp, rootState, server, serverValue, setLocalHeight,
  sleep, START_HEIGHT, syncs, update, writeAsDeviceB
} from './kv-height-harness.js'
import { CHELONIA_KV_STATUS_CHANGED, CHELONIA_KV_UPDATED } from './events.js'
import { KV_NOOP } from './kv-constants.js'
import { kvHeightTimings } from './kv-height.js'
import { until, waitMicrotasks, within } from './test-utils.js'
import type {
  ChelContractState, ChelKvGetResult, ChelKvOnConflictCallback, JSONType, KvHeightRecoveryAttempt,
  KvHeightRecoveryOptions, KvMirrorEntry
} from './types.js'

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

// The lane whose work the filter below vetoes
let vetoedLane: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedLane
)

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

    // The passive wait after a failed sync stays within the recovery deadline
    kvHeightTimings.waitMs = 60_000
    kvHeightTimings.recoveryTimeoutMs = 50
    const late = needs(START_HEIGHT + 1)
    await assert.rejects(within(recover(late.attempt), 'the deadline'), (e) => e === late.errors[0])
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
    const warnings = logs.logged.filter(({ method, args }) => method === 'warn' &&
      /gave up|reached the height/.test(String(args[0])))
    assert.deepStrictEqual(warnings.map(({ args }) => args.length), [1, 1])
  })

  it('counts a recovery sync that a filter vetoes as a failed one', async () => {
    await activate()
    kvHeightTimings.waitMs = 20
    writeAsDeviceB('prefs', { v: 1 }, START_HEIGHT + 2)
    const before = syncs.count
    const gaveUp = () => logs.logged.filter(({ method, args }) => method === 'warn' &&
      /gave up: its sync failed/.test(String(args[0]))).length
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
      const warned = gaveUp()
      vetoedLane = CONTRACT_ID
      try {
        await assert.rejects(within(recover((args) => {
          calls++
          return attempt(args)
        }), via), (e) => isKvHeightAhead(e))
      } finally {
        vetoedLane = undefined
      }
      assert.deepStrictEqual([calls, gaveUp() - warned], [1, 1], via)
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
const appendX = (value: JSONType) => [...(value as string[]), 'x']
const updateWith = (key: string, options: Record<string, unknown> = {}) =>
  update(key, appendX, options)
const clear = (key: string, options?: Record<string, unknown>) =>
  within(sbp('chelonia/kv/clear', CONTRACT_ID, key, options) as Promise<void>, `clear of ${key}`)
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
    const before = syncs.count
    const release = holdSyncs()
    const write = updateWith('names')
    await until(() => syncs.count === before + 1, 'the recovery sync')
    const probe = sbp('chelonia/private/queueEvent', `public:${CONTRACT_ID}`, () => 'free')
    assert.strictEqual(await within(probe, 'the public lane'), 'free')
    release()
    assert.deepStrictEqual(await write, ['a', 'x'])
    // The retry reloads the slot first, so it writes under the value's etag
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [412, 204])
    assert.strictEqual(syncs.count, before + 1)
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])
  })

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

  it("a recovering write awaited on another contract's lane completes", async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    syncs.catchUp = true
    const writers = {
      update: () => updateWith('names'),
      queuedSet: () => queuedSet({ key: 'note', data: 1, ifMatch: '*' })
    }
    for (const lane of ['chelonia/private/queueEvent', 'chelonia/queueInvocation']) {
      for (const [name, write] of Object.entries(writers)) {
        writeAsDeviceB('names', [name], server.height + 1)
        const before = syncs.count
        await within(sbp(lane, 'zKvOtherContract', write), `${name} awaited on ${lane}`)
        assert.strictEqual(syncs.count, before + 1)
      }
    }
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [
      412, 204, 409, 204, 412, 204, 409, 204
    ])
  })

  it('gives up on a value from a newer height and reloads the key once the height arrives', async () => {
    const slotKeys = ['reject', 'passive', 'failed', 'aborted']
    for (const key of slotKeys) defineSlot({ key, defaultValue: [] })
    await activate()
    for (const key of slotKeys) writeAsDeviceB(key, [key], AHEAD)
    kvHeightTimings.waitMs = 20
    const before = syncs.count
    await assert.rejects(updateWith('reject', { onHeightAhead: 'reject' }), aheadAt(AHEAD))
    await assert.rejects(updateWith('passive', { maxHeightRecoveries: 0 }), aheadAt(AHEAD))
    assert.strictEqual(syncs.count, before)
    syncs.fail = true
    await assert.rejects(updateWith('failed'), aheadAt(AHEAD))
    syncs.fail = false
    const release = holdSyncs()
    const controller = new AbortController()
    const aborted = updateWith('aborted', { signal: controller.signal })
    await until(() => syncs.count === before + 2, 'the recovery sync')
    controller.abort('stop')
    await assert.rejects(aborted, (e) => e === 'stop')
    for (const key of slotKeys) {
      assert.deepStrictEqual(slotState(key), ['loading', AHEAD, true], key)
    }
    release()
    // A stale stamp (409) reveals no value
    defineSlot({ key: 'stale', defaultValue: [] })
    await drainLanes()
    await assert.rejects(updateWith('stale', { maxHeightRecoveries: 0 }), (e) =>
      isKvHeightAhead(e) && e.cause?.exact === false)
    assert.deepStrictEqual(slotState('stale'), ['non-init', undefined, true])

    setLocalHeight(AHEAD)
    await until(() => slotKeys.every((key) => mirror(key)?.status === 'loaded'), 'the reloads')
    for (const key of slotKeys) {
      assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, key), [key])
      assert.deepStrictEqual(slotState(key), ['loaded', undefined, true], key)
    }
    assert.strictEqual(server.posts().filter(({ status }) => status === 204).length, 0)
  })

  it('clear overwrites values it can\'t verify without waiting; giving up marks the slot', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    kvHeightTimings.waitMs = 60_000
    const before = syncs.count
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
    assert.strictEqual(syncs.count, before)
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
    const posted = server.posts().length
    server.onPost = () => {
      if (server.posts().length === posted + 2) etag = writeAsDeviceB('names', 'oops')
    }
    await assert.rejects(updateWith('names', { maxAttempts: 2 }), (e: Error) =>
      conflict({ currentStatus: 'present', etag })(e))
  })

  it('a committed write drops the key\'s wait it saw, but not one for a value found meanwhile', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    writeAsDeviceB('names', ['a'], AHEAD)
    kvHeightTimings.waitMs = 60_000
    const synced = syncs.count
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
    await until(syncEnded(synced + 1), 'the failed recovery sync')
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
    // And so does `null` for the options themselves
    await within(sbp('chelonia/kv/sync', CONTRACT_ID, 'names', null), 'sync, null options')
    await within(sbp('chelonia/kv/clear', CONTRACT_ID, 'names', null), 'clear, null options')
    assert.strictEqual(await within(sbp('chelonia/kv/whenSettled', CONTRACT_ID, 'names', null),
      'whenSettled, null options'), 'non-init')
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204, 204, 204])
  })

  it("resolves when a listener drops the slot's entry as the write applies", async () => {
    let matching = true
    defineSlot({ key: 'prefs', defaultValue: {}, match: () => matching })
    await activate()
    const drop = ({ key, reason }: { key: string; reason: string }) => {
      if (key !== 'prefs' || reason !== 'local') return
      matching = false
      sbp('chelonia/kv/refreshFilters', CONTRACT_ID)
    }
    sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, drop)
    try {
      assert.deepStrictEqual(await update('prefs', () => ({ v: 1 })), { v: 1 })
    } finally {
      sbp('okTurtles.events/off', CHELONIA_KV_UPDATED, drop)
    }
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [204])
    assert.strictEqual(mirror('prefs'), undefined)
  })

  for (const autoLoad of ['on-sync', 'never'] as const) {
    it(`settles a slot a listener replaces as the write applies (${autoLoad})`, async () => {
      defineSlot({ key: 'prefs', defaultValue: {}, autoLoad })
      await activate()
      // The replacement rejects the value written
      const schema = {
        parse: (value: unknown) => {
          if (value == null || (value as { v?: number }).v === 1) throw new Error('v 1 is rejected')
          return value as JSONType
        }
      }
      let replaced = false
      const replace = ({ key, reason }: { key: string; reason: string }) => {
        if (key !== 'prefs' || reason !== 'local' || replaced) return
        replaced = true
        defineSlot({ key: 'prefs', defaultValue: {}, autoLoad, schema })
      }
      sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, replace)
      try {
        await update('prefs', () => ({ v: 1 }))
      } finally {
        sbp('okTurtles.events/off', CHELONIA_KV_UPDATED, replace)
      }
      await drainLanes()
      assert.ok(replaced)
      assert.deepStrictEqual(slotState('prefs'), ['error', undefined, true])
    })
  }
})

// GETs of `key` answer 500 until the returned function is called
const failGets = (key: string): (() => void) => {
  const { handle } = server
  server.handle = async (url, init) => {
    if (init?.method === 'POST' || !url.endsWith(`/${key}`)) return handle(url, init)
    server.log.push({ method: 'GET', key, status: 500 })
    return new Response(null, { status: 500 })
  }
  return () => { server.handle = handle }
}
const httpError = (e: unknown) => (e as Error)?.name === 'ChelErrorUnexpectedHttpResponseCode'
const listSchema = {
  parse: (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('not a list')
    return value
  }
}
const writes = (key: string) => server.posts().filter((request) => request.key === key)
  .map(({ ifMatch, status }) => [ifMatch, status])
const counted = (updater: (value: JSONType) => JSONType | typeof KV_NOOP) => {
  const calls: JSONType[] = []
  return {
    calls,
    updater: (value: JSONType) => {
      calls.push(value)
      return updater(value)
    }
  }
}
const noopOnEmpty = (value: JSONType) => (value as string[]).length ? appendX(value) : KV_NOOP
// A KV_NOOP on a list without 'b'
const dropB = (value: JSONType) => (value as string[]).includes('b')
  ? (value as string[]).filter((name) => name !== 'b')
  : KV_NOOP
// Loads `value`, then leaves the slot 'error' with it: a newer value fails the schema
const breakSlot = async (key: string, value: JSONType) => {
  writeAsDeviceB(key, value)
  await within(sbp('chelonia/kv/sync', CONTRACT_ID, key), `load of ${key}`)
  writeAsDeviceB(key, 'not a list')
  await assert.rejects(within(sbp('chelonia/kv/sync', CONTRACT_ID, key), `reload of ${key}`),
    { name: 'ChelErrorKvValidation' })
  assert.deepStrictEqual([mirror(key)?.status, mirror(key)?.value], ['error', value])
}
let vetoLoads = false
sbp('sbp/filters/selector/add', 'chelonia/kv/_loadSlotNow', () => !vetoLoads)

describe('update\'s reducer basis', () => {
  installKvHarness()

  it('reloads after a height recovery, but not after a stale stamp alone (409)', async () => {
    defineSlot({ key: 'stale', defaultValue: [] })
    defineSlot({ key: 'merged', defaultValue: [] })
    const loaded = writeAsDeviceB('merged', ['a'])
    await activate()
    syncs.catchUp = true
    const etag = writeAsDeviceB('merged', ['b'])
    server.height = START_HEIGHT + 1
    assert.deepStrictEqual(await updateWith('stale'), ['x'])
    assert.strictEqual(gets('stale'), 1)
    assert.deepStrictEqual(writes('stale').map(([, status]) => status), [409, 204])
    // A 409 after a 412: the value the 412 brought isn't in the mirror. The
    // slot stays 'loaded' while it reloads.
    server.height = START_HEIGHT + 2
    const statuses: string[] = []
    const listener = ({ key, status }: { key: string; status: string }) => {
      if (key === 'merged') statuses.push(status)
    }
    sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
    try {
      assert.deepStrictEqual(await updateWith('merged'), ['b', 'x'])
    } finally {
      sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener)
    }
    assert.strictEqual(gets('merged'), 2)
    assert.deepStrictEqual(writes('merged'), [[loaded, 412], [etag, 409], [etag, 204]])
    assert.deepStrictEqual(statuses, [])
  })

  it('reloads a slot known to lack the server value first, and rejects if that fails', async () => {
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    const etag = writeAsDeviceB('names', ['a'], AHEAD)
    await assert.rejects(updateWith('names', { onHeightAhead: 'reject' }), aheadAt(AHEAD))
    const restore = failGets('names')
    const failing = counted(appendX)
    await assert.rejects(updateWith('names', { updater: failing.updater }), httpError)
    assert.deepStrictEqual(failing.calls, [])
    assert.deepStrictEqual(slotState('names'), ['loading', AHEAD, true])
    restore()
    // The reload finds the value ahead; the recovery's sync fires the key's deferred
    // reload, so the retry doesn't reload again (only a last attempt would wait).
    syncs.catchUp = true
    kvHeightTimings.waitMs = 60_000
    const before = gets('names')
    const retried = counted(appendX)
    assert.deepStrictEqual(await updateWith('names', { updater: retried.updater }), ['a', 'x'])
    assert.deepStrictEqual(retried.calls, [['a']])
    assert.strictEqual(gets('names'), before + 2)
    assert.deepStrictEqual(writes('names').at(-1), [etag, 204])
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])
  })

  it('writes a never-loaded slot under if-match "", reloading only for a KV_NOOP', async () => {
    const slotKeys = ['lazy', 'noop', 'failing']
    for (const key of slotKeys) defineSlot({ key, defaultValue: [], autoLoad: 'never' })
    await activate()
    const etags = slotKeys.map((key) => writeAsDeviceB(key, ['a']))
    assert.deepStrictEqual(await updateWith('lazy'), ['a', 'x'])
    assert.strictEqual(gets('lazy'), 0)
    assert.deepStrictEqual(writes('lazy'), [['""', 412], [etags[0], 204]])

    const noop = counted(noopOnEmpty)
    assert.deepStrictEqual(await updateWith('noop', { updater: noop.updater }), ['a', 'x'])
    assert.deepStrictEqual(noop.calls, [[], ['a']])
    assert.deepStrictEqual(writes('noop'), [[etags[1], 204]])

    // The slot stays unverified while its reload fails: a second KV_NOOP
    // rejects, a write still merges on the 412
    failGets('failing')
    await assert.rejects(updateWith('failing', { updater: noopOnEmpty }), httpError)
    assert.deepStrictEqual(slotState('failing'), ['non-init', undefined, false])
    let first = true
    const noopOnce = (value: JSONType) => first ? ((first = false), KV_NOOP) : appendX(value)
    assert.deepStrictEqual(await updateWith('failing', { updater: noopOnce }), ['a', 'x'])
    assert.deepStrictEqual(writes('failing'), [['""', 412], [etags[2], 204]])
    for (const key of slotKeys) assert.deepStrictEqual(slotState(key), ['loaded', undefined, true])
  })

  it('with the caller\'s ifMatch, reloads an unsettled slot first; any failed reload rejects', async () => {
    defineSlot({ key: 'names', defaultValue: [], autoLoad: 'never' })
    defineSlot({ key: 'other', defaultValue: [], autoLoad: 'never' })
    defineSlot({ key: 'guarded', defaultValue: [], schema: listSchema })
    await activate()
    const etag = writeAsDeviceB('names', ['a'])
    assert.deepStrictEqual(await updateWith('names', { ifMatch: etag }), ['a', 'x'])
    assert.strictEqual(gets('names'), 1)
    assert.deepStrictEqual(writes('names'), [[etag, 204]])

    // A reload that a filter vetoes fails like any other
    vetoLoads = true
    try {
      const vetoed = counted(appendX)
      await assert.rejects(updateWith('other', { ifMatch: '*', updater: vetoed.updater }),
        { name: 'ChelErrorUnexpected', message: /vetoed/ })
      assert.deepStrictEqual(vetoed.calls, [])
    } finally {
      vetoLoads = false
    }
    await breakSlot('guarded', ['a'])
    failGets('guarded')
    failGets('other')
    for (const key of ['other', 'guarded']) {
      const rejected = counted(appendX)
      await assert.rejects(updateWith(key, { ifMatch: '*', updater: rejected.updater }), httpError)
      assert.deepStrictEqual(rejected.calls, [])
    }
    // Without it, the guard falls back to the value it kept
    const noop = counted(() => KV_NOOP)
    assert.strictEqual(await updateWith('guarded', { updater: noop.updater }), undefined)
    assert.deepStrictEqual(noop.calls, [['a']])
    assert.strictEqual(server.posts().length, 1)
  })

  it('the last attempt waits once for a value its reload found ahead, then reloads', async () => {
    defineSlot({ key: 'names', defaultValue: [], schema: listSchema })
    defineSlot({ key: 'other', defaultValue: [], schema: listSchema })
    await activate()
    kvHeightTimings.waitMs = 60_000
    const before = syncs.count
    await breakSlot('names', ['a'])
    const etag = writeAsDeviceB('names', ['b'], AHEAD)
    const waiting = counted(appendX)
    const writing = updateWith('names', { maxHeightRecoveries: 0, updater: waiting.updater })
    await until(() => mirror('names')?.heightAhead, 'the reload finding the value ahead')
    assert.deepStrictEqual(waiting.calls, [])
    setLocalHeight(AHEAD)
    assert.deepStrictEqual(await writing, ['b', 'x'])
    assert.deepStrictEqual(writes('names'), [[etag, 204]])
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])

    // The retained value is known to be outdated: a KV_NOOP on it rejects
    // once the second reload fails
    await breakSlot('other', ['a'])
    writeAsDeviceB('other', ['b'], AHEAD + 1)
    const noop = updateWith('other', { maxHeightRecoveries: 0, updater: () => KV_NOOP })
    await until(() => mirror('other')?.heightAhead, 'the reload finding the value ahead')
    failGets('other')
    setLocalHeight(AHEAD + 1)
    await assert.rejects(noop, httpError)
    assert.deepStrictEqual(writes('other'), [])
    assert.strictEqual(syncs.count, before)
  })

  it('writes entries an earlier session persisted under their etags; some reload first', async () => {
    const slotKeys = ['merged', 'noop', 'ifMatch', 'failing', 'marked', 'cleared']
    const persisted: Record<string, KvMirrorEntry> = {}
    for (const key of slotKeys) {
      persisted[key] = { value: ['a'], etag: writeAsDeviceB(key, ['a']), status: 'loaded', settled: true }
      defineSlot({ key, defaultValue: [], autoLoad: 'never' })
    }
    // That session couldn't verify the server value
    persisted.marked.heightAhead = { requiredHeight: AHEAD }
    persisted.cleared = { value: undefined, etag: writeAsDeviceB('cleared', null), status: 'non-init' }
    rootState()._kv = { [CONTRACT_ID]: structuredClone(persisted) }
    const etags: Record<string, string> = {}
    for (const key of slotKeys.slice(0, -1)) etags[key] = writeAsDeviceB(key, ['a', 'b'], AHEAD)
    setLocalHeight(AHEAD)
    await activate()
    assert.deepStrictEqual(slotKeys.map((key) => mirror(key)?.settled), slotKeys.map(() => false))
    const run = async (key: string, updater: typeof dropB, options = {}) => {
      const counter = counted(updater)
      const result = await updateWith(key, { updater: counter.updater, ...options })
      return [result, counter.calls, gets(key), writes(key)]
    }
    // A server value written since comes back as a 412, and merges
    assert.deepStrictEqual(await run('merged', appendX), [
      ['a', 'b', 'x'], [['a'], ['a', 'b']], 0, [[persisted.merged.etag, 412], [etags.merged, 204]]
    ])
    assert.deepStrictEqual(await run('noop', dropB), [['a'], [['a'], ['a', 'b']], 1, [[etags.noop, 204]]])
    assert.deepStrictEqual(await run('ifMatch', appendX, { ifMatch: '*' }), [
      ['a', 'b', 'x'], [['a', 'b']], 1, [['*', 204]]
    ])
    assert.deepStrictEqual(await run('marked', dropB), [['a'], [['a', 'b']], 1, [[etags.marked, 204]]])
    assert.strictEqual(mirror('marked')?.heightAhead, undefined)
    failGets('failing')
    failGets('cleared')
    const failing = counted(appendX)
    await assert.rejects(updateWith('failing', { updater: failing.updater, ifMatch: '*' }), httpError)
    assert.deepStrictEqual([failing.calls, writes('failing')], [[], []])
    // A KV_NOOP whose reload fails runs again on the mirror, written under its etag
    let first = true
    const noopOnce = (value: JSONType) => first ? ((first = false), KV_NOOP) : appendX(value)
    assert.deepStrictEqual(await updateWith('cleared', { updater: noopOnce }), ['x'])
    assert.deepStrictEqual(writes('cleared'), [[persisted.cleared.etag, 204]])
  })

  it("an 'error' slot holding an old value recovers the newer one before its reducer runs", async () => {
    defineSlot({ key: 'names', defaultValue: [], schema: listSchema })
    await activate()
    await breakSlot('names', ['a'])
    const etag = writeAsDeviceB('names', ['a', 'b'], AHEAD)
    syncs.catchUp = true
    kvHeightTimings.waitMs = 60_000
    const before = syncs.count
    const dropping = counted(dropB)
    assert.deepStrictEqual(await updateWith('names', { updater: dropping.updater }), ['a'])
    assert.deepStrictEqual(dropping.calls, [['a', 'b']])
    assert.deepStrictEqual(writes('names'), [[etag, 204]])
    assert.strictEqual(syncs.count, before + 1)
    assert.deepStrictEqual(slotState('names'), ['loaded', undefined, true])
  })

  it('a failed reload after a height recovery makes a KV_NOOP reject; a write merges', async () => {
    defineSlot({ key: 'noop', defaultValue: [] })
    defineSlot({ key: 'write', defaultValue: [] })
    await activate()
    syncs.catchUp = true
    writeAsDeviceB('noop', ['a'], AHEAD)
    failGets('noop')
    let first = true
    const noopOnRetry = (value: JSONType) => first ? ((first = false), appendX(value)) : KV_NOOP
    await assert.rejects(updateWith('noop', { updater: noopOnRetry }), httpError)
    assert.deepStrictEqual(writes('noop').map(([, status]) => status), [412])
    const etag = writeAsDeviceB('write', ['a'], AHEAD + 1)
    failGets('write')
    assert.deepStrictEqual(await updateWith('write'), ['a', 'x'])
    assert.deepStrictEqual(writes('write'), [['""', 412], ['""', 412], [etag, 204]])
  })
})
