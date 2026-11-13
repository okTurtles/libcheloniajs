import assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import sbp from '@sbp/sbp'
import { ChelErrorSignatureKeyUnauthorized } from './errors.js'
import { signedIncomingData } from './signedData.js'

const STORE = 'state/vuex/state'
sbp('sbp/selectors/unsafe', [STORE])

const setStore = (state: (() => unknown) | null) => {
  if (sbp('sbp/selectors/fn', STORE)) sbp('sbp/selectors/unregister', [STORE])
  if (state) sbp('sbp/selectors/register', { [STORE]: state })
}

// Captures the loud-fail side effects (the rejection would fail this test
// file if it were left unhandled)
const verifyUnauthorized = () => {
  const logged: unknown[][] = []
  const rejected: unknown[] = []
  const { error } = console
  const { reject } = Promise
  console.error = (...args: unknown[]) => { logged.push(args) }
  Promise.reject = ((reason: unknown) => {
    rejected.push(reason)
    return Promise.resolve()
  }) as typeof Promise.reject
  let thrown: unknown
  try {
    signedIncomingData(
      'contractID',
      { _vm: { authorizedKeys: {} } },
      { _signedData: ['{}', 'unknownKeyId', 'signature'] },
      1,
      ''
    ).valueOf()
  } catch (e) {
    thrown = e
  } finally {
    console.error = error
    Promise.reject = reject
  }
  return { thrown, logged, rejected }
}

describe('Unauthorized signing key in CI', () => {
  let ci: string | undefined
  beforeEach(() => {
    ci = process.env.CI
    process.env.CI = 'true'
  })
  afterEach(() => {
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
    setStore(null)
  })

  it('throws the real error quietly when there is no host app store', () => {
    setStore(null)
    const { thrown, logged, rejected } = verifyUnauthorized()
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(logged.length, 0)
    assert.strictEqual(rejected.length, 0)
  })

  it('fails loudly in the host app\'s CI', () => {
    setStore(() => ({ a: 1 }))
    const { thrown, logged, rejected } = verifyUnauthorized()
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(logged.length, 1)
    assert.deepStrictEqual((logged[0][1] as { state: unknown }).state, { a: 1 })
    assert.strictEqual(rejected.length, 1)
    assert.ok(rejected[0] instanceof ChelErrorSignatureKeyUnauthorized)
  })

  it('logs a placeholder for an unserializable store', () => {
    const state: Record<string, unknown> = {}
    state.self = state
    setStore(() => state)
    const { thrown, logged, rejected } = verifyUnauthorized()
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual((logged[0][1] as { state: unknown }).state, '[unserializable]')
    assert.strictEqual(rejected.length, 1)
  })

  it('stays quiet outside CI', () => {
    delete process.env.CI
    setStore(() => ({ a: 1 }))
    const { thrown, logged, rejected } = verifyUnauthorized()
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(logged.length, 0)
    assert.strictEqual(rejected.length, 0)
  })
})
