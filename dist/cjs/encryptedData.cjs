"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeEncryptedIncomingData = exports.unwrapMaybeEncryptedData = exports.isRawEncryptedData = exports.encryptedDataKeyId = exports.encryptedIncomingDataWithRawKey = exports.encryptedIncomingForeignData = exports.encryptedIncomingData = exports.encryptedOutgoingDataWithRawKey = exports.encryptedOutgoingData = exports.isEncryptedData = void 0;
const crypto_1 = require("@chelonia/crypto");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const errors_js_1 = require("./errors.cjs");
const signedData_js_1 = require("./signedData.cjs");
const rootStateFn = () => (0, sbp_1.default)('chelonia/rootState');
// `proto` & `wrapper` are utilities for `isEncryptedData`
const proto = Object.create(null, {
    _isEncryptedData: {
        value: true
    }
});
const wrapper = (o) => {
    return Object.setPrototypeOf(o, proto);
};
// `isEncryptedData` will return true for objects created by the various
// `encrypt*Data` functions. It's meant to implement functionality equivalent
// to `o instanceof EncryptedData`
const isEncryptedData = (o) => {
    return !!o && !!Object.getPrototypeOf(o)?._isEncryptedData;
};
exports.isEncryptedData = isEncryptedData;
// TODO: Check for permissions and allowedActions; this requires passing some
// additional context
const encryptData = function (stateOrContractID, eKeyId, data, additionalData) {
    const state = typeof stateOrContractID === 'string' ? rootStateFn()[stateOrContractID] : stateOrContractID;
    // Has the key been revoked? If so, attempt to find an authorized key by the same name
    const designatedKey = state?._vm?.authorizedKeys?.[eKeyId];
    if (!designatedKey?.purpose.includes('enc')) {
        throw new Error(`Encryption key ID ${eKeyId} is missing or is missing encryption purpose`);
    }
    if (designatedKey._notAfterHeight != null) {
        const name = state._vm.authorizedKeys[eKeyId].name;
        const newKeyId = Object.values(state._vm?.authorizedKeys).find((v) => v._notAfterHeight == null && v.name === name && v.purpose.includes('enc'))?.id;
        if (!newKeyId) {
            throw new Error(`Encryption key ID ${eKeyId} has been revoked and no new key exists by the same name (${name})`);
        }
        eKeyId = newKeyId;
    }
    const key = state._vm?.authorizedKeys?.[eKeyId].data;
    if (!key) {
        throw new Error(`Missing encryption key ${eKeyId}`);
    }
    const deserializedKey = typeof key === 'string' ? (0, crypto_1.deserializeKey)(key) : key;
    return [
        (0, crypto_1.keyId)(deserializedKey),
        (0, crypto_1.encrypt)(deserializedKey, JSON.stringify(data, (_, v) => {
            if (v && (0, turtledash_1.has)(v, 'serialize') && typeof v.serialize === 'function') {
                if (v.serialize.length === 1) {
                    return v.serialize(additionalData);
                }
                else {
                    return v.serialize();
                }
            }
            return v;
        }), additionalData)
    ];
};
// TODO: Check for permissions and allowedActions; this requires passing the
// entire SPMessage
const decryptData = function (state, height, data, additionalKeys, additionalData, validatorFn) {
    if (!state) {
        throw new errors_js_1.ChelErrorDecryptionError('Missing contract state');
    }
    // Compatibility with signedData (composed signed + encrypted data)
    if (typeof data.valueOf === 'function')
        data = data.valueOf();
    if (!(0, exports.isRawEncryptedData)(data)) {
        throw new errors_js_1.ChelErrorDecryptionError('Invalid message format');
    }
    const [eKeyId, message] = data;
    const key = additionalKeys[eKeyId];
    if (!key) {
        throw new errors_js_1.ChelErrorDecryptionKeyNotFound(`Key ${eKeyId} not found`, { cause: eKeyId });
    }
    // height as NaN is used to allow checking for revokedKeys as well as
    // authorizedKeys when decrypting data. This is normally inappropriate because
    // revoked keys should be considered compromised and not used for encrypting
    // new data
    // However, OP_KEY_SHARE may include data encrypted with some other contract's
    // keys when a key rotation is done. This is done, along with OP_ATOMIC and
    // OP_KEY_UPDATE to rotate keys in a contract while allowing member contracts
    // to retrieve and use the new key material.
    // In such scenarios, since the keys really live in that other contract, it is
    // impossible to know if the keys had been revoked in the 'source' contract
    // at the time the key rotation was done. This is also different from foreign
    // keys because these encryption keys are not necessarily authorized in the
    // contract issuing OP_KEY_SHARE, and what is important is to refer to the
    // (keys in the) foreign contract explicitly, as an alternative to sending
    // an OP_KEY_SHARE to that contract.
    // Using revoked keys represents some security risk since, as mentioned, they
    // should generlly be considered compromised. However, in the scenario above
    // we can trust that the party issuing OP_KEY_SHARE is not maliciously using
    // old (revoked) keys, because there is little to be gained from not doing
    // this. If that party's intention were to leak or compromise keys, they can
    // already do so by other means, since they have access to the raw secrets
    // that OP_KEY_SHARE is meant to protect. Hence, this attack does not open up
    // any new attack vectors or venues that were not already available using
    // different means.
    const designatedKey = state._vm?.authorizedKeys?.[eKeyId];
    if (!designatedKey || (height > designatedKey._notAfterHeight) || (height < designatedKey._notBeforeHeight) || !designatedKey.purpose.includes('enc')) {
        throw new errors_js_1.ChelErrorUnexpected(`Key ${eKeyId} is unauthorized or expired for the current contract`);
    }
    const deserializedKey = typeof key === 'string' ? (0, crypto_1.deserializeKey)(key) : key;
    try {
        const result = JSON.parse((0, crypto_1.decrypt)(deserializedKey, message, additionalData));
        if (typeof validatorFn === 'function')
            validatorFn(result, eKeyId);
        return result;
    }
    catch (e) {
        throw new errors_js_1.ChelErrorDecryptionError(e?.message || e);
    }
};
const encryptedOutgoingData = (stateOrContractID, eKeyId, data) => {
    if (!stateOrContractID || data === undefined || !eKeyId)
        throw new TypeError('Invalid invocation');
    const boundStringValueFn = encryptData.bind(null, stateOrContractID, eKeyId, data);
    return wrapper({
        get encryptionKeyId() {
            return eKeyId;
        },
        get serialize() {
            return (additionalData) => boundStringValueFn(additionalData || '');
        },
        get toString() {
            return (additionalData) => JSON.stringify(this.serialize(additionalData));
        },
        get valueOf() {
            return () => data;
        }
    });
};
exports.encryptedOutgoingData = encryptedOutgoingData;
// Used for OP_CONTRACT as a state does not yet exist
const encryptedOutgoingDataWithRawKey = (key, data) => {
    if (data === undefined || !key)
        throw new TypeError('Invalid invocation');
    const eKeyId = (0, crypto_1.keyId)(key);
    const state = {
        _vm: {
            authorizedKeys: {
                [eKeyId]: {
                    purpose: ['enc'],
                    data: (0, crypto_1.serializeKey)(key, false),
                    _notBeforeHeight: 0,
                    _notAfterHeight: undefined
                }
            }
        }
    };
    const boundStringValueFn = encryptData.bind(null, state, eKeyId, data);
    return wrapper({
        get encryptionKeyId() {
            return eKeyId;
        },
        get serialize() {
            return (additionalData) => boundStringValueFn(additionalData || '');
        },
        get toString() {
            return (additionalData) => JSON.stringify(this.serialize(additionalData));
        },
        get valueOf() {
            return () => data;
        }
    });
};
exports.encryptedOutgoingDataWithRawKey = encryptedOutgoingDataWithRawKey;
const encryptedIncomingData = (contractID, state, data, height, additionalKeys, additionalData, validatorFn) => {
    let decryptedValue;
    const decryptedValueFn = () => {
        if (decryptedValue) {
            return decryptedValue;
        }
        if (!state || !additionalKeys) {
            const rootState = rootStateFn();
            state = state || rootState[contractID];
            additionalKeys = additionalKeys ?? rootState.secretKeys;
        }
        decryptedValue = decryptData(state, height, data, additionalKeys, additionalData || '', validatorFn);
        if ((0, signedData_js_1.isRawSignedData)(decryptedValue)) {
            decryptedValue = (0, signedData_js_1.signedIncomingData)(contractID, state, decryptedValue, height, additionalData || '');
        }
        return decryptedValue;
    };
    return wrapper({
        get encryptionKeyId() {
            return (0, exports.encryptedDataKeyId)(data);
        },
        get serialize() {
            return () => data;
        },
        get toString() {
            return () => JSON.stringify(this.serialize());
        },
        get valueOf() {
            return decryptedValueFn;
        },
        get toJSON() {
            return this.serialize;
        }
    });
};
exports.encryptedIncomingData = encryptedIncomingData;
const encryptedIncomingForeignData = (contractID, _0, data, _1, additionalKeys, additionalData, validatorFn) => {
    let decryptedValue;
    const decryptedValueFn = () => {
        if (decryptedValue) {
            return decryptedValue;
        }
        const rootState = rootStateFn();
        const state = rootState[contractID];
        decryptedValue = decryptData(state, NaN, data, additionalKeys ?? rootState.secretKeys, additionalData || '', validatorFn);
        if ((0, signedData_js_1.isRawSignedData)(decryptedValue)) {
            // TODO: Specify height
            return (0, signedData_js_1.signedIncomingData)(contractID, state, decryptedValue, NaN, additionalData || '');
        }
        return decryptedValue;
    };
    return wrapper({
        get encryptionKeyId() {
            return (0, exports.encryptedDataKeyId)(data);
        },
        get serialize() {
            return () => data;
        },
        get toString() {
            return () => JSON.stringify(this.serialize());
        },
        get valueOf() {
            return decryptedValueFn;
        },
        get toJSON() {
            return this.serialize;
        }
    });
};
exports.encryptedIncomingForeignData = encryptedIncomingForeignData;
const encryptedIncomingDataWithRawKey = (key, data, additionalData) => {
    if (data === undefined || !key)
        throw new TypeError('Invalid invocation');
    let decryptedValue;
    const eKeyId = (0, crypto_1.keyId)(key);
    const decryptedValueFn = () => {
        if (decryptedValue) {
            return decryptedValue;
        }
        const state = {
            _vm: {
                authorizedKeys: {
                    [eKeyId]: {
                        purpose: ['enc'],
                        data: (0, crypto_1.serializeKey)(key, false),
                        _notBeforeHeight: 0,
                        _notAfterHeight: undefined
                    }
                }
            }
        };
        decryptedValue = decryptData(state, NaN, data, { [eKeyId]: key }, additionalData || '');
        return decryptedValue;
    };
    return wrapper({
        get encryptionKeyId() {
            return (0, exports.encryptedDataKeyId)(data);
        },
        get serialize() {
            return () => data;
        },
        get toString() {
            return () => JSON.stringify(this.serialize());
        },
        get valueOf() {
            return decryptedValueFn;
        },
        get toJSON() {
            return this.serialize;
        }
    });
};
exports.encryptedIncomingDataWithRawKey = encryptedIncomingDataWithRawKey;
const encryptedDataKeyId = (data) => {
    if (!(0, exports.isRawEncryptedData)(data)) {
        throw new errors_js_1.ChelErrorDecryptionError('Invalid message format');
    }
    return data[0];
};
exports.encryptedDataKeyId = encryptedDataKeyId;
const isRawEncryptedData = (data) => {
    if (!Array.isArray(data) || data.length !== 2 || data.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
        return false;
    }
    return true;
};
exports.isRawEncryptedData = isRawEncryptedData;
const unwrapMaybeEncryptedData = (data) => {
    if (data == null)
        return;
    if ((0, exports.isEncryptedData)(data)) {
        try {
            return {
                encryptionKeyId: data.encryptionKeyId,
                data: data.valueOf()
            };
        }
        catch (e) {
            console.warn('unwrapMaybeEncryptedData: Unable to decrypt', e);
        }
    }
    else {
        return {
            encryptionKeyId: null,
            data
        };
    }
};
exports.unwrapMaybeEncryptedData = unwrapMaybeEncryptedData;
const maybeEncryptedIncomingData = (contractID, state, data, height, additionalKeys, additionalData, validatorFn) => {
    if ((0, exports.isRawEncryptedData)(data)) {
        return (0, exports.encryptedIncomingData)(contractID, state, data, height, additionalKeys, additionalData, validatorFn);
    }
    else {
        validatorFn?.(data, '');
        return data;
    }
};
exports.maybeEncryptedIncomingData = maybeEncryptedIncomingData;
