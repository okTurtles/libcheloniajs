// Tests for the CI-only diagnostics of signature verification
// (`verifySignatureData` in `src/signedData.ts`). When `CI` is set and the
// host app registers `state/vuex/state` (Group Income's integration tests),
// a signature by an unauthorized key logs the app state and leaves an
// unhandled rejection behind, to make Cypress fail. Anywhere else (this
// library's own tests on a CI service, other apps), verification must just
// throw `ChelErrorSignatureKeyUnauthorized`. A state that can't be
// serialized must not replace the real error either.
//
// Runs in its own process. The tests that need `state/vuex/state` register
// it, and it is unregistered after each test, so that the tests pass in any
// order (e.g. with `--test-randomize`).

import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { ChelErrorSignatureKeyUnauthorized } from './errors.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'

const CONTRACT_ID = 'zSignedDataCiContract'
const KEY = 'profile'

// A value signed at height 40 by a key that was revoked at height 5.
const readRevokedKeyValue = (): (() => unknown) => {
  const rootState = sbp('chelonia/private/state') as Record<string, unknown> & {
    contracts: Record<string, unknown>
  }
  rootState.contracts[CONTRACT_ID] = { HEAD: 'h40', height: 40, previousKeyOp: '', type: 'test' }
  const revoked = keygen(EDWARDS25519SHA512BATCH)
  const revokedId = keyId(revoked)
  rootState[CONTRACT_ID] = {
    _vm: {
      authorizedKeys: {
        [revokedId]: {
          id: revokedId,
          name: 'old-device-csk',
          purpose: ['sig'],
          ringLevel: 0,
          permissions: '*',
          data: serializeKey(revoked, false),
          _notBeforeHeight: 0,
          _notAfterHeight: 5
        }
      }
    }
  }
  const serializedData = {
    ...signedOutgoingDataWithRawKey(revoked, { displayName: 'mallory' }).serialize(KEY + '40'),
    height: '40'
  }
  return () => sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
    contractID: CONTRACT_ID, serializedData, meta: KEY
  }).data
}

// Runs `fn` and reports what it threw and which promise rejections were left
// unhandled meanwhile (instead of letting the test runner fail the test).
const capture = async (fn: () => unknown) => {
  const rejections: unknown[] = []
  const listeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason) => { rejections.push(reason) })
  let thrown: unknown
  try {
    try {
      fn()
    } catch (e) {
      thrown = e
    }
    // Unhandled rejections are reported once the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of listeners) process.on('unhandledRejection', listener)
  }
  return { thrown, rejections }
}

const originalCI = process.env.CI
const originalError = console.error
let errors: unknown[][]

// What the host app's `state/vuex/state` returns. Like an app's store, it
// reads the state through its SBP domain's `this`, and a filter counts its
// calls: the diagnostics must call it through `sbp`. The selectors are
// unsafe, so that `afterEach` can unregister them. The filter is added once:
// filters can't be removed, and it outlives the registrations.
const APP_STATE_SELECTORS = ['state/_init', 'state/vuex/state']
sbp('sbp/selectors/unsafe', APP_STATE_SELECTORS)
let appState: unknown
let appStateCalls = 0
sbp('sbp/filters/selector/add', 'state/vuex/state', () => { appStateCalls++ })
const useAppState = (state: unknown) => {
  appState = state
  // SBP warns when an unsafe selector is registered: expected here.
  const { warn } = console
  console.warn = () => {}
  try {
    sbp('sbp/selectors/register', {
      'state/_init': function (this: { read?: () => unknown }) { this.read = () => appState },
      'state/vuex/state': function (this: { read: () => unknown }) { return this.read() }
    })
  } finally {
    console.warn = warn
  }
}

// The library's own messages: Node may also log warnings through
// `console.error` (e.g. a deprecation warning), at any time.
const libraryErrors = () => errors.filter((args) =>
  /^\[chelonia\] |is unauthorized or expired/.test(String(args[0]))
)

describe('signature verification with an unauthorized key', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
    errors = []
    console.error = (...args: unknown[]) => { errors.push(args) }
  })

  afterEach(() => {
    console.error = originalError
    sbp('sbp/selectors/unregister', APP_STATE_SELECTORS)
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
  })

  it('throws ChelErrorSignatureKeyUnauthorized', async () => {
    delete process.env.CI
    const { thrown, rejections } = await capture(readRevokedKeyValue())
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.deepStrictEqual(rejections, [])
  })

  it('throws the same error under CI when the host app has no state selector', async () => {
    process.env.CI = 'true'
    const { thrown, rejections } = await capture(readRevokedKeyValue())
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.deepStrictEqual(rejections, [])
    assert.deepStrictEqual(libraryErrors(), [])
  })

  it('logs the app state and leaves a rejection under CI when the host app has one', async () => {
    useAppState({ app: 'state' })
    process.env.CI = 'true'
    const callsBefore = appStateCalls
    const { thrown, rejections } = await capture(readRevokedKeyValue())
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(rejections.length, 1)
    assert.ok(rejections[0] instanceof ChelErrorSignatureKeyUnauthorized)
    const logged = libraryErrors()
    assert.strictEqual(logged.length, 1)
    assert.deepStrictEqual((logged[0][1] as { state: unknown }).state, { app: 'state' })
    assert.strictEqual(appStateCalls, callsBefore + 1)
  })

  // `JSON.parse(JSON.stringify(state))` throws for each of these.
  const circular: Record<string, unknown> = {}
  circular.self = circular
  for (const [label, state] of [
    ['undefined', undefined], ['circular', circular], ['BigInt', { n: BigInt(1) }]
  ] as const) {
    it(`still throws the real error under CI when the app state is ${label}`, async () => {
      useAppState(state)
      process.env.CI = 'true'
      const { thrown, rejections } = await capture(readRevokedKeyValue())
      assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
      assert.strictEqual(rejections.length, 1)
      assert.ok(rejections[0] instanceof ChelErrorSignatureKeyUnauthorized)
      const logged = libraryErrors()
      assert.strictEqual(logged.length, 2)
      assert.match(String(logged[0][0]), /could not serialize the app state/)
      // The diagnostic itself is still logged, without the state.
      assert.match(String(logged[1][0]), /is unauthorized or expired/)
      const details = logged[1][1] as { designatedKey?: unknown; height?: unknown; state: unknown }
      assert.strictEqual(details.state, '[unserializable]')
      assert.ok('designatedKey' in details && 'height' in details)
    })
  }
})
