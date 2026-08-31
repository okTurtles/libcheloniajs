import * as assert from 'node:assert'
import { describe, it } from 'node:test'

import * as utils from './utils.js'
import { INVITE_STATUS } from './constants.js'
import type { ChelContractKey, ChelContractState, CheloniaContext } from './types.js'
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

  it('records invite keys without a numeric quantity as revoked', () => {
    // A missing quantity means 'unlimited' to the OP_KEY_REQUEST handler, so
    // processing must fail closed rather than mint an unlimited invite.
    const inviteKey = {
      id: 'invite_id',
      name: '#inviteKey-broken',
      data: 'data',
      purpose: ['sig' as const],
      ringLevel: 1,
      permissions: [SPMessage.OP_KEY_REQUEST],
      _notBeforeHeight: 0
    }
    const inviteContext = { ...context, transientSecretKeys: {} } as CheloniaContext
    const process = (key: SPKey, state: ChelContractState) =>
      utils.keyAdditionProcessor.call(
        inviteContext,
        {} as SPMessage,
        'hash',
        [key],
        state,
        'cid',
        inviteKey as unknown as ChelContractKey
      )

    const state = { _vm: { type: 'type', authorizedKeys: {} } } as unknown as ChelContractState
    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      assert.doesNotThrow(() => process(inviteKey as unknown as SPKey, state))
    } finally {
      console.error = originalError
    }
    assert.strictEqual(state._vm.invites!.invite_id.status, INVITE_STATUS.REVOKED)
    assert.strictEqual(errors.length, 1)

    // A well-formed invite is still recorded as valid.
    const ok = { _vm: { type: 'type', authorizedKeys: {} } } as unknown as ChelContractState
    process({ ...inviteKey, meta: { quantity: 2 } } as unknown as SPKey, ok)
    assert.strictEqual(ok._vm.invites!.invite_id.status, INVITE_STATUS.VALID)
    assert.strictEqual(ok._vm.invites!.invite_id.quantity, 2)
  })
})
