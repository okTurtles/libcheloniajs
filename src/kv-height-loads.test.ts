import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import { CONTRACT_IS_SYNCING } from './events.js'
import {
  notifyContractHeight, onHeight, waitForHeight, waitForHeightAfterSync
} from './kv-height.js'
import { captureConsole, within } from './test-utils.js'
import type { CheloniaContext } from './types.js'

const CID = 'zHeightContract'
const contracts: Record<string, { height: number }> = {}
sbp('sbp/selectors/register', { 'test.kvHeight/state': () => ({ contracts }) })

const PENDING = Symbol('pending')
const settledSoon = (promise: Promise<unknown>) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(PENDING), 20))])

describe('waitForHeight', () => {
  let ctx: CheloniaContext
  // What committing an event does
  const commit = (height: number, contractID = CID) => {
    contracts[contractID] = { height }
    notifyContractHeight(ctx, contractID, height)
  }
  const pubsubWith = (readyState: number | null) =>
    ({ socket: readyState === null ? null : { readyState } }) as CheloniaContext['pubsub']

  beforeEach(() => {
    contracts[CID] = { height: 10 }
    ctx = {
      config: { stateSelector: 'test.kvHeight/state' },
      currentSyncs: {},
      kvHeightListeners: new Map()
    } as unknown as CheloniaContext
  })

  it('resolves at once when the height is already committed', async () => {
    ctx.pubsub = pubsubWith(WebSocket.CLOSED)
    assert.strictEqual(await waitForHeight(ctx, CID, 10, { timeoutMs: 0 }), true)
  })

  it('wakes when the contract commits the height, not before', async () => {
    const wait = waitForHeight(ctx, CID, 12, { timeoutMs: 60_000 })
    commit(11)
    commit(12, 'zOtherContract')
    assert.strictEqual(await settledSoon(wait), PENDING)
    commit(13)
    assert.strictEqual(await within(wait, 'the wait'), true)
  })

  it('resolves false when the height does not arrive in time', async () => {
    assert.strictEqual(await within(waitForHeight(ctx, CID, 11, { timeoutMs: 20 }), 'wait'), false)
    assert.strictEqual(ctx.kvHeightListeners.size, 0)
  })

  it('rejects with the abort reason, whatever it is', async () => {
    const controller = new AbortController()
    const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: controller.signal })
    controller.abort('stop')
    await assert.rejects(within(wait, 'the wait'), (e) => e === 'stop')
    await assert.rejects(waitForHeight(ctx, CID, 10, { signal: controller.signal }), (e) => e === 'stop')
    assert.strictEqual(ctx.kvHeightListeners.size, 0)
  })

  it("doesn't wait while the pubsub socket isn't open", async () => {
    for (const readyState of [null, WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
      ctx.pubsub = pubsubWith(readyState)
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000 })
      assert.strictEqual(await within(wait, `wait (socket ${readyState})`), false)
    }
  })

  it('waits with an open socket, and without a pubsub client', async () => {
    for (const pubsub of [pubsubWith(WebSocket.OPEN), undefined]) {
      ctx.pubsub = pubsub as CheloniaContext['pubsub']
      const height = contracts[CID].height + 1
      const wait = waitForHeight(ctx, CID, height, { timeoutMs: 60_000 })
      assert.strictEqual(await settledSoon(wait), PENDING)
      commit(height)
      assert.strictEqual(await within(wait, 'the wait'), true)
    }
  })

  it("doesn't time out at once when asked to wait 2^31 ms or more", async () => {
    const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 2 ** 31 })
    assert.strictEqual(await settledSoon(wait), PENDING)
    commit(11)
    assert.strictEqual(await within(wait, 'the wait'), true)
  })

  it('still wakes the other waits when a height listener throws', async () => {
    const logs = captureConsole(['error'])
    try {
      onHeight(ctx, CID, 11, () => { throw new Error('listener failed') })
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000 })
      commit(11)
      assert.strictEqual(await within(wait, 'the wait'), true)
      assert.strictEqual(logs.logged.length, 1)
    } finally {
      logs.restore()
    }
  })

  describe('after a running sync', () => {
    const endSync = (contractID = CID) => {
      delete ctx.currentSyncs[contractID]
      sbp('okTurtles.events/emit', CONTRACT_IS_SYNCING, contractID, false)
    }

    beforeEach(() => {
      ctx.currentSyncs[CID] = { firstSync: false }
      ctx.currentSyncs.zOtherContract = { firstSync: false }
      ctx.pubsub = pubsubWith(WebSocket.CLOSED)
    })

    it('waits for the sync to end first, even with the socket closed', async () => {
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000 })
      commit(11)
      endSync('zOtherContract')
      assert.strictEqual(await settledSoon(wait), PENDING)
      endSync()
      assert.strictEqual(await within(wait, 'the wait'), true)
    })

    it("gives up if the sync doesn't end in time, even with the height reached", async () => {
      for (const timeoutMs of [0, 20]) {
        const wait = waitForHeightAfterSync(ctx, CID, 10, { timeoutMs })
        assert.strictEqual(await within(wait, `wait (${timeoutMs} ms)`), false)
      }
    })

    it("doesn't wait for the height once the sync ended while the socket is closed", async () => {
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000 })
      endSync()
      assert.strictEqual(await within(wait, 'the wait'), false)
    })
  })
})
