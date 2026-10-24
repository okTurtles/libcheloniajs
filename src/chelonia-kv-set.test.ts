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
import { kvHeightTimings } from './kv-height.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { within, type FetchInit } from './test-utils.js'
import type {
  ChelContractState, ChelKvGetResult, ChelKvOnConflictCallback, ChelRootState, CheloniaConfig,
  JSONType, KvConflictCause
} from './types.js'

type ConflictArgs = Parameters<ChelKvOnConflictCallback>[0]

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

// As if an event had committed `height`
const setLocalHeight = (contractID: string, height: number) => {
  (sbp('chelonia/private/state') as ChelRootState).contracts[contractID].height = height
  sbp('chelonia/kv/_notifyHeight', contractID, height)
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

// The server's contract height isn't the posted stamp; it stores `stored`
const staleStamp = (stored?: unknown) =>
  new Response(stored === undefined ? '' : JSON.stringify(stored), {
    status: 409, headers: { etag: 'etag-0' }
  })

type Post = { height: string; ifMatch: string | null; body: { _signedData: string[] } }

// Answers the n-th POST (from 0) with `respond`; returns the POSTs so far
const recordPosts = (respond: (n: number) => Response): Post[] => {
  const posts: Post[] = []
  stubFetch((method, init) => {
    assert.strictEqual(method, 'POST')
    const body = JSON.parse(String(init!.body))
    posts.push({ height: body.height, ifMatch: new Headers(init!.headers).get('if-match'), body })
    return respond(posts.length - 1)
  })
  return posts
}

const accepted = () => new Response(null, { status: 204, headers: { 'x-cid': 'cid-ok' } })

const merge = async (
  { etag }: { etag: string | null | undefined }
): Promise<[JSONType, string | undefined]> => [{ x: 2 }, etag ?? undefined]

// Where `kv/set` first reads a server value (served with etag 'etag-5'): the
// requests made by then, and that response's status
const valueSources: {
  label: string;
  data: JSONType | undefined;
  requests: string[];
  httpStatus: number;
  respond: (value: unknown) => (method: string) => Response;
}[] = [
  {
    label: 'a 412',
    data: { x: 1 },
    requests: ['POST'],
    httpStatus: 412,
    respond: (value) => () => conflict(value, 'etag-5')
  },
  {
    label: 'a recovery GET',
    data: { x: 1 },
    requests: ['POST', 'GET'],
    httpStatus: 200,
    respond: (value) => (method) =>
      method === 'POST' ? conflict() : Response.json(value, { headers: { etag: 'etag-5' } })
  },
  {
    label: 'a fetch-first GET',
    data: undefined,
    requests: ['GET'],
    httpStatus: 200,
    respond: (value) => () => Response.json(value, { headers: { etag: 'etag-5' } })
  }
]

describe('chelonia/kv/set', () => {
  const originalRandom = Math.random
  const timings = { ...kvHeightTimings }
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
    Object.assign(kvHeightTimings, timings)
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
    for (const heightWaitMs of [-1, NaN, Infinity, -Infinity, '5']) {
      await assert.rejects(() => set({ x: 1 }, { heightWaitMs }), TypeError, String(heightWaitMs))
    }
    for (const onconflict of [undefined, null, 'merge']) {
      await assert.rejects(() => set(undefined, { onconflict }), TypeError)
    }
    assert.deepStrictEqual(calls, [])

    for (const maxAttempts of [null, undefined, 1]) await set({ x: 1 }, { maxAttempts })
    for (const heightWaitMs of [null, undefined, 0, 2 ** 40]) await set({ x: 1 }, { heightWaitMs })
    assert.deepStrictEqual(calls, Array(7).fill('POST'))
  })

  it('rejects a 412 without onconflict at once, describing its value', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    kvHeightTimings.waitMs = 60_000
    const value = (height: string) => signValue(signingKey, 'settings', { x: 9 }, height)
    const cases: [unknown, string | undefined, KvConflictCause][] = [
      [value('1'), 'etag-1', { currentStatus: 'present', currentData: { x: 9 }, etag: 'etag-1' }],
      [value('5'), 'etag-5', { currentStatus: 'ahead', requiredHeight: 5, etag: 'etag-5' }],
      [undefined, undefined, { currentStatus: 'absent', currentData: undefined, etag: null }],
      [value('01'), 'etag-m', { currentStatus: 'malformed', etag: 'etag-m' }]
    ]
    for (const [body, etag, cause] of cases) {
      const calls = stubFetch(() => conflict(body, etag))
      const e = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 3
      }).catch((e: unknown) => e), `kv/set (${cause.currentStatus})`)
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

  it('rejects a final ahead or malformed 412 with a height error unless allowed', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    kvHeightTimings.waitMs = 60_000
    let onconflictCalls = 0
    // The final 412 is read without waiting for the height
    const set = (blind?: boolean) => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      maxAttempts: 1,
      allowUnverifiedConflict: blind,
      onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
    }).catch((e: unknown) => e), 'kv/set', 1000)
    const ahead = () => conflict(signValue(signingKey, 'settings', { x: 9 }, '5'), 'etag-5')
    const malformed = () => conflict(signValue(signingKey, 'settings', { x: 9 }, '1e0'), 'etag-m')

    stubFetch(ahead)
    const e = await set()
    assert.ok(isKvHeightAhead(e))
    assert.deepStrictEqual(kvHeightAheadCause(e), {
      requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-5', httpStatus: 412
    })
    stubFetch(malformed)
    assert.ok(isKvHeightMalformed(await set()))

    // A blind writer gets a conflict describing the value
    for (const [respond, cause] of [
      [ahead, { currentStatus: 'ahead', requiredHeight: 5, etag: 'etag-5' }],
      [malformed, { currentStatus: 'malformed', etag: 'etag-m' }]
    ] as const) {
      stubFetch(respond)
      const e = await set(true)
      assert.ok(e instanceof ChelErrorKvMaxAttempts)
      assert.deepStrictEqual(e.cause, cause)
    }
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
    for (const phase of [
      'conflict backoff', 'blind writer\'s conflict backoff', 'height wait', 'stale-stamp wait'
    ] as const) {
      it(`ends the ${phase} at once when ${label}`, async () => {
        const { contractID, signingKeyId, signingKey } = setupContract()
        const blind = phase === 'blind writer\'s conflict backoff'
        const body = phase === 'height wait' || blind
          ? signValue(signingKey, 'settings', { x: 9 }, '5')
          : undefined
        if (phase.endsWith('conflict backoff')) Math.random = () => 0.999
        const controller = new AbortController()
        let onconflictCalls = 0
        let aborted: unknown
        const calls = stubFetch(() => {
          setTimeout(() => { aborted = abort(controller) }, 10)
          return phase === 'stale-stamp wait' ? staleStamp() : conflict(body, 'etag-1')
        })

        const e = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          signal: controller.signal,
          heightWaitMs: 60_000,
          allowUnverifiedConflict: blind,
          onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
        }).catch((e: unknown) => e), `kv/set in its ${phase}`, 1000)
        assert.ok(expected(e), String(e))
        assert.strictEqual(onconflictCalls, 0)
        assert.deepStrictEqual(calls, ['POST'])
        await aborted
      })
    }
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

  for (const source of valueSources) {
    it(`waits for an ahead value from ${source.label} to become verifiable`, async () => {
      const { contractID, signingKeyId, signingKey } = setupContract()
      const reply = source.respond(signValue(signingKey, 'settings', { x: 9 }, '5'))
      const calls = stubFetch((method) => {
        const n = calls.length - source.requests.length
        if (n > 0) return new Response(null, { status: 204, headers: { 'x-cid': 'cid-ok' } })
        if (n === 0) setTimeout(() => setLocalHeight(contractID, 5), 10)
        return reply(method)
      })
      const seen: unknown[] = []

      const result = await within(sbp('chelonia/kv/set', contractID, 'settings', source.data, {
        signingKeyId,
        heightWaitMs: 60_000,
        onconflict: (args: ConflictArgs) => {
          seen.push([args.currentStatus, args.currentData, args.etag])
          return merge(args)
        }
      }), 'kv/set')
      assert.deepStrictEqual(result, { etag: 'cid-ok' })
      assert.deepStrictEqual(seen, [['present', { x: 9 }, 'etag-5']])
      assert.deepStrictEqual(calls, [...source.requests, 'POST'])
    })

    it(`rejects a value from ${source.label} it can't verify, without onconflict`, async () => {
      const { contractID, signingKeyId, signingKey } = setupContract()
      let onconflictCalls = 0
      const set = async (stamp: string, heightWaitMs: number) => {
        const calls = stubFetch(source.respond(signValue(signingKey, 'settings', { x: 9 }, stamp)))
        const e = await within(sbp('chelonia/kv/set', contractID, 'settings', source.data, {
          signingKeyId,
          heightWaitMs,
          onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
        }).catch((e: unknown) => e), `kv/set (stamp ${stamp})`)
        assert.deepStrictEqual(calls, source.requests)
        return e
      }

      const ahead = await set('5', 20)
      assert.ok(isKvHeightAhead(ahead))
      assert.deepStrictEqual(kvHeightAheadCause(ahead), {
        requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-5', httpStatus: source.httpStatus
      })
      // No wait for a value that can never be verified
      assert.ok(isKvHeightMalformed(await set('01', 60_000)))
      assert.strictEqual(onconflictCalls, 0)
    })
  }

  it('gives onconflict values it cannot verify, without waiting, when allowed', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    kvHeightTimings.waitMs = 60_000
    const stamped = (stamp: string) => signValue(signingKey, 'settings', { x: 9 }, stamp)
    const fetchFirst = valueSources[2]
    const cases: [JSONType | undefined, (method: string) => Response, unknown[]][] = [
      [{ x: 1 }, () => conflict(stamped('5'), 'etag-5'), ['ahead', 5, 'ChelErrorKvHeightAhead']],
      [undefined, fetchFirst.respond(stamped('5')), ['ahead', 5, 'ChelErrorKvHeightAhead']],
      [{ x: 1 }, () => conflict(stamped('01'), 'etag-5'),
        ['malformed', undefined, 'ChelErrorKvHeightMalformed']],
      [{ x: 1 }, () => conflict(stamped('1'), 'etag-5'), ['present', undefined, { x: 9 }]],
      [{ x: 1 }, () => conflict(undefined, 'etag-5'), ['absent', undefined, undefined]]
    ]
    for (const [data, respond, expected] of cases) {
      stubFetch(respond)
      let seen: unknown[] = []
      const result = await within(sbp('chelonia/kv/set', contractID, 'settings', data, {
        signingKeyId,
        allowUnverifiedConflict: true,
        onconflict: async (args: ConflictArgs) => {
          let currentData: unknown
          try { currentData = args.currentData } catch (e) { currentData = (e as Error).name }
          assert.strictEqual(!!args.currentValue, args.currentStatus === 'present')
          seen = [args.currentStatus, args.requiredHeight, currentData]
          return false
        }
      }), `kv/set (${String(expected[0])})`)
      assert.deepStrictEqual(result, { etag: null })
      assert.deepStrictEqual(seen, expected)
    }
  })

  it('re-signs the same write once the height a 409 needs arrives, without onconflict', async () => {
    const { contractID, signingKeyId } = setupContract()
    const posts = recordPosts((n) => {
      if (n > 0) return accepted()
      setTimeout(() => setLocalHeight(contractID, 2), 10)
      return staleStamp()
    })

    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, ifMatch: 'etag-a', heightWaitMs: 60_000
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: 'cid-ok' })
    assert.deepStrictEqual(posts.map(({ height, ifMatch }) => [height, ifMatch]), [
      ['1', 'etag-a'], ['2', 'etag-a']
    ])
    const [first, second] = posts.map(({ body }) => body._signedData)
    assert.strictEqual(second[0], first[0])
    const resigned = sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
      contractID, serializedData: posts[1].body, meta: 'settings'
    }) as ChelKvGetResult
    assert.deepStrictEqual(resigned.data, { x: 1 })
  })

  it("rejects with an inexact height error when a 409's height doesn't arrive in time", async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    const stored = (stamp: string) => signValue(signingKey, 'settings', { x: 9 }, stamp)
    let onconflictCalls = 0
    // The stored value's stamp, when readable and higher, raises the height needed
    for (const [body, requiredHeight] of [
      [undefined, 2], [stored('4'), 4], [stored('0'), 2], [stored('04'), 2], ['not a value', 2]
    ] as const) {
      const posts = recordPosts(() => staleStamp(body))
      const e = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        heightWaitMs: 20,
        onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
      }).catch((e: unknown) => e), `kv/set (requires ${requiredHeight})`)
      assert.ok(isKvHeightAhead(e))
      assert.deepStrictEqual(kvHeightAheadCause(e), {
        requiredHeight, exact: false, localHeight: 1, etag: 'etag-0', httpStatus: 409
      })
      assert.strictEqual(posts.length, 1)
    }
    assert.strictEqual(onconflictCalls, 0)
  })

  it('gives up after five re-signs in one call, whatever maxAttempts is', async () => {
    const { contractID, signingKeyId } = setupContract()
    let onconflictCalls = 0
    // Each write finds the server one event further along
    const posts = recordPosts((n) => {
      setLocalHeight(contractID, n + 2)
      return staleStamp()
    })

    const e = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      maxAttempts: 1,
      onconflict: () => { onconflictCalls++; return merge({ etag: null }) }
    }).catch((e: unknown) => e), 'kv/set')
    assert.ok(isKvHeightAhead(e))
    assert.deepStrictEqual(kvHeightAheadCause(e), {
      requiredHeight: 7, exact: false, localHeight: 7, etag: 'etag-0', httpStatus: 409
    })
    assert.deepStrictEqual(posts.map(({ height }) => height), ['1', '2', '3', '4', '5', '6'])
    assert.strictEqual(onconflictCalls, 0)
  })

  it('keeps re-signs apart from conflict attempts, re-signing what onconflict chose', async () => {
    const { contractID, signingKeyId, signingKey } = setupContract()
    const current = signValue(signingKey, 'settings', { x: 9 }, '1')
    const posts = recordPosts((n) => {
      if (n === 1) return conflict(current, 'etag-1')
      if (n === 3) return accepted()
      setLocalHeight(contractID, n + 2)
      return staleStamp()
    })
    let onconflictCalls = 0

    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      ifMatch: 'etag-a',
      maxAttempts: 2,
      onconflict: (args: ConflictArgs) => { onconflictCalls++; return merge(args) }
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: 'cid-ok' })
    assert.strictEqual(onconflictCalls, 1)
    assert.deepStrictEqual(
      posts.map(({ height, ifMatch, body }) => [height, ifMatch, JSON.parse(body._signedData[0])]),
      [['1', 'etag-a', { x: 1 }], ['2', 'etag-a', { x: 1 }], ['2', 'etag-1', { x: 2 }],
        ['4', 'etag-1', { x: 2 }]]
    )
  })
})

describe('chelonia/kv/get', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

  // Same leak-prevention as the `chelonia/kv/set` block above.
  const timings = { ...kvHeightTimings }
  afterEach(() => {
    Object.assign(kvHeightTimings, timings)
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
    kvHeightTimings.waitMs = 60_000

    // Without waiting for the height
    const e = await within(
      sbp('chelonia/kv/get', contractID, 'settings').catch((e: unknown) => e), 'kv/get', 1000
    )
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
