import { keyId } from '@chelonia/crypto';
import { serdesDeserializeSymbol, serdesSerializeSymbol, serdesTagSymbol } from '@chelonia/serdes';
import { has } from 'turtledash';
import { encryptedIncomingData, encryptedIncomingForeignData, maybeEncryptedIncomingData, unwrapMaybeEncryptedData } from './encryptedData.mjs';
import { createCID, multicodes } from './functions.mjs';
import { isRawSignedData, isSignedData, rawSignedIncomingData, signedIncomingData } from './signedData.mjs';
// Takes a raw message and processes it so that EncryptedData and SignedData
// attributes are defined
const decryptedAndVerifiedDeserializedMessage = (head, headJSON, contractID, parsedMessage, additionalKeys, state) => {
    const op = head.op;
    const height = head.height;
    const message = op === SPMessage.OP_ACTION_ENCRYPTED
        ? encryptedIncomingData(contractID, state, parsedMessage, height, additionalKeys, headJSON, undefined)
        : parsedMessage;
    // If the operation is SPMessage.OP_KEY_ADD or SPMessage.OP_KEY_UPDATE,
    // extract encrypted data from key.meta?.private?.content
    if ([SPMessage.OP_KEY_ADD, SPMessage.OP_KEY_UPDATE].includes(op)) {
        return message.map((key) => {
            return maybeEncryptedIncomingData(contractID, state, key, height, additionalKeys, headJSON, (key) => {
                if (key.meta?.private?.content) {
                    key.meta.private.content = encryptedIncomingData(contractID, state, key.meta.private.content, height, additionalKeys, headJSON, (value) => {
                        // Validator function to verify the key matches its expected ID
                        const computedKeyId = keyId(value);
                        if (computedKeyId !== key.id) {
                            throw new Error(`Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`);
                        }
                    });
                }
                // key.meta?.keyRequest?.contractID could be optionally encrypted
                if (key.meta?.keyRequest?.reference) {
                    try {
                        key.meta.keyRequest.reference = maybeEncryptedIncomingData(contractID, state, key.meta.keyRequest.reference, height, additionalKeys, headJSON)?.valueOf();
                    }
                    catch {
                        // If we couldn't decrypt it, this value is of no use to us (we
                        // can't keep track of key requests and key shares), so we delete it
                        delete key.meta.keyRequest.reference;
                    }
                }
                // key.meta?.keyRequest?.contractID could be optionally encrypted
                if (key.meta?.keyRequest?.contractID) {
                    try {
                        key.meta.keyRequest.contractID = maybeEncryptedIncomingData(contractID, state, key.meta.keyRequest.contractID, height, additionalKeys, headJSON)?.valueOf();
                    }
                    catch {
                        // If we couldn't decrypt it, this value is of no use to us (we
                        // can't keep track of key requests and key shares), so we delete it
                        delete key.meta.keyRequest.contractID;
                    }
                }
            });
        });
    }
    // If the operation is SPMessage.OP_CONTRACT,
    // extract encrypted data from keys?.[].meta?.private?.content
    if (op === SPMessage.OP_CONTRACT) {
        message.keys = message.keys?.map((key) => {
            return maybeEncryptedIncomingData(contractID, state, key, height, additionalKeys, headJSON, (key) => {
                if (!key.meta?.private?.content)
                    return;
                // The following two lines are commented out because this feature
                // (using a foreign decryption contract) doesn't seem to be in use and
                // the use case seems unclear.
                // const decryptionFn = key.meta.private.foreignContractID ? encryptedIncomingForeignData : encryptedIncomingData
                // const decryptionContract = key.meta.private.foreignContractID ? key.meta.private.foreignContractID : contractID
                const decryptionFn = encryptedIncomingData;
                const decryptionContract = contractID;
                key.meta.private.content = decryptionFn(decryptionContract, state, key.meta.private.content, height, additionalKeys, headJSON, (value) => {
                    const computedKeyId = keyId(value);
                    if (computedKeyId !== key.id) {
                        throw new Error(`Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`);
                    }
                });
            });
        });
    }
    // If the operation is SPMessage.OP_KEY_SHARE,
    // extract encrypted data from keys?.[].meta?.private?.content
    if (op === SPMessage.OP_KEY_SHARE) {
        return maybeEncryptedIncomingData(contractID, state, message, height, additionalKeys, headJSON, (message) => {
            message.keys?.forEach((key) => {
                if (!key.meta?.private?.content)
                    return;
                const decryptionFn = message.foreignContractID
                    ? encryptedIncomingForeignData
                    : encryptedIncomingData;
                const decryptionContract = message.foreignContractID || contractID;
                key.meta.private.content = decryptionFn(decryptionContract, state, key.meta.private.content, height, additionalKeys, headJSON, (value) => {
                    const computedKeyId = keyId(value);
                    if (computedKeyId !== key.id) {
                        throw new Error(`Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`);
                    }
                });
            });
        });
    }
    // If the operation is OP_KEY_REQUEST, the payload might be EncryptedData
    // The ReplyWith attribute is SignedData
    if (op === SPMessage.OP_KEY_REQUEST) {
        return maybeEncryptedIncomingData(contractID, state, message, height, additionalKeys, headJSON, (msg, id) => {
            // V2 format has `innerData`, V1 does not. V2 always has an _unencrypted_
            // outer layer.
            if (!id && has(msg, 'innerData')) {
                msg.innerData =
                    maybeEncryptedIncomingData(contractID, state, msg.innerData, height, additionalKeys, headJSON, (innerMsg) => {
                        innerMsg.replyWith = signedIncomingData(innerMsg.contractID, undefined, innerMsg.replyWith, innerMsg.height, headJSON);
                    });
            }
            else {
                msg.replyWith = signedIncomingData(msg.contractID, undefined, msg.replyWith, msg.height, headJSON);
            }
        });
    }
    // If the operation is OP_ACTION_UNENCRYPTED, it may contain an inner
    // signature
    // Actions must be signed using a key for the current contract
    if (op === SPMessage.OP_ACTION_UNENCRYPTED && isRawSignedData(message)) {
        return signedIncomingData(contractID, state, message, height, headJSON);
    }
    // Inner signatures are handled by EncryptedData
    if (op === SPMessage.OP_ACTION_ENCRYPTED) {
        return message;
    }
    if (op === SPMessage.OP_KEY_DEL) {
        return message.map((key) => {
            return maybeEncryptedIncomingData(contractID, state, key, height, additionalKeys, headJSON, undefined);
        });
    }
    if (op === SPMessage.OP_KEY_REQUEST_SEEN) {
        return maybeEncryptedIncomingData(contractID, state, parsedMessage, height, additionalKeys, headJSON, (data, id) => {
            if (!id && has(data, 'innerData')) {
                const dataV2 = data;
                if (dataV2.innerData) {
                    dataV2.innerData = maybeEncryptedIncomingData(contractID, state, dataV2.innerData, height, additionalKeys, headJSON);
                }
            }
        });
    }
    // If the operation is OP_ATOMIC, call this function recursively
    if (op === SPMessage.OP_ATOMIC) {
        return message.map(([opT, opV]) => [
            opT,
            decryptedAndVerifiedDeserializedMessage({ ...head, op: opT }, headJSON, contractID, opV, additionalKeys, state)
        ]);
    }
    return message;
};
export class SPMessage {
    // flow type annotations to make flow happy
    _mapping;
    _head;
    _message;
    _signedMessageData;
    _direction;
    _decryptedValue;
    _innerSigningKeyId;
    static OP_CONTRACT = 'c';
    static OP_ACTION_ENCRYPTED = 'ae'; // e2e-encrypted action
    static OP_ACTION_UNENCRYPTED = 'au'; // publicly readable action
    static OP_KEY_ADD = 'ka'; // add this key to the list of keys allowed to write to this contract, or update an existing key
    static OP_KEY_DEL = 'kd'; // remove this key from authorized keys
    static OP_KEY_UPDATE = 'ku'; // update key in authorized keys
    static OP_PROTOCOL_UPGRADE = 'pu';
    static OP_PROP_SET = 'ps'; // set a public key/value pair
    static OP_PROP_DEL = 'pd'; // delete a public key/value pair
    static OP_CONTRACT_AUTH = 'ca'; // authorize a contract
    static OP_CONTRACT_DEAUTH = 'cd'; // deauthorize a contract
    static OP_ATOMIC = 'a'; // atomic op
    static OP_KEY_SHARE = 'ks'; // key share
    static OP_KEY_REQUEST = 'kr'; // key request
    static OP_KEY_REQUEST_SEEN = 'krs'; // key request response
    // eslint-disable-next-line camelcase
    static createV1_0({ contractID, previousHEAD = null, previousKeyOp = null, 
    // Height will be automatically set to the correct value when sending
    // The reason to set it to Number.MAX_SAFE_INTEGER is so that we can
    // temporarily process outgoing messages with signature validation
    // still working
    height = Number.MAX_SAFE_INTEGER, op, manifest }) {
        const head = {
            version: '1.0.0',
            previousHEAD,
            previousKeyOp,
            height,
            contractID,
            op: op[0],
            manifest
        };
        return new this(messageToParams(head, op[1]));
    }
    // SPMessage.cloneWith could be used when make a SPMessage object having the same id()
    // https://github.com/okTurtles/group-income/issues/1503
    static cloneWith(targetHead, targetOp, sources) {
        const head = Object.assign({}, targetHead, sources);
        return new this(messageToParams(head, targetOp[1]));
    }
    static deserialize(value, additionalKeys, state, unwrapMaybeEncryptedDataFn = unwrapMaybeEncryptedData) {
        if (!value)
            throw new Error(`deserialize bad value: ${value}`);
        const { head: headJSON, ...parsedValue } = JSON.parse(value);
        const head = JSON.parse(headJSON);
        const contractID = head.op === SPMessage.OP_CONTRACT
            ? createCID(value, multicodes.SHELTER_CONTRACT_DATA)
            : head.contractID;
        // Special case for OP_CONTRACT, since the keys are not yet present in the
        // state
        if (!state?._vm?.authorizedKeys && head.op === SPMessage.OP_CONTRACT) {
            const value = rawSignedIncomingData(parsedValue);
            const authorizedKeys = Object.fromEntries(value
                .valueOf()
                ?.keys.map((wk) => {
                const k = unwrapMaybeEncryptedDataFn(wk);
                if (!k)
                    return null;
                return [k.data.id, k.data];
            })
                // eslint-disable-next-line no-use-before-define
                .filter(Boolean));
            state = {
                _vm: {
                    type: head.type,
                    authorizedKeys
                }
            };
        }
        const signedMessageData = signedIncomingData(contractID, state, parsedValue, head.height, headJSON, (message) => decryptedAndVerifiedDeserializedMessage(head, headJSON, contractID, message, additionalKeys, state));
        return new this({
            direction: 'incoming',
            mapping: { key: createCID(value, multicodes.SHELTER_CONTRACT_DATA), value },
            head,
            signedMessageData
        });
    }
    static deserializeHEAD(value) {
        if (!value)
            throw new Error(`deserialize bad value: ${value}`);
        let head, hash;
        const result = {
            get head() {
                if (head === undefined) {
                    head = JSON.parse(JSON.parse(value).head);
                }
                return head;
            },
            get hash() {
                if (!hash) {
                    hash = createCID(value, multicodes.SHELTER_CONTRACT_DATA);
                }
                return hash;
            },
            get contractID() {
                return result.head?.contractID ?? result.hash;
            },
            // `description` is not a getter to prevent the value from being copied
            // if the object is cloned or serialized
            description() {
                const type = this.head.op;
                return `<op_${type}|${this.hash} of ${this.contractID}>`;
            },
            get isFirstMessage() {
                return !result.head?.contractID;
            }
        };
        return result;
    }
    constructor(params) {
        this._direction = params.direction;
        this._mapping = params.mapping;
        this._head = params.head;
        this._signedMessageData = params.signedMessageData;
        // perform basic sanity check
        const type = this.opType();
        let atomicTopLevel = true;
        const validate = (type, message) => {
            switch (type) {
                case SPMessage.OP_CONTRACT:
                    if (!this.isFirstMessage() || !atomicTopLevel) {
                        throw new Error('OP_CONTRACT: must be first message');
                    }
                    break;
                case SPMessage.OP_ATOMIC:
                    if (!atomicTopLevel) {
                        throw new Error('OP_ATOMIC not allowed inside of OP_ATOMIC');
                    }
                    if (!Array.isArray(message)) {
                        throw new TypeError('OP_ATOMIC must be of an array type');
                    }
                    atomicTopLevel = false;
                    message.forEach(([t, m]) => validate(t, m));
                    break;
                case SPMessage.OP_KEY_ADD:
                case SPMessage.OP_KEY_DEL:
                case SPMessage.OP_KEY_UPDATE:
                    if (!Array.isArray(message)) {
                        throw new TypeError('OP_KEY_{ADD|DEL|UPDATE} must be of an array type');
                    }
                    break;
                case SPMessage.OP_KEY_SHARE:
                case SPMessage.OP_KEY_REQUEST:
                case SPMessage.OP_KEY_REQUEST_SEEN:
                case SPMessage.OP_ACTION_ENCRYPTED:
                case SPMessage.OP_ACTION_UNENCRYPTED:
                    // nothing for now
                    break;
                default:
                    throw new Error(`unsupported op: ${type}`);
            }
        };
        // this._message is set as a getter to verify the signature only once the
        // message contents are read
        Object.defineProperty(this, '_message', {
            get: ((validated) => () => {
                const message = this._signedMessageData.valueOf();
                // If we haven't validated the message, validate it now
                if (!validated) {
                    validate(type, message);
                    validated = true;
                }
                return message;
            })()
        });
    }
    decryptedValue() {
        if (this._decryptedValue)
            return this._decryptedValue;
        try {
            const value = this.message();
            // TODO: This uses `unwrapMaybeEncryptedData` instead of a configurable
            // version based on `skipDecryptionAttempts`. This is fine based on current
            // use, and also something else might be confusing based on the explicit
            // name of this function, `decryptedValue`.
            const data = unwrapMaybeEncryptedData(value);
            // Did decryption succeed? (unwrapMaybeEncryptedData will return undefined
            // on failure)
            if (data?.data) {
                // The data inside could be signed. In this case, we unwrap that to get
                // to the inner contents
                if (isSignedData(data.data)) {
                    this._innerSigningKeyId = data.data.signingKeyId;
                    this._decryptedValue = data.data.valueOf();
                }
                else {
                    this._decryptedValue = data.data;
                }
            }
            return this._decryptedValue;
        }
        catch {
            // Signature or encryption error
            // We don't log this error because it's already logged when the value is
            // retrieved
            return undefined;
        }
    }
    innerSigningKeyId() {
        if (!this._decryptedValue) {
            this.decryptedValue();
        }
        return this._innerSigningKeyId;
    }
    head() {
        return this._head;
    }
    message() {
        return this._message;
    }
    op() {
        return [this.head().op, this.message()];
    }
    rawOp() {
        return [this.head().op, this._signedMessageData];
    }
    opType() {
        return this.head().op;
    }
    opValue() {
        return this.message();
    }
    signingKeyId() {
        return this._signedMessageData.signingKeyId;
    }
    manifest() {
        return this.head().manifest;
    }
    description() {
        const type = this.opType();
        let desc = `<op_${type}`;
        if (type === SPMessage.OP_ACTION_UNENCRYPTED) {
            try {
                const value = this.opValue().valueOf();
                if (typeof value.action === 'string') {
                    desc += `|${value.action}`;
                }
            }
            catch (e) {
                console.warn('Error on .description()', this.hash(), e);
            }
        }
        return `${desc}|${this.hash()} of ${this.contractID()}>`;
    }
    isFirstMessage() {
        return !this.head().contractID;
    }
    contractID() {
        return this.head().contractID || this.hash();
    }
    serialize() {
        return this._mapping.value;
    }
    hash() {
        return this._mapping.key;
    }
    previousKeyOp() {
        return this._head.previousKeyOp;
    }
    height() {
        return this._head.height;
    }
    id() {
        // TODO: Schedule for later removal
        throw new Error('SPMessage.id() was called but it has been removed');
    }
    direction() {
        return this._direction;
    }
    // `isKeyOp` is used to filter out non-key operations for providing an
    // abbreviated chain fo snapshot validation
    isKeyOp() {
        let value;
        return !!(keyOps.includes(this.opType()) ||
            (this.opType() === SPMessage.OP_ATOMIC &&
                Array.isArray((value = this.opValue())) &&
                value.some(([opT]) => {
                    return keyOps.includes(opT);
                })));
    }
    static get [serdesTagSymbol]() {
        return 'SPMessage';
    }
    static [serdesSerializeSymbol](m) {
        return [m.serialize(), m.direction(), m.decryptedValue(), m.innerSigningKeyId()];
    }
    static [serdesDeserializeSymbol]([serialized, direction, decryptedValue, innerSigningKeyId]) {
        const m = SPMessage.deserialize(serialized);
        m._direction = direction;
        m._decryptedValue = decryptedValue;
        m._innerSigningKeyId = innerSigningKeyId;
        return m;
    }
}
function messageToParams(head, message) {
    // NOTE: the JSON strings generated here must be preserved forever.
    //       do not ever regenerate this message using the contructor.
    //       instead store it using serialize() and restore it using deserialize().
    //       The issue is that different implementations of JavaScript engines might generate different strings
    //       when serializing JS objects using JSON.stringify
    //       and that would lead to different hashes resulting from createCID.
    //       So to get around this we save the serialized string upon creation
    //       and keep a copy of it (instead of regenerating it as needed).
    //       https://github.com/okTurtles/group-income/pull/1513#discussion_r1142809095
    let mapping;
    return {
        direction: has(message, 'recreate') ? 'outgoing' : 'incoming',
        // Lazy computation of mapping to prevent us from serializing outgoing
        // atomic operations
        get mapping() {
            if (!mapping) {
                const headJSON = JSON.stringify(head);
                const messageJSON = { ...message.serialize(headJSON), head: headJSON };
                const value = JSON.stringify(messageJSON);
                mapping = {
                    key: createCID(value, multicodes.SHELTER_CONTRACT_DATA),
                    value
                };
            }
            return mapping;
        },
        head,
        signedMessageData: message
    };
}
// Operations that affect valid keys
const keyOps = [
    SPMessage.OP_CONTRACT,
    SPMessage.OP_KEY_ADD,
    SPMessage.OP_KEY_DEL,
    SPMessage.OP_KEY_UPDATE
];
