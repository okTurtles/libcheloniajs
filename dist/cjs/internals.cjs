"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("@chelonia/crypto");
const sbp_1 = __importStar(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const SPMessage_js_1 = require("./SPMessage.cjs");
const Secret_js_1 = require("./Secret.cjs");
const constants_js_1 = require("./constants.cjs");
require("./db.cjs");
const encryptedData_js_1 = require("./encryptedData.cjs");
const errors_js_1 = require("./errors.cjs");
const events_js_1 = require("./events.cjs");
const functions_js_1 = require("./functions.cjs");
const signedData_js_1 = require("./signedData.cjs");
const utils_js_1 = require("./utils.cjs");
// Used for temporarily storing the missing decryption key IDs in a given
// message
const missingDecryptionKeyIdsMap = new WeakMap();
const getMsgMeta = function (message, contractID, state, index) {
    const signingKeyId = message.signingKeyId();
    let innerSigningKeyId = null;
    const config = this.config;
    const result = {
        signingKeyId,
        get signingContractID() {
            return (0, utils_js_1.getContractIDfromKeyId)(contractID, signingKeyId, state);
        },
        get innerSigningKeyId() {
            if (innerSigningKeyId === null) {
                const value = message.message();
                const data = config.unwrapMaybeEncryptedData(value);
                if (data?.data && (0, signedData_js_1.isSignedData)(data.data)) {
                    innerSigningKeyId = data.data.signingKeyId;
                }
                else {
                    innerSigningKeyId = undefined;
                }
                return innerSigningKeyId;
            }
        },
        get innerSigningContractID() {
            return (0, utils_js_1.getContractIDfromKeyId)(contractID, result.innerSigningKeyId, state);
        },
        index
    };
    return result;
};
const keysToMap = function (keys_, height, signingKeyId, authorizedKeys) {
    // Using cloneDeep to ensure that the returned object is serializable
    // Keys in a SPMessage may not be serializable (i.e., supported by the
    // structured clone algorithm) when they contain encryptedIncomingData
    const keys = keys_
        .map((key) => {
        const data = this.config.unwrapMaybeEncryptedData(key);
        if (!data)
            return undefined;
        if (data.encryptionKeyId) {
            data.data._private = data.encryptionKeyId;
        }
        return data.data;
    })
        // eslint-disable-next-line no-use-before-define
        .filter(Boolean);
    const keysCopy = (0, turtledash_1.cloneDeep)(keys);
    return Object.fromEntries(keysCopy.map((key) => {
        key._notBeforeHeight = height;
        key._addedByKeyId = signingKeyId;
        if (authorizedKeys?.[key.id]) {
            if (authorizedKeys[key.id]._notAfterHeight == null) {
                throw new errors_js_1.ChelErrorKeyAlreadyExists(`Cannot set existing unrevoked key: ${key.id}`);
            }
            // If the key was get previously, preserve its _notBeforeHeight
            // NOTE: (SECURITY) This may allow keys for periods for which it wasn't
            // supposed to be active. This is a trade-off for simplicity, instead of
            // considering discrete periods, which is the correct solution
            // Discrete ranges *MUST* be implemented because they impact permissions
            key._notBeforeHeight = Math.min(height, authorizedKeys[key.id]._notBeforeHeight ?? 0);
        }
        else {
            key._notBeforeHeight = height;
        }
        delete key._notAfterHeight;
        return [key.id, key];
    }));
};
const keyRotationHelper = (contractID, state, config, updatedKeysMap, requiredPermissions, outputSelector, outputMapper, internalSideEffectStack) => {
    if (!internalSideEffectStack || !Array.isArray(state._volatile?.watch))
        return;
    const rootState = (0, sbp_1.default)(config.stateSelector);
    const watchMap = Object.create(null);
    state._volatile.watch.forEach(([name, cID]) => {
        if (!updatedKeysMap[name] || watchMap[cID] === null) {
            return;
        }
        if (!watchMap[cID]) {
            if (!rootState.contracts[cID]?.type ||
                !(0, utils_js_1.findSuitableSecretKeyId)(rootState[cID], [SPMessage_js_1.SPMessage.OP_KEY_UPDATE], ['sig'])) {
                watchMap[cID] = null;
                return;
            }
            watchMap[cID] = [];
        }
        watchMap[cID].push(name);
    });
    Object.entries(watchMap).forEach(([cID, names]) => {
        if (!Array.isArray(names) || !names.length)
            return;
        const [keyNamesToUpdate, signingKeyId] = names
            .map((name) => {
            const foreignContractKey = rootState[cID]?._vm?.authorizedKeys?.[updatedKeysMap[name].oldKeyId];
            if (!foreignContractKey)
                return undefined;
            const signingKeyId = (0, utils_js_1.findSuitableSecretKeyId)(rootState[cID], requiredPermissions, ['sig'], foreignContractKey.ringLevel);
            if (signingKeyId) {
                return [
                    [name, foreignContractKey.name],
                    signingKeyId,
                    rootState[cID]._vm.authorizedKeys[signingKeyId].ringLevel
                ];
            }
            return undefined;
        })
            .filter(Boolean)
            .reduce((acc, [name, signingKeyId, ringLevel]) => {
            acc[0].push(name);
            return ringLevel < acc[2] ? [acc[0], signingKeyId, ringLevel] : acc;
        }, [[], undefined, Number.POSITIVE_INFINITY]);
        if (!signingKeyId)
            return;
        // Send output based on keyNamesToUpdate, signingKeyId
        const contractName = rootState.contracts[cID]?.type;
        internalSideEffectStack?.push(() => {
            // We can't await because it'll block on a different contract, which
            // is possibly waiting on this current contract.
            (0, sbp_1.default)(outputSelector, {
                contractID: cID,
                contractName,
                data: keyNamesToUpdate.map(outputMapper).map((v) => {
                    return v;
                }),
                signingKeyId
            }).catch((e) => {
                console.warn(`Error mirroring key operation (${outputSelector}) from ${contractID} to ${cID}: ${e?.message || e}`);
            });
        });
    });
};
// export const FERAL_FUNCTION = Function
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    //     DO NOT CALL ANY OF THESE YOURSELF!
    'chelonia/private/state': function () {
        return this.state;
    },
    'chelonia/private/invoke': function (instance, invocation) {
        // If this._instance !== instance (i.e., chelonia/reset was called)
        if (this._instance !== instance) {
            console.info("['chelonia/private/invoke] Not proceeding with invocation as Chelonia was restarted", { invocation });
            return;
        }
        if (Array.isArray(invocation)) {
            return (0, sbp_1.default)(...invocation);
        }
        else if (typeof invocation === 'function') {
            return invocation();
        }
        else {
            throw new TypeError(`[chelonia/private/invoke] Expected invocation to be an array or a function. Saw ${typeof invocation} instead.`);
        }
    },
    'chelonia/private/queueEvent': function (queueName, invocation) {
        return (0, sbp_1.default)('okTurtles.eventQueue/queueEvent', queueName, [
            'chelonia/private/invoke',
            this._instance,
            invocation
        ]);
    },
    'chelonia/private/verifyManifestSignature': function (contractName, manifestHash, manifest) {
        // We check that the manifest contains a 'signature' field with the correct
        // shape
        if (!(0, turtledash_1.has)(manifest, 'signature') ||
            typeof manifest.signature.keyId !== 'string' ||
            typeof manifest.signature.value !== 'string') {
            throw new Error(`Invalid or missing signature field for manifest ${manifestHash} (named ${contractName})`);
        }
        // Now, start the signature verification process
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (!(0, turtledash_1.has)(rootState, 'contractSigningKeys')) {
            this.config.reactiveSet(rootState, 'contractSigningKeys', Object.create(null));
        }
        // Because `contractName` comes from potentially unsafe sources (for
        // instance, from `processMessage`), the key isn't used directly because
        // it could overlap with current or future 'special' key names in JavaScript,
        // such as `prototype`, `__proto__`, etc. We also can't guarantee that the
        // `contractSigningKeys` always has a null prototype, and, because of the
        // way we manage state, neither can we use `Map`. So, we use prefix for the
        // lookup key that's unlikely to ever be part of a special JS name.
        const contractNameLookupKey = `name:${contractName}`;
        // If the contract name has been seen before, validate its signature now
        let signatureValidated = false;
        if (process.env.UNSAFE_TRUST_ALL_MANIFEST_SIGNING_KEYS !== 'true' &&
            (0, turtledash_1.has)(rootState.contractSigningKeys, contractNameLookupKey)) {
            console.info(`[chelonia] verifying signature for ${manifestHash} with an existing key`);
            if (!(0, turtledash_1.has)(rootState.contractSigningKeys[contractNameLookupKey], manifest.signature.keyId)) {
                console.error(`The manifest with ${manifestHash} (named ${contractName}) claims to be signed with a key with ID ${manifest.signature.keyId}, which is not trusted. The trusted key IDs for this name are:`, Object.keys(rootState.contractSigningKeys[contractNameLookupKey]));
                throw new Error(`Invalid or missing signature in manifest ${manifestHash} (named ${contractName}). It claims to be signed with a key with ID ${manifest.signature.keyId}, which has not been authorized for this contract before.`);
            }
            const signingKey = rootState.contractSigningKeys[contractNameLookupKey][manifest.signature.keyId];
            (0, crypto_1.verifySignature)(signingKey, manifest.body + manifest.head, manifest.signature.value);
            console.info(`[chelonia] successful signature verification for ${manifestHash} (named ${contractName}) using the already-trusted key ${manifest.signature.keyId}.`);
            signatureValidated = true;
        }
        // Otherwise, when this is a yet-unseen contract, we parse the body to
        // see its allowed signers to trust on first-use (TOFU)
        const body = JSON.parse(manifest.body);
        // If we don't have a list of authorized signatures yet, verify this
        // contract's signature and set the auhorized signing keys
        if (!signatureValidated) {
            console.info(`[chelonia] verifying signature for ${manifestHash} (named ${contractName}) for the first time`);
            if (!(0, turtledash_1.has)(body, 'signingKeys') || !Array.isArray(body.signingKeys)) {
                throw new Error(`Invalid manifest file ${manifestHash} (named ${contractName}). Its body doesn't contain a 'signingKeys' list'`);
            }
            let contractSigningKeys;
            try {
                contractSigningKeys = Object.fromEntries(body.signingKeys.map((serializedKey) => {
                    return [(0, crypto_1.keyId)(serializedKey), serializedKey];
                }));
            }
            catch (e) {
                console.error(`[chelonia] Error parsing the public keys list for ${manifestHash} (named ${contractName})`, e);
                throw e;
            }
            if (!(0, turtledash_1.has)(contractSigningKeys, manifest.signature.keyId)) {
                throw new Error(`Invalid or missing signature in manifest ${manifestHash} (named ${contractName}). It claims to be signed with a key with ID ${manifest.signature.keyId}, which is not listed in its 'signingKeys' field.`);
            }
            (0, crypto_1.verifySignature)(contractSigningKeys[manifest.signature.keyId], manifest.body + manifest.head, manifest.signature.value);
            console.info(`[chelonia] successful signature verification for ${manifestHash} (named ${contractName}) using ${manifest.signature.keyId}. The following key IDs will now be trusted for this contract name`, Object.keys(contractSigningKeys));
            signatureValidated = true;
            rootState.contractSigningKeys[contractNameLookupKey] = contractSigningKeys;
        }
        // If verification was successful, return the parsed body to make the newly-
        // loaded contract available
        return body;
    },
    'chelonia/private/loadManifest': async function (contractName, manifestHash) {
        if (!contractName || typeof contractName !== 'string') {
            throw new Error('Invalid or missing contract name');
        }
        if (this.manifestToContract[manifestHash]) {
            console.warn('[chelonia]: already loaded manifest', manifestHash);
            return;
        }
        const manifestSource = await (0, sbp_1.default)('chelonia/out/fetchResource', manifestHash, {
            code: functions_js_1.multicodes.SHELTER_CONTRACT_MANIFEST
        });
        const manifest = JSON.parse(manifestSource);
        const body = (0, sbp_1.default)('chelonia/private/verifyManifestSignature', contractName, manifestHash, manifest);
        if (body.name !== contractName) {
            throw new Error(`Mismatched contract name. Expected ${contractName} but got ${body.name}`);
        }
        const contractInfo = (this.config.contracts.defaults.preferSlim && body.contractSlim) || body.contract;
        console.info(`[chelonia] loading contract '${contractInfo.file}'@'${body.version}' from manifest: ${manifestHash}`);
        const source = await (0, sbp_1.default)('chelonia/out/fetchResource', contractInfo.hash, {
            code: functions_js_1.multicodes.SHELTER_CONTRACT_TEXT
        });
        const reduceAllow = (acc, v) => {
            acc[v] = true;
            return acc;
        };
        const allowedSels = [
            'okTurtles.events/on',
            'chelonia/defineContract',
            'chelonia/out/keyRequest'
        ]
            .concat(this.config.contracts.defaults.allowedSelectors)
            .reduce(reduceAllow, {});
        const allowedDoms = this.config.contracts.defaults.allowedDomains.reduce(reduceAllow, {});
        const contractSBP = (selector, ...args) => {
            const domain = (0, sbp_1.domainFromSelector)(selector);
            if (selector.startsWith(contractName + '/')) {
                selector = `${manifestHash}/${selector}`;
            }
            if (allowedSels[selector] || allowedDoms[domain]) {
                return (0, sbp_1.default)(selector, ...args);
            }
            else {
                console.error('[chelonia] selector not on allowlist', {
                    selector,
                    allowedSels,
                    allowedDoms
                });
                throw new Error(`[chelonia] selector not on allowlist: '${selector}'`);
            }
        };
        // const saferEval: Function = new FERAL_FUNCTION(`
        // eslint-disable-next-line no-new-func
        const saferEval = new Function(`
      return function (globals) {
        // almost a real sandbox
        // stops (() => this)().fetch
        // needs additional step of locking down Function constructor to stop:
        // new (()=>{}).constructor("console.log(typeof this.fetch)")()
        globals.self = globals
        globals.globalThis = globals
        with (new Proxy(globals, {
          get (o, p) { return o[p] },
          has (o, p) { /* console.log('has', p); */ return true }
        })) {
          (function () {
            'use strict'
            ${source}
          })()
        }
      }
    `)();
        // TODO: lock down Function constructor! could just use SES lockdown()
        // or do our own version of it.
        // https://github.com/endojs/endo/blob/master/packages/ses/src/tame-function-constructors.js
        this.defContractSBP = contractSBP;
        this.defContractManifest = manifestHash;
        // contracts will also be signed, so even if sandbox breaks we still have protection
        saferEval({
            // pass in globals that we want access to by default in the sandbox
            // note: you can undefine these by setting them to undefined in exposedGlobals
            crypto: {
                getRandomValues: (v) => globalThis.crypto.getRandomValues(v)
            },
            ...(typeof window === 'object' &&
                window && {
                alert: window.alert.bind(window),
                confirm: window.confirm.bind(window),
                prompt: window.prompt.bind(window)
            }),
            isNaN,
            console,
            Object,
            Error,
            TypeError,
            RangeError,
            Math,
            Symbol,
            Date,
            Array,
            BigInt,
            Boolean,
            String,
            Number,
            Int8Array,
            Int16Array,
            Int32Array,
            Uint8Array,
            Uint16Array,
            Uint32Array,
            Float32Array,
            Float64Array,
            ArrayBuffer,
            JSON,
            RegExp,
            parseFloat,
            parseInt,
            Promise,
            Function,
            Map,
            WeakMap,
            ...this.config.contracts.defaults.exposedGlobals,
            require: (dep) => {
                return dep === '@sbp/sbp' ? contractSBP : this.config.contracts.defaults.modules[dep];
            },
            sbp: contractSBP,
            fetchServerTime: async (fallback = true) => {
                // If contracts need the current timestamp (for example, for metadata 'createdDate')
                // they must call this function so that clients are kept synchronized to the server's
                // clock, for consistency, so that if one client's clock is off, it doesn't conflict
                // with other client's clocks.
                // See: https://github.com/okTurtles/group-income/issues/531
                try {
                    const response = await this.config.fetch(`${this.config.connectionURL}/time`, {
                        signal: this.abortController.signal
                    });
                    return (0, utils_js_1.handleFetchResult)('text')(response);
                }
                catch (e) {
                    console.warn('[fetchServerTime] Error', e);
                    if (fallback) {
                        return new Date((0, sbp_1.default)('chelonia/time')).toISOString();
                    }
                    throw new errors_js_1.ChelErrorFetchServerTimeFailed('Can not fetch server time. Please check your internet connection.');
                }
            }
        });
        if (contractName !== this.defContract.name) {
            throw new Error(`Invalid contract name for manifest ${manifestHash}. Expected ${contractName} but got ${this.defContract.name}`);
        }
        this.defContractSelectors.forEach((s) => {
            allowedSels[s] = true;
        });
        this.manifestToContract[manifestHash] = {
            slim: contractInfo === body.contractSlim,
            info: contractInfo,
            contract: this.defContract,
            name: contractName
        };
    },
    // Warning: avoid using this unless you know what you're doing. Prefer using /remove.
    'chelonia/private/removeImmediately': function (contractID, params) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const contractName = state.contracts[contractID]?.type;
        if (!contractName) {
            console.error('[chelonia/private/removeImmediately] Missing contract name for contract', {
                contractID
            });
            return;
        }
        const manifestHash = this.config.contracts.manifests[contractName];
        if (manifestHash) {
            const destructor = `${manifestHash}/${contractName}/_cleanup`;
            // Check if a destructor is defined
            if ((0, sbp_1.default)('sbp/selectors/fn', destructor)) {
                // And call it
                try {
                    (0, sbp_1.default)(destructor, { contractID, resync: !!params?.resync, state: state[contractID] });
                }
                catch (e) {
                    console.error(`[chelonia/private/removeImmediately] Error at destructor for ${contractID}`, e);
                }
            }
        }
        if (params?.resync) {
            // If re-syncing, keep the reference count
            Object.keys(state.contracts[contractID])
                .filter((k) => k !== 'references')
                .forEach((k) => this.config.reactiveDel(state.contracts[contractID], k));
            // If re-syncing, keep state._volatile.watch
            Object.keys(state[contractID])
                .filter((k) => k !== '_volatile')
                .forEach((k) => this.config.reactiveDel(state[contractID], k));
            if (state[contractID]._volatile) {
                Object.keys(state[contractID]._volatile)
                    .filter((k) => k !== 'watch')
                    .forEach((k) => this.config.reactiveDel(state[contractID]._volatile, k));
            }
        }
        else {
            delete this.ephemeralReferenceCount[contractID];
            if (params?.permanent) {
                // Keep a 'null' state to remember permanently-deleted contracts
                // (e.g., when they've been removed from the server)
                this.config.reactiveSet(state.contracts, contractID, null);
            }
            else {
                this.config.reactiveDel(state.contracts, contractID);
            }
            this.config.reactiveDel(state, contractID);
        }
        this.subscriptionSet.delete(contractID);
        // calling this will make pubsub unsubscribe for events on `contractID`
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACTS_MODIFIED, Array.from(this.subscriptionSet), {
            added: [],
            removed: [contractID],
            permanent: params?.permanent,
            resync: params?.resync
        });
    },
    // used by, e.g. 'chelonia/contract/wait'
    'chelonia/private/noop': function () { },
    'chelonia/private/out/sync': function (contractIDs, params) {
        const listOfIds = typeof contractIDs === 'string' ? [contractIDs] : contractIDs;
        const forcedSync = !!params?.force;
        return Promise.all(listOfIds.map((contractID) => {
            // If this isn't a forced sync and we're already subscribed to the contract,
            // only wait on the event queue (as events should come over the subscription)
            if (!forcedSync && this.subscriptionSet.has(contractID)) {
                const rootState = (0, sbp_1.default)(this.config.stateSelector);
                // However, if the contract has been marked as dirty (meaning its state
                // could be wrong due to newly received encryption keys), sync it anyhow
                // (i.e., disregard the force flag and proceed to sync the contract)
                if (!rootState[contractID]?._volatile?.dirty) {
                    return (0, sbp_1.default)('chelonia/private/queueEvent', contractID, ['chelonia/private/noop']);
                }
            }
            // enqueue this invocation in a serial queue to ensure
            // handleEvent does not get called on contractID while it's syncing,
            // but after it's finished. This is used in tandem with
            // queuing the 'chelonia/private/in/handleEvent' selector, defined below.
            // This prevents handleEvent getting called with the wrong previousHEAD for an event.
            return (0, sbp_1.default)('chelonia/private/queueEvent', contractID, [
                'chelonia/private/in/syncContract',
                contractID,
                params
            ]).catch((err) => {
                console.error(`[chelonia] failed to sync ${contractID}:`, err);
                throw err; // re-throw the error
            });
        }));
    },
    'chelonia/private/out/publishEvent': function (entry, { maxAttempts = 5, headers, billableContractID, bearer, disableAutoDedup } = {}, hooks) {
        const contractID = entry.contractID();
        const originalEntry = entry;
        return (0, sbp_1.default)('chelonia/private/queueEvent', `publish:${contractID}`, async () => {
            let attempt = 1;
            let lastAttemptedHeight;
            // prepublish is asynchronous to allow for cleanly sending messages to
            // different contracts
            await hooks?.prepublish?.(entry);
            const onreceivedHandler = (_contractID, message) => {
                if (entry.hash() === message.hash()) {
                    (0, sbp_1.default)('okTurtles.events/off', events_js_1.EVENT_HANDLED, onreceivedHandler);
                    hooks.onprocessed(entry);
                }
            };
            if (typeof hooks?.onprocessed === 'function') {
                (0, sbp_1.default)('okTurtles.events/on', events_js_1.EVENT_HANDLED, onreceivedHandler);
            }
            // auto resend after short random delay
            // https://github.com/okTurtles/group-income/issues/608
            while (true) {
                // Queued event to ensure that we send the event with whatever the
                // 'latest' state may be for that contract (in case we were receiving
                // something over the web socket)
                // This also ensures that the state doesn't change while reading it
                lastAttemptedHeight = entry.height();
                const newEntry = await (0, sbp_1.default)('chelonia/private/queueEvent', contractID, async () => {
                    const rootState = (0, sbp_1.default)(this.config.stateSelector);
                    const state = rootState[contractID];
                    const isFirstMessage = entry.isFirstMessage();
                    if (!state && !isFirstMessage) {
                        console.info(`[chelonia] Not sending message as contract state has been removed: ${entry.description()}`);
                        return;
                    }
                    if (hooks?.preSendCheck) {
                        if (!(await hooks.preSendCheck(entry, state))) {
                            console.info(`[chelonia] Not sending message as preSendCheck hook returned non-truish value: ${entry.description()}`);
                            return;
                        }
                    }
                    // Process message to ensure that it is valid. Should this throw,
                    // we propagate the error. Calling `processMessage` will perform
                    // validation by checking signatures, well-formedness and, in the case
                    // of actions, by also calling both the `validate` method (which
                    // doesn't mutate the state) and the `process` method (which could
                    // mutate the state).
                    // `SPMessage` objects have an implicit `direction` field that's set
                    // based on how the object was constructed. For messages that will be
                    // sent to the server (this case), `direction` is set to `outgoing`.
                    // This `direction` affects how certain errors are reported during
                    // processing, and is also exposed to contracts (which could then
                    // alter their behavior based on this) to support some features (such
                    // as showing users that a certain message is 'pending').
                    // Validation ensures that we don't write messages known to be invalid.
                    // Although those invalid messages will be ignored if sent anyhow,
                    // sending them is wasteful.
                    // The only way to know for sure if a message is valid or not is using
                    // the same logic that would be used if the message was received,
                    // hence the call to `processMessage`. Validation requires having the
                    // state and all mutations that would be applied. For example, when
                    // joining a chatroom, this is usually done by sending an OP_ATOMIC
                    // that contains OP_KEY_ADD and OP_ACTION_ENCRYPTED. Correctly
                    // validating this operation requires applying the OP_KEY_ADD to the
                    // state in order to know whether OP_ACTION_ENCRYPTED has a valid
                    // signature or not.
                    // We also rely on this logic to keep different contracts in sync
                    // when there are side-effects. For example, the side-effect in a
                    // group for someone joining a chatroom can call the `join` action
                    // on the chatroom unconditionally, since validation will prevent
                    // the message from being sent.
                    // Because of this, 'chelonia/private/in/processMessage' SHOULD NOT
                    // change the global Chelonia state and it MUST NOT call any
                    // side-effects or change the global state in a way that affects
                    // the meaning of any future messages or successive invocations.
                    // Note: mutations to the contract state, if any, are immediately
                    // discarded (see the temporary object created using `cloneDeep`).
                    await (0, sbp_1.default)('chelonia/private/in/processMessage', entry, (0, turtledash_1.cloneDeep)(state || {}));
                    // if this isn't the first event (i.e., OP_CONTRACT), recreate and
                    // resend message
                    // This is mainly to set height and previousHEAD. For the first event,
                    // this doesn't need to be done because previousHEAD is always undefined
                    // and height is always 0.
                    // We always call recreateEvent because we may have received new events
                    // in the web socket
                    if (!isFirstMessage) {
                        return (0, utils_js_1.recreateEvent)(entry, state, rootState.contracts[contractID], disableAutoDedup);
                    }
                    return entry;
                });
                // If there is no event to send, return
                if (!newEntry)
                    return;
                await hooks?.beforeRequest?.(newEntry, entry);
                entry = newEntry;
                const r = await this.config.fetch(`${this.config.connectionURL}/event`, {
                    method: 'POST',
                    body: entry.serialize(),
                    headers: {
                        ...headers,
                        ...(bearer && {
                            Authorization: `Bearer ${bearer}`
                        }),
                        ...(billableContractID && {
                            Authorization: utils_js_1.buildShelterAuthorizationHeader.call(this, billableContractID)
                        }),
                        'Content-Type': 'text/plain'
                    },
                    signal: this.abortController.signal
                });
                if (r.ok) {
                    await hooks?.postpublish?.(entry);
                    return entry;
                }
                try {
                    if (r.status === 409) {
                        if (attempt + 1 > maxAttempts) {
                            console.error(`[chelonia] failed to publish ${entry.description()} after ${attempt} attempts`, entry);
                            throw new Error(`publishEvent: ${r.status} - ${r.statusText}. attempt ${attempt}`);
                        }
                        // create new entry
                        const randDelay = (0, turtledash_1.randomIntFromRange)(0, 1500);
                        console.warn(`[chelonia] publish attempt ${attempt} of ${maxAttempts} failed. Waiting ${randDelay} msec before resending ${entry.description()}`);
                        attempt += 1;
                        await (0, turtledash_1.delay)(randDelay); // wait randDelay ms before sending it again
                        // TODO: The [pubsub] code seems to miss events that happened between
                        // a call to sync and the subscription time. This is a temporary measure
                        // to handle this until [pubsub] is updated.
                        if (!entry.isFirstMessage() && entry.height() === lastAttemptedHeight) {
                            await (0, sbp_1.default)('chelonia/private/out/sync', contractID, { force: true });
                        }
                    }
                    else {
                        const message = (await r.json())?.message;
                        console.error(`[chelonia] ERROR: failed to publish ${entry.description()}: ${r.status} - ${r.statusText}: ${message}`, entry);
                        throw new Error(`publishEvent: ${r.status} - ${r.statusText}: ${message}`);
                    }
                }
                catch (e) {
                    (0, sbp_1.default)('okTurtles.events/off', events_js_1.EVENT_HANDLED, onreceivedHandler);
                    throw e;
                }
            }
        })
            .then((entry) => {
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.EVENT_PUBLISHED, {
                contractID,
                message: entry,
                originalMessage: originalEntry
            });
            return entry;
        })
            .catch((e) => {
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.EVENT_PUBLISHING_ERROR, {
                contractID,
                message: entry,
                originalMessage: originalEntry,
                error: e
            });
            throw e;
        });
    },
    'chelonia/private/out/latestHEADinfo': function (contractID) {
        return this.config
            .fetch(`${this.config.connectionURL}/latestHEADinfo/${contractID}`, {
            cache: 'no-store',
            signal: this.abortController.signal
        })
            .then((0, utils_js_1.handleFetchResult)('json'));
    },
    'chelonia/private/postKeyShare': function (contractID, previousVolatileState, signingKey) {
        const cheloniaState = (0, sbp_1.default)(this.config.stateSelector);
        const targetState = cheloniaState[contractID];
        if (!targetState)
            return;
        if (previousVolatileState && (0, turtledash_1.has)(previousVolatileState, 'watch')) {
            if (!targetState._volatile) {
                this.config.reactiveSet(targetState, '_volatile', Object.create(null));
            }
            if (!targetState._volatile.watch) {
                this.config.reactiveSet(targetState._volatile, 'watch', previousVolatileState.watch);
            }
            else if (targetState._volatile.watch !== previousVolatileState.watch) {
                previousVolatileState.watch.forEach((pWatch) => {
                    if (!targetState._volatile.watch.some((tWatch) => {
                        return tWatch[0] === pWatch[0] && tWatch[1] === pWatch[1];
                    })) {
                        targetState._volatile.watch.push(pWatch);
                    }
                });
            }
        }
        if (!Array.isArray(targetState._volatile?.pendingKeyRequests))
            return;
        this.config.reactiveSet(targetState._volatile, 'pendingKeyRequests', targetState._volatile.pendingKeyRequests.filter((pkr) => pkr?.name !== signingKey.name));
    },
    'chelonia/private/operationHook': function (contractID, message, state) {
        if (this.config.skipActionProcessing)
            return;
        const manifestHash = message.manifest();
        const contractName = this.manifestToContract[manifestHash]?.name;
        if (!contractName)
            return;
        const callHook = (op, atomic) => {
            const hook = `${manifestHash}/${contractName}/_postOpHook/${op}`;
            // Check if a hook is defined
            if ((0, sbp_1.default)('sbp/selectors/fn', hook)) {
                // And call it
                try {
                    // Note: Errors here should not stop processing, since running these
                    // hooks is optional (for example, they aren't run on the server)
                    (0, sbp_1.default)(hook, { contractID, message, state, atomic });
                }
                catch (e) {
                    console.error(`[${hook}] hook error for message ${message.hash()} on contract ${contractID}:`, e);
                }
            }
        };
        if (message.opType() === SPMessage_js_1.SPMessage.OP_ATOMIC) {
            const opsSet = new Set();
            for (const [op] of message.opValue()) {
                // Only call hook once per opcode
                if (opsSet.has(op))
                    continue;
                opsSet.add(op);
                callHook(op, true);
            }
        }
        // Note that for `OP_ATOMIC` the hook will be called multiple times:
        //   * once per op-type (with the `atomic` option)
        //   * then, for OP_ATOMIC
        callHook(message.opType());
    },
    'chelonia/private/in/processMessage': async function (message, state, internalSideEffectStack, contractName) {
        const [opT, opV] = message.op();
        const hash = message.hash();
        const height = message.height();
        const contractID = message.contractID();
        const manifestHash = message.manifest();
        const signingKeyId = message.signingKeyId();
        const direction = message.direction();
        const config = this.config;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const opName = Object.entries(SPMessage_js_1.SPMessage).find(([, y]) => y === opT)?.[0];
        console.debug('PROCESSING OPCODE:', opName, 'to', contractID);
        if (state?._volatile?.dirty) {
            console.debug('IGNORING OPCODE BECAUSE CONTRACT STATE IS MARKED AS DIRTY.', 'OPCODE:', opName, 'CONTRACT:', contractID);
            return;
        }
        if (!state._vm)
            state._vm = Object.create(null);
        const opFns = {
            /*
              There are two types of "errors" that we need to consider:
              1. "Ignoring" errors
              2. "Failure" errors
              Example: OP_KEY_ADD
              1. IGNORING: an error is thrown because we wanted to add a key but the
              key we wanted to add is already there. This is not a hard error, it's an
              ignoring error. We don't care that the operation failed in this case because the intent was accomplished.
              2. FAILURE: an error is thrown while attempting to add a key that doesn't exist.
              Example: OP_ACTION_ENCRYPTED
              1. IGNORING: An error is thrown because we don't have the key to decrypt the action. We ignore it.
              2. FAILURE: An error is thrown by the process function during processing.
              Handling these in OP_ATOMIC
              • ALL errors of class "IGNORING" should be ignored. They should not
              impact our ability to process the rest of the operations in the OP_ATOMIC.
              No matter how many of these are thrown, it doesn't affect the rest of the operations.
              • ANY error of class "FAILURE" will call the rest of the operations to
              fail and the state to be reverted to prior to the OP_ATOMIC. No side-effects should be run. Because an intention failed.
            */
            async [SPMessage_js_1.SPMessage.OP_ATOMIC](v) {
                for (let i = 0; i < v.length; i++) {
                    const u = v[i];
                    try {
                        if (u[0] === SPMessage_js_1.SPMessage.OP_ATOMIC)
                            throw new Error('Cannot nest OP_ATOMIC');
                        if (!(0, utils_js_1.validateKeyPermissions)(message, config, state, signingKeyId, u[0], u[1])) {
                            throw new Error('Inside OP_ATOMIC: no matching signing key was defined');
                        }
                        await opFns[u[0]](u[1]);
                    }
                    catch (e_) {
                        const e = e_;
                        if (e && typeof e === 'object') {
                            if (e.name === 'ChelErrorDecryptionKeyNotFound') {
                                console.warn(`[chelonia] [OP_ATOMIC] WARN '${e.name}' in processMessage for ${message.description()}: ${e.message}`, e, message.serialize());
                                if (e.cause) {
                                    const missingDecryptionKeyIds = missingDecryptionKeyIdsMap.get(message);
                                    if (missingDecryptionKeyIds) {
                                        missingDecryptionKeyIds.add(e.cause);
                                    }
                                    else {
                                        missingDecryptionKeyIdsMap.set(message, new Set([e.cause]));
                                    }
                                }
                                continue;
                            }
                            else {
                                (0, utils_js_1.logEvtError)(message, `[chelonia] [OP_ATOMIC] ERROR '${e.name}' in processMessage for ${message.description()}: ${e.message || e}`, e, message.serialize());
                            }
                            console.warn(`[chelonia] [OP_ATOMIC] Error processing ${message.description()}: ${message.serialize()}. Any side effects will be skipped!`);
                            if (config.strictProcessing) {
                                throw e;
                            }
                            config.hooks.processError?.(e, message, getMsgMeta.call(self, message, contractID, state));
                            if (e.name === 'ChelErrorWarning')
                                continue;
                        }
                        else {
                            (0, utils_js_1.logEvtError)(message, 'Inside OP_ATOMIC: Non-object or null error thrown', contractID, message, i, e);
                        }
                        throw e;
                    }
                }
            },
            [SPMessage_js_1.SPMessage.OP_CONTRACT](v) {
                state._vm.type = v.type;
                const keys = keysToMap.call(self, v.keys, height, signingKeyId);
                state._vm.authorizedKeys = keys;
                // Loop through the keys in the contract and try to decrypt all of the private keys
                // Example: in the identity contract you have the IEK, IPK, CSK, and CEK.
                // When you login you have the IEK which is derived from your password, and you
                // will use it to decrypt the rest of the keys which are encrypted with that.
                // Specifically, the IEK is used to decrypt the CSKs and the CEKs, which are
                // the encrypted versions of the CSK and CEK.
                utils_js_1.keyAdditionProcessor.call(self, message, hash, v.keys, state, contractID, signingKey, internalSideEffectStack);
            },
            [SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED](v) {
                if (config.skipActionProcessing) {
                    if (!config.skipDecryptionAttempts) {
                        console.log('OP_ACTION_ENCRYPTED: skipped action processing');
                    }
                    return;
                }
                return opFns[SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED](v.valueOf());
            },
            async [SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED](v) {
                if (!config.skipActionProcessing) {
                    let innerSigningKeyId;
                    if ((0, signedData_js_1.isSignedData)(v)) {
                        innerSigningKeyId = v.signingKeyId;
                        v = v.valueOf();
                    }
                    const { data, meta, action } = v;
                    if (!config.whitelisted(action)) {
                        throw new Error(`chelonia: action not whitelisted: '${action}'`);
                    }
                    await (0, sbp_1.default)(`${manifestHash}/${action}/process`, {
                        data,
                        meta,
                        hash,
                        height,
                        contractID,
                        direction: message.direction(),
                        signingKeyId,
                        get signingContractID() {
                            return (0, utils_js_1.getContractIDfromKeyId)(contractID, signingKeyId, state);
                        },
                        innerSigningKeyId,
                        get innerSigningContractID() {
                            return (0, utils_js_1.getContractIDfromKeyId)(contractID, innerSigningKeyId, state);
                        }
                    }, state);
                }
            },
            [SPMessage_js_1.SPMessage.OP_KEY_SHARE](wv) {
                // TODO: Prompt to user if contract not in pending
                const data = config.unwrapMaybeEncryptedData(wv);
                if (!data)
                    return;
                const v = data.data;
                for (const key of v.keys) {
                    if (key.id && key.meta?.private?.content) {
                        if (!(0, turtledash_1.has)(state._vm, 'sharedKeyIds'))
                            state._vm.sharedKeyIds = [];
                        // Set or update sharedKeyIds information
                        const sharedKeyId = state._vm.sharedKeyIds.find((sK) => sK.id === key.id);
                        if (!sharedKeyId) {
                            state._vm.sharedKeyIds.push({
                                id: key.id,
                                // Contract ID this key is for
                                contractID: v.contractID,
                                // Contract ID used for encrypting the key
                                foreignContractIDs: v.foreignContractID ? [[v.foreignContractID, height]] : [],
                                height,
                                keyRequestHash: v.keyRequestHash,
                                keyRequestHeight: v.keyRequestHeight
                            });
                        }
                        else if (v.foreignContractID) {
                            if (!sharedKeyId.foreignContractIDs) {
                                sharedKeyId.foreignContractIDs = [[v.foreignContractID, height]];
                            }
                            else {
                                const tuple = sharedKeyId
                                    .foreignContractIDs.find(([id]) => id === v.foreignContractID);
                                if (tuple) {
                                    tuple[2] = height;
                                }
                                else {
                                    sharedKeyId.foreignContractIDs.push([v.foreignContractID, height]);
                                }
                            }
                        }
                    }
                }
                // If this is a response to an OP_KEY_REQUEST (marked by the
                // presence of the keyRequestHash attribute), then we'll mark the
                // key request as completed
                // TODO: Verify that the keyRequestHash is what we expect (on the
                // other contact's state, we should have a matching structure in
                // state._volatile.pendingKeyRequests = [
                //    { contractID: "this", name: "name of this signingKeyId", reference: "this reference", hash: "KA" }, ..., but we don't
                // have a copy of the keyRequestHash (this would need a new
                // message to ourselves in the KR process), so for now we trust
                // that if it has keyRequestHash, it's a response to a request
                // we sent.
                // For similar reasons, we can't check pendingKeyRequests, because
                // depending on how and in which order events are processed, it may
                // not be available.
                // ]
                if ((0, turtledash_1.has)(v, 'keyRequestHash') && state._vm.authorizedKeys[signingKeyId].meta?.keyRequest) {
                    state._vm.authorizedKeys[signingKeyId].meta.keyRequest.responded = hash;
                }
                internalSideEffectStack?.push(async () => {
                    delete self.postSyncOperations[contractID]?.['pending-keys-for-' + v.contractID];
                    const cheloniaState = (0, sbp_1.default)(self.config.stateSelector);
                    const targetState = cheloniaState[v.contractID];
                    const missingDecryptionKeyIds = cheloniaState.contracts[v.contractID]?.missingDecryptionKeyIds;
                    let newestEncryptionKeyHeight = Number.POSITIVE_INFINITY;
                    for (const key of v.keys) {
                        if (key.id && key.meta?.private?.content) {
                            // Outgoing messages' keys are always transient
                            const transient = direction === 'outgoing' || key.meta.private.transient;
                            if (!(0, sbp_1.default)('chelonia/haveSecretKey', key.id, !transient)) {
                                try {
                                    const decrypted = key.meta.private.content.valueOf();
                                    (0, sbp_1.default)('chelonia/storeSecretKeys', new Secret_js_1.Secret([
                                        {
                                            key: (0, crypto_1.deserializeKey)(decrypted),
                                            transient
                                        }
                                    ]));
                                    // If we've just received a known missing key (i.e., a key
                                    // that previously resulted in a decryption error), we know
                                    // our state is outdated and we need to re-sync the contract
                                    if (missingDecryptionKeyIds?.includes(key.id)) {
                                        newestEncryptionKeyHeight = Number.NEGATIVE_INFINITY;
                                    }
                                    else if (
                                    // Otherwise, we make an educated guess on whether a re-sync
                                    // is needed based on the height.
                                    targetState?._vm?.authorizedKeys?.[key.id]?._notBeforeHeight != null &&
                                        Array.isArray(targetState._vm.authorizedKeys[key.id].purpose) &&
                                        targetState._vm.authorizedKeys[key.id].purpose.includes('enc')) {
                                        newestEncryptionKeyHeight = Math.min(newestEncryptionKeyHeight, targetState._vm.authorizedKeys[key.id]._notBeforeHeight);
                                    }
                                }
                                catch (e_) {
                                    const e = e_;
                                    if (e?.name === 'ChelErrorDecryptionKeyNotFound') {
                                        console.warn(`OP_KEY_SHARE (${hash} of ${contractID}) missing secret key: ${e.message}`, e);
                                    }
                                    else {
                                        // Using console.error instead of logEvtError because this
                                        // is a side-effect and not relevant for outgoing messages
                                        console.error(`OP_KEY_SHARE (${hash} of ${contractID}) error '${e.message || e}':`, e);
                                    }
                                }
                            }
                        }
                    }
                    // If an encryption key has been shared with _notBefore lower than the
                    // current height, then the contract must be resynced.
                    const mustResync = !!(newestEncryptionKeyHeight < cheloniaState.contracts[v.contractID]?.height);
                    if (mustResync) {
                        if (!(0, turtledash_1.has)(targetState, '_volatile')) {
                            config.reactiveSet(targetState, '_volatile', Object.create(null));
                        }
                        config.reactiveSet(targetState._volatile, 'dirty', true);
                        if (!Object.keys(targetState).some((k) => k !== '_volatile')) {
                            // If the contract only has _volatile state, we don't force sync it
                            return;
                        }
                        // Mark contracts that have foreign keys that have been received
                        // as dirty
                        // First, we group watched keys by key and contracts
                        const keyDict = Object.create(null);
                        targetState._volatile?.watch?.forEach(([keyName, contractID]) => {
                            if (!keyDict[keyName]) {
                                keyDict[keyName] = [contractID];
                                return;
                            }
                            keyDict[keyName].push(contractID);
                        });
                        // Then, see which of those contracts need to be updated
                        const contractIdsToUpdate = Array.from(new Set(Object.entries(keyDict).flatMap(([keyName, contractIDs]) => {
                            const keyId = (0, utils_js_1.findKeyIdByName)(targetState, keyName);
                            if (
                            // Does the key exist? (i.e., is it a current key)
                            keyId &&
                                // Is it an encryption key? (signing keys don't build up a
                                // potentially invalid state because the private key isn't
                                // required for validation; however, missing encryption keys
                                // prevent message processing)
                                targetState._vm.authorizedKeys[keyId].purpose.includes('enc') &&
                                // Is this a newly set key? (avoid re-syncing contracts that
                                // haven't been affected by the `OP_KEY_SHARE`)
                                targetState._vm.authorizedKeys[keyId]._notBeforeHeight >=
                                    newestEncryptionKeyHeight) {
                                return contractIDs;
                            }
                            return [];
                        })));
                        // Mark these contracts as dirty
                        contractIdsToUpdate.forEach((contractID) => {
                            const targetState = cheloniaState[contractID];
                            if (!targetState)
                                return;
                            if (!(0, turtledash_1.has)(targetState, '_volatile')) {
                                config.reactiveSet(targetState, '_volatile', Object.create(null));
                            }
                            config.reactiveSet(targetState._volatile, 'dirty', true);
                        });
                        // Since we have received new keys, the current contract state might be wrong, so we need to remove the contract and resync
                        // Note: The following may be problematic when several tabs are open
                        // sharing the same state. This is more of a general issue in this
                        // situation, not limited to the following sequence of events
                        if (self.subscriptionSet.has(v.contractID)) {
                            const resync = (0, sbp_1.default)('chelonia/private/queueEvent', v.contractID, [
                                'chelonia/private/in/syncContract',
                                v.contractID
                            ])
                                .then(() => {
                                // Now, if we're subscribed to any of the contracts that were
                                // marked as dirty, re-sync them
                                (0, sbp_1.default)('chelonia/private/out/sync', contractIdsToUpdate.filter((contractID) => {
                                    return self.subscriptionSet.has(contractID);
                                }), { force: true, resync: true }).catch((e) => {
                                    // Using console.error instead of logEvtError because this
                                    // is a side-effect and not relevant for outgoing messages
                                    console.error('[chelonia] Error resyncing contracts with foreign key references after key rotation', e);
                                });
                            })
                                .catch((e) => {
                                // Using console.error instead of logEvtError because this
                                // is a side-effect and not relevant for outgoing messages
                                console.error(`[chelonia] Error during sync for ${v.contractID} during OP_KEY_SHARE for ${contractID}`);
                                if (v.contractID === contractID) {
                                    throw e;
                                }
                            });
                            // If the keys received were for the current contract, we can't
                            // use queueEvent as we're already on that same queue
                            if (v.contractID !== contractID) {
                                await resync;
                            }
                        }
                    }
                    const previousVolatileState = targetState?._volatile;
                    (0, sbp_1.default)('chelonia/private/queueEvent', v.contractID, [
                        'chelonia/private/postKeyShare',
                        v.contractID,
                        mustResync ? previousVolatileState : null,
                        signingKey
                    ]).then(() => {
                        // The CONTRACT_HAS_RECEIVED_KEYS event is placed on the queue for
                        // the current contract so that calling
                        // 'chelonia/contract/waitingForKeyShareTo' will give correct results
                        // (i.e., the event is processed after the state is written)
                        (0, sbp_1.default)('chelonia/private/queueEvent', contractID, () => {
                            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACT_HAS_RECEIVED_KEYS, {
                                contractID: v.contractID,
                                sharedWithContractID: contractID,
                                signingKeyId,
                                get signingKeyName() {
                                    return state._vm?.authorizedKeys?.[signingKeyId]?.name;
                                }
                            });
                        }).catch((e) => {
                            // Using console.error instead of logEvtError because this
                            // is a side-effect and not relevant for outgoing messages
                            console.error(`[chelonia] Error while emitting the CONTRACT_HAS_RECEIVED_KEYS event for ${contractID}`, e);
                        });
                    });
                });
            },
            [SPMessage_js_1.SPMessage.OP_KEY_REQUEST](wv) {
                const data = config.unwrapMaybeEncryptedData(wv);
                // TODO: THIS CODE SHOULD BE REFACTORED IF WE RECREATE GROUPS
                //       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
                // If we're unable to decrypt the OP_KEY_REQUEST, then still
                // proceed to do accounting of invites
                let skipInviteAccounting = false;
                let encryptedRequest = false;
                // Handle both V1 and V2
                const v = (() => {
                    if (!data)
                        return;
                    // V2 has an _unencrypted_ outer layer and an optionally encrypted
                    // `innerData` field
                    if (!data.encryptionKeyId && (0, turtledash_1.has)(data.data, 'innerData')) {
                        // It's V2
                        skipInviteAccounting = !!data.data.skipInviteAccounting;
                        const innerData = config.unwrapMaybeEncryptedData(data.data.innerData);
                        encryptedRequest = !!innerData?.encryptionKeyId;
                        return innerData?.data;
                    }
                    else {
                        // It's V1
                        encryptedRequest = !!data.encryptionKeyId;
                        return data.data;
                    }
                })() || {
                    contractID: '(private)',
                    replyWith: { context: undefined },
                    request: '(private)'
                };
                const originatingContractID = v.contractID;
                if (state._vm?.invites?.[signingKeyId] &&
                    !skipInviteAccounting) {
                    if (state._vm.invites[signingKeyId].status !== constants_js_1.INVITE_STATUS.VALID) {
                        (0, utils_js_1.logEvtError)(message, '[processMessage] Ignoring OP_KEY_REQUEST because it is not valid: ' +
                            originatingContractID);
                        return;
                    }
                    // We consume invites before responding (or checking if we can respond)
                    // because it's the only way to be certain that we won't over-respond
                    // to requests.
                    if (state._vm?.invites?.[signingKeyId]?.quantity != null) {
                        if (state._vm.invites[signingKeyId].quantity > 0) {
                            if (--state._vm.invites[signingKeyId].quantity <= 0) {
                                state._vm.invites[signingKeyId].status = constants_js_1.INVITE_STATUS.USED;
                            }
                        }
                        else {
                            (0, utils_js_1.logEvtError)(message, 'Ignoring OP_KEY_REQUEST because it exceeds allowed quantity: ' +
                                originatingContractID);
                            return;
                        }
                    }
                    if (state._vm.invites[signingKeyId].expires != null &&
                        state._vm.invites[signingKeyId].expires < Date.now()) {
                        (0, utils_js_1.logEvtError)(message, 'Ignoring OP_KEY_REQUEST because it expired at ' +
                            state._vm.invites[signingKeyId].expires +
                            ': ' +
                            originatingContractID);
                        return;
                    }
                }
                // If skipping processing or if the message is outgoing, there isn't
                // anything else to do
                if (config.skipActionProcessing || direction === 'outgoing') {
                    return;
                }
                // Outgoing messages don't have a context attribute
                if (!(0, turtledash_1.has)(v.replyWith, 'context')) {
                    (0, utils_js_1.logEvtError)(message, 'Ignoring OP_KEY_REQUEST because it is missing the context attribute');
                    return;
                }
                const context = v.replyWith.context;
                if (data && (!Array.isArray(context) || context[0] !== originatingContractID)) {
                    (0, utils_js_1.logEvtError)(message, 'Ignoring OP_KEY_REQUEST because it is signed by the wrong contract');
                    return;
                }
                if (!state._vm.pendingKeyshares)
                    state._vm.pendingKeyshares = Object.create(null);
                state._vm.pendingKeyshares[message.hash()] = context
                    ? [
                        // Full-encryption (i.e., KRS encryption) requires that this request
                        // was encrypted and that the invite is marked as private
                        encryptedRequest,
                        message.height(),
                        signingKeyId,
                        context,
                        v.request,
                        message.manifest(),
                        skipInviteAccounting
                    ]
                    : [encryptedRequest, message.height(), signingKeyId];
                // Call 'chelonia/private/respondToAllKeyRequests' after sync
                if (data) {
                    internalSideEffectStack?.push(() => {
                        self.setPostSyncOp(contractID, 'respondToAllKeyRequests-' + message.contractID(), [
                            'chelonia/private/respondToAllKeyRequests',
                            contractID
                        ]);
                    });
                }
            },
            [SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN](wv) {
                if (config.skipActionProcessing) {
                    return;
                }
                // TODO: Handle boolean (success) value
                const data = config.unwrapMaybeEncryptedData(wv);
                if (!data)
                    return;
                const v = data.data;
                if (state._vm.pendingKeyshares && v.keyRequestHash in state._vm.pendingKeyshares) {
                    const hash = v.keyRequestHash;
                    const pending = state._vm.pendingKeyshares[hash];
                    delete state._vm.pendingKeyshares[hash];
                    // TODO: THIS CODE SHOULD BE REFACTORED IF WE RECREATE GROUPS
                    //       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
                    if (pending.length !== 4 && pending.length !== 7)
                        return;
                    // If we were able to respond, clean up responders
                    const keyId = pending[2];
                    const originatingContractID = pending[3][0];
                    if (Array.isArray(state._vm?.invites?.[keyId]?.responses)) {
                        state._vm?.invites?.[keyId]?.responses.push(originatingContractID);
                    }
                    if (!(0, turtledash_1.has)(state._vm, 'keyshares'))
                        state._vm.keyshares = Object.create(null);
                    // TODO: THIS CODE SHOULD BE DELETED IF WE RECREATE GROUPS
                    //       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
                    // Handle new and old formats
                    let inner = v;
                    if (data.encryptionKeyId == null && (0, turtledash_1.has)(v, 'innerData')) {
                        const innerResult = config.unwrapMaybeEncryptedData(v.innerData);
                        inner = innerResult?.data;
                    }
                    const success = inner?.success;
                    state._vm.keyshares[hash] = {
                        contractID: originatingContractID,
                        height,
                        success,
                        ...(success && {
                            hash: inner?.keyShareHash
                        })
                    };
                }
            },
            [SPMessage_js_1.SPMessage.OP_PROP_DEL]: notImplemented,
            [SPMessage_js_1.SPMessage.OP_PROP_SET](v) {
                if (!state._vm.props)
                    state._vm.props = {};
                state._vm.props[v.key] = v.value;
            },
            [SPMessage_js_1.SPMessage.OP_KEY_ADD](v) {
                const keys = keysToMap.call(self, v, height, signingKeyId, state._vm.authorizedKeys);
                const keysArray = Object.values(v);
                keysArray.forEach((k) => {
                    if ((0, turtledash_1.has)(state._vm.authorizedKeys, k.id) &&
                        state._vm.authorizedKeys[k.id]._notAfterHeight == null) {
                        throw new errors_js_1.ChelErrorWarning('Cannot use OP_KEY_ADD on existing keys. Key ID: ' + k.id);
                    }
                });
                utils_js_1.validateKeyAddPermissions.call(self, contractID, signingKey, state, v);
                state._vm.authorizedKeys = { ...state._vm.authorizedKeys, ...keys };
                utils_js_1.keyAdditionProcessor.call(self, message, hash, v, state, contractID, signingKey, internalSideEffectStack);
            },
            [SPMessage_js_1.SPMessage.OP_KEY_DEL](v) {
                if (!state._vm.authorizedKeys)
                    state._vm.authorizedKeys = Object.create(null);
                if (!state._volatile)
                    state._volatile = Object.create(null);
                if (!state._volatile.pendingKeyRevocations) {
                    state._volatile.pendingKeyRevocations = Object.create(null);
                }
                utils_js_1.validateKeyDelPermissions.call(self, contractID, signingKey, state, v);
                const keyIds = v
                    .map((k) => {
                    const data = config.unwrapMaybeEncryptedData(k);
                    if (!data)
                        return undefined;
                    return data.data;
                })
                    .filter((keyId) => {
                    if (!keyId || typeof keyId !== 'string')
                        return false;
                    if (!(0, turtledash_1.has)(state._vm.authorizedKeys, keyId) ||
                        state._vm.authorizedKeys[keyId]._notAfterHeight != null) {
                        console.warn('Attempted to delete non-existent key from contract', {
                            contractID,
                            keyId
                        });
                        return false;
                    }
                    return true;
                });
                (0, utils_js_1.deleteKeyHelper)(state, height, keyIds);
                keyIds.forEach((keyId) => {
                    const key = state._vm.authorizedKeys[keyId];
                    // Are we deleting a foreign key? If so, we also need to remove
                    // the operation from (1) _volatile.watch (on the other contract)
                    // and (2) pendingWatch
                    if (key.foreignKey) {
                        const fkUrl = new URL(key.foreignKey);
                        const foreignContract = fkUrl.pathname;
                        const foreignKeyName = fkUrl.searchParams.get('keyName');
                        if (!foreignContract || !foreignKeyName) {
                            throw new Error('Invalid foreign key: missing contract or key name');
                        }
                        internalSideEffectStack?.push(() => {
                            (0, sbp_1.default)('chelonia/private/queueEvent', foreignContract, () => {
                                const rootState = (0, sbp_1.default)(config.stateSelector);
                                if (Array.isArray(rootState[foreignContract]?._volatile?.watch)) {
                                    // Stop watching events for this key
                                    const oldWatch = rootState[foreignContract]._volatile.watch;
                                    rootState[foreignContract]._volatile.watch = oldWatch.filter(([name, cID]) => name !== foreignKeyName || cID !== contractID);
                                    if (oldWatch.length !== rootState[foreignContract]._volatile.watch.length) {
                                        // If the number of foreign keys changed, maybe there's no
                                        // reason to remain subscribed to this contract. In this
                                        // case, attempt to release it.
                                        (0, sbp_1.default)('chelonia/contract/release', foreignContract, { try: true }).catch((e) => {
                                            // Using console.error instead of logEvtError because this
                                            // is a side-effect and not relevant for outgoing messages
                                            console.error(`[chelonia] Error at OP_KEY_DEL internalSideEffectStack while attempting to release foreign contract ${foreignContract}`, e);
                                        });
                                    }
                                }
                            }).catch((e) => {
                                // Using console.error instead of logEvtError because this
                                // is a side-effect and not relevant for outgoing messages
                                console.error('Error stopping watching events after removing key', { contractID, foreignContract, foreignKeyName, fkUrl }, e);
                            });
                        });
                        const pendingWatch = state._vm.pendingWatch?.[foreignContract];
                        if (pendingWatch) {
                            state._vm.pendingWatch[foreignContract] = pendingWatch.filter(([, kId]) => kId !== keyId);
                        }
                    }
                    // Set the status to revoked for invite keys
                    if (key.name.startsWith('#inviteKey-') && state._vm.invites[key.id]) {
                        state._vm.invites[key.id].status = constants_js_1.INVITE_STATUS.REVOKED;
                    }
                });
                // Check state._volatile.watch for contracts that should be
                // mirroring this operation
                if (Array.isArray(state._volatile?.watch)) {
                    const updatedKeysMap = Object.create(null);
                    keyIds.forEach((keyId) => {
                        updatedKeysMap[state._vm.authorizedKeys[keyId].name] = {
                            name: state._vm.authorizedKeys[keyId].name,
                            oldKeyId: keyId
                        };
                    });
                    keyRotationHelper(contractID, state, config, updatedKeysMap, [SPMessage_js_1.SPMessage.OP_KEY_DEL], 'chelonia/out/keyDel', (name) => updatedKeysMap[name[0]].oldKeyId, internalSideEffectStack);
                }
            },
            [SPMessage_js_1.SPMessage.OP_KEY_UPDATE](v) {
                if (!state._volatile)
                    state._volatile = Object.create(null);
                if (!state._volatile.pendingKeyRevocations) {
                    state._volatile.pendingKeyRevocations = Object.create(null);
                }
                const [updatedKeys, updatedMap] = utils_js_1.validateKeyUpdatePermissions.call(self, contractID, signingKey, state, v);
                const keysToDelete = Object.values(updatedMap);
                (0, utils_js_1.deleteKeyHelper)(state, height, keysToDelete);
                let canMirrorOperationsUpToRingLevel = NaN;
                let hasOutOfSyncKeys = false;
                for (const key of updatedKeys) {
                    if (!(0, turtledash_1.has)(state._vm.authorizedKeys, key.id)) {
                        key._notBeforeHeight = height;
                        state._vm.authorizedKeys[key.id] = (0, turtledash_1.cloneDeep)(key);
                    }
                    else if (state._vm.authorizedKeys[key.id]._notAfterHeight == null) {
                        state._vm.authorizedKeys[key.id] = (0, utils_js_1.updateKey)(state._vm.authorizedKeys[key.id], key);
                    }
                    else {
                        throw new Error('Unable to update a deleted key');
                    }
                    // If this is a foreign key, it may be out of sync
                    if (key.foreignKey != null) {
                        if (!(key.ringLevel >= canMirrorOperationsUpToRingLevel)) {
                            const signingKey = (0, utils_js_1.findSuitableSecretKeyId)(state, [SPMessage_js_1.SPMessage.OP_KEY_DEL], ['sig'], key.ringLevel);
                            if (signingKey) {
                                canMirrorOperationsUpToRingLevel = key.ringLevel;
                            }
                        }
                        const fkUrl = new URL(key.foreignKey);
                        const foreignContractID = fkUrl.pathname;
                        const foreignKeyName = fkUrl.searchParams.get('keyName');
                        if (!foreignKeyName)
                            throw new Error('Missing foreign key name');
                        const foreignState = (0, sbp_1.default)('chelonia/contract/state', foreignContractID);
                        if (foreignState) {
                            const fKeyId = (0, utils_js_1.findKeyIdByName)(foreignState, foreignKeyName);
                            if (!fKeyId) {
                                // Key was deleted; mark it for deletion
                                self.config.reactiveSet(state._volatile.pendingKeyRevocations, key.id, 'del');
                                hasOutOfSyncKeys = true;
                            }
                            else if (fKeyId !== key.id) {
                                // Key still needs to be rotated
                                self.config.reactiveSet(state._volatile.pendingKeyRevocations, key.id, true);
                                hasOutOfSyncKeys = true;
                            }
                        }
                    }
                }
                utils_js_1.keyAdditionProcessor.call(self, message, hash, updatedKeys, state, contractID, signingKey, internalSideEffectStack);
                // If we're able to rotate foreign keys and we need to, do so
                if (Number.isFinite(canMirrorOperationsUpToRingLevel) && hasOutOfSyncKeys) {
                    internalSideEffectStack?.push(() => {
                        (0, sbp_1.default)('chelonia/private/queueEvent', contractID, [
                            'chelonia/private/deleteOrRotateRevokedKeys',
                            contractID
                        ]).catch((e) => {
                            console.error(`Error at deleteOrRotateRevokedKeys for contractID ${contractID} at OP_KEY_UPDATE with ${hash}`, e);
                        });
                    });
                }
                // Check state._volatile.watch for contracts that should be
                // mirroring this operation
                if (Array.isArray(state._volatile?.watch)) {
                    const updatedKeysMap = Object.create(null);
                    updatedKeys.forEach((key) => {
                        if (key.data) {
                            updatedKeysMap[key.name] = (0, turtledash_1.cloneDeep)(key);
                            updatedKeysMap[key.name].oldKeyId = updatedMap[key.id];
                        }
                    });
                    keyRotationHelper(contractID, state, config, updatedKeysMap, [SPMessage_js_1.SPMessage.OP_KEY_UPDATE], 'chelonia/out/keyUpdate', (name) => ({
                        name: name[1],
                        oldKeyId: updatedKeysMap[name[0]].oldKeyId,
                        id: updatedKeysMap[name[0]].id,
                        data: updatedKeysMap[name[0]].data
                    }), internalSideEffectStack);
                }
            },
            [SPMessage_js_1.SPMessage.OP_PROTOCOL_UPGRADE]: notImplemented
        };
        if (!this.config.skipActionProcessing && !this.manifestToContract[manifestHash]) {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            // Having rootState.contracts[contractID] is not enough to determine we
            // have previously synced this contract, as reference counts are also
            // stored there. Hence, we check for the presence of 'type'
            if (!contractName) {
                contractName =
                    (0, turtledash_1.has)(rootState.contracts, contractID) &&
                        rootState.contracts[contractID] &&
                        (0, turtledash_1.has)(rootState.contracts[contractID], 'type')
                        ? rootState.contracts[contractID].type
                        : opT === SPMessage_js_1.SPMessage.OP_CONTRACT
                            ? opV.type
                            : '';
            }
            if (!contractName) {
                throw new Error(`Unable to determine the name for a contract and refusing to load it (contract ID was ${contractID} and its manifest hash was ${manifestHash})`);
            }
            await (0, sbp_1.default)('chelonia/private/loadManifest', contractName, manifestHash);
        }
        let processOp = true;
        if (config.preOp) {
            processOp = config.preOp(message, state) !== false && processOp;
        }
        let signingKey;
        // Signature verification
        {
            // This sync code has potential issues
            // The first issue is that it can deadlock if there are circular references
            // The second issue is that it doesn't handle key rotation. If the key used
            // for signing is invalidated / removed from the originating contract, we
            // won't have it in the state
            // Both of these issues can be resolved by introducing a parameter with the
            // message ID the state is based on. This requires implementing a separate,
            // ephemeral, state container for operations that refer to a different contract.
            // The difficulty of this is how to securely determine the message ID to use.
            // The server can assist with this.
            const stateForValidation = opT === SPMessage_js_1.SPMessage.OP_CONTRACT && !state?._vm?.authorizedKeys
                ? {
                    _vm: {
                        authorizedKeys: keysToMap.call(this, opV.keys, height, signingKeyId)
                    }
                }
                : state;
            // Verify that the signing key is found, has the correct purpose and is
            // allowed to sign this particular operation
            if (!(0, utils_js_1.validateKeyPermissions)(message, config, stateForValidation, signingKeyId, opT, opV)) {
                throw new Error(`No matching signing key was defined: ${signingKeyId} of ${hash} (${contractID})`);
            }
            signingKey = stateForValidation._vm.authorizedKeys[signingKeyId];
        }
        if (config[`preOp_${opT}`]) {
            processOp = config[`preOp_${opT}`](message, state) !== false && processOp;
        }
        if (processOp) {
            await opFns[opT](opV);
            (0, sbp_1.default)('chelonia/private/operationHook', contractID, message, state);
            config.postOp?.(message, state);
            config[`postOp_${opT}`]?.(message, state); // hack to fix syntax highlighting `
        }
    },
    'chelonia/private/in/enqueueHandleEvent': function (contractID, event) {
        // make sure handleEvent is called AFTER any currently-running invocations
        // to 'chelonia/private/out/sync', to prevent gi.db from throwing
        // "bad previousHEAD" errors
        return (0, sbp_1.default)('chelonia/private/queueEvent', contractID, async () => {
            await (0, sbp_1.default)('chelonia/private/in/handleEvent', contractID, event);
            // Before the next operation is enqueued, enqueue post sync ops. This
            // makes calling `/wait` more reliable
            (0, sbp_1.default)('chelonia/private/enqueuePostSyncOps', contractID);
        });
    },
    'chelonia/private/in/syncContract': async function (contractID, params) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        if (state.contracts[contractID] === null) {
            throw new errors_js_1.ChelErrorResourceGone('Cannot sync permanently deleted contract ' + contractID);
        }
        try {
            this.currentSyncs[contractID] = { firstSync: !state.contracts[contractID]?.type };
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACT_IS_SYNCING, contractID, true);
            const currentVolatileState = state[contractID]?._volatile || Object.create(null);
            // If the dirty flag is set (indicating that new encryption keys were received),
            // we remove the current state before syncing (this has the effect of syncing
            // from the beginning, recreating the entire state). When this is the case,
            // the _volatile state is preserved
            if (currentVolatileState?.dirty || params?.resync) {
                delete currentVolatileState.dirty;
                currentVolatileState.resyncing = true;
                (0, sbp_1.default)('chelonia/private/removeImmediately', contractID, { resync: true });
                this.config.reactiveSet(state, contractID, Object.create(null));
                this.config.reactiveSet(state[contractID], '_volatile', currentVolatileState);
            }
            const { HEAD: latestHEAD } = await (0, sbp_1.default)('chelonia/out/latestHEADInfo', contractID);
            console.debug(`[chelonia] syncContract: ${contractID} latestHash is: ${latestHEAD}`);
            // there is a chance two users are logged in to the same machine and must check their contracts before syncing
            const { HEAD: recentHEAD, height: recentHeight } = state.contracts[contractID] || {};
            const isSubscribed = this.subscriptionSet.has(contractID);
            if (!isSubscribed) {
                const entry = this.pending.find((entry) => entry?.contractID === contractID);
                // we're syncing a contract for the first time, make sure to add to pending
                // so that handleEvents knows to expect events from this contract
                if (!entry) {
                    this.pending.push({ contractID });
                }
            }
            this.postSyncOperations[contractID] =
                this.postSyncOperations[contractID] ?? Object.create(null);
            if (latestHEAD !== recentHEAD) {
                console.debug(`[chelonia] Synchronizing Contract ${contractID}: our recent was ${recentHEAD || 'undefined'} but the latest is ${latestHEAD}`);
                // TODO: fetch events from localStorage instead of server if we have them
                const eventsStream = (0, sbp_1.default)('chelonia/out/eventsAfter', contractID, {
                    sinceHeight: recentHeight ?? 0,
                    sinceHash: recentHEAD ?? contractID
                });
                // Sanity check: verify event with latest hash exists in list of events
                // TODO: using findLastIndex, it will be more clean but it needs Cypress 9.7+ which has bad performance
                //       https://docs.cypress.io/guides/references/changelog#9-7-0
                //       https://github.com/cypress-io/cypress/issues/22868
                let latestHashFound = false;
                const eventReader = eventsStream.getReader();
                // remove the first element in cases where we are not getting the contract for the first time
                for (let skip = (0, turtledash_1.has)(state.contracts, contractID) && (0, turtledash_1.has)(state.contracts[contractID], 'HEAD');; skip = false) {
                    const { done, value: event } = await eventReader.read();
                    if (done) {
                        if (!latestHashFound) {
                            throw new errors_js_1.ChelErrorForkedChain(`expected hash ${latestHEAD} in list of events for contract ${contractID}`);
                        }
                        break;
                    }
                    if (!latestHashFound) {
                        latestHashFound = SPMessage_js_1.SPMessage.deserializeHEAD(event).hash === latestHEAD;
                    }
                    if (skip)
                        continue;
                    // this must be called directly, instead of via enqueueHandleEvent
                    await (0, sbp_1.default)('chelonia/private/in/handleEvent', contractID, event);
                }
            }
            else if (!isSubscribed) {
                this.subscriptionSet.add(contractID);
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACTS_MODIFIED, Array.from(this.subscriptionSet), {
                    added: [contractID],
                    removed: []
                });
                const entryIndex = this.pending.findIndex((entry) => entry?.contractID === contractID);
                if (entryIndex !== -1) {
                    this.pending.splice(entryIndex, 1);
                }
                console.debug(`[chelonia] added already synchronized ${contractID} to subscription set`);
            }
            else {
                console.debug(`[chelonia] contract ${contractID} was already synchronized`);
            }
            // Do not await here as the post-sync ops might themselves might be
            // waiting on the same queue, causing a deadlock
            (0, sbp_1.default)('chelonia/private/enqueuePostSyncOps', contractID);
        }
        catch (e) {
            console.error(`[chelonia] syncContract error: ${e.message || e}`, e);
            this.config.hooks.syncContractError?.(e, contractID);
            throw e;
        }
        finally {
            if (state[contractID]?._volatile?.resyncing) {
                this.config.reactiveDel(state[contractID]._volatile, 'resyncing');
            }
            delete this.currentSyncs[contractID];
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACT_IS_SYNCING, contractID, false);
        }
    },
    'chelonia/private/enqueuePostSyncOps': function (contractID) {
        if (!(0, turtledash_1.has)(this.postSyncOperations, contractID))
            return;
        // Iterate over each post-sync operation associated with the given contractID.
        Object.entries(this.postSyncOperations[contractID]).forEach(([key, op]) => {
            // Remove the operation which is about to be handled so that subsequent
            // calls to this selector don't result in repeat calls to the post-sync op
            delete this.postSyncOperations[contractID][key];
            // Queue the current operation for execution.
            // Note that we do _not_ await because it could be unsafe to do so.
            // If the operation fails for some reason, just log the error.
            (0, sbp_1.default)('chelonia/private/queueEvent', contractID, op).catch((e) => {
                console.error(`Post-sync operation for ${contractID} failed`, { contractID, op, error: e });
            });
        });
    },
    'chelonia/private/watchForeignKeys': function (externalContractID) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const externalContractState = state[externalContractID];
        const pendingWatch = externalContractState?._vm?.pendingWatch;
        if (!pendingWatch || !Object.keys(pendingWatch).length)
            return;
        const signingKey = (0, utils_js_1.findSuitableSecretKeyId)(externalContractState, [SPMessage_js_1.SPMessage.OP_KEY_DEL], ['sig']);
        const canMirrorOperations = !!signingKey;
        // Only sync contract if we are actually able to mirror key operations
        // This avoids exponentially growing the number of contracts that we need
        // to be subscribed to.
        // Otherwise, every time there is a foreign key, we would subscribe to that
        // contract, plus the contracts referenced by the foreign keys of that
        // contract, plus those contracts referenced by the foreign keys of those
        // other contracts and so on.
        if (!canMirrorOperations) {
            console.info('[chelonia/private/watchForeignKeys]: Returning as operations cannot be mirrored', { externalContractID });
            return;
        }
        // For each pending watch operation, queue a synchronization event in the
        // respective contract queue
        Object.entries(pendingWatch).forEach(([contractID, keys]) => {
            if (!Array.isArray(keys) ||
                // Check that the keys exist and haven't been revoked
                !keys.some(([, id]) => {
                    return (0, turtledash_1.has)(externalContractState._vm.authorizedKeys, id);
                })) {
                console.info('[chelonia/private/watchForeignKeys]: Skipping as none of the keys to watch exist', {
                    externalContractID,
                    contractID
                });
                return;
            }
            (0, sbp_1.default)('chelonia/private/queueEvent', contractID, [
                'chelonia/private/in/syncContractAndWatchKeys',
                contractID,
                externalContractID
            ]).catch((e) => {
                console.error(`Error at syncContractAndWatchKeys for contractID ${contractID} and externalContractID ${externalContractID}`, e);
            });
        });
    },
    'chelonia/private/in/syncContractAndWatchKeys': async function (contractID, externalContractID) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const externalContractState = rootState[externalContractID];
        const pendingWatch = externalContractState?._vm?.pendingWatch?.[contractID]?.splice(0);
        // We duplicate the check in 'chelonia/private/watchForeignKeys' because
        // new events may have been received in the meantime. This avoids
        // unnecessarily subscribing to the contract
        if (!Array.isArray(pendingWatch) ||
            // Check that the keys exist and haven't been revoked
            !pendingWatch.some(([, id]) => {
                return ((0, turtledash_1.has)(externalContractState._vm.authorizedKeys, id) &&
                    (0, utils_js_1.findKeyIdByName)(externalContractState, externalContractState._vm.authorizedKeys[id].name) != null);
            })) {
            console.info('[chelonia/private/syncContractAndWatchKeys]: Skipping as none of the keys to watch exist', {
                externalContractID,
                contractID
            });
            return;
        }
        // We check this.subscriptionSet to see if we're already
        // subscribed to the contract; if not, we call sync.
        if (!this.subscriptionSet.has(contractID)) {
            await (0, sbp_1.default)('chelonia/private/in/syncContract', contractID);
        }
        const contractState = rootState[contractID];
        const keysToDelete = [];
        const keysToUpdate = [];
        pendingWatch.forEach(([keyName, externalId]) => {
            // Does the key exist? If not, it has probably been removed and instead
            // of waiting, we need to remove it ourselves
            const keyId = (0, utils_js_1.findKeyIdByName)(contractState, keyName);
            if (!keyId) {
                keysToDelete.push(externalId);
                return;
            }
            else if (keyId !== externalId) {
                // Or, the key has been updated and we need to update it in the external
                // contract as well
                keysToUpdate.push(externalId);
            }
            // Add keys to watchlist as another contract is waiting on these
            // operations
            if (!contractState._volatile) {
                this.config.reactiveSet(contractState, '_volatile', Object.create(null, {
                    watch: {
                        value: [[keyName, externalContractID]],
                        configurable: true,
                        enumerable: true,
                        writable: true
                    }
                }));
            }
            else {
                if (!contractState._volatile.watch) {
                    this.config.reactiveSet(contractState._volatile, 'watch', [
                        [keyName, externalContractID]
                    ]);
                }
                if (Array.isArray(contractState._volatile.watch) &&
                    !contractState._volatile.watch.find((v) => v[0] === keyName && v[1] === externalContractID)) {
                    contractState._volatile.watch.push([keyName, externalContractID]);
                }
            }
        });
        // If there are keys that need to be revoked, queue an event to handle the
        // deletion
        if (keysToDelete.length || keysToUpdate.length) {
            if (!externalContractState._volatile) {
                this.config.reactiveSet(externalContractState, '_volatile', Object.create(null));
            }
            if (!externalContractState._volatile.pendingKeyRevocations) {
                this.config.reactiveSet(externalContractState._volatile, 'pendingKeyRevocations', Object.create(null));
            }
            keysToDelete.forEach((id) => this.config.reactiveSet(externalContractState._volatile.pendingKeyRevocations, id, 'del'));
            keysToUpdate.forEach((id) => this.config.reactiveSet(externalContractState._volatile.pendingKeyRevocations, id, true));
            (0, sbp_1.default)('chelonia/private/queueEvent', externalContractID, [
                'chelonia/private/deleteOrRotateRevokedKeys',
                externalContractID
            ]).catch((e) => {
                console.error(`Error at deleteOrRotateRevokedKeys for contractID ${contractID} and externalContractID ${externalContractID}`, e);
            });
        }
    },
    // The following function gets called when we start watching a contract for
    // foreign keys for the first time, and it ensures that, at the point the
    // watching starts, keys are in sync between the two contracts (later on,
    // this will be handled automatically for incoming OP_KEY_DEL and
    // OP_KEY_UPDATE).
    // For any given foreign key, there are three possible states:
    //   1. The key is in sync with the foreign contract. In this case, there's
    //      nothing left to do.
    //   2. The key has been rotated in the foreign contract (replaced by another
    //      key of the same name). We need to mirror this operation manually
    //      since watching only affects new messages we receive.
    //   3. The key has been removed in the foreign contract. We also need to
    //      mirror the operation.
    'chelonia/private/deleteOrRotateRevokedKeys': function (contractID) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const contractState = rootState[contractID];
        const pendingKeyRevocations = contractState?._volatile?.pendingKeyRevocations;
        if (!pendingKeyRevocations || Object.keys(pendingKeyRevocations).length === 0)
            return;
        // Map of foreign keys to their ID (URI -> key id)
        const activeForeignKeyIds = Object.fromEntries(Object.values(contractState._vm.authorizedKeys)
            .filter(({ foreignKey, _notAfterHeight }) => foreignKey != null && _notAfterHeight == null)
            .map(({ foreignKey, id }) => [foreignKey, id]));
        // First, we handle keys that have been rotated
        const keysToUpdate = Object.entries(pendingKeyRevocations)
            .filter(([, v]) => v === true)
            .map(([id]) => id);
        // Set to prevent duplicates
        const affectedKeyIds = new Set();
        // Aggregate the keys that we can update to send them in a single operation
        const [, keyUpdateSigningKeyId, keyUpdateArgs] = keysToUpdate.reduce((acc, keyId) => {
            const pkrKey = contractState._vm?.authorizedKeys?.[keyId];
            if (!pkrKey || !pkrKey.foreignKey)
                return acc;
            const activeKeyId = activeForeignKeyIds[pkrKey.foreignKey];
            if (!activeKeyId)
                return acc;
            const key = contractState._vm.authorizedKeys[activeKeyId];
            if (affectedKeyIds.has(key.id))
                return acc;
            const foreignKey = String(key.foreignKey);
            const fkUrl = new URL(foreignKey);
            const foreignContractID = fkUrl.pathname;
            const foreignKeyName = fkUrl.searchParams.get('keyName');
            if (!foreignKeyName)
                throw new Error('Missing foreign key name');
            const foreignState = rootState[foreignContractID];
            if (!foreignState)
                return acc;
            const fKeyId = (0, utils_js_1.findKeyIdByName)(foreignState, foreignKeyName);
            if (!fKeyId) {
                // Key was deleted; mark it for deletion
                if (pendingKeyRevocations[keyId] === true) {
                    this.config.reactiveSet(pendingKeyRevocations, keyId, 'del');
                }
                return acc;
            }
            else if (fKeyId === key.id) {
                // Key has already been rotated
                this.config.reactiveDel(pendingKeyRevocations, keyId);
                return acc;
            }
            const [currentRingLevel, currentSigningKeyId, currentKeyArgs] = acc;
            const ringLevel = Math.min(currentRingLevel, key.ringLevel ?? Number.MAX_SAFE_INTEGER);
            if (ringLevel >= currentRingLevel) {
                affectedKeyIds.add(key.id);
                currentKeyArgs.push({
                    name: key.name,
                    oldKeyId: key.id,
                    id: fKeyId,
                    data: foreignState._vm.authorizedKeys[fKeyId].data
                });
                return [currentRingLevel, currentSigningKeyId, currentKeyArgs];
            }
            else if (Number.isFinite(ringLevel)) {
                const signingKeyId = (0, utils_js_1.findSuitableSecretKeyId)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_UPDATE], ['sig'], ringLevel);
                if (signingKeyId) {
                    affectedKeyIds.add(key.id);
                    currentKeyArgs.push({
                        name: key.name,
                        oldKeyId: key.id,
                        id: fKeyId,
                        data: foreignState._vm.authorizedKeys[fKeyId].data
                    });
                    return [ringLevel, signingKeyId, currentKeyArgs];
                }
            }
            return acc;
        }, [
            Number.POSITIVE_INFINITY,
            '',
            []
        ]);
        if (keyUpdateArgs.length !== 0) {
            const contractName = contractState._vm.type;
            // This is safe to do without await because it's sending an operation
            // Using await could deadlock when retrying to send the message
            (0, sbp_1.default)('chelonia/out/keyUpdate', {
                contractID,
                contractName,
                data: keyUpdateArgs,
                signingKeyId: keyUpdateSigningKeyId
            }).catch((e) => {
                console.error(`[chelonia/private/deleteOrRotateRevokedKeys] Error sending OP_KEY_UPDATE for ${contractID}`, e.message);
            });
        }
        // And then, we handle keys that have been deleted
        const keysToDelete = Object.entries(pendingKeyRevocations)
            .filter(([, v]) => v === 'del')
            .map(([id]) => id);
        // Aggregate the keys that we can delete to send them in a single operation
        const [, keyDelSigningKeyId, keyIdsToDelete] = keysToDelete.reduce((acc, pkrKeyId) => {
            const pkrKey = contractState._vm?.authorizedKeys?.[pkrKeyId];
            if (!pkrKey || !pkrKey.foreignKey)
                return acc;
            const keyId = activeForeignKeyIds[pkrKey.foreignKey];
            if (!keyId || affectedKeyIds.has(keyId))
                return acc;
            const [currentRingLevel, currentSigningKeyId, currentKeyIds] = acc;
            const ringLevel = Math.min(currentRingLevel, contractState._vm?.authorizedKeys?.[keyId]?.ringLevel ?? Number.MAX_SAFE_INTEGER);
            if (ringLevel >= currentRingLevel) {
                affectedKeyIds.add(keyId);
                currentKeyIds.push(keyId);
                return [currentRingLevel, currentSigningKeyId, currentKeyIds];
            }
            else if (Number.isFinite(ringLevel)) {
                const signingKeyId = (0, utils_js_1.findSuitableSecretKeyId)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_DEL], ['sig'], ringLevel);
                if (signingKeyId) {
                    affectedKeyIds.add(keyId);
                    currentKeyIds.push(keyId);
                    return [ringLevel, signingKeyId, currentKeyIds];
                }
            }
            return acc;
        }, [Number.POSITIVE_INFINITY, '', []]);
        if (keyIdsToDelete.length !== 0) {
            const contractName = contractState._vm.type;
            // This is safe to do without await because it's sending an operation
            // Using await could deadlock when retrying to send the message
            (0, sbp_1.default)('chelonia/out/keyDel', {
                contractID,
                contractName,
                data: keyIdsToDelete,
                signingKeyId: keyDelSigningKeyId
            }).catch((e) => {
                console.error(`[chelonia/private/deleteOrRotateRevokedKeys] Error sending OP_KEY_DEL for ${contractID}`, e.message);
            });
        }
    },
    'chelonia/private/respondToAllKeyRequests': function (contractID) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const contractState = (state[contractID] ?? { _vm: {} });
        const pending = contractState?._vm?.pendingKeyshares;
        if (!pending)
            return;
        const signingKeyId = (0, utils_js_1.findSuitableSecretKeyId)(contractState, [SPMessage_js_1.SPMessage.OP_ATOMIC, SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN, SPMessage_js_1.SPMessage.OP_KEY_SHARE], ['sig']);
        if (!signingKeyId) {
            console.log('Unable to respond to key request because there is no suitable secret key with OP_KEY_REQUEST_SEEN permission');
            return;
        }
        Object.entries(pending).map(([hash, entry]) => {
            if (!Array.isArray(entry) || (entry.length !== 4 && entry.length !== 7)) {
                return undefined;
            }
            const [, , , [originatingContractID]] = entry;
            return (0, sbp_1.default)('chelonia/private/queueEvent', originatingContractID, [
                'chelonia/private/respondToKeyRequest',
                contractID,
                signingKeyId,
                hash
            ]).catch((e) => {
                console.error(`respondToAllKeyRequests: Error responding to key request ${hash} from ${originatingContractID} to ${contractID}`, e);
            });
        });
    },
    'chelonia/private/respondToKeyRequest': async function (contractID, signingKeyId, hash) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const contractState = state[contractID];
        const entry = contractState?._vm?.pendingKeyshares?.[hash];
        const instance = this._instance;
        if (!Array.isArray(entry) || (entry.length !== 4 && entry.length !== 7) || (0, turtledash_1.has)(entry, 'processing')) {
            return;
        }
        // For `entry.length === 4` (kept for compatibility purposes, not used in
        // new entries), `request` and subsequent values will be undefined. This
        // is expected and should be handled.
        const [keyShareEncryption, height, inviteId, [originatingContractID, rv, originatingContractHeight, headJSON], request, manifestHash, requestedSkipInviteAccounting] = entry;
        // If the OP_KEY_REQUEST was encrypted, use an encrypted OP_KEY_REQUEST_SEEN
        const krsEncryption = keyShareEncryption;
        // 1. Sync (originating) identity contract
        await (0, sbp_1.default)('chelonia/private/in/syncContract', originatingContractID);
        if (instance !== this._instance)
            return;
        const originatingState = state[originatingContractID];
        const contractName = state.contracts[contractID].type;
        const originatingContractName = originatingState._vm.type;
        const v = (0, signedData_js_1.signedIncomingData)(originatingContractID, originatingState, rv, originatingContractHeight, headJSON).valueOf();
        // 2. Verify 'data'
        const { encryptionKeyId } = v;
        const responseKey = (0, encryptedData_js_1.encryptedIncomingData)(contractID, contractState, v.responseKey, height, this.transientSecretKeys, headJSON).valueOf();
        const deserializedResponseKey = (0, crypto_1.deserializeKey)(responseKey);
        const responseKeyId = (0, crypto_1.keyId)(deserializedResponseKey);
        // This is safe to do without await because it's sending actions
        // If we had await it could deadlock when retrying to send the event
        Promise.resolve()
            .then(async () => {
            if (instance !== this._instance)
                return;
            // Guard to prevent responding to this request multiple times
            // Note: there's a small time window where the previous check and this
            // could pass. This is for brevity (avoiding the same check multiple times)
            if ((0, turtledash_1.has)(entry, 'processing'))
                return;
            if (!contractState?._vm?.pendingKeyshares?.[hash]) {
                // While we were getting ready, another client may have shared the keys
                return;
            }
            // Using Object.defineProperty because it's not part of the type definition
            // and making `processing` part of the type definition seems to break type
            // inference
            Object.defineProperty(entry, 'processing', { configurable: true, value: true });
            if (!(0, turtledash_1.has)(originatingState._vm.authorizedKeys, responseKeyId) ||
                originatingState._vm.authorizedKeys[responseKeyId]._notAfterHeight != null) {
                throw new Error(`Unable to respond to key request for ${originatingContractID}. Key ${responseKeyId} is not valid.`);
            }
            // We don't need to worry about persistence (if it was an outgoing
            // message) here as this is done from an internal side-effect.
            (0, sbp_1.default)('chelonia/storeSecretKeys', new Secret_js_1.Secret([{ key: deserializedResponseKey }]));
            let keyIds;
            let skipInviteAccounting;
            // skipInviteAccounting isn't allowed to be `true` for these requests
            if (request == null || request === '*') {
                if (contractState._vm?.invites?.[inviteId]?.expires != null) {
                    if (contractState._vm.invites[inviteId].expires < Date.now()) {
                        console.error('[respondToKeyRequest] Ignoring OP_KEY_REQUEST because it expired at ' +
                            contractState._vm.invites[inviteId].expires +
                            ': ' +
                            originatingContractID);
                        return;
                    }
                }
                keyIds = Object.entries(contractState._vm.authorizedKeys)
                    .filter(([, key]) => !!key.meta?.private?.shareable)
                    .map(([kId]) => kId);
            }
            else if (manifestHash) {
                const contractName = this.manifestToContract[manifestHash]?.name;
                if (!contractName)
                    return;
                const method = `${manifestHash}/${contractName}/_responseOptionsForKeyRequest`;
                if ((0, sbp_1.default)('sbp/selectors/fn', method)) {
                    try {
                        const result = await (0, sbp_1.default)(method, {
                            contractID,
                            request,
                            state: contractState,
                            keyShareEncryption,
                            height,
                            inviteId,
                            originatingContractID,
                            originatingContractHeight
                        });
                        if (result) {
                            keyIds = result.keyIds;
                            skipInviteAccounting = result.skipInviteAccounting;
                        }
                    }
                    catch (e) {
                        console.warn('[respondToKeyRequest] Cannot respond: hook errored', {
                            contractID,
                            originatingContractID,
                            inviteId,
                            request,
                            e
                        });
                        return;
                    }
                }
                else {
                    console.warn('[respondToKeyRequest] Cannot respond: hook not defined', {
                        contractID,
                        originatingContractID,
                        inviteId,
                        request
                    });
                    return;
                }
            }
            if (!Array.isArray(keyIds)) {
                console.info('[respondToKeyRequest] no keys to share', {
                    contractID,
                    originatingContractID,
                    inviteId,
                    request
                });
                return;
            }
            else if (keyIds.length === 0) {
                // If the responder explicitly decided no keys are to be shared, mark
                // the request as successful, but without sharing any keys.
                console.info('[respondToKeyRequest] explicitly empty keyshare response', {
                    contractID,
                    originatingContractID,
                    inviteId,
                    request
                });
                return [null, skipInviteAccounting];
            }
            for (let i = 0; i < keyIds.length; i++) {
                if (!state.secretKeys[keyIds[i]]) {
                    console.info('[respondToKeyRequest] missing key id', {
                        contractID,
                        originatingContractID,
                        inviteId,
                        request,
                        keyId: keyIds[i]
                    });
                    return;
                }
            }
            const keySharePayload = {
                contractID,
                keys: keyIds.map((keyId) => ({
                    id: keyId,
                    meta: {
                        private: {
                            content: (0, encryptedData_js_1.encryptedOutgoingData)(originatingContractID, encryptionKeyId, state.secretKeys[keyId]),
                            shareable: true
                        }
                    }
                })),
                keyRequestHash: hash,
                keyRequestHeight: height
            };
            // 3. Send OP_KEY_SHARE to identity contract
            return [keySharePayload, skipInviteAccounting];
        })
            .then(async (value) => {
            if (instance !== this._instance || !value)
                return;
            const [keySharePayload, skipInviteAccounting] = value;
            if (!!requestedSkipInviteAccounting !== !!skipInviteAccounting) {
                console.error(`Error at respondToKeyRequest: mismatched result for skipInviteAccounting (${!!requestedSkipInviteAccounting} !== ${!!skipInviteAccounting}) for ${contractID}`);
                throw new Error('Mismatched skipInviteAccounting');
            }
            const msg = keySharePayload && await (0, sbp_1.default)('chelonia/out/keyShare', {
                contractID: originatingContractID,
                contractName: originatingContractName,
                data: keyShareEncryption
                    ? (0, encryptedData_js_1.encryptedOutgoingData)(originatingContractID, (0, utils_js_1.findSuitablePublicKeyIds)(originatingState, [SPMessage_js_1.SPMessage.OP_KEY_SHARE], ['enc'])?.[0] || '', keySharePayload)
                    : keySharePayload,
                signingKeyId: responseKeyId
            });
            if (instance !== this._instance)
                return;
            // 4(i). Remove originating contract and update current contract with information
            // If no keys were shared (empty array), we still mark success but without a hash
            // (undefined keyShareHash will be disregarded)
            const innerPayload = { keyShareHash: msg?.hash(), success: true };
            const connectionKeyPayload = {
                contractID: originatingContractID,
                keys: [
                    {
                        id: responseKeyId,
                        meta: {
                            private: {
                                content: (0, encryptedData_js_1.encryptedOutgoingData)(contractID, (0, utils_js_1.findSuitablePublicKeyIds)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN], ['enc'])?.[0] || '', responseKey),
                                shareable: true
                            }
                        }
                    }
                ]
            };
            // This is safe to do without await because it's sending an action
            // If we had await it could deadlock when retrying to send the event
            (0, sbp_1.default)('chelonia/out/atomic', {
                contractID,
                contractName,
                signingKeyId,
                data: [
                    [
                        'chelonia/out/keyRequestResponse',
                        {
                            data: {
                                keyRequestHash: hash,
                                skipInviteAccounting,
                                innerData: krsEncryption
                                    ? (0, encryptedData_js_1.encryptedOutgoingData)(contractID, (0, utils_js_1.findSuitablePublicKeyIds)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN], ['enc'])?.[0] || '', innerPayload)
                                    : innerPayload
                            }
                        }
                    ],
                    [
                        // Upon successful key share, we want to share deserializedResponseKey
                        // with ourselves
                        'chelonia/out/keyShare',
                        {
                            data: keyShareEncryption
                                ? (0, encryptedData_js_1.encryptedOutgoingData)(contractID, (0, utils_js_1.findSuitablePublicKeyIds)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_SHARE], ['enc'])?.[0] || '', connectionKeyPayload)
                                : connectionKeyPayload
                        }
                    ]
                ]
            }).catch((e) => {
                console.error('Error at respondToKeyRequest while sending keyRequestResponse', e);
            });
        })
            .catch((e) => {
            console.error('Error at respondToKeyRequest', e);
            const innerPayload = { success: false };
            // 4(ii). Remove originating contract and update current contract with information
            if (!contractState?._vm?.pendingKeyshares?.[hash]) {
                // While we were getting ready, another client may have shared the keys
                return;
            }
            // This is safe to do without await because it's sending an action
            // If we had await it could deadlock when retrying to send the event
            (0, sbp_1.default)('chelonia/out/keyRequestResponse', {
                contractID,
                contractName,
                signingKeyId,
                data: {
                    keyRequestHash: hash,
                    skipInviteAccounting: requestedSkipInviteAccounting,
                    innerData: krsEncryption
                        ? (0, encryptedData_js_1.encryptedOutgoingData)(contractID, (0, utils_js_1.findSuitablePublicKeyIds)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN], ['enc'])?.[0] || '', innerPayload)
                        : innerPayload
                }
            }).catch((e) => {
                console.error('Error at respondToKeyRequest while sending keyRequestResponse in error handler', e);
            });
        });
    },
    'chelonia/private/in/handleEvent': async function (contractID, rawMessage) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const { preHandleEvent, postHandleEvent, handleEventError } = this.config.hooks;
        let processingErrored = false;
        let message;
        // Errors in mutations result in ignored messages
        // Errors in side effects result in dropped messages to be reprocessed
        try {
            // verify we're expecting to hear from this contract
            if (!this.config.acceptAllMessages &&
                !this.pending.some((entry) => entry?.contractID === contractID) &&
                !this.subscriptionSet.has(contractID)) {
                console.warn(`[chelonia] WARN: ignoring unexpected event for ${contractID}:`, rawMessage);
                return;
            }
            // contractStateCopy has a copy of the current contract state, or an empty
            // object if the state doesn't exist. This copy will be used to apply
            // any changes from processing the current event as well as when calling
            // side-effects and, once everything is processed, it will be applied
            // to the global state. Important note: because the state change is
            // applied to the Vuex state only if process is successful (and after both
            // process and the sideEffect finish), any sideEffects that need to the
            // access the state should do so only through the state that is passed in
            // to the call to the sideEffect, or through a call though queueInvocation
            // (so that the side effect runs after the changes are applied)
            const contractStateCopy = state[contractID]
                ? (0, turtledash_1.cloneDeep)(state[contractID])
                : Object.create(null);
            // Now, deserialize the messsage
            // The message is deserialized *here* and not earlier because deserialize
            // constructs objects of signedIncomingData and encryptedIncomingData
            // which are bound to the state. For some opcodes (such as OP_ATOMIC), the
            // state could change in ways that are significant for further processing,
            // so those objects need to be bound to the state copy (which is mutated)
            // as opposed to the the root state (which is mutated only after
            // processing is done).
            // For instance, let's say the message contains an OP_ATOMIC comprising
            // two operations: OP_KEY_ADD (adding a signing key) and OP_ACTION_ENCRYPTED
            // (with an inner signature using this key in OP_KEY_ADD). If the state
            // is bound to the copy (as below), then by the time OP_ACTION_ENCRYPTED
            // is processed, the result of OP_KEY_ADD has been applied to the state
            // copy. If we didn't specify a state or instead grabbed it from the root
            // state, then we wouldn't be able to process OP_ACTION_ENCRYPTED correctly,
            // as we wouldn't know that the key is valid from that state, and the
            // state copy (contractStateCopy) is only written to the root state after
            // all processing has completed.
            message = SPMessage_js_1.SPMessage.deserialize(rawMessage, this.transientSecretKeys, contractStateCopy, this.config.unwrapMaybeEncryptedData);
            if (message.contractID() !== contractID) {
                throw new Error(`[chelonia] Wrong contract ID. Expected ${contractID} but got ${message.contractID()}`);
            }
            if (!message.isFirstMessage() &&
                (!(0, turtledash_1.has)(state.contracts, contractID) || !(0, turtledash_1.has)(state, contractID))) {
                throw new errors_js_1.ChelErrorUnrecoverable('The event is not for a first message but the contract state is missing');
            }
            preHandleEvent?.(message);
            // the order the following actions are done is critically important!
            // first we make sure we can save this message to the db
            // if an exception is thrown here we do not need to revert the state
            // because nothing has been processed yet
            const proceed = handleEvent.checkMessageOrdering.call(this, message);
            if (proceed === false)
                return;
            // If the contract was marked as dirty, we stop processing
            // The 'dirty' flag is set, possibly *by another contract*, indicating
            // that a previously unknown encryption key has been received. This means
            // that the current state is invalid (because it could changed based on
            // this new information) and we must re-sync the contract. When this
            // happens, we stop processing because the state will be regenerated.
            if (state[contractID]?._volatile?.dirty) {
                console.info(`[chelonia] Ignoring message ${message.description()} as the contract is marked as dirty`);
                return;
            }
            const internalSideEffectStack = !this.config.skipSideEffects
                ? []
                : undefined;
            // process the mutation on the state
            // IMPORTANT: even though we 'await' processMutation, everything in your
            //            contract's 'process' function must be synchronous! The only
            //            reason we 'await' here is to dynamically load any new contract
            //            source / definitions specified by the SPMessage
            missingDecryptionKeyIdsMap.delete(message);
            try {
                await handleEvent.processMutation.call(this, message, contractStateCopy, internalSideEffectStack);
            }
            catch (e_) {
                const e = e_;
                if (e?.name === 'ChelErrorDecryptionKeyNotFound') {
                    console.warn(`[chelonia] WARN '${e.name}' in processMutation for ${message.description()}: ${e.message}`, e, message.serialize());
                    if (e.cause) {
                        const missingDecryptionKeyIds = missingDecryptionKeyIdsMap.get(message);
                        if (missingDecryptionKeyIds) {
                            missingDecryptionKeyIds.add(e.cause);
                        }
                        else {
                            missingDecryptionKeyIdsMap.set(message, new Set([e.cause]));
                        }
                    }
                }
                else {
                    console.error(`[chelonia] ERROR '${e.name}' in processMutation for ${message.description()}: ${e.message || e}`, e, message.serialize());
                }
                // we revert any changes to the contract state that occurred, ignoring this mutation
                console.warn(`[chelonia] Error processing ${message.description()}: ${message.serialize()}. Any side effects will be skipped!`);
                if (this.config.strictProcessing) {
                    throw e;
                }
                processingErrored = e?.name !== 'ChelErrorWarning';
                this.config.hooks.processError?.(e, message, getMsgMeta.call(this, message, contractID, contractStateCopy));
                // special error that prevents the head from being updated, effectively killing the contract
                if (e.name === 'ChelErrorUnrecoverable' ||
                    e.name === 'ChelErrorForkedChain' ||
                    message.isFirstMessage()) {
                    throw e;
                }
            }
            // process any side-effects (these must never result in any mutation to the contract state!)
            if (!processingErrored) {
                // Gets run get when skipSideEffects is false
                if (Array.isArray(internalSideEffectStack) && internalSideEffectStack.length > 0) {
                    await Promise.all(internalSideEffectStack.map((fn) => Promise.resolve(fn({ state: contractStateCopy, message: message })).catch((e_) => {
                        const e = e_;
                        console.error(`[chelonia] ERROR '${e.name}' in internal side effect for ${message.description()}: ${e.message}`, e, { message: message.serialize() });
                    })));
                }
                if (!this.config.skipActionProcessing && !this.config.skipSideEffects) {
                    await handleEvent.processSideEffects
                        .call(this, message, contractStateCopy)
                        ?.catch((e_) => {
                        const e = e_;
                        console.error(`[chelonia] ERROR '${e.name}' in sideEffect for ${message.description()}: ${e.message}`, e, { message: message.serialize() });
                        // We used to revert the state and rethrow the error here, but we no longer do that
                        // see this issue for why: https://github.com/okTurtles/group-income/issues/1544
                        this.config.hooks.sideEffectError?.(e, message);
                    });
                }
            }
            // We keep changes to the contract state and state.contracts as close as
            // possible in the code to reduce the chances of still ending up with
            // an inconsistent state if a sudden failure happens while this code
            // is executing. In particular, everything in between should be synchronous.
            // This block will apply all the changes related to modifying the state
            // after an event has been processed:
            //   1. Adding the messge to the DB
            //   2. Applying changes to the contract state
            //   3. Applying changes to rootState.contracts
            try {
                const state = (0, sbp_1.default)(this.config.stateSelector);
                await handleEvent.applyProcessResult.call(this, {
                    message,
                    state,
                    contractState: contractStateCopy,
                    processingErrored,
                    postHandleEvent
                });
            }
            catch (e_) {
                const e = e_;
                console.error(`[chelonia] ERROR '${e.name}' for ${message.description()} marking the event as processed: ${e.message}`, e, { message: message.serialize() });
            }
        }
        catch (e_) {
            const e = e_;
            console.error(`[chelonia] ERROR in handleEvent: ${e.message || e}`, e);
            try {
                handleEventError?.(e, message);
            }
            catch (e2) {
                console.error('[chelonia] Ignoring user error in handleEventError hook:', e2);
            }
            throw e;
        }
        finally {
            if (message) {
                missingDecryptionKeyIdsMap.delete(message);
            }
        }
    }
});
const eventsToReingest = [];
const reprocessDebounced = (0, turtledash_1.debounce)((contractID) => (0, sbp_1.default)('chelonia/private/out/sync', contractID, { force: true }).catch((e) => {
    console.error(`[chelonia] Error at reprocessDebounced for ${contractID}`, e);
}), 1000);
const handleEvent = {
    checkMessageOrdering(message) {
        const contractID = message.contractID();
        const hash = message.hash();
        const height = message.height();
        const state = (0, sbp_1.default)(this.config.stateSelector);
        // The latest height we want to use is the one from `state.contracts` and
        // not the one from the DB. The height in the state reflects the latest
        // message that's been processed, which is desired here. On the other hand,
        // the DB function includes the latest known message for that contract,
        // which can be ahead of the latest message processed.
        const latestProcessedHeight = state.contracts[contractID]?.height;
        if (!Number.isSafeInteger(height)) {
            throw new errors_js_1.ChelErrorDBBadPreviousHEAD(`Message ${hash} in contract ${contractID} has an invalid height.`);
        }
        // Avoid re-processing already processed messages
        if (message.isFirstMessage()
            // If this is the first message, the height is is expected not to exist
            ? latestProcessedHeight != null
            // If this isn't the first message, the height must not be lower than the
            // current's message height. The check is negated to handle NaN values
            : !(latestProcessedHeight < height)) {
            // The web client may sometimes get repeated messages. If strict ordering
            // isn't enabled, instead of throwing we return false.
            // On the other hand, the server must enforce strict ordering.
            if (!this.config.strictOrdering) {
                return false;
            }
            throw new errors_js_1.ChelErrorAlreadyProcessed(`Message ${hash} with height ${height} in contract ${contractID} has already been processed. Current height: ${latestProcessedHeight}.`);
        }
        // If the message is from the future, add it to eventsToReingest
        if (latestProcessedHeight + 1 < height) {
            if (this.config.strictOrdering) {
                throw new errors_js_1.ChelErrorDBBadPreviousHEAD(`Unexpected message ${hash} with height ${height} in contract ${contractID}: height is too high. Current height: ${latestProcessedHeight}.`);
            }
            // sometimes we simply miss messages, it's not clear why, but it happens
            // in rare cases. So we attempt to re-sync this contract once
            if (eventsToReingest.length > 100) {
                throw new errors_js_1.ChelErrorUnrecoverable('more than 100 different bad previousHEAD errors');
            }
            if (!eventsToReingest.includes(hash)) {
                console.warn(`[chelonia] WARN bad previousHEAD for ${message.description()}, will attempt to re-sync contract to reingest message`);
                eventsToReingest.push(hash);
                reprocessDebounced(contractID);
                return false; // ignore the error for now
            }
            else {
                console.error(`[chelonia] ERROR already attempted to reingest ${message.description()}, will not attempt again!`);
                throw new errors_js_1.ChelErrorDBBadPreviousHEAD(`Already attempted to reingest ${hash}`);
            }
        }
        const reprocessIdx = eventsToReingest.indexOf(hash);
        if (reprocessIdx !== -1) {
            console.warn(`[chelonia] WARN: successfully reingested ${message.description()}`);
            eventsToReingest.splice(reprocessIdx, 1);
        }
    },
    async processMutation(message, state, internalSideEffectStack) {
        const contractID = message.contractID();
        if (message.isFirstMessage()) {
            // Allow having _volatile but nothing else if this is the first message,
            // as we should be starting off with a clean state
            if (Object.keys(state).some((k) => k !== '_volatile')) {
                throw new errors_js_1.ChelErrorUnrecoverable(`state for ${contractID} is already set`);
            }
        }
        await (0, sbp_1.default)('chelonia/private/in/processMessage', message, state, internalSideEffectStack);
    },
    processSideEffects(message, state) {
        const opT = message.opType();
        if (![
            SPMessage_js_1.SPMessage.OP_ATOMIC,
            SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED,
            SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED
        ].includes(opT)) {
            return;
        }
        const contractID = message.contractID();
        const manifestHash = message.manifest();
        const hash = message.hash();
        const height = message.height();
        const signingKeyId = message.signingKeyId();
        const callSideEffect = async (field) => {
            const wv = this.config.unwrapMaybeEncryptedData(field);
            if (!wv)
                return;
            let v = wv.data;
            let innerSigningKeyId;
            if ((0, signedData_js_1.isSignedData)(v)) {
                innerSigningKeyId = v.signingKeyId;
                v = v.valueOf();
            }
            const { action, data, meta } = v;
            const mutation = {
                data,
                meta,
                hash,
                height,
                contractID,
                description: message.description(),
                direction: message.direction(),
                signingKeyId,
                get signingContractID() {
                    return (0, utils_js_1.getContractIDfromKeyId)(contractID, signingKeyId, state);
                },
                innerSigningKeyId,
                get innerSigningContractID() {
                    return (0, utils_js_1.getContractIDfromKeyId)(contractID, innerSigningKeyId, state);
                }
            };
            return await (0, sbp_1.default)(`${manifestHash}/${action}/sideEffect`, mutation, state);
        };
        const msg = Object(message.message());
        if (opT !== SPMessage_js_1.SPMessage.OP_ATOMIC) {
            return callSideEffect(msg);
        }
        const reducer = (acc, [opT, opV]) => {
            if ([SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED, SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED].includes(opT)) {
                acc.push(Object(opV));
            }
            return acc;
        };
        const actionsOpV = msg.reduce(reducer, []);
        return Promise.allSettled(actionsOpV.map((action) => callSideEffect(action))).then((results) => {
            const errors = results
                .filter((r) => r.status === 'rejected')
                .map((r) => r.reason);
            if (errors.length > 0) {
                console.error('Side-effect errors', contractID, errors);
                throw new AggregateError(errors, `Error at side effects for ${contractID}`);
            }
        });
    },
    async applyProcessResult({ message, state, contractState, processingErrored, postHandleEvent }) {
        const contractID = message.contractID();
        const hash = message.hash();
        const height = message.height();
        await (0, sbp_1.default)('chelonia/db/addEntry', message);
        if (!processingErrored) {
            // Once side-effects are called, we apply changes to the state.
            // This means, as mentioned above, that retrieving the contract state
            // via the global state will yield incorrect results. Doing things in
            // this order ensures that incomplete processing of events (i.e., process
            // + side-effects), e.g., due to sudden failures (like power outages,
            // Internet being disconnected, etc.) aren't persisted. This allows
            // us to recover by re-processing the event when these sudden failures
            // happen
            this.config.reactiveSet(state, contractID, contractState);
            try {
                postHandleEvent?.(message);
            }
            catch (e) {
                console.error(`[chelonia] ERROR '${e.name}' for ${message.description()} in event post-handling: ${e.message}`, e, { message: message.serialize() });
            }
        }
        // whether or not there was an exception, we proceed ahead with updating the head
        // you can prevent this by throwing an exception in the processError hook
        if (message.isFirstMessage()) {
            const { type } = message.opValue();
            if (!(0, turtledash_1.has)(state.contracts, contractID)) {
                this.config.reactiveSet(state.contracts, contractID, Object.create(null));
            }
            this.config.reactiveSet(state.contracts[contractID], 'type', type);
            console.debug(`contract ${type} registered for ${contractID}`);
        }
        if (message.isKeyOp()) {
            this.config.reactiveSet(state.contracts[contractID], 'previousKeyOp', hash);
        }
        this.config.reactiveSet(state.contracts[contractID], 'HEAD', hash);
        this.config.reactiveSet(state.contracts[contractID], 'height', height);
        // If there were decryption errors due to missing encryption keys, we store
        // those key IDs. If those key IDs are later shared with us, we can re-sync
        // the contract. Without this information, we can only guess whether a
        // re-sync is needed or not.
        // We do it here because the property is stored under `.contracts` instead
        // of in the contract state itself, and this is where `.contracts` gets
        // updated after handling a message.
        const missingDecryptionKeyIdsForMessage = missingDecryptionKeyIdsMap.get(message);
        if (missingDecryptionKeyIdsForMessage) {
            let missingDecryptionKeyIds = state.contracts[contractID].missingDecryptionKeyIds;
            if (!missingDecryptionKeyIds) {
                missingDecryptionKeyIds = [];
                this.config.reactiveSet(state.contracts[contractID], 'missingDecryptionKeyIds', missingDecryptionKeyIds);
            }
            missingDecryptionKeyIdsForMessage.forEach((keyId) => {
                if (missingDecryptionKeyIds.includes(keyId))
                    return;
                missingDecryptionKeyIds.push(keyId);
            });
        }
        if (!this.subscriptionSet.has(contractID)) {
            const entry = this.pending.find((entry) => entry?.contractID === contractID);
            // we've successfully received it back, so remove it from expectation pending
            if (entry) {
                const index = this.pending.indexOf(entry);
                if (index !== -1) {
                    this.pending.splice(index, 1);
                }
            }
            this.subscriptionSet.add(contractID);
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACTS_MODIFIED, Array.from(this.subscriptionSet), {
                added: [contractID],
                removed: []
            });
        }
        if (!processingErrored) {
            (0, sbp_1.default)('okTurtles.events/emit', hash, contractID, message);
            (0, sbp_1.default)('okTurtles.events/emit', events_js_1.EVENT_HANDLED, contractID, message);
        }
    }
};
const notImplemented = (v) => {
    throw new Error(`chelonia: action not implemented to handle: ${JSON.stringify(v)}.`);
};
// The code below represents different ways to dynamically load code at runtime,
// and the SES example shows how to sandbox runtime loaded code (although it doesn't
// work, see https://github.com/endojs/endo/issues/1207 for details). It's also not
// super important since we're loaded signed contracts.
/*
// https://2ality.com/2019/10/eval-via-import.html
// Example: await import(esm`${source}`)
// const esm = ({ raw }, ...vals) => {
//   return URL.createObjectURL(new Blob([String.raw({ raw }, ...vals)], { type: 'text/javascript' }))
// }

// await loadScript.call(this, contractInfo.file, source, contractInfo.hash)
//   .then(x => {
//     console.debug(`loaded ${contractInfo.file}`)
//     return x
//   })
// eslint-disable-next-line no-unused-vars
function loadScript (file, source, hash) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    // script.type = 'application/javascript'
    script.type = 'module'
    // problem with this is that scripts will step on each other's feet
    script.text = source
    // NOTE: this will work if the file route adds .header('Content-Type', 'application/javascript')
    // script.src = `${this.config.connectionURL}/file/${hash}`
    // this results in: "SyntaxError: import declarations may only appear at top level of a module"
    // script.text = `(function () {
    //   ${source}
    // })()`
    script.onload = () => resolve(script)
    script.onerror = (err) => reject(new Error(`${err || 'Error'} trying to load: ${file}`))
    document.getElementsByTagName('head')[0].appendChild(script)
  })
}

// This code is cobbled together based on:
// https://github.com/endojs/endo/blob/master/packages/ses/test/test-import-cjs.js
// https://github.com/endojs/endo/blob/master/packages/ses/test/test-import.js
//   const vm = await sesImportVM.call(this, `${this.config.connectionURL}/file/${contractInfo.hash}`)
// eslint-disable-next-line no-unused-vars
function sesImportVM (url): Promise<Object> {
  // eslint-disable-next-line no-undef
  const vm = new Compartment(
    {
      ...this.config.contracts.defaults.exposedGlobals,
      console
    },
    {}, // module map
    {
      resolveHook (spec, referrer) {
        console.debug('resolveHook', { spec, referrer })
        return spec
      },
      // eslint-disable-next-line require-await
      async importHook (moduleSpecifier: string, ...args) {
        const source = await this.config.fetch(moduleSpecifier).then(handleFetchResult('text'))
        console.debug('importHook', { fetch: moduleSpecifier, args, source })
        const execute = (moduleExports, compartment, resolvedImports) => {
          console.debug('execute called with:', { moduleExports, resolvedImports })
          const functor = compartment.evaluate(
            `(function (require, exports, module, __filename, __dirname) { ${source} })`
            // this doesn't seem to help with: https://github.com/endojs/endo/issues/1207
            // { __evadeHtmlCommentTest__: false, __rejectSomeDirectEvalExpressions__: false }
          )
          const require_ = (importSpecifier) => {
            console.debug('in-source require called with:', importSpecifier, 'keying:', resolvedImports)
            const namespace = compartment.importNow(resolvedImports[importSpecifier])
            console.debug('got namespace:', namespace)
            return namespace.default === undefined ? namespace : namespace.default
          }
          const module_ = {
            get exports () {
              return moduleExports
            },
            set exports (newModuleExports) {
              moduleExports.default = newModuleExports
            }
          }
          functor(require_, moduleExports, module_, moduleSpecifier)
        }
        if (moduleSpecifier === '@common/common.cjs') {
          return {
            imports: [],
            exports: ['Vue', 'L'],
            execute
          }
        } else {
          return {
            imports: ['@common/common.cjs'],
            exports: [],
            execute
          }
        }
      }
    }
  )
  // vm.evaluate(source)
  return vm.import(url)
}
*/
