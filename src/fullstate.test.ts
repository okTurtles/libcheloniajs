// Tests for the real `chelonia/contract/fullState` selector and for the
// consumers of it in `src/local-selectors/index.ts`.
//
// These live in their own entry point (see the `test` script in
// package.json) and MUST NOT be imported from `src/index.test.ts`:
// `src/local-selectors/index.test.ts` registers a *stub*
// `chelonia/contract/fullState` and is imported before `src/chelonia.ts`,
// and SBP silently drops a registration for an already-registered selector.
// In the aggregate run the real selector therefore never gets registered, so
// assertions placed there would exercise the stub instead.
//
// Import order below also matters: `src/local-selectors/index.ts` registers
// `chelonia/externalStateSetup` and `chelonia/externalStateWait`, and must be
// loaded before `src/chelonia.ts`, which locks the `chelonia` SBP domain at
// module scope.

import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'

import './local-selectors/index.js'
import './chelonia.js'
import { EVENT_HANDLED } from './events.js'
import type { ChelRootState } from './types.js'

const EXTERNAL_STATE_SELECTOR = 'test/fullState/externalState'

type ExternalState = {
  contracts?: Record<string, Record<string, unknown>>;
} & Record<string, unknown>

let externalState: ExternalState

sbp('sbp/selectors/register', {
  [EXTERNAL_STATE_SELECTOR]: (): ExternalState => externalState
})

const rootState = (): ChelRootState => sbp('chelonia/private/state')
const looseRootState = (): Record<string, unknown> =>
  rootState() as unknown as Record<string, unknown>
const contractMetas = (): Record<string, unknown> => {
  const state = looseRootState()
  if (!state.contracts) state.contracts = {}
  return state.contracts as Record<string, unknown>
}

const makeMeta = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  HEAD: 'hash',
  height: 3,
  previousKeyOp: 'keyop',
  ...extra
})

const JOURNAL = { entries: [{ entryIndex: 0, kind: 'snapshot' }] }

const mirrored = (contractID: string): Record<string, unknown> | undefined =>
  externalState.contracts?.[contractID]

const resetState = (): void => {
  const state = looseRootState()
  for (const contractID of Object.keys(contractMetas())) {
    delete contractMetas()[contractID]
    delete state[contractID]
  }
  delete state._kv
  externalState = { contracts: Object.create(null) }
}

const waitMicrotasks = async (): Promise<void> => {
  // The handlers queue work onto okTurtles.eventQueue/queueEvent; await a
  // couple of macrotask boundaries so that they settle.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

// Fails loudly instead of hanging the suite when a promise never settles.
const settlesWithin = async (p: Promise<unknown>, ms: number, label: string): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not settle within ${ms}ms`))
        }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Resolves to 'resolved', 'rejected: <message>' or 'pending'.
const outcomeWithin = async (p: Promise<unknown>, ms: number): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

let teardown: () => void

before(() => {
  externalState = { contracts: Object.create(null) }
  teardown = sbp('chelonia/externalStateSetup', {
    stateSelector: EXTERNAL_STATE_SELECTOR
  })
})

after(() => {
  teardown()
})

beforeEach(resetState)

describe('chelonia/contract/fullState', () => {
  const CID = 'cid-fullState'

  it('omits the journal by default, without leaving an empty key behind', () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })

    const { cheloniaState } = sbp('chelonia/contract/fullState', CID)

    assert.ok(cheloniaState, 'cheloniaState must stay truthy for a known contract')
    assert.strictEqual(cheloniaState.HEAD, 'hash')
    assert.strictEqual(cheloniaState.height, 3)
    assert.strictEqual(cheloniaState.previousKeyOp, 'keyop')
    assert.ok(!('_journal' in cheloniaState), '_journal must not be an own property')
    assert.deepStrictEqual(Object.keys(cheloniaState).sort(), ['HEAD', 'height', 'previousKeyOp'])
  })

  it('includes the journal when opted in', () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })

    const { cheloniaState } = sbp(
      'chelonia/contract/fullState', CID, undefined, { includeJournal: true }
    )

    assert.deepStrictEqual(cheloniaState._journal, JOURNAL)
    // Documented behaviour: the journal comes back by reference, unlike
    // `chelonia/journal/get`, which deep-clones. Callers must not mutate it.
    assert.strictEqual(cheloniaState._journal, JOURNAL)
    assert.strictEqual(cheloniaState.HEAD, 'hash')
  })

  it('accepts an empty options object', () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })

    const { cheloniaState } = sbp('chelonia/contract/fullState', CID, undefined, {})

    assert.ok(!('_journal' in cheloniaState))
  })

  it('accepts a null options argument', () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })

    const { cheloniaState } = sbp('chelonia/contract/fullState', CID, undefined, null)

    assert.ok(!('_journal' in cheloniaState))
  })

  it('omits the _journal key when opted in but there is no journal', () => {
    contractMetas()[CID] = makeMeta()

    const { cheloniaState } = sbp(
      'chelonia/contract/fullState', CID, undefined, { includeJournal: true }
    )

    // An `_journal: undefined` own key would make `'_journal' in
    // cheloniaState` (and `structuredClone` / `deepStrictEqual`) report a
    // journal the contract never had.
    assert.ok(!('_journal' in cheloniaState))
    assert.deepStrictEqual(Object.keys(cheloniaState).sort(), ['HEAD', 'height', 'previousKeyOp'])
  })

  it('omits the _journal key after the journal was cleared', () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })
    sbp('chelonia/journal/clear', CID)
    const live = contractMetas()[CID] as Record<string, unknown>
    assert.ok(!('_journal' in live), 'clearing must delete the key, not empty it')

    const { cheloniaState } = sbp(
      'chelonia/contract/fullState', CID, undefined, { includeJournal: true }
    )

    assert.ok(!('_journal' in cheloniaState))
  })

  it('is a shallow copy: nested values stay shared with live state', () => {
    const keyIds = ['kid1']
    contractMetas()[CID] = makeMeta({ missingDecryptionKeyIds: keyIds })

    const { cheloniaState } = sbp('chelonia/contract/fullState', CID)

    // Documented in docs/api.md: only top-level keys are isolated, so the
    // whole tuple must be treated as read-only.
    assert.strictEqual(cheloniaState.missingDecryptionKeyIds, keyIds)
  })

  it('passes a null meta through unchanged (permanently-deleted sentinel)', () => {
    contractMetas()[CID] = null

    assert.strictEqual(sbp('chelonia/contract/fullState', CID).cheloniaState, null)
    // Requesting the journal for a deleted contract must not throw.
    assert.strictEqual(
      sbp('chelonia/contract/fullState', CID, undefined, { includeJournal: true }).cheloniaState,
      null
    )
  })

  it('passes a missing meta through unchanged', () => {
    assert.strictEqual(sbp('chelonia/contract/fullState', CID).cheloniaState, undefined)
    assert.strictEqual(
      sbp('chelonia/contract/fullState', CID, undefined, { includeJournal: true }).cheloniaState,
      undefined
    )
  })

  it('keeps per-contract semantics in the array form', () => {
    const present = 'cid-present'
    const deleted = 'cid-deleted'
    const unknown = 'cid-unknown'
    contractMetas()[present] = makeMeta({ _journal: JOURNAL })
    contractMetas()[deleted] = null
    looseRootState()[present] = { _vm: { authorizedKeys: {} } }
    looseRootState()._kv = {
      [present]: { slot: { value: 'v', etag: null, status: 'loaded' } }
    }

    const out = sbp('chelonia/contract/fullState', [present, deleted, unknown], 'slot')

    assert.deepStrictEqual(Object.keys(out).sort(), [deleted, present, unknown].sort())
    assert.ok(!('_journal' in out[present].cheloniaState))
    assert.deepStrictEqual(out[present].contractState, { _vm: { authorizedKeys: {} } })
    assert.deepStrictEqual(out[present].kvState, {
      slot: { value: 'v', etag: null, status: 'loaded' }
    })
    assert.deepStrictEqual(out[present].kvEntry, { value: 'v', etag: null, status: 'loaded' })
    assert.strictEqual(out[deleted].cheloniaState, null)
    assert.strictEqual(out[unknown].cheloniaState, undefined)
    assert.strictEqual(out[unknown].contractState, undefined)
    assert.strictEqual(out[unknown].kvEntry, undefined)
  })

  it('returns a copy, so callers cannot mutate Chelonia state', () => {
    contractMetas()[CID] = makeMeta()

    const { cheloniaState } = sbp('chelonia/contract/fullState', CID)
    cheloniaState.HEAD = 'mutated'

    const live = contractMetas()[CID] as Record<string, unknown>
    assert.strictEqual(live.HEAD, 'hash')
  })
})

describe('chelonia/externalStateWait', () => {
  const CID = 'cid-wait'

  it('returns immediately for a permanently-deleted contract', async () => {
    contractMetas()[CID] = null

    await settlesWithin(sbp('chelonia/externalStateWait', CID), 500, 'wait(null meta)')
  })

  it('returns immediately for a contract Chelonia has no meta for', async () => {
    await settlesWithin(sbp('chelonia/externalStateWait', CID), 500, 'wait(absent meta)')
  })

  it('returns immediately when the meta carries no height', async () => {
    contractMetas()[CID] = { HEAD: 'hash', previousKeyOp: 'keyop' }

    await settlesWithin(sbp('chelonia/externalStateWait', CID), 500, 'wait(heightless meta)')
  })

  it('returns immediately during a resync window (meta shell)', async () => {
    // `chelonia/private/removeImmediately(cid, { resync: true })` deletes
    // every meta key but `references`, leaving a truthy meta with no height
    // until the replay sets HEAD/height again. If the resync itself fails,
    // that shell persists, so waiting on it would never settle.
    contractMetas()[CID] = { references: 1 }

    await settlesWithin(sbp('chelonia/externalStateWait', CID), 500, 'wait(resync shell)')
  })

  it('waits for the external mirror, even before it has a contracts subtree', async () => {
    // No `contracts` key at all: reading the local height must not throw.
    externalState = Object.create(null)
    contractMetas()[CID] = makeMeta()
    looseRootState()[CID] = { _vm: { authorizedKeys: {} } }

    const waiting = sbp('chelonia/externalStateWait', CID) as Promise<void>
    assert.strictEqual(await outcomeWithin(waiting, 150), 'pending')

    sbp('okTurtles.events/emit', EVENT_HANDLED, CID, {})
    await settlesWithin(waiting, 500, 'wait after the mirror caught up')
    assert.strictEqual(mirrored(CID)?.height, 3)
  })
})

describe('external state mirror', () => {
  const CID = 'cid-mirror'

  it('does not receive the journal', async () => {
    contractMetas()[CID] = makeMeta({ _journal: JOURNAL })
    looseRootState()[CID] = { _vm: { authorizedKeys: {} } }

    sbp('okTurtles.events/emit', EVENT_HANDLED, CID, {})
    await waitMicrotasks()

    assert.strictEqual(mirrored(CID)?.height, 3)
    assert.ok(!('_journal' in (mirrored(CID) ?? {})), 'the journal must not reach the mirror')
  })

  it('drops the entry when the contract meta disappears', async () => {
    contractMetas()[CID] = makeMeta()
    looseRootState()[CID] = { _vm: { authorizedKeys: {} } }
    sbp('okTurtles.events/emit', EVENT_HANDLED, CID, {})
    await waitMicrotasks()
    assert.ok(mirrored(CID), 'the mirror should hold the contract first')

    // Permanent removal lands before the queued handler for a later event.
    contractMetas()[CID] = null
    delete looseRootState()[CID]
    sbp('okTurtles.events/emit', EVENT_HANDLED, CID, {})
    await waitMicrotasks()

    assert.ok(
      !(CID in (externalState.contracts ?? {})),
      'a removed contract must not leave a stale (truthy) entry behind'
    )
    assert.ok(!(CID in externalState), 'the contract state must be dropped too')
  })
})
