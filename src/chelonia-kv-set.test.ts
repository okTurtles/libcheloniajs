import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvHeightAhead,
  ChelErrorUnexpectedHttpResponseCode,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed,
  kvHeightAheadCause
} from './errors.js'
import { KV_MAX_STALE_STAMP_RETRIES } from './kv-height.js'
import { captureConsole, setContractHeightLater, sleep, useKvSetHooks, withLocalHeight, within } from './test-utils.js'
import type {
  ChelKvOnConflictCallback,
  ChelRootState,
  CheloniaConfig,
  JSONType,
  ParsedEncryptedOrUnencryptedMessage
} from './types.js'

// What `chelonia/kv/set` passes to `onconflict`.
type ConflictArgs = Parameters<ChelKvOnConflictCallback>[0]

const setupContract = (): { contractID: string; signingKeyId: string } => {
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
  return { contractID, signingKeyId }
}

// The body `chelonia/kv/set` would POST for `data` at contract `height`, i.e.
// a value another device wrote at that height (validly signed).
const signedBodyAt = async (
  contractID: string,
  signingKeyId: string,
  key: string,
  data: JSONType,
  height: number
): Promise<string> => {
  let body = ''
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    fetch: async (_url: string, opts: { body: string }) => {
      body = opts.body
      return new Response(null, { status: 204 })
    }
  } as unknown as Partial<CheloniaConfig>)
  await withLocalHeight(contractID, height, () =>
    sbp('chelonia/kv/set', contractID, key, data, { signingKeyId })
  )
  return body
}

// A body stamped at height 1 whose payload no longer matches its signature.
const tamperedBodyAt1 = async (contractID: string, signingKeyId: string): Promise<string> => {
  const stored = JSON.parse(await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1))
  const other = JSON.parse(await signedBodyAt(contractID, signingKeyId, 'settings', { x: 6 }, 1))
  stored._signedData[0] = other._signedData[0]
  return JSON.stringify(stored)
}

// A `fetch` that answers every request with the body of the test's first
// request, which must be a POST, re-stamped at `height` (e.g. a value the
// local contract can't verify yet, or a malformed stamp).
const replyRestamped = (
  height: string,
  init: ConstructorParameters<typeof Response>[1],
  onRequest?: (opts?: { method?: string; body?: string }) => void
) => {
  let captured = ''
  return async (_url: string, opts?: { method?: string; body?: string }) => {
    onRequest?.(opts)
    if (!captured) {
      if (opts?.method !== 'POST' || !opts.body) {
        throw new Error('replyRestamped: the first request must be a POST')
      }
      captured = opts.body
    }
    return new Response(JSON.stringify({ ...JSON.parse(captured), height }), init)
  }
}

// Calls `kv/set` against a server that answers every request with
// `respond()`, and aborts the call 50 ms after the first request, with
// `chelonia/reset` or with the caller's signal. Checks that the call rejects
// at once, not when the wait it was in (a 412's backoff, the wait for the
// height of a 412 that is ahead, or the passive wait after a 409) ends. A
// reset that started is awaited, even when an assertion fails, so that it
// doesn't run into the next test.
const abortDuringWait = async (
  by: 'reset' | 'signal',
  { contractID, signingKeyId }: { contractID: string; signingKeyId: string },
  respond: () => Response,
  options: Record<string, unknown> = {}
): Promise<void> => {
  const controller = new AbortController()
  let abortedAt: number | undefined
  let resetting: Promise<unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  sbp('chelonia/configure', {
    connectionURL: 'https://example.test',
    fetch: async (_url: string, opts: { signal?: AbortSignal }) => {
      opts.signal?.throwIfAborted()
      timer ??= setTimeout(() => {
        abortedAt = Date.now()
        if (by === 'signal') {
          controller.abort()
          return
        }
        resetting = sbp('chelonia/reset')
        // Awaited below; an early rejection mustn't be unhandled meanwhile.
        resetting!.catch(() => {})
      }, 50)
      return respond()
    }
  } as unknown as Partial<CheloniaConfig>)

  try {
    await assert.rejects(
      within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, ...(by === 'signal' && { signal: controller.signal }), ...options
      }), 'kv/set'),
      { name: 'AbortError' }
    )
    assert.ok(abortedAt !== undefined)
    assert.ok(Date.now() - abortedAt < 300, `rejected ${Date.now() - abortedAt} ms after the abort`)
  } finally {
    clearTimeout(timer)
    await within(resetting ?? Promise.resolve(), 'chelonia/reset')
  }
}

describe('chelonia/kv/set', () => {
  // Scoped to this describe rather than registered at module scope, so the
  // re-init only wraps this suite's tests.
  useKvSetHooks()

  it('bounds body-less conflict recovery GETs to one per set call', async () => {
    const { contractID, signingKeyId } = setupContract()
    const calls: string[] = []
    const { warnings, restore } = captureConsole()
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
          onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => [
            { x: 2 },
            typeof args.etag === 'string' ? args.etag : undefined
          ]
        }),
        (e: unknown) => isKvConflict(e)
      )
    } finally {
      restore()
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

  // Not a bound at all otherwise: `NaN` would retry a contended key forever.
  it('rejects an invalid maxAttempts with a TypeError, without any request', async () => {
    const { contractID, signingKeyId } = setupContract()
    let requests = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        requests++
        return new Response('', { status: 412 })
      }
    } as Partial<CheloniaConfig>)
    for (const maxAttempts of [NaN, 0, -1, 1.5, Infinity, '3']) {
      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          maxAttempts,
          onconflict: async ({ etag }: ConflictArgs): Promise<[JSONType, string | undefined]> =>
            [{ x: 1 }, etag ?? undefined]
        }),
        (e: unknown) => e instanceof TypeError &&
          e.message === '[chelonia/kv] set: `maxAttempts` must be an integer >= 1',
        String(maxAttempts)
      )
    }
    assert.strictEqual(requests, 0)
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

  // The last value is unknown: the cause leaves out `currentStatus` (and
  // `currentData`) rather than setting them to `undefined`.
  it('throws max-attempts when diagnostic conflict parsing fails', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response('not json', { status: 412, headers: { etag: 'etag-1' } })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 1,
        onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, 'etag-1']
      }),
      (e: unknown) => {
        assert.ok(isKvConflict(e))
        assert.deepStrictEqual((e as { cause?: unknown }).cause, { etag: 'etag-1' })
        return true
      }
    )
  })

  it("throws max-attempts without a currentStatus when the last value can't be decoded", async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await tamperedBodyAt1(contractID, signingKeyId)
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(stored, {
        status: 412, headers: { etag: '"cid-1"' }
      })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 1,
        onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, undefined]
      }),
      (e: unknown) => {
        assert.ok(isKvConflict(e))
        assert.deepStrictEqual((e as { cause?: unknown }).cause, { etag: '"cid-1"' })
        return true
      }
    )
  })

  it('reports the last response, not an earlier recovered value, when the final conflict is body-less', async () => {
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
        onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => [
          { x: (args.currentData as { x: number }).x + 1 },
          args.etag ?? undefined
        ]
      }),
      // The one recovery GET (after the first 412) is used up: the last,
      // body-less 412 says the key is absent, and carries no etag.
      (e: unknown) => isKvConflict(e) &&
        assert.deepStrictEqual(
          (e as { cause?: unknown }).cause,
          { currentData: undefined, currentStatus: 'absent', etag: null }
        ) === undefined
    )
    assert.deepStrictEqual(calls, 3)
  })

  it('rejects a 412 whose value is ahead, without calling onconflict', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
    let posts = 0
    let conflicts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      // A stored value written at a contract height (5) ahead of the locally
      // synced height (1)
      fetch: replyRestamped('5', { status: 412, headers: { etag: 'etag-ahead' } }, () => {
        posts++
      })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        onconflict: async (): Promise<[JSONType, string | undefined]> => {
          conflicts++
          return [{ x: 2 }, undefined]
        }
      }), 'kv/set'),
      (e: unknown) => {
        assert.ok(isKvHeightAhead(e))
        assert.ok(e instanceof ChelErrorInvalidMessageHeight)
        assert.deepStrictEqual(kvHeightAheadCause(e), {
          requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-ahead', httpStatus: 412
        })
        return true
      }
    )
    assert.strictEqual(posts, 1)
    assert.strictEqual(conflicts, 0)
  })

  it('passes the verified value to onconflict once the height catches up', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 2)
    const postedHeights: string[] = []
    const seen: unknown[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        postedHeights.push(JSON.parse(opts!.body!).height)
        if (postedHeights.length === 1) {
          // Event 2 finishes processing while the conflict is resolved.
          setContractHeightLater(contractID, 2, 20)
          return new Response(stored, { status: 412, headers: { etag: 'etag-2' } })
        }
        return new Response(null, { status: 204, headers: { etag: 'etag-3' } })
      }
    } as Partial<CheloniaConfig>)

    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: 8 }, args.etag ?? undefined]
      }
    }), 'kv/set') as { etag: string | null }

    assert.deepStrictEqual(result, { etag: 'etag-3' })
    assert.deepStrictEqual(seen, [['present', { x: 7 }, 'etag-2']])
    assert.deepStrictEqual(postedHeights, ['1', '2'])
  })

  it('allowUnverifiedConflict passes an ahead value with a throwing currentData', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
    const seen: unknown[] = []
    const posted: unknown[] = []
    const conflict = replyRestamped('5', { status: 412, headers: { etag: 'e5' } })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        posted.push(JSON.parse(opts!.body!)._signedData[0])
        if (seen.length === 0) return conflict(url, opts)
        return new Response(null, { status: 204, headers: { etag: 'e6' } })
      }
    } as Partial<CheloniaConfig>)

    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      allowUnverifiedConflict: true,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        assert.throws(() => args.currentData, (e: unknown) => isKvHeightAhead(e))
        seen.push([args.currentStatus, args.requiredHeight, args.currentValue, args.etag])
        return [{ x: 2 }, args.etag ?? undefined]
      }
    })
    assert.deepStrictEqual(seen, [['ahead', 5, undefined, 'e5']])
    // The merged data was written.
    assert.deepStrictEqual(result, { etag: 'e6' })
    assert.strictEqual(posted.length, 2)
    assert.deepStrictEqual(JSON.parse(posted[1] as string), { x: 2 })
  })

  it("reports currentStatus 'absent' for an empty conflict body", async () => {
    const { contractID, signingKeyId } = setupContract()
    const seen: unknown[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => seen.length === 0
        ? new Response('', { status: 412, headers: { etag: '""' } })
        : new Response(null, { status: 204, headers: { etag: 'e1' } })
    } as Partial<CheloniaConfig>)

    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      ifMatch: '"stale"',
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: 2 }, args.etag ?? undefined]
      }
    })
    assert.deepStrictEqual(seen, [['absent', undefined, '""']])
  })

  // Type-checked: the test file fails to compile if `currentValue` stops
  // being tied to `currentStatus`.
  it('types currentValue by currentStatus for onconflict', async () => {
    const { contractID, signingKeyId } = setupContract()
    const seen: unknown[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => seen.length === 0
        ? new Response('', { status: 412, headers: { etag: '""' } })
        : new Response(null, { status: 204, headers: { etag: 'e1' } })
    } as Partial<CheloniaConfig>)
    type Parsed = ParsedEncryptedOrUnencryptedMessage<JSONType>
    const onconflict: ChelKvOnConflictCallback = async (args) => {
      // @ts-expect-error `currentValue` is `undefined` unless 'present'
      const unnarrowed: Parsed = args.currentValue
      assert.strictEqual(unnarrowed, undefined)
      if (args.currentStatus === 'present') {
        const parsed: Parsed = args.currentValue
        seen.push([args.currentStatus, parsed])
      } else if (args.currentStatus === 'ahead') {
        const requiredHeight: number = args.requiredHeight
        const none: undefined = args.currentValue
        seen.push([args.currentStatus, requiredHeight, none])
      } else {
        const none: undefined = args.currentValue
        seen.push([args.currentStatus, none])
      }
      return [{ x: 2 }, args.etag ?? undefined]
    }
    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, ifMatch: '"stale"', onconflict
    })
    assert.deepStrictEqual(seen, [['absent', undefined]])
  })

  it("reports 'present' for a value verified lazily: currentData can still throw", async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await tamperedBodyAt1(contractID, signingKeyId)
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(stored, {
        status: 412, headers: { etag: '"cid-1"' }
      })
    } as Partial<CheloniaConfig>)

    const seen: unknown[] = []
    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (args: ConflictArgs) => {
        assert.throws(() => args.currentData, { name: 'ChelErrorSignatureError' })
        seen.push(args.currentStatus)
        return false
      }
    })
    assert.deepStrictEqual(seen, ['present'])
  })

  it('rejects a malformed height stamp instead of treating the value as absent', async () => {
    const { contractID, signingKeyId } = setupContract()
    // '01' is how a server comparing `Number(stamp)` sees height 1. With
    // `maxAttempts: 1` the first 412 is also the last: reported the same.
    for (const stamp of ['not-a-height', '01']) {
      for (const maxAttempts of [1, 3]) {
        const label = `${stamp}, maxAttempts: ${maxAttempts}`
        let conflicts = 0
        sbp('chelonia/configure', {
          connectionURL: 'https://example.test',
          fetch: replyRestamped(stamp, { status: 412, headers: { etag: 'e' } })
        } as Partial<CheloniaConfig>)

        await assert.rejects(
          () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
            signingKeyId,
            maxAttempts,
            onconflict: async (): Promise<[JSONType, string | undefined]> => {
              conflicts++
              return [{ x: 2 }, undefined]
            }
          }),
          (e: unknown) => isKvHeightMalformed(e) && !isKvConflict(e) &&
            e instanceof ChelErrorInvalidMessageHeight,
          label
        )
        assert.strictEqual(conflicts, 0, label)
      }
    }
  })

  it("allowUnverifiedConflict passes a malformed stamp as 'malformed', so it can be overwritten", async () => {
    const { contractID, signingKeyId } = setupContract()
    const seen: unknown[] = []
    const posted: string[] = []
    const conflict = replyRestamped('01', { status: 412, headers: { etag: 'e1' } })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        posted.push(JSON.parse(opts!.body!)._signedData[0])
        if (posted.length === 1) return conflict(url, opts)
        return new Response(null, { status: 204, headers: { etag: 'e2' } })
      }
    } as Partial<CheloniaConfig>)

    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      allowUnverifiedConflict: true,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        assert.throws(
          () => args.currentData,
          (e: unknown) => isKvHeightMalformed(e)
        )
        seen.push([args.currentStatus, args.requiredHeight, args.currentValue, args.etag])
        return [{ x: 2 }, args.etag ?? undefined]
      }
    })
    assert.deepStrictEqual(seen, [['malformed', undefined, undefined, 'e1']])
    assert.deepStrictEqual(result, { etag: 'e2' })
    assert.strictEqual(posted.length, 2)
    assert.deepStrictEqual(JSON.parse(posted[1]), { x: 2 })
  })

  it('reports the height error when attempts run out on a value that is ahead', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: replyRestamped('5', { status: 412, headers: { etag: 'e5' } })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 1,
        onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, undefined]
      }),
      (e: unknown) => kvHeightAheadCause(e)?.requiredHeight === 5
    )
  })

  it("the height error of attempts that ran out carries the last 412's etag, not an earlier one's", async () => {
    const { contractID, signingKeyId } = setupContract()
    let posts = 0
    const verifiable = replyRestamped('1', { status: 412, headers: { etag: 'e1' } })
    const ahead = replyRestamped('5', { status: 412 })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        posts++
        return (posts === 1 ? verifiable : ahead)(url, opts)
      }
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 2,
        onconflict: async ({ etag }: ConflictArgs): Promise<[JSONType, string | undefined]> =>
          [{ x: 2 }, etag ?? undefined]
      }),
      (e: unknown) => isKvHeightAhead(e) && kvHeightAheadCause(e)?.etag === null
    )
    assert.strictEqual(posts, 2)
  })

  it('a blind writer reports running out of attempts on a value that is ahead as a conflict', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: replyRestamped('5', { status: 412, headers: { etag: 'e5' } }, () => { posts++ })
    } as Partial<CheloniaConfig>)

    const started = Date.now()
    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        maxAttempts: 2,
        allowUnverifiedConflict: true,
        onconflict: async ({ etag }: ConflictArgs): Promise<[JSONType, string | undefined]> =>
          [{ x: 2 }, etag ?? undefined]
      }),
      (e: unknown) => {
        assert.strictEqual(isKvConflict(e), true)
        assert.strictEqual(isKvHeightAhead(e), false)
        assert.deepStrictEqual((e as Error).cause, {
          currentStatus: 'ahead', requiredHeight: 5, etag: 'e5'
        })
        return true
      }
    )
    // Without a passive wait for the value's height: the merge doesn't
    // depend on it.
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
    assert.strictEqual(posts, 2)
  })

  // The wait for the height of a 412 that is ahead (here up to 10 s: no
  // pubsub client, so it isn't skipped) ends with the call.
  for (const by of ['reset', 'signal'] as const) {
    const what = by === 'reset' ? 'chelonia/reset' : "the caller's signal"
    it(`rejects as soon as ${what} aborts the wait for a 412's height, not when the wait ends`, async () => {
      const contract = setupContract()
      const ahead = await signedBodyAt(
        contract.contractID, contract.signingKeyId, 'settings', { x: 0 }, 5
      )
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
      await abortDuringWait(
        by,
        contract,
        () => new Response(ahead, { status: 412, headers: { etag: 'e5' } }),
        { onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, undefined] }
      )
    })
  }

  // The cause describes the response that revealed the height gap: the
  // recovery GET, with its own etag and status (not the 412's), on a
  // conflict with attempts left as on the last one.
  for (const maxAttempts of [undefined, 1]) {
    it(`recovery GET with a value that is ahead rejects with the GET's etag and status (maxAttempts: ${maxAttempts})`, async () => {
      const { contractID, signingKeyId } = setupContract()
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
      let capturedBody = ''
      let posts = 0
      let gets = 0
      let conflicts = 0
      sbp('chelonia/configure', {
        connectionURL: 'https://example.test',
        fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
          if (opts?.method === 'POST') {
            posts++
            capturedBody ||= opts.body ?? ''
            return new Response('', { status: 412 })
          }
          gets++
          const ahead = { ...JSON.parse(capturedBody), height: '5' }
          return new Response(JSON.stringify(ahead), {
            status: 200,
            headers: { etag: 'etag-recovered' }
          })
        }
      } as Partial<CheloniaConfig>)

      await assert.rejects(
        () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          maxAttempts,
          onconflict: async (): Promise<[JSONType, string | undefined]> => {
            conflicts++
            return [{ x: 2 }, undefined]
          }
        }), 'kv/set'),
        (e: unknown) => {
          assert.deepStrictEqual(kvHeightAheadCause(e), {
            requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-recovered', httpStatus: 200
          })
          return true
        }
      )
      assert.strictEqual(posts, 1)
      assert.strictEqual(gets, 1)
      assert.strictEqual(conflicts, 0)
    })
  }

  it("the conflict cause reports the last 412's etag, or null when it carried none", async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    for (const lastEtag of [undefined, '"cid-last"']) {
      let posts = 0
      sbp('chelonia/configure', {
        connectionURL: 'https://example.test',
        // The first 412 carries a value and an etag; the second (the last
        // attempt's) a body that can't be read, with or without an etag.
        fetch: async () => ++posts === 1
          ? new Response(stored, { status: 412, headers: { etag: '"cid-1"' } })
          : new Response('not json', { status: 412, headers: lastEtag ? { etag: lastEtag } : {} })
      } as Partial<CheloniaConfig>)

      await assert.rejects(
        () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          maxAttempts: 2,
          onconflict: async ({ etag }: ConflictArgs): Promise<[JSONType, string | undefined]> =>
            [{ x: 2 }, etag ?? undefined]
        }), 'kv/set'),
        (e: unknown) => {
          assert.ok(isKvConflict(e))
          assert.deepStrictEqual((e as { cause?: unknown }).cause, { etag: lastEtag ?? null })
          return true
        },
        String(lastEtag)
      )
      assert.strictEqual(posts, 2)
    }
  })

  it('stops before onconflict when chelonia/reset aborts during the backoff', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    Math.random = () => 0.2 // a ~300 ms backoff before onconflict
    let resetting: Promise<unknown> | undefined
    let resetTimer: ReturnType<typeof setTimeout> | undefined
    let conflicts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: { signal?: AbortSignal }) => {
        opts.signal?.throwIfAborted()
        // `reset` waits for the contracts' lanes (none here), aborts the
        // global signal, which ends the backoff at once, then waits in its
        // persistence hook: the write must not reach `onconflict` meanwhile.
        resetTimer ??= setTimeout(() => {
          resetting = sbp('chelonia/reset', () => sleep(500))
          // Awaited below; an early rejection mustn't be unhandled meanwhile.
          resetting!.catch(() => {})
        }, 50)
        return new Response(stored, { status: 412, headers: { etag: '"cid-1"' } })
      }
    } as unknown as Partial<CheloniaConfig>)

    // Cancels a reset that hasn't started, and awaits one that has, even
    // when an assertion fails, so that it doesn't run into the next test.
    try {
      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          onconflict: async (): Promise<[JSONType, string | undefined]> => {
            conflicts++
            return [{ x: 2 }, undefined]
          }
        }),
        { name: 'AbortError' }
      )
      assert.strictEqual(conflicts, 0)
    } finally {
      clearTimeout(resetTimer)
      await within(resetting ?? Promise.resolve(), 'chelonia/reset')
    }
  })

  for (const by of ['reset', 'signal'] as const) {
    const what = by === 'reset' ? 'chelonia/reset' : "the caller's signal"
    it(`rejects as soon as ${what} aborts the backoff, not when the backoff ends`, async () => {
      const contract = setupContract()
      const stored = await signedBodyAt(
        contract.contractID, contract.signingKeyId, 'settings', { x: 7 }, 1
      )
      Math.random = () => 0.9999 // a ~1500 ms backoff before onconflict
      await abortDuringWait(
        by,
        contract,
        () => new Response(stored, { status: 412, headers: { etag: '"cid-1"' } }),
        { onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, undefined] }
      )
    })
  }
})

// A 409 means the server accepted the `if-match` precondition but not the
// height stamp (KV-REVAMPED.md §3.4), so `kv/set` signs the same data again
// once the local contract has moved past the stamp.
describe('chelonia/kv/set on 409', () => {
  useKvSetHooks()

  const signedMessage = (body: string): string => JSON.parse(body)._signedData[0]

  it('re-signs the same data at the new height (no onconflict needed)', async () => {
    const { contractID, signingKeyId } = setupContract()
    type Post = { body: string; height: string; message: string; ifMatch: string | null }
    const posts: Post[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: { body: string; headers: Headers }) => {
        const body = JSON.parse(opts.body)
        posts.push({
          body: opts.body,
          height: body.height,
          message: signedMessage(opts.body),
          ifMatch: new Headers(opts.headers).get('if-match')
        })
        if (posts.length === 1) {
          setContractHeightLater(contractID, 2, 20)
          return new Response('', { status: 409, headers: { etag: '"cid-0"' } })
        }
        return new Response(null, { status: 204, headers: { etag: '"cid-1"' } })
      }
    } as unknown as Partial<CheloniaConfig>)

    // No `onconflict` at all: a 409 doesn't need one.
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      ifMatch: '"cid-0"'
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: '"cid-1"' })
    assert.deepStrictEqual(posts.map((p) => p.height), ['1', '2'])
    assert.strictEqual(posts[0].message, posts[1].message)
    assert.deepStrictEqual(posts.map((p) => p.ifMatch), ['"cid-0"', '"cid-0"'])
    // Signed again, for the new height: reusing the first signature would
    // only change the unsigned stamp, and the body wouldn't verify.
    const signatureOf = (body: string): string => JSON.parse(body)._signedData[2]
    assert.notStrictEqual(signatureOf(posts[0].body), signatureOf(posts[1].body))
    assert.deepStrictEqual(sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
      contractID, serializedData: JSON.parse(posts[1].body), meta: 'settings'
    }).data, { x: 1 })
  })

  it('never calls onconflict for a 409', async () => {
    const { contractID, signingKeyId } = setupContract()
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        if (++posts === 1) {
          setContractHeightLater(contractID, 2, 20)
          return new Response('', { status: 409 })
        }
        return new Response(null, { status: 204 })
      }
    } as Partial<CheloniaConfig>)

    await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async () => {
        throw new Error('onconflict must not be called for a 409')
      }
    }), 'kv/set')
    assert.strictEqual(posts, 2)
  })

  it('rejects with a height error when the local height does not move', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        posts++
        return new Response('', { status: 409, headers: { etag: '"cid-0"' } })
      }
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, { signingKeyId }), 'kv/set'),
      (e: unknown) => {
        assert.ok(isKvHeightAhead(e))
        assert.deepStrictEqual(kvHeightAheadCause(e), {
          requiredHeight: 2, exact: false, localHeight: 1, etag: '"cid-0"', httpStatus: 409
        })
        // A 409 only gives a lower bound, and may carry no stored value.
        assert.ok((e as Error).message.includes(
          'the server requires a contract height of at least 2, but the local contract is at height 1;'
        ), (e as Error).message)
        return true
      }
    )
    assert.strictEqual(posts, 1)
  })

  // The passive wait after a 409 (here up to 10 s: no pubsub client, so
  // it isn't skipped) ends with the call.
  for (const by of ['reset', 'signal'] as const) {
    const what = by === 'reset' ? 'chelonia/reset' : "the caller's signal"
    it(`rejects as soon as ${what} aborts the passive wait, not when the wait ends`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
      await abortDuringWait(by, setupContract(), () => new Response('', { status: 409 }))
    })
  }

  it('uses the stored value height as the lower bound when it is higher', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 4)
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(stored, { status: 409, headers: { etag: '"cid-4"' } })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        ifMatch: '"cid-4"'
      }), 'kv/set'),
      (e: unknown) => kvHeightAheadCause(e)?.requiredHeight === 4
    )
  })

  it('reports the height error when the stale-stamp retries run out', async () => {
    const { contractID, signingKeyId } = setupContract()
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        const n = ++posts
        // The server keeps moving one event ahead of us, also past the last
        // allowed re-sign: only the retry limit can end the call at this
        // POST (without it, the next POST would go out and require one more
        // height). `setContractHeightLater` ignores a timer that outlives the
        // test.
        if (n <= KV_MAX_STALE_STAMP_RETRIES + 1) setContractHeightLater(contractID, n + 1, 5)
        return new Response('', { status: 409 })
      }
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        // A 409 isn't a conflict: it doesn't use up conflict attempts.
        maxAttempts: 1
      }), 'kv/set'),
      (e: unknown) => {
        const cause = kvHeightAheadCause(e)
        assert.strictEqual(cause?.exact, false)
        assert.strictEqual(cause?.requiredHeight, KV_MAX_STALE_STAMP_RETRIES + 2)
        return true
      }
    )
    assert.strictEqual(posts, KV_MAX_STALE_STAMP_RETRIES + 1)
  })

  // 409 (stale height stamp) and 412 (conflict) retries have separate
  // budgets: `maxAttempts` only counts conflicts.
  const scriptedConflicts = (
    contractID: string,
    script: Array<{ status: 409 } | { status: 412; body: string } | { status: 204 }>
  ) => {
    const heights: string[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: { body: string }) => {
        heights.push(JSON.parse(opts.body).height)
        const step = script[heights.length - 1]
        if (!step) throw new Error(`unexpected request #${heights.length}`)
        if (step.status === 409) {
          // The client catches up with the server shortly after.
          setContractHeightLater(contractID, Number(heights[heights.length - 1]) + 1, 5)
          return new Response('', { status: 409 })
        }
        if (step.status === 412) {
          return new Response(step.body, {
            status: 412, headers: { etag: `"cid-${heights.length}"` }
          })
        }
        return new Response(null, { status: 204, headers: { etag: '"cid-final"' } })
      }
    } as unknown as Partial<CheloniaConfig>)
    return heights
  }
  const mergeX = (seen: unknown[]) => async (
    args: ConflictArgs
  ): Promise<[JSONType, string | undefined]> => {
    seen.push([args.currentStatus, args.currentData, args.etag])
    return [{ x: 8 }, args.etag ?? undefined]
  }

  it('409s before a 412 do not use up the conflict attempts', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 3)
    const heights = scriptedConflicts(contractID, [
      { status: 409 }, { status: 409 }, { status: 412, body: stored }, { status: 204 }
    ])
    const seen: unknown[] = []
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, ifMatch: '"cid-0"', maxAttempts: 2, onconflict: mergeX(seen)
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: '"cid-final"' })
    assert.deepStrictEqual(seen, [['present', { x: 7 }, '"cid-3"']])
    assert.deepStrictEqual(heights, ['1', '2', '3', '3'])
  })

  it('a 409 after conflicts does not end the call with a height error', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    const heights = scriptedConflicts(contractID, [
      { status: 412, body: stored }, { status: 412, body: stored }, { status: 409 }, { status: 204 }
    ])
    const seen: unknown[] = []
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, onconflict: mergeX(seen)
    }), 'kv/set')
    assert.deepStrictEqual(result, { etag: '"cid-final"' })
    assert.strictEqual(seen.length, 2)
    assert.deepStrictEqual(heights, ['1', '1', '1', '2'])
  })

  it('reports a conflict when attempts run out on a 412 that follows a 409', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored1 = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    const stored2 = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 9 }, 2)
    const heights = scriptedConflicts(contractID, [
      { status: 412, body: stored1 }, { status: 409 }, { status: 412, body: stored2 }
    ])
    const seen: unknown[] = []
    await assert.rejects(
      () => within(sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 2, onconflict: mergeX(seen)
      }), 'kv/set'),
      (e: unknown) => isKvConflict(e) &&
        assert.deepStrictEqual(
          (e as { cause?: unknown }).cause,
          { currentData: { x: 9 }, currentStatus: 'present', etag: '"cid-3"' }
        ) === undefined
    )
    assert.deepStrictEqual(seen, [['present', { x: 7 }, '"cid-1"']])
    assert.deepStrictEqual(heights, ['1', '1', '2'])
  })
})

// With no `data`, `kv/set` reads the current value first (a GET) and lets
// `onconflict` compute the value to write.
describe('chelonia/kv/set fetch-first (no data)', () => {
  useKvSetHooks()

  type RecordedRequest = { method: string; ifMatch: string | null; body?: string }
  type FetchOptions = { method?: string; body?: string; headers?: Headers }
  // Records each request, and answers it with `respond(request)`.
  const recordRequests = (respond: (req: RecordedRequest) => Response) => {
    const requests: RecordedRequest[] = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: FetchOptions = {}) => {
        const req = {
          method: opts.method ?? 'GET',
          ifMatch: opts.headers?.get('if-match') ?? null,
          body: opts.body
        }
        requests.push(req)
        return respond(req)
      }
    } as unknown as Partial<CheloniaConfig>)
    return requests
  }
  const postedData = (req: RecordedRequest): unknown =>
    JSON.parse(JSON.parse(req.body!)._signedData[0])
  const postedHeight = (req: RecordedRequest): string => JSON.parse(req.body!).height
  const written = () => new Response(null, { status: 204, headers: { etag: '"cid-new"' } })

  it("calls onconflict with 'absent' for a missing value, then writes with an empty if-match", async () => {
    const { contractID, signingKeyId } = setupContract()
    const seen: unknown[] = []
    const requests = recordRequests((req) =>
      req.method === 'GET' ? new Response(null, { status: 404 }) : written()
    )
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', undefined, {
      signingKeyId,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        seen.push([args.status, args.currentStatus, args.currentData, args.etag])
        return [{ x: 1 }, args.etag ?? undefined]
      }
    }), 'kv/set')
    assert.deepStrictEqual(seen, [[404, 'absent', undefined, null]])
    assert.deepStrictEqual(requests.map((r) => [r.method, r.ifMatch]), [['GET', null], ['POST', '""']])
    assert.deepStrictEqual(postedData(requests[1]), { x: 1 })
    assert.deepStrictEqual(result, { etag: '"cid-new"' })
  })

  it('passes the current value and its etag to onconflict, and writes with that etag', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    const seen: unknown[] = []
    const requests = recordRequests((req) => req.method === 'GET'
      ? new Response(stored, { status: 200, headers: { etag: '"cid-7"' } })
      : written()
    )
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', undefined, {
      signingKeyId,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: (args.currentData as { x: number }).x + 1 }, args.etag ?? undefined]
      }
    }), 'kv/set')
    assert.deepStrictEqual(seen, [['present', { x: 7 }, '"cid-7"']])
    assert.deepStrictEqual(requests.map((r) => [r.method, r.ifMatch]), [['GET', null], ['POST', '"cid-7"']])
    assert.deepStrictEqual(postedData(requests[1]), { x: 8 })
    assert.deepStrictEqual(result, { etag: '"cid-new"' })
  })

  it('waits for a value that is ahead, then passes it to onconflict decoded', async () => {
    const { contractID, signingKeyId } = setupContract()
    // Long enough that a wait ended by its timeout fails the timing check.
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 3000 })
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 3)
    const seen: unknown[] = []
    const requests = recordRequests((req) => {
      if (req.method !== 'GET') return written()
      // The local contract reaches the value's height shortly after the GET.
      setContractHeightLater(contractID, 3, 50)
      return new Response(stored, { status: 200, headers: { etag: '"cid-7"' } })
    })
    const started = Date.now()
    await within(sbp('chelonia/kv/set', contractID, 'settings', undefined, {
      signingKeyId,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: 8 }, args.etag ?? undefined]
      }
    }), 'kv/set')
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 40 && elapsed < 1500, `took ${elapsed} ms`)
    assert.deepStrictEqual(seen, [['present', { x: 7 }, '"cid-7"']])
    assert.deepStrictEqual(requests.map((r) => r.method), ['GET', 'POST'])
    assert.strictEqual(postedHeight(requests[1]), '3')
  })

  it('rejects a value that is ahead at once with heightWaitMs: 0, without writing', async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 3)
    let conflicts = 0
    const requests = recordRequests((req) => req.method === 'GET'
      ? new Response(stored, { status: 200, headers: { etag: '"cid-7"' } })
      : written()
    )
    await assert.rejects(
      within(sbp('chelonia/kv/set', contractID, 'settings', undefined, {
        signingKeyId,
        heightWaitMs: 0,
        onconflict: async (): Promise<[JSONType, string | undefined]> => {
          conflicts++
          return [{ x: 8 }, undefined]
        }
      }), 'kv/set'),
      (e: unknown) => {
        assert.ok(isKvHeightAhead(e))
        assert.deepStrictEqual(kvHeightAheadCause(e), {
          requiredHeight: 3, exact: true, localHeight: 1, etag: '"cid-7"', httpStatus: 200
        })
        return true
      }
    )
    assert.strictEqual(conflicts, 0)
    assert.deepStrictEqual(requests.map((r) => r.method), ['GET'])
  })

  it("allowUnverifiedConflict passes a value that is ahead as 'ahead', with a throwing currentData", async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 3)
    const seen: unknown[] = []
    const requests = recordRequests((req) => req.method === 'GET'
      ? new Response(stored, { status: 200, headers: { etag: '"cid-7"' } })
      : written()
    )
    const result = await within(sbp('chelonia/kv/set', contractID, 'settings', undefined, {
      signingKeyId,
      allowUnverifiedConflict: true,
      onconflict: async (args: ConflictArgs): Promise<[JSONType, string | undefined]> => {
        assert.throws(() => args.currentData, (e: unknown) => isKvHeightAhead(e))
        seen.push([args.currentStatus, args.requiredHeight, args.currentValue, args.etag])
        return [{ x: 2 }, args.etag ?? undefined]
      }
    }), 'kv/set')
    assert.deepStrictEqual(seen, [['ahead', 3, undefined, '"cid-7"']])
    assert.deepStrictEqual(requests.map((r) => [r.method, r.ifMatch]), [['GET', null], ['POST', '"cid-7"']])
    assert.deepStrictEqual(postedData(requests[1]), { x: 2 })
    assert.deepStrictEqual(result, { etag: '"cid-new"' })
  })

  it('requires onconflict, and sends no request without one', async () => {
    const { contractID, signingKeyId } = setupContract()
    const requests = recordRequests(() => written())
    await assert.rejects(
      within(sbp('chelonia/kv/set', contractID, 'settings', undefined, { signingKeyId }), 'kv/set'),
      (e: unknown) => e instanceof TypeError &&
        e.message === '[chelonia/kv] set: `onconflict` is required when `data` is undefined'
    )
    assert.strictEqual(requests.length, 0)
  })
})

describe('chelonia/kv/get', () => {
  useKvSetHooks()

  it('rejects with a descriptive height error for height-ahead values', async () => {
    const { contractID, signingKeyId } = setupContract()
    let capturedBody = ''
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        if (opts?.method === 'POST') {
          capturedBody = opts.body ?? ''
          return new Response('', { status: 200, headers: { 'x-cid': 'cid-ok' } })
        }
        const ahead = { ...JSON.parse(capturedBody), height: '5' }
        return new Response(JSON.stringify(ahead), {
          status: 200,
          headers: { etag: 'etag-ahead' }
        })
      }
    } as Partial<CheloniaConfig>)

    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, { signingKeyId })
    await assert.rejects(
      () => sbp('chelonia/kv/get', contractID, 'settings'),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvHeightAhead)
        // Still an `InvalidMessageHeight`, for existing `instanceof` checks,
        // but with its own name: name-based checks use `isKvHeightAhead`.
        assert.ok(e instanceof ChelErrorInvalidMessageHeight)
        assert.strictEqual((e as Error).name, 'ChelErrorKvHeightAhead')
        assert.ok(isKvHeightAhead(e))
        assert.strictEqual(kvHeightAheadCause(e)?.requiredHeight, 5)
        assert.ok((e as Error).message.includes('sync the contract and retry'))
        assert.deepStrictEqual((e as Error).cause, {
          requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-ahead', httpStatus: 200
        })
        return true
      }
    )
  })

  it('says the local contract is not loaded when its height is unknown', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 1 }, 5)
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(stored, { status: 200 })
    } as Partial<CheloniaConfig>)
    const rootState = sbp('chelonia/private/state') as ChelRootState
    ;(rootState.contracts[contractID] as { height?: number }).height = undefined

    await assert.rejects(
      () => sbp('chelonia/kv/get', contractID, 'settings'),
      (e: unknown) => isKvHeightAhead(e) &&
        /the server value was written at contract height 5, but the local contract is not loaded;/
          .test((e as Error).message)
    )
  })

  it('reports a malformed height stamp as an invalid height, not as ahead', async () => {
    const { contractID, signingKeyId } = setupContract()
    let capturedBody = ''
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts?: { method?: string; body?: string }) => {
        if (opts?.method === 'POST') {
          capturedBody = opts.body ?? ''
          return new Response(null, { status: 204 })
        }
        const bad = { ...JSON.parse(capturedBody), height: '-3' }
        return new Response(JSON.stringify(bad), { status: 200 })
      }
    } as Partial<CheloniaConfig>)

    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, { signingKeyId })
    await assert.rejects(
      () => sbp('chelonia/kv/get', contractID, 'settings'),
      (e: unknown) => {
        assert.ok(isKvHeightMalformed(e))
        assert.ok(!isKvHeightAhead(e))
        assert.ok(e instanceof ChelErrorInvalidMessageHeight)
        return true
      }
    )
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
