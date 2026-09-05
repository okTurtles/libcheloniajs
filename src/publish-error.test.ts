import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { SPMessage } from './SPMessage.js'
import type { SPKey, SPOpContract, SPOpValue } from './SPMessage.js'
import { ChelErrorUnexpectedHttpResponseCode } from './errors.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import type { CheloniaConfig } from './types.js'

// A self-signed OP_CONTRACT, which is all `publishEvent` needs to get as far as
// POSTing to the relay. `skipActionProcessing` keeps `processMessage` from
// loading the manifest, so no contract source has to be served.
const firstMessage = (): SPMessage => {
  const CSK = keygen(EDWARDS25519SHA512BATCH)
  const payload: SPOpContract = {
    type: 'test/publish-error',
    keys: [{
      id: keyId(CSK),
      name: '#csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      allowedActions: '*',
      data: serializeKey(CSK, false),
      _notBeforeHeight: 0,
      _notAfterHeight: undefined
    } as SPKey]
  }
  return SPMessage.createV1_0({
    contractID: null,
    height: 0,
    op: [SPMessage.OP_CONTRACT, signedOutgoingDataWithRawKey<SPOpValue, object>(CSK, payload)],
    manifest: 'test-manifest'
  })
}

const configureWithResponse = (response: () => Response) => {
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    skipActionProcessing: true,
    fetch: async (_url: string, opts?: { method?: string }) => {
      return opts?.method === 'POST' ? response() : new Response('', { status: 404 })
    }
  } as Partial<CheloniaConfig>)
}

const publish = () => sbp('chelonia/private/out/publishEvent', firstMessage(), {}, {})

describe('publishEvent failure reporting', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

  // `_init` rebuilds the default config so the stubbed `fetch` cannot leak into
  // subsequently-imported test files.
  afterEach(() => {
    sbp('chelonia/_init')
  })

  // The regression this guards: the body used to be read with `r.json()`, so a
  // plain text error body (Hono's `HTTPException` default, which is what chel
  // sends) threw a SyntaxError and the status never reached the caller.
  it('reports the status for a plain text error body instead of a parse error', async () => {
    configureWithResponse(() => new Response('Registration disabled', {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'text/plain;charset=UTF-8' }
    }))

    await assert.rejects(publish, (e: Error) => {
      assert.ok(
        e instanceof ChelErrorUnexpectedHttpResponseCode,
        `expected ChelErrorUnexpectedHttpResponseCode but got ${e.name}: ${e.message}`
      )
      assert.strictEqual(e.message, 'publishEvent: 403: Forbidden - Registration disabled')
      // The status has to be reachable without parsing the message, so an app
      // can tell "signups are disabled" from "rate limited"
      assert.strictEqual(e.cause, 403)
      return true
    })
  })

  it('reads a JSON error body', async () => {
    configureWithResponse(() => new Response('{"message":"Rate limit exceeded"}', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json' }
    }))

    await assert.rejects(publish, (e: Error) => {
      assert.strictEqual(e.message, 'publishEvent: 429: Too Many Requests - Rate limit exceeded')
      assert.strictEqual(e.cause, 429)
      return true
    })
  })

  it('still reports the status when the body cannot be read', async () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      configureWithResponse(() => new Response('not json at all', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' }
      }))

      await assert.rejects(publish, (e: Error) => {
        assert.strictEqual(e.message, 'publishEvent: 500: Internal Server Error')
        assert.strictEqual(e.cause, 500)
        return true
      })
    } finally {
      console.warn = originalWarn
    }
  })

  it('reports the status after exhausting 409 retries', async () => {
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = () => {}
    console.error = () => {}
    try {
      configureWithResponse(() => new Response('', { status: 409, statusText: 'Conflict' }))

      await assert.rejects(
        () => sbp('chelonia/private/out/publishEvent', firstMessage(), { maxAttempts: 1 }, {}),
        (e: Error) => {
          assert.ok(e instanceof ChelErrorUnexpectedHttpResponseCode)
          assert.strictEqual(e.cause, 409)
          return true
        }
      )
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }
  })
})
