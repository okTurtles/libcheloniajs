import assert from 'node:assert'
import { describe, it } from 'node:test'

import type { UUIDV4 } from './types.js'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Bumped per import so two calls in the same millisecond still get separate
// copies of the module.
let count = 0

// `functions.js` decides once, at import, whether to use the native
// `crypto.randomUUID`. So reaching the other branch means changing `crypto`
// first and then loading a fresh copy; the query string is what makes it fresh.
//
// `body` runs while `crypto.randomUUID` is still replaced, which matters: the
// fallback closure would otherwise be able to reach the real method again and
// the test would pass for the wrong reason.
const withRandomUUID = async (
  impl: (() => UUIDV4) | undefined,
  body: (randomUUID: () => UUIDV4) => void
): Promise<void> => {
  const proto = Object.getPrototypeOf(globalThis.crypto)
  const original = Object.getOwnPropertyDescriptor(proto, 'randomUUID')!
  Object.defineProperty(proto, 'randomUUID', { value: impl, configurable: true })
  try {
    const fresh = await import(`./functions.js?uuid-test=${Date.now()}-${count++}`)
    body((fresh as { randomUUID: () => UUIDV4 }).randomUUID)
  } finally {
    Object.defineProperty(proto, 'randomUUID', original)
  }
}

describe('randomUUID', () => {
  // A valid UUID alone would not prove this, since the fallback returns one
  // too. Only a sentinel shows the native method is really being called.
  it('hands off to the native one when there is one', async () => {
    const sentinel = '00000000-0000-4000-8000-000000000000' as UUIDV4
    await withRandomUUID(() => sentinel, (randomUUID) => {
      assert.strictEqual(randomUUID(), sentinel)
    })
  })

  it('still returns a v4 UUID without a native one', async () => {
    await withRandomUUID(undefined, (randomUUID) => {
      assert.match(randomUUID(), V4)
    })
  })

  it('does not repeat itself without a native one', async () => {
    await withRandomUUID(undefined, (randomUUID) => {
      assert.strictEqual(new Set(Array.from({ length: 500 }, randomUUID)).size, 500)
    })
  })
})
