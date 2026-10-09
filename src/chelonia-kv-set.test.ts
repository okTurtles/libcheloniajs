import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorKvConflict,
  ChelErrorKvHeightAhead,
  ChelErrorUnexpectedHttpResponseCode,
  isKvConflict,
  isKvHeightAhead,
  kvHeightAheadCause
} from './errors.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
import { KV_MAX_STALE_STAMP_RETRIES } from './kv-height.js'
import { setLocalHeightLater, sleep, useKvSetHooks, withLocalHeight } from './test-utils.js'
import type { ChelRootState, CheloniaConfig, JSONType } from './types.js'

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

// A `fetch` that answers every request with the first body POSTed in the
// test, re-stamped at `height` (e.g. a value the local contract can't
// verify yet, or a malformed stamp).
const replyRestamped = (
  height: string,
  init: ConstructorParameters<typeof Response>[1],
  onRequest?: (opts?: { method?: string; body?: string }) => void
) => {
  let captured = ''
  return async (_url: string, opts?: { method?: string; body?: string }) => {
    onRequest?.(opts)
    captured ||= opts?.body ?? ''
    return new Response(JSON.stringify({ ...JSON.parse(captured), height }), init)
  }
}

describe('chelonia/kv/set', () => {
  // Scoped to this describe rather than registered at module scope, so the
  // re-init only wraps this suite's tests.
  useKvSetHooks()

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
      (e: unknown) => e instanceof ChelErrorKvMaxAttempts &&
        (e as { cause?: { etag?: string | null } }).cause?.etag === 'etag-1'
    )
  })

  it('preserves recovered currentData when final conflict is body-less', async () => {
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
          (e as { cause?: { currentData?: JSONType; etag?: string | null } }).cause,
          { currentData: { x: 1 }, etag: 'etag-current' }
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
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        onconflict: async (): Promise<[JSONType, string | undefined]> => {
          conflicts++
          return [{ x: 2 }, undefined]
        }
      }),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvHeightAhead)
        assert.ok(e instanceof ChelErrorInvalidMessageHeight)
        assert.deepStrictEqual((e as Error).cause, {
          requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-ahead', status: 412
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
          setLocalHeightLater(contractID, 2, 20)
          return new Response(stored, { status: 412, headers: { etag: 'etag-2' } })
        }
        return new Response(null, { status: 204, headers: { etag: 'etag-3' } })
      }
    } as Partial<CheloniaConfig>)

    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (args: {
        currentStatus: string; currentData: JSONType | undefined; etag: string | null | undefined
      }): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: 8 }, args.etag ?? undefined]
      }
    }) as { etag: string | null }

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
      onconflict: async (args: {
        currentStatus: string;
        requiredHeight?: number;
        currentData: JSONType | undefined;
        currentValue: unknown;
        etag: string | null | undefined;
      }): Promise<[JSONType, string | undefined]> => {
        assert.throws(() => args.currentData, ChelErrorKvHeightAhead)
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
      onconflict: async (args: {
        currentStatus: string; currentData: JSONType | undefined; etag: string | null | undefined
      }): Promise<[JSONType, string | undefined]> => {
        seen.push([args.currentStatus, args.currentData, args.etag])
        return [{ x: 2 }, args.etag ?? undefined]
      }
    })
    assert.deepStrictEqual(seen, [['absent', undefined, '""']])
  })

  it("reports 'present' for a value verified lazily: currentData can still throw", async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = JSON.parse(await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1))
    const other = JSON.parse(await signedBodyAt(contractID, signingKeyId, 'settings', { x: 6 }, 1))
    // The payload no longer matches its signature.
    stored._signedData[0] = other._signedData[0]
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(JSON.stringify(stored), {
        status: 412, headers: { etag: '"cid-1"' }
      })
    } as Partial<CheloniaConfig>)

    const seen: unknown[] = []
    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async (args: { currentStatus: string; currentData: JSONType | undefined }) => {
        let readError: Error | undefined
        try {
          assert.notStrictEqual(args.currentData, undefined)
        } catch (e) {
          readError = e as Error
        }
        seen.push([args.currentStatus, readError?.name])
        return false
      }
    })
    assert.deepStrictEqual(seen, [['present', 'ChelErrorSignatureError']])
  })

  it('rejects a malformed height stamp instead of treating the value as absent', async () => {
    const { contractID, signingKeyId } = setupContract()
    // '01' is how a server comparing `Number(stamp)` sees height 1.
    for (const stamp of ['not-a-height', '01']) {
      let conflicts = 0
      sbp('chelonia/configure', {
        connectionURL: 'https://example.test',
        fetch: replyRestamped(stamp, { status: 412, headers: { etag: 'e' } })
      } as Partial<CheloniaConfig>)

      await assert.rejects(
        () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
          signingKeyId,
          onconflict: async (): Promise<[JSONType, string | undefined]> => {
            conflicts++
            return [{ x: 2 }, undefined]
          }
        }),
        (e: unknown) => e instanceof ChelErrorInvalidMessageHeight &&
          !(e instanceof ChelErrorKvHeightAhead),
        stamp
      )
      assert.strictEqual(conflicts, 0, stamp)
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
      onconflict: async (args: {
        currentStatus: string;
        requiredHeight?: number;
        currentData: JSONType | undefined;
        currentValue: unknown;
        etag: string | null | undefined;
      }): Promise<[JSONType, string | undefined]> => {
        assert.throws(
          () => args.currentData,
          (e: unknown) => e instanceof ChelErrorInvalidMessageHeight &&
            !(e instanceof ChelErrorKvHeightAhead)
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
      (e: unknown) => e instanceof ChelErrorKvHeightAhead &&
        (e as { cause: { requiredHeight: number } }).cause.requiredHeight === 5
    )
  })

  it("the wait for the height honours the caller's signal", async () => {
    const { contractID, signingKeyId } = setupContract()
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 10000 })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: replyRestamped('5', { status: 412, headers: { etag: 'e5' } })
    } as Partial<CheloniaConfig>)

    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(new Error('caller gave up')), 30)
    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        signal: controller.signal,
        onconflict: async (): Promise<[JSONType, string | undefined]> => [{ x: 2 }, undefined]
      }),
      (e: unknown) => (e as Error).message === 'caller gave up'
    )
    assert.ok(Date.now() - started < 5000)
  })

  it('recovery GET with a value that is ahead rejects with its etag', async () => {
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
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        onconflict: async (): Promise<[JSONType, string | undefined]> => {
          conflicts++
          return [{ x: 2 }, undefined]
        }
      }),
      (e: unknown) => e instanceof ChelErrorKvHeightAhead &&
        (e as { cause: { etag: string } }).cause.etag === 'etag-recovered'
    )
    assert.strictEqual(posts, 1)
    assert.strictEqual(gets, 1)
    assert.strictEqual(conflicts, 0)
  })

  it('stops before onconflict when chelonia/reset aborts during the backoff', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 1)
    Math.random = () => 0.2 // a ~300 ms backoff before onconflict
    let resetting: Promise<unknown> | undefined
    let conflicts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: { signal?: AbortSignal }) => {
        opts.signal?.throwIfAborted()
        // `reset` aborts the global signal right away, then waits in its
        // persistence hook while the backoff is still running.
        setTimeout(() => { resetting = sbp('chelonia/reset', () => sleep(500)) }, 50)
        return new Response(stored, { status: 412, headers: { etag: '"cid-1"' } })
      }
    } as unknown as Partial<CheloniaConfig>)

    // Awaits the reset even when an assertion fails, so it doesn't run into
    // the next test.
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
      await resetting
    }
  })
})

// A 409 means the server accepted the `if-match` precondition but not the
// height stamp (KV-REVAMPED.md §3.4), so `kv/set` signs the same data again
// once the local contract has moved past the stamp.
describe('chelonia/kv/set on 409', () => {
  useKvSetHooks()

  const signedMessage = (body: string): string => JSON.parse(body)._signedData[0]

  it('re-signs the same data at the new height without calling onconflict', async () => {
    const { contractID, signingKeyId } = setupContract()
    const posts: Array<{ height: string; message: string; ifMatch: string | null }> = []
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async (_url: string, opts: { body: string; headers: Headers }) => {
        const body = JSON.parse(opts.body)
        posts.push({
          height: body.height,
          message: signedMessage(opts.body),
          ifMatch: new Headers(opts.headers).get('if-match')
        })
        if (posts.length === 1) {
          setLocalHeightLater(contractID, 2, 20)
          return new Response('', { status: 409, headers: { etag: '"cid-0"' } })
        }
        return new Response(null, { status: 204, headers: { etag: '"cid-1"' } })
      }
    } as unknown as Partial<CheloniaConfig>)

    // No `onconflict` at all: a 409 doesn't need one.
    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      ifMatch: '"cid-0"'
    })
    assert.deepStrictEqual(result, { etag: '"cid-1"' })
    assert.deepStrictEqual(posts.map((p) => p.height), ['1', '2'])
    assert.strictEqual(posts[0].message, posts[1].message)
    assert.deepStrictEqual(posts.map((p) => p.ifMatch), ['"cid-0"', '"cid-0"'])
  })

  it('never calls onconflict for a 409', async () => {
    const { contractID, signingKeyId } = setupContract()
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        if (++posts === 1) {
          setLocalHeightLater(contractID, 2, 20)
          return new Response('', { status: 409 })
        }
        return new Response(null, { status: 204 })
      }
    } as Partial<CheloniaConfig>)

    await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId,
      onconflict: async () => {
        throw new Error('onconflict must not be called for a 409')
      }
    })
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
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, { signingKeyId }),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvHeightAhead)
        assert.deepStrictEqual((e as Error).cause, {
          requiredHeight: 2, exact: false, localHeight: 1, etag: '"cid-0"', status: 409
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

  it('uses the stored value height as the lower bound when it is higher', async () => {
    const { contractID, signingKeyId } = setupContract()
    const stored = await signedBodyAt(contractID, signingKeyId, 'settings', { x: 7 }, 4)
    sbp('chelonia/kv/_testSetHeightTimings', { waitMs: 30 })
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => new Response(stored, { status: 409, headers: { etag: '"cid-4"' } })
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        ifMatch: '"cid-4"'
      }),
      (e: unknown) => e instanceof ChelErrorKvHeightAhead &&
        (e as { cause: { requiredHeight: number } }).cause.requiredHeight === 4
    )
  })

  it('reports the height error when the stale-stamp retries run out', async () => {
    const { contractID, signingKeyId } = setupContract()
    let posts = 0
    sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      fetch: async () => {
        const n = ++posts
        // The server keeps moving one event ahead of us, until the retries
        // run out (no timer outlives the test).
        if (n <= KV_MAX_STALE_STAMP_RETRIES) setLocalHeightLater(contractID, n + 1, 5)
        return new Response('', { status: 409 })
      }
    } as Partial<CheloniaConfig>)

    await assert.rejects(
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId,
        // A 409 isn't a conflict: it doesn't use up conflict attempts.
        maxAttempts: 1
      }),
      (e: unknown) => {
        assert.ok(e instanceof ChelErrorKvHeightAhead)
        const cause = (e as { cause: { exact: boolean; requiredHeight: number } }).cause
        assert.strictEqual(cause.exact, false)
        assert.strictEqual(cause.requiredHeight, KV_MAX_STALE_STAMP_RETRIES + 2)
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
        if (step.status === 409) {
          // The client catches up with the server shortly after.
          setLocalHeightLater(contractID, Number(heights[heights.length - 1]) + 1, 5)
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
  const mergeX = (seen: unknown[]) => async (args: {
    currentStatus: string; currentData: JSONType | undefined; etag: string | null | undefined
  }): Promise<[JSONType, string | undefined]> => {
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
    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, ifMatch: '"cid-0"', maxAttempts: 2, onconflict: mergeX(seen)
    })
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
    const result = await sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
      signingKeyId, onconflict: mergeX(seen)
    })
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
      () => sbp('chelonia/kv/set', contractID, 'settings', { x: 1 }, {
        signingKeyId, maxAttempts: 2, onconflict: mergeX(seen)
      }),
      (e: unknown) => e instanceof ChelErrorKvMaxAttempts &&
        assert.deepStrictEqual(
          (e as { cause?: { currentData?: JSONType; etag?: string | null } }).cause,
          { currentData: { x: 9 }, etag: '"cid-3"' }
        ) === undefined
    )
    assert.deepStrictEqual(seen, [['present', { x: 7 }, '"cid-1"']])
    assert.deepStrictEqual(heights, ['1', '1', '2'])
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
          requiredHeight: 5, exact: true, localHeight: 1, etag: 'etag-ahead', status: 200
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
      (e: unknown) => e instanceof ChelErrorKvHeightAhead &&
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
      (e: unknown) => e instanceof ChelErrorInvalidMessageHeight &&
        !(e instanceof ChelErrorKvHeightAhead)
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

describe('isKvHeightAhead / kvHeightAheadCause / isKvConflict', () => {
  it('isKvHeightAhead matches by name, so errors from another copy of the library match', () => {
    const foreign = Object.assign(new Error('from another bundle'), {
      name: 'ChelErrorKvHeightAhead',
      cause: { requiredHeight: 7, exact: true, localHeight: 3, etag: null, status: 200 }
    })
    assert.ok(isKvHeightAhead(foreign))
    assert.strictEqual(kvHeightAheadCause(foreign)?.requiredHeight, 7)
    assert.ok(!isKvHeightAhead(new ChelErrorInvalidMessageHeight('malformed')))
    assert.strictEqual(kvHeightAheadCause(new Error('other')), undefined)
    assert.ok(!isKvHeightAhead(undefined))
  })

  it("isKvHeightAhead matches a slot's lastError, which has no cause", () => {
    const lastError = { name: 'ChelErrorKvHeightAhead', message: 'ahead' }
    assert.ok(isKvHeightAhead(lastError))
    assert.strictEqual(lastError.cause, undefined)
    assert.strictEqual(kvHeightAheadCause(lastError), undefined)
  })

  it('isKvConflict matches both conflict errors by name', () => {
    assert.ok(isKvConflict(new ChelErrorKvConflict('conflict')))
    assert.ok(isKvConflict(new ChelErrorKvMaxAttempts('raw kv/set')))
    for (const name of ['ChelErrorKvConflict', 'ChelErrorKvMaxAttempts']) {
      // E.g. from another copy of the library.
      assert.ok(isKvConflict(Object.assign(new Error('foreign'), { name })), name)
      assert.ok(isKvConflict({ name, message: 'plain object' }), name)
    }
    assert.ok(!isKvConflict(new ChelErrorKvHeightAhead('ahead')))
    assert.ok(!isKvConflict(new Error('other')))
    assert.ok(!isKvConflict(undefined))
    assert.ok(!isKvConflict(null))
    assert.ok(!isKvConflict('ChelErrorKvConflict'))
  })
})
