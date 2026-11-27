import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CONTRACT_IS_SYNCING } from './events.js'
import { sleep } from './kv-height-harness.js'
import {
  notifyContractHeight, onHeight, waitForHeight, waitForHeightAfterSync
} from './kv-height.js'
import { captureConsole, within } from './test-utils.js'
import type { CheloniaContext } from './types.js'

// An abort rejects with its reason if that is an Error (STOP below); with a
// non-Error reason, or none (chelonia/reset aborts without one), with an AbortError
const STOP = new Error('stop')

const CID = 'zHeightContract'
const contracts: Record<string, { height: number }> = {}
sbp('sbp/selectors/register', { 'test.kvHeight/state': () => ({ contracts }) })

const PENDING = Symbol('pending')
const settledSoon = (promise: Promise<unknown>) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(PENDING), 20))])

describe('waitForHeight', () => {
  let ctx: CheloniaContext
  // Ends the waits a test leaves pending, so that none outlives the file
  let waits = new AbortController()
  beforeEach(() => { waits = new AbortController() })
  afterEach(() => waits.abort())
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
    const wait = waitForHeight(ctx, CID, 12, { timeoutMs: 60_000, signal: waits.signal })
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

  it('rejects with the abort reason if it is an Error, or else an AbortError', async () => {
    for (const [reason, expected] of [
      [STOP, (e: unknown) => e === STOP],
      ['stop', (e: unknown) => e instanceof DOMException && e.name === 'AbortError']
    ] as const) {
      const controller = new AbortController()
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: controller.signal })
      controller.abort(reason)
      await assert.rejects(within(wait, 'the wait'), expected)
      await assert.rejects(waitForHeight(ctx, CID, 10, { signal: controller.signal }), expected)
      assert.strictEqual(ctx.kvHeightListeners.size, 0)
    }
  })

  it("doesn't wait while the pubsub socket isn't open", async () => {
    for (const readyState of [null, WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
      ctx.pubsub = pubsubWith(readyState)
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
      assert.strictEqual(await within(wait, `wait (socket ${readyState})`), false)
    }
  })

  it('needs no global WebSocket, as with a manual pubsub client before connect()', async () => {
    const open = WebSocket.OPEN
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')!
    delete (globalThis as { WebSocket?: unknown }).WebSocket
    try {
      ctx.pubsub = pubsubWith(null)
      const noSocket = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
      assert.strictEqual(await within(noSocket, 'the wait without a socket'), false)
      ctx.pubsub = pubsubWith(open)
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
      assert.strictEqual(await settledSoon(wait), PENDING)
      commit(11)
      assert.strictEqual(await within(wait, 'the wait with an open socket'), true)
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', saved)
    }
  })

  it('waits with an open socket, and without a pubsub client', async () => {
    for (const pubsub of [pubsubWith(WebSocket.OPEN), undefined]) {
      ctx.pubsub = pubsub as CheloniaContext['pubsub']
      const height = contracts[CID].height + 1
      const wait = waitForHeight(ctx, CID, height, { timeoutMs: 60_000, signal: waits.signal })
      assert.strictEqual(await settledSoon(wait), PENDING)
      commit(height)
      assert.strictEqual(await within(wait, 'the wait'), true)
    }
  })

  it("doesn't time out at once when asked to wait 2^31 ms or more", async () => {
    const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 2 ** 31, signal: waits.signal })
    assert.strictEqual(await settledSoon(wait), PENDING)
    commit(11)
    assert.strictEqual(await within(wait, 'the wait'), true)
  })

  it('still wakes the other waits when a height listener throws', async () => {
    const errors = captureConsole(['error'])
    try {
      onHeight(ctx, CID, 11, () => { throw new Error('listener failed') })
      const wait = waitForHeight(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
      commit(11)
      assert.strictEqual(await within(wait, 'the wait'), true)
      assert.strictEqual(errors.entries.length, 1)
    } finally {
      errors.restore()
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
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
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
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 60_000, signal: waits.signal })
      endSync()
      assert.strictEqual(await within(wait, 'the wait'), false)
    })

    it('shares one budget between the sync wait and the height wait', async () => {
      ctx.pubsub = pubsubWith(WebSocket.OPEN)
      const wait = waitForHeightAfterSync(ctx, CID, 11, { timeoutMs: 400, signal: waits.signal })
      // Ends at 400 ms; separate budgets would end it at 300 + 400 ms
      const result = within(wait, 'the end of the shared budget', 600)
      await sleep(300)
      endSync()
      assert.strictEqual(await result, false)
    })
  })
})
