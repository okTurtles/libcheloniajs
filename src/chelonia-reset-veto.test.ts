// An SBP filter can veto a contract's queue (`chelonia/private/queueEvent`),
// and waiting on that queue then rejects. `chelonia/reset` runs on logout, so
// it must still clear the state and the secret keys: it logs the failure and
// goes on, after waiting for the other contracts' queues.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { CHELONIA_RESET } from './events.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, connectChelonia, createFakePubsubServer, createFakeRelay, retainedContract,
  sleep, waitFor
} from './pubsub/test-harness.js'
import type { TestContract } from './pubsub/test-harness.js'
import { Secret } from './Secret.js'
import type { ChelRootState } from './types.js'

let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedQueue
)
let clearedTransientKeys = 0
sbp('sbp/filters/selector/add', 'chelonia/clearTransientSecretKeys', () => {
  clearedTransientKeys++
})
let resets = 0
sbp('okTurtles.events/on', CHELONIA_RESET, () => { resets++ })

const SLOT = 'veto'
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
    resetDrainTimeout: 0
  })
})

after(() => {
  pubsub?.destroy()
  sbp('chelonia/private/stopClockSync')
  logs.restore()
  server.uninstall()
})

afterEach(() => { vetoedQueue = undefined })

// The lanes of a contract, and how to hold up work on each
const lanes: {
  name: string
  queue: (contractID: string) => string
  hold: (contractID: string, gate: Promise<void>) => Promise<unknown>
}[] = [
  {
    name: 'publish',
    queue: (contractID) => `publish:${contractID}`,
    hold: (contractID, gate) =>
      sbp('chelonia/private/queueEvent', `publish:${contractID}`, () => gate)
  },
  {
    name: 'public',
    queue: (contractID) => `public:${contractID}`,
    hold: (contractID, gate) => sbp('chelonia/queueInvocation', contractID, () => gate)
  },
  {
    name: 'internal',
    queue: (contractID) => contractID,
    hold: (contractID, gate) =>
      sbp('chelonia/private/queueEvent', contractID, () => gate)
  }
]

// Resets with `vetoed`'s lane vetoed while `busy`'s same lane holds work, and
// checks that the reset waited for that work and then cleared everything
const resetWithVeto = async (
  lane: typeof lanes[number], vetoed: TestContract, busy: TestContract
) => {
  // A persistent key, in `rootState.secretKeys` (the harness stores the
  // contracts' keys as transient ones)
  sbp('chelonia/storeSecretKeys', new Secret([{ key: vetoed.SAK }]))
  const rootState = sbp('chelonia/private/state') as ChelRootState
  assert.ok(rootState.secretKeys[vetoed.SAKid], 'no persistent secret key to clear')
  assert.ok(sbp('chelonia/haveSecretKey', vetoed.CSKid), 'no transient secret key to clear')
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  let busyDone = false
  const held = lane.hold(busy.contractID, gate).then(() => { busyDone = true })
  const resetsBefore = resets
  const clearedBefore = clearedTransientKeys
  const logged = logs.fromNow()
  vetoedQueue = lane.queue(vetoed.contractID)
  let outcome: string | undefined
  let busyDoneAtReset: boolean | undefined
  const reset = sbp('chelonia/reset').then(
    () => { outcome = 'resolved' },
    (e: unknown) => { outcome = `rejected: ${(e as Error)?.message}` }
  ).finally(() => { busyDoneAtReset = busyDone })
  try {
    await sleep(50)
    assert.equal(outcome, undefined, 'the reset did not wait for the other contract')
  } finally {
    open()
  }
  assert.ok(await waitFor(() => outcome !== undefined), 'the reset is still waiting')
  await reset
  await held
  assert.equal(outcome, 'resolved')
  assert.equal(busyDoneAtReset, true, 'the reset ended before the other contract\'s work')
  const state = sbp('chelonia/private/state') as ChelRootState
  assert.deepEqual(Object.keys(state.contracts), [], 'contracts left after the reset')
  assert.deepEqual(Object.keys(state.secretKeys), [], 'persistent secret keys left')
  assert.equal(sbp('chelonia/haveSecretKey', vetoed.CSKid), false, 'transient key left')
  assert.equal(clearedTransientKeys - clearedBefore, 1, 'transient keys not cleared')
  assert.equal(resets - resetsBefore, 1, 'CHELONIA_RESET not emitted once')
  return logged
}

describe('chelonia/reset with a vetoed queue', () => {
  for (const lane of lanes) {
    it(`clears everything when the ${lane.name} lane is vetoed`, async () => {
      const vetoed = await retainedContract(relay, pubsub)
      const busy = await retainedContract(relay, pubsub)
      const logged = await resetWithVeto(lane, vetoed, busy)
      const lines = logged.grep(/^\[chelonia\/reset\] Draining /)
      assert.ok(lines.length > 0, 'the vetoed drain was not logged')
      const queue = lane.queue(vetoed.contractID)
      for (const { text } of lines) {
        assert.ok(text.includes(`for ${vetoed.contractID} failed; resetting anyway`), text)
        assert.ok(text.includes(`queueing on ${queue} was vetoed`), text)
      }
    })
  }

  // `chelonia/kv/_waitInFlight` waits on the lanes of the contracts with a
  // KV slot
  describe('with a KV slot', () => {
    before(() => {
      sbp('chelonia/kv/defineSlot', {
        contractType: 'test/contract',
        key: SLOT,
        defaultValue: {},
        encryptionKeyName: null,
        signingKeyName: '#csk',
        autoLoad: 'never'
      })
    })

    it('clears everything when a contract with a KV slot has its lane vetoed', async () => {
      const vetoed = await retainedContract(relay, pubsub)
      const busy = await retainedContract(relay, pubsub)
      const logged = await resetWithVeto(lanes[2], vetoed, busy)
      const lines = logged.grep(/^\[chelonia\/reset\] Draining chelonia\/kv\/_waitInFlight failed/)
      assert.equal(lines.length, 1, 'the vetoed KV drain was not logged once')
      assert.ok(lines[0].text.includes(`Waiting failed for ${vetoed.contractID}`), lines[0].text)
    })

    // The reset waits on the contracts again right after, so this checks
    // `_waitInFlight` alone: it is the only wait for a released contract
    // whose KV write is still queued
    it('_waitInFlight waits for the other KV lanes before it rejects', async () => {
      const vetoed = await retainedContract(relay, pubsub)
      const busy = await retainedContract(relay, pubsub)
      let open!: () => void
      const gate = new Promise<void>((resolve) => { open = resolve })
      let busyDone = false
      const held = sbp('chelonia/private/queueEvent', busy.contractID, () => gate)
        .then(() => { busyDone = true })
      vetoedQueue = vetoed.contractID
      const settled: { error?: unknown } = {}
      let busyDoneAtSettle: boolean | undefined
      const waiting = sbp('chelonia/kv/_waitInFlight').then(
        () => { settled.error = null },
        (e: unknown) => { settled.error = e }
      ).finally(() => { busyDoneAtSettle = busyDone })
      try {
        await sleep(50)
        assert.equal(settled.error, undefined, 'did not wait for the other KV lane')
      } finally {
        open()
      }
      assert.ok(await waitFor(() => settled.error !== undefined), '_waitInFlight is still waiting')
      await waiting
      await held
      // (`assert.equal` above narrowed `settled.error` to `undefined`)
      const { error } = settled as { error?: unknown }
      assert.equal(busyDoneAtSettle, true, 'settled before the other KV lane\'s work')
      assert.ok(error instanceof AggregateError, `not an AggregateError: ${String(error)}`)
      assert.equal(error.message, `[chelonia/kv/_waitInFlight] Waiting failed for ${vetoed.contractID}`)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, new RegExp(`queueing on ${vetoed.contractID} was vetoed`))
      vetoedQueue = undefined
      await sbp('chelonia/reset')
    })
  })
})
