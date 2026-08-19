import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import { ChelErrorUnexpected, ChelErrorUnexpectedHttpResponseCode } from './errors.js'
import { createCID, multicodes } from './functions.js'
import type { CheloniaConfig } from './types.js'

type FetchOptions = { cache?: string; signal?: AbortSignal };

// Built with the real hasher so the fixture can't drift from the CID
// validation done by the selector.
const CONTRACT_ID = createCID('name-lookup-fixture', multicodes.SHELTER_CONTRACT_DATA)

const configureWithFetch = (
  fetchImpl: (url: string, opts?: FetchOptions) => Promise<Response>
) => {
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    fetch: fetchImpl
  } as Partial<CheloniaConfig>)
}

describe('chelonia/out/nameToContractID', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

  // `_init` rebuilds the default config (fetch passthrough, unset
  // connectionURL), so the stubbed `fetch` cannot leak into
  // subsequently-imported test files. Within this file the next test's
  // beforeEach would do this anyway; this call only matters after the
  // final test. (A snapshot/restore via `chelonia/config` isn't possible:
  // it deep-clones the config, which throws on a fresh one because the
  // default `connectionURL` is a throwing getter.)
  afterEach(() => {
    sbp('chelonia/_init')
  })

  it('resolves a registered name to a contract ID', async () => {
    const contractID = CONTRACT_ID
    const seen: Array<{ url: string; cache?: string; hasSignal: boolean }> = []
    configureWithFetch(async (url, opts) => {
      seen.push({ url, cache: opts?.cache, hasSignal: !!opts?.signal })
      return new Response(contractID, { status: 200 })
    })

    const result = await sbp('chelonia/out/nameToContractID', 'alice')
    assert.strictEqual(result, contractID)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].url, 'https://example.test/name/alice')
    assert.strictEqual(seen[0].cache, 'no-store')
    assert.ok(seen[0].hasSignal)
  })

  it('percent-encodes names with reserved characters', async () => {
    const seen: string[] = []
    configureWithFetch(async (url) => {
      seen.push(url)
      return new Response(CONTRACT_ID, { status: 200 })
    })

    await sbp('chelonia/out/nameToContractID', 'alice smith/bob?x=1&y=2')
    assert.deepStrictEqual(seen, [
      'https://example.test/name/alice%20smith%2Fbob%3Fx%3D1%26y%3D2'
    ])
  })

  it('returns null when the name is not registered (404)', async () => {
    configureWithFetch(async () => new Response('Not Found', { status: 404 }))

    const result = await sbp('chelonia/out/nameToContractID', 'mallory')
    assert.strictEqual(result, null)
  })

  it('returns null when the mapping was deleted (410)', async () => {
    configureWithFetch(async () => new Response('Gone', {
      status: 410,
      statusText: 'Gone'
    }))

    const result = await sbp('chelonia/out/nameToContractID', 'alice')
    assert.strictEqual(result, null)
  })

  it('returns null when the name is malformed (400)', async () => {
    configureWithFetch(async () => new Response('Bad Request', {
      status: 400,
      statusText: 'Bad Request'
    }))

    const result = await sbp('chelonia/out/nameToContractID', 'a')
    assert.strictEqual(result, null)
  })

  it('throws on a 400 when throwOnInvalidName is set', async () => {
    configureWithFetch(async () => new Response('Bad Request', {
      status: 400,
      statusText: 'Bad Request'
    }))

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', 'a', { throwOnInvalidName: true }),
      (e: unknown) =>
        e instanceof ChelErrorUnexpectedHttpResponseCode &&
        e.message === '400: Bad Request' &&
        e.cause === 400
    )
  })

  it('still returns null on 404 / 410 when throwOnInvalidName is set', async () => {
    for (const status of [404, 410]) {
      configureWithFetch(async () => new Response('', { status }))

      const result = await sbp(
        'chelonia/out/nameToContractID', 'alice', { throwOnInvalidName: true }
      )
      assert.strictEqual(result, null)
    }
  })

  it('trims whitespace around the returned contract ID', async () => {
    const contractID = CONTRACT_ID
    configureWithFetch(async () => new Response(`\n  ${contractID}  \n`, {
      status: 200
    }))

    const result = await sbp('chelonia/out/nameToContractID', 'alice')
    assert.strictEqual(result, contractID)
  })

  it('returns null for an empty 200 body', async () => {
    configureWithFetch(async () => new Response('', { status: 200 }))

    const result = await sbp('chelonia/out/nameToContractID', 'alice')
    assert.strictEqual(result, null)
  })

  it('throws ChelErrorUnexpectedHttpResponseCode on other failed statuses', async () => {
    configureWithFetch(async () => new Response('Internal Server Error', {
      status: 500,
      statusText: 'Internal Server Error'
    }))

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', 'alice'),
      (e: unknown) =>
        e instanceof ChelErrorUnexpectedHttpResponseCode &&
        e.message === '500: Internal Server Error' &&
        e.cause === 500
    )
  })

  it('throws a TypeError when no name is provided', async () => {
    configureWithFetch(async () => new Response('', { status: 200 }))

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', ''),
      TypeError
    )
  })

  it('returns null for dot-only names without sending a request', async () => {
    for (const name of ['.', '..']) {
      let called = 0
      configureWithFetch(async () => {
        called++
        return new Response(CONTRACT_ID, { status: 200 })
      })

      const result = await sbp('chelonia/out/nameToContractID', name)
      assert.strictEqual(result, null)
      assert.strictEqual(called, 0)
    }
  })

  it('throws on dot-only names when throwOnInvalidName is set', async () => {
    let called = 0
    configureWithFetch(async () => {
      called++
      return new Response(CONTRACT_ID, { status: 200 })
    })

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', '..', { throwOnInvalidName: true }),
      (e: unknown) =>
        e instanceof ChelErrorUnexpectedHttpResponseCode &&
        e.message === '400: invalid name ..' &&
        e.cause === 400
    )
    assert.strictEqual(called, 0)
  })

  it('throws when a 200 body is not a CID', async () => {
    configureWithFetch(async () => new Response('<html>hello</html>', { status: 200 }))

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', 'alice'),
      ChelErrorUnexpected
    )
  })

  it('throws when a 200 body is a CID with the wrong multicodec', async () => {
    const rawCID = createCID('name-lookup-fixture', multicodes.RAW)
    configureWithFetch(async () => new Response(rawCID, { status: 200 }))

    await assert.rejects(
      () => sbp('chelonia/out/nameToContractID', 'alice'),
      ChelErrorUnexpected
    )
  })
})
