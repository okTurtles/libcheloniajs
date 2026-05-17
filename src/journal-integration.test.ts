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
  processingErrored = false
) => {
  sbp(
    'chelonia/private/journal/recordEvent',
    contractID,
    fakeMessage(hash, height),
    before,
    after,
    processingErrored
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
})
