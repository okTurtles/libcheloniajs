import * as assert from 'node:assert'
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

  it('reports no detail when a JSON body has no usable message', async () => {
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"error":"nope"}', 'application/json')),
      ''
    )
    assert.strictEqual(
      await utils.httpErrorDetail(response('{"message":42}', 'application/json')),
      ''
    )
  })
})
