// Tests for the CI-only diagnostics of signature verification
// (`verifySignatureData` in `src/signedData.ts`). When `CI` is set and the
// host app registers `state/vuex/state` (Group Income's integration tests),
// a signature by an unauthorized key logs the app state and leaves an
// unhandled rejection behind, to make Cypress fail. Anywhere else (this
// library's own tests on a CI service, other apps), verification must just
// throw `ChelErrorSignatureKeyUnauthorized`.
//
// Runs in its own process: the tests after the first two register
// `state/vuex/state`. A state that can't be serialized must not replace the
// real error either.

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

// What the host app's `state/vuex/state` returns. SBP keeps the first
// registration of a selector, so it is registered once, by the first test
// that needs it, and reads this variable.
let appState: unknown
let appStateRegistered = false
const useAppState = (state: unknown) => {
  appState = state
  if (appStateRegistered) return
  sbp('sbp/selectors/register', { 'state/vuex/state': () => appState })
  appStateRegistered = true
}

describe('signature verification with an unauthorized key', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
    errors = []
    console.error = (...args: unknown[]) => { errors.push(args) }
  })

  afterEach(() => {
    console.error = originalError
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
    assert.deepStrictEqual(errors, [])
  })

  it('logs the app state and leaves a rejection under CI when the host app has one', async () => {
    useAppState({ app: 'state' })
    process.env.CI = 'true'
    const { thrown, rejections } = await capture(readRevokedKeyValue())
    assert.ok(thrown instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(rejections.length, 1)
    assert.ok(rejections[0] instanceof ChelErrorSignatureKeyUnauthorized)
    assert.strictEqual(errors.length, 1)
    assert.deepStrictEqual((errors[0][1] as { state: unknown }).state, { app: 'state' })
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
      assert.strictEqual(errors.length, 1)
      assert.match(String(errors[0][0]), /could not serialize the app state/)
    })
  }
})
