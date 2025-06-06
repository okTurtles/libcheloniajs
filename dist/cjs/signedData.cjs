"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rawSignedIncomingData = exports.isRawSignedData = exports.signedDataKeyId = exports.signedIncomingData = exports.signedOutgoingDataWithRawKey = exports.signedOutgoingData = exports.isSignedData = void 0;
const crypto_1 = require("@chelonia/crypto");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const errors_js_1 = require("./errors.cjs");
const functions_js_1 = require("./functions.cjs");
const rootStateFn = () => (0, sbp_1.default)('chelonia/rootState');
// `proto` & `wrapper` are utilities for `isSignedData`
const proto = Object.create(null, {
    _isSignedData: {
        value: true
    }
});
const wrapper = (o) => {
    return Object.setPrototypeOf(o, proto);
};
// `isSignedData` will return true for objects created by the various
// `signed*Data` functions. It's meant to implement functionality equivalent
// to `o instanceof SignedData`
const isSignedData = (o) => {
    return !!o && !!Object.getPrototypeOf(o)?._isSignedData;
};
exports.isSignedData = isSignedData;
// TODO: Check for permissions and allowedActions; this requires passing some
// additional context
const signData = function (stateOrContractID, sKeyId, data, extraFields, additionalKeys, additionalData) {
    const state = typeof stateOrContractID === 'string' ? rootStateFn()[stateOrContractID] : stateOrContractID;
    if (!additionalData) {
        throw new errors_js_1.ChelErrorSignatureError('Signature additional data must be provided');
    }
    // Has the key been revoked? If so, attempt to find an authorized key by the same name
    const designatedKey = state?._vm?.authorizedKeys?.[sKeyId];
    if (!designatedKey?.purpose.includes('sig')) {
        throw new errors_js_1.ChelErrorSignatureKeyNotFound(`Signing key ID ${sKeyId} is missing or is missing signing purpose`);
    }
    if (designatedKey._notAfterHeight != null) {
        const name = state._vm.authorizedKeys[sKeyId].name;
        const newKeyId = Object.values(state._vm?.authorizedKeys).find((v) => v._notAfterHeight == null && v.name === name && v.purpose.includes('sig'))?.id;
        if (!newKeyId) {
            throw new errors_js_1.ChelErrorSignatureKeyNotFound(`Signing key ID ${sKeyId} has been revoked and no new key exists by the same name (${name})`);
        }
        sKeyId = newKeyId;
    }
    const key = additionalKeys[sKeyId];
    if (!key) {
        throw new errors_js_1.ChelErrorSignatureKeyNotFound(`Missing signing key ${sKeyId}`);
    }
    const deserializedKey = typeof key === 'string' ? (0, crypto_1.deserializeKey)(key) : key;
    const serializedData = JSON.stringify(data, (_, v) => {
        if (v && (0, turtledash_1.has)(v, 'serialize') && typeof v.serialize === 'function') {
            if (v.serialize.length === 1) {
                return v.serialize(additionalData);
            }
            else {
                return v.serialize();
            }
        }
        return v;
    });
    const payloadToSign = (0, functions_js_1.blake32Hash)(`${(0, functions_js_1.blake32Hash)(additionalData)}${(0, functions_js_1.blake32Hash)(serializedData)}`);
    return {
        ...extraFields,
        _signedData: [
            serializedData,
            (0, crypto_1.keyId)(deserializedKey),
            (0, crypto_1.sign)(deserializedKey, payloadToSign)
        ]
    };
};
// TODO: Check for permissions and allowedActions; this requires passing the
// entire SPMessage
const verifySignatureData = function (state, height, data, additionalData) {
    if (!state) {
        throw new errors_js_1.ChelErrorSignatureError('Missing contract state');
    }
    if (!(0, exports.isRawSignedData)(data)) {
        throw new errors_js_1.ChelErrorSignatureError('Invalid message format');
    }
    if (!Number.isSafeInteger(height) || height < 0) {
        throw new errors_js_1.ChelErrorSignatureError(`Height ${height} is invalid or out of range`);
    }
    const [serializedMessage, sKeyId, signature] = data._signedData;
    const designatedKey = state._vm?.authorizedKeys?.[sKeyId];
    if (!designatedKey || (height > designatedKey._notAfterHeight) || (height < designatedKey._notBeforeHeight) || !designatedKey.purpose.includes('sig')) {
        // These errors (ChelErrorSignatureKeyUnauthorized) are serious and
        // indicate a bug. Make them fatal when running integration tests
        // (otherwise, they get swallowed and shown as a notification)
        if (process.env.CI) {
            console.error(`Key ${sKeyId} is unauthorized or expired for the current contract`, { designatedKey, height, state: JSON.parse(JSON.stringify((0, sbp_1.default)('state/vuex/state'))) });
            // An unhandled promise rejection will cause Cypress to fail
            Promise.reject(new errors_js_1.ChelErrorSignatureKeyUnauthorized(`Key ${sKeyId} is unauthorized or expired for the current contract`));
        }
        throw new errors_js_1.ChelErrorSignatureKeyUnauthorized(`Key ${sKeyId} is unauthorized or expired for the current contract`);
    }
    // TODO
    const deserializedKey = designatedKey.data;
    const payloadToSign = (0, functions_js_1.blake32Hash)(`${(0, functions_js_1.blake32Hash)(additionalData)}${(0, functions_js_1.blake32Hash)(serializedMessage)}`);
    try {
        (0, crypto_1.verifySignature)(deserializedKey, payloadToSign, signature);
        const message = JSON.parse(serializedMessage);
        return [sKeyId, message];
    }
    catch (e) {
        throw new errors_js_1.ChelErrorSignatureError(e?.message || e);
    }
};
const signedOutgoingData = (stateOrContractID, sKeyId, data, additionalKeys) => {
    if (!stateOrContractID || data === undefined || !sKeyId)
        throw new TypeError('Invalid invocation');
    if (!additionalKeys) {
        additionalKeys = rootStateFn().secretKeys;
    }
    const extraFields = Object.create(null);
    const boundStringValueFn = signData.bind(null, stateOrContractID, sKeyId, data, extraFields, additionalKeys);
    const serializefn = (additionalData) => boundStringValueFn(additionalData || '');
    return wrapper({
        get signingKeyId() {
            return sKeyId;
        },
        get serialize() {
            return serializefn;
        },
        get toString() {
            return (additionalData) => JSON.stringify(this.serialize(additionalData));
        },
        get valueOf() {
            return () => data;
        },
        get recreate() {
            return (data) => (0, exports.signedOutgoingData)(stateOrContractID, sKeyId, data, additionalKeys);
        },
        get get() {
            return (k) => extraFields[k];
        },
        get set() {
            return (k, v) => {
                extraFields[k] = v;
            };
        }
    });
};
exports.signedOutgoingData = signedOutgoingData;
// Used for OP_CONTRACT as a state does not yet exist
const signedOutgoingDataWithRawKey = (key, data) => {
    const sKeyId = (0, crypto_1.keyId)(key);
    const state = {
        _vm: {
            authorizedKeys: {
                [sKeyId]: {
                    purpose: ['sig'],
                    data: (0, crypto_1.serializeKey)(key, false),
                    _notBeforeHeight: 0,
                    _notAfterHeight: undefined
                }
            }
        }
    };
    const extraFields = Object.create(null);
    const boundStringValueFn = signData.bind(null, state, sKeyId, data, extraFields, { [sKeyId]: key });
    const serializefn = (additionalData) => boundStringValueFn(additionalData || '');
    return wrapper({
        get signingKeyId() {
            return sKeyId;
        },
        get serialize() {
            return serializefn;
        },
        get toString() {
            return (additionalData) => JSON.stringify(this.serialize(additionalData));
        },
        get valueOf() {
            return () => data;
        },
        get recreate() {
            return (data) => (0, exports.signedOutgoingDataWithRawKey)(key, data);
        },
        get get() {
            return (k) => extraFields[k];
        },
        get set() {
            return (k, v) => {
                extraFields[k] = v;
            };
        }
    });
};
exports.signedOutgoingDataWithRawKey = signedOutgoingDataWithRawKey;
const signedIncomingData = (contractID, state, data, height, additionalData, mapperFn) => {
    const stringValueFn = () => data;
    let verifySignedValue;
    const verifySignedValueFn = () => {
        if (verifySignedValue) {
            return verifySignedValue[1];
        }
        verifySignedValue = verifySignatureData(state || rootStateFn()[contractID], height, data, additionalData);
        if (mapperFn)
            verifySignedValue[1] = mapperFn(verifySignedValue[1]);
        return verifySignedValue[1];
    };
    return wrapper({
        get signingKeyId() {
            if (verifySignedValue)
                return verifySignedValue[0];
            return (0, exports.signedDataKeyId)(data);
        },
        get serialize() {
            return stringValueFn;
        },
        get context() {
            return [contractID, data, height, additionalData];
        },
        get toString() {
            return () => JSON.stringify(this.serialize());
        },
        get valueOf() {
            return verifySignedValueFn;
        },
        get toJSON() {
            return this.serialize;
        },
        get get() {
            return (k) => k !== '_signedData' ? data[k] : undefined;
        }
    });
};
exports.signedIncomingData = signedIncomingData;
const signedDataKeyId = (data) => {
    if (!(0, exports.isRawSignedData)(data)) {
        throw new errors_js_1.ChelErrorSignatureError('Invalid message format');
    }
    return data._signedData[1];
};
exports.signedDataKeyId = signedDataKeyId;
const isRawSignedData = (data) => {
    if (!data || typeof data !== 'object' || !(0, turtledash_1.has)(data, '_signedData') || !Array.isArray(data._signedData) || data._signedData.length !== 3 || data._signedData.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
        return false;
    }
    return true;
};
exports.isRawSignedData = isRawSignedData;
// WARNING: The following function (rawSignedIncomingData) will not check signatures
const rawSignedIncomingData = (data) => {
    if (!(0, exports.isRawSignedData)(data)) {
        throw new errors_js_1.ChelErrorSignatureError('Invalid message format');
    }
    const stringValueFn = () => data;
    let verifySignedValue;
    const verifySignedValueFn = () => {
        if (verifySignedValue) {
            return verifySignedValue[1];
        }
        verifySignedValue = [data._signedData[1], JSON.parse(data._signedData[0])];
        return verifySignedValue[1];
    };
    return wrapper({
        get signingKeyId() {
            if (verifySignedValue)
                return verifySignedValue[0];
            return (0, exports.signedDataKeyId)(data);
        },
        get serialize() {
            return stringValueFn;
        },
        get toString() {
            return () => JSON.stringify(this.serialize());
        },
        get valueOf() {
            return verifySignedValueFn;
        },
        get toJSON() {
            return this.serialize;
        },
        get get() {
            return (k) => k !== '_signedData' ? data[k] : undefined;
        }
    });
};
exports.rawSignedIncomingData = rawSignedIncomingData;
