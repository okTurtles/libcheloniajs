import assert from 'node:assert'
import { describe, it } from 'node:test'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// This file is on its own because the check below only means something while
// `functions.js` has not been loaded yet: it settles on an implementation at
// import, so a copy loaded earlier would already be bound to the native
// `crypto.randomUUID` and the fallback would never run. `npm test` gives every
// test file its own process, so nothing here has loaded it.
//
// Nothing above this line may import `./functions.js` or `./persistent-actions.js`.
describe('PersistentAction without a native crypto.randomUUID', () => {
  // The bug: on a plain http origin there is no native method, so building an
  // action threw and the first enqueue lost it. If `persistent-actions.ts` went
  // back to calling `crypto.randomUUID()` itself, the constructor below would
  // throw rather than return an id.
  it('still gets an id', async () => {
    const proto = Object.getPrototypeOf(globalThis.crypto)
    const original = Object.getOwnPropertyDescriptor(proto, 'randomUUID')!
    Object.defineProperty(proto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const { PersistentAction } = await import('./persistent-actions.js')
      assert.match(new PersistentAction(['log', 'hello']).id, V4)
    } finally {
      Object.defineProperty(proto, 'randomUUID', original)
    }
  })
})
