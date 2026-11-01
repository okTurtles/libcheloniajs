import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvConflict,
  ChelErrorKvHeightAhead,
  ChelErrorKvHeightMalformed,
  ChelErrorKvValidation,
  findErrorCause,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import { ChelErrorKvMaxAttempts, isKvMaxAttempts } from './internal-errors.js'
import type { KvHeightAheadCause } from './types.js'

const predicates = { isKvHeightAhead, isKvHeightMalformed, isKvConflict, isKvMaxAttempts }

const foreignError = (name: string): unknown =>
  runInNewContext('const e = new Error("foreign"); e.name = name; e', { name })

const wrap = (cause: unknown) => new ChelErrorKvValidation('wrapper', { cause })

const cause: KvHeightAheadCause = {
  requiredHeight: 7, exact: true, localHeight: 5, etag: 'etag', httpStatus: 200
}

// A failed check must not narrow an `Error` to `never` (checked by tsc).
function describeError (e: Error): string {
  if (isKvHeightAhead(e)) return `ahead ${e.cause?.requiredHeight}`
  if (isKvHeightMalformed(e)) return 'malformed'
  if (isKvConflict(e)) return `conflict ${e.cause?.currentStatus}`
  return e.message
}

describe('KV error predicates', () => {
  it('match errors of their own class', () => {
    assert.ok(isKvHeightAhead(new ChelErrorKvHeightAhead('x')))
    assert.ok(isKvHeightMalformed(new ChelErrorKvHeightMalformed('x')))
    assert.ok(isKvConflict(new ChelErrorKvConflict('x')))
    assert.ok(isKvConflict(new ChelErrorKvMaxAttempts('x')))
    assert.ok(isKvMaxAttempts(new ChelErrorKvMaxAttempts('x')))
    assert.ok(!isKvMaxAttempts(new ChelErrorKvConflict('x')))
  })

  it('height errors keep the old class but have their own names', () => {
    const ahead = new ChelErrorKvHeightAhead('x', { cause })
    const malformed = new ChelErrorKvHeightMalformed('x')
    assert.ok(ahead instanceof ChelErrorInvalidMessageHeight)
    assert.ok(malformed instanceof ChelErrorInvalidMessageHeight)
    assert.strictEqual(ahead.name, 'ChelErrorKvHeightAhead')
    assert.strictEqual(malformed.name, 'ChelErrorKvHeightMalformed')
    assert.ok(!isKvHeightMalformed(ahead) && !isKvConflict(ahead))
    assert.ok(!isKvHeightAhead(malformed) && !isKvConflict(malformed))
  })

  it('match errors from another realm and plain { name, message } objects', () => {
    const matches: Array<[string, (e: unknown) => boolean]> = [
      ['ChelErrorKvHeightAhead', isKvHeightAhead],
      ['ChelErrorKvHeightMalformed', isKvHeightMalformed],
      ['ChelErrorKvConflict', isKvConflict],
      ['ChelErrorKvMaxAttempts', isKvConflict],
      ['ChelErrorKvMaxAttempts', isKvMaxAttempts]
    ]
    for (const [name, predicate] of matches) {
      const foreign = foreignError(name)
      assert.ok(!(foreign instanceof Error))
      assert.ok(predicate(foreign), `${predicate.name}(foreign ${name})`)
      assert.ok(predicate({ name, message: '' }), `${predicate.name}({ name: ${name} })`)
    }
  })

  it('reject other errors and non-objects', () => {
    const others: unknown[] = [
      new ChelErrorInvalidMessageHeight('x'), new Error('x'), { name: 'ChelErrorKvConflictish' },
      'ChelErrorKvHeightAhead', function ChelErrorKvConflict () {}, null, undefined, 0
    ]
    for (const e of others) {
      for (const [name, predicate] of Object.entries(predicates)) {
        assert.ok(!predicate(e), `${name}(${String(e)})`)
      }
      assert.strictEqual(kvHeightAheadCause(e), undefined)
    }
  })

  it('check only the error itself, not its causes', () => {
    const wrapped = [
      new ChelErrorKvHeightAhead('x', { cause }), new ChelErrorKvHeightMalformed('x'),
      new ChelErrorKvConflict('x'), new ChelErrorKvMaxAttempts('x')
    ].map(wrap)
    for (const e of wrapped) {
      for (const [name, predicate] of Object.entries(predicates)) {
        assert.ok(!predicate(e), name)
      }
      assert.strictEqual(kvHeightAheadCause(e), undefined)
    }
  })

  it('narrow to the matched error and keep an Error intact otherwise', () => {
    assert.strictEqual(describeError(new ChelErrorKvHeightAhead('x', { cause })), 'ahead 7')
    assert.strictEqual(describeError(new ChelErrorKvHeightMalformed('x')), 'malformed')
    assert.strictEqual(
      describeError(new ChelErrorKvConflict('x', { cause: { currentStatus: 'ahead' } })),
      'conflict ahead'
    )
    assert.strictEqual(describeError(new Error('plain')), 'plain')
  })
})

describe('kvHeightAheadCause', () => {
  it('returns the cause of a height-ahead error, also from another realm', () => {
    assert.deepStrictEqual(kvHeightAheadCause(new ChelErrorKvHeightAhead('x', { cause })), cause)
    const foreign = Object.assign(foreignError('ChelErrorKvHeightAhead') as object, { cause })
    assert.deepStrictEqual(kvHeightAheadCause(foreign), cause)
  })

  it('returns undefined when the cause is missing or not an object', () => {
    assert.strictEqual(kvHeightAheadCause(new ChelErrorKvHeightAhead('x')), undefined)
    assert.strictEqual(kvHeightAheadCause(new ChelErrorKvHeightAhead('x', { cause: 7 })), undefined)
    assert.strictEqual(kvHeightAheadCause({ name: 'ChelErrorKvHeightAhead', message: '' }), undefined)
    assert.strictEqual(kvHeightAheadCause(new ChelErrorKvConflict('x', { cause })), undefined)
  })
})

describe('findErrorCause', () => {
  it('finds the error itself or one wrapped in causes, also from another realm', () => {
    const ahead = new ChelErrorKvHeightAhead('x', { cause })
    assert.strictEqual(findErrorCause(ahead, isKvHeightAhead), ahead)
    assert.strictEqual(findErrorCause(wrap(wrap(ahead)), isKvHeightAhead), ahead)
    const foreign = foreignError('ChelErrorKvConflict')
    assert.strictEqual(findErrorCause(wrap(foreign), isKvConflict), foreign)
    assert.strictEqual(findErrorCause(wrap(ahead), isKvConflict), undefined)
  })

  it('checks at most maxDepth errors, the first one included', () => {
    const ahead = new ChelErrorKvHeightAhead('x')
    assert.strictEqual(findErrorCause(wrap(wrap(ahead)), isKvHeightAhead, 2), undefined)
    assert.strictEqual(findErrorCause(wrap(wrap(ahead)), isKvHeightAhead, 3), ahead)
    assert.strictEqual(findErrorCause(ahead, isKvHeightAhead, 0), undefined)
  })

  it('stops on a cycle and on a cause that is not an object', () => {
    const cyclic = new Error('cyclic')
    cyclic.cause = cyclic
    assert.strictEqual(findErrorCause(cyclic, isKvConflict), undefined)
    assert.strictEqual(
      findErrorCause(wrap('ChelErrorKvConflict'), (e): e is string => typeof e === 'string'),
      undefined
    )
    assert.strictEqual(findErrorCause(undefined, isKvConflict), undefined)
  })
})

describe('package root', () => {
  it('exports the KV error helpers but none of the internal ones', async () => {
    const root = await import('./index.js')
    for (const name of [
      'ChelErrorKvHeightAhead', 'ChelErrorKvHeightMalformed', 'isKvHeightAhead',
      'isKvHeightMalformed', 'isKvConflict', 'kvHeightAheadCause', 'findErrorCause'
    ]) {
      assert.ok(name in root, name)
    }
    for (const name of [
      'hasErrorName', 'isKvMaxAttempts', 'ChelErrorKvMaxAttempts', 'resolveKvKeyIds',
      'assertMaxAttempts', 'resolveRecoveryOptions', 'withHeightRecovery', 'recoverContractHeight',
      'assertNotReentrant'
    ]) {
      assert.ok(!(name in root), name)
    }
  })
})
