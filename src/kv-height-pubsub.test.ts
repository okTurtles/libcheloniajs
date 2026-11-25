import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import { isKvHeightMalformed, kvHeightAheadCause } from './errors.js'
import { CHELONIA_KV_STATUS_CHANGED } from './events.js'
import {
  activate, CONTRACT_ID, connectPubsub, defineSlot, deliverFrame, drainLanes, frameOf, gets,
  holdResetAfterAbort, holdSyncs, installKvHarness, logs, mirror, read, restamped, server,
  setLocalHeight, settledStatus, START_HEIGHT, subscriptionSucceeded, syncs, vetoQueue,
  whenSettled, writeAsDeviceB
} from './kv-height-harness.js'
import { kvHeightTimings } from './kv-height.js'
import { until, within } from './test-utils.js'
import type { JSONType, KvLoadStatus } from './types.js'

const AHEAD = START_HEIGHT + 2
const logged = (method: string, text: string) => logs.entries.filter((entry) =>
  entry.level === method && String(entry.args[0]).includes(text))
const frameErrors = () => logged('error', 'Error processing kv event')
const statusesDuring = async (body: () => Promise<void>) => {
  const statuses: KvLoadStatus[] = []
  const listener = ({ status }: { status: KvLoadStatus }) => { statuses.push(status) }
  sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, listener)
  try {
    await body()
  } finally {
    sbp('okTurtles.events/off', CHELONIA_KV_STATUS_CHANGED, listener)
  }
  return statuses
}

describe("Pubsub KV frames the contract can't verify, yet or at all", () => {
  installKvHarness()

  it('keep a loaded value, and reload the key once the height arrives', async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    const updates: unknown[] = []
    defineSlot({
      key: 'prefs', defaultValue: {}, onUpdate: (value, { reason }) => { updates.push([value, reason]) }
    })
    connectPubsub()
    await activate()
    const etag = writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    const before = gets('prefs')
    deliverFrame('prefs')
    await drainLanes()
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
    assert.strictEqual(settledStatus('prefs'), 'loaded')
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD })
    assert.strictEqual(gets('prefs'), before)

    setLocalHeight(AHEAD)
    await until(() => mirror('prefs')?.heightAhead === undefined, 'the reload')
    await drainLanes()
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(mirror('prefs')?.etag, etag)
    assert.strictEqual(gets('prefs'), before + 1)
    assert.deepStrictEqual(updates, [[{ theme: 'light' }, 'load'], [{ theme: 'dark' }, 'remote']])
  })

  it('make a settled empty slot loading until the value loads', async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    assert.strictEqual(settledStatus('prefs'), 'non-init')
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    deliverFrame('prefs')
    await drainLanes()
    assert.strictEqual(mirror('prefs')?.status, 'loading')
    assert.strictEqual(settledStatus('prefs'), undefined)

    const settling = whenSettled('prefs')
    setLocalHeight(AHEAD)
    assert.strictEqual(await settling, 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  // Device B cleared the key, then wrote a value from a newer height
  it("don't let a clear frame settle the slot empty while it waits for a newer value", async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', null)
    const clear = frameOf('prefs')
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    deliverFrame('prefs')
    deliverFrame('prefs', clear)
    await drainLanes()
    assert.strictEqual(mirror('prefs')?.status, 'loading')
    assert.strictEqual(settledStatus('prefs'), undefined)

    setLocalHeight(AHEAD)
    assert.strictEqual(await whenSettled('prefs'), 'loaded')
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
  })

  it('wait again for a newer value after a clear frame, once the fallback gave up', async () => {
    kvHeightTimings.pendingFallbackMs = 20
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', null)
    const clear = frameOf('prefs')
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    deliverFrame('prefs')
    await drainLanes()
    assert.strictEqual(await whenSettled('prefs'), 'error')

    const before = syncs.count
    deliverFrame('prefs', clear)
    await until(() => syncs.count > before, 'another fallback sync')
    assert.strictEqual(await whenSettled('prefs'), 'error')
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightAhead')
  })

  for (const stored of ['malformed', 'valid']) {
    it(`with a malformed stamp are logged and reload the slot (${stored} stored value)`, async () => {
      writeAsDeviceB('prefs', { theme: 'light' })
      defineSlot({ key: 'prefs', defaultValue: {} })
      const rawFrames = connectPubsub({ rawHandler: true })
      await activate()
      writeAsDeviceB('prefs', { theme: 'dark' })
      const frame = restamped('prefs', '040')
      if (stored === 'malformed') server.put('prefs', frame.body)
      const statuses = await statusesDuring(async () => {
        deliverFrame('prefs', frame)
        await drainLanes()
      })
      assert.deepStrictEqual(statuses, ['loading', stored === 'malformed' ? 'error' : 'loaded'])
      assert.strictEqual(mirror('prefs')?.settled, true)
      if (stored === 'malformed') {
        assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorKvHeightMalformed')
      } else {
        assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
      }
      assert.strictEqual(rawFrames.length, 0)
      assert.strictEqual(frameErrors().length, 1)
      assert.ok(isKvHeightMalformed(frameErrors()[0].args[2]))
    })
  }

  it('that are not JSON are logged and reload the slot', async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' })
    const before = gets('prefs')
    deliverFrame('prefs', { body: 'not JSON', cid: '"frame"' })
    await drainLanes()
    assert.strictEqual(gets('prefs'), before + 1)
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(frameErrors().length, 1)
  })

  it('are not passed to the raw KV handler, and a warning says so', async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    const rawFrames = connectPubsub({ rawHandler: true })
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    writeAsDeviceB('other', 1, AHEAD)
    deliverFrame('prefs')
    deliverFrame('other')
    await drainLanes()
    assert.strictEqual(logged('warn', 'not passed to the raw KV handler').length, 2)

    // Only the slot reloads its key
    const before = gets('other')
    setLocalHeight(AHEAD)
    await until(() => settledStatus('prefs') === 'loaded' && !mirror('prefs')?.heightAhead,
      'the reload')
    await drainLanes()
    assert.deepStrictEqual(read('prefs'), { theme: 'dark' })
    assert.strictEqual(gets('other'), before)
    assert.strictEqual(rawFrames.length, 0)
    // A frame it can verify is passed on
    deliverFrame('other')
    await drainLanes()
    assert.strictEqual(rawFrames.length, 1)
    const [key, parsed] = rawFrames[0] as [string, { data: JSONType }]
    assert.deepStrictEqual([key, parsed.data], ['other', 1])
  })
})

describe('A pubsub KV frame after a clear that recovered', () => {
  installKvHarness()

  it("applies without a GET: the clear's first conflict isn't kept", async () => {
    kvHeightTimings.pendingFallbackMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    deliverFrame('prefs')
    await drainLanes()
    syncs.catchUp = true
    await within(sbp('chelonia/kv/clear', CONTRACT_ID, 'prefs') as Promise<void>, 'the clear')
    await drainLanes()
    // A conflict, a stale stamp, then a commit after the recovery sync
    assert.deepStrictEqual(server.posts().map(({ status, height }) => [status, height]), [
      [412, String(START_HEIGHT)], [409, String(START_HEIGHT)], [204, String(AHEAD)]
    ])
    writeAsDeviceB('prefs', { theme: 'light' })
    const before = gets('prefs')
    deliverFrame('prefs')
    await drainLanes()
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
    assert.strictEqual(gets('prefs'), before)
  })
})

describe('Vetoed pubsub KV frame work', () => {
  installKvHarness()

  it("is logged, and doesn't throw out of the message handler", async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' })
    const lift = vetoQueue(CONTRACT_ID)
    deliverFrame('prefs')
    lift()
    await until(() => frameErrors().length === 1, 'the logged veto')
    await drainLanes()
    assert.deepStrictEqual(read('prefs'), { theme: 'light' })
  })

  it("settles the slot when the reload after a malformed frame can't start", async () => {
    writeAsDeviceB('prefs', { theme: 'light' })
    defineSlot({ key: 'prefs', defaultValue: {}, autoLoad: 'never' })
    connectPubsub()
    await activate()
    assert.strictEqual(mirror('prefs')?.settled, false)
    deliverFrame('prefs', restamped('prefs', 'not-a-height'))
    // The frame got past this lane; its reload won't
    const lift = vetoQueue(CONTRACT_ID)
    await until(() => settledStatus('prefs') === 'error', 'the vetoed reload to settle')
    lift()
    assert.strictEqual(mirror('prefs')?.lastError?.name, 'ChelErrorUnexpected')
    assert.strictEqual(logged('error', 'malformed frame').length, 1)
    assert.strictEqual(gets('prefs'), 0)
  })
})

describe('Single-key kv/sync with the pubsub socket down', () => {
  installKvHarness()

  it('syncs without waiting; a slot waiting for a newer frame stays unsettled', async () => {
    kvHeightTimings.waitMs = 60_000
    defineSlot({ key: 'prefs', defaultValue: {} })
    connectPubsub()
    await activate()
    writeAsDeviceB('prefs', { theme: 'dark' }, AHEAD)
    syncs.fail = true
    const releaseSyncs = holdSyncs()
    const before = syncs.count
    const explicit = assert.rejects(
      within(sbp('chelonia/kv/sync', CONTRACT_ID, 'prefs'), 'kv/sync'),
      (e) => kvHeightAheadCause(e)?.requiredHeight === AHEAD
    )
    await until(() => syncs.count === before + 1, 'the recovery sync')
    writeAsDeviceB('prefs', { theme: 'light' }, AHEAD + 1)
    // What its frame does, but at once: the frame handler's work would wait behind
    // the held sync on the contract's lane, and then race the give-up
    sbp('chelonia/kv/_onUnverifiableFrame', CONTRACT_ID, 'prefs', AHEAD + 1)
    releaseSyncs()
    await explicit
    // Its failed recovery sync ended the recovery
    assert.strictEqual(syncs.count, before + 1)
    assert.strictEqual(mirror('prefs')?.status, 'loading')
    assert.strictEqual(settledStatus('prefs'), undefined)
    assert.deepStrictEqual(mirror('prefs')?.heightAhead, { requiredHeight: AHEAD + 1 })
  })
})

describe('chelonia/reset with the pubsub client connected', () => {
  installKvHarness()

  it('ends although a confirmed subscription starts a sync while it waits after its abort', async () => {
    connectPubsub()
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const ends = await holdResetAfterAbort()
    const before = syncs.count
    const openSyncs = holdSyncs()
    // Queues a contract sync that captures no signal
    subscriptionSucceeded()
    await ends(openSyncs)
    assert.strictEqual(syncs.count, before)
  })
})
