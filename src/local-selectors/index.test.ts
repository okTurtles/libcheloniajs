// Tests for `chelonia/externalStateSetup` teardown contract.
//
// Spec (KV-REVAMPED §11.4): setup returns a teardown function; the
// teardown MUST remove every registered listener so listener counts
// are stable across login/logout cycles.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import '@sbp/okturtles.events'
import '@sbp/okturtles.eventqueue'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CONTRACTS_MODIFIED,
  EVENT_HANDLED
} from '../events.js'
import localSelectors from './index.js'
// Reference the export so the module is not tree-shaken away by the
// ts-node ESM loader (the side-effectful `sbp/selectors/register` call
// runs at import time).
if (!localSelectors) throw new Error('local-selectors import failed')

const EXTERNAL_STATE_SELECTOR = 'test/external/state'

let externalState: Record<string, unknown>
let fullStateCalls: number

// Register stub selectors once. Mutable behaviour swaps via the
// closures above.
sbp('sbp/selectors/register', {
  [EXTERNAL_STATE_SELECTOR]: () => externalState,
  'chelonia/contract/fullState': (contractID: string | string[]) => {
    fullStateCalls++
    if (Array.isArray(contractID)) {
      const out: Record<string, unknown> = {}
      for (const cID of contractID) {
        out[cID] = { contractState: { id: cID }, cheloniaState: { id: cID }, kvState: {} }
      }
      return out
    }
    return { contractState: { id: contractID }, cheloniaState: { id: contractID }, kvState: {} }
  }
})

const waitMicrotasks = async () => {
  // The setup queues work onto okTurtles.eventQueue/queueEvent; await
  // a couple of macrotask boundaries so that async handlers settle.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

describe('chelonia/externalStateSetup teardown', () => {
  beforeEach(() => {
    externalState = Object.create(null)
    fullStateCalls = 0
  })

  afterEach(() => {
    // No global tear-down needed; each `it` manages its own setup/teardown.
  })

  it('teardown removes all listeners; events are no-ops afterwards', async () => {
    const teardown = sbp('chelonia/externalStateSetup', {
      stateSelector: EXTERNAL_STATE_SELECTOR
    })
    assert.strictEqual(typeof teardown, 'function', 'setup must return a teardown function')

    // Tear down immediately, then fire each event Chelonia would emit
    // and assert that no handler ran (no `fullState` calls, no
    // mutation of `externalState`).
    teardown()
    fullStateCalls = 0

    sbp('okTurtles.events/emit', EVENT_HANDLED, 'cid-A', { x: 1 })
    sbp('okTurtles.events/emit', CONTRACTS_MODIFIED, new Set(), {
      added: ['cid-B'], removed: [], permanent: false
    })
    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, { contractID: 'cid-C' })
    sbp('okTurtles.events/emit', CHELONIA_KV_STATUS_CHANGED, { contractID: 'cid-D' })

    await waitMicrotasks()

    assert.strictEqual(
      fullStateCalls, 0,
      'no listeners should have fired after teardown'
    )
    assert.deepStrictEqual(
      Object.keys(externalState), [],
      'externalState should remain untouched after teardown'
    )
  })

  it('repeated setup/teardown cycles do not accumulate listeners', async () => {
    // Run setup → teardown five times, then verify that after a final
    // setup, exactly one of each event reaches exactly one handler.
    for (let i = 0; i < 5; i++) {
      const off = sbp('chelonia/externalStateSetup', {
        stateSelector: EXTERNAL_STATE_SELECTOR
      })
      off()
    }

    const teardown = sbp('chelonia/externalStateSetup', {
      stateSelector: EXTERNAL_STATE_SELECTOR
    })
    fullStateCalls = 0

    sbp('okTurtles.events/emit', CHELONIA_KV_UPDATED, { contractID: 'cid-X' })
    await waitMicrotasks()

    assert.strictEqual(
      fullStateCalls, 1,
      'after 5 setup/teardown cycles + 1 active setup, exactly one handler should fire'
    )

    teardown()
  })
})
