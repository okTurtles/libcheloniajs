// `chelonia/reset` waits for the contracts' queues before it aborts the
// requests still in flight. A request in those queues that never settles
// (e.g. on a dead link) would hold up the reset for good, so the reset aborts
// it after `resetDrainTimeout` ms. Every Chelonia request uses the same abort
// signal, so this covers KV writes, syncs and publishes alike.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  actionMessage, captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay,
  retainedContract, sleep, waitFor
} from './pubsub/test-harness.js'
import type { RelayRequest, TestContract } from './pubsub/test-harness.js'
import type { ChelRootState } from './types.js'

const SLOT = 'hung'
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let pubsub: PubSubClient

before(async () => {
  server.install()
  logs = captureConsole()
  sbp('chelonia/_init')
  pubsub = await connectChelonia(relay, {
    skipActionProcessing: true,
    pubsubReconcileInterval: 0,
    resetDrainTimeout: 200
  })
  sbp('chelonia/kv/defineSlot', {
    contractType: 'test/contract',
    key: SLOT,
    defaultValue: {},
    encryptionKeyName: null,
    signingKeyName: '#csk',
    autoLoad: 'never'
  })
})

after(() => {
  pubsub?.destroy()
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

const cases: {
  name: string
  hangs: (request: RelayRequest, contractID: string) => boolean
  start: (contract: TestContract) => Promise<unknown>
}[] = [
  {
    name: 'a queued KV write (kv/update)',
    hangs: ({ method, path }) => method === 'POST' && path.startsWith('/kv/'),
    start: ({ contractID }) =>
      sbp('chelonia/kv/update', { contractID, key: SLOT, updater: () => ({ n: 1 }) })
  },
  {
    name: 'a sync',
    hangs: ({ path }, contractID) => path === `/latestHEADinfo/${contractID}`,
    start: ({ contractID }) => sbp('chelonia/contract/sync', contractID, { force: true })
  },
  {
    name: 'a publish',
    hangs: ({ method, path }) => method === 'POST' && path === '/event',
    start: (contract) => sbp(
      'chelonia/private/out/publishEvent', actionMessage(contract, { text: 'hung' }), {}, {}
    )
  }
]

describe('chelonia/reset with a request that never settles', () => {
  for (const { name, hangs, start } of cases) {
    it(`aborts ${name} after resetDrainTimeout`, async () => {
      const contract = await retainedContract(relay, pubsub)
      // Only an abort ends the request (or the cleanup below, without the fix)
      let answer!: (response: Response) => void
      const hung = new Promise<Response>((resolve) => { answer = resolve })
      let sent = false
      relay.onRequest = (request) => {
        if (!hangs(request, contract.contractID)) return
        sent = true
        return hung
      }
      const work = start(contract).then(() => 'no error', (e: unknown) => (e as Error)?.name)
      assert.ok(await waitFor(() => sent), 'the request was not sent')
      let resetDone = false
      const started = performance.now()
      let took = 0
      const reset = sbp('chelonia/reset').then(() => {
        resetDone = true
        took = performance.now() - started
      })
      try {
        assert.ok(await waitFor(() => resetDone, { timeout: 3000 }), 'the reset is still waiting')
        // (Node.js may fire a timer up to 1 ms early)
        assert.ok(took >= 199, `the reset aborted after ${took} ms, before resetDrainTimeout`)
        assert.equal(await work, 'AbortError', 'the work did not reject with an AbortError')
        const state = sbp('chelonia/private/state') as ChelRootState
        assert.deepEqual(Object.keys(state.contracts), [], 'contracts left after the reset')
        // Nothing retries the aborted work after the reset (which restarts
        // the clock sync, hence `/time`)
        const from = relay.requests.length
        await sleep(300)
        const later = relay.requests.slice(from).map(({ path }) => path)
        assert.deepEqual(later.filter((path) => path !== '/time'), [], 'requests after the reset')
      } finally {
        answer(new Response('', { status: 500 }))
        relay.onRequest = undefined
        await reset
      }
    })
  }

  // Like the other timeouts of the config (`timerDelay`)
  it('waits as long as it takes for 0, null, a negative, Infinity or a non-number', async () => {
    try {
      for (const value of [0, null, -1, Infinity, '200']) {
        await sbp('chelonia/configure', { resetDrainTimeout: value })
        const { contractID } = await retainedContract(relay, pubsub)
        let answer!: (response: Response) => void
        const hung = new Promise<Response>((resolve) => { answer = resolve })
        relay.onRequest = ({ path }) => path === `/latestHEADinfo/${contractID}` ? hung : undefined
        const sync = sbp('chelonia/contract/sync', contractID, { force: true }).catch(() => {})
        let resetDone = false
        const reset = sbp('chelonia/reset').then(() => { resetDone = true })
        await sleep(400)
        const waited = !resetDone
        answer(new Response('', { status: 500 }))
        relay.onRequest = undefined
        await Promise.all([sync, reset])
        assert.ok(waited, `resetDrainTimeout: ${String(value)} did not wait`)
      }
    } finally {
      await sbp('chelonia/configure', { resetDrainTimeout: 200 })
    }
  })
})
