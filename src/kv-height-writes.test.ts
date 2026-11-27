import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, CONTRACT_ID, defineSlot, drainLanes, filterCalls, gateLane, holdGets, holdSyncs,
  installKvHarness, keys, mirror, server, serverValue, setLocalHeight, sleep, START_HEIGHT, syncs,
  update, type UpdateOptions, writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { until, within } from './test-utils.js'
import type { ChelKvGetResult, ChelKvOnConflictCallback, JSONType } from './types.js'

// An abort rejects with its reason if that is an Error (STOP, GONE below); with a
// non-Error reason, or none (chelonia/reset aborts without one), with an AbortError
const STOP = new Error('stop')

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

describe('chelonia/kv/withHeightRecovery', () => {
  installKvHarness()

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

  // Not specific to KV, but this harness can hold the lanes
  it('skips a contract sync that a reset aborted while it was queued', () =>
    queueBeforeResetAbort(
      () => sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the contract sync'
    ))
})

const queuedSet = (args: Record<string, unknown>) =>
  sbp('chelonia/kv/queuedSet', { contractID: CONTRACT_ID, ...args }) as Promise<{
    etag: string | null
  }>

const AHEAD = START_HEIGHT + 2
const appendX = (value: JSONType) => [...(value as string[]), 'x']
const updateWith = (key: string, options: UpdateOptions = {}) =>
  update(key, appendX, options)

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
})
