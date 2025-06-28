"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleFetchResult = exports.logEvtError = exports.collectEventStream = exports.checkCanBeGarbageCollected = exports.reactiveClearObject = exports.clearObject = exports.getContractIDfromKeyId = exports.recreateEvent = exports.subscribeToForeignKeyContracts = exports.keyAdditionProcessor = exports.validateKeyUpdatePermissions = exports.validateKeyDelPermissions = exports.validateKeyAddPermissions = exports.validateKeyPermissions = exports.findSuitablePublicKeyIds = exports.findContractIDByForeignKeyId = exports.findSuitableSecretKeyId = exports.findRevokedKeyIdsByName = exports.findForeignKeysByContractID = exports.findKeyIdByName = void 0;
exports.eventsAfter = eventsAfter;
exports.buildShelterAuthorizationHeader = buildShelterAuthorizationHeader;
exports.verifyShelterAuthorizationHeader = verifyShelterAuthorizationHeader;
const crypto_1 = require("@chelonia/crypto");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const SPMessage_js_1 = require("./SPMessage.cjs");
const Secret_js_1 = require("./Secret.cjs");
const constants_js_1 = require("./constants.cjs");
const errors_js_1 = require("./errors.cjs");
const events_js_1 = require("./events.cjs");
const functions_js_1 = require("./functions.cjs");
const signedData_js_1 = require("./signedData.cjs");
const MAX_EVENTS_AFTER = Number.parseInt(process.env.MAX_EVENTS_AFTER || '', 10) || Infinity;
const findKeyIdByName = (state, name) => state._vm?.authorizedKeys && Object.values((state._vm.authorizedKeys)).find((k) => k.name === name && k._notAfterHeight == null)?.id;
exports.findKeyIdByName = findKeyIdByName;
const findForeignKeysByContractID = (state, contractID) => state._vm?.authorizedKeys && ((Object.values((state._vm.authorizedKeys)))).filter((k) => k._notAfterHeight == null && k.foreignKey?.includes(contractID)).map(k => k.id);
exports.findForeignKeysByContractID = findForeignKeysByContractID;
const findRevokedKeyIdsByName = (state, name) => state._vm?.authorizedKeys && ((Object.values((state._vm.authorizedKeys) || {}))).filter((k) => k.name === name && k._notAfterHeight != null).map(k => k.id);
exports.findRevokedKeyIdsByName = findRevokedKeyIdsByName;
const findSuitableSecretKeyId = (state, permissions, purposes, ringLevel, allowedActions) => {
    return state._vm?.authorizedKeys &&
        Object.values((state._vm.authorizedKeys))
            .filter((k) => {
            return k._notAfterHeight == null &&
                (k.ringLevel <= (ringLevel ?? Number.POSITIVE_INFINITY)) &&
                (0, sbp_1.default)('chelonia/haveSecretKey', k.id) &&
                (Array.isArray(permissions)
                    ? permissions.reduce((acc, permission) => acc && (k.permissions === '*' || k.permissions.includes(permission)), true)
                    : permissions === k.permissions) &&
                purposes.reduce((acc, purpose) => acc && k.purpose.includes(purpose), true) &&
                (Array.isArray(allowedActions)
                    ? allowedActions.reduce((acc, action) => acc && (k.allowedActions === '*' || !!k.allowedActions?.includes(action)), true)
                    : allowedActions ? allowedActions === k.allowedActions : true);
        })
            .sort((a, b) => b.ringLevel - a.ringLevel)[0]?.id;
};
exports.findSuitableSecretKeyId = findSuitableSecretKeyId;
const findContractIDByForeignKeyId = (state, keyId) => {
    let fk;
    if (!keyId || !(fk = state?._vm?.authorizedKeys?.[keyId]?.foreignKey))
        return;
    try {
        const fkUrl = new URL(fk);
        return fkUrl.pathname;
    }
    catch { }
};
exports.findContractIDByForeignKeyId = findContractIDByForeignKeyId;
// TODO: Resolve inviteKey being added (doesn't have krs permission)
const findSuitablePublicKeyIds = (state, permissions, purposes, ringLevel) => {
    return state._vm?.authorizedKeys &&
        Object.values((state._vm.authorizedKeys)).filter((k) => (k._notAfterHeight == null) &&
            (k.ringLevel <= (ringLevel ?? Number.POSITIVE_INFINITY)) &&
            (Array.isArray(permissions)
                ? permissions.reduce((acc, permission) => acc && (k.permissions === '*' || k.permissions.includes(permission)), true)
                : permissions === k.permissions) &&
            purposes.reduce((acc, purpose) => acc && k.purpose.includes(purpose), true))
            .sort((a, b) => b.ringLevel - a.ringLevel)
            .map((k) => k.id);
};
exports.findSuitablePublicKeyIds = findSuitablePublicKeyIds;
const validateActionPermissions = (msg, signingKey, state, opT, opV) => {
    const data = (0, signedData_js_1.isSignedData)(opV)
        ? opV.valueOf()
        : opV;
    if (signingKey.allowedActions !== '*' && (!Array.isArray(signingKey.allowedActions) ||
        !signingKey.allowedActions.includes(data.action))) {
        (0, exports.logEvtError)(msg, `Signing key ${signingKey.id} is not allowed for action ${data.action}`);
        return false;
    }
    if ((0, signedData_js_1.isSignedData)(opV)) {
        const s = opV;
        const innerSigningKey = state._vm?.authorizedKeys?.[s.signingKeyId];
        // For outgoing messages, we may be using an inner signing key that isn't
        // available for us to see. In this case, we ignore the missing key.
        // For incoming messages, we must check permissions and a missing
        // key means no permissions.
        if (!innerSigningKey && msg._direction === 'outgoing')
            return true;
        if (!innerSigningKey ||
            !Array.isArray(innerSigningKey.purpose) ||
            !innerSigningKey.purpose.includes('sig') ||
            (innerSigningKey.permissions !== '*' &&
                (!Array.isArray(innerSigningKey.permissions) ||
                    !innerSigningKey.permissions.includes(opT + '#inner')))) {
            (0, exports.logEvtError)(msg, `Signing key ${s.signingKeyId} is missing permissions for operation ${opT}`);
            return false;
        }
        if (innerSigningKey.allowedActions !== '*' && (!Array.isArray(innerSigningKey.allowedActions) ||
            !innerSigningKey.allowedActions.includes(data.action + '#inner'))) {
            (0, exports.logEvtError)(msg, `Signing key ${innerSigningKey.id} is not allowed for action ${data.action}`);
            return false;
        }
    }
    return true;
};
const validateKeyPermissions = (msg, config, state, signingKeyId, opT, opV) => {
    const signingKey = state._vm?.authorizedKeys?.[signingKeyId];
    if (!signingKey ||
        !Array.isArray(signingKey.purpose) ||
        !signingKey.purpose.includes('sig') ||
        (signingKey.permissions !== '*' &&
            (!Array.isArray(signingKey.permissions) ||
                !signingKey.permissions.includes(opT)))) {
        (0, exports.logEvtError)(msg, `Signing key ${signingKeyId} is missing permissions for operation ${opT}`);
        return false;
    }
    if (opT === SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED &&
        !validateActionPermissions(msg, signingKey, state, opT, opV)) {
        return false;
    }
    if (!config.skipActionProcessing &&
        opT === SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED &&
        !validateActionPermissions(msg, signingKey, state, opT, opV.valueOf())) {
        return false;
    }
    return true;
};
exports.validateKeyPermissions = validateKeyPermissions;
const validateKeyAddPermissions = function (contractID, signingKey, state, v, skipPrivateCheck) {
    const signingKeyPermissions = Array.isArray(signingKey.permissions) ? new Set(signingKey.permissions) : signingKey.permissions;
    const signingKeyAllowedActions = Array.isArray(signingKey.allowedActions) ? new Set(signingKey.allowedActions) : signingKey.allowedActions;
    if (!state._vm?.authorizedKeys?.[signingKey.id])
        throw new Error('Singing key for OP_KEY_ADD or OP_KEY_UPDATE must exist in _vm.authorizedKeys. contractID=' + contractID + ' signingKeyId=' + signingKey.id);
    const localSigningKey = state._vm.authorizedKeys[signingKey.id];
    v.forEach(wk => {
        const data = this.config.unwrapMaybeEncryptedData(wk);
        if (!data)
            return;
        const k = data.data;
        if (!skipPrivateCheck && signingKey._private && !data.encryptionKeyId) {
            throw new Error('Signing key is private but it tried adding a public key');
        }
        if (!Number.isSafeInteger(k.ringLevel) || k.ringLevel < localSigningKey.ringLevel) {
            throw new Error('Signing key has ringLevel ' + localSigningKey.ringLevel + ' but attempted to add or update a key with ringLevel ' + k.ringLevel);
        }
        if (signingKeyPermissions !== '*') {
            if (!Array.isArray(k.permissions) || !k.permissions.reduce((acc, cv) => acc && signingKeyPermissions.has(cv), true)) {
                throw new Error('Unable to add or update a key with more permissions than the signing key. signingKey permissions: ' + String(signingKey?.permissions) + '; key add permissions: ' + String(k.permissions));
            }
        }
        if (signingKeyAllowedActions !== '*' && k.allowedActions) {
            if (!signingKeyAllowedActions || !Array.isArray(k.allowedActions) || !k.allowedActions.reduce((acc, cv) => acc && signingKeyAllowedActions.has(cv), true)) {
                throw new Error('Unable to add or update a key with more allowed actions than the signing key. signingKey allowed actions: ' + String(signingKey?.allowedActions) + '; key add allowed actions: ' + String(k.allowedActions));
            }
        }
    });
};
exports.validateKeyAddPermissions = validateKeyAddPermissions;
const validateKeyDelPermissions = function (contractID, signingKey, state, v) {
    if (!state._vm?.authorizedKeys?.[signingKey.id])
        throw new Error('Singing key for OP_KEY_DEL must exist in _vm.authorizedKeys. contractID=' + contractID + ' signingKeyId=' + signingKey.id);
    const localSigningKey = state._vm.authorizedKeys[signingKey.id];
    v
        .forEach((wid) => {
        const data = this.config.unwrapMaybeEncryptedData(wid);
        if (!data)
            return;
        const id = data.data;
        const k = state._vm.authorizedKeys[id];
        if (!k) {
            throw new Error('Nonexisting key ID ' + id);
        }
        if (signingKey._private) {
            throw new Error('Signing key is private');
        }
        if (!k._private !== !data.encryptionKeyId) {
            throw new Error('_private attribute must be preserved');
        }
        if (!Number.isSafeInteger(k.ringLevel) || k.ringLevel < localSigningKey.ringLevel) {
            throw new Error('Signing key has ringLevel ' + localSigningKey.ringLevel + ' but attempted to remove a key with ringLevel ' + k.ringLevel);
        }
    });
};
exports.validateKeyDelPermissions = validateKeyDelPermissions;
const validateKeyUpdatePermissions = function (contractID, signingKey, state, v) {
    const updatedMap = Object.create(null);
    const keys = v.map((wuk) => {
        const data = this.config.unwrapMaybeEncryptedData(wuk);
        if (!data)
            return undefined;
        const uk = data.data;
        const existingKey = state._vm.authorizedKeys[uk.oldKeyId];
        if (!existingKey) {
            throw new errors_js_1.ChelErrorWarning('Missing old key ID ' + uk.oldKeyId);
        }
        if (!existingKey._private !== !data.encryptionKeyId) {
            throw new Error('_private attribute must be preserved');
        }
        if (uk.name !== existingKey.name) {
            throw new Error('Name cannot be updated');
        }
        if (!uk.id !== !uk.data) {
            throw new Error('Both or none of the id and data attributes must be provided. Old key ID: ' + uk.oldKeyId);
        }
        if (uk.data && existingKey.meta?.private && !(uk.meta?.private)) {
            throw new Error('Missing private key. Old key ID: ' + uk.oldKeyId);
        }
        if (uk.id && uk.id !== uk.oldKeyId) {
            updatedMap[uk.id] = uk.oldKeyId;
        }
        // Discard `_notAfterHeight` and `_notBeforeHeight`, since retaining them
        // can cause issues reprocessing messages.
        // An example is reprocessing old messages in a chatroom using
        // `chelonia/in/processMessage`: cloning `_notAfterHeight` will break key
        // rotations, since the new key will have the same expiration value as the
        // old key (the new key is supposed to have no expiration height).
        const updatedKey = (0, turtledash_1.omit)(existingKey, ['_notAfterHeight', '_notBeforeHeight']);
        // Set the corresponding updated attributes
        if (uk.permissions) {
            updatedKey.permissions = uk.permissions;
        }
        if (uk.allowedActions) {
            updatedKey.allowedActions = uk.allowedActions;
        }
        if (uk.purpose) {
            updatedKey.purpose = uk.purpose;
        }
        if (uk.meta) {
            updatedKey.meta = uk.meta;
        }
        if (uk.id) {
            updatedKey.id = uk.id;
        }
        if (uk.data) {
            updatedKey.data = uk.data;
        }
        return updatedKey;
        // eslint-disable-next-line no-use-before-define
    }).filter(Boolean);
    exports.validateKeyAddPermissions.call(this, contractID, signingKey, state, keys, true);
    return [keys, updatedMap];
};
exports.validateKeyUpdatePermissions = validateKeyUpdatePermissions;
const keyAdditionProcessor = function (_msg, hash, keys, state, contractID, _signingKey, internalSideEffectStack) {
    const decryptedKeys = [];
    const keysToPersist = [];
    const storeSecretKey = (key, decryptedKey) => {
        const decryptedDeserializedKey = (0, crypto_1.deserializeKey)(decryptedKey);
        const transient = !!key.meta?.private?.transient;
        (0, sbp_1.default)('chelonia/storeSecretKeys', new Secret_js_1.Secret([{
                key: decryptedDeserializedKey,
                // We always set this to true because this could be done from
                // an outgoing message
                transient: true
            }]));
        if (!transient) {
            keysToPersist.push({ key: decryptedDeserializedKey, transient });
        }
    };
    for (const wkey of keys) {
        const data = this.config.unwrapMaybeEncryptedData(wkey);
        if (!data)
            continue;
        const key = data.data;
        let decryptedKey;
        // Does the key have key.meta?.private? If so, attempt to decrypt it
        if (key.meta?.private && key.meta.private.content) {
            if (key.id &&
                key.meta.private.content &&
                !(0, sbp_1.default)('chelonia/haveSecretKey', key.id, !key.meta.private.transient)) {
                const decryptedKeyResult = this.config.unwrapMaybeEncryptedData(key.meta.private.content);
                // Ignore data that couldn't be decrypted
                if (decryptedKeyResult) {
                    // Data aren't encrypted
                    if (decryptedKeyResult.encryptionKeyId == null) {
                        throw new Error('Expected encrypted data but got unencrypted data for key with ID: ' + key.id);
                    }
                    decryptedKey = decryptedKeyResult.data;
                    decryptedKeys.push([key.id, decryptedKey]);
                    storeSecretKey(key, decryptedKey);
                }
            }
        }
        // Is this a #sak
        if (key.name === '#sak') {
            if (data.encryptionKeyId) {
                throw new Error('#sak may not be encrypted');
            }
            if (key.permissions && (!Array.isArray(key.permissions) || key.permissions.length !== 0)) {
                throw new Error('#sak may not have permissions');
            }
            if (!Array.isArray(key.purpose) || key.purpose.length !== 1 || key.purpose[0] !== 'sak') {
                throw new Error("#sak must have exactly one purpose: 'sak'");
            }
            if (key.ringLevel !== 0) {
                throw new Error('#sak must have ringLevel 0');
            }
        }
        // Is this a an invite key? If so, run logic for invite keys and invitation
        // accounting
        if (key.name.startsWith('#inviteKey-')) {
            if (!state._vm.invites)
                state._vm.invites = Object.create(null);
            const inviteSecret = decryptedKey || ((0, turtledash_1.has)(this.transientSecretKeys, key.id)
                ? (0, crypto_1.serializeKey)(this.transientSecretKeys[key.id], true)
                : undefined);
            state._vm.invites[key.id] = {
                status: constants_js_1.INVITE_STATUS.VALID,
                initialQuantity: key.meta.quantity,
                quantity: key.meta.quantity,
                expires: key.meta.expires,
                inviteSecret: inviteSecret,
                responses: []
            };
        }
        // Is this KEY operation the result of requesting keys for another contract?
        if (key.meta?.keyRequest?.contractID && (0, exports.findSuitableSecretKeyId)(state, [SPMessage_js_1.SPMessage.OP_KEY_ADD], ['sig'])) {
            const data = this.config.unwrapMaybeEncryptedData(key.meta.keyRequest.contractID);
            // Are we subscribed to this contract?
            // If we are not subscribed to the contract, we don't set pendingKeyRequests because we don't need that contract's state
            // Setting pendingKeyRequests in these cases could result in issues
            // when a corresponding OP_KEY_SHARE is received, which could trigger subscribing to this previously unsubscribed to contract
            if (data && internalSideEffectStack) {
                const keyRequestContractID = data.data;
                const reference = this.config.unwrapMaybeEncryptedData(key.meta.keyRequest.reference);
                // Since now we'll make changes to keyRequestContractID, we need to
                // do this while no other operations are running for that
                // contract
                internalSideEffectStack.push(() => {
                    (0, sbp_1.default)('chelonia/private/queueEvent', keyRequestContractID, () => {
                        const rootState = (0, sbp_1.default)(this.config.stateSelector);
                        const originatingContractState = rootState[contractID];
                        if ((0, sbp_1.default)('chelonia/contract/hasKeyShareBeenRespondedBy', originatingContractState, keyRequestContractID, reference)) {
                            // In the meantime, our key request has been responded, so we
                            // don't need to set pendingKeyRequests.
                            return;
                        }
                        if (!(0, turtledash_1.has)(rootState, keyRequestContractID))
                            this.config.reactiveSet(rootState, keyRequestContractID, Object.create(null));
                        const targetState = rootState[keyRequestContractID];
                        if (!targetState._volatile) {
                            this.config.reactiveSet(targetState, '_volatile', Object.create(null));
                        }
                        if (!targetState._volatile.pendingKeyRequests) {
                            this.config.reactiveSet(rootState[keyRequestContractID]._volatile, 'pendingKeyRequests', []);
                        }
                        if (targetState._volatile.pendingKeyRequests.some((pkr) => {
                            return pkr && pkr.contractID === contractID && pkr.hash === hash;
                        })) {
                            // This pending key request has already been registered.
                            // Nothing left to do.
                            return;
                        }
                        // Mark the contract for which keys were requested as pending keys
                        // The hash (of the current message) is added to this dictionary
                        // for cross-referencing puposes.
                        targetState._volatile.pendingKeyRequests.push({ contractID, name: key.name, hash, reference: reference?.data });
                        this.setPostSyncOp(contractID, 'pending-keys-for-' + keyRequestContractID, ['okTurtles.events/emit', events_js_1.CONTRACT_IS_PENDING_KEY_REQUESTS, { contractID: keyRequestContractID }]);
                    }).catch((e) => {
                        // Using console.error instead of logEvtError because this
                        // is a side-effect and not relevant for outgoing messages
                        console.error('Error while setting or updating pendingKeyRequests', { contractID, keyRequestContractID, reference }, e);
                    });
                });
            }
        }
    }
    // Any persistent keys are stored as a side-effect
    if (keysToPersist.length) {
        internalSideEffectStack?.push(() => {
            (0, sbp_1.default)('chelonia/storeSecretKeys', new Secret_js_1.Secret(keysToPersist));
        });
    }
    internalSideEffectStack?.push(() => exports.subscribeToForeignKeyContracts.call(this, contractID, state));
};
exports.keyAdditionProcessor = keyAdditionProcessor;
const subscribeToForeignKeyContracts = function (contractID, state) {
    try {
        Object.values(state._vm.authorizedKeys).filter((key) => !!((key)).foreignKey && (0, exports.findKeyIdByName)(state, ((key)).name) != null).forEach((key) => {
            const foreignKey = String(key.foreignKey);
            const fkUrl = new URL(foreignKey);
            const foreignContract = fkUrl.pathname;
            const foreignKeyName = fkUrl.searchParams.get('keyName');
            if (!foreignContract || !foreignKeyName) {
                console.warn('Invalid foreign key: missing contract or key name', { contractID, keyId: key.id });
                return;
            }
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            const signingKey = (0, exports.findSuitableSecretKeyId)(state, [SPMessage_js_1.SPMessage.OP_KEY_DEL], ['sig'], key.ringLevel);
            const canMirrorOperations = !!signingKey;
            // If we cannot mirror operations, then there is nothing left to do
            if (!canMirrorOperations)
                return;
            // If the key is already being watched, do nothing
            if (Array.isArray(rootState?.[foreignContract]?._volatile?.watch)) {
                if (rootState[foreignContract]._volatile.watch.find((v) => v[0] === key.name && v[1] === contractID))
                    return;
            }
            if (!(0, turtledash_1.has)(state._vm, 'pendingWatch'))
                this.config.reactiveSet(state._vm, 'pendingWatch', Object.create(null));
            if (!(0, turtledash_1.has)(state._vm.pendingWatch, foreignContract))
                this.config.reactiveSet(state._vm.pendingWatch, foreignContract, []);
            if (!state._vm.pendingWatch[foreignContract].find(([n]) => n === foreignKeyName)) {
                state._vm.pendingWatch[foreignContract].push([foreignKeyName, key.id]);
            }
            this.setPostSyncOp(contractID, `watchForeignKeys-${contractID}`, ['chelonia/private/watchForeignKeys', contractID]);
        });
    }
    catch (e) {
        console.warn('Error at subscribeToForeignKeyContracts: ' + (e.message || e));
    }
};
exports.subscribeToForeignKeyContracts = subscribeToForeignKeyContracts;
// Messages might be sent before receiving already posted messages, which will
// result in a conflict
// When resending a message, race conditions might also occur (for example, if
// key rotation is required and there are many clients simultaneously online, it
// may be performed by all connected clients at once).
// The following function handles re-signing of messages when a conflict
// occurs (required because the message's previousHEAD will change) as well as
// duplicate operations. For operations involving keys, the payload will be
// rewritten to eliminate no-longer-relevant keys. In most cases, this would
// result in an empty payload, in which case the message is omitted entirely.
const recreateEvent = (entry, state, contractsState) => {
    const { HEAD: previousHEAD, height: previousHeight, previousKeyOp } = contractsState || {};
    if (!previousHEAD) {
        throw new Error('recreateEvent: Giving up because the contract has been removed');
    }
    const head = entry.head();
    const [opT, rawOpV] = entry.rawOp();
    const recreateOperation = (opT, rawOpV) => {
        const opV = rawOpV.valueOf();
        const recreateOperationInternal = (opT, opV) => {
            let newOpV;
            if (opT === SPMessage_js_1.SPMessage.OP_KEY_ADD) {
                if (!Array.isArray(opV))
                    throw new Error('Invalid message format');
                newOpV = opV.filter((k) => {
                    const kId = k.valueOf().id;
                    return !(0, turtledash_1.has)(state._vm.authorizedKeys, kId) || state._vm.authorizedKeys[kId]._notAfterHeight != null;
                });
                // Has this key already been added? (i.e., present in authorizedKeys)
                if (newOpV.length === 0) {
                    console.info('Omitting empty OP_KEY_ADD', { head });
                }
                else if (newOpV.length === opV.length) {
                    return opV;
                }
            }
            else if (opT === SPMessage_js_1.SPMessage.OP_KEY_DEL) {
                if (!Array.isArray(opV))
                    throw new Error('Invalid message format');
                // Has this key already been removed? (i.e., no longer in authorizedKeys)
                newOpV = opV.filter((keyId) => {
                    const kId = Object(keyId).valueOf();
                    return (0, turtledash_1.has)(state._vm.authorizedKeys, kId) && state._vm.authorizedKeys[kId]._notAfterHeight == null;
                });
                if (newOpV.length === 0) {
                    console.info('Omitting empty OP_KEY_DEL', { head });
                }
                else if (newOpV.length === opV.length) {
                    return opV;
                }
            }
            else if (opT === SPMessage_js_1.SPMessage.OP_KEY_UPDATE) {
                if (!Array.isArray(opV))
                    throw new Error('Invalid message format');
                // Has this key already been replaced? (i.e., no longer in authorizedKeys)
                newOpV = opV.filter((k) => {
                    const oKId = k.valueOf().oldKeyId;
                    const nKId = k.valueOf().id;
                    return nKId == null || ((0, turtledash_1.has)(state._vm.authorizedKeys, oKId) && state._vm.authorizedKeys[oKId]._notAfterHeight == null);
                });
                if (newOpV.length === 0) {
                    console.info('Omitting empty OP_KEY_UPDATE', { head });
                }
                else if (newOpV.length === opV.length) {
                    return opV;
                }
            }
            else if (opT === SPMessage_js_1.SPMessage.OP_ATOMIC) {
                if (!Array.isArray(opV))
                    throw new Error('Invalid message format');
                newOpV = opV.map(([t, v]) => [t, recreateOperationInternal(t, v)]).filter(([, v]) => !!v);
                if (newOpV.length === 0) {
                    console.info('Omitting empty OP_ATOMIC', { head });
                }
                else if (newOpV.length === opV.length && newOpV.reduce((acc, cv, i) => acc && cv === opV[i], true)) {
                    return opV;
                }
                else {
                    return newOpV;
                }
            }
            else {
                return opV;
            }
        };
        const newOpV = recreateOperationInternal(opT, opV);
        if (newOpV === opV) {
            return rawOpV;
        }
        else if (newOpV === undefined) {
            return;
        }
        if (typeof rawOpV.recreate !== 'function') {
            throw new Error('Unable to recreate operation');
        }
        return rawOpV.recreate(newOpV);
    };
    const newRawOpV = recreateOperation(opT, rawOpV);
    if (!newRawOpV)
        return;
    const newOp = [opT, newRawOpV];
    entry = SPMessage_js_1.SPMessage.cloneWith(head, newOp, { previousKeyOp, previousHEAD, height: previousHeight + 1 });
    return entry;
};
exports.recreateEvent = recreateEvent;
const getContractIDfromKeyId = (contractID, signingKeyId, state) => {
    if (!signingKeyId)
        return;
    return signingKeyId && state._vm?.authorizedKeys?.[signingKeyId]?.foreignKey
        ? new URL(state._vm.authorizedKeys[signingKeyId].foreignKey).pathname
        : contractID;
};
exports.getContractIDfromKeyId = getContractIDfromKeyId;
function eventsAfter(contractID, sinceHeight, limit, sinceHash, { stream } = { stream: true }) {
    if (!contractID) {
        // Avoid making a network roundtrip to tell us what we already know
        throw new Error('Missing contract ID');
    }
    let lastUrl;
    const fetchEventsStreamReader = async () => {
        requestLimit = Math.min(limit ?? MAX_EVENTS_AFTER, remainingEvents);
        lastUrl = `${this.config.connectionURL}/eventsAfter/${contractID}/${sinceHeight}${Number.isInteger(requestLimit) ? `/${requestLimit}` : ''}`;
        const eventsResponse = await this.config.fetch(lastUrl, { signal });
        if (!eventsResponse.ok) {
            const msg = `${eventsResponse.status}: ${eventsResponse.statusText}`;
            if (eventsResponse.status === 404 || eventsResponse.status === 410)
                throw new errors_js_1.ChelErrorResourceGone(msg, { cause: eventsResponse.status });
            throw new errors_js_1.ChelErrorUnexpectedHttpResponseCode(msg, { cause: eventsResponse.status });
        }
        if (!eventsResponse.body)
            throw new Error('Missing body');
        latestHeight = parseInt(eventsResponse.headers.get('shelter-headinfo-height'), 10);
        if (!Number.isSafeInteger(latestHeight))
            throw new Error('Invalid latest height');
        requestCount++;
        return eventsResponse.body.getReader();
    };
    if (!Number.isSafeInteger(sinceHeight) || sinceHeight < 0) {
        throw new TypeError('Invalid since height value. Expected positive integer.');
    }
    const signal = this.abortController.signal;
    let requestCount = 0;
    let remainingEvents = limit ?? Number.POSITIVE_INFINITY;
    let eventsStreamReader;
    let latestHeight;
    let state = 'fetch';
    let requestLimit;
    let count;
    let buffer = '';
    let currentEvent;
    // return ReadableStream with a custom pull function to handle streamed data
    const s = new ReadableStream({
        // The pull function is called whenever the internal buffer of the stream
        // becomes empty and needs more data.
        async pull(controller) {
            try {
                for (;;) {
                    // Handle different states of the stream reading process.
                    switch (state) {
                        // When in 'fetch' state, initiate a new fetch request to obtain a
                        // stream reader for events.
                        case 'fetch': {
                            eventsStreamReader = await fetchEventsStreamReader();
                            // Transition to reading the new response and reset the processed
                            // events counter
                            state = 'read-new-response';
                            count = 0;
                            break;
                        }
                        case 'read-eos': // End of stream case
                        case 'read-new-response': // Just started reading a new response
                        case 'read': { // Reading from the response stream
                            const { done, value } = await eventsStreamReader.read();
                            // If done, determine if the stream should close or fetch more
                            // data by making a new request
                            if (done) {
                                // No more events to process or reached the latest event
                                // Using `>=` instead of `===` to avoid an infinite loop in the
                                // event of data loss on the server.
                                if (remainingEvents === 0 || sinceHeight >= latestHeight) {
                                    controller.close();
                                    return;
                                }
                                else if (state === 'read-new-response' || buffer) {
                                    // If done prematurely, throw an error
                                    throw new Error('Invalid response: done too early');
                                }
                                else {
                                    // If there are still events to fetch, switch state to fetch
                                    state = 'fetch';
                                    break;
                                }
                            }
                            if (!value) {
                                // If there's no value (e.g., empty response), throw an error
                                throw new Error('Invalid response: missing body');
                            }
                            // Concatenate new data to the buffer, trimming any
                            // leading/trailing whitespace (the response is a JSON array of
                            // base64-encoded data, meaning that whitespace is not significant)
                            buffer = buffer + Buffer.from(value).toString().trim();
                            // If there was only whitespace, try reading again
                            if (!buffer)
                                break;
                            if (state === 'read-new-response') {
                                // Response is in JSON format, so we look for the start of an
                                // array (`[`)
                                if (buffer[0] !== '[') {
                                    throw new Error('Invalid response: no array start delimiter');
                                }
                                // Trim the array start delimiter from the buffer
                                buffer = buffer.slice(1);
                            }
                            else if (state === 'read-eos') {
                                // If in 'read-eos' state and still reading data, it's an error
                                // because the response isn't valid JSON (there should be
                                // nothing other than whitespace after `]`)
                                throw new Error('Invalid data at the end of response');
                            }
                            // If not handling new response or end-of-stream, switch to
                            // processing events
                            state = 'events';
                            break;
                        }
                        case 'events': {
                            // Process events by looking for a comma or closing bracket that
                            // indicates the end of an event
                            const nextIdx = buffer.search(/(?<=\s*)[,\]]/);
                            // If the end of the event isn't found, go back to reading more
                            // data
                            if (nextIdx < 0) {
                                state = 'read';
                                break;
                            }
                            let enqueued = false;
                            try {
                                // Extract the current event's value and trim whitespace
                                const eventValue = buffer.slice(0, nextIdx).trim();
                                if (eventValue) {
                                    // Check if the event limit is reached; if so, throw an error
                                    if (count === requestLimit) {
                                        throw new Error('Received too many events');
                                    }
                                    currentEvent = JSON.parse((0, functions_js_1.b64ToStr)(JSON.parse(eventValue))).message;
                                    if (count === 0) {
                                        const hash = SPMessage_js_1.SPMessage.deserializeHEAD(currentEvent).hash;
                                        const height = SPMessage_js_1.SPMessage.deserializeHEAD(currentEvent).head.height;
                                        if (height !== sinceHeight || (sinceHash && sinceHash !== hash)) {
                                            if (height === sinceHeight && sinceHash && sinceHash !== hash) {
                                                throw new errors_js_1.ChelErrorForkedChain(`Forked chain: hash(${hash}) !== since(${sinceHash})`);
                                            }
                                            else {
                                                throw new Error(`Unexpected data: hash(${hash}) !== since(${sinceHash || ''}) or height(${height}) !== since(${sinceHeight})`);
                                            }
                                        }
                                    }
                                    // If this is the first event in a second or later request,
                                    // drop the event because it's already been included in
                                    // a previous response
                                    if (count++ !== 0 || requestCount !== 0) {
                                        controller.enqueue(currentEvent);
                                        enqueued = true;
                                        remainingEvents--;
                                    }
                                }
                                // If the stream is finished (indicated by a closing bracket),
                                // update `since` (to make the next request if needed) and
                                // switch to 'read-eos'.
                                if (buffer[nextIdx] === ']') {
                                    if (currentEvent) {
                                        const deserialized = SPMessage_js_1.SPMessage.deserializeHEAD(currentEvent);
                                        sinceHeight = deserialized.head.height;
                                        sinceHash = deserialized.hash;
                                        state = 'read-eos';
                                    }
                                    else {
                                        // If the response came empty, assume there are no more events
                                        // after. Mostly this prevents infinite loops if a server is
                                        // claiming there are more events than it's willing to return
                                        // data for.
                                        state = 'eod';
                                    }
                                    // This should be an empty string now
                                    buffer = buffer.slice(nextIdx + 1).trim();
                                }
                                else if (currentEvent) {
                                    // Otherwise, move the buffer pointer to the next event
                                    buffer = buffer.slice(nextIdx + 1).trimStart();
                                }
                                else {
                                    // If the end delimiter (`]`) is missing, throw an error
                                    throw new Error('Missing end delimiter');
                                }
                                // If an event was successfully enqueued, exit the loop to wait
                                // for the next pull request
                                if (enqueued) {
                                    return;
                                }
                            }
                            catch (e) {
                                console.error('[chelonia] Error during event parsing', e);
                                throw e;
                            }
                            break;
                        }
                        case 'eod': {
                            if (remainingEvents === 0 || sinceHeight >= latestHeight) {
                                controller.close();
                            }
                            else {
                                throw new Error('Unexpected end of data');
                            }
                            return;
                        }
                    }
                }
            }
            catch (e) {
                console.error('[eventsAfter] Error', { lastUrl }, e);
                eventsStreamReader?.cancel('Error during pull').catch(e2 => {
                    console.error('Error canceling underlying event stream reader on error', e, e2);
                });
                throw e;
            }
        }
    });
    if (stream)
        return s;
    // Workaround for <https://bugs.webkit.org/show_bug.cgi?id=215485>
    return (0, exports.collectEventStream)(s);
}
function buildShelterAuthorizationHeader(contractID, state) {
    if (!state)
        state = (0, sbp_1.default)(this.config.stateSelector)[contractID];
    const SAKid = (0, exports.findKeyIdByName)(state, '#sak');
    if (!SAKid) {
        throw new Error(`Missing #sak in ${contractID}`);
    }
    const SAK = this.transientSecretKeys[SAKid];
    if (!SAK) {
        throw new Error(`Missing secret #sak (${SAKid}) in ${contractID}`);
    }
    const deserializedSAK = typeof SAK === 'string' ? (0, crypto_1.deserializeKey)(SAK) : SAK;
    const nonceBytes = new Uint8Array(15);
    globalThis.crypto.getRandomValues(nonceBytes);
    // <contractID> <UNIX ms time>.<nonce>
    const data = `${contractID} ${(0, sbp_1.default)('chelonia/time')}.${Buffer.from(nonceBytes).toString('base64')}`;
    // shelter <contractID> <UNIX time>.<nonce>.<signature>
    return `shelter ${data}.${(0, crypto_1.sign)(deserializedSAK, data)}`;
}
function verifyShelterAuthorizationHeader(authorization, rootState) {
    const regex = /^shelter (([a-zA-Z0-9]+) ([0-9]+)\.([a-zA-Z0-9+/=]{20}))\.([a-zA-Z0-9+/=]+)$/i;
    if (authorization.length > 1024) {
        throw new Error('Authorization header too long');
    }
    const matches = authorization.match(regex);
    if (!matches) {
        throw new Error('Unable to parse shelter authorization header');
    }
    // TODO: Remember nonces and reject already used ones
    const [, data, contractID, timestamp, , signature] = matches;
    if (Math.abs(parseInt(timestamp) - Date.now()) > 60e3) {
        throw new Error('Invalid signature time range');
    }
    if (!rootState)
        rootState = (0, sbp_1.default)('chelonia/rootState');
    if (!(0, turtledash_1.has)(rootState, contractID)) {
        throw new Error(`Contract ${contractID} from shelter authorization header not found`);
    }
    const SAKid = (0, exports.findKeyIdByName)(rootState[contractID], '#sak');
    if (!SAKid) {
        throw new Error(`Missing #sak in ${contractID}`);
    }
    const SAK = rootState[contractID]._vm.authorizedKeys[SAKid].data;
    if (!SAK) {
        throw new Error(`Missing secret #sak (${SAKid}) in ${contractID}`);
    }
    const deserializedSAK = (0, crypto_1.deserializeKey)(SAK);
    (0, crypto_1.verifySignature)(deserializedSAK, data, signature);
    return contractID;
}
const clearObject = (o) => {
    Object.keys(o).forEach((k) => delete o[k]);
};
exports.clearObject = clearObject;
const reactiveClearObject = (o, fn) => {
    Object.keys(o).forEach((k) => fn(o, k));
};
exports.reactiveClearObject = reactiveClearObject;
const checkCanBeGarbageCollected = function (id) {
    const rootState = (0, sbp_1.default)(this.config.stateSelector);
    return (
    // Check persistent references
    (!(0, turtledash_1.has)(rootState.contracts, id) || !rootState.contracts[id] || !(0, turtledash_1.has)(rootState.contracts[id], 'references')) &&
        // Check ephemeral references
        !(0, turtledash_1.has)(this.ephemeralReferenceCount, id)) &&
        // Check foreign keys (i.e., that no keys from this contract are being watched)
        (!(0, turtledash_1.has)(rootState, id) || !(0, turtledash_1.has)(rootState[id], '_volatile') || !(0, turtledash_1.has)(rootState[id]._volatile, 'watch') || rootState[id]._volatile.watch.length === 0 || rootState[id]._volatile.watch.filter(([, cID]) => this.subscriptionSet.has(cID)).length === 0);
};
exports.checkCanBeGarbageCollected = checkCanBeGarbageCollected;
const collectEventStream = async (s) => {
    const reader = s.getReader();
    const r = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        r.push(value);
    }
    return r;
};
exports.collectEventStream = collectEventStream;
// Used inside processing functions for displaying errors at the 'warn' level
// for outgoing messages to increase the signal-to-noise error. See issue #2773.
const logEvtError = (msg, ...args) => {
    if (msg._direction === 'outgoing') {
        console.warn(...args);
    }
    else {
        console.error(...args);
    }
};
exports.logEvtError = logEvtError;
const handleFetchResult = (type) => {
    return function (r) {
        if (!r.ok) {
            const msg = `${r.status}: ${r.statusText}`;
            // 410 is sometimes special (for example, it can mean that a contract or
            // a file been deleted)
            if (r.status === 404 || r.status === 410)
                throw new errors_js_1.ChelErrorResourceGone(msg, { cause: r.status });
            throw new errors_js_1.ChelErrorUnexpectedHttpResponseCode(msg, { cause: r.status });
        }
        return r[type]();
    };
};
exports.handleFetchResult = handleFetchResult;
