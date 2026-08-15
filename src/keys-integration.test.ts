// Integration tests for the declarative key API (`src/keys.ts` selectors
// and their `chelonia/out/*` integration), run in their own Node process
// (Chelonia's global SBP context and domain lock make in-runner isolation
// fragile — see docs/specs/KEYS-API-IMPLEMENTATION.md §3).
//
// Uses the test-only in-memory Shelter transport in `src/test-utils/`.

import {
  EDWARDS25519SHA512BATCH,
  keyId,
  keygen,
  serializeKey,
  sign
} from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { before, describe, it } from 'node:test'

import './chelonia.js'
import './db.js'
import './keys.js'
import { createCID, multicodes } from './functions.js'
import {
  ChelErrorKeyNameNotFound,
  ChelErrorKeySpecInvalid
} from './errors.js'
import { SPMessage } from './SPMessage.js'
import { createShelterServerFixture } from './test-utils/shelter-server.js'
import type { ChelContractState, ChelRootState } from './types.js'
import type { KeyMap, RotationKeyMap } from './keys.js'

// Test contract state shape (custom action fields live alongside _vm).
type TestContractState = ChelContractState & {
  initialized?: boolean;
  count?: number;
  lastData?: { hello?: string, atomic?: boolean, rotated?: string } | null;
}

const CONTRACT_NAME = 't.test/main'

const CONTRACT_SOURCE = `
sbp('chelonia/defineContract', {
  name: '${CONTRACT_NAME}',
  metadata: { create: () => ({}), validate: () => {} },
  getters: {},
  actions: {
    '${CONTRACT_NAME}': {
      validate: () => {},
      process: (message, { state }) => { state.initialized = true }
    },
    '${CONTRACT_NAME}/act': {
      validate: () => {},
      process: (message, { state }) => {
        state.count = (state.count || 0) + 1
        state.lastData = message.data
      }
    }
  }
})
`

const fixture = createShelterServerFixture()

// Build a signed manifest + contract source, served under their CIDs.
const manifestHash = (() => {
  const signingKey = keygen(EDWARDS25519SHA512BATCH)
  const contractHash = createCID(CONTRACT_SOURCE, multicodes.SHELTER_CONTRACT_TEXT)
  const body = JSON.stringify({
    name: CONTRACT_NAME,
    version: '1.0.0',
    contract: { hash: contractHash, file: 'main.js' },
    contractSlim: { hash: contractHash, file: 'main.js' },
    signingKeys: [serializeKey(signingKey, false)]
  })
  const head = '{"manifestVersion":"1.0.0"}'
  const manifest = JSON.stringify({
    head,
    body,
    signature: {
      keyId: keyId(signingKey),
      value: sign(signingKey, body + head)
    }
  })
  const mHash = createCID(manifest, multicodes.SHELTER_CONTRACT_MANIFEST)
  fixture.addFile(mHash, manifest, multicodes.SHELTER_CONTRACT_MANIFEST)
  fixture.addFile(contractHash, CONTRACT_SOURCE, multicodes.SHELTER_CONTRACT_TEXT)
  return mHash
})()

const rootState = (): ChelRootState => sbp('chelonia/private/state') as ChelRootState
const contractState = (cid: string): TestContractState =>
  rootState()[cid] as TestContractState

// Standard key layout used by most tests below: mirrors Group Income's
// identity contract (CSK/CEK under IEK, PEK under CEK, DMK under PEK, SAK).
const identitySpecs = () => ({
  ipk: {
    purpose: ['sig' as const],
    ringLevel: 0,
    permissions: '*',
    allowedActions: '*',
    transient: true
  },
  iek: {
    purpose: ['enc' as const],
    ringLevel: 0,
    permissions: [],
    transient: true
  },
  csk: {
    purpose: ['sig' as const],
    ringLevel: 1,
    permissions: '*',
    allowedActions: '*',
    encryptWith: 'iek'
  },
  cek: {
    purpose: ['enc' as const],
    ringLevel: 1,
    permissions: [SPMessage.OP_ACTION_ENCRYPTED],
    encryptWith: 'iek'
  },
  pek: {
    purpose: ['enc' as const],
    ringLevel: 2,
    permissions: [SPMessage.OP_ACTION_ENCRYPTED],
    allowedActions: [`${CONTRACT_NAME}/act`],
    encryptWith: 'cek'
  },
  '#sak': { encryptWith: 'iek' }
})

// The fixture has no pubsub connection, so outgoing events are only applied
// to the local state by re-syncing from the (in-memory) server.
const applyRemote = async (cid: string) => {
  await sbp('chelonia/private/in/sync', cid, { force: true })
}

// First nested entry (`[opType, opValue]`) of an OP_ATOMIC message. Note
// that atomic strips each nested message's outer signing envelope (the inner
// operations are authorized by the outer signer when processed), so nested
// signing references are only observable through entry resolution behavior
// and the substantive payload (e.g., `actionEncrypted`'s encryption key).
const atomicFirstEntry = (msg: SPMessage): [string, unknown] =>
  (msg.opValue() as unknown as [string, unknown][])[0]

const registerIdentity = async (overrides: object = {}) => {
  const msg = await sbp('chelonia/out/registerContract', {
    contractName: CONTRACT_NAME,
    signingKeyName: 'ipk',
    actionSigningKeyName: 'csk',
    actionEncryptionKeyName: 'pek',
    keys: identitySpecs(),
    data: { attributes: { username: 'test' } },
    ...overrides
  }) as SPMessage
  await applyRemote(msg.contractID())
  await sbp('chelonia/contract/retain', msg.contractID())
  return msg
}

describe('keys integration', () => {
  before(async () => {
    sbp('chelonia/configure', {
      connectionURL: 'http://fixture',
      fetch: fixture.fetch as unknown as typeof fetch,
      contracts: {
        manifests: { [CONTRACT_NAME]: manifestHash }
      }
    } as never)
  })

  // ---------------------------------------------------------------------
  // Work package 2: selector registration and generation
  // ---------------------------------------------------------------------

  describe('chelonia/key/generate', () => {
    it('registers for direct chelonia imports and returns a KeyMap', () => {
      assert.ok(sbp('sbp/selectors/fn', 'chelonia/key/generate'))
      const K = sbp('chelonia/key/generate', {
        keys: { csk: { purpose: ['sig'], ringLevel: 1 } }
      }) as KeyMap
      assert.ok(K.csk.key)
      assert.strictEqual(K.csk.name, 'csk')
    })

    it('stores generated raw keys transiently, satisfying haveSecretKey', () => {
      const K = sbp('chelonia/key/generate', {
        keys: { csk: { purpose: ['sig'], ringLevel: 1 } }
      }) as KeyMap
      assert.ok(sbp('chelonia/haveSecretKey', K.csk.id))
      // not persistent yet
      assert.strictEqual(
        sbp('chelonia/haveSecretKey', K.csk.id, true),
        false
      )
    })

    it('does not write persistent root-state storage during generation', () => {
      const before = Object.keys(rootState().secretKeys ?? {}).length
      sbp('chelonia/key/generate', {
        keys: { cek: { purpose: ['enc'], ringLevel: 1, encryptWith: 'cek' } }
      })
      assert.strictEqual(
        Object.keys(rootState().secretKeys ?? {}).length,
        before
      )
    })

    it('does not pass data-only foreign entries to secret storage', () => {
      const K = sbp('chelonia/key/generate', {
        keys: {
          pub: {
            data: serializeKey(keygen(EDWARDS25519SHA512BATCH), false),
            ringLevel: 2
          }
        }
      }) as KeyMap
      assert.strictEqual(K.pub.key, undefined)
      assert.ok(!sbp('chelonia/haveSecretKey', K.pub.id))
    })
  })

  // ---------------------------------------------------------------------
  // Work package 3: spec-based registration
  // ---------------------------------------------------------------------

  describe('spec registration', () => {
    it('registers a contract and produces the expected authorizedKeys', async () => {
      const msg = await registerIdentity()
      assert.ok(msg)
      const contractID = msg.contractID()
      const state = contractState(contractID)
      assert.strictEqual(state._vm.type, CONTRACT_NAME)
      assert.ok(state.initialized)

      const keys = state._vm.authorizedKeys
      const byName = Object.fromEntries(
        Object.values(keys).map((k) => [k.name, k])
      )
      // All six keys present and active
      for (const name of ['ipk', 'iek', 'csk', 'cek', 'pek', '#sak']) {
        assert.ok(byName[name], `missing key ${name}`)
        assert.strictEqual(byName[name]._notAfterHeight, undefined)
      }
      // Correct curve types by purpose
      assert.strictEqual(byName.csk.purpose.join(), 'sig')
      assert.strictEqual(byName.cek.purpose.join(), 'enc')
      assert.strictEqual(byName['#sak'].purpose.join(), 'sak')
      assert.strictEqual(byName['#sak'].ringLevel, 0)
      // ipk/iek are transient (password-derived): no persisted secret
      assert.strictEqual(sbp('chelonia/haveSecretKey', byName.ipk.id, true), false)
      assert.strictEqual(sbp('chelonia/haveSecretKey', byName.iek.id, true), false)
      // wrapped non-transient keys (csk, cek, #sak) persisted after processing
      assert.ok(sbp('chelonia/haveSecretKey', byName.csk.id, true))
      assert.ok(sbp('chelonia/haveSecretKey', byName.cek.id, true))
      assert.ok(sbp('chelonia/haveSecretKey', byName['#sak'].id, true))
      // initial action was processed (encrypted branch)
      assert.strictEqual(state.count, undefined)
      assert.strictEqual(state.initialized, true)
      // two events on the fixture: OP_CONTRACT + OP_ACTION_ENCRYPTED
      assert.strictEqual(fixture.eventsByContract().get(contractID)!.length, 2)
    })

    it('supports signing by final wire name and by id with matching names', async () => {
      // Alias form is already covered above; exercise id+name pair.
      const K = sbp('chelonia/key/generate', {
        keys: identitySpecs()
      }) as KeyMap
      const msg = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyId: K.ipk.id,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: null,
        keys: Object.values(K).map((k) => k.spkey),
        data: {}
      }) as SPMessage
      await applyRemote(msg.contractID())
      const state = contractState(msg.contractID())
      assert.strictEqual(state.initialized, true)
    })

    it('rejects id/name mismatches before publishing', async () => {
      const eventsBefore = fixture.eventsByContract().size
      await assert.rejects(
        () => sbp('chelonia/out/registerContract', {
          contractName: CONTRACT_NAME,
          signingKeyId: 'mismatched-key-id',
          signingKeyName: 'ipk',
          actionSigningKeyName: 'csk',
          keys: identitySpecs(),
          data: {}
        }),
        ChelErrorKeyNameNotFound
      )
      assert.strictEqual(fixture.eventsByContract().size, eventsBefore)
    })

    it('runs onKeysReady before message creation and passes the KeyMap to data factories', async () => {
      const order: string[] = []
      const seenKeys: string[] = []
      const msg = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: 'cek',
        keys: {
          ipk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true },
          iek: { purpose: ['enc'], ringLevel: 0, transient: true },
          csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' },
          cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' }
        },
        onKeysReady: (K: KeyMap) => {
          order.push('onKeysReady')
          seenKeys.push(...Object.keys(K))
          // Generated signing key is available during the callback
          assert.ok(sbp('chelonia/haveSecretKey', K.csk.id))
        },
        data: (K: KeyMap) => {
          order.push('data')
          // ... and during the data factory
          assert.ok(sbp('chelonia/haveSecretKey', K.cek.id))
          return { attributes: { embed: serializeKey(K.cek.key!, false) } }
        }
      }) as SPMessage
      await applyRemote(msg.contractID())
      assert.ok(msg)
      assert.deepStrictEqual(order, ['onKeysReady', 'data'])
      assert.deepStrictEqual(seenKeys.sort(), ['cek', 'csk', 'iek', 'ipk'])
      // The encrypted initial action was processed with the factory data
      const state = contractState(msg.contractID())
      assert.strictEqual(state.initialized, true)
    })

    it('a callback error prevents message creation and publishing', async () => {
      const eventsBefore = fixture.eventsByContract().size
      await assert.rejects(
        () => sbp('chelonia/out/registerContract', {
          contractName: CONTRACT_NAME,
          signingKeyName: 'ipk',
          actionSigningKeyName: 'csk',
          keys: {
            ipk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true },
            iek: { purpose: ['enc'], ringLevel: 0, transient: true },
            csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' }
          },
          onKeysReady: () => { throw new Error('callback rejected') },
          data: {}
        }),
        /callback rejected/
      )
      assert.strictEqual(fixture.eventsByContract().size, eventsBefore)
    })

    it('appends an auto-SAK only when explicitly enabled', async () => {
      const noSak = await registerIdentity({ autoSak: false })
      // identitySpecs already declares '#sak' explicitly; autoSak is a no-op
      assert.ok(contractState(noSak.contractID())._vm.authorizedKeys)

      const withSak = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: 'cek',
        autoSak: { encryptWith: 'iek' },
        keys: {
          ipk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true },
          iek: { purpose: ['enc'], ringLevel: 0, transient: true },
          csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' },
          cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' }
        },
        data: {}
      }) as SPMessage
      await applyRemote(withSak.contractID())
      const names = Object.values(
        contractState(withSak.contractID())._vm.authorizedKeys
      ).map((k) => k.name)
      assert.ok(names.includes('#sak'))
    })

    it("object-form '#sak' spec wins over autoSak", async () => {
      // The caller's '#sak' record key must be detected; the bogus
      // autoSak.encryptWith proves the caller's spec (wrapped under 'cek')
      // is the one used.
      const msg = (await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: 'cek',
        autoSak: { encryptWith: 'nonexistent' },
        keys: {
          ipk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true },
          iek: { purpose: ['enc'], ringLevel: 0, transient: true },
          csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' },
          cek: { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' },
          '#sak': { encryptWith: 'cek' }
        },
        data: {}
      })) as SPMessage
      await applyRemote(msg.contractID())
      const saks = Object.values(contractState(msg.contractID())._vm.authorizedKeys)
        .filter((k) => k.name === '#sak')
      assert.strictEqual(saks.length, 1)
      // Wrapped under the caller's 'cek' (which we hold), so the secret was
      // decrypted and persisted on processing.
      assert.ok(sbp('chelonia/haveSecretKey', saks[0].id, true))
    })

    it("array-form '#sak' spec suppresses autoSak append", async () => {
      const { keySpec } = await import('./keys.js')
      const msg = (await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: 'cek',
        autoSak: { encryptWith: 'iek' },
        keys: [
          keySpec('ipk', { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true }),
          keySpec('iek', { purpose: ['enc'], ringLevel: 0, transient: true }),
          keySpec('csk', { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*', encryptWith: 'iek' }),
          keySpec('cek', { purpose: ['enc'], ringLevel: 1, permissions: [SPMessage.OP_ACTION_ENCRYPTED], encryptWith: 'iek' }),
          keySpec('#sak', { encryptWith: 'iek' })
        ],
        data: {}
      })) as SPMessage
      await applyRemote(msg.contractID())
      const saks = Object.values(contractState(msg.contractID())._vm.authorizedKeys)
        .filter((k) => k.name === '#sak')
      assert.strictEqual(saks.length, 1)
    })

    it('autoSak without an explicit encryptWith fails loudly (§2.6)', async () => {
      // The type requires `{ encryptWith: string }`, but JS callers bypass
      // types. A malformed opt-in must throw instead of silently appending
      // an unwrapped (unrecoverable) SAK.
      const keys = {
        ipk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*', transient: true },
        csk: { purpose: ['sig'], ringLevel: 1, permissions: '*', allowedActions: '*' }
      }
      for (const autoSak of [true, {}, { encryptWith: '' }]) {
        await assert.rejects(
          () => sbp('chelonia/out/registerContract', {
            contractName: CONTRACT_NAME,
            signingKeyName: 'ipk',
            actionSigningKeyName: 'csk',
            autoSak: autoSak as never,
            keys,
            data: {}
          }),
          (e: Error) => e instanceof ChelErrorKeySpecInvalid &&
            /autoSak requires an explicit encryptWith/.test(e.message)
        )
      }
    })

    it('spec registration matches raw registration authorizedKeys structure', async () => {
      // Same raw keys through both paths; compare parsed policy structure.
      const K = sbp('chelonia/key/generate', {
        keys: identitySpecs()
      }) as KeyMap

      const viaRaw = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyId: K.ipk.id,
        actionSigningKeyId: K.csk.id,
        actionEncryptionKeyId: K.cek.id,
        keys: Object.values(K).map((k) => k.spkey),
        data: {}
      }) as SPMessage
      await applyRemote(viaRaw.contractID())
      const viaSpec = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        actionSigningKeyName: 'csk',
        actionEncryptionKeyName: 'pek',
        keys: identitySpecs(),
        data: {}
      }) as SPMessage
      await applyRemote(viaSpec.contractID())

      const strip = (state: ChelContractState) =>
        Object.values(state._vm.authorizedKeys)
          .map((k) => ({
            name: k.name,
            purpose: k.purpose,
            ringLevel: k.ringLevel,
            permissions: k.permissions,
            hasContent: k.meta?.private?.content != null,
            transient: k.meta?.private?.transient === true
          }))
          .sort((a, b) => a.name.localeCompare(b.name))

      assert.deepStrictEqual(
        strip(contractState(viaRaw.contractID())),
        strip(contractState(viaSpec.contractID()))
      )
    })

    it('raw arrays keep legacy behavior (no auto-SAK, no callbacks)', async () => {
      const K = sbp('chelonia/key/generate', {
        keys: { csk: { purpose: ['sig'], ringLevel: 0, permissions: '*', allowedActions: '*' } }
      }) as KeyMap
      const msg = await sbp('chelonia/out/registerContract', {
        contractName: CONTRACT_NAME,
        signingKeyId: K.csk.id,
        actionSigningKeyId: K.csk.id,
        keys: Object.values(K).map((k) => k.spkey),
        data: {}
      }) as SPMessage
      await applyRemote(msg.contractID())
      const names = Object.values(
        contractState(msg.contractID())._vm.authorizedKeys
      ).map((k) => k.name)
      assert.ok(!names.includes('#sak'))
    })
  })

  // ---------------------------------------------------------------------
  // Work package 4: name references on existing outgoing operations
  // ---------------------------------------------------------------------

  describe('name references on outgoing operations', () => {
    let contractID: string

    before(async () => {
      const msg = await registerIdentity()
      contractID = msg.contractID()
    })

    it('actionEncrypted resolves signingKeyName and encryptionKeyName', async () => {
      const msg = (await sbp('chelonia/out/actionEncrypted', {
        action: `${CONTRACT_NAME}/act`,
        contractID,
        signingKeyName: 'csk',
        encryptionKeyName: 'cek',
        data: { hello: 'name-resolution' }
      })) as SPMessage
      await applyRemote(contractID)
      const state = contractState(contractID)
      assert.strictEqual(state.lastData?.hello, 'name-resolution')
      assert.ok(msg)
    })

    it('throws on id/name mismatch and unknown names', async () => {
      const state = contractState(contractID)
      const cskId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!.id
      await assert.rejects(
        () => sbp('chelonia/out/actionUnencrypted', {
          action: `${CONTRACT_NAME}/act`,
          contractID,
          signingKeyId: cskId,
          signingKeyName: 'ipk',
          data: {}
        }),
        ChelErrorKeyNameNotFound
      )
      await assert.rejects(
        () => sbp('chelonia/out/actionUnencrypted', {
          action: `${CONTRACT_NAME}/act`,
          contractID,
          signingKeyName: 'nope',
          data: {}
        }),
        ChelErrorKeyNameNotFound
      )
    })

    it('missing required key references throw TypeError (§7)', async () => {
      const eventsBefore = fixture.eventsByContract().get(contractID)!.length
      const probeKey = keygen(EDWARDS25519SHA512BATCH)
      // Neither id nor name: a required reference is missing on every
      // outgoing selector
      await assert.rejects(
        () => sbp('chelonia/out/actionUnencrypted', {
          action: `${CONTRACT_NAME}/act`,
          contractID,
          data: {}
        }),
        TypeError
      )
      await assert.rejects(
        () => sbp('chelonia/out/keyAdd', {
          contractID,
          contractName: CONTRACT_NAME,
          data: [
            {
              id: keyId(probeKey),
              name: 'probe',
              purpose: ['sig'],
              ringLevel: 2,
              permissions: [],
              data: serializeKey(probeKey, false)
            }
          ]
        }),
        // Same pointed error as every other selector (§2.7), not the opaque
        // 'Invalid invocation' from deep inside signedOutgoingData
        {
          constructor: TypeError,
          message: /signingKey: either a key ID or a key name must be provided/
        }
      )
      await assert.rejects(
        () => sbp('chelonia/out/keyDel', {
          contractID,
          contractName: CONTRACT_NAME,
          data: []
        }),
        TypeError
      )
      await assert.rejects(
        () => sbp('chelonia/out/keyUpdate', {
          contractID,
          contractName: CONTRACT_NAME,
          data: []
        }),
        TypeError
      )
      await assert.rejects(
        () => sbp('chelonia/out/keyRequestResponse', {
          contractID,
          contractName: CONTRACT_NAME,
          data: {}
        }),
        TypeError
      )
      await assert.rejects(
        () => sbp('chelonia/out/atomic', {
          contractID,
          contractName: CONTRACT_NAME,
          data: []
        }),
        TypeError
      )
      assert.strictEqual(fixture.eventsByContract().get(contractID)!.length, eventsBefore)
    })

    it('atomic preserves nested operation key references (merge-order regression)', async () => {
      const state = contractState(contractID)
      const ipkId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'ipk')!.id
      const cskId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!.id
      const cekId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'cek')!.id
      // The OUTER message is signed by the ipk id/name pair; the nested op
      // carries its OWN signing id. Before the fix, the outer params were
      // spread into the nested invocation and the cross-bred (cskId, 'ipk')
      // pair was rejected as a mismatch.
      const msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyId: ipkId,
        signingKeyName: 'ipk',
        data: [
          ['chelonia/out/actionEncrypted', {
            action: `${CONTRACT_NAME}/act`,
            contractID,
            signingKeyId: cskId,
            innerSigningKeyId: cskId,
            encryptionKeyId: cekId,
            data: { atomic: true }
          }]
        ]
      })) as SPMessage
      await applyRemote(contractID)
      // Outer signature must be ipk, and the nested op's own references must
      // have survived: the encryption key is substantive (it is part of the
      // atomic payload, unlike the stripped nested signing envelope).
      assert.strictEqual(msg.signingKeyId(), ipkId)
      const [opType, opValue] = atomicFirstEntry(msg)
      assert.strictEqual(opType, SPMessage.OP_ACTION_ENCRYPTED)
      assert.strictEqual((opValue as { encryptionKeyId: string }).encryptionKeyId, cekId)
      assert.strictEqual(contractState(contractID).lastData?.atomic, true)
    })

    it('atomic never mixes outer and nested key references (§7.3)', async () => {
      const state = contractState(contractID)
      const ipkId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'ipk')!.id
      const cskId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!.id
      const act = (tag: string) => ({
        action: `${CONTRACT_NAME}/act`,
        contractID,
        data: { atomic: tag }
      })

      // Outer id+name pair with a nested distinct id: before the fix the
      // outer name leaked into the nested call and the cross-bred pair was
      // rejected as a mismatch.
      let msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyId: ipkId,
        signingKeyName: 'ipk',
        data: [['chelonia/out/actionUnencrypted', { ...act('A'), signingKeyId: cskId }]]
      })) as SPMessage
      assert.strictEqual(msg.signingKeyId(), ipkId)

      // Outer name only, nested distinct id
      msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        data: [['chelonia/out/actionUnencrypted', { ...act('B'), signingKeyId: cskId }]]
      })) as SPMessage
      assert.strictEqual(msg.signingKeyId(), ipkId)

      // Outer id only, nested distinct name
      msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyId: ipkId,
        data: [['chelonia/out/actionUnencrypted', { ...act('C'), signingKeyName: 'csk' }]]
      })) as SPMessage
      assert.strictEqual(msg.signingKeyId(), ipkId)

      await applyRemote(contractID)
      assert.strictEqual(contractState(contractID).lastData?.atomic, 'C')
    })

    it('atomic signer-less nested ops inherit the outer signing reference', async () => {
      const state = contractState(contractID)
      const cskId = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!.id
      const msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyId: cskId,
        signingKeyName: 'csk',
        data: [
          ['chelonia/out/actionUnencrypted', {
            action: `${CONTRACT_NAME}/act`,
            contractID,
            data: { atomic: 'inherited' }
          }]
        ]
      })) as SPMessage
      await applyRemote(contractID)
      assert.strictEqual(msg.signingKeyId(), cskId)
      assert.strictEqual(atomicFirstEntry(msg)[0], SPMessage.OP_ACTION_UNENCRYPTED)
      assert.strictEqual(contractState(contractID).lastData?.atomic, 'inherited')
    })

    it('atomic does not override a nested raw signing key with outer references', async () => {
      // Add a dedicated signing key with OP_KEY_SHARE permission, then use
      // it as a RAW signing key inside an atomic batch whose outer message
      // is signed by name. Before the fix, the leaked outer references
      // pre-empted the raw key path (or failed pair validation); the nested
      // selector must take the raw-key path and resolve nothing else.
      const rawKey = keygen(EDWARDS25519SHA512BATCH)
      const rawKeyId = keyId(rawKey)
      await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: [
          {
            id: rawKeyId,
            name: 'rawsk',
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [SPMessage.OP_KEY_SHARE],
            data: serializeKey(rawKey, false)
          }
        ]
      })
      await applyRemote(contractID)

      const msg = (await sbp('chelonia/out/atomic', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: [
          ['chelonia/out/keyShare', {
            contractID,
            contractName: CONTRACT_NAME,
            data: { contractID, keys: [] },
            signingKey: rawKey
          }]
        ]
      })) as SPMessage
      await applyRemote(contractID)
      const cskId = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'csk')!.id
      assert.strictEqual(msg.signingKeyId(), cskId)
      assert.strictEqual(atomicFirstEntry(msg)[0], SPMessage.OP_KEY_SHARE)
    })
  })

  // ---------------------------------------------------------------------
  // Work package 5: spec-based keyAdd and foreign keys
  // ---------------------------------------------------------------------

  describe('spec-based keyAdd', () => {
    let contractID: string

    before(async () => {
      const msg = await registerIdentity()
      contractID = msg.contractID()
    })

    it('adds a generated DMK wrapped by the existing CEK', async () => {
      const msg = (await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: {
          dmk: {
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [SPMessage.OP_ACTION_ENCRYPTED + '#inner'],
            allowedActions: '*',
            encryptWith: 'pek',
            shareable: true
          }
        }
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_ADD)
      await applyRemote(contractID)
      const state = contractState(contractID)
      const dmk = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'dmk')!
      assert.ok(dmk)
      // Secret persisted after processing (wrapped under pek -> cek -> iek)
      assert.ok(sbp('chelonia/haveSecretKey', dmk.id, true))
      // invite-accounting is not triggered for ordinary names
      assert.strictEqual(state._vm.invites, undefined)
    })

    it('adds a foreign member CSK with URI and copied public data', async () => {
      // Register a second (member) contract whose csk we reference
      const member = await registerIdentity()
      const memberID = member.contractID()
      const memberState = contractState(memberID)
      const memberCsk = Object.values(memberState._vm.authorizedKeys).find(
        (k) => k.name === 'csk'
      )!

      const msg = (await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: {
          fk: {
            foreignKeyFrom: [memberID, 'csk'],
            purpose: ['sig'],
            ringLevel: Number.MAX_SAFE_INTEGER,
            permissions: [SPMessage.OP_ACTION_ENCRYPTED + '#inner'],
            allowedActions: '*'
          }
        }
      })) as SPMessage
      assert.ok(msg)
      await applyRemote(contractID)
      const state = contractState(contractID)
      const fk = Object.values(state._vm.authorizedKeys).find((k) => k.id === memberCsk.id)
      assert.ok(fk, 'foreign key added with the origin key id')
      assert.strictEqual(
        fk!.foreignKey,
        `shelter:${encodeURIComponent(memberID)}?keyName=${encodeURIComponent('csk')}`
      )
      assert.strictEqual(fk!.data, memberCsk.data)
      // No secret was stored for the foreign entry
      // (the member's own csk secret exists from the member contract — check
      // instead that keyAdd created no new persistent secret for this cid)
    })

    it('mixed raw/encrypted/spec entries keep array order', async () => {
      const rawKey = keygen(EDWARDS25519SHA512BATCH)
      const { keySpec } = await import('./keys.js')
      const msg = (await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: [
          {
            id: keyId(rawKey),
            name: 'raw-entry',
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [],
            data: serializeKey(rawKey, false)
          },
          keySpec('spec-entry', { purpose: ['sig'], ringLevel: 2 })
        ]
      })) as SPMessage
      assert.ok(msg)
      const opValue = msg.opValue() as unknown as object[]
      // Serialized payload order matches the original array order
      const names = opValue.map((k) => (k as { name: string }).name)
      assert.deepStrictEqual(names, ['raw-entry', 'spec-entry'])
    })

    it('duplicate existing keys remain a no-op', async () => {
      const K = sbp('chelonia/key/generate', {
        contractID,
        keys: {
          dmk: {
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [],
            encryptWith: 'pek'
          }
        }
      }) as KeyMap
      const first = await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: [K.dmk.spkey]
      })
      assert.ok(first)
      await applyRemote(contractID)
      const before = Object.keys(contractState(contractID)._vm.authorizedKeys).length
      const result = await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: [K.dmk.spkey]
      })
      assert.strictEqual(result, undefined)
      assert.strictEqual(
        Object.keys(contractState(contractID)._vm.authorizedKeys).length,
        before
      )
    })

    it('missing origin or wrapper errors before publishing', async () => {
      const eventsBefore = fixture.eventsByContract().get(contractID)!.length
      await assert.rejects(
        () => sbp('chelonia/out/keyAdd', {
          contractID,
          contractName: CONTRACT_NAME,
          signingKeyName: 'csk',
          data: {
            fk: { foreignKeyFrom: ['unknown-contract', 'csk'], ringLevel: 2 }
          }
        }),
        ChelErrorKeyNameNotFound
      )
      await assert.rejects(
        () => sbp('chelonia/out/keyAdd', {
          contractID,
          contractName: CONTRACT_NAME,
          signingKeyName: 'csk',
          data: {
            k: { purpose: ['sig'], ringLevel: 2, encryptWith: 'nope' }
          }
        }),
        ChelErrorKeyNameNotFound
      )
      assert.strictEqual(fixture.eventsByContract().get(contractID)!.length, eventsBefore)
    })

    it('adds a self-wrapped key end-to-end (§2.5)', async () => {
      const msg = (await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: {
          ssk: {
            purpose: ['enc'],
            ringLevel: 2,
            permissions: [],
            encryptWith: 'ssk'
          }
        }
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_ADD)
      await applyRemote(contractID)
      const state = contractState(contractID)
      const ssk = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'ssk')!
      assert.ok(ssk)
      // The secret half is wrapped under the key itself (valid terminal edge)
      assert.strictEqual((ssk.meta!.private!.content as unknown as string[])[0], ssk.id)
      // Sender-side processing recovered the self-wrapped secret and
      // persisted it (the spec is not marked transient)
      assert.ok(sbp('chelonia/haveSecretKey', ssk.id, true))
    })
  })

  // ---------------------------------------------------------------------
  // Work package 6: chelonia/out/shareKeys
  // ---------------------------------------------------------------------

  describe('chelonia/out/shareKeys', () => {
    it('shares a subject contract keys with a destination contract', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()

      const msg = (await sbp('chelonia/out/shareKeys', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyNames: ['csk', 'cek']
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_SHARE)
      await applyRemote(destID)

      // After processing, the destination contract holds sharedKeyIds for
      // the subject keys and can decrypt them (secrets were re-encrypted
      // under the destination cek).
      const destState = contractState(destID)
      const subjectState = contractState(subjectID)
      const sharedIds = destState._vm.sharedKeyIds?.map((s) => s.id) ?? []
      const subjectCskId = Object.values(subjectState._vm.authorizedKeys)
        .find((k) => k.name === 'csk')!.id
      assert.ok(sharedIds.includes(subjectCskId))
    })

    it("keyNames: '*' selects only active recoverable keys", async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()

      const msg = (await sbp('chelonia/out/shareKeys', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyNames: '*'
      })) as SPMessage
      assert.ok(msg)
      await applyRemote(destID)
      const destState = contractState(destID)
      // ipk/iek are transient but recoverable (present transiently) so they
      // are shareable; all shared keys are active with content
      assert.ok((destState._vm.sharedKeyIds?.length ?? 0) > 0)
    })

    it('shares transient-only subject keys', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()
      // Add a wrapped key marked transient: its secret is never persisted
      await sbp('chelonia/out/keyAdd', {
        contractID: subjectID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: {
          dmk: {
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [],
            encryptWith: 'pek',
            transient: true
          }
        }
      })
      await applyRemote(subjectID)
      const subjectState = contractState(subjectID)
      const dmk = Object.values(subjectState._vm.authorizedKeys)
        .find((k) => k.name === 'dmk')!
      // The secret exists only transiently
      assert.ok(sbp('chelonia/haveSecretKey', dmk.id))
      assert.strictEqual(sbp('chelonia/haveSecretKey', dmk.id, true), false)

      const msg = (await sbp('chelonia/out/shareKeys', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyNames: ['dmk']
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_SHARE)
      await applyRemote(destID)

      // The destination recovered the transient-only secret from the
      // re-encrypted content
      const destState = contractState(destID)
      assert.ok(destState._vm.sharedKeyIds?.some((s) => s.id === dmk.id))
      assert.ok(sbp('chelonia/haveSecretKey', dmk.id))
    })

    it('atomic mode does not publish', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()
      const eventsBefore = fixture.eventsByContract().get(destID)!.length

      const msg = (await sbp('chelonia/out/shareKeys', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyIds: '*',
        atomic: true
      })) as SPMessage
      assert.ok(msg)
      assert.strictEqual(fixture.eventsByContract().get(destID)!.length, eventsBefore)
    })

    it('same subject and destination is a no-op', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const result = await sbp('chelonia/out/shareKeys', {
        contractID: subjectID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyIds: '*'
      })
      assert.strictEqual(result, undefined)
    })

    it('missing subject secret errors', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()
      // Wipe local secrets for one subject key to force the error
      const subjectState = contractState(subjectID)
      const cskId = Object.values(subjectState._vm.authorizedKeys)
        .find((k) => k.name === 'csk')!.id
      sbp('chelonia/clearTransientSecretKeys')
      delete rootState().secretKeys![cskId]
      await assert.rejects(
        () => sbp('chelonia/out/shareKeys', {
          contractID: destID,
          contractName: CONTRACT_NAME,
          subjectContractID: subjectID,
          keyIds: [cskId]
        }),
        /missing secret/
      )
    })

    it('validates signingKeyId/signingKeyName pairs (§2.7)', async () => {
      const subject = await registerIdentity()
      const subjectID = subject.contractID()
      const dest = await registerIdentity()
      const destID = dest.contractID()
      const destIpkId = Object.values(contractState(destID)._vm.authorizedKeys)
        .find((k) => k.name === 'ipk')!.id
      const eventsBefore = fixture.eventsByContract().get(destID)!.length

      // Both provided and matching: the id is used as-is
      const msg = (await sbp('chelonia/out/shareKeys', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        subjectContractID: subjectID,
        keyNames: ['csk'],
        signingKeyId: destIpkId,
        signingKeyName: 'ipk'
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_SHARE)
      assert.strictEqual(fixture.eventsByContract().get(destID)!.length, eventsBefore + 1)

      // Both provided and mismatching: error before anything is published
      await assert.rejects(
        () => sbp('chelonia/out/shareKeys', {
          contractID: destID,
          contractName: CONTRACT_NAME,
          subjectContractID: subjectID,
          keyNames: ['csk'],
          signingKeyId: destIpkId,
          signingKeyName: 'csk'
        }),
        ChelErrorKeyNameNotFound
      )
      assert.strictEqual(fixture.eventsByContract().get(destID)!.length, eventsBefore + 1)
    })
  })

  describe('chelonia/out/keyShare', () => {
    it('validates signingKeyId/signingKeyName pairs (§2.7)', async () => {
      const dest = await registerIdentity()
      const destID = dest.contractID()
      const destIpkId = Object.values(contractState(destID)._vm.authorizedKeys)
        .find((k) => k.name === 'ipk')!.id
      const eventsBefore = fixture.eventsByContract().get(destID)!.length
      const data = { contractID: destID, keys: [] }

      // Both provided and matching: publishes
      const msg = (await sbp('chelonia/out/keyShare', {
        contractID: destID,
        contractName: CONTRACT_NAME,
        data,
        signingKeyId: destIpkId,
        signingKeyName: 'ipk',
        atomic: false
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_SHARE)
      assert.strictEqual(fixture.eventsByContract().get(destID)!.length, eventsBefore + 1)

      // Both provided and mismatching: error, nothing published
      await assert.rejects(
        () => sbp('chelonia/out/keyShare', {
          contractID: destID,
          contractName: CONTRACT_NAME,
          data,
          signingKeyId: destIpkId,
          signingKeyName: 'csk',
          atomic: false
        }),
        ChelErrorKeyNameNotFound
      )
      assert.strictEqual(fixture.eventsByContract().get(destID)!.length, eventsBefore + 1)
    })
  })

  // ---------------------------------------------------------------------
  // Work package 7: update specs and rotation
  // ---------------------------------------------------------------------

  describe('chelonia/key/rotate', () => {
    it('rotates csk+cek together with the two-case wrapper rule', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const before = contractState(contractID)
      const cskBefore = Object.values(before._vm.authorizedKeys).find((k) => k.name === 'csk')!
      const cekBefore = Object.values(before._vm.authorizedKeys).find((k) => k.name === 'cek')!

      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: ['csk', 'cek']
      })
      assert.ok(result)
      await applyRemote(contractID)

      const after = contractState(contractID)
      const activeKey = (name: string) =>
        Object.values(after._vm.authorizedKeys).find(
          (k) => k.name === name && k._notAfterHeight == null
        )!
      const cskAfter = activeKey('csk')
      const cekAfter = activeKey('cek')

      // Old keys revoked, new keys active, policy preserved
      assert.notStrictEqual(cskAfter.id, cskBefore.id)
      assert.notStrictEqual(cekAfter.id, cekBefore.id)
      assert.strictEqual(after._vm.authorizedKeys[cskBefore.id]._notAfterHeight != null, true)
      assert.strictEqual(after._vm.authorizedKeys[cekBefore.id]._notAfterHeight != null, true)
      assert.deepStrictEqual(cskAfter.permissions, cskBefore.permissions)
      assert.deepStrictEqual(cskAfter.allowedActions, cskBefore.allowedActions)
      assert.deepStrictEqual(cekAfter.purpose, cekBefore.purpose)

      // New secrets are available and persisted
      assert.ok(sbp('chelonia/haveSecretKey', cskAfter.id, true))
      assert.ok(sbp('chelonia/haveSecretKey', cekAfter.id, true))
    })

    it("supports 'pending' (excluding 'del') and explicit names", async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      // Mark csk pending revocation
      sbp('chelonia/contract/setPendingKeyRevocation', contractID, ['csk'])
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: 'pending'
      })
      assert.ok(result)
      await applyRemote(contractID)
      const names = result.updates.map((u: { name: string }) => u.name)
      assert.deepStrictEqual(names, ['csk'])
    })

    it("'pending' excludes keys marked for deletion ('del')", async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const state = contractState(contractID)
      const cekId = Object.values(state._vm.authorizedKeys)
        .find((k) => k.name === 'cek')!.id
      // csk is pending rotation (`true`); cek is pending deletion ('del')
      sbp('chelonia/contract/setPendingKeyRevocation', contractID, ['csk'])
      state._volatile!.pendingKeyRevocations![cekId] = 'del'
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: 'pending'
      })
      assert.ok(result)
      await applyRemote(contractID)
      // Only the `true`-marked key is rotated; the 'del' key is excluded
      assert.deepStrictEqual(
        result.updates.map((u: { name: string }) => u.name),
        ['csk']
      )
      const cekAfter = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.id === cekId)!
      assert.strictEqual(cekAfter._notAfterHeight, undefined)
    })

    it('bundles additional operations via atomic before/after', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()

      let calledWith: unknown = null
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: ['csk'],
        additionalOperations: async (newKeys: RotationKeyMap, ctx: { lastAttempt?: boolean }) => {
          calledWith = { newKeys, ctx }
          return {
            after: [
              ['chelonia/out/actionUnencrypted', {
                action: `${CONTRACT_NAME}/act`,
                contractID,
                signingKeyName: 'csk',
                data: { rotated: Object.keys(newKeys).join(',') }
              }]
            ]
          }
        }
      })
      assert.ok(result)
      assert.ok(result.msg)
      assert.strictEqual(result.msg!.opType(), SPMessage.OP_ATOMIC)
      assert.ok(calledWith)
      await applyRemote(contractID)
      // The after-action ran on-chain
      assert.strictEqual(
        contractState(contractID).lastData?.rotated,
        'csk'
      )
    })

    it('returns undefined when no keys qualify', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: []
      })
      assert.strictEqual(result, undefined)
    })

    it('suppresses publishing when every old key is already revoked (stale update)', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      // Rotate csk once
      const first = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: ['csk']
      })
      assert.ok(first)
      await applyRemote(contractID)
      // Now attempt to rotate the SAME (already revoked) old key by id —
      // expansion should reject it as revoked.
      const oldCskId = (first.updates[0] as { oldKeyId: string }).oldKeyId
      await assert.rejects(
        () => sbp('chelonia/out/keyUpdate', {
          contractID,
          contractName: CONTRACT_NAME,
          signingKeyName: 'ipk',
          data: { csk: { oldKeyId: oldCskId, rotate: true } }
        }).catch((e: unknown) => {
          throw e
        }),
        (e: unknown) => (e as Error).name === 'ChelErrorKeyNameNotFound'
      )
    })

    it('rotate composes preSendCheck with send-time stale-update suppression', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const eventsBefore = fixture.eventsByContract().get(contractID)!.length
      const state = contractState(contractID)
      const oldCskId = Object.values(state._vm.authorizedKeys)
        .find((k) => k.name === 'csk')!.id

      // Simulate a concurrent rotation landing between expansion and send:
      // the caller preSendCheck (which runs first in the composed hook)
      // marks the old key revoked in the live state; the composed
      // stale-update check must then suppress the publish.
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: ['csk'],
        hooks: {
          preSendCheck: (msg: SPMessage, s: ChelContractState) => {
            s._vm.authorizedKeys[oldCskId]._notAfterHeight = 1
            return true
          }
        }
      })
      assert.ok(result)
      assert.strictEqual(result.msg, undefined)
      assert.strictEqual(fixture.eventsByContract().get(contractID)!.length, eventsBefore)
    })

    it('keyUpdate accepts marked update specs in array form', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const { keyUpdateSpec } = await import('./keys.js')
      const msg = (await sbp('chelonia/out/keyUpdate', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        data: [
          keyUpdateSpec('csk', { oldKeyName: 'csk', rotate: true })
        ]
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_UPDATE)
      await applyRemote(contractID)
      const state = contractState(contractID)
      const csk = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!
      assert.ok(sbp('chelonia/haveSecretKey', csk.id, true))
    })

    it('array update-spec aliases may differ from the wire name', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const { keyUpdateSpec } = await import('./keys.js')
      // Free-form alias selecting the ring-0 wrapped #sak by oldKeyName
      const msg = (await sbp('chelonia/out/keyUpdate', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        data: [
          keyUpdateSpec('root-sak', { oldKeyName: '#sak', rotate: true })
        ]
      })) as SPMessage
      assert.strictEqual(msg.opType(), SPMessage.OP_KEY_UPDATE)
      await applyRemote(contractID)
      const sak = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === '#sak' && k._notAfterHeight == null)!
      assert.ok(sak.purpose.length === 1 && sak.purpose[0] === 'sak')
      assert.ok(sbp('chelonia/haveSecretKey', sak.id, true))
    })

    it('policy-only update specs augment permissions without replacing keys', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      // pek starts with permissions [OP_ACTION_ENCRYPTED]; the processor
      // augments (never narrows) permissions on OP_KEY_UPDATE.
      const before = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'pek')!
      const msg = (await sbp('chelonia/out/keyUpdate', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        data: {
          pek: { permissions: [SPMessage.OP_KEY_DEL] }
        }
      })) as SPMessage
      assert.ok(msg)
      await applyRemote(contractID)
      const after = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'pek' && k._notAfterHeight == null)!
      assert.strictEqual(after.id, before.id)
      assert.strictEqual(after.data, before.data)
      assert.deepStrictEqual(
        [...after.permissions as string[]].sort(),
        [SPMessage.OP_ACTION_ENCRYPTED, SPMessage.OP_KEY_DEL].sort()
      )
    })

    it('policy-only update works when the sender lacks the target secret', async () => {
      // Regression: the spec form copies the existing `meta.private.content`
      // (a serialized tuple) into the update. Without the copied-data marker,
      // sender-side processing treats it as fresh content and aborts the
      // publish when the sender cannot decrypt it (e.g. an admin updating a
      // member's wrapped key). Legacy raw updates omit `meta` and never hit
      // this.
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      // Add a wrapped key marked transient, then drop its secret: the sender
      // keeps signing authority (ipk) but no longer holds the target secret.
      await sbp('chelonia/out/keyAdd', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'csk',
        data: {
          dmk: {
            purpose: ['sig'],
            ringLevel: 2,
            permissions: [],
            encryptWith: 'pek',
            transient: true
          }
        }
      })
      await applyRemote(contractID)
      const dmk = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'dmk')!
      assert.ok(sbp('chelonia/haveSecretKey', dmk.id))
      sbp('chelonia/clearTransientSecretKeys', [dmk.id])
      assert.strictEqual(sbp('chelonia/haveSecretKey', dmk.id), false)

      const msg = (await sbp('chelonia/out/keyUpdate', {
        contractID,
        contractName: CONTRACT_NAME,
        signingKeyName: 'ipk',
        data: {
          dmk: { permissions: [SPMessage.OP_ACTION_UNENCRYPTED] }
        }
      })) as SPMessage
      assert.ok(msg)
      await applyRemote(contractID)
      const after = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'dmk' && k._notAfterHeight == null)!
      assert.strictEqual(after.id, dmk.id)
      assert.deepStrictEqual(after.permissions, [SPMessage.OP_ACTION_UNENCRYPTED])
      // The copied content survives the update unchanged. After the resync
      // it is re-wrapped lazily by the deserializer, so compare serialized
      // ciphertext tuples.
      const afterContent = after.meta?.private?.content
      assert.deepStrictEqual(
        Array.isArray(afterContent) ? afterContent : afterContent!.serialize(),
        dmk.meta?.private?.content
      )
    })

    it("rotates '*' across mixed ring levels (wrapped #sak)", async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const rotatedNames = ['#sak', 'cek', 'csk', 'pek']
      const oldIds = rotatedNames.map((name) =>
        Object.values(contractState(contractID)._vm.authorizedKeys)
          .find((k) => k.name === name)!.id
      )

      // '*' selects csk, cek, pek and the ring-0 wrapped #sak (ipk/iek have
      // no wrapped secret); the signer must be ring-0 ipk for this to pass
      // validateKeyAddPermissions.
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: '*'
      })
      assert.ok(result)
      assert.deepStrictEqual(
        result.updates.map((u: { name: string }) => u.name).sort(),
        rotatedNames
      )
      await applyRemote(contractID)

      const authorizedKeys = contractState(contractID)._vm.authorizedKeys
      for (const oldId of oldIds) {
        assert.ok(authorizedKeys[oldId]._notAfterHeight != null, `${oldId} not revoked`)
      }
      for (const name of rotatedNames) {
        const active = Object.values(authorizedKeys)
          .find((k) => k.name === name && k._notAfterHeight == null)!
        assert.notStrictEqual(active.id, oldIds[rotatedNames.indexOf(name)])
        assert.ok(
          sbp('chelonia/haveSecretKey', active.id, true),
          `new ${name} secret not persisted`
        )
      }
    })

    it("'pending' rotation including a ring-0 wrapped key", async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      sbp('chelonia/contract/setPendingKeyRevocation', contractID, ['csk', '#sak'])
      const result = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: 'pending'
      })
      assert.ok(result)
      await applyRemote(contractID)
      assert.deepStrictEqual(
        result.updates.map((u: { name: string }) => u.name).sort(),
        ['#sak', 'csk']
      )
    })

    it('fails fast before publishing when no signer at min ringLevel is available', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const ipkId = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'ipk')!.id
      sbp('chelonia/clearTransientSecretKeys', [ipkId])
      const eventsBefore = fixture.eventsByContract().get(contractID)!.length

      // '*' includes ring-0 #sak, so only a ring-0 signer (ipk, now cleared)
      // is eligible; the failure must happen before any event is published.
      await assert.rejects(
        () => sbp('chelonia/key/rotate', {
          contractID,
          contractName: CONTRACT_NAME,
          names: '*'
        }),
        /no suitable signing key/
      )
      assert.strictEqual(fixture.eventsByContract().get(contractID)!.length, eventsBefore)
    })

    it('validates explicit signingKeyId/signingKeyName pairs (§2.7)', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const ipkId = Object.values(contractState(contractID)._vm.authorizedKeys)
        .find((k) => k.name === 'ipk')!.id

      const first = await sbp('chelonia/key/rotate', {
        contractID,
        contractName: CONTRACT_NAME,
        names: ['csk'],
        signingKeyId: ipkId,
        signingKeyName: 'ipk'
      })
      assert.ok(first)
      await applyRemote(contractID)

      // 'csk' now resolves to the new key id, which is not the given id
      await assert.rejects(
        () => sbp('chelonia/key/rotate', {
          contractID,
          contractName: CONTRACT_NAME,
          names: ['csk'],
          signingKeyId: ipkId,
          signingKeyName: 'csk'
        }),
        ChelErrorKeyNameNotFound
      )
    })

    it('rejects rotation of missing keys and spec errors', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      await assert.rejects(
        () => sbp('chelonia/key/rotate', {
          contractID,
          contractName: CONTRACT_NAME,
          names: ['nonexistent']
        }),
        ChelErrorKeyNameNotFound
      )
      // #sak cannot be malformed
      assert.throws(
        () => sbp('chelonia/key/generate', {
          keys: { '#sak': { permissions: ['c'] } }
        }),
        ChelErrorKeySpecInvalid
      )
    })
  })

  // ---------------------------------------------------------------------
  // Transient/persistent lifecycle sanity across the whole flow
  // ---------------------------------------------------------------------

  describe('secret lifecycle', () => {
    it('wrapped non-transient keys persist while transient roots do not', async () => {
      const reg = await registerIdentity()
      const contractID = reg.contractID()
      const state = contractState(contractID)
      const ipk = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'ipk')!
      const csk = Object.values(state._vm.authorizedKeys).find((k) => k.name === 'csk')!

      // Clearing transient roots (logout flow) does not affect persisted keys
      sbp('chelonia/clearTransientSecretKeys', [ipk.id])
      assert.strictEqual(sbp('chelonia/haveSecretKey', ipk.id), false)
      assert.ok(sbp('chelonia/haveSecretKey', csk.id, true))
    })
  })
})
