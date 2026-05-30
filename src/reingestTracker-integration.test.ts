// Integration tests for the re-ingest tracker against the live SBP
// selectors. These verify the two regressions called out in the unit
// tests are actually cleared at the right places in chelonia:
//
//   * `chelonia/private/removeImmediately(cid, { resync: true })` must
//     drop any pending re-ingest entries for that contract (forced
//     re-sync replays from height 0, so the pre-resync hashes are
//     stale).
//   * `chelonia/reset` must wipe the tracker for every contract (the
//     consumer's "Re-sync and rebuild data" path tears down chelonia
//     before re-syncing, and the tracker is otherwise module-level
//     state that would survive across sessions).

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it, beforeEach } from 'node:test'

import './chelonia.js'
import './db.js'
import {
  clearReingestTrackerAll,
  hasPendingReingest,
  noteFutureEvent,
  pendingReingestCount
} from './reingestTracker.js'
import type { ChelRootState } from './types.js'

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const CID_A = 'cidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const CID_B = 'cidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const CID_C = 'cidCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'

// `chelonia/private/removeImmediately` runs its main body only if
// `state.contracts[cid].type` is set. We stub just enough state for it
// to proceed; no real contract definition is required because the
// destructor lookup is by selector name and a missing destructor is a
// no-op.
const ensureContractStub = (contractID: string) => {
  const s = rootState() as ChelRootState & { contracts: Record<string, unknown> }
  if (!s.contracts) (s as { contracts?: unknown }).contracts = Object.create(null)
  s.contracts[contractID] = { type: 'test-contract', HEAD: '', height: 0, previousKeyOp: '' }
  ;(s as Record<string, unknown>)[contractID] = { _vm: { authorizedKeys: {} } }
}

describe('reingestTracker: integration with chelonia selectors', () => {
  // Reset both the tracker and the chelonia root state between tests
  // so the suite is order-independent (otherwise `state.contracts`
  // accumulates stub rows across tests).
  beforeEach(async () => {
    clearReingestTrackerAll()
    await sbp('chelonia/reset')
  })

  it('removeImmediately({ resync: true }) clears the per-contract entries', () => {
    ensureContractStub(CID_A)
    ensureContractStub(CID_B)
    noteFutureEvent(CID_A, 'h-stale-a-1', 10)
    noteFutureEvent(CID_A, 'h-stale-a-2', 20)
    noteFutureEvent(CID_B, 'h-stale-b-1', 10)
    assert.strictEqual(pendingReingestCount(CID_A), 2)

    sbp('chelonia/private/removeImmediately', CID_A, { resync: true })

    // CID_A's entries are gone (resync replays from height 0; their
    // pre-resync hashes are obsolete).
    assert.strictEqual(pendingReingestCount(CID_A), 0)
    assert.strictEqual(hasPendingReingest(CID_A, 'h-stale-a-1'), false)
    // CID_B is untouched.
    assert.strictEqual(pendingReingestCount(CID_B), 1)
    assert.strictEqual(hasPendingReingest(CID_B, 'h-stale-b-1'), true)
  })

  it('removeImmediately without resync also clears: the contract is gone, the entries can never re-ingest', () => {
    // Note: the non-resync removeImmediately path is used for true
    // contract teardown (release-to-zero, permanent deletion). Either
    // way, the contract id is no longer relevant — keeping its tracker
    // entries around would just consume cap space and risk poisoning a
    // later, unrelated re-creation of the same id. Asserts on CID_B
    // pin that the clear is scoped to CID_A: a regression that
    // accidentally drained the whole map would surface here.
    ensureContractStub(CID_A)
    noteFutureEvent(CID_A, 'h-stale-a-1', 10)
    noteFutureEvent(CID_B, 'h-stale-b-1', 10)
    sbp('chelonia/private/removeImmediately', CID_A)
    assert.strictEqual(pendingReingestCount(CID_A), 0)
    assert.strictEqual(pendingReingestCount(CID_B), 1)
    assert.strictEqual(hasPendingReingest(CID_B, 'h-stale-b-1'), true)
  })

  it('removeImmediately also clears when state.contracts[cid].type is missing (early-return path)', () => {
    // Regression: previously the tracker clear lived *after* the
    // "Missing contract name" early-return, so a CID that had no
    // `state.contracts[cid]` row would keep its pending hashes
    // indefinitely. Moving the clear above the early-return makes it
    // unconditional. We deliberately do NOT call `ensureContractStub`
    // here so the selector takes the early-return branch.
    noteFutureEvent(CID_C, 'h-stale-c-1', 10)
    assert.strictEqual(pendingReingestCount(CID_C), 1)
    sbp('chelonia/private/removeImmediately', CID_C)
    assert.strictEqual(pendingReingestCount(CID_C), 0)
  })

  it('chelonia/reset wipes the tracker for every contract', async () => {
    ensureContractStub(CID_A)
    ensureContractStub(CID_B)
    noteFutureEvent(CID_A, 'h-a', 10)
    noteFutureEvent(CID_B, 'h-b', 10)
    assert.strictEqual(pendingReingestCount(CID_A), 1)
    assert.strictEqual(pendingReingestCount(CID_B), 1)

    await sbp('chelonia/reset')

    assert.strictEqual(pendingReingestCount(CID_A), 0)
    assert.strictEqual(pendingReingestCount(CID_B), 0)
  })

  it('after removeImmediately({ resync: true }), re-noting the same hash is accepted (regression for "Already attempted to reingest")', () => {
    ensureContractStub(CID_A)
    noteFutureEvent(CID_A, 'h-stale', 10)
    sbp('chelonia/private/removeImmediately', CID_A, { resync: true })
    // Before the fix, the hash would still be in the global tracker
    // and noteFutureEvent would return 'duplicate' (which the caller
    // then escalates to ChelErrorDBBadPreviousHEAD). After the fix,
    // the tracker has been cleared for this contract.
    assert.strictEqual(noteFutureEvent(CID_A, 'h-stale', 10), 'added')
  })
})
