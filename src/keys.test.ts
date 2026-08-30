// Pure unit tests for the key spec expansion engine (src/keys.ts).
//
// These tests never import chelonia.ts: the expansion engine is pure with
// respect to SBP, and that property is itself asserted below.

import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  keyId,
  keygen,
  serializeKey
} from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import {
  ChelErrorKeyNameNotFound,
  ChelErrorKeySpecInvalid,
  ChelErrorKeyWrapCycle
} from './errors.js'
import {
  expandKeySpecs,
  expandKeyUpdateSpecs,
  isKeySpec,
  isKeyUpdateSpec,
  keySpec,
  keyUpdateSpec,
  normalizeKeySpecs,
  normalizeKeyUpdateSpecs,
  resolveGeneratedKeyReference,
  resolveStateKeyReference
} from './keys.js'
import type { KeySpec } from './keys.js'
import type { SPKeyMeta, SPKeyUpdate } from './SPMessage.js'
import type { ChelContractKey, ChelContractState } from './types.js'
import { SPMessage } from './SPMessage.js'

const activeKey = (
  key: ReturnType<typeof keygen>,
  overrides: Partial<ChelContractKey> = {}
): ChelContractKey => ({
  id: keyId(key),
  name: 'k',
  purpose: ['sig'],
  ringLevel: 0,
  permissions: [],
  _notBeforeHeight: 0,
  data: serializeKey(key, false),
  ...overrides
})

const stateWith = (keys: ChelContractKey[]): ChelContractState =>
  ({ _vm: { authorizedKeys: Object.fromEntries(keys.map((k) => [k.id, k])) } }) as ChelContractState

describe('keys: markers and normalization', () => {
  it('marks specs with a prototype tag, not instanceof', () => {
    const spec = keySpec('csk', { purpose: ['sig'], ringLevel: 1 })
    assert.ok(isKeySpec(spec))
    assert.strictEqual(spec.alias, 'csk')
    // A caller-provided wire name is preserved, not overwritten by the alias
    assert.strictEqual(spec.name, undefined)
    assert.ok(!isKeySpec({ name: 'csk' }))
    assert.ok(!isKeySpec(null))
    // Spreading loses the marker (plain object again)
    assert.ok(!isKeySpec({ ...spec }))

    const updateSpec = keyUpdateSpec('csk', { rotate: true })
    assert.ok(isKeyUpdateSpec(updateSpec))
    assert.ok(!isKeyUpdateSpec({ rotate: true }))
    assert.ok(!isKeySpec(updateSpec))
    assert.ok(!isKeyUpdateSpec(spec))
  })

  it('keeps the alias separate from an explicit wire name in array form', () => {
    const spec = keySpec('creatorInvite', { name: '#inviteKey', quantity: 1 })
    assert.ok(isKeySpec(spec))
    assert.strictEqual(spec.alias, 'creatorInvite')
    assert.strictEqual(spec.name, '#inviteKey')

    const entries = normalizeKeySpecs([spec])
    assert.deepStrictEqual(entries.map((e) => e.alias), ['creatorInvite'])
    assert.strictEqual(entries[0].spec.name, '#inviteKey')

    // Duplicate aliases are rejected even when wire names differ; duplicate
    // wire names under distinct aliases are caught at expansion time.
    assert.throws(
      () => normalizeKeySpecs([
        keySpec('a', { name: 'x' }),
        keySpec('a', { name: 'y' })
      ]),
      ChelErrorKeySpecInvalid
    )
  })

  it('normalizes the object and marked-array forms in insertion order', () => {
    const objectForm = normalizeKeySpecs({
      csk: { purpose: ['sig'], ringLevel: 1 },
      cek: { purpose: ['enc'], ringLevel: 1 }
    })
    assert.deepStrictEqual(objectForm.map((e) => e.alias), ['csk', 'cek'])

    const arrayForm = normalizeKeySpecs([
      keySpec('cek', { purpose: ['enc'], ringLevel: 1 }),
      keySpec('csk', { purpose: ['sig'], ringLevel: 1 })
    ])
    assert.deepStrictEqual(arrayForm.map((e) => e.alias), ['cek', 'csk'])
  })

  it('rejects duplicate aliases and unmarked array entries', () => {
    assert.throws(
      () => normalizeKeySpecs([keySpec('a', {}), keySpec('a', {})]),
      ChelErrorKeySpecInvalid
    )
    assert.throws(
      () => normalizeKeySpecs([{ name: 'a' } as never]),
      ChelErrorKeySpecInvalid
    )
  })
})

describe('keys: expandKeySpecs defaults and conventions', () => {
  it('infers the type from purpose and derives id/data', () => {
    const K = expandKeySpecs({
      keys: {
        csk: { purpose: ['sig'], ringLevel: 1, permissions: '*' },
        cek: { purpose: ['enc'], ringLevel: 1 }
      }
    })
    assert.strictEqual(K.csk.spkey.data, serializeKey(K.csk.key!, false))
    assert.strictEqual(K.csk.id, keyId(K.csk.key!))
    assert.strictEqual(K.csk.name, 'csk')
    assert.deepStrictEqual(K.csk.spkey.purpose, ['sig'])
    assert.strictEqual(K.csk.spkey.ringLevel, 1)
    assert.strictEqual(K.csk.spkey.permissions, '*')
    assert.strictEqual(K.cek.key!.type, CURVE25519XSALSA20POLY1305)
    // data-only (public half) entries have no raw key
    const D = expandKeySpecs({
      keys: {
        pub: { data: serializeKey(keygen(EDWARDS25519SHA512BATCH), false), ringLevel: 2 }
      }
    })
    assert.strictEqual(D.pub.key, undefined)
    assert.strictEqual(D.pub.id, keyId(D.pub.spkey.data))
  })

  it('applies fail-closed permission defaults and requires ringLevel', () => {
    const K = expandKeySpecs({
      keys: { csk: { purpose: ['sig'], ringLevel: 3 } }
    })
    assert.deepStrictEqual(K.csk.spkey.permissions, [])
    assert.deepStrictEqual(K.csk.spkey.allowedActions, [])

    assert.throws(
      () => expandKeySpecs({ keys: { csk: { purpose: ['sig'] } } }),
      /ringLevel.*required/
    )
  })

  it('applies #sak conventions and rejects non-default policy', () => {
    const K = expandKeySpecs({ keys: { '#sak': { encryptWith: 'cek' }, cek: { purpose: ['enc'], ringLevel: 1, encryptWith: 'cek' } } })
    const sak = K['#sak'].spkey
    assert.deepStrictEqual(sak.purpose, ['sak'])
    assert.strictEqual(sak.ringLevel, 0)
    assert.deepStrictEqual(sak.permissions, [])
    assert.strictEqual(sak.name, '#sak')
    assert.strictEqual(K['#sak'].key!.type, EDWARDS25519SHA512BATCH)

    assert.throws(
      () => expandKeySpecs({ keys: { '#sak': { permissions: ['c'] } } }),
      /#sak may not have permissions/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { '#sak': { ringLevel: 1 } } }),
      /#sak must have ringLevel 0/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { '#sak': { purpose: ['sig'] } } }),
      /exactly one purpose/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { '#sak': { type: CURVE25519XSALSA20POLY1305 } } }),
      /#sak must be an edwards key/
    )
  })

  it('suffixes invite names and requires quantity', () => {
    const K = expandKeySpecs({
      keys: {
        generalInvite: {
          name: '#inviteKey',
          quantity: 60,
          permissions: [SPMessage.OP_KEY_REQUEST]
        }
      }
    })
    assert.strictEqual(K.generalInvite.name, `#inviteKey-${K.generalInvite.id}`)
    assert.strictEqual(K.generalInvite.spkey.meta?.quantity, 60)
    assert.strictEqual(K.generalInvite.spkey.ringLevel, Number.MAX_SAFE_INTEGER)
    assert.deepStrictEqual(K.generalInvite.spkey.purpose, ['sig'])

    assert.throws(
      () => expandKeySpecs({ keys: { i: { name: '#inviteKey' } } }),
      /require 'quantity'/
    )

    // Two invite aliases with the same spec name do not collide: suffixing
    // happens before final-name uniqueness validation.
    const two = expandKeySpecs({
      keys: {
        a: { name: '#inviteKey', quantity: 1 },
        b: { name: '#inviteKey', quantity: 2 }
      }
    })
    assert.notStrictEqual(two.a.name, two.b.name)

    // Array form has the same expressiveness (plan §2.2): the alias is a
    // label, the spec's `name` is the wire name, and multiple `#inviteKey`
    // entries are allowed.
    const arrayForm = expandKeySpecs({
      keys: [
        keySpec('creatorInvite', { name: '#inviteKey', quantity: 1 }),
        keySpec('generalInvite', { name: '#inviteKey', quantity: 60 })
      ]
    })
    assert.deepStrictEqual(Object.keys(arrayForm), ['creatorInvite', 'generalInvite'])
    assert.strictEqual(arrayForm.creatorInvite.name, `#inviteKey-${arrayForm.creatorInvite.id}`)
    assert.strictEqual(arrayForm.generalInvite.spkey.meta?.quantity, 60)
    assert.strictEqual(arrayForm.generalInvite.spkey.ringLevel, Number.MAX_SAFE_INTEGER)
    assert.notStrictEqual(arrayForm.creatorInvite.name, arrayForm.generalInvite.name)
  })

  it('rejects unknown reserved names', () => {
    assert.throws(
      () => expandKeySpecs({ keys: { '#nope': { ringLevel: 0 } } }),
      /reserved key name/
    )
  })

  it('rejects near misses of the conventional reserved names', () => {
    // A key called `#sak-1` or `#krrk` would be treated as an ordinary key by
    // expansion, but none of the convention handling elsewhere in the library
    // matches those names, so the spec is almost certainly a typo.
    for (const name of ['#sak-1', '#sak-foo', '#krrk', '#krrk2']) {
      assert.throws(
        () => expandKeySpecs({ keys: { k: { name, purpose: ['sig'], ringLevel: 3 } } }),
        /reserved key name/,
        `expected '${name}' to be rejected`
      )
    }
    // The documented forms stay accepted
    assert.ok(expandKeySpecs({ keys: { s: { name: '#sak' } } }).s)
    assert.ok(
      expandKeySpecs({
        keys: { i: { name: '#inviteKey-foo', ringLevel: 3, quantity: 1 } }
      }).i
    )
    assert.ok(
      expandKeySpecs({
        keys: { r: { name: '#krrk-abc', purpose: ['enc'], ringLevel: 3 } }
      }).r
    )
  })

  it('rejects duplicate final wire names and duplicate ids', () => {
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: { purpose: ['sig'], ringLevel: 1 },
          b: { name: 'a', purpose: ['sig'], ringLevel: 1 }
        }
      }),
      /Duplicate final key name/
    )
    const sameKey = keygen(EDWARDS25519SHA512BATCH)
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: { key: sameKey, ringLevel: 1 },
          b: { key: sameKey, ringLevel: 1 }
        }
      }),
      /Duplicate key ID/
    )
  })
})

describe('keys: expandKeySpecs validation rules', () => {
  it('rejects key+type, key+data, and empty derivations', () => {
    const k = keygen(CURVE25519XSALSA20POLY1305)
    assert.throws(
      () => expandKeySpecs({
        keys: { a: { key: k, type: EDWARDS25519SHA512BATCH, ringLevel: 0 } }
      }),
      /mutually exclusive/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { a: { key: k, data: 'x', ringLevel: 0 } } }),
      /mutually exclusive/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { a: { ringLevel: 0 } } }),
      /nothing to derive/
    )
  })

  it('rejects data+type, whose type would be silently discarded', () => {
    // The type is always derived from the supplied public material, so a
    // `type` alongside `data` is either redundant or a contradiction. It used
    // to be accepted and ignored, including for a mismatched curve.
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: {
            data: serializeKey(keygen(CURVE25519XSALSA20POLY1305), false),
            type: EDWARDS25519SHA512BATCH,
            ringLevel: 2
          }
        }
      }),
      /mutually exclusive/
    )
  })

  it('rejects purpose/type inconsistencies', () => {
    assert.throws(
      () => expandKeySpecs({
        keys: { a: { type: EDWARDS25519SHA512BATCH, purpose: ['enc'], ringLevel: 0 } }
      }),
      /not compatible/
    )
    assert.throws(
      () => expandKeySpecs({
        keys: { a: { type: CURVE25519XSALSA20POLY1305, purpose: ['sig'], ringLevel: 0 } }
      }),
      /not compatible/
    )
    assert.throws(
      () => expandKeySpecs({ keys: { a: { purpose: ['enc', 'sig'], ringLevel: 0 } } }),
      /Cannot infer/
    )
  })

  it('rejects encryptWith references that cannot be resolved', () => {
    assert.throws(
      () => expandKeySpecs({
        keys: { a: { purpose: ['enc'], ringLevel: 0, encryptWith: 'nope' } }
      }),
      ChelErrorKeyNameNotFound
    )
    // non-enc wrapper
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: { purpose: ['enc'], ringLevel: 0, encryptWith: 's' },
          s: { purpose: ['sig'], ringLevel: 0 }
        }
      }),
      /not an encryption key/
    )
  })
})

describe('keys: wrapping graph', () => {
  it('supports self-wrap as a terminal edge', () => {
    const K = expandKeySpecs({
      keys: { cek: { purpose: ['enc'], ringLevel: 0, encryptWith: 'cek' } }
    })
    const content = K.cek.spkey.meta?.private?.content
    assert.ok(content)
    // Lazily encrypted under the key itself
    const serialized = (content as unknown as { serialize: (ad?: string) => [string, string] })
      .serialize('test')
    assert.strictEqual(serialized[0], K.cek.id)
  })

  it('supports chains and diamonds', () => {
    const K = expandKeySpecs({
      keys: {
        iek: { purpose: ['enc'], ringLevel: 0 },
        csk: { purpose: ['sig'], ringLevel: 1, encryptWith: 'iek' },
        cek: { purpose: ['enc'], ringLevel: 1, encryptWith: 'iek' },
        pek: { purpose: ['enc'], ringLevel: 2, encryptWith: 'cek' },
        dmk: { purpose: ['sig'], ringLevel: 2, encryptWith: 'pek' }
      }
    })
    const wrap = (alias: string, additionalData = '') =>
      ((K[alias].spkey.meta!.private!.content as unknown as {
        serialize: (ad?: string) => [string, string]
      }).serialize(additionalData)[0])
    assert.strictEqual(wrap('csk'), K.iek.id)
    assert.strictEqual(wrap('cek'), K.iek.id)
    assert.strictEqual(wrap('pek'), K.cek.id)
    assert.strictEqual(wrap('dmk'), K.pek.id)
  })

  it('rejects multi-node cycles with ChelErrorKeyWrapCycle', () => {
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: { purpose: ['enc'], ringLevel: 0, encryptWith: 'b' },
          b: { purpose: ['enc'], ringLevel: 0, encryptWith: 'a' }
        }
      }),
      ChelErrorKeyWrapCycle
    )
    // 3-node cycle
    assert.throws(
      () => expandKeySpecs({
        keys: {
          a: { purpose: ['enc'], ringLevel: 0, encryptWith: 'b' },
          b: { purpose: ['enc'], ringLevel: 0, encryptWith: 'c' },
          c: { purpose: ['enc'], ringLevel: 0, encryptWith: 'a' }
        }
      }),
      ChelErrorKeyWrapCycle
    )
  })

  it('supports raw-key wrappers ({ key })', () => {
    const rawWrapper = keygen(CURVE25519XSALSA20POLY1305)
    const K = expandKeySpecs({
      keys: {
        csk: { purpose: ['sig'], ringLevel: 1, encryptWith: { key: rawWrapper } }
      }
    })
    const serialized = (K.csk.spkey.meta!.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }).serialize('')[0]
    assert.strictEqual(serialized, keyId(rawWrapper))
  })

  it('supports existing-contract wrappers by name and by { contractID, name }', () => {
    const wrapperKey = keygen(CURVE25519XSALSA20POLY1305)
    const state = stateWith([
      activeKey(wrapperKey, { name: 'cek', purpose: ['enc'] })
    ])
    const states: Record<string, ChelContractState> = { cid: state }

    // by name (target contract context)
    const K1 = expandKeySpecs({
      keys: { dmk: { purpose: ['sig'], ringLevel: 2, encryptWith: 'cek' } },
      context: { contractID: 'cid', contractState: state, getContractState: (c) => states[c] }
    })
    // By-id wrapping is lazy; the wrapper key id is available eagerly.
    const s1 = (K1.dmk.spkey.meta!.private!.content as unknown as {
      encryptionKeyId: string
    }).encryptionKeyId
    assert.strictEqual(s1, keyId(wrapperKey))

    // by explicit { contractID, name }
    const K2 = expandKeySpecs({
      keys: { dmk: { purpose: ['sig'], ringLevel: 2, encryptWith: { contractID: 'cid', name: 'cek' } } },
      context: { getContractState: (c) => states[c] }
    })
    const s2 = (K2.dmk.spkey.meta!.private!.content as unknown as {
      encryptionKeyId: string
    }).encryptionKeyId
    assert.strictEqual(s2, keyId(wrapperKey))
  })
})

describe('keys: foreign keys', () => {
  it('builds a foreignKeyFrom entry with encoded URI and copied public data', () => {
    const originKey = keygen(EDWARDS25519SHA512BATCH)
    const originID = 'z'.repeat(30) + '/origin'
    const state = stateWith([
      activeKey(originKey, { name: 'csk', purpose: ['sig'] })
    ])
    const K = expandKeySpecs({
      keys: {
        fk: {
          foreignKeyFrom: [originID, 'csk'],
          purpose: ['sig'],
          ringLevel: Number.MAX_SAFE_INTEGER
        }
      },
      context: { getContractState: () => state }
    })
    const spkey = K.fk.spkey
    assert.strictEqual(spkey.id, keyId(originKey))
    assert.strictEqual(spkey.data, serializeKey(originKey, false))
    assert.strictEqual(
      spkey.foreignKey,
      `shelter:${encodeURIComponent(originID)}?keyName=${encodeURIComponent('csk')}`
    )
    // Default wire name: <originContractID>/<keyId>
    assert.strictEqual(spkey.name, `${originID}/${keyId(originKey)}`)
    // No secret material
    assert.strictEqual(K.fk.key, undefined)
  })

  it('requires the origin contract to be loaded and active', () => {
    assert.throws(
      () => expandKeySpecs({
        keys: { fk: { foreignKeyFrom: ['nope', 'csk'], ringLevel: 0 } },
        context: { getContractState: () => undefined }
      }),
      ChelErrorKeyNameNotFound
    )
    const revoked = stateWith([
      activeKey(keygen(EDWARDS25519SHA512BATCH), { name: 'csk', _notAfterHeight: 5 })
    ])
    assert.throws(
      () => expandKeySpecs({
        keys: { fk: { foreignKeyFrom: ['c', 'csk'], ringLevel: 0 } },
        context: { getContractState: () => revoked }
      }),
      ChelErrorKeyNameNotFound
    )
  })

  it('rejects key/type/data/encryptWith on foreignKeyFrom specs', () => {
    const state = stateWith([activeKey(keygen(EDWARDS25519SHA512BATCH), { name: 'csk' })])
    const ctx = { getContractState: () => state }
    assert.throws(
      () => expandKeySpecs({
        keys: { fk: { foreignKeyFrom: ['c', 'csk'], key: keygen(EDWARDS25519SHA512BATCH), ringLevel: 0 } },
        context: ctx
      }),
      ChelErrorKeySpecInvalid
    )
    assert.throws(
      () => expandKeySpecs({
        keys: { fk: { foreignKeyFrom: ['c', 'csk'], encryptWith: 'x', ringLevel: 0 } },
        context: ctx
      }),
      ChelErrorKeySpecInvalid
    )
  })
})

describe('keys: metadata merging', () => {
  it('generated fields win over caller meta; unrelated fields survive', () => {
    const rawWrapper = keygen(CURVE25519XSALSA20POLY1305)
    const K = expandKeySpecs({
      keys: {
        a: {
          purpose: ['sig'],
          ringLevel: 1,
          quantity: 3,
          expires: 42,
          encryptWith: { key: rawWrapper },
          // `custom` is an arbitrary caller field; SPKeyMeta is closed so
          // the escape hatch is typed through a cast.
          meta: {
            quantity: 999, // cannot override generated
            ...({ custom: 'keep-me' } as Record<string, unknown>),
            private: {
              oldKeys: 'old-keys-blob'
            }
          }
        }
      }
    })
    const meta = K.a.spkey.meta! as SPKeyMeta & { custom?: string }
    assert.strictEqual(meta.quantity, 3)
    assert.strictEqual(meta.expires, 42)
    assert.strictEqual((meta as { custom?: string }).custom, 'keep-me')
    const content = meta.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }
    assert.strictEqual(content.serialize('')[0], keyId(rawWrapper))
    assert.strictEqual(meta.private!.oldKeys, 'old-keys-blob')
  })

  it("rejects caller-supplied meta.private.content in favor of 'encryptWith'", () => {
    // Content supplied here would bypass the wrapper purpose checks, the
    // in-set/contract resolution and the cycle detection that `encryptWith`
    // runs, and is never validated against the key it is attached to.
    const cases: KeySpec[] = [
      // ...alongside a wrapper, where the generated content would win anyway
      {
        purpose: ['sig'],
        ringLevel: 1,
        encryptWith: { key: keygen(CURVE25519XSALSA20POLY1305) },
        meta: { private: { content: 'attacker-controlled' as never } }
      },
      // ...without a wrapper, where it used to pass through verbatim
      {
        purpose: ['sig'],
        ringLevel: 1,
        meta: { private: { content: 'attacker-controlled' as never } }
      },
      // ...on a transient key, which also has no generated content
      {
        purpose: ['sig'],
        ringLevel: 0,
        transient: true,
        meta: { private: { content: 'attacker-controlled' as never } }
      },
      // ...on a public-material-only entry, which has no secret at all
      {
        data: serializeKey(keygen(EDWARDS25519SHA512BATCH), false),
        ringLevel: 2,
        meta: { private: { content: 'attacker-controlled' as never } }
      }
    ]
    for (const spec of cases) {
      assert.throws(
        () => expandKeySpecs({ keys: { a: spec } }),
        ChelErrorKeySpecInvalid
      )
    }
  })

  it('marks transient and shareable keys', () => {
    const K = expandKeySpecs({
      keys: {
        iek: { purpose: ['enc'], ringLevel: 0, transient: true },
        csk: { purpose: ['sig'], ringLevel: 1, shareable: true, encryptWith: 'iek' }
      }
    })
    assert.strictEqual(K.iek.spkey.meta?.private?.transient, true)
    assert.strictEqual(K.iek.spkey.meta?.private?.content, undefined)
    assert.strictEqual(K.csk.spkey.meta?.private?.shareable, true)
  })
})

describe('keys: update-spec expansion', () => {
  const wrapperKey = keygen(CURVE25519XSALSA20POLY1305)
  const cskKey = keygen(EDWARDS25519SHA512BATCH)

  // Build a contract state that looks like processed state: cek is wrapped
  // under itself and csk is wrapped under cek. Like a real contract, every
  // rotatable key has a recoverable `meta.private.content`.
  const buildState = (): ChelContractState => {
    const cek = activeKey(wrapperKey, {
      name: 'cek',
      purpose: ['enc'],
      meta: {
        private: {
          content: ['cek-self-wrapper-tuple', 'ciphertext']
        }
      }
    })
    ;(cek.meta!.private!.content as [string, string])[0] = keyId(wrapperKey)
    const csk = activeKey(cskKey, {
      name: 'csk',
      permissions: ['ae'],
      meta: {
        private: {
          content: ['cek-wrapper-tuple', 'ciphertext']
        }
      }
    })
    // The raw tuple's first element is the wrapper key id
    ;(csk.meta!.private!.content as [string, string])[0] = keyId(wrapperKey)
    return stateWith([cek, csk])
  }

  it('rotates a key and re-wraps under the stable wrapper (by id)', () => {
    const state = buildState()
    const { updates: rawUpdates, newKeys } = expandKeyUpdateSpecs({
      updates: { csk: { rotate: true } },
      contractID: 'cid',
      contractState: state
    })
    const updates = rawUpdates as SPKeyUpdate[]
    assert.strictEqual(updates.length, 1)
    const u = updates[0]
    assert.strictEqual(u.name, 'csk')
    assert.strictEqual(u.oldKeyId, keyId(cskKey))
    assert.ok(u.id)
    assert.ok(u.data)
    assert.notStrictEqual(u.id, keyId(cskKey))
    // Stable wrapper: by-id form (lazy); wrapper id available eagerly
    const content = u.meta!.private!.content as unknown as {
      encryptionKeyId: string
    }
    assert.strictEqual(content.encryptionKeyId, keyId(wrapperKey))
    assert.strictEqual(newKeys.csk.id, u.id)
  })

  it('uses the new raw key when the wrapper is rotated in the same set', () => {
    const state = buildState()
    const { updates: rawUpdates, newKeys } = expandKeyUpdateSpecs({
      updates: { csk: { rotate: true }, cek: { rotate: true } },
      contractID: 'cid',
      contractState: state
    })
    const updates = rawUpdates as SPKeyUpdate[]
    const cskUpdate = updates.find((u: SPKeyUpdate) => u.name === 'csk')!
    const content = cskUpdate.meta!.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }
    // Wrapped under the NEW cek, not the old one
    assert.strictEqual(content.serialize('')[0], newKeys.cek.id)
  })

  it('supports explicit raw wrappers and provided replacement keys', () => {
    const state = buildState()
    const newKey = keygen(EDWARDS25519SHA512BATCH)
    const iek = keygen(CURVE25519XSALSA20POLY1305)
    const { updates: rawUpdates } = expandKeyUpdateSpecs({
      updates: {
        csk: { key: newKey, encryptWith: { key: iek } }
      },
      contractID: 'cid',
      contractState: state
    })
    const u = (rawUpdates as SPKeyUpdate[])[0]!
    assert.strictEqual(u.id, keyId(newKey))
    const content = u.meta!.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }
    assert.strictEqual(content.serialize('')[0], keyId(iek))
  })

  it('emits id/data only for replacements (policy-only updates)', () => {
    const state = buildState()
    const { updates: rawUpdates } = expandKeyUpdateSpecs({
      updates: { csk: { permissions: ['ae', 'au'] } },
      contractID: 'cid',
      contractState: state
    })
    const u = (rawUpdates as SPKeyUpdate[])[0]!
    assert.strictEqual(u.id, undefined)
    assert.strictEqual(u.data, undefined)
    assert.deepStrictEqual(u.permissions, ['ae', 'au'])
    // Content preserved verbatim for policy-only updates
    assert.deepStrictEqual(
      u.meta!.private!.content,
      state._vm.authorizedKeys[keyId(cskKey)].meta!.private!.content
    )
  })

  it('preserves metadata through rotation', () => {
    const state = buildState()
    state._vm.authorizedKeys[keyId(cskKey)].meta = {
      quantity: 5,
      expires: 99,
      private: {
        content: state._vm.authorizedKeys[keyId(cskKey)].meta!.private!.content,
        shareable: true,
        oldKeys: 'blob'
      }
    }
    const { updates: rawUpdates } = expandKeyUpdateSpecs({
      updates: { csk: { rotate: true } },
      contractID: 'cid',
      contractState: state
    })
    const u = (rawUpdates as SPKeyUpdate[])[0]!
    assert.strictEqual(u.meta!.quantity, 5)
    assert.strictEqual(u.meta!.expires, 99)
    assert.strictEqual(u.meta!.private!.shareable, true)
    assert.strictEqual(u.meta!.private!.oldKeys, 'blob')
  })

  it('rejects unrecoverable replacements for wrapper-less keys', () => {
    // A key with no `meta.private.content`: its secret has no wrapper.
    const bare = activeKey(keygen(EDWARDS25519SHA512BATCH), { name: 'bare' })
    const state = stateWith([bare])

    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: { bare: { rotate: true } },
        contractID: 'cid',
        contractState: state
      }),
      (e: Error) =>
        e instanceof ChelErrorKeySpecInvalid && /unrecoverable after reload/.test(e.message)
    )

    // `transient: true` opts out: the caller keeps the secret
    const viaSpec = expandKeyUpdateSpecs({
      updates: { bare: { rotate: true, transient: true } },
      contractID: 'cid',
      contractState: state
    })
    const uSpec = (viaSpec.updates as SPKeyUpdate[])[0]!
    assert.ok(uSpec.id)
    assert.ok(uSpec.data)
    assert.strictEqual(uSpec.meta!.private!.transient, true)
    assert.strictEqual(uSpec.meta!.private!.content, undefined)

    // Already transient in contract state: no flag in the spec is needed
    // (the shape of password-derived ipk/iek keys)
    const transientKey = activeKey(keygen(EDWARDS25519SHA512BATCH), {
      name: 'ipk',
      meta: { private: { transient: true } }
    })
    const viaState = expandKeyUpdateSpecs({
      updates: { ipk: { rotate: true } },
      contractID: 'cid',
      contractState: stateWith([transientKey])
    })
    assert.ok((viaState.updates as SPKeyUpdate[])[0]!.id)

    // An explicit `encryptWith: { key }` wrapper also satisfies the rule
    const wrapper = keygen(CURVE25519XSALSA20POLY1305)
    const viaWrapper = expandKeyUpdateSpecs({
      updates: { bare: { rotate: true, encryptWith: { key: wrapper } } },
      contractID: 'cid',
      contractState: state
    })
    const uWrapped = (viaWrapper.updates as SPKeyUpdate[])[0]!
    const content = uWrapped.meta!.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }
    assert.strictEqual(content.serialize('')[0], keyId(wrapper))

    // Policy-only updates make no secret, so they are still allowed
    const policyOnly = expandKeyUpdateSpecs({
      updates: { bare: { permissions: ['ae'] } },
      contractID: 'cid',
      contractState: state
    })
    const uPolicy = (policyOnly.updates as SPKeyUpdate[])[0]!
    assert.strictEqual(uPolicy.id, undefined)
    assert.deepStrictEqual(uPolicy.permissions, ['ae'])
  })

  it('rejects rotation of keys with unusable wrapper metadata', () => {
    // Content that is not a `[keyId, ciphertext]` tuple yields no wrapper id.
    // Rotation must throw instead of emitting a replacement with an
    // unrecoverable secret.
    const badShape = activeKey(keygen(EDWARDS25519SHA512BATCH), {
      name: 'badShape',
      meta: { private: { content: { nope: true } as unknown as [string, string] } }
    })
    assert.throws(() => expandKeyUpdateSpecs({
      updates: { badShape: { rotate: true } },
      contractID: 'cid',
      contractState: stateWith([badShape])
    }))

    // An empty wrapper id must also fail: encryption rejects an empty
    // reference.
    const emptyRef = activeKey(keygen(EDWARDS25519SHA512BATCH), {
      name: 'emptyRef',
      meta: { private: { content: ['', 'ciphertext'] } }
    })
    assert.throws(() => expandKeyUpdateSpecs({
      updates: { emptyRef: { rotate: true } },
      contractID: 'cid',
      contractState: stateWith([emptyRef])
    }))
  })

  it('rejects missing/revoked old keys and name mismatches', () => {
    const state = buildState()
    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: { x: { oldKeyName: 'nope', rotate: true } },
        contractID: 'cid',
        contractState: state
      }),
      ChelErrorKeyNameNotFound
    )
    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: { x: { rotate: true } },
        contractID: 'cid',
        contractState: state
      }),
      ChelErrorKeySpecInvalid
    )
    // id/name mismatch
    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: { x: { oldKeyId: 'wrong', oldKeyName: 'csk', rotate: true } },
        contractID: 'cid',
        contractState: state
      }),
      ChelErrorKeyNameNotFound
    )
    // renaming is not allowed
    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: { x: { oldKeyName: 'csk', name: 'renamed', rotate: true } },
        contractID: 'cid',
        contractState: state
      }),
      /cannot be updated/
    )
  })

  it('array-form aliases are caller labels and may differ from wire names', () => {
    const invite = activeKey(keygen(EDWARDS25519SHA512BATCH), {
      name: '#inviteKey-abc'
    })
    const state = stateWith([invite])
    const { updates: rawUpdates, newKeys } = expandKeyUpdateSpecs({
      updates: [
        // Invite keys have no wrapper: the secret travels in the invite link,
        // so the caller manages it (`transient`).
        keyUpdateSpec('creatorInvite', {
          oldKeyName: '#inviteKey-abc',
          rotate: true,
          transient: true
        })
      ],
      contractID: 'cid',
      contractState: state
    })
    const u = (rawUpdates as SPKeyUpdate[])[0]!
    assert.strictEqual(u.name, '#inviteKey-abc')
    assert.strictEqual(u.oldKeyId, invite.id)
    assert.ok(u.id)
    // Wrapper-less by design: transient, no content
    assert.strictEqual(u.meta!.private!.transient, true)
    assert.strictEqual(u.meta!.private!.content, undefined)
    // RotationKeyMap is keyed by the existing wire name, not the alias
    assert.strictEqual(newKeys['#inviteKey-abc']!.id, u.id)

    // Duplicate aliases are still rejected
    assert.throws(
      () => normalizeKeyUpdateSpecs([
        keyUpdateSpec('a', {}),
        keyUpdateSpec('a', {})
      ]),
      ChelErrorKeySpecInvalid
    )
  })

  it('explicit name equal to the wire name passes in both forms', () => {
    const state = buildState()
    const fromMap = expandKeyUpdateSpecs({
      updates: { csk: { oldKeyName: 'csk', name: 'csk', rotate: true } },
      contractID: 'cid',
      contractState: state
    })
    assert.strictEqual((fromMap.updates as SPKeyUpdate[])[0]!.name, 'csk')
    const fromArray = expandKeyUpdateSpecs({
      updates: [keyUpdateSpec('csk', { oldKeyName: 'csk', name: 'csk', rotate: true })],
      contractID: 'cid',
      contractState: state
    })
    assert.strictEqual((fromArray.updates as SPKeyUpdate[])[0]!.name, 'csk')
  })

  it('does not mutate caller-provided spec objects', () => {
    const state = buildState()
    // Map form: alias-defaulted `oldKeyName` must stay local to the expansion
    const mapSpec: { rotate: boolean, oldKeyName?: string } = { rotate: true }
    expandKeyUpdateSpecs({
      updates: { csk: mapSpec },
      contractID: 'cid',
      contractState: state
    })
    assert.strictEqual(mapSpec.oldKeyName, undefined)
    assert.deepStrictEqual(Object.keys(mapSpec), ['rotate'])

    // Array form: the marked spec itself (which callers may retain and reuse)
    // must survive both successful and failed expansions unmodified
    const marked = keyUpdateSpec('csk', { rotate: true })
    expandKeyUpdateSpecs({
      updates: [marked],
      contractID: 'cid',
      contractState: state
    })
    assert.strictEqual((marked as { oldKeyName?: string }).oldKeyName, undefined)
    assert.deepStrictEqual(Object.keys(marked).sort(), ['alias', 'rotate'])

    const markedMissing = keyUpdateSpec('nonexistent', { rotate: true })
    assert.throws(
      () => expandKeyUpdateSpecs({
        updates: [markedMissing],
        contractID: 'cid',
        contractState: state
      }),
      ChelErrorKeyNameNotFound
    )
    assert.strictEqual((markedMissing as { oldKeyName?: string }).oldKeyName, undefined)
  })
})

describe('keys: reference resolution', () => {
  it('resolveGeneratedKeyReference: aliases, wire names, and mismatches', () => {
    const K = expandKeySpecs({
      keys: {
        csk: { purpose: ['sig'], ringLevel: 1 },
        inv: { name: '#inviteKey', quantity: 1 }
      }
    })
    assert.strictEqual(resolveGeneratedKeyReference(K, undefined, 'csk', 't'), K.csk.id)
    assert.strictEqual(resolveGeneratedKeyReference(K, undefined, '#inviteKey-' + K.inv.id, 't'), K.inv.id)
    assert.strictEqual(resolveGeneratedKeyReference(K, K.csk.id, 'csk', 't'), K.csk.id)
    assert.throws(
      () => resolveGeneratedKeyReference(K, K.csk.id, 'inv', 't'),
      ChelErrorKeyNameNotFound
    )
    assert.throws(
      () => resolveGeneratedKeyReference(K, undefined, undefined, 't'),
      TypeError
    )
    // nullable reference (not required)
    assert.strictEqual(resolveGeneratedKeyReference(K, null, null, 't', false), null)
  })

  it('resolves a name the same way as encryptWith does (wire name first)', () => {
    // A name that is one key's alias and another key's wire name used to
    // resolve to the alias here but to the wire name in `encryptWith`.
    const K = expandKeySpecs({
      keys: {
        cek: { name: 'other', purpose: ['enc'], ringLevel: 1 },
        wrapper: { name: 'cek', purpose: ['enc'], ringLevel: 1 },
        wrapped: { purpose: ['sig'], ringLevel: 2, encryptWith: 'cek' }
      }
    })
    // Both paths agree on the key whose *wire* name is 'cek'
    assert.strictEqual(resolveGeneratedKeyReference(K, undefined, 'cek', 't'), K.wrapper.id)
    const content = K.wrapped.spkey.meta!.private!.content as unknown as {
      serialize: (ad?: string) => [string, string]
    }
    assert.strictEqual(content.serialize('')[0], K.wrapper.id)
    // The alias is still the fallback when it is not any key's wire name
    assert.strictEqual(resolveGeneratedKeyReference(K, undefined, 'wrapper', 't'), K.wrapper.id)
    assert.strictEqual(resolveGeneratedKeyReference(K, undefined, 'other', 't'), K.cek.id)
  })

  it('resolveStateKeyReference: active names and revocation awareness', () => {
    const k1 = keygen(EDWARDS25519SHA512BATCH)
    const k2 = keygen(EDWARDS25519SHA512BATCH)
    const state = stateWith([
      activeKey(k1, { name: 'ipk' }),
      activeKey(k2, { name: 'ipk', _notAfterHeight: 10 })
    ])
    assert.strictEqual(resolveStateKeyReference(state, undefined, 'ipk', 't'), keyId(k1))
    assert.strictEqual(resolveStateKeyReference(state, keyId(k1), 'ipk', 't'), keyId(k1))
    assert.throws(
      () => resolveStateKeyReference(state, keyId(k2), 'ipk', 't'),
      ChelErrorKeyNameNotFound
    )
    assert.throws(
      () => resolveStateKeyReference(state, undefined, 'gone', 't'),
      ChelErrorKeyNameNotFound
    )
    assert.throws(
      () => resolveStateKeyReference(undefined, undefined, 'ipk', 't'),
      ChelErrorKeyNameNotFound
    )
  })
})

describe('keys: purity', () => {
  it('makes no SBP calls during expansion', () => {
    const calls: string[] = []
    // sbp cannot remove filters, so this one stays installed for the rest of
    // the process. The flag disables it after this test; without it, `calls`
    // would grow forever.
    let recording = true
    sbp('sbp/filters/global/add', (_domain: string, selector: string) => {
      if (recording) calls.push(selector)
      return true
    })
    try {
      expandKeySpecs({
        keys: {
          iek: { purpose: ['enc'], ringLevel: 0 },
          csk: { purpose: ['sig'], ringLevel: 1, encryptWith: 'iek' }
        }
      })
      expandKeyUpdateSpecs({
        updates: {},
        contractID: 'cid',
        contractState: stateWith([])
      })
      // Serialize the lazy raw-key wrappers: encryption must not need SBP
      // either. (By-id wrapping defers its state lookup to serialization time
      // and is exercised in the integration tests instead.)
      const K = expandKeySpecs({
        keys: {
          cek: { purpose: ['enc'], ringLevel: 0, encryptWith: 'cek' }
        }
      })
      ;(K.cek.spkey.meta!.private!.content as unknown as {
        serialize: (ad?: string) => [string, string]
      }).serialize('')
    } finally {
      recording = false
    }
    assert.deepStrictEqual(calls, [])
  })
})
