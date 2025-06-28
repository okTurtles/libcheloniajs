import { serdesDeserializeSymbol, serdesSerializeSymbol, serdesTagSymbol } from '@chelonia/serdes'

/* Wrapper class for secrets, which identifies them as such and prevents them
from being logged */

// Use a `WeakMap` to store the actual secret outside of the returned `Secret`
// object. This ensures that the only way to access the secret is via the
// `.valueOf()` method, and it prevents accidentally logging things that
// shouldn't be logged.
const wm = new WeakMap()
export class Secret<T> {
  static [serdesDeserializeSymbol] <T> (secret: T) {
    return new this(secret)
  }

  static [serdesSerializeSymbol] <T> (secret: Secret<T>) {
    return wm.get(secret)
  }

  static get [serdesTagSymbol] () {
    return '__chelonia_Secret'
  }

  constructor (value: T) {
    wm.set(this, value)
  }

  valueOf (): T {
    return wm.get(this)
  }
}
