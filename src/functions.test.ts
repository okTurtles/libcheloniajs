import { base32 } from '@chelonia/multiformats/bases/base32'
import { base58btc } from '@chelonia/multiformats/bases/base58'
import { CID } from '@chelonia/multiformats/cid'
import * as Digest from '@chelonia/multiformats/hashes/digest'
import * as assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  CHELONIA_CID_REGEX,
  CID_REGEX,
  CONTRACT_ID_REGEX,
  createCID,
  maybeParseCID,
  multicodes
} from './functions.js'

const BLAKE2B_256 = 0xb220
const SHA2_256 = 0x12
const SHA2_512 = 0x13

// The lowest and highest digest give the first and last CID a codec can have,
// so every other one sits between them
const extremeCIDs = (code: number): string[] => [0x00, 0xff].map((fill) => {
  const digest = Digest.create(BLAKE2B_256, new Uint8Array(32).fill(fill))
  return CID.create(1, code, digest).toString(base58btc)
})

describe('CID regexes', () => {
  // Fails when a codec is added to `multicodes` without updating the prefixes
  it('match every Chelonia codec, and only contracts match CONTRACT_ID_REGEX', () => {
    for (const [name, code] of Object.entries(multicodes)) {
      const random = Array.from({ length: 200 }, () => createCID(randomBytes(32), code))
      const cids = [...extremeCIDs(code), ...random]
      for (const cid of cids) {
        assert.ok(maybeParseCID(cid), `${name} ${cid}`)
        assert.strictEqual(CHELONIA_CID_REGEX.test(cid), true, `${name} ${cid}`)
        assert.strictEqual(CID_REGEX.test(cid), true, `${name} ${cid}`)
        assert.strictEqual(CONTRACT_ID_REGEX.test(cid), name === 'SHELTER_CONTRACT_DATA', `${name} ${cid}`)
      }
    }
  })

  it('CID_REGEX matches other CIDs that CID.parse decodes', () => {
    const cids: string[] = []
    for (let i = 0; i < 20; i++) {
      // CIDv0 is always dag-pb and sha2-256
      cids.push(CID.create(0, 0x70, Digest.create(SHA2_256, randomBytes(32))).toString())
    }
    // Codecs of 1 to 3 bytes, and digests from the shortest length allowed
    const digests: Array<[hash: number, size: number]> = [
      [SHA2_256, 20], [SHA2_256, 32], [SHA2_512, 64], [BLAKE2B_256, 32]
    ]
    for (const code of [0x55, 0x70, 0x0129, 0x511e02]) {
      for (const [hash, size] of digests) {
        const cid = CID.create(1, code, Digest.create(hash, randomBytes(size)))
        cids.push(cid.toString(base32), cid.toString(base58btc))
      }
    }
    for (const cid of cids) {
      assert.doesNotThrow(() => CID.parse(cid), cid)
      assert.strictEqual(CID_REGEX.test(cid), true, cid)
    }
  })

  it('reject strings that are not CIDs', () => {
    const contractID = createCID('a contract', multicodes.SHELTER_CONTRACT_DATA)
    const notCIDs = [
      '', 'hello', 'zebras', 'baggages', 'bafflement', 'Qmfoo',
      '6f1c3b8e-2a4d-4f5e-9b7a-1c2d3e4f5a6b',
      // Valid CIDs left out on purpose: tiny identity data, uppercase base32,
      // and base36, which CID.parse can't decode on its own
      'bafkqaaa',
      CID.parse(contractID).toString(base32).toUpperCase(),
      'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnz0v',
      // A Chelonia ID with a character base58 doesn't have
      `${contractID.slice(0, -1)}0`
    ]
    for (const text of notCIDs) {
      assert.strictEqual(CHELONIA_CID_REGEX.test(text), false, text)
      assert.strictEqual(CONTRACT_ID_REGEX.test(text), false, text)
      assert.strictEqual(CID_REGEX.test(text), false, text)
    }
    // Chelonia IDs have one length. CID_REGEX has no longest one, since
    // identity CIDs can be any size.
    for (const text of [contractID.slice(0, -1), `${contractID}a`]) {
      assert.strictEqual(CHELONIA_CID_REGEX.test(text), false, text)
      assert.strictEqual(CONTRACT_ID_REGEX.test(text), false, text)
    }
  })

  it('answer a very long string without hanging', () => {
    const long = `z2${'a'.repeat(1_000_000)}!`
    assert.strictEqual(CID_REGEX.test(long), false)
    assert.strictEqual(CHELONIA_CID_REGEX.test(long), false)
  })
})
