"use strict";
// Internal: the name check behind the realm-safe error predicates of
// `src/errors.ts` and `src/internal-errors.ts`. Not re-exported from
// `src/index.ts`, and registers no selectors.
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasErrorName = hasErrorName;
// Whether `e` is an object whose `name` is one of `names`. Name-based, so it
// matches errors created by another loaded copy of the library (dual
// ESM/CJS builds, bundles, other realms), where `instanceof` fails, and plain
// `{ name, message }` objects such as a slot's `lastError`.
function hasErrorName(e, ...names) {
    return !!e && typeof e === 'object' && names.includes(e.name);
}
