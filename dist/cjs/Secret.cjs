"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Secret = void 0;
const serdes_1 = require("@chelonia/serdes");
/* Wrapper class for secrets, which identifies them as such and prevents them
from being logged */
// Use a `WeakMap` to store the actual secret outside of the returned `Secret`
// object. This ensures that the only way to access the secret is via the
// `.valueOf()` method, and it prevents accidentally logging things that
// shouldn't be logged.
const wm = new WeakMap();
class Secret {
    static [serdes_1.serdesDeserializeSymbol](secret) {
        return new this(secret);
    }
    static [serdes_1.serdesSerializeSymbol](secret) {
        return wm.get(secret);
    }
    static get [serdes_1.serdesTagSymbol]() {
        return '__chelonia_Secret';
    }
    constructor(value) {
        wm.set(this, value);
    }
    valueOf() {
        return wm.get(this);
    }
}
exports.Secret = Secret;
