// Integration tests for the journal SBP selectors. These verify the
// recording/snapshot/trim cadence, redaction handling, error paths, and
// the public read/clear/reconstruct selectors against a real Chelonia
// context.
//
// We sidestep building a full SPMessage by feeding the journal a small
// stub object that exposes the methods the journal calls: `hash`,
// `height`, `opType`, `description`. The journal does not introspect
// anything else from the message.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it, before, beforeEach } from 'node:test'

import './chelonia.js'
import './db.js'
import { ChelErrorJournalCorrupt } from './errors.js'
import { defaultApplyPatch, defaultDiff } from './journal.js'
import type { ChelContractState, ChelRootState, JournalEntry, JournalPatch } from './types.js'

type FakeMessage = {
  hash: () => string;
  height: () => number;
  opType: () => string;
  description: () => string;
}

const fakeMessage = (
  hash: string,
  height: number,
  opType = 'ae',
  description?: string
): FakeMessage => ({
  hash: () => hash,
  height: () => height,
  opType: () => opType,
  description: () => description ?? `<${opType}|${hash}>`
})

const rootState = (): ChelRootState => sbp('chelonia/private/state')

const ensureContractMeta = (contractID: string) => {
  const s = rootState()
  if (!s.contracts) (s as { contracts?: unknown }).contracts = Object.create(null)
  if (!s.contracts[contractID]) {
    s.contracts[contractID] = {
      HEAD: '',
      height: 0,
      previousKeyOp: ''
    }
  }
}

const mkState = (n: number): ChelContractState => ({
  _vm: { authorizedKeys: {} },
  counter: n
} as unknown as ChelContractState)

const record = (
  contractID: string,
  hash: string,
  height: number,
  before: ChelContractState | undefined,
  after: ChelContractState | undefined,
  processingErrored = false,
  processingError: unknown = null
) => {
  sbp(
    'chelonia/private/journal/recordEvent',
    contractID,
    fakeMessage(hash, height),
    before,
    after,
    processingErrored,
    processingError
  )
}

const getEntries = (contractID: string): JournalEntry[] | undefined => {
  const j = sbp('chelonia/journal/get', contractID) as { entries: JournalEntry[] } | undefined
  return j?.entries
}

describe('journal: integration via SBP selectors', () => {
  before(() => {
    // Configure with a small snapshot interval so the trim path is fast
    // to exercise. Reset journal options between tests via configure.
    return sbp('chelonia/configure', {
      journal: {
        enabled: true,
        snapshotInterval: 3,
        contractIDs: [],
        redactions: []
      }
    })
  })

  beforeEach(() => {
    // Wipe all journals between tests so state from prior tests doesn't
    // leak. Each test brings its own contract IDs anyway, but be safe.
    sbp('chelonia/journal/clear')
    // Restore default journal config in case a previous test mutated it.
    // We explicitly reset `diff` / `applyPatch` back to the defaults — the
    // configure-side merge replaces only fields it sees, and tests below
    // intentionally swap in throwing implementations.
    return sbp('chelonia/configure', {
      journal: {
        enabled: true,
        snapshotInterval: 3,
        contractIDs: [],
        redactions: [],
        diff: defaultDiff,
        applyPatch: defaultApplyPatch
      }
    })
  })

  it('records a snapshot for the very first event of a contract', () => {
    const cid = 'cid-first'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[0].hash, 'h0')
    assert.strictEqual(entries[0].height, 0)
  })

  it('emits a patch entry for the second event and reconstructs', () => {
    const cid = 'cid-2nd'
    ensureContractMeta(cid)
    const s1 = mkState(1)
    const s2 = mkState(2)
    record(cid, 'h0', 0, undefined, s1)
    record(cid, 'h1', 1, s1, s2)
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 2)
    assert.strictEqual(entries[1].kind, 'patch')
    const recon = sbp('chelonia/journal/reconstruct', cid) as ChelContractState
    assert.deepStrictEqual(recon, s2)
  })

  it('inserts a fresh snapshot after `snapshotInterval` patches', () => {
    const cid = 'cid-snap'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    // With snapshotInterval = 3, the 3rd patch should trigger an
    // auto-snapshot, so the entries grow: [snap, p, p, p, snap].
    for (let i = 1; i <= 3; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 5)
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[1].kind, 'patch')
    assert.strictEqual(entries[2].kind, 'patch')
    assert.strictEqual(entries[3].kind, 'patch')
    assert.strictEqual(entries[4].kind, 'snapshot')
  })

  it('trims to the most recent snapshot once over 2*snapshotInterval', () => {
    const cid = 'cid-trim'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    // Drive many events through and verify the window invariant holds.
    for (let i = 1; i <= 20; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
      const entries = getEntries(cid)!
      assert.ok(
        entries.length <= 2 * 3,
        `journal entries (${entries.length}) exceeded 2*snapshotInterval at step ${i}`
      )
      assert.strictEqual(
        entries[0].kind,
        'snapshot',
        `entries[0] must always be a snapshot (step ${i})`
      )
    }
    // Final reconstruct still equals the latest after-state.
    const recon = sbp('chelonia/journal/reconstruct', cid)
    assert.deepStrictEqual(recon, prev)
  })

  // Guards the "between X and 2X" window invariant across the
  // auto-snapshot + trim boundary, where the trim could in principle
  // splice everything before a freshly-pushed snapshot and collapse the
  // window to a single entry. Drives the journal through many events
  // and asserts on every step:
  //   1. entries.length never exceeds 2 * snapshotInterval (upper bound)
  //   2. entries.length stays >= snapshotInterval once steady state is
  //      reached (the trim never collapses the window)
  //   3. entries[0] is always a snapshot so `reconstruct` has a base
  it('never collapses the window below `snapshotInterval` even at the auto-snapshot + trim boundary', () => {
    const cid = 'cid-trim-collapse-regression'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    const X = 3
    for (let i = 1; i <= 50; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
      const entries = getEntries(cid)!
      // Upper bound: trim must keep us at or below 2X.
      assert.ok(
        entries.length <= 2 * X,
        `step ${i}: entries.length=${entries.length} exceeded 2*X=${2 * X}`
      )
      // Lower bound: after the first event the window is just one
      // snapshot, which is fine; from step 2 onward we have at least
      // two entries, and once we reach steady state we should never
      // see the window collapse below X.
      if (i >= X) {
        assert.ok(
          entries.length >= X,
          `step ${i}: window collapsed to ${entries.length} entries (< X=${X})`
        )
      }
      // The head must always be a snapshot so `reconstruct` works.
      assert.strictEqual(
        entries[0].kind,
        'snapshot',
        `step ${i}: entries[0] is not a snapshot`
      )
    }
    // Reconstruct still matches the latest after-state.
    assert.deepStrictEqual(sbp('chelonia/journal/reconstruct', cid), prev)
  })

  it('skips journaling entirely when `enabled: false`', async () => {
    await sbp('chelonia/configure', {
      journal: { enabled: false, snapshotInterval: 3, contractIDs: [], redactions: [] }
    })
    const cid = 'cid-disabled'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    assert.strictEqual(getEntries(cid), undefined)
  })

  it('honours a `contractIDs` filter', async () => {
    await sbp('chelonia/configure', {
      journal: {
        enabled: true,
        snapshotInterval: 3,
        contractIDs: ['only-this'],
        redactions: []
      }
    })
    ensureContractMeta('only-this')
    ensureContractMeta('not-this')
    record('only-this', 'h0', 0, undefined, mkState(1))
    record('not-this', 'h0', 0, undefined, mkState(1))
    assert.ok(getEntries('only-this'))
    assert.strictEqual(getEntries('not-this'), undefined)
  })

  it('redacts via user-supplied redactor before diffing', async () => {
    await sbp('chelonia/configure', {
      journal: {
        enabled: true,
        snapshotInterval: 3,
        contractIDs: [],
        redactions: [
          { path: '_vm.authorizedKeys.*.data', redact: () => '[REDACTED]' }
        ]
      }
    })
    const cid = 'cid-redact'
    ensureContractMeta(cid)
    const s1 = {
      _vm: {
        authorizedKeys: {
          k1: { id: 'k1', data: 'SUPER-SECRET-1', purpose: ['sig'] }
        }
      }
    } as unknown as ChelContractState
    const s2 = {
      _vm: {
        authorizedKeys: {
          k1: { id: 'k1', data: 'SUPER-SECRET-2', purpose: ['sig'] },
          k2: { id: 'k2', data: 'SUPER-SECRET-3', purpose: ['enc'] }
        }
      }
    } as unknown as ChelContractState
    record(cid, 'h0', 0, undefined, s1)
    record(cid, 'h1', 1, s1, s2)
    const json = JSON.stringify(getEntries(cid))
    assert.ok(!json.includes('SUPER-SECRET-1'), 'before-secret leaked')
    assert.ok(!json.includes('SUPER-SECRET-2'), 'after-secret leaked')
    assert.ok(!json.includes('SUPER-SECRET-3'), 'new-secret leaked')
    assert.ok(json.includes('[REDACTED]'))
    // Because the redacted projection of k1 is constant, the only churn
    // visible in the patch should be the addition of k2.
    const entries = getEntries(cid)!
    assert.strictEqual(entries[1].kind, 'patch')
    const patch = (entries[1] as Extract<JournalEntry, { kind: 'patch' }>).patch
    // No 'replace' on the unchanged k1.data path.
    for (const p of patch) {
      assert.ok(
        !(p.op === 'replace' && p.path.endsWith('/k1/data')),
        `did not expect replace on k1.data: ${JSON.stringify(p)}`
      )
    }
  })

  it('does NOT clear the journal when reconfiguring with redactions (caller is responsible for clearing on actual changes)', async () => {
    // Rationale: `chelonia/configure` is typically re-invoked on every
    // app start with the same redactions, but function identity isn't
    // stable across process restarts — so we cannot detect "redactions
    // actually changed" reliably. Auto-clearing would therefore wipe
    // persisted journal history on every relaunch. The contract is:
    // configure leaves journals alone; callers who genuinely change
    // their redaction set must call `chelonia/journal/clear` themselves.
    await sbp('chelonia/configure', {
      journal: {
        enabled: true,
        snapshotInterval: 3,
        contractIDs: [],
        redactions: [{ path: '_vm.authorizedKeys.*.data', redact: () => '[REDACTED]' }]
      }
    })
    const cid = 'cid-redact-noclear'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(2))
    const before = getEntries(cid)!
    assert.ok(before.length >= 2)
    // Reconfigure with a *different* redact function: configure must
    // still not auto-clear. This mimics an app relaunch where the
    // freshly constructed redactor function is structurally identical
    // but a different object reference.
    await sbp('chelonia/configure', {
      journal: {
        redactions: [{ path: '_vm.authorizedKeys.*.data', redact: () => '[REDACTED-2]' }]
      }
    })
    assert.deepStrictEqual(getEntries(cid), before)
  })

  it('continues recording when a redactor throws (sentinel value)', async () => {
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await sbp('chelonia/configure', {
        journal: {
          enabled: true,
          snapshotInterval: 3,
          contractIDs: [],
          redactions: [
            { path: 'counter', redact: () => { throw new Error('boom') } }
          ]
        }
      })
      const cid = 'cid-throw-redact'
      ensureContractMeta(cid)
      record(cid, 'h0', 0, undefined, mkState(1))
      const entries = getEntries(cid)!
      assert.strictEqual(entries.length, 1)
      assert.strictEqual(entries[0].kind, 'snapshot')
    } finally {
      console.warn = origWarn
    }
  })

  it('swallows a throwing diff and emits an empty-patch entry', async () => {
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await sbp('chelonia/configure', {
        journal: {
          enabled: true,
          snapshotInterval: 3,
          contractIDs: [],
          redactions: [],
          diff: () => { throw new Error('diff exploded') }
        }
      })
      const cid = 'cid-bad-diff'
      ensureContractMeta(cid)
      record(cid, 'h0', 0, undefined, mkState(1))
      record(cid, 'h1', 1, mkState(1), mkState(2))
      const entries = getEntries(cid)!
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[1].kind, 'patch')
      const patch = (entries[1] as Extract<JournalEntry, { kind: 'patch' }>).patch
      assert.deepStrictEqual(patch, [])
    } finally {
      console.warn = origWarn
    }
  })

  it('bounds the journal at 2*snapshotInterval even under sustained processing errors', () => {
    // Regression: errored events emit empty-patch entries with no
    // post-state to snapshot from, so the snapshot-boundary path is
    // skipped. If an errored run begins after the last snapshot and
    // never returns, `appendAndTrim` has no newer snapshot to trim to
    // and the journal would grow unboundedly. Drive a long run of
    // errored events and assert the 2X upper bound holds throughout.
    const cid = 'cid-errored-bound'
    ensureContractMeta(cid)
    const initial = mkState(0)
    record(cid, 'h0', 0, undefined, initial)
    // snapshotInterval = 3 in this suite, so 2X = 6.
    for (let i = 1; i <= 50; i++) {
      record(cid, `h${i}`, i, initial, initial, true)
      const entries = getEntries(cid)!
      assert.ok(
        entries.length <= 6,
        `journal grew past 2*snapshotInterval (${entries.length}) at step ${i}`
      )
    }
  })

  it('attaches { name, message } to the auto-snapshot at the X-th-patch boundary when the boundary event errored', () => {
    // The X-th patch since the last snapshot triggers an auto-snapshot
    // built from `entry.hash/height/opType/description` plus the
    // post-state. If that boundary event was itself an errored event,
    // the snapshot must carry the error detail forward too — otherwise,
    // once the journal grows past 2X and trims everything before the
    // snapshot, the error info (which lived on the trimmed-away patch
    // entry) would be silently lost. snapshotInterval=3, so the 3rd
    // patch is the boundary; we make that 3rd patch error AND mutate
    // state so the snapshot path actually runs (it skips on undefined
    // post-state).
    const cid = 'cid-errored-auto-snapshot'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    // Two successful patches (patchesSinceSnap = 2).
    for (let i = 1; i <= 2; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    // 3rd patch is the boundary AND errored — but post-state is defined,
    // so the auto-snapshot path runs.
    const err = new Error('boundary boom')
    err.name = 'ChelErrorBoundary'
    const next = mkState(3)
    record(cid, 'h3', 3, prev, next, true, err)
    const entries = getEntries(cid)!
    // Expect: [snap@h0, patch@h1, patch@h2, patch@h3, snap@h3].
    assert.strictEqual(entries.length, 5)
    const autoSnap = entries[4] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(autoSnap.kind, 'snapshot')
    assert.strictEqual(autoSnap.hash, 'h3')
    assert.deepStrictEqual(autoSnap.error, {
      name: 'ChelErrorBoundary',
      message: 'boundary boom'
    })
    // And the matching patch entry also has it.
    const boundaryPatch = entries[3] as Extract<JournalEntry, { kind: 'patch' }>
    assert.deepStrictEqual(boundaryPatch.error, {
      name: 'ChelErrorBoundary',
      message: 'boundary boom'
    })
  })

  it('preserves boundary-event error detail on the auto-snapshot after trim discards the original patch entry', () => {
    // Follow-up to the boundary test: once the journal grows past 2X
    // entries, the trim splices away everything before the most recent
    // snapshot — including the errored boundary patch itself. If the
    // auto-snapshot didn't copy `error` forward, that information would
    // be permanently lost. Drive enough events past the boundary to
    // trigger a trim and assert the surviving snapshot still carries
    // the error.
    const cid = 'cid-errored-auto-snapshot-trim'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    for (let i = 1; i <= 2; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    const err = new Error('boundary boom')
    err.name = 'ChelErrorBoundary'
    const boundaryState = mkState(3)
    record(cid, 'h3', 3, prev, boundaryState, true, err)
    prev = boundaryState
    // Now push more patches past the boundary until the trim fires
    // (snapshotInterval=3 → 2X=6, so step h6 pushes length to 7 → trim).
    for (let i = 4; i <= 6; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    const entries = getEntries(cid)!
    // Trim drops everything before the most recent snapshot, so the
    // h0 snapshot AND the h1/h2/h3 patches are gone; only the h3 snapshot
    // plus subsequent patches survive.
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[0].hash, 'h3')
    assert.deepStrictEqual(
      (entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>).error,
      { name: 'ChelErrorBoundary', message: 'boundary boom' }
    )
    // The errored boundary patch was trimmed away — the snapshot is now
    // the only place this error detail lives.
    const boundaryPatch = entries.find((e) => e.kind === 'patch' && e.hash === 'h3')
    assert.strictEqual(boundaryPatch, undefined)
  })

  it('records an empty-patch entry when processingErrored is true', () => {
    const cid = 'cid-errored'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(1), true)
    const entries = getEntries(cid)!
    assert.strictEqual(entries[1].kind, 'patch')
    const patch = (entries[1] as Extract<JournalEntry, { kind: 'patch' }>).patch as JournalPatch[]
    assert.deepStrictEqual(patch, [])
  })

  it('attaches { name, message } from a captured error to the empty-patch entry', () => {
    // The recorder receives the live `Error` from internals.ts and is
    // expected to persist its `name` / `message` so the journal can
    // explain why the patch is empty after the fact.
    const cid = 'cid-errored-detail'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const err = new Error('bad signature')
    err.name = 'ChelErrorSignatureError'
    record(cid, 'h1', 1, mkState(1), mkState(1), true, err)
    const entries = getEntries(cid)!
    const e = entries[1] as Extract<JournalEntry, { kind: 'patch' }>
    assert.deepStrictEqual(e.patch, [])
    assert.deepStrictEqual(e.error, {
      name: 'ChelErrorSignatureError',
      message: 'bad signature'
    })
  })

  it('omits `error` when processingErrored is false even if an error reference is passed', () => {
    // Defensive: only record an error when the mutation was actually
    // discarded. A successful event must never carry an `error` field.
    const cid = 'cid-no-error-on-success'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(2), false, new Error('ignored'))
    const entries = getEntries(cid)!
    const e = entries[1] as Extract<JournalEntry, { kind: 'patch' }>
    assert.strictEqual(e.error, undefined)
  })

  it('omits `error` when processingErrored is true but no error reference is passed', () => {
    // The error parameter is optional; legacy/test callers that only
    // pass the boolean must continue to produce a clean empty-patch.
    const cid = 'cid-errored-no-detail'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(1), true)
    const entries = getEntries(cid)!
    const e = entries[1] as Extract<JournalEntry, { kind: 'patch' }>
    assert.strictEqual(e.error, undefined)
  })

  it('attaches { name, message } to the first-event snapshot when the first event errored', () => {
    // The first event on a contract is recorded as a snapshot (not a
    // patch), so the error-detail affordance must also exist on the
    // snapshot variant or the failure detail would be lost on this
    // path. Same expectation for resync / forward-gap re-seeds below.
    const cid = 'cid-errored-first'
    ensureContractMeta(cid)
    const err = new Error('first-event boom')
    err.name = 'ChelErrorFirstEvent'
    record(cid, 'h0', 0, undefined, mkState(1), true, err)
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1)
    const snap = entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(snap.kind, 'snapshot')
    assert.deepStrictEqual(snap.error, {
      name: 'ChelErrorFirstEvent',
      message: 'first-event boom'
    })
  })

  it('attaches { name, message } to a resync snapshot when the resync event errored', () => {
    // A strictly-backwards height re-seeds the journal with a fresh
    // snapshot. If processMutation throws on that re-seed event we
    // still want the error detail preserved.
    const cid = 'cid-errored-resync'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(2))
    // Resync: height moves backwards to 0.
    const err = new Error('resync boom')
    err.name = 'ChelErrorResync'
    record(cid, 'h-resync', 0, undefined, mkState(9), true, err)
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1, 'resync must collapse to a single snapshot')
    const snap = entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(snap.kind, 'snapshot')
    assert.deepStrictEqual(snap.error, {
      name: 'ChelErrorResync',
      message: 'resync boom'
    })
  })

  it('attaches { name, message } to a forward-gap snapshot when the gap event errored', () => {
    // A strictly-forward height gap (last height N, incoming height >
    // N + 1) is also treated as a resync and emits a fresh snapshot.
    const cid = 'cid-errored-gap'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    record(cid, 'h1', 1, mkState(1), mkState(2))
    // Gap: jump from height 1 to height 5 — height > lastEntry.height + 1.
    const err = new Error('gap boom')
    err.name = 'ChelErrorGap'
    record(cid, 'h-gap', 5, mkState(2), mkState(3), true, err)
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1, 'forward-gap must collapse to a single snapshot')
    const snap = entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(snap.kind, 'snapshot')
    assert.deepStrictEqual(snap.error, {
      name: 'ChelErrorGap',
      message: 'gap boom'
    })
  })

  it('omits `error` on a snapshot when processingErrored is false even if an error reference is passed', () => {
    // Mirror of the patch-side defensive check: an `error` argument
    // must be ignored when the mutation succeeded.
    const cid = 'cid-snapshot-no-error-on-success'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1), false, new Error('ignored'))
    const entries = getEntries(cid)!
    const snap = entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(snap.kind, 'snapshot')
    assert.strictEqual(snap.error, undefined)
  })

  it('omits `error` on a snapshot when processingErrored is true but no error reference is passed', () => {
    const cid = 'cid-snapshot-errored-no-detail'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1), true)
    const entries = getEntries(cid)!
    const snap = entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    assert.strictEqual(snap.kind, 'snapshot')
    assert.strictEqual(snap.error, undefined)
  })

  it('normalizes non-Error throwables (string, number, plain object, null) into { name, message }', () => {
    // JavaScript permits `throw <anything>`. The recorder must not
    // assume an `Error` instance — these cases must still produce a
    // sensible `{ name: string, message: string }` pair instead of
    // crashing or persisting `undefined` getters.
    //
    // Helper: locate the patch entry for a specific hash. We can't
    // just take `entries[entries.length - 1]` because the boundary
    // snapshot can land on top of a patch when `snapshotInterval`
    // ticks over.
    const findPatch = (cid: string, hash: string) => {
      const entries = getEntries(cid)!
      const e = entries.find((x) => x.kind === 'patch' && x.hash === hash)
      assert.ok(e, `expected to find patch entry for ${hash}`)
      return e as Extract<JournalEntry, { kind: 'patch' }>
    }

    const cid = 'cid-errored-non-error'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))

    // String throwable.
    record(cid, 'h1', 1, mkState(1), mkState(1), true, 'oops')
    assert.deepStrictEqual(findPatch(cid, 'h1').error,
      { name: 'string', message: 'oops' })

    // Number throwable.
    record(cid, 'h2', 2, mkState(1), mkState(1), true, 42)
    assert.deepStrictEqual(findPatch(cid, 'h2').error,
      { name: 'number', message: '42' })

    // Plain object with name/message.
    record(cid, 'h3', 3, mkState(1), mkState(1), true,
      { name: 'CustomThrow', message: 'plain' })
    assert.deepStrictEqual(findPatch(cid, 'h3').error,
      { name: 'CustomThrow', message: 'plain' })

    // Plain object without name/message — defaults applied.
    record(cid, 'h4', 4, mkState(1), mkState(1), true, {})
    assert.deepStrictEqual(findPatch(cid, 'h4').error,
      { name: 'Object', message: '' })

    // null is treated as "no error detail" (same as omitted).
    record(cid, 'h5', 5, mkState(1), mkState(1), true, null)
    assert.strictEqual(findPatch(cid, 'h5').error, undefined)
  })

  it('coerces non-string name/message on Error-like objects without throwing', () => {
    // A custom error class could expose non-string `name` / `message`
    // (e.g. a number, an object, even a getter that throws). The
    // recorder must coerce defensively — a journal entry with a
    // non-JSON-safe value would break downstream consumers.
    const cid = 'cid-errored-weird-fields'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const weird = { name: 123, message: { toString: () => 'stringified' } }
    record(cid, 'h1', 1, mkState(1), mkState(1), true, weird)
    const entries = getEntries(cid)!
    const patch = entries.find((x) => x.kind === 'patch' && x.hash === 'h1') as
      Extract<JournalEntry, { kind: 'patch' }>
    assert.strictEqual(typeof patch.error?.name, 'string')
    assert.strictEqual(typeof patch.error?.message, 'string')
    assert.strictEqual(patch.error?.name, '123')
    assert.strictEqual(patch.error?.message, 'stringified')
  })

  it('does not insert a snapshot with `state: undefined` when the snapshot boundary lands on an errored event', () => {
    // An errored event arriving at the X-th-patch-since-last-snapshot
    // boundary must not trigger an auto-snapshot built from the missing
    // post-state: doing so would persist `{ state: undefined }`, which
    // crashes `reconstruct` and, once trimming kicks in at 2X, leaves the
    // journal permanently anchored on a bogus snapshot. The auto-snapshot
    // is instead deferred to the next non-errored event on the boundary.
    const cid = 'cid-errored-boundary'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    // Drive snapshotInterval-1 successful patches then a final errored
    // patch on the boundary. With snapshotInterval=3 we need 2 OK + 1
    // errored to land the errored event at patchesSinceSnap === 3.
    for (let i = 1; i <= 2; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    record(cid, 'h3', 3, prev, prev, true)
    const entries = getEntries(cid)!
    for (const e of entries) {
      if (e.kind === 'snapshot') {
        assert.notStrictEqual(
          e.state,
          undefined,
          'snapshot.state must not be undefined; the auto-snapshot at an errored boundary must be deferred'
        )
      }
    }
    // reconstruct must round-trip cleanly.
    const recon = sbp('chelonia/journal/reconstruct', cid)
    assert.deepStrictEqual(recon, prev)
  })

  it('chelonia/journal/get returns a deep clone', () => {
    const cid = 'cid-clone'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const first = sbp('chelonia/journal/get', cid) as { entries: JournalEntry[] }
    first.entries.length = 0
    const second = sbp('chelonia/journal/get', cid) as { entries: JournalEntry[] }
    assert.strictEqual(second.entries.length, 1)
  })

  it('chelonia/journal/clear removes a single contract\'s journal', () => {
    const cid1 = 'cid-clear-1'
    const cid2 = 'cid-clear-2'
    ensureContractMeta(cid1)
    ensureContractMeta(cid2)
    record(cid1, 'h0', 0, undefined, mkState(1))
    record(cid2, 'h0', 0, undefined, mkState(1))
    const n = sbp('chelonia/journal/clear', cid1)
    assert.strictEqual(n, 1)
    assert.strictEqual(getEntries(cid1), undefined)
    assert.ok(getEntries(cid2))
  })

  it('chelonia/journal/clear with no arg clears all', () => {
    const cid1 = 'cid-clear-all-1'
    const cid2 = 'cid-clear-all-2'
    ensureContractMeta(cid1)
    ensureContractMeta(cid2)
    record(cid1, 'h0', 0, undefined, mkState(1))
    record(cid2, 'h0', 0, undefined, mkState(1))
    const n = sbp('chelonia/journal/clear') as number
    assert.ok(n >= 2)
    assert.strictEqual(getEntries(cid1), undefined)
    assert.strictEqual(getEntries(cid2), undefined)
  })

  it('reconstruct returns undefined for an unknown contract', () => {
    assert.strictEqual(sbp('chelonia/journal/reconstruct', 'never-seen'), undefined)
  })

  it('reconstruct throws ChelErrorJournalCorrupt when applyPatch fails', async () => {
    // Swap in a deliberately broken applier and watch reconstruct fail
    // loudly rather than silently returning undefined (which a caller
    // could not distinguish from "no journal exists").
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await sbp('chelonia/configure', {
        journal: {
          applyPatch: () => { throw new Error('boom') }
        }
      })
      const cid = 'cid-recon-broken'
      ensureContractMeta(cid)
      record(cid, 'h0', 0, undefined, mkState(1))
      record(cid, 'h1', 1, mkState(1), mkState(2))
      assert.throws(
        () => sbp('chelonia/journal/reconstruct', cid),
        (err: unknown) => {
          assert.ok(err instanceof ChelErrorJournalCorrupt,
            `expected ChelErrorJournalCorrupt, got ${(err as Error)?.name}`)
          const e = err as Error & { entryIndex?: number; contractID?: string; cause?: unknown }
          assert.strictEqual(e.entryIndex, 1)
          assert.strictEqual(e.contractID, cid)
          assert.ok(e.cause instanceof Error)
          assert.strictEqual((e.cause as Error).message, 'boom')
          return true
        }
      )
    } finally {
      // Restore the default applier so subsequent tests are unaffected.
      await sbp('chelonia/configure', { journal: { applyPatch: defaultApplyPatch } })
      console.warn = origWarn
    }
  })

  it('reconstruct matches the latest redacted after-state across many events', () => {
    const cid = 'cid-recon-long'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    for (let i = 1; i <= 10; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    assert.deepStrictEqual(sbp('chelonia/journal/reconstruct', cid), prev)
  })

  it('re-seeds with a snapshot when a contract is re-synced', () => {
    // Simulates Chelonia re-processing the same chain (e.g. a keyShare
    // arrived and `_volatile.dirty` triggered a full resync). The journal
    // must NOT append a giant nonsensical patch on top of the prior
    // entries; it must drop the old window and start fresh.
    const cid = 'cid-resync'
    ensureContractMeta(cid)
    let prev = mkState(0)
    record(cid, 'h0', 0, undefined, prev)
    for (let i = 1; i <= 4; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, prev, next)
      prev = next
    }
    const beforeResync = getEntries(cid)!
    assert.ok(beforeResync.length > 1)

    // Replay the chain from height 0. The first replayed event must
    // collapse the journal back to a single snapshot.
    record(cid, 'h0', 0, undefined, mkState(0))
    const afterFirstReplay = getEntries(cid)!
    assert.strictEqual(afterFirstReplay.length, 1)
    assert.strictEqual(afterFirstReplay[0].kind, 'snapshot')
    assert.strictEqual(afterFirstReplay[0].hash, 'h0')

    // Subsequent replayed events resume as patches against the reseed.
    let p = mkState(0)
    for (let i = 1; i <= 4; i++) {
      const next = mkState(i)
      record(cid, `h${i}`, i, p, next)
      p = next
    }
    const after = getEntries(cid)!
    assert.strictEqual(after[0].kind, 'snapshot')
    assert.deepStrictEqual(sbp('chelonia/journal/reconstruct', cid), p)
  })

  it('ignores duplicate arrivals (same hash, same height) without rewriting the journal', () => {
    // Duplicate event delivery (retry-on-publish, web-socket replay) must
    // not be treated as a resync: the perfectly valid prior window has to
    // be preserved when the duplicate carries the same (hash, height)
    // pair as the last journalled entry. Only a strictly backwards
    // height counts as a resync (see the next test).
    const cid = 'cid-dup-arrival'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(0))
    record(cid, 'h1', 1, mkState(0), mkState(1))
    const before = getEntries(cid)!
    assert.strictEqual(before.length, 2)
    record(cid, 'h1', 1, mkState(0), mkState(1))
    const after = getEntries(cid)!
    // Window is unchanged — the duplicate is dropped silently.
    assert.deepStrictEqual(after, before)
  })

  it('re-seeds when an incoming event has strictly lower height than the last journalled entry', () => {
    // Strict backwards-height delivery is the unambiguous resync signal:
    // the journal collapses to a fresh snapshot.
    const cid = 'cid-resync-backwards'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(0))
    record(cid, 'h1', 1, mkState(0), mkState(1))
    record(cid, 'h2', 2, mkState(1), mkState(2))
    // A re-arrival of an earlier height with a different hash signals a
    // full re-process from scratch.
    record(cid, 'h0b', 0, undefined, mkState(0))
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[0].hash, 'h0b')
  })

  it('chelonia/journal/get preserves `undefined` property values', () => {
    // Use a snapshot path that puts `undefined` directly into the cloned
    // state. JSON round-trip would silently drop it; cloneValue must not.
    const cid = 'cid-undef'
    ensureContractMeta(cid)
    const s = { keepMe: 'yes', dropMe: undefined } as unknown as ChelContractState
    record(cid, 'h0', 0, undefined, s)
    const j = sbp('chelonia/journal/get', cid) as
      { entries: JournalEntry[] } | undefined
    assert.ok(j)
    const snap = j!.entries[0] as Extract<JournalEntry, { kind: 'snapshot' }>
    const cloned = snap.state as Record<string, unknown>
    assert.strictEqual(cloned.keepMe, 'yes')
    // Property must still exist with value `undefined` (not dropped).
    assert.ok('dropMe' in cloned, '`undefined` value was dropped by clone')
    assert.strictEqual(cloned.dropMe, undefined)
  })

  it('rejects field-level null in chelonia/configure with a TypeError', async () => {
    // Documented contract: only typed values are accepted; pass
    // `undefined`/omit to leave a field alone. `null` is a programmer
    // error and must fail loudly rather than slip through to the read
    // path with surprising effects.
    for (const field of [
      'enabled', 'snapshotInterval', 'contractIDs', 'redactions', 'diff', 'applyPatch'
    ]) {
      await assert.rejects(
        sbp('chelonia/configure', { journal: { [field]: null } }),
        (err: unknown) => err instanceof TypeError && /cannot be null/.test((err as Error).message),
        `expected configure to reject null for ${field}`
      )
    }
  })

  it('rejects field-level type mismatches in chelonia/configure with a TypeError', async () => {
    // Same loud-failure rationale as the null check: a wrong type would
    // otherwise slip through (e.g. `enabled: "true"` is truthy but
    // fails the strict-equality check in `resolveJournalConfig`, leaving
    // journaling silently disabled).
    const cases: Array<[string, unknown, RegExp]> = [
      ['enabled', 'true', /must be a boolean/],
      ['contractIDs', 'cid-x', /must be an array/],
      ['redactions', {}, /must be an array/],
      ['diff', 'not-a-fn', /must be a function/],
      ['applyPatch', 42, /must be a function/]
    ]
    for (const [field, value, pattern] of cases) {
      await assert.rejects(
        sbp('chelonia/configure', { journal: { [field]: value } }),
        (err: unknown) => err instanceof TypeError && pattern.test((err as Error).message),
        `expected configure to reject ${field}=${String(value)}`
      )
    }
  })

  it('treats top-level journal: null as "stop journaling"', async () => {
    // Seed: record an entry on a contract while journaling is enabled.
    const cid = 'cid-journal-null'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    assert.ok(getEntries(cid), 'precondition: journal exists')

    // Reset via journal: null. This should disable journaling and clear
    // all persisted journals.
    await sbp('chelonia/configure', { journal: null })

    assert.strictEqual(getEntries(cid), undefined,
      'persisted journal should be cleared by journal: null')

    // And subsequent recordEvent must be a no-op while disabled.
    record(cid, 'h1', 1, undefined, mkState(2))
    assert.strictEqual(getEntries(cid), undefined,
      'recordEvent must not journal while disabled')

    // Restore enabled state for subsequent tests (beforeEach also does
    // this, but be explicit).
    await sbp('chelonia/configure', {
      journal: { enabled: true, snapshotInterval: 3 }
    })
  })

  it('treats omitted journal field as "leave alone"', async () => {
    // Reconfiguring without a `journal` key must not touch journal
    // config or persisted entries.
    const cid = 'cid-journal-leave-alone'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const before = getEntries(cid)
    assert.ok(before)

    await sbp('chelonia/configure', { /* no journal key */ })

    assert.deepStrictEqual(getEntries(cid), before,
      'omitted journal must not clear persisted entries')

    // And recording must still work (i.e. journaling is still enabled).
    record(cid, 'h1', 1, mkState(1), mkState(2))
    const after = getEntries(cid)!
    assert.ok(after.length > before!.length,
      'omitted journal must leave `enabled: true` alone')
  })

  it('treats explicit journal: undefined as "leave alone" (not a wipe)', async () => {
    // Spreads / conditional config builders commonly produce
    // `{ journal: undefined }`. Per docs/configure.md, omission means "leave
    // alone"; an explicit `undefined` MUST behave the same. Otherwise
    // turtledash's `merge` would silently overwrite the live journal
    // block with `undefined`, killing journaling with no diagnostic.
    const cid = 'cid-journal-undefined'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(1))
    const before = getEntries(cid)
    assert.ok(before, 'precondition: journal exists')

    await sbp('chelonia/configure', { journal: undefined })

    assert.deepStrictEqual(getEntries(cid), before,
      'explicit journal: undefined must not clear persisted entries')

    // And recording must still work — i.e. journaling is still enabled
    // and the live `journal.enabled` flag wasn't quietly clobbered.
    record(cid, 'h1', 1, mkState(1), mkState(2))
    const after = getEntries(cid)!
    assert.ok(after.length > before!.length,
      'explicit journal: undefined must leave `enabled: true` alone')
  })

  it('re-seeds when the incoming height jumps forward past lastEntry.height + 1', async () => {
    // Forward-gap detection. Under normal operation Chelonia journals
    // every event, so a height jump from M to M+2+ means we missed
    // entries — typically because journaling was toggled off and back
    // on, or `contractIDs` was widened to re-include this contract.
    // The cached before-state inside the next event no longer matches
    // `lastEntry`, so producing a patch on top of it would silently
    // corrupt `reconstruct`. Instead the recorder must re-seed with a
    // fresh snapshot.
    const cid = 'cid-forward-gap'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(0))
    record(cid, 'h1', 1, mkState(0), mkState(1))
    const before = getEntries(cid)!
    assert.strictEqual(before.length, 2)

    // Simulate the gap: jump from height 1 directly to height 5.
    record(cid, 'h5', 5, mkState(4), mkState(5))
    const after = getEntries(cid)!
    assert.strictEqual(after.length, 1, 'forward gap must collapse the journal to a snapshot')
    assert.strictEqual(after[0].kind, 'snapshot')
    assert.strictEqual(after[0].hash, 'h5')

    // And reconstruct round-trips cleanly against the fresh seed.
    assert.deepStrictEqual(sbp('chelonia/journal/reconstruct', cid), mkState(5))
  })

  it('does NOT treat the normal +1 height step as a forward gap', async () => {
    // Guard against regression: a contiguous chain must continue to
    // emit patches.
    const cid = 'cid-no-false-gap'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(0))
    record(cid, 'h1', 1, mkState(0), mkState(1))
    record(cid, 'h2', 2, mkState(1), mkState(2))
    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 3)
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[1].kind, 'patch')
    assert.strictEqual(entries[2].kind, 'patch')
  })

  it('survives an enabled: false → true cycle without corrupting reconstruct', async () => {
    // End-to-end scenario for the gap-detection guard: journal a chain,
    // disable journaling, drive the contract forward off-journal, then
    // re-enable. The next recorded event arrives with a forward gap
    // and the recorder must re-seed rather than diff from the stale
    // before-state.
    const cid = 'cid-toggle-cycle'
    ensureContractMeta(cid)
    record(cid, 'h0', 0, undefined, mkState(0))
    record(cid, 'h1', 1, mkState(0), mkState(1))

    // Disable: subsequent events are no-ops in the recorder.
    await sbp('chelonia/configure', { journal: { enabled: false } })
    record(cid, 'h2', 2, mkState(1), mkState(2))
    record(cid, 'h3', 3, mkState(2), mkState(3))

    // Re-enable. The next event has height 4 while the last entry is
    // still at height 1 — a forward gap. Re-seed with a snapshot.
    await sbp('chelonia/configure', { journal: { enabled: true } })
    record(cid, 'h4', 4, mkState(3), mkState(4))

    const entries = getEntries(cid)!
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].kind, 'snapshot')
    assert.strictEqual(entries[0].hash, 'h4')
    assert.deepStrictEqual(sbp('chelonia/journal/reconstruct', cid), mkState(4))
  })
})
