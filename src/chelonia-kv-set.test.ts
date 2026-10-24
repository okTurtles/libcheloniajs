import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey, type Key } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorSignatureKeyUnauthorized,
  ChelErrorUnexpectedHttpResponseCode,
  findErrorCause,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { within, type FetchInit } from './test-utils.js'
import type {
  ChelContractState, ChelKvGetResult, ChelRootState, CheloniaConfig, JSONType, KvConflictCause
} from './types.js'

const setupContract = (): { contractID: string; signingKeyId: string; signingKey: Key } => {
  const contractID = 'cid-kv-set-recovery'
  const signingKey = keygen(EDWARDS25519SHA512BATCH)
  const signingKeyId = keyId(signingKey)
  const rootState = sbp('chelonia/private/state') as ChelRootState
  rootState.contracts[contractID] = {
    height: 1,
    HEAD: '',
    previousKeyOp: '',
    type: 'test-contract'
  }
  ;(rootState as unknown as Record<string, unknown>)[contractID] = {
    _vm: {
      authorizedKeys: {
        [signingKeyId]: {
          id: signingKeyId,
          name: '#sak',
          purpose: ['sig', 'sak'],
          data: serializeKey(signingKey, false),
          _notBeforeHeight: 0
        }
      }
    }
  }
  rootState.secretKeys = { [signingKeyId]: serializeKey(signingKey, true) }
  return { contractID, signingKeyId, signingKey }
}

// A correctly signed KV value with an arbitrary height stamp
const signValue = (signingKey: Key, key: string, data: JSONType, height: unknown) => ({
  ...signedOutgoingDataWithRawKey(signingKey, data).serialize(key + String(height)),
  height
})

const setLocalHeight = (contractID: string, height: number) => {
  (sbp('chelonia/private/state') as ChelRootState).contracts[contractID].height = height
}

// Serves `served.body` to every request (with etag 'etag-1')
const serve = (served: { body: unknown }) => {
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    fetch: async () => new Response(JSON.stringify(served.body), {
      status: 200, headers: { etag: 'etag-1' }
    })
  } as Partial<CheloniaConfig>)
}

const NON_CANONICAL_STAMPS = ['1e1', '010', ' 10', '10 ', '-1', '', '0x1', 1.5, -1, null, undefined]

// Answers every request with `respond`; returns the methods requested so far
const stubFetch = (
  respond: (method: string, init?: FetchInit) => Response | Promise<Response>
): string[] => {
  const calls: string[] = []
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    fetch: async (_url: string, init?: FetchInit) => {
      const method = init?.method ?? 'GET'
      calls.push(method)
      return respond(method, init)
    }
  } as Partial<CheloniaConfig>)
  return calls
}

const conflict = (body?: unknown, etag?: string) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status: 412, headers: etag ? { etag } : {}
  })

const merge = async (
  { etag }: { etag: string | null | undefined }
): Promise<[JSONType, string | undefined]> => [{ x: 2 }, etag ?? undefined]

describe('chelonia/kv/set', () => {
  const originalRandom = Math.random
  // Intentionally scoped to this describe rather than hoisted to module
  // scope, so the re-init only wraps this suite's tests.
  beforeEach(() => {
    sbp('chelonia/_init')
    // No conflict backoff unless a test asks for one
    Math.random = () => 0
  })

  // Re-init after each test so the stubbed `fetch` doesn't leak past this
  // suite (`_init` rebuilds the default config; any later suite in this
  // file would otherwise see the stub).
  afterEach(() => {
    Math.random = originalRandom
    sbp('chelonia/_init')
  })

  it('rejects invalid options with a TypeError before any request', async () => {
    const { contractID, signingKeyId } = setupContract()
    const calls = stubFetch(() => new Response(null, { status: 204 }))
    const set = (data: JSONType | undefined, options: Record<string, unknown>) =>
      sbp('chelonia/kv/set', contractID, 'settings', data, { signingKeyId, ...options })

    for (const maxAttempts of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '3']) {
      await assert.rejects(() => set({ x: 1 }, { maxAttempts }), TypeError, String(maxAttempts))
    }
    for (const onconflict of [undefined, null, 'merge']) {
      await assert.rejects(() => set(undefined, { onconflict }), TypeError)
    }
    assert.deepStrictEqual(calls, [])

    for (const maxAttempts of [null, undefined, 1]) await set({ x: 1 }, { maxAttempts })
    assert.deepStrictEqual(calls, ['POST', 'POST', 'POST'])
  })

  it('rejects a 412 without onconflict at once, describing its value', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    const value = (height: string) => signValue(signingKey, 'settings', { x: 9 }, height)
    const cases: [unknown, string | undefined, KvConflictCause][] = [
      [value('1'), 'etag-1', { currentStatus: 'present', currentData: { x: 9 }, etag: 'etag-1' }],
      [value('5'), 'etag-5', { currentStatus: 'ahead', requiredHeight: 5, etag: 'etag-5' }],
      [undefined, undefined, { currentStatus: 'absent', currentData: undefined, etag: null }],
      [value('01'), 'etag-m', { etag: 'etag-m' }]
    ]
    for (const [body, etag, cause] of cases) {
      const calls = stubFetch(() => conflict(body, etag))
      const e = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 3
      }).catch((e: unknown) => e)
      assert.ok(e instanceof ChelErrorKvMaxAttempts && isKvConflict(e))
      assert.match(e.message, /failed with status 412 and no onconflict handler was provided/)
      assert.deepStrictEqual(e.cause, cause)
      assert.deepStrictEqual(calls, ['POST'])
    }
  })

  it('describes only the final 412 when attempts run out', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    const values = [{ x: 'a' }, { x: 'b' }].map((data) => signValue(signingKey, 'settings', data, '1'))
    let posts = 0
    stubFetch(() => { const i = posts++; return conflict(values[i], `etag-${i}`) })
    const seen: unknown[] = []

    const e = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      maxAttempts: 2,
      onconflict: (args: { currentData: JSONType | undefined; etag: string | null }) => {
        seen.push(args.currentData)
        return merge(args)
      }
    }).catch((e: unknown) => e)
    assert.deepStrictEqual(seen, [{ x: 'a' }])
    assert.ok(e instanceof ChelErrorKvMaxAttempts)
    assert.deepStrictEqual(e.cause, { currentStatus: 'present', currentData: { x: 'b' }, etag: 'etag-1' })
  })

  it('rejects with a height error when the final 412 value is ahead or malformed', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    let onconflictCalls = 0
    const set = () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      maxAttempts: 1,
      onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
    }).catch((e: unknown) => e)

    stubFetch(() => conflict(signValue(signingKey, 'settings', { x: 9 }, '5'), 'etag-5'))
    const ahead = await set()
    assert.ok(isKvHeightAhead(ahead))
    assert.deepStrictEqual(kvHeightAheadCause(ahead), {
      requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-5', httpStatus: 412
    })
    stubFetch(() => conflict(signValue(signingKey, 'settings', { x: 9 }, '1e0'), 'etag-m'))
    assert.ok(isKvHeightMalformed(await set()))
    assert.strictEqual(onconflictCalls, 0)
  })

  it('rejects with the abort reason when aborted while reading the final 412', async () => {
    const { contractID, signingKeyId } = setupContract()
    const controller = new AbortController()
    const reason = { stopped: true }
    const calls = stubFetch((method, init) => {
      if (method === 'POST') return conflict()
      controller.abort(reason)
      throw init!.signal!.reason
    })

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 1, onconflict: merge, signal: controller.signal
      }),
      (e: unknown) => e === reason
    )
    assert.deepStrictEqual(calls, ['POST', 'GET'])
  })

  for (const [label, abort, expected] of [
    ['the caller aborts', (c: AbortController) => c.abort('stop'), (e: unknown) => e === 'stop'],
    ['Chelonia resets', () => sbp('chelonia/reset'),
      (e: unknown) => (e as Error).name === 'AbortError']
  ] as const) {
    it(`ends the conflict backoff at once when ${label}`, async () => {
      const { contractID, signingKeyId } = setupContract()
      Math.random = () => 0.999
      const controller = new AbortController()
      let onconflictCalls = 0
      let aborted: unknown
      const calls = stubFetch(() => {
        setTimeout(() => { aborted = abort(controller) }, 10)
        return conflict(undefined, 'etag-1')
      })

      const e = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        signal: controller.signal,
        onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
      }).catch((e: unknown) => e), 'kv/set in its backoff', 1000)
      assert.ok(expected(e), String(e))
      assert.strictEqual(onconflictCalls, 0)
      assert.deepStrictEqual(calls, ['POST'])
      await aborted
    })
  }

  it('bounds body-less conflict recovery GETs to one per set call', async () => {
    const { contractID, signingKeyId } = setupContract()
    const calls: string[] = []
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string }) => {
        const method = opts?.method ?? 'GET'
        calls.push(method)
        return new Response('', { status: method === 'POST' ? 412 : 404 })
      }
    } as Partial<CheloniaConfig>)

    try {
      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          maxAttempts: 3,
          onconflict: async (
            args: { etag: string | null | undefined }
          ): Promise<[JSONType, string | undefined]> => [
            { x: 2 },
            typeof args.etag === 'string' ? args.etag : undefined
          ]
        }),
        (e: unknown) => e instanceof ChelErrorKvMaxAttempts
      )
    } finally {
      console.warn = originalWarn
    }

    assert.deepStrictEqual(calls, ['POST', 'GET', 'POST', 'POST'])
    assert.strictEqual(warnings.length, 1)
  })

  it('falls back when AbortSignal.any is unavailable and propagates aborts', async () => {
    const { contractID, signingKeyId } = setupContract()
    const originalAny = (AbortSignal as unknown as { any?: typeof AbortSignal.any }).any
    const callerController = new AbortController()
    const callerError = new DOMException('caller stopped', 'AbortError')
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined
    })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { signal?: AbortSignal }) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal
          if (!signal) throw new Error('missing composed signal')
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          setTimeout(() => callerController.abort(callerError), 0)
        })
      }
    } as Partial<CheloniaConfig>)

    try {
      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          signal: callerController.signal
        }),
        callerError
      )
    } finally {
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        value: originalAny
      })
    }
  })

  it('fallback composed signal is aborted when the caller signal already is', async () => {
    const { contractID, signingKeyId } = setupContract()
    const originalAny = (AbortSignal as unknown as { any?: typeof AbortSignal.any }).any
    const callerController = new AbortController()
    const callerError = new DOMException('already stopped', 'AbortError')
    callerController.abort(callerError)
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined
    })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { signal?: AbortSignal }) => {
        const signal = opts?.signal
        assert.strictEqual(signal?.aborted, true)
        throw signal!.reason
      }
    } as Partial<CheloniaConfig>)

    try {
      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          signal: callerController.signal
        }),
        callerError
      )
    } finally {
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        value: originalAny
      })
    }
  })

  it('cleans fallback composed-signal listeners after successful writes', async () => {
    const { contractID, signingKeyId } = setupContract()
    const originalAny = (AbortSignal as unknown as { any?: typeof AbortSignal.any }).any
    const callerController = new AbortController()
    const originalRemove = callerController.signal.removeEventListener.bind(callerController.signal)
    let removed = 0
    callerController.signal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
      removed++
      return originalRemove(...args)
    }) as typeof callerController.signal.removeEventListener
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined
    })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response('', {
        status: 200,
        headers: { 'x-cid': 'success-cid' }
      })
    } as Partial<CheloniaConfig>)

    try {
      await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        signal: callerController.signal
      })
    } finally {
      callerController.signal.removeEventListener = originalRemove
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        value: originalAny
      })
    }

    assert.strictEqual(removed, 1)
  })

  it('returns null etag when a retry succeeds without etag headers', async () => {
    const { contractID, signingKeyId } = setupContract()
    let calls = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string }) => {
        calls++
        if (opts?.method === 'POST' && calls === 1) {
          return new Response('', { status: 412, headers: { etag: 'stale-etag' } })
        }
        return new Response('', { status: 200 })
      }
    } as Partial<CheloniaConfig>)

    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, 'stale-etag']
    }) as { etag: string | null }

    assert.deepStrictEqual(result, { etag: null })
  })

  it('leaves the final value out of the cause when it cannot be read', async () => {
    const { contractID, signingKeyId } = setupContract()
    const unverifiable = signValue(keygen(EDWARDS25519SHA512BATCH), 'settings', { x: 9 }, '1')
    for (const body of ['not json', JSON.stringify(unverifiable)]) {
      stubFetch(() => new Response(body, { status: 412, headers: { etag: 'etag-1' } }))
      const e = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 1, onconflict: merge
      }).catch((e: unknown) => e)
      assert.ok(e instanceof ChelErrorKvMaxAttempts)
      assert.deepStrictEqual(e.cause, { etag: 'etag-1' })
    }
  })

  it("doesn't carry a recovered value into the final body-less 412's cause", async () => {
    const { contractID, signingKeyId } = setupContract()
    let capturedBody = ''
    let calls = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        calls++
        if (opts?.method === 'POST') {
          capturedBody ||= opts.body ?? ''
          return new Response('', { status: 412 })
        }
        return new Response(capturedBody, { status: 200, headers: { etag: 'etag-current' } })
      }
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 2,
        onconflict: async (
          args: { currentData: JSONType | undefined; etag: string | null | undefined }
        ): Promise<[JSONType, string | undefined]> => [
          { x: (args.currentData as { x: number }).x + 1 },
          args.etag ?? undefined
        ]
      }),
      (e: unknown) => e instanceof ChelErrorKvMaxAttempts &&
        assert.deepStrictEqual(
          (e as { cause?: unknown }).cause,
          { currentStatus: 'absent', currentData: undefined, etag: null }
        ) === undefined
    )
    assert.deepStrictEqual(calls, 3)
  })

  it('treats a height-ahead conflict body as no current value and retries', async () => {
    const { contractID, signingKeyId } = setupContract()
    let capturedBody = ''
    let posts = 0
    const seenCurrentData: (JSONType | undefined)[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        if (opts?.method === 'POST') {
          posts++
          capturedBody ||= opts.body ?? ''
          if (posts === 1) {
            // Simulate a stored value written at a contract height (5) ahead
            // of the locally synced height (1)
            const ahead = { ...JSON.parse(capturedBody), height: '5' }
            return new Response(JSON.stringify(ahead), {
              status: 412,
              headers: { etag: 'etag-ahead' }
            })
          }
          return new Response('', { status: 200, headers: { 'x-cid': 'cid-ok' } })
        }
        return new Response('', { status: 404 })
      }
    } as Partial<CheloniaConfig>)

    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (
        args: { currentData: JSONType | undefined; etag: string | null | undefined }
      ): Promise<[JSONType, string | undefined]> => {
        seenCurrentData.push(args.currentData)
        return [{ x: 2 }, args.etag ?? undefined]
      }
    }) as { etag: string | null }

    assert.deepStrictEqual(result, { etag: 'cid-ok' })
    assert.strictEqual(posts, 2)
    assert.deepStrictEqual(seenCurrentData, [undefined])
  })

  it('recovery GET tolerates a height-ahead body and still recovers the etag', async () => {
    const { contractID, signingKeyId } = setupContract()
    let capturedBody = ''
    let posts = 0
    let gets = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        if (opts?.method === 'POST') {
          posts++
          capturedBody ||= opts.body ?? ''
          if (posts === 1) return new Response('', { status: 412 })
          return new Response('', { status: 200, headers: { 'x-cid': 'cid-ok' } })
        }
        gets++
        const ahead = { ...JSON.parse(capturedBody), height: '5' }
        return new Response(JSON.stringify(ahead), {
          status: 200,
          headers: { etag: 'etag-recovered' }
        })
      }
    } as Partial<CheloniaConfig>)

    const seenEtags: (string | null | undefined)[] = []
    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (
        args: { currentData: JSONType | undefined; etag: string | null | undefined }
      ): Promise<[JSONType, string | undefined]> => {
        seenEtags.push(args.etag)
        return [{ x: 2 }, args.etag ?? undefined]
      }
    }) as { etag: string | null }

    assert.deepStrictEqual(result, { etag: 'cid-ok' })
    assert.strictEqual(gets, 1)
    assert.deepStrictEqual(seenEtags, ['etag-recovered'])
  })
})

describe('chelonia/kv/get', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

  // Same leak-prevention as the `chelonia/kv/set` block above.
  afterEach(() => {
    sbp('chelonia/_init')
  })

  it('returns values stamped at or below the local height', async () => {
    const { contractID, signingKey } = setupContract()
    setLocalHeight(contractID, 10)
    const served = { body: undefined as unknown }
    serve(served)
    for (const height of ['0', '10', 10, 0]) {
      served.body = signValue(signingKey, 'settings', { height }, height)
      const result = await sbp('chelonia/kv/get', contractID, 'settings') as ChelKvGetResult
      assert.deepStrictEqual(result.data, { height })
      assert.strictEqual(result.etag, 'etag-1')
    }
  })

  it('rejects a value ahead of the local height with ChelErrorKvHeightAhead', async () => {
    const { contractID, signingKey } = setupContract()
    serve({ body: signValue(signingKey, 'settings', { x: 1 }, '5') })

    const e = await sbp('chelonia/kv/get', contractID, 'settings').catch((e: unknown) => e)
    assert.ok(isKvHeightAhead(e) && e instanceof ChelErrorInvalidMessageHeight)
    assert.deepStrictEqual(kvHeightAheadCause(e), {
      requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-1', httpStatus: 200
    })
    assert.match(e.message, /height 5.*height 1.*sync the contract and retry/)
  })

  it('reports a contract without local height as not loaded', async () => {
    const { contractID, signingKey } = setupContract()
    delete (sbp('chelonia/private/state') as ChelRootState).contracts[contractID]
    serve({ body: signValue(signingKey, 'settings', { x: 1 }, '0') })

    const e = await sbp('chelonia/kv/get', contractID, 'settings').catch((e: unknown) => e)
    assert.ok(isKvHeightAhead(e))
    assert.strictEqual(kvHeightAheadCause(e)?.localHeight, undefined)
    assert.strictEqual(kvHeightAheadCause(e)?.requiredHeight, 0)
    assert.match(e.message, /not loaded/)
  })

  it('rejects a malformed stamp with ChelErrorKvHeightMalformed, also on its cause', async () => {
    const { contractID, signingKey } = setupContract()
    setLocalHeight(contractID, 20)
    const served = { body: undefined as unknown }
    serve(served)
    const oldName = (e: unknown): e is Error =>
      (e as Error).name === 'ChelErrorInvalidMessageHeight'
    for (const height of NON_CANONICAL_STAMPS) {
      served.body = signValue(signingKey, 'settings', { x: 1 }, height)
      const e = await sbp('chelonia/kv/get', contractID, 'settings').catch((e: unknown) => e)
      assert.ok(isKvHeightMalformed(e), `stamp ${JSON.stringify(height)}`)
      assert.ok(isKvHeightMalformed(e.cause))
      assert.strictEqual(findErrorCause(e, oldName), undefined)
    }
  })

  // Same reason as the publish path: an app should be able to branch on the
  // status without parsing it back out of the message.
  it('reports the HTTP status on `cause`', async () => {
    const { contractID } = setupContract()
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response('', { status: 503, statusText: 'Service Unavailable' })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/get', contractID, 'settings'),
      (e: unknown) => e instanceof ChelErrorUnexpectedHttpResponseCode &&
        (e as Error).cause === 503 &&
        (e as Error).message === '[kv/get] 503: Service Unavailable'
    )
  })
})

describe('height stamps of detached messages', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

  afterEach(() => {
    sbp('chelonia/_init')
  })

  const parse = (contractID: string, serializedData: unknown) =>
    sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
      contractID, serializedData, meta: 'settings'
    }) as ChelKvGetResult
  const isGenericHeightError = (e: unknown) =>
    (e as Error).name === 'ChelErrorInvalidMessageHeight'

  it('rejects non-canonical stamps with ChelErrorInvalidMessageHeight', () => {
    const { contractID, signingKey } = setupContract()
    setLocalHeight(contractID, 20)
    for (const height of NON_CANONICAL_STAMPS) {
      assert.throws(
        () => parse(contractID, signValue(signingKey, 'settings', { x: 1 }, height)),
        isGenericHeightError,
        `stamp ${JSON.stringify(height)}`
      )
    }
  })

  it("doesn't let a revoked key into its key window with a non-canonical stamp", () => {
    const { contractID } = setupContract()
    const revokedKey = keygen(EDWARDS25519SHA512BATCH)
    const revokedKeyId = keyId(revokedKey)
    const rootState = sbp('chelonia/private/state') as Record<string, ChelContractState>
    rootState[contractID]._vm.authorizedKeys[revokedKeyId] = {
      id: revokedKeyId,
      name: 'revoked',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      data: serializeKey(revokedKey, false),
      _notBeforeHeight: 0,
      _notAfterHeight: 1
    }
    setLocalHeight(contractID, 10)

    // The server reads '1e1' as height 10; `parseInt` would read 1, inside the window
    assert.throws(
      () => parse(contractID, signValue(revokedKey, 'settings', { x: 1 }, '1e1')),
      isGenericHeightError
    )
    const atTen = parse(contractID, signValue(revokedKey, 'settings', { x: 1 }, '10'))
    assert.throws(() => atTen.data, ChelErrorSignatureKeyUnauthorized)
    const atOne = parse(contractID, signValue(revokedKey, 'settings', { x: 1 }, '1'))
    assert.deepStrictEqual(atOne.data, { x: 1 })
  })
})
