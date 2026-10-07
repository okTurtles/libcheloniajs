import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import { isValidUsername } from './names.js'

describe('isValidUsername', () => {
  it('accepts usernames the relay can register', () => {
    const usernames = [
      'a', 'alice', 'alice-smith', 'alice_smith', 'alice42', '42', 'a_-b', 'a'.repeat(80)
    ]
    for (const username of usernames) {
      assert.strictEqual(isValidUsername(username), true, username)
    }
  })

  it('rejects usernames the relay answers with a 400', () => {
    const usernames = [
      '', 'Alice', 'alice smith', 'alice.smith', 'alice!', 'ålice', 'alice\n', '.', '..',
      '-alice', 'alice-', '_alice', 'alice_', 'a--b', 'a__b', 'a'.repeat(81)
    ]
    for (const username of usernames) {
      assert.strictEqual(isValidUsername(username), false, JSON.stringify(username))
    }
  })

  it('rejects values that are not strings', () => {
    for (const username of [undefined, null, 42, ['alice'], { toString: () => 'alice' }]) {
      assert.strictEqual(isValidUsername(username as unknown as string), false, String(username))
    }
  })
})
