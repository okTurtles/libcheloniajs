// Aggregate test runner.
//
// Import order matters here. `src/chelonia.ts` calls
// `sbp('sbp/domains/lock', ['chelonia'])` at module top-level, which
// permanently locks the `chelonia` SBP domain. Any subsequent
// `sbp/selectors/register` call against `chelonia/*` is silently
// dropped with a "[SBP WARN]: not registering selector on locked
// domain" warning, so test files that register `chelonia/*` selectors
// MUST be imported before any file that transitively pulls in
// `src/chelonia.ts`.
//
// Concretely:
//   - `local-selectors/index.test.ts` registers
//     `chelonia/contract/fullState` as a stub and depends on
//     `chelonia/externalStateSetup` being registered on an unlocked
//     domain, so it must be imported first (alongside other tests
//     that don't pull in `chelonia.ts`).
//   - `journal-integration.test.ts` imports `./chelonia.js` directly
//     and is the first test in this list to lock the domain.
//
// Each block below is separated by a blank line; the comment above
// each block records the constraint that pins its placement.

// Pure-unit tests that do not load chelonia.ts. Safe to run first.
import './encryptedData.test.js'

// MUST run before journal-integration.test.ts: registers stub
// `chelonia/contract/fullState` and exercises
// `chelonia/externalStateSetup`, both of which require the `chelonia`
// SBP domain to be unlocked.
import './local-selectors/index.test.js'

// Journal unit tests — pull in journal.ts but not chelonia.ts.
import './journal.test.js'

// First test that imports `./chelonia.js` (transitively locks the
// `chelonia` SBP domain). Everything after this point cannot register
// `chelonia/*` selectors.
import './journal-integration.test.js'
import './chelonia-kv-set.test.js'

import './persistent-actions.test.js'
import './pubsub/index.test.js'
import './reingestTracker.test.js'
import './reingestTracker-integration.test.js'
import './utils.test.js'
