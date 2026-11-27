import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, CONTRACT_ID, defineSlot, filterCalls, gateLane, holdResetAfterAbort, holdSyncs,
  installKvHarness, rootState, setupContract, sleep, syncs
} from './kv-height-harness.js'
import { until, within } from './test-utils.js'

const OTHER_ID = 'zKvOtherContract'

// Holds the first drain of the next reset (of another contract's publishes)
// until the returned function is called
const holdFirstDrain = (): (() => void) => {
  rootState().contracts[OTHER_ID] = { HEAD: 'other', height: 0, previousKeyOp: '', type: 'other' }
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  sbp('chelonia/private/queueEvent', `publish:${OTHER_ID}`, () => gate)
  return open
}

// A request of the session in place: 'answered', or the name of its error
const request = (): Promise<unknown> => within(
  (sbp('chelonia/private/out/latestHEADinfo', CONTRACT_ID) as Promise<unknown>)
    .then(() => 'answered', (e) => e?.name),
  'the request'
)

// Until the returned function runs, a reset's teardown deletes `contracts` and throws
const breakTeardown = async (): Promise<() => Promise<unknown>> => {
  const reactiveDel = (obj: Record<string, unknown>, key: string) => { delete obj[key] }
  await sbp('chelonia/configure', {
    reactiveDel: (obj: Record<string, unknown>, key: string) => {
      reactiveDel(obj, key)
      throw new Error('teardown failed')
    }
  })
  return () => sbp('chelonia/configure', { reactiveDel })
}

describe('chelonia/reset', () => {
  installKvHarness()

  it('ends although a contract sync is requested while it waits after its abort', async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const ends = await holdResetAfterAbort()
    const before = syncs.count
    const openSyncs = holdSyncs()
    const synced = (sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }) as Promise<unknown>)
      .then(() => 'synced', (e) => e?.name)
    await ends(openSyncs)
    assert.strictEqual(await within(synced, 'the sync'), 'AbortError')
    assert.strictEqual(syncs.count, before)
  })

  // Its timer fires once the first reset has put a new controller in place, or before
  for (const firesFirst of [false, true]) {
    const also = firesFirst ? ', also if its timer fires before that reset ends' : ''
    it(`ends at its drain timeout although it starts while another reset waits after its abort${also}`, async () => {
      await sbp('chelonia/configure', { resetDrainTimeout: 200 })
      defineSlot({ key: 'prefs', defaultValue: {} })
      await activate()
      const ends = await holdResetAfterAbort()
      // The second reset starts meanwhile and waits in its first drain
      const openDrain = holdFirstDrain()
      const second = sbp('chelonia/reset') as Promise<unknown>
      second.catch(() => {})
      let openSyncs: (() => void) | undefined
      try {
        if (firesFirst) await sleep(300)
        await ends(() => {})
        // A sync of the next session hangs on a dead link, ahead of the second
        // reset's next drain
        setupContract()
        openSyncs = holdSyncs()
        const before = syncs.count
        const synced = (sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }) as Promise<unknown>)
          .then(() => 'synced', (e) => e?.name)
        await until(() => syncs.count > before, 'the sync\'s request')
        openDrain()
        await within(second, 'the second reset to end at its drain timeout', 1000)
        assert.strictEqual(await within(synced, 'the sync'), 'AbortError')
      } finally {
        openDrain()
        openSyncs?.()
      }
      setupContract()
      assert.strictEqual(await request(), 'answered', 'the next session starts with an aborted signal')
    })
  }

  it('ends although the next session syncs while it waits after its abort, once another reset ended', async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    const ends = await holdResetAfterAbort()
    let calls = 0
    let openSecond: (() => void) | undefined
    filterCalls('chelonia/kv/_waitInFlight', () => { if (++calls === 1) openSecond = gateLane() })
    // Gone from the state with its slots still active, as after a release: only
    // the waits after the abort, not the drains before it, wait for its lanes
    delete rootState().contracts[CONTRACT_ID]
    const second = sbp('chelonia/reset') as Promise<unknown>
    second.catch(() => {})
    let openSyncs: (() => void) | undefined
    try {
      await until(() => openSecond, 'the second reset to abort')
      await ends(() => {})
      // The next session's sync sits on the lane the second reset drains last
      setupContract()
      openSyncs = holdSyncs()
      const before = syncs.count
      const synced = (sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }) as Promise<unknown>)
        .then(() => 'synced', (e) => e?.name)
      openSecond!()
      await within(second, 'the second reset to end while the next session\'s sync is held', 1000)
      assert.strictEqual(await within(synced, 'the sync'), 'AbortError')
      assert.strictEqual(syncs.count, before, 'the sync sent its request')
    } finally {
      openSecond?.()
      openSyncs?.()
    }
    setupContract()
    assert.strictEqual(await request(), 'answered', 'the next session starts with an aborted signal')
  })

  it('leaves the next session live when it fails after its drain timeout aborted another reset\'s new controller', async () => {
    await sbp('chelonia/configure', { resetDrainTimeout: 200 })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    let openFirst: (() => void) | undefined
    filterCalls('chelonia/kv/_waitInFlight', () => { openFirst ??= gateLane() })
    let restore: (() => Promise<unknown>) | undefined
    // Its teardown fails once the second reset's timer has fired
    const first = within(sbp('chelonia/reset', async () => {
      await sleep(300)
      restore = await breakTeardown()
    }), 'the first reset')
    await until(() => openFirst, 'the first reset to abort')
    const openDrain = holdFirstDrain()
    const second = within(sbp('chelonia/reset') as Promise<unknown>, 'the second reset')
    second.catch(() => {})
    try {
      openFirst!()
      await assert.rejects(first, /teardown failed/)
    } finally {
      await restore?.()
      openDrain()
    }
    // Its next drain, before its abort, finds no `contracts`
    await assert.rejects(second, TypeError)

    rootState().contracts = Object.create(null)
    setupContract()
    assert.strictEqual(await request(), 'answered', 'the next session starts with an aborted signal')
  })

  it('leaves the next session live when it fails after aborting the controller another reset put in place', async () => {
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    let calls = 0
    let openFirst: (() => void) | undefined
    let openSecond: (() => void) | undefined
    filterCalls('chelonia/kv/_waitInFlight', () => {
      if (++calls === 1) openFirst = gateLane()
      else if (calls === 2) openSecond = gateLane()
    })
    let restore: (() => Promise<unknown>) | undefined
    let cleaning = false
    // Its teardown fails while the second reset waits after its abort
    const first = within(sbp('chelonia/reset', async () => {
      cleaning = true
      await until(() => openSecond, 'the second reset to abort')
      restore = await breakTeardown()
    }), 'the first reset')
    await until(() => openFirst, 'the first reset to abort')
    const openDrain = holdFirstDrain()
    const second = within(sbp('chelonia/reset') as Promise<unknown>, 'the second reset')
    second.catch(() => {})
    try {
      openFirst!()
      // The second reset aborts only once the first one has put a new controller in place
      await until(() => cleaning, 'the first reset\'s postCleanupFn')
      openDrain()
      await assert.rejects(first, /teardown failed/)
    } finally {
      await restore?.()
      openDrain()
    }
    openSecond!()
    // Its last drain finds no `contracts`
    await assert.rejects(second, TypeError)

    rootState().contracts = Object.create(null)
    setupContract()
    assert.strictEqual(await request(), 'answered', 'the next session starts with an aborted signal')
  })
})
