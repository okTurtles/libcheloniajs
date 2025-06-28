import { CURVE25519XSALSA20POLY1305, keygen, keyId, serializeKey } from '@chelonia/crypto';
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { encryptedIncomingData, encryptedOutgoingData, encryptedOutgoingDataWithRawKey } from './encryptedData.mjs';
describe('Encrypted data API', () => {
    it('should encrypt outgoing data and decrypt incoming data when using a key from the state', () => {
        const key = keygen(CURVE25519XSALSA20POLY1305);
        const id = keyId(key);
        const state = {
            _vm: {
                authorizedKeys: {
                    [id]: {
                        name: 'name',
                        purpose: ['enc'],
                        data: serializeKey(key, false)
                    }
                }
            }
        };
        const encryptedData = encryptedOutgoingData(state, id, 'foo');
        assert.ok(typeof encryptedData === 'object');
        assert.ok(typeof encryptedData.toString === 'function');
        assert.ok(typeof encryptedData.serialize === 'function');
        assert.ok(typeof encryptedData.valueOf === 'function');
        assert.equal(encryptedData.valueOf(), 'foo');
        const stringifiedEncryptedData = encryptedData.toString('');
        assert.notEqual(stringifiedEncryptedData, 'foo');
        assert.notEqual(encryptedData.serialize(''), 'foo');
        const incoming = encryptedIncomingData('', state, JSON.parse(stringifiedEncryptedData), 0, {
            [id]: key
        });
        assert.ok(typeof incoming === 'object');
        assert.ok(typeof incoming.toString === 'function');
        assert.ok(typeof incoming.serialize === 'function');
        assert.ok(typeof incoming.valueOf === 'function');
        assert.deepEqual(incoming.toJSON(), JSON.parse(stringifiedEncryptedData));
        assert.equal(incoming.toString(), stringifiedEncryptedData);
        assert.equal(incoming.valueOf(), 'foo');
    });
    it('should encrypt outgoing data and decrypt incoming data when using a raw key', () => {
        const key = keygen(CURVE25519XSALSA20POLY1305);
        const id = keyId(key);
        const encryptedData = encryptedOutgoingDataWithRawKey(key, 'foo');
        assert.ok(typeof encryptedData === 'object');
        assert.ok(typeof encryptedData.toString === 'function');
        assert.ok(typeof encryptedData.serialize === 'function');
        assert.ok(typeof encryptedData.valueOf === 'function');
        assert.equal(encryptedData.valueOf(), 'foo');
        const serializedEncryptedData = encryptedData.serialize();
        assert.notEqual(serializedEncryptedData, 'foo');
        const incoming = encryptedIncomingData('', {
            _vm: {
                authorizedKeys: {
                    [id]: {
                        purpose: ['enc']
                    }
                }
            }
        }, serializedEncryptedData, 0, { [id]: key });
        assert.ok(typeof incoming === 'object');
        assert.ok(typeof incoming.toString === 'function');
        assert.ok(typeof incoming.serialize === 'function');
        assert.ok(typeof incoming.valueOf === 'function');
        assert.equal(incoming.valueOf(), 'foo');
        assert.deepEqual(incoming.toJSON(), serializedEncryptedData);
        assert.equal(incoming.toString(), JSON.stringify(serializedEncryptedData));
    });
});
