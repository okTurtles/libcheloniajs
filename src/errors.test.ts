// The name-based KV error predicates. Registers no SBP selectors.

import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvConflict,
  ChelErrorKvHeightAhead,
  ChelErrorKvHeightMalformed,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import { ChelErrorKvMaxAttempts, isKvMaxAttempts } from './internal-errors.js'

// An `Error` named `name`, created in another realm (as by another copy of
// the library loaded in an iframe or a `vm` context): `instanceof` fails.
const foreignError = (name: string): unknown => vm.runInNewContext(
  `const e = new Error('foreign'); e.name = ${JSON.stringify(name)}; e`
)

// Type-level checks (`tsc -p tsconfig.json` compiles this file): a guard
// that fails narrows its argument to `never` unless the guard names its
// type, so that `e.message` would not compile after it.
const conflictThenMessage = (e: Error): string => {
  if (isKvConflict(e)) return 'conflict'
  return e.message
}
const heightAheadThenMessage = (e: Error): string => {
  if (isKvHeightAhead(e)) return 'ahead'
  return e.message
}
const malformedThenMessage = (e: Error): string => {
  if (isKvHeightMalformed(e)) return 'malformed'
  return e.message
}
const maxAttemptsThenMessage = (e: Error): string => {
  if (isKvMaxAttempts(e)) return 'max attempts'
  return e.message
}

describe('KV error predicates', () => {
  it('match errors from this copy of the library', () => {
    assert.strictEqual(isKvHeightAhead(new ChelErrorKvHeightAhead('x')), true)
    assert.strictEqual(isKvHeightMalformed(new ChelErrorKvHeightMalformed('x')), true)
    assert.strictEqual(isKvConflict(new ChelErrorKvConflict('x')), true)
    assert.strictEqual(isKvConflict(new ChelErrorKvMaxAttempts('x')), true)
    assert.strictEqual(isKvMaxAttempts(new ChelErrorKvMaxAttempts('x')), true)
  })

  it('match errors from another realm, where instanceof fails', () => {
    const ahead = foreignError('ChelErrorKvHeightAhead')
    const malformed = foreignError('ChelErrorKvHeightMalformed')
    const conflict = foreignError('ChelErrorKvConflict')
    const maxAttempts = foreignError('ChelErrorKvMaxAttempts')
    assert.strictEqual(ahead instanceof Error, false)
    assert.strictEqual(isKvHeightAhead(ahead), true)
    assert.strictEqual(isKvHeightMalformed(malformed), true)
    assert.strictEqual(isKvConflict(conflict), true)
    assert.strictEqual(isKvConflict(maxAttempts), true)
    assert.strictEqual(isKvMaxAttempts(maxAttempts), true)
  })

  it("match plain { name, message } objects, such as a slot's lastError", () => {
    const lastError = (name: string) => ({ name, message: 'stored' })
    assert.strictEqual(isKvHeightAhead(lastError('ChelErrorKvHeightAhead')), true)
    assert.strictEqual(kvHeightAheadCause(lastError('ChelErrorKvHeightAhead')), undefined)
    assert.strictEqual(isKvHeightMalformed(lastError('ChelErrorKvHeightMalformed')), true)
    assert.strictEqual(isKvConflict(lastError('ChelErrorKvConflict')), true)
    assert.strictEqual(isKvMaxAttempts(lastError('ChelErrorKvMaxAttempts')), true)
  })

  it('reject other errors and non-objects', () => {
    const others: unknown[] = [
      new ChelErrorInvalidMessageHeight('x'),
      new Error('x'),
      { name: 'ChelErrorKvConflictish' },
      'ChelErrorKvHeightAhead',
      null,
      undefined,
      0
    ]
    for (const other of others) {
      assert.strictEqual(isKvHeightAhead(other), false)
      assert.strictEqual(isKvHeightMalformed(other), false)
      assert.strictEqual(isKvConflict(other), false)
      assert.strictEqual(isKvMaxAttempts(other), false)
      assert.strictEqual(kvHeightAheadCause(other), undefined)
    }
  })

  it("don't mistake a value that is ahead for a malformed one, or the reverse", () => {
    const ahead = new ChelErrorKvHeightAhead('x')
    const malformed = new ChelErrorKvHeightMalformed('x')
    // Both still extend the class they had before, for `instanceof`.
    assert.ok(ahead instanceof ChelErrorInvalidMessageHeight)
    assert.ok(malformed instanceof ChelErrorInvalidMessageHeight)
    assert.strictEqual(isKvHeightMalformed(ahead), false)
    assert.strictEqual(isKvHeightAhead(malformed), false)
    assert.strictEqual(malformed.name, 'ChelErrorKvHeightMalformed')
  })

  it("kvHeightAheadCause reads the error's cause", () => {
    const cause = { requiredHeight: 42, exact: true }
    assert.deepStrictEqual(
      kvHeightAheadCause(new ChelErrorKvHeightAhead('x', { cause })), cause
    )
    assert.strictEqual(kvHeightAheadCause(new ChelErrorKvHeightAhead('x')), undefined)
  })

  it('narrow to their names, so that an Error keeps its members after a failed check', () => {
    const plain = new Error('plain')
    assert.strictEqual(conflictThenMessage(plain), 'plain')
    assert.strictEqual(heightAheadThenMessage(plain), 'plain')
    assert.strictEqual(malformedThenMessage(plain), 'plain')
    assert.strictEqual(maxAttemptsThenMessage(plain), 'plain')
    assert.strictEqual(conflictThenMessage(new ChelErrorKvConflict('x')), 'conflict')
    assert.strictEqual(heightAheadThenMessage(new ChelErrorKvHeightAhead('x')), 'ahead')
    assert.strictEqual(malformedThenMessage(new ChelErrorKvHeightMalformed('x')), 'malformed')
    assert.strictEqual(maxAttemptsThenMessage(new ChelErrorKvMaxAttempts('x')), 'max attempts')
  })
})
