import * as assert from 'node:assert'
import { getEventListeners } from 'node:events'
import { describe, it } from 'node:test'

import * as utils from './utils.js'
import type { CheloniaContext } from './types.js'
import { SPKey, SPKeyUpdate, SPMessage } from './SPMessage.js'

const context = {
  config: {
    unwrapMaybeEncryptedData: (data) => {
      return {
        encryptionKeyId: null,
        data
      }
    }
  }
} as CheloniaContext

describe('Chelonia utils', () => {
  it('should enforce permissions for validateKeyAddPermissions', () => {
    const signingKey = {
      id: 'id',
      name: 'name',
      data: 'data',
      purpose: ['sig'],
      ringLevel: 5,
      permissions: [SPMessage.OP_KEY_ADD],
      _notBeforeHeight: 0
    }
    const state = {
      _vm: {
        type: 'type',
        authorizedKeys: {
          id: signingKey
        }
      }
    }
    const newKey = {
      id: 'new_id',
      name: 'new_name',
      data: 'data',
      purpose: ['sig' as const],
      ringLevel: 5,
      permissions: [SPMessage.OP_KEY_ADD],
      _notBeforeHeight: 0
    }

    const validateKeyAddPermissions = (newKey: SPKey) => utils.validateKeyAddPermissions.call(context, 'cid', signingKey, state, [newKey])

    validateKeyAddPermissions(newKey)

    assert.throws(() => {
      validateKeyAddPermissions({ ...newKey, ringLevel: signingKey.ringLevel - 1 })
    }, /^Error: Signing key has ringLevel/, 'Ring level is not being enforced')

    assert.throws(() => {
      validateKeyAddPermissions({ ...newKey, permissions: '*' })
    }, /^Error: Unable to add or update a key with more permissions than the signing key/, 'Permission escalation')

    assert.throws(() => {
      validateKeyAddPermissions({
        ...newKey,
        permissions: [
          ...newKey.permissions, SPMessage.OP_CONTRACT
        ]
      })
    }, /^Error: Unable to add or update a key with more permissions than the signing key/, 'Permission escalation')

    assert.throws(() => {
      validateKeyAddPermissions({
        ...newKey,
        permissions: [
          SPMessage.OP_CONTRACT
        ]
      })
    }, /^Error: Unable to add or update a key with more permissions than the signing key/, 'Permission escalation')
  })

  it('should enforce permissions for validateKeyUpdatePermissions', () => {
    const signingKey = {
      id: 'id',
      name: 'name',
      data: 'data',
      purpose: ['sig'],
      ringLevel: 5,
      permissions: [SPMessage.OP_KEY_ADD],
      _notBeforeHeight: 0
    }
    const existingKey = {
      id: 'existing',
      name: 'existing_name',
      data: 'data',
      purpose: ['sig'],
      ringLevel: 5,
      permissions: [SPMessage.OP_KEY_DEL],
      _notBeforeHeight: 0
    }
    const state = {
      _vm: {
        type: 'type',
        authorizedKeys: {
          id: signingKey,
          existing: existingKey
        }
      }
    }
    const updatedKey = {
      name: existingKey.name,
      oldKeyId: existingKey.id,
      permissions: []
    }

    const validateKeyUpdatePermissions = (updatedKey: SPKeyUpdate) => utils.validateKeyUpdatePermissions.call(context, 'cid', signingKey, state, [updatedKey])

    validateKeyUpdatePermissions(updatedKey)
    validateKeyUpdatePermissions({
      ...updatedKey,
      permissions: [...updatedKey.permissions, SPMessage.OP_KEY_ADD]
    })

    assert.throws(() => {
      validateKeyUpdatePermissions({
        ...updatedKey,
        permissions: [
          SPMessage.OP_CONTRACT
        ]
      })
    }, /^Error: Unable to add or update a key with more permissions than the signing key/, 'Permission escalation')

    state._vm.authorizedKeys.existing.ringLevel = state._vm.authorizedKeys.id.ringLevel - 1
    assert.throws(() => {
      validateKeyUpdatePermissions(updatedKey)
    }, /^Error: Signing key has ringLevel/, 'Ring level is not being enforced')
  })
})

describe('httpErrorDetail', () => {
  const response = (body: string, contentType?: string) =>
    new Response(body, {
      status: 403,
      headers: contentType ? { 'content-type': contentType } : {}
    })

  it('reads `message` out of a JSON body', async () => {
    const r = response('{"message":"Registration disabled"}', 'application/json')
    assert.strictEqual(await utils.httpErrorDetail(r), 'Registration disabled')
  })

  it('accepts a charset and a +json suffix on the content type', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(
        response('{"message":"with charset"}', 'application/json; charset=utf-8')
      ),
      'with charset'
    )
    assert.strictEqual(
      await utils.httpErrorDetail(
        response('{"message":"problem json"}', 'application/problem+json')
      ),
      'problem json'
    )
  })

  // The `application/` prefix is required, so a `+json` suffix on any other
  // type is read as text rather than parsed.
  it('only treats a +json suffix as JSON under application/', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"message":"not parsed"}', 'text/x+json')),
      '{"message":"not parsed"}'
    )
  })

  // RFC 7807 problem documents put the text in `detail`, not `message`.
  it('falls back to the RFC 7807 detail field', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(
        response('{"title":"Forbidden","detail":"signups are off"}', 'application/problem+json')
      ),
      'signups are off'
    )
    // `message` still wins when both are present
    assert.strictEqual(
      await utils.httpErrorDetail(
        response('{"message":"from message","detail":"from detail"}', 'application/json')
      ),
      'from message'
    )
  })

  // A proxy error page can be kilobytes of HTML, and this text reaches
  // `e.message` and the logs.
  it('truncates a long detail', async () => {
    const long = 'x'.repeat(1000)
    const fromText = await utils.httpErrorDetail(response(long))
    assert.strictEqual(fromText, `${'x'.repeat(512)}…[truncated]`)

    const fromJson = await utils.httpErrorDetail(
      response(JSON.stringify({ message: long }), 'application/json')
    )
    assert.strictEqual(fromJson, `${'x'.repeat(512)}…[truncated]`)
  })

  // The reason for this issue: Hono's HTTPException answers with plain text,
  // so parsing as JSON threw and the status never reached the caller.
  it('reads a plain text body as the message', async () => {
    const r = response('Registration disabled', 'text/plain;charset=UTF-8')
    assert.strictEqual(await utils.httpErrorDetail(r), 'Registration disabled')
  })

  it('reads the body as text when there is no content type', async () => {
    assert.strictEqual(await utils.httpErrorDetail(response('no type here')), 'no type here')
  })

  it('trims a text body and reports an empty one as no detail', async () => {
    assert.strictEqual(await utils.httpErrorDetail(response('  spaced  ')), 'spaced')
    assert.strictEqual(await utils.httpErrorDetail(response('   ')), '')
  })

  it('reports no detail rather than throwing when the body is not what it claims', async () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const r = response('Registration disabled', 'application/json')
      assert.strictEqual(await utils.httpErrorDetail(r), '')
    } finally {
      console.warn = originalWarn
    }
  })

  // `message` is what chel sends, `detail` is RFC 7807, and `error` is common
  // enough elsewhere to be worth reading.
  it('reads the error field when there is no message or detail', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"error":"Rate limit exceeded"}', 'application/json')),
      'Rate limit exceeded'
    )
    // `message` still wins over both
    assert.strictEqual(
      await utils.httpErrorDetail(
        response('{"message":"from message","error":"from error"}', 'application/json')
      ),
      'from message'
    )
  })

  it('reports no detail when a JSON body has no usable message', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"code":"nope"}', 'application/json')),
      ''
    )
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"message":42}', 'application/json')),
      ''
    )
  })

  // The detail goes straight into a log line, so a body that carries newlines
  // or escapes cannot be allowed to forge one.
  it('replaces control characters with spaces', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(response('first\nERROR: forged\u0000line')),
      'first ERROR: forged line'
    )
    assert.strictEqual(
      await utils.httpErrorDetail(
        response(JSON.stringify({ message: '\u001b[31mred\u001b[0m' }), 'application/json')
      ),
      '[31mred [0m'
    )
  })

  // Reading is capped too, so a hostile relay cannot make the client buffer a
  // huge "error page" for a string that is about to be cut to 512 characters.
  it('stops reading a body that is far over the cap', async () => {
    const huge = 'y'.repeat(100_000)
    assert.strictEqual(
      await utils.httpErrorDetail(response(huge)),
      `${'y'.repeat(512)}\u2026[truncated]`
    )
  })

  // A JSON body has to be read whole to be parsed, so one over the read budget
  // is reported as no detail rather than as a partial message.
  it('reports no detail for a JSON body over the read budget', async () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const body = JSON.stringify({ message: 'z'.repeat(20_000) })
      assert.strictEqual(await utils.httpErrorDetail(response(body, 'application/json')), '')
    } finally {
      console.warn = originalWarn
    }
  })
})

describe('abortReason, raceAbort and abortableDelay', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const abortListeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length

  // Runs `fn`, and fails if a rejection went unhandled meanwhile
  const noUnhandledRejections = async (fn: () => Promise<void>) => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      await fn()
      await tick()
    } finally {
      process.off('unhandledRejection', listener)
    }
    assert.deepStrictEqual(unhandled, [])
  }

  // A promise that rejects when the test says so
  const pending = () => {
    let rejectWith!: (e: unknown) => void
    const promise = new Promise<never>((_resolve, reject) => { rejectWith = reject })
    return { promise, reject: rejectWith }
  }

  it('abortReason is the reason if it is an Error, or else an AbortError', () => {
    const error = new Error('stop')
    const withError = new AbortController()
    withError.abort(error)
    assert.strictEqual(utils.abortReason(withError.signal), error)
    const withString = new AbortController()
    withString.abort('stop')
    const reason = utils.abortReason(withString.signal)
    assert.strictEqual(reason.name, 'AbortError')
    assert.strictEqual(reason.message, 'Aborted')
  })

  it('raceAbort settles like the promise, and then stops listening to the signal', async () => {
    const { signal } = new AbortController()
    assert.strictEqual(await utils.raceAbort(Promise.resolve(1), signal), 1)
    const error = new Error('failed')
    await assert.rejects(utils.raceAbort(Promise.reject(error), signal), (e) => e === error)
    await tick()
    assert.strictEqual(abortListeners(signal), 0)
  })

  it('raceAbort rejects as soon as the signal aborts, and the promise goes on', async () => {
    await noUnhandledRejections(async () => {
      const controller = new AbortController()
      const work = pending()
      const race = utils.raceAbort(work.promise, controller.signal)
      assert.strictEqual(abortListeners(controller.signal), 1)
      const reason = new Error('stop')
      controller.abort(reason)
      await assert.rejects(race, (e) => e === reason)
      assert.strictEqual(abortListeners(controller.signal), 0)
      work.reject(new Error('failed after the abort'))
    })
  })

  it('raceAbort rejects at once if the signal has aborted', async () => {
    await noUnhandledRejections(async () => {
      const controller = new AbortController()
      controller.abort('stop')
      const work = pending()
      await assert.rejects(utils.raceAbort(work.promise, controller.signal), { name: 'AbortError' })
      assert.strictEqual(abortListeners(controller.signal), 0)
      work.reject(new Error('failed after the abort'))
    })
  })

  it('abortableDelay resolves after the delay', async () => {
    const { signal } = new AbortController()
    const start = performance.now()
    await utils.abortableDelay(20, signal)
    // (Node.js may fire a timer up to 1 ms early)
    assert.ok(performance.now() - start >= 19)
    assert.strictEqual(abortListeners(signal), 0)
  })

  // A timer left running would keep Node.js alive until it fires
  it('abortableDelay rejects as soon as the signal aborts, and clears its timer', async (t) => {
    const set = t.mock.method(globalThis, 'setTimeout')
    const clear = t.mock.method(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const wait = utils.abortableDelay(60_000, controller.signal)
    const timer = set.mock.calls.find(({ arguments: [, ms] }) => ms === 60_000)?.result
    assert.ok(timer, 'no timer')
    controller.abort()
    await assert.rejects(wait, { name: 'AbortError' })
    assert.ok(clear.mock.calls.some(({ arguments: [id] }) => id === timer), 'timer not cleared')
  })
})
