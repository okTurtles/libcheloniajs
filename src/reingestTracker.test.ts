// Unit tests for the re-ingest tracker.
//
// Background: when `checkMessageOrdering` sees an event whose height is
// strictly greater than `latestProcessedHeight + 1` (a "future" event,
// i.e. there's a gap), it records the event's hash and schedules a
// forced re-sync to fill the gap. Originally this bookkeeping was a
// single module-level `string[]` shared across every contract, with a
// global cap of 100 entries. That design has three failure modes:
//
//   1. Cross-contract pollution: one chatty contract can exhaust the
//      shared cap and starve every other contract. The cap's intent
//      ("a single contract is stuck in a pathological loop") becomes
//      a system-wide kill switch instead.
//   2. Stale entries survive `chelonia/reset`: the tracker is module
//      state, not chelonia-context state, so a reset of the application
//      leaves stale hashes that then trip
//      `ChelErrorDBBadPreviousHEAD('Already attempted to reingest ...')`
//      on the next live delivery.
//   3. Stale entries survive a forced re-sync: `removeImmediately(cid,
//      { resync: true })` wipes the contract's state and re-fetches from
//      height 0, so any "future-event" hashes from the pre-resync
//      timeline are obsolete. Leaving them in the tracker turns the next
//      pubsub delivery of those hashes into a hard error even though,
//      post-resync, the chain is internally consistent again.
//
// The fix is a per-contract tracker with explicit clear hooks for
// reset and for resync. These tests pin that contract.

import assert from 'node:assert'
import { describe, it, beforeEach } from 'node:test'

import { ChelErrorUnrecoverable } from './errors.js'
import {
  clearReingestTrackerAll,
  clearReingestTrackerForContract,
  hasPendingReingest,
  noteReingestSuccess,
  noteFutureEvent,
  pendingReingestCount,
  REINGEST_PER_CONTRACT_CAP
} from './reingestTracker.js'

const CID_A = 'cidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const CID_B = 'cidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

describe('reingestTracker', () => {
  beforeEach(() => {
    clearReingestTrackerAll()
  })

  it('noteFutureEvent returns "added" the first time a hash is seen', () => {
    assert.strictEqual(noteFutureEvent(CID_A, 'h1'), 'added')
    assert.strictEqual(hasPendingReingest(CID_A, 'h1'), true)
    assert.strictEqual(pendingReingestCount(CID_A), 1)
  })

  it('noteFutureEvent returns "duplicate" the second time the same hash is seen', () => {
    noteFutureEvent(CID_A, 'h1')
    assert.strictEqual(noteFutureEvent(CID_A, 'h1'), 'duplicate')
    assert.strictEqual(pendingReingestCount(CID_A), 1)
  })

  it('noteReingestSuccess drops the hash if present, no-ops otherwise', () => {
    noteFutureEvent(CID_A, 'h1')
    assert.strictEqual(noteReingestSuccess(CID_A, 'h1'), true)
    assert.strictEqual(hasPendingReingest(CID_A, 'h1'), false)
    // Idempotent: calling again on the now-absent hash returns false.
    assert.strictEqual(noteReingestSuccess(CID_A, 'h1'), false)
  })

  it('isolates tracking per contract — filling contract A does not affect B', () => {
    // Fill A right up to (but not past) the per-contract cap. Contract
    // B must remain completely empty and able to accept a fresh entry.
    for (let i = 0; i < REINGEST_PER_CONTRACT_CAP; i++) {
      assert.strictEqual(noteFutureEvent(CID_A, `a-${i}`), 'added')
    }
    assert.strictEqual(pendingReingestCount(CID_A), REINGEST_PER_CONTRACT_CAP)
    assert.strictEqual(pendingReingestCount(CID_B), 0)
    assert.strictEqual(noteFutureEvent(CID_B, 'b-0'), 'added')
    assert.strictEqual(pendingReingestCount(CID_B), 1)
  })

  it('enforces a PER-CONTRACT cap and throws ChelErrorUnrecoverable on overflow', () => {
    for (let i = 0; i < REINGEST_PER_CONTRACT_CAP; i++) {
      noteFutureEvent(CID_A, `a-${i}`)
    }
    // The (CAP+1)-th distinct hash on the same contract must throw.
    assert.throws(
      () => noteFutureEvent(CID_A, 'overflow'),
      (err: Error) => err.name === 'ChelErrorUnrecoverable'
    )
    // ...but the same number of distinct hashes on a *different*
    // contract must still succeed (proves cap is per-contract).
    for (let i = 0; i < REINGEST_PER_CONTRACT_CAP; i++) {
      assert.strictEqual(noteFutureEvent(CID_B, `b-${i}`), 'added')
    }
  })

  it('clearReingestTrackerForContract drops only that contract\'s entries', () => {
    noteFutureEvent(CID_A, 'a-1')
    noteFutureEvent(CID_A, 'a-2')
    noteFutureEvent(CID_B, 'b-1')
    clearReingestTrackerForContract(CID_A)
    assert.strictEqual(pendingReingestCount(CID_A), 0)
    assert.strictEqual(hasPendingReingest(CID_A, 'a-1'), false)
    assert.strictEqual(pendingReingestCount(CID_B), 1)
    assert.strictEqual(hasPendingReingest(CID_B, 'b-1'), true)
  })

  it('clearReingestTrackerForContract on an unknown contract is a no-op (no throw)', () => {
    assert.doesNotThrow(() => clearReingestTrackerForContract('never-seen'))
  })

  it('clearReingestTrackerAll wipes every contract', () => {
    noteFutureEvent(CID_A, 'a-1')
    noteFutureEvent(CID_B, 'b-1')
    clearReingestTrackerAll()
    assert.strictEqual(pendingReingestCount(CID_A), 0)
    assert.strictEqual(pendingReingestCount(CID_B), 0)
  })

  it('after clearing a contract, the next future event is accepted (not re-blocked)', () => {
    // This is the resync regression: a hash that was rejected on the
    // pre-resync timeline must NOT be treated as "already attempted"
    // when the same hash arrives on the post-resync timeline (or, in
    // the simpler case below, when fresh events arrive after the
    // resync). After a per-contract clear, the tracker must accept the
    // same hash again without throwing.
    noteFutureEvent(CID_A, 'h-stale')
    clearReingestTrackerForContract(CID_A)
    assert.strictEqual(noteFutureEvent(CID_A, 'h-stale'), 'added')
  })

  it('cumulative gap events across many contracts must not trip a shared cap (okTurtles/libcheloniajs#77)', () => {
    // Regression for the original bug: during the consumer's manual
    // "Re-sync and rebuild data", `chelonia/private/in/sync` fans
    // out a forced re-sync over every contract in parallel. Each
    // contract racing through `removeImmediately({resync:true})` +
    // event-stream replay can contribute a few gap events to the
    // tracker. Under the old logic this was a single module-level
    // array with a global cap of 100, so the *cumulative* churn — not
    // any individual contract — tripped
    // `ChelErrorUnrecoverable('more than 100 different bad
    // previousHEAD errors')`. The fix makes the cap per-contract,
    // so cross-contract parallelism cannot starve the budget.
    //
    // We model the storm with 50 contracts × 5 distinct future events
    // each = 250 total — well past the old global cap of 100, but
    // each contract is comfortably under the per-contract cap.
    const N_CONTRACTS = 50
    const PER_CONTRACT = 5
    assert.ok(
      PER_CONTRACT < REINGEST_PER_CONTRACT_CAP,
      'precondition: each contract must be below the per-contract cap'
    )
    assert.ok(
      N_CONTRACTS * PER_CONTRACT > 100,
      'precondition: total events must exceed the old global cap of 100 to actually reproduce the bug'
    )

    // Step 1: prove the bug existed by replaying the *old* logic
    // inline against the same input. This is a faithful copy of the
    // pre-fix `eventsToReingest`/cap branch from
    // `handleEvent.checkMessageOrdering` (src/internals.ts, pre-fix).
    // If the old logic survives the storm we have no bug to fix; if
    // it throws `ChelErrorUnrecoverable` we've reproduced the
    // symptom the user reported in the issue screenshot.
    const legacyEventsToReingest: string[] = []
    const legacyCheck = (_cid: string, hash: string) => {
      if (legacyEventsToReingest.length > 100) {
        throw new ChelErrorUnrecoverable('more than 100 different bad previousHEAD errors')
      }
      if (!legacyEventsToReingest.includes(hash)) legacyEventsToReingest.push(hash)
    }
    assert.throws(
      () => {
        for (let c = 0; c < N_CONTRACTS; c++) {
          for (let h = 0; h < PER_CONTRACT; h++) {
            legacyCheck(`cid-storm-${c}`, `h-${c}-${h}`)
          }
        }
      },
      (err: Error) =>
        err.name === 'ChelErrorUnrecoverable' &&
        /more than 100 different bad previousHEAD errors/.test(err.message)
    )

    // Step 2: same storm against the new per-contract tracker must
    // *not* throw. Each contract is below its own cap; the cumulative
    // total no longer matters.
    for (let c = 0; c < N_CONTRACTS; c++) {
      const cid = `cid-storm-${c}`
      for (let h = 0; h < PER_CONTRACT; h++) {
        assert.strictEqual(noteFutureEvent(cid, `h-${c}-${h}`), 'added')
      }
    }
  })
})
