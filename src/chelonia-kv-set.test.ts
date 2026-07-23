import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import './chelonia.js'
import './internals.js'
import { ChelErrorInvalidMessageHeight } from './errors.js'
import { ChelErrorKvMaxAttempts } from './internal-errors.js'
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

describe('chelonia/kv/set', () => {
  beforeEach(() => {
    sbp('chelonia/_init')
  })

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
        return new Response('', { status: method === 'POST' ? 409 : 404 })
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
      (e: unknown) => e instanceof ChelErrorInvalidMessageHeight &&
        (e as Error).message.includes('sync the contract and retry')
    )
  })
})
