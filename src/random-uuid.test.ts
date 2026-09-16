import assert from 'node:assert'
import { describe, it } from 'node:test'

import { randomUUID } from './functions.js'
import { PersistentAction } from './persistent-actions.js'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Runs `fn` with `crypto.randomUUID` hidden, the way a browser leaves it on a
// plain http origin.
const withoutNative = <T>(fn: () => T): T => {
  const proto = Object.getPrototypeOf(globalThis.crypto)
  const native = proto.randomUUID
  delete proto.randomUUID
  try {
    return fn()
  } finally {
    proto.randomUUID = native
  }
}

describe('randomUUID', () => {
  it('uses the native one when there is one', () => {
    assert.match(randomUUID(), V4)
  })

  it('still returns a v4 UUID without a native one', () => {
    withoutNative(() => {
      assert.strictEqual(typeof globalThis.crypto.randomUUID, 'undefined')
      assert.match(randomUUID(), V4)
    })
  })

  // The bug this fixes: a persistent action could not even be built on a plain
  // http origin, so the first enqueue threw and the action was lost.
  it('lets a persistent action be built without a native one', () => {
    withoutNative(() => {
      assert.match(new PersistentAction(['log', 'hello']).id, V4)
    })
  })

  it('does not repeat itself', () => {
    const ids = withoutNative(() => new Set(Array.from({ length: 500 }, randomUUID)))
    assert.strictEqual(ids.size, 500)
  })
})
