import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { isValidName } from './names.js'

describe('isValidName', () => {
  it('accepts names the relay can register', () => {
    const names = [
      'a', 'alice', 'alice-smith', 'alice_smith', 'alice42', '42', 'a_-b', 'a'.repeat(80)
    ]
    for (const name of names) {
      assert.strictEqual(isValidName(name), true, name)
    }
  })

  it('rejects names the relay answers with a 400', () => {
    const names = [
      '', 'Alice', 'alice smith', 'alice.smith', 'alice!', 'ålice', 'alice\n', '.', '..',
      '-alice', 'alice-', '_alice', 'alice_', 'a--b', 'a__b', 'a'.repeat(81)
    ]
    for (const name of names) {
      assert.strictEqual(isValidName(name), false, JSON.stringify(name))
    }
  })

  it('rejects values that are not strings', () => {
    for (const name of [undefined, null, 42, ['alice'], { toString: () => 'alice' }]) {
      assert.strictEqual(isValidName(name as unknown as string), false, String(name))
    }
  })
})
