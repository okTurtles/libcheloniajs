"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTION_REGEX = exports.SPMessage = void 0;
require("@sbp/okturtles.eventqueue");
require("@sbp/okturtles.events");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const functions_js_1 = require("./functions.cjs");
const buffer_1 = require("buffer");
const index_js_1 = require("./pubsub/index.cjs");
const crypto_1 = require("@chelonia/crypto");
const errors_js_1 = require("./errors.cjs");
const events_js_1 = require("./events.cjs");
const SPMessage_js_1 = require("./SPMessage.cjs");
Object.defineProperty(exports, "SPMessage", { enumerable: true, get: function () { return SPMessage_js_1.SPMessage; } });
require("./chelonia-utils.cjs");
const encryptedData_js_1 = require("./encryptedData.cjs");
require("./files.cjs");
require("./internals.cjs");
const signedData_js_1 = require("./signedData.cjs");
require("./time-sync.cjs");
const utils_js_1 = require("./utils.cjs");
exports.ACTION_REGEX = /^((([\w.]+)\/([^/]+))(?:\/(?:([^/]+)\/)?)?)\w*/;
// ACTION_REGEX.exec('gi.contracts/group/payment/process')
// 0 => 'gi.contracts/group/payment/process'
// 1 => 'gi.contracts/group/payment/'
// 2 => 'gi.contracts/group'
// 3 => 'gi.contracts'
// 4 => 'group'
// 5 => 'payment'
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    // https://www.wordnik.com/words/chelonia
    // https://gitlab.okturtles.org/okturtles/group-income/-/wikis/E2E-Protocol/Framework.md#alt-names
    'chelonia/_init': function () {
        this.config = {
            // TODO: handle connecting to multiple servers for federation
            get connectionURL() {
                throw new Error('Invalid use of connectionURL before initialization');
            },
            // override!
            set connectionURL(value) {
                Object.defineProperty(this, 'connectionURL', { value, writable: true });
            },
            stateSelector: 'chelonia/private/state', // override to integrate with, for example, vuex
            contracts: {
                defaults: {
                    modules: {}, // '<module name>' => resolved module import
                    exposedGlobals: {},
                    allowedDomains: [],
                    allowedSelectors: [],
                    preferSlim: false
                },
                overrides: {}, // override default values per-contract
                manifests: {} // override! contract names => manifest hashes
            },
            whitelisted: (action) => !!this.whitelistedActions[action],
            reactiveSet: (obj, key, value) => {
                obj[key] = value;
                return value;
            }, // example: set to Vue.set
            fetch: (...args) => fetch(...args),
            reactiveDel: (obj, key) => {
                delete obj[key];
            },
            // acceptAllMessages disables checking whether we are expecting a message
            // or not for processing
            acceptAllMessages: false,
            skipActionProcessing: false,
            skipDecryptionAttempts: false,
            skipSideEffects: false,
            // Strict processing will treat all processing errors as unrecoverable
            // This is useful, e.g., in the server, to prevent invalid messages from
            // being added to the database
            strictProcessing: false,
            // Strict ordering will throw on past events with ChelErrorAlreadyProcessed
            // Similarly, future events will not be reingested and will throw
            // with ChelErrorDBBadPreviousHEAD
            strictOrdering: false,
            connectionOptions: {
                maxRetries: Infinity, // See https://github.com/okTurtles/group-income/issues/1183
                reconnectOnTimeout: true // can be enabled since we are not doing auth via web sockets
            },
            hooks: {
                preHandleEvent: null, // async (message: SPMessage) => {}
                postHandleEvent: null, // async (message: SPMessage) => {}
                processError: null, // (e: Error, message: SPMessage) => {}
                sideEffectError: null, // (e: Error, message: SPMessage) => {}
                handleEventError: null, // (e: Error, message: SPMessage) => {}
                syncContractError: null, // (e: Error, contractID: string) => {}
                pubsubError: null // (e:Error, socket: Socket)
            },
            unwrapMaybeEncryptedData: encryptedData_js_1.unwrapMaybeEncryptedData
        };
        // Used in publishEvent to cancel sending events after reset (logout)
        this._instance = Object.create(null);
        this.abortController = new AbortController();
        this.state = {
            contracts: {}, // contractIDs => { type, HEAD } (contracts we've subscribed to)
            pending: [] // prevents processing unexpected data from a malicious server
        };
        this.manifestToContract = {};
        this.whitelistedActions = {};
        this.currentSyncs = Object.create(null);
        this.postSyncOperations = Object.create(null);
        this.sideEffectStacks = Object.create(null); // [contractID]: Array<unknown>
        this.sideEffectStack = (contractID) => {
            let stack = this.sideEffectStacks[contractID];
            if (!stack) {
                this.sideEffectStacks[contractID] = stack = [];
            }
            return stack;
        };
        // setPostSyncOp defines operations to be run after all recent events have
        // been processed. This is useful, for example, when responding to
        // OP_KEY_REQUEST, as we want to send an OP_KEY_SHARE only to yet-unanswered
        // requests, which is information in the future (from the point of view of
        // the event handler).
        // We could directly enqueue the operations, but by using a map we avoid
        // enqueueing more operations than necessary
        // The operations defined here will be executed:
        //   (1) After a call to /sync or /syncContract; or
        //   (2) After an event has been handled, if it was received on a web socket
        this.setPostSyncOp = (contractID, key, op) => {
            this.postSyncOperations[contractID] =
                this.postSyncOperations[contractID] || Object.create(null);
            this.postSyncOperations[contractID][key] = op;
        };
        const secretKeyGetter = (o, p) => {
            if ((0, turtledash_1.has)(o, p))
                return o[p];
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            if (rootState?.secretKeys && (0, turtledash_1.has)(rootState.secretKeys, p)) {
                const key = (0, crypto_1.deserializeKey)(rootState.secretKeys[p]);
                o[p] = key;
                return key;
            }
        };
        const secretKeyList = (o) => {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            const stateKeys = Object.keys(rootState?.secretKeys || {});
            return Array.from(new Set([...Object.keys(o), ...stateKeys]));
        };
        this.transientSecretKeys = new Proxy(Object.create(null), {
            get: secretKeyGetter,
            ownKeys: secretKeyList
        });
        this.ephemeralReferenceCount = Object.create(null);
        // subscriptionSet includes all the contracts in state.contracts for which
        // we can process events (contracts for which we have called /sync)
        // The reason we can't use, e.g., Object.keys(state.contracts), is that
        // when resetting the state (calling /reset, e.g., after logging out) we may
        // still receive events for old contracts that belong to the old session.
        // Those events must be ignored or discarded until the new session is set up
        // (i.e., login has finished running) because we don't necessarily have
        // all the information needed to process events in those contracts, such as
        // secret keys.
        // A concrete example is:
        //   1. user1 logs in to the group and rotates the group keys, then logs out
        //   2. user2 logs in to the group.
        //   3. If an event came over the web socket for the group, we must not
        //      process it before we've processed the OP_KEY_SHARE containing the
        //      new keys, or else we'll build an incorrect state.
        // The example above is simplified, but this is even more of an issue
        // when there is a third contract (for example, a group chatroom) using
        // those rotated keys as foreign keys.
        this.subscriptionSet = new Set();
        // pending includes contracts that are scheduled for syncing or in the
        // process of syncing for the first time. After sync completes for the
        // first time, they are removed from pending and added to subscriptionSet
        this.pending = [];
    },
    'chelonia/config': function () {
        return {
            ...(0, turtledash_1.cloneDeep)(this.config),
            fetch: this.config.fetch,
            reactiveSet: this.config.reactiveSet,
            reactiveDel: this.config.reactiveDel
        };
    },
    'chelonia/configure': async function (config) {
        (0, turtledash_1.merge)(this.config, config);
        // merge will strip the hooks off of config.hooks when merging from the root of the object
        // because they are functions and cloneDeep doesn't clone functions
        Object.assign(this.config.hooks, config.hooks || {});
        // using Object.assign here instead of merge to avoid stripping away imported modules
        if (config.contracts) {
            Object.assign(this.config.contracts.defaults, config.contracts.defaults || {});
            const manifests = this.config.contracts.manifests;
            console.debug('[chelonia] preloading manifests:', Object.keys(manifests));
            for (const contractName in manifests) {
                await (0, sbp_1.default)('chelonia/private/loadManifest', contractName, manifests[contractName]);
            }
        }
        if ((0, turtledash_1.has)(config, 'skipDecryptionAttempts')) {
            if (config.skipDecryptionAttempts) {
                this.config.unwrapMaybeEncryptedData = (data) => {
                    if (data == null)
                        return;
                    if (!(0, encryptedData_js_1.isEncryptedData)(data)) {
                        return {
                            encryptionKeyId: null,
                            data
                        };
                    }
                };
            }
            else {
                this.config.unwrapMaybeEncryptedData = encryptedData_js_1.unwrapMaybeEncryptedData;
            }
        }
    },
    'chelonia/reset': async function (newState, postCleanupFn) {
        // Allow optional newState OR postCleanupFn
        if (typeof newState === 'function' && typeof postCleanupFn === 'undefined') {
            postCleanupFn = newState;
            newState = undefined;
        }
        if (this.pubsub) {
            (0, sbp_1.default)('chelonia/private/stopClockSync');
        }
        // wait for any pending sync operations to finish before saving
        Object.keys(this.postSyncOperations).forEach((cID) => {
            (0, sbp_1.default)('chelonia/private/enqueuePostSyncOps', cID);
        });
        await (0, sbp_1.default)('chelonia/contract/waitPublish');
        await (0, sbp_1.default)('chelonia/contract/wait');
        // do this again to catch operations that are the result of side-effects
        // or post sync ops
        Object.keys(this.postSyncOperations).forEach((cID) => {
            (0, sbp_1.default)('chelonia/private/enqueuePostSyncOps', cID);
        });
        await (0, sbp_1.default)('chelonia/contract/waitPublish');
        await (0, sbp_1.default)('chelonia/contract/wait');
        const result = await postCleanupFn?.();
        // The following are all synchronous operations
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        // Cancel all outgoing messages by replacing this._instance
        this._instance = Object.create(null);
        this.abortController.abort();
        this.abortController = new AbortController();
        // Remove all contracts, including all contracts from pending
        (0, utils_js_1.reactiveClearObject)(rootState, this.config.reactiveDel);
        this.config.reactiveSet(rootState, 'contracts', Object.create(null));
        (0, utils_js_1.clearObject)(this.ephemeralReferenceCount);
        this.pending.splice(0);
        (0, utils_js_1.clearObject)(this.currentSyncs);
        (0, utils_js_1.clearObject)(this.postSyncOperations);
        (0, utils_js_1.clearObject)(this.sideEffectStacks);
        const removedContractIDs = Array.from(this.subscriptionSet);
        this.subscriptionSet.clear();
        (0, sbp_1.default)('chelonia/clearTransientSecretKeys');
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CHELONIA_RESET);
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACTS_MODIFIED, Array.from(this.subscriptionSet), {
            added: [],
            removed: removedContractIDs
        });
        if (this.pubsub) {
            (0, sbp_1.default)('chelonia/private/startClockSync');
        }
        if (newState) {
            Object.entries(newState).forEach(([key, value]) => {
                this.config.reactiveSet(rootState, key, value);
            });
        }
        return result;
    },
    'chelonia/storeSecretKeys': function (wkeys) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (!rootState.secretKeys) {
            this.config.reactiveSet(rootState, 'secretKeys', Object.create(null));
        }
        let keys = wkeys.valueOf();
        if (!keys)
            return;
        if (!Array.isArray(keys))
            keys = [keys];
        keys.forEach(({ key, transient }) => {
            if (!key)
                return;
            if (typeof key === 'string') {
                key = (0, crypto_1.deserializeKey)(key);
            }
            const id = (0, crypto_1.keyId)(key);
            // Store transient keys transientSecretKeys
            if (!(0, turtledash_1.has)(this.transientSecretKeys, id)) {
                this.transientSecretKeys[id] = key;
            }
            if (transient)
                return;
            // If the key is marked as persistent, write it to the state as well
            if (!(0, turtledash_1.has)(rootState.secretKeys, id)) {
                this.config.reactiveSet(rootState.secretKeys, id, (0, crypto_1.serializeKey)(key, true));
            }
        });
    },
    'chelonia/clearTransientSecretKeys': function (ids) {
        if (Array.isArray(ids)) {
            ids.forEach((id) => {
                delete this.transientSecretKeys[id];
            });
        }
        else {
            Object.keys(this.transientSecretKeys).forEach((id) => {
                delete this.transientSecretKeys[id];
            });
        }
    },
    'chelonia/haveSecretKey': function (keyId, persistent) {
        if (!persistent && (0, turtledash_1.has)(this.transientSecretKeys, keyId))
            return true;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        return !!rootState?.secretKeys && (0, turtledash_1.has)(rootState.secretKeys, keyId);
    },
    'chelonia/contract/isResyncing': function (contractIDOrState) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        return (!!contractIDOrState?._volatile?.dirty ||
            !!contractIDOrState?._volatile?.resyncing);
    },
    'chelonia/contract/hasKeyShareBeenRespondedBy': function (contractIDOrState, requestedToContractID, reference) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const result = Object.values(contractIDOrState?._vm.authorizedKeys || {}).some((r) => {
            return (r?.meta?.keyRequest?.responded &&
                r.meta.keyRequest.contractID === requestedToContractID &&
                (!reference || r.meta.keyRequest.reference === reference));
        });
        return result;
    },
    'chelonia/contract/waitingForKeyShareTo': function (contractIDOrState, requestingContractID, reference) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const result = contractIDOrState._volatile?.pendingKeyRequests
            ?.filter((r) => {
            return (r &&
                (!requestingContractID || r.contractID === requestingContractID) &&
                (!reference || r.reference === reference));
        })
            ?.map(({ name }) => name);
        if (!result?.length)
            return null;
        return result;
    },
    'chelonia/contract/successfulKeySharesByContractID': function (contractIDOrState, requestingContractID) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const keyShares = Object.values(contractIDOrState._vm.keyshares || {});
        if (!keyShares?.length)
            return;
        const result = Object.create(null);
        keyShares.forEach((kS) => {
            if (!kS.success)
                return;
            if (requestingContractID && kS.contractID !== requestingContractID)
                return;
            if (!result[kS.contractID])
                result[kS.contractID] = [];
            result[kS.contractID].push({ height: kS.height, hash: kS.hash });
        });
        Object.keys(result).forEach((cID) => {
            result[cID].sort((a, b) => {
                return b.height - a.height;
            });
        });
        return result;
    },
    'chelonia/contract/hasKeysToPerformOperation': function (contractIDOrState, operation) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const op = operation !== '*' ? [operation] : operation;
        return !!(0, utils_js_1.findSuitableSecretKeyId)(contractIDOrState, op, ['sig']);
    },
    // Did sourceContractIDOrState receive an OP_KEY_SHARE to perform the given
    // operation on contractIDOrState?
    'chelonia/contract/receivedKeysToPerformOperation': function (sourceContractIDOrState, contractIDOrState, operation) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (typeof sourceContractIDOrState === 'string') {
            sourceContractIDOrState = rootState[sourceContractIDOrState];
        }
        if (typeof contractIDOrState === 'string') {
            contractIDOrState = rootState[contractIDOrState];
        }
        const op = operation !== '*' ? [operation] : operation;
        const keyId = (0, utils_js_1.findSuitableSecretKeyId)(contractIDOrState, op, ['sig']);
        return sourceContractIDOrState?._vm?.sharedKeyIds?.some((sK) => sK.id === keyId);
    },
    'chelonia/contract/currentKeyIdByName': function (contractIDOrState, name, requireSecretKey) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const currentKeyId = (0, utils_js_1.findKeyIdByName)(contractIDOrState, name);
        if (requireSecretKey && !(0, sbp_1.default)('chelonia/haveSecretKey', currentKeyId)) {
            return;
        }
        return currentKeyId;
    },
    'chelonia/contract/foreignKeysByContractID': function (contractIDOrState, foreignContractID) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        return (0, utils_js_1.findForeignKeysByContractID)(contractIDOrState, foreignContractID);
    },
    'chelonia/contract/historicalKeyIdsByName': function (contractIDOrState, name) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const currentKeyId = (0, utils_js_1.findKeyIdByName)(contractIDOrState, name);
        const revokedKeyIds = (0, utils_js_1.findRevokedKeyIdsByName)(contractIDOrState, name);
        return currentKeyId ? [currentKeyId, ...revokedKeyIds] : revokedKeyIds;
    },
    'chelonia/contract/suitableSigningKey': function (contractIDOrState, permissions, purposes, ringLevel, allowedActions) {
        if (typeof contractIDOrState === 'string') {
            const rootState = (0, sbp_1.default)(this.config.stateSelector);
            contractIDOrState = rootState[contractIDOrState];
        }
        const keyId = (0, utils_js_1.findSuitableSecretKeyId)(contractIDOrState, permissions, purposes, ringLevel, allowedActions);
        return keyId;
    },
    'chelonia/contract/setPendingKeyRevocation': function (contractID, names) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const state = rootState[contractID];
        if (!state._volatile)
            this.config.reactiveSet(state, '_volatile', Object.create(null));
        if (!state._volatile.pendingKeyRevocations) {
            this.config.reactiveSet(state._volatile, 'pendingKeyRevocations', Object.create(null));
        }
        for (const name of names) {
            const keyId = (0, utils_js_1.findKeyIdByName)(state, name);
            if (keyId) {
                this.config.reactiveSet(state._volatile.pendingKeyRevocations, keyId, true);
            }
            else {
                console.warn('[setPendingKeyRevocation] Unable to find keyId for name', {
                    contractID,
                    name
                });
            }
        }
    },
    'chelonia/shelterAuthorizationHeader'(contractID) {
        return utils_js_1.buildShelterAuthorizationHeader.call(this, contractID);
    },
    // The purpose of the 'chelonia/crypto/*' selectors is so that they can be called
    // from contracts without including the crypto code (i.e., importing crypto.js)
    // This function takes a function as a parameter that returns a string
    // It does not a string directly to prevent accidentally logging the value,
    // which is a secret
    'chelonia/crypto/keyId': (inKey) => {
        return (0, crypto_1.keyId)(inKey.valueOf());
    },
    // TODO: allow connecting to multiple servers at once
    'chelonia/connect': function (options = {}) {
        if (!this.config.connectionURL)
            throw new Error('config.connectionURL missing');
        if (!this.config.connectionOptions)
            throw new Error('config.connectionOptions missing');
        if (this.pubsub) {
            this.pubsub.destroy();
        }
        let pubsubURL = this.config.connectionURL;
        if (process.env.NODE_ENV === 'development') {
            // This is temporarily used in development mode to help the server improve
            // its console output until we have a better solution. Do not use for auth.
            pubsubURL += `?debugID=${(0, turtledash_1.randomHexString)(6)}`;
        }
        if (this.pubsub) {
            (0, sbp_1.default)('chelonia/private/stopClockSync');
        }
        (0, sbp_1.default)('chelonia/private/startClockSync');
        this.pubsub = (0, index_js_1.createClient)(pubsubURL, {
            ...this.config.connectionOptions,
            handlers: {
                ...options.handlers,
                // Every time we get a REQUEST_TYPE.SUB response, which happens for
                // 'new' subscriptions as well as every time the connection is reset
                'subscription-succeeded': function (event) {
                    const { channelID } = event.detail;
                    // The check below is needed because we could have unsubscribed since
                    // requesting a subscription from the server. In that case, we don't
                    // need to call `sync`.
                    if (this.subscriptionSet.has(channelID)) {
                        // For new subscriptions, some messages could have been lost
                        // between the time the subscription was requested and it was
                        // actually set up. In these cases, force sync contracts to get them
                        // updated.
                        (0, sbp_1.default)('chelonia/private/out/sync', channelID, { force: true }).catch((err) => {
                            console.warn(`[chelonia] Syncing contract ${channelID} failed: ${err.message}`);
                        });
                    }
                    options.handlers?.['subscription-succeeded']?.call(this, event);
                }
            },
            // Map message handlers to transparently handle encryption and signatures
            messageHandlers: {
                ...Object.fromEntries(Object.entries(options.messageHandlers || {}).map(([k, v]) => {
                    switch (k) {
                        case index_js_1.NOTIFICATION_TYPE.PUB:
                            return [
                                k,
                                (msg) => {
                                    if (!msg.channelID) {
                                        console.info('[chelonia] Discarding pub event without channelID');
                                        return;
                                    }
                                    if (!this.subscriptionSet.has(msg.channelID)) {
                                        console.info(`[chelonia] Discarding pub event for ${msg.channelID} because it's not in the current subscriptionSet`);
                                        return;
                                    }
                                    (0, sbp_1.default)('chelonia/queueInvocation', msg.channelID, () => {
                                        v.call(this.pubsub, parseEncryptedOrUnencryptedMessage(this, {
                                            contractID: msg.channelID,
                                            serializedData: msg.data
                                        }));
                                    }).catch((e) => {
                                        console.error(`[chelonia] Error processing pub event for ${msg.channelID}`, e);
                                    });
                                }
                            ];
                        case index_js_1.NOTIFICATION_TYPE.KV:
                            return [
                                k,
                                (msg) => {
                                    if (!msg.channelID || !msg.key) {
                                        console.info('[chelonia] Discarding kv event without channelID or key');
                                        return;
                                    }
                                    if (!this.subscriptionSet.has(msg.channelID)) {
                                        console.info(`[chelonia] Discarding kv event for ${msg.channelID} because it's not in the current subscriptionSet`);
                                        return;
                                    }
                                    (0, sbp_1.default)('chelonia/queueInvocation', msg.channelID, () => {
                                        v.call(this.pubsub, [
                                            msg.key,
                                            parseEncryptedOrUnencryptedMessage(this, {
                                                contractID: msg.channelID,
                                                meta: msg.key,
                                                serializedData: JSON.parse(buffer_1.Buffer.from(msg.data).toString())
                                            })
                                        ]);
                                    }).catch((e) => {
                                        console.error(`[chelonia] Error processing kv event for ${msg.channelID} and key ${msg.key}`, msg, e);
                                    });
                                }
                            ];
                        case index_js_1.NOTIFICATION_TYPE.DELETION:
                            return [
                                k,
                                (msg) => v.call(this.pubsub, msg.data)
                            ];
                        default:
                            return [k, v];
                    }
                })),
                [index_js_1.NOTIFICATION_TYPE.ENTRY](msg) {
                    // We MUST use 'chelonia/private/in/enqueueHandleEvent' to ensure handleEvent()
                    // is called AFTER any currently-running calls to 'chelonia/private/out/sync'
                    // to prevent gi.db from throwing "bad previousHEAD" errors.
                    // Calling via SBP also makes it simple to implement 'test/backend.cjs'
                    const { contractID } = SPMessage_js_1.SPMessage.deserializeHEAD(msg.data);
                    (0, sbp_1.default)('chelonia/private/in/enqueueHandleEvent', contractID, msg.data);
                }
            }
        });
        if (!this.contractsModifiedListener) {
            // Keep pubsub in sync (logged into the right "rooms") with 'state.contracts'
            this.contractsModifiedListener = () => (0, sbp_1.default)('chelonia/pubsub/update');
            (0, sbp_1.default)('okTurtles.events/on', events_js_1.CONTRACTS_MODIFIED, this.contractsModifiedListener);
        }
        return this.pubsub;
    },
    // This selector is defined primarily for ingesting web push notifications,
    // although it can be used as a general-purpose API to process events received
    // from other external sources that are not managed by Chelonia itself (i.e. sources
    // other than the Chelonia-managed websocket connection and RESTful API).
    'chelonia/handleEvent': async function (event) {
        const { contractID } = SPMessage_js_1.SPMessage.deserializeHEAD(event);
        return await (0, sbp_1.default)('chelonia/private/in/enqueueHandleEvent', contractID, event);
    },
    'chelonia/defineContract': function (contract) {
        if (!exports.ACTION_REGEX.exec(contract.name))
            throw new Error(`bad contract name: ${contract.name}`);
        if (!contract.metadata)
            contract.metadata = { validate() { }, create: () => ({}) };
        if (!contract.getters)
            contract.getters = {};
        contract.state = (contractID) => (0, sbp_1.default)(this.config.stateSelector)[contractID];
        contract.manifest = this.defContractManifest;
        contract.sbp = this.defContractSBP;
        this.defContractSelectors = [];
        this.defContract = contract;
        this.defContractSelectors.push(...(0, sbp_1.default)('sbp/selectors/register', {
            // expose getters for Vuex integration and other conveniences
            [`${contract.manifest}/${contract.name}/getters`]: () => contract.getters,
            // 2 ways to cause sideEffects to happen: by defining a sideEffect function in the
            // contract, or by calling /pushSideEffect w/async SBP call. Can also do both.
            [`${contract.manifest}/${contract.name}/pushSideEffect`]: (contractID, asyncSbpCall) => {
                // if this version of the contract is pushing a sideEffect to a function defined by the
                // contract itself, make sure that it calls the same version of the sideEffect
                const [sel] = asyncSbpCall;
                if (sel.startsWith(contract.name + '/')) {
                    asyncSbpCall[0] = `${contract.manifest}/${sel}`;
                }
                this.sideEffectStack(contractID).push(asyncSbpCall);
            }
        }));
        for (const action in contract.actions) {
            contractNameFromAction(action); // ensure actions are appropriately named
            this.whitelistedActions[action] = true;
            // TODO: automatically generate send actions here using `${action}/send`
            //       allow the specification of:
            //       - the optype (e.g. OP_ACTION_(UN)ENCRYPTED)
            //       - a localized error message
            //       - whatever keys should be passed in as well
            //       base it off of the design of encryptedAction()
            this.defContractSelectors.push(...(0, sbp_1.default)('sbp/selectors/register', {
                [`${contract.manifest}/${action}/process`]: async (message, state) => {
                    const { meta, data, contractID } = message;
                    // TODO: optimize so that you're creating a proxy object only when needed
                    // TODO: Note: when sandboxing contracts, contracts may not have
                    // access to the state directly, meaning that modifications would need
                    // to be re-applied
                    state = state || contract.state(contractID);
                    const gProxy = gettersProxy(state, contract.getters);
                    // These `await` are here to help with sandboxing in the future
                    // Sandboxing may mean that contracts are executed in another context
                    // (e.g., a worker), which would require asynchronous communication
                    // between Chelonia and the contract.
                    // Even though these are asynchronous calls, contracts should not
                    // call side effects from these functions
                    await contract.metadata.validate(meta, { state, ...gProxy, contractID });
                    await contract.actions[action].validate(data, {
                        state,
                        ...gProxy,
                        meta,
                        message,
                        contractID
                    });
                    // it's possible that the sideEffect stack got filled up by the call to `processMessage` from
                    // a call to `publishEvent` (when an outgoing message is being sent).
                    this.sideEffectStacks[contractID] = [];
                    await contract.actions[action].process(message, { state, ...gProxy });
                },
                // 'mutation' is an object that's similar to 'message', but not identical
                [`${contract.manifest}/${action}/sideEffect`]: async (mutation, state) => {
                    if (contract.actions[action].sideEffect) {
                        state = state || contract.state(mutation.contractID);
                        if (!state) {
                            console.warn(`[${contract.manifest}/${action}/sideEffect]: Skipping side-effect since there is no contract state for contract ${mutation.contractID}`);
                            return;
                        }
                        // TODO: Copy to simulate a sandbox boundary without direct access
                        // as well as to enforce the rule that side-effects must not mutate
                        // state
                        const stateCopy = (0, turtledash_1.cloneDeep)(state);
                        const gProxy = gettersProxy(stateCopy, contract.getters);
                        await contract.actions[action].sideEffect(mutation, { state: stateCopy, ...gProxy });
                    }
                    // since both /process and /sideEffect could call /pushSideEffect, we make sure
                    // to process the side effects on the stack after calling /sideEffect.
                    const sideEffects = this.sideEffectStack(mutation.contractID);
                    while (sideEffects.length > 0) {
                        const sideEffect = sideEffects.shift();
                        try {
                            await contract.sbp(...sideEffect);
                        }
                        catch (e_) {
                            const e = e_;
                            console.error(`[chelonia] ERROR: '${e.name}' ${e.message}, for pushed sideEffect of ${mutation.description}:`, sideEffect);
                            this.sideEffectStacks[mutation.contractID] = []; // clear the side effects
                            throw e;
                        }
                    }
                }
            }));
        }
        for (const method in contract.methods) {
            this.defContractSelectors.push(...(0, sbp_1.default)('sbp/selectors/register', {
                [`${contract.manifest}/${method}`]: contract.methods[method]
            }));
        }
        (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACT_REGISTERED, contract);
    },
    'chelonia/queueInvocation': (contractID, sbpInvocation) => {
        // We maintain two queues, contractID, used for internal events (i.e.,
        // from chelonia) and public:contractID, used for operations that need to
        // be done after all the current internal events (if any) have
        // finished processing.
        // Once all of the current internal events (in the contractID queue)
        // have completed, the operation requested is put into the public queue.
        // The reason for maintaining two different queues is to provide users
        // a way to run operations after internal operations have been processed
        // (for example, a side-effect might call queueInvocation to do work
        // after the current and future events have been processed), without the
        // work in these user-functions blocking Chelonia and prventing it from
        // processing events.
        // For example, a contract could have an action called
        // 'example/setProfilePicture'. The side-effect could look like this:
        //
        //    sideEffect ({ data, contractID }, { state }) {
        //      const profilePictureUrl = data.url
        //
        //      sbp('chelonia/queueInvocation', contractID, () => {
        //        const rootState = sbp('state/vuex/state')
        //        if  (rootState[contractID].profilePictureUrl !== profilePictureUrl)
        //          return // The profile picture changed, so we do nothing
        //
        //        // The following could take a long time. We want Chelonia
        //        // to still work and process events as normal.
        //        return this.config.fetch(profilePictureUrl).then(doSomeWorkWithTheFile)
        //      })
        //    }
        return (0, sbp_1.default)('chelonia/private/queueEvent', contractID, ['chelonia/private/noop']).then(() => (0, sbp_1.default)('chelonia/private/queueEvent', 'public:' + contractID, sbpInvocation));
    },
    'chelonia/begin': async (...invocations) => {
        for (const invocation of invocations) {
            await (0, sbp_1.default)(...invocation);
        }
    },
    // call this manually to resubscribe/unsubscribe from contracts as needed
    // if you are using a custom stateSelector and reload the state (e.g. upon login)
    'chelonia/pubsub/update': function () {
        const client = this.pubsub;
        const subscribedIDs = [...client.subscriptionSet];
        const currentIDs = Array.from(this.subscriptionSet);
        const leaveSubscribed = (0, turtledash_1.intersection)(subscribedIDs, currentIDs);
        const toUnsubscribe = (0, turtledash_1.difference)(subscribedIDs, leaveSubscribed);
        const toSubscribe = (0, turtledash_1.difference)(currentIDs, leaveSubscribed);
        // There is currently no need to tell other clients about our sub/unsubscriptions.
        try {
            for (const contractID of toUnsubscribe) {
                client.unsub(contractID);
            }
            for (const contractID of toSubscribe) {
                client.sub(contractID);
            }
        }
        catch (e) {
            console.error(`[chelonia] pubsub/update: error ${e.name}: ${e.message}`, { toUnsubscribe, toSubscribe }, e);
            this.config.hooks.pubsubError?.(e, client);
        }
    },
    // resolves when all pending actions for these contractID(s) finish
    'chelonia/contract/wait': function (contractIDs) {
        const listOfIds = contractIDs
            ? typeof contractIDs === 'string'
                ? [contractIDs]
                : contractIDs
            : Object.keys((0, sbp_1.default)(this.config.stateSelector).contracts);
        return Promise.all(listOfIds.flatMap((cID) => {
            return (0, sbp_1.default)('chelonia/queueInvocation', cID, ['chelonia/private/noop']);
        }));
    },
    // resolves when all pending *writes* for these contractID(s) finish
    'chelonia/contract/waitPublish': function (contractIDs) {
        const listOfIds = contractIDs
            ? typeof contractIDs === 'string'
                ? [contractIDs]
                : contractIDs
            : Object.keys((0, sbp_1.default)(this.config.stateSelector).contracts);
        return Promise.all(listOfIds.flatMap((cID) => {
            return (0, sbp_1.default)('chelonia/private/queueEvent', `publish:${cID}`, ['chelonia/private/noop']);
        }));
    },
    // 'chelonia/contract' - selectors related to injecting remote data and monitoring contracts
    // TODO: add an optional parameter to "retain" the contract (see #828)
    // eslint-disable-next-line require-await
    'chelonia/contract/sync': async function (contractIDs, params) {
        // The exposed `chelonia/contract/sync` selector is meant for users of
        // Chelonia and not for internal use within Chelonia.
        // It should only be called after `/retain` where needed (for example, when
        // starting up Chelonia with a saved state)
        const listOfIds = typeof contractIDs === 'string' ? [contractIDs] : contractIDs;
        // Verify that there's a valid reference count
        listOfIds.forEach((id) => {
            if (utils_js_1.checkCanBeGarbageCollected.call(this, id)) {
                if (process.env.CI) {
                    Promise.reject(new Error('[chelonia] Missing reference count for contract ' + id));
                }
                console.error('[chelonia] Missing reference count for contract ' + id);
                throw new Error('Missing reference count for contract');
            }
        });
        // Call the internal sync selector. `force` is always true as using `/sync`
        // besides internally is only needed to force sync a contract
        return (0, sbp_1.default)('chelonia/private/out/sync', listOfIds, { ...params, force: true });
    },
    'chelonia/contract/isSyncing': function (contractID, { firstSync = false } = {}) {
        const isSyncing = !!this.currentSyncs[contractID];
        return firstSync ? isSyncing && this.currentSyncs[contractID].firstSync : isSyncing;
    },
    'chelonia/contract/currentSyncs': function () {
        return Object.keys(this.currentSyncs);
    },
    // Because `/remove` is done asynchronously and a contract might be removed
    // much later than when the call to remove was made, an optional callback
    // can be passed to verify whether to proceed with removal. This is used as
    // part of the `/release` mechanism to prevent removing contracts that have
    // acquired new references since the call to `/remove`.
    'chelonia/contract/remove': function (contractIDs, { confirmRemovalCallback, permanent } = {}) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        const listOfIds = typeof contractIDs === 'string' ? [contractIDs] : contractIDs;
        return Promise.all(listOfIds.map((contractID) => {
            if (!rootState?.contracts?.[contractID]) {
                return undefined;
            }
            return (0, sbp_1.default)('chelonia/private/queueEvent', contractID, () => {
                // This allows us to double-check that the contract is meant to be
                // removed, as circumstances could have changed from the time remove
                // was called and this function is executed. For example, `/release`
                // makes a synchronous check, but processing of other events since
                // require this to be re-checked (in this case, for reference counts).
                if (confirmRemovalCallback && !confirmRemovalCallback(contractID)) {
                    return;
                }
                const rootState = (0, sbp_1.default)(this.config.stateSelector);
                const fkContractIDs = Array.from(new Set(Object.values(rootState[contractID]?._vm?.authorizedKeys ?? {})
                    .filter((k) => {
                    return !!k.foreignKey;
                })
                    .map((k) => {
                    try {
                        const fkUrl = new URL(k.foreignKey);
                        return fkUrl.pathname;
                    }
                    catch {
                        return undefined;
                    }
                })
                    .filter(Boolean)));
                (0, sbp_1.default)('chelonia/private/removeImmediately', contractID, { permanent });
                if (fkContractIDs.length) {
                    // Attempt to release all contracts that are being monitored for
                    // foreign keys
                    (0, sbp_1.default)('chelonia/contract/release', fkContractIDs, { try: true }).catch((e) => {
                        console.error('[chelonia] Error attempting to release foreign key contracts', e);
                    });
                }
            });
        }));
    },
    'chelonia/contract/retain': async function (contractIDs, params) {
        const listOfIds = typeof contractIDs === 'string' ? [contractIDs] : contractIDs;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (listOfIds.length === 0)
            return Promise.resolve();
        const checkIfDeleted = (id) => {
            // Contract has been permanently deleted
            if (rootState.contracts[id] === null) {
                console.error('[chelonia/contract/retain] Called /retain on permanently deleted contract.', id);
                throw new errors_js_1.ChelErrorResourceGone('Unable to retain permanently deleted contract ' + id);
            }
        };
        if (!params?.ephemeral) {
            listOfIds.forEach((id) => {
                checkIfDeleted(id);
                if (!(0, turtledash_1.has)(rootState.contracts, id)) {
                    this.config.reactiveSet(rootState.contracts, id, Object.create(null));
                }
                this.config.reactiveSet(rootState.contracts[id], 'references', (rootState.contracts[id].references ?? 0) + 1);
            });
        }
        else {
            listOfIds.forEach((id) => {
                checkIfDeleted(id);
                if (!(0, turtledash_1.has)(this.ephemeralReferenceCount, id)) {
                    this.ephemeralReferenceCount[id] = 1;
                }
                else {
                    this.ephemeralReferenceCount[id] = this.ephemeralReferenceCount[id] + 1;
                }
            });
        }
        return await (0, sbp_1.default)('chelonia/private/out/sync', listOfIds);
    },
    // the `try` parameter does not affect (ephemeral or persistent) reference
    // counts, but rather removes a contract if the reference count is zero
    // and the contract isn't being monitored for foreign keys. This parameter
    // is meant mostly for internal chelonia use, so that removing or releasing
    // a contract can also remove other contracts that this first contract
    // was monitoring.
    'chelonia/contract/release': async function (contractIDs, params) {
        const listOfIds = typeof contractIDs === 'string' ? [contractIDs] : contractIDs;
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (!params?.try) {
            if (!params?.ephemeral) {
                listOfIds.forEach((id) => {
                    // Contract has been permanently deleted
                    if (rootState.contracts[id] === null) {
                        console.warn('[chelonia/contract/release] Called /release on permanently deleted contract. This has no effect.', id);
                        return;
                    }
                    if ((0, turtledash_1.has)(rootState.contracts, id) && (0, turtledash_1.has)(rootState.contracts[id], 'references')) {
                        const current = rootState.contracts[id].references;
                        if (current === 0) {
                            console.error('[chelonia/contract/release] Invalid negative reference count for', id);
                            if (process.env.CI) {
                                // If running in CI, force tests to fail
                                Promise.reject(new Error('Invalid negative reference count: ' + id));
                            }
                            throw new Error('Invalid negative reference count');
                        }
                        if (current <= 1) {
                            this.config.reactiveDel(rootState.contracts[id], 'references');
                        }
                        else {
                            this.config.reactiveSet(rootState.contracts[id], 'references', current - 1);
                        }
                    }
                    else {
                        console.error('[chelonia/contract/release] Invalid negative reference count for', id);
                        if (process.env.CI) {
                            // If running in CI, force tests to fail
                            Promise.reject(new Error('Invalid negative reference count: ' + id));
                        }
                        throw new Error('Invalid negative reference count');
                    }
                });
            }
            else {
                listOfIds.forEach((id) => {
                    // Contract has been permanently deleted
                    if (rootState.contracts[id] === null) {
                        console.warn('[chelonia/contract/release] Called /release on permanently deleted contract. This has no effect.', id);
                        return;
                    }
                    if ((0, turtledash_1.has)(this.ephemeralReferenceCount, id)) {
                        const current = this.ephemeralReferenceCount[id] ?? 0;
                        if (current <= 1) {
                            delete this.ephemeralReferenceCount[id];
                        }
                        else {
                            this.ephemeralReferenceCount[id] = current - 1;
                        }
                    }
                    else {
                        console.error('[chelonia/contract/release] Invalid negative ephemeral reference count for', id);
                        if (process.env.CI) {
                            // If running in CI, force tests to fail
                            Promise.reject(new Error('Invalid negative ephemeral reference count: ' + id));
                        }
                        throw new Error('Invalid negative ephemeral reference count');
                    }
                });
            }
        }
        // This function will be called twice. The first time, it provides a list of
        // candidate contracts to remove. The second time, it confirms that the
        // contract is safe to remove
        const boundCheckCanBeGarbageCollected = utils_js_1.checkCanBeGarbageCollected.bind(this);
        const idsToRemove = listOfIds.filter(boundCheckCanBeGarbageCollected);
        return idsToRemove.length
            ? await (0, sbp_1.default)('chelonia/contract/remove', idsToRemove, {
                confirmRemovalCallback: boundCheckCanBeGarbageCollected
            })
            : undefined;
    },
    'chelonia/contract/disconnect': async function (contractID, contractIDToDisconnect) {
        const state = (0, sbp_1.default)(this.config.stateSelector);
        const contractState = state[contractID];
        const keyIds = Object.values(contractState._vm.authorizedKeys)
            .filter((k) => {
            return (k._notAfterHeight == null && k.meta?.keyRequest?.contractID === contractIDToDisconnect);
        })
            .map((k) => k.id);
        if (!keyIds.length)
            return;
        return await (0, sbp_1.default)('chelonia/out/keyDel', {
            contractID,
            contractName: contractState._vm.type,
            data: keyIds,
            signingKeyId: (0, utils_js_1.findSuitableSecretKeyId)(contractState, [SPMessage_js_1.SPMessage.OP_KEY_DEL], ['sig'])
        });
    },
    'chelonia/in/processMessage': function (messageOrRawMessage, state) {
        const stateCopy = (0, turtledash_1.cloneDeep)(state);
        const message = typeof messageOrRawMessage === 'string'
            ? SPMessage_js_1.SPMessage.deserialize(messageOrRawMessage, this.transientSecretKeys, stateCopy, this.config.unwrapMaybeEncryptedData)
            : messageOrRawMessage;
        return (0, sbp_1.default)('chelonia/private/in/processMessage', message, stateCopy)
            .then(() => stateCopy)
            .catch((e) => {
            console.warn(`chelonia/in/processMessage: reverting mutation ${message.description()}: ${message.serialize()}`, e);
            return state;
        });
    },
    'chelonia/out/fetchResource': async function (cid, { code } = {}) {
        const parsedCID = (0, functions_js_1.parseCID)(cid);
        if (code != null) {
            if (parsedCID.code !== code) {
                throw new Error(`Invalid CID content type. Expected ${code}, got ${parsedCID.code}`);
            }
        }
        // Note that chelonia.db/get (set) is a no-op for lightweight clients
        // This was added for consistency (processing an event also adds it to the DB)
        const local = await (0, sbp_1.default)('chelonia.db/get', cid);
        // We don't verify the CID because it's already been verified when it was set
        if (local != null)
            return local;
        const url = `${this.config.connectionURL}/file/${cid}`;
        const data = (await this.config
            .fetch(url, { signal: this.abortController.signal })
            .then((0, utils_js_1.handleFetchResult)('text')));
        const ourHash = (0, functions_js_1.createCID)(data, parsedCID.code);
        if (ourHash !== cid) {
            throw new Error(`expected hash ${cid}. Got: ${ourHash}`);
        }
        await (0, sbp_1.default)('chelonia.db/set', cid, data);
        return data;
    },
    'chelonia/out/latestHEADInfo': function (contractID) {
        return this.config
            .fetch(`${this.config.connectionURL}/latestHEADinfo/${contractID}`, {
            cache: 'no-store',
            signal: this.abortController.signal
        })
            .then((0, utils_js_1.handleFetchResult)('json'));
    },
    'chelonia/out/eventsAfter': utils_js_1.eventsAfter,
    'chelonia/out/eventsBefore': function (contractID, { beforeHeight, limit, stream }) {
        if (limit <= 0) {
            console.error('[chelonia] invalid params error: "limit" needs to be positive integer');
        }
        const offset = Math.max(0, beforeHeight - limit + 1);
        const eventsAfterLimit = Math.min(beforeHeight + 1, limit);
        return (0, sbp_1.default)('chelonia/out/eventsAfter', contractID, {
            sinceHeight: offset,
            limit: eventsAfterLimit,
            stream
        });
    },
    'chelonia/out/eventsBetween': function (contractID, { startHash, endHeight, offset = 0, limit = 0, stream = true }) {
        if (offset < 0) {
            console.error('[chelonia] invalid params error: "offset" needs to be positive integer or zero');
            return;
        }
        let reader;
        const s = new ReadableStream({
            start: async (controller) => {
                const first = (await this.config
                    .fetch(`${this.config.connectionURL}/file/${startHash}`, {
                    signal: this.abortController.signal
                })
                    .then((0, utils_js_1.handleFetchResult)('text')));
                const deserializedHEAD = SPMessage_js_1.SPMessage.deserializeHEAD(first);
                if (deserializedHEAD.contractID !== contractID) {
                    controller.error(new Error('chelonia/out/eventsBetween: Mismatched contract ID'));
                    return;
                }
                const startOffset = Math.max(0, deserializedHEAD.head.height - offset);
                const ourLimit = limit
                    ? Math.min(endHeight - startOffset + 1, limit)
                    : endHeight - startOffset + 1;
                if (ourLimit < 1) {
                    controller.close();
                    return;
                }
                reader = (0, sbp_1.default)('chelonia/out/eventsAfter', contractID, {
                    sinceHeight: startOffset,
                    limit: ourLimit
                }).getReader();
            },
            async pull(controller) {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                }
                else {
                    controller.enqueue(value);
                }
            }
        });
        if (stream)
            return s;
        // Workaround for <https://bugs.webkit.org/show_bug.cgi?id=215485>
        return (0, utils_js_1.collectEventStream)(s);
    },
    'chelonia/rootState': function () {
        return (0, sbp_1.default)(this.config.stateSelector);
    },
    'chelonia/latestContractState': async function (contractID, options = { forceSync: false }) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        // return a copy of the state if we already have it, unless the only key that's in it is _volatile,
        // in which case it means we should sync the contract to get more info.
        if (rootState.contracts[contractID] === null) {
            throw new errors_js_1.ChelErrorResourceGone('Permanently deleted contract ' + contractID);
        }
        if (!options.forceSync &&
            rootState[contractID] &&
            Object.keys(rootState[contractID]).some((x) => x !== '_volatile')) {
            return (0, turtledash_1.cloneDeep)(rootState[contractID]);
        }
        let state = Object.create(null);
        let contractName = rootState.contracts[contractID]?.type;
        const eventsStream = (0, sbp_1.default)('chelonia/out/eventsAfter', contractID, {
            sinceHeight: 0,
            sinceHash: contractID
        });
        const eventsStreamReader = eventsStream.getReader();
        if (rootState[contractID])
            state._volatile = rootState[contractID]._volatile;
        for (;;) {
            const { value: event, done } = await eventsStreamReader.read();
            if (done)
                return state;
            const stateCopy = (0, turtledash_1.cloneDeep)(state);
            try {
                await (0, sbp_1.default)('chelonia/private/in/processMessage', SPMessage_js_1.SPMessage.deserialize(event, this.transientSecretKeys, state, this.config.unwrapMaybeEncryptedData), state, undefined, contractName);
                if (!contractName && state._vm) {
                    contractName = state._vm.type;
                }
            }
            catch (e) {
                console.warn(`[chelonia] latestContractState: '${e.name}': ${e.message} processing:`, event, e.stack);
                if (e instanceof errors_js_1.ChelErrorUnrecoverable)
                    throw e;
                state = stateCopy;
            }
        }
    },
    'chelonia/contract/state': function (contractID, height) {
        const state = (0, sbp_1.default)(this.config.stateSelector)[contractID];
        const stateCopy = state && (0, turtledash_1.cloneDeep)(state);
        if (stateCopy?._vm && height != null) {
            // Remove keys in the future
            Object.keys(stateCopy._vm.authorizedKeys).forEach((keyId) => {
                if (stateCopy._vm.authorizedKeys[keyId]._notBeforeHeight > height) {
                    delete stateCopy._vm.authorizedKeys[keyId];
                }
            });
        }
        return stateCopy;
    },
    'chelonia/contract/fullState': function (contractID) {
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        if (Array.isArray(contractID)) {
            return Object.fromEntries(contractID.map((contractID) => {
                return [
                    contractID,
                    {
                        contractState: rootState[contractID],
                        cheloniaState: rootState.contracts[contractID]
                    }
                ];
            }));
        }
        return {
            contractState: rootState[contractID],
            cheloniaState: rootState.contracts[contractID]
        };
    },
    // 'chelonia/out' - selectors that send data out to the server
    'chelonia/out/registerContract': async function (params) {
        const { contractName, keys, hooks, publishOptions, signingKeyId, actionSigningKeyId, actionEncryptionKeyId } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contractInfo = this.manifestToContract[manifestHash];
        if (!contractInfo)
            throw new Error(`contract not defined: ${contractName}`);
        const signingKey = this.transientSecretKeys[signingKeyId];
        if (!signingKey)
            throw new Error(`Signing key ${signingKeyId} is not defined`);
        const payload = {
            type: contractName,
            keys
        };
        const contractMsg = SPMessage_js_1.SPMessage.createV1_0({
            contractID: null,
            height: 0,
            op: [
                SPMessage_js_1.SPMessage.OP_CONTRACT,
                (0, signedData_js_1.signedOutgoingDataWithRawKey)(signingKey, payload)
            ],
            manifest: manifestHash
        });
        const contractID = contractMsg.hash();
        await (0, sbp_1.default)('chelonia/private/out/publishEvent', contractMsg, params.namespaceRegistration
            ? {
                ...publishOptions,
                headers: {
                    ...publishOptions?.headers,
                    'shelter-namespace-registration': params.namespaceRegistration
                }
            }
            : publishOptions, hooks && {
            prepublish: hooks.prepublishContract,
            postpublish: hooks.postpublishContract
        });
        await (0, sbp_1.default)('chelonia/private/out/sync', contractID);
        const msg = await (0, sbp_1.default)(actionEncryptionKeyId ? 'chelonia/out/actionEncrypted' : 'chelonia/out/actionUnencrypted', {
            action: contractName,
            contractID,
            data: params.data,
            signingKeyId: actionSigningKeyId ?? signingKeyId,
            encryptionKeyId: actionEncryptionKeyId,
            hooks,
            publishOptions
        });
        return msg;
    },
    'chelonia/out/ownResources': async function (contractID) {
        if (!contractID) {
            throw new TypeError('A contract ID must be provided');
        }
        const response = await this.config.fetch(`${this.config.connectionURL}/ownResources`, {
            method: 'GET',
            signal: this.abortController.signal,
            headers: new Headers([
                ['authorization', utils_js_1.buildShelterAuthorizationHeader.call(this, contractID)]
            ])
        });
        if (!response.ok) {
            console.error('Unable to fetch own resources', contractID, response.status);
            throw new Error(`Unable to fetch own resources for ${contractID}: ${response.status}`);
        }
        return response.json();
    },
    'chelonia/out/deleteContract': async function (contractID, credentials = {}) {
        if (!contractID) {
            throw new TypeError('A contract ID must be provided');
        }
        if (!Array.isArray(contractID))
            contractID = [contractID];
        return await Promise.allSettled(contractID.map(async (cid) => {
            const hasCredential = (0, turtledash_1.has)(credentials, cid);
            const hasToken = (0, turtledash_1.has)(credentials[cid], 'token') && credentials[cid].token;
            const hasBillableContractID = (0, turtledash_1.has)(credentials[cid], 'billableContractID') && credentials[cid].billableContractID;
            if (!hasCredential || hasToken === hasBillableContractID) {
                throw new TypeError(`Either a token or a billable contract ID must be provided for ${cid}`);
            }
            const response = await this.config.fetch(`${this.config.connectionURL}/deleteContract/${cid}`, {
                method: 'POST',
                signal: this.abortController.signal,
                headers: new Headers([
                    [
                        'authorization',
                        hasToken
                            ? `bearer ${credentials[cid].token.valueOf()}`
                            : utils_js_1.buildShelterAuthorizationHeader.call(this, credentials[cid].billableContractID)
                    ]
                ])
            });
            if (!response.ok) {
                if (response.status === 404 || response.status === 410) {
                    console.warn('Contract appears to have been deleted already', cid, response.status);
                    return;
                }
                console.error('Unable to delete contract', cid, response.status);
                throw new Error(`Unable to delete contract ${cid}: ${response.status}`);
            }
        }));
    },
    // all of these functions will do both the creation of the SPMessage
    // and the sending of it via 'chelonia/private/out/publishEvent'
    'chelonia/out/actionEncrypted': function (params) {
        return outEncryptedOrUnencryptedAction.call(this, SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED, params);
    },
    'chelonia/out/actionUnencrypted': function (params) {
        return outEncryptedOrUnencryptedAction.call(this, SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED, params);
    },
    'chelonia/out/keyShare': async function (params) {
        const { atomic, originatingContractName, originatingContractID, contractName, contractID, data, hooks, publishOptions } = params;
        const originatingManifestHash = this.config.contracts.manifests[originatingContractName];
        const destinationManifestHash = this.config.contracts.manifests[contractName];
        const originatingContract = originatingContractID
            ? this.manifestToContract[originatingManifestHash]?.contract
            : undefined;
        const destinationContract = this.manifestToContract[destinationManifestHash]?.contract;
        if ((originatingContractID && !originatingContract) || !destinationContract) {
            throw new Error('Contract name not found');
        }
        const payload = data;
        if (!params.signingKeyId && !params.signingKey) {
            throw new TypeError('Either signingKeyId or signingKey must be specified');
        }
        let msg = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_KEY_SHARE,
                params.signingKeyId
                    ? (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
                    : (0, signedData_js_1.signedOutgoingDataWithRawKey)(params.signingKey, payload)
            ],
            manifest: destinationManifestHash
        });
        if (!atomic) {
            msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, hooks);
        }
        return msg;
    },
    'chelonia/out/keyAdd': async function (params) {
        // TODO: For foreign keys, recalculate the key id
        // TODO: Make this a noop if the key already exsits with the given permissions
        const { atomic, contractID, contractName, data, hooks, publishOptions } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const state = contract.state(contractID);
        const payload = params.skipExistingKeyCheck
            ? data
            : data.filter((wk) => {
                const k = ((0, encryptedData_js_1.isEncryptedData)(wk) ? wk.valueOf() : wk);
                if ((0, turtledash_1.has)(state._vm.authorizedKeys, k.id)) {
                    if (state._vm.authorizedKeys[k.id]._notAfterHeight == null) {
                        // Can't add a key that exists
                        return false;
                    }
                }
                return true;
            });
        if (payload.length === 0)
            return;
        let msg = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_KEY_ADD,
                (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
            ],
            manifest: manifestHash
        });
        if (!atomic) {
            msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, hooks);
        }
        return msg;
    },
    'chelonia/out/keyDel': async function (params) {
        const { atomic, contractID, contractName, data, hooks, publishOptions } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const state = contract.state(contractID);
        const payload = data
            .map((keyId) => {
            if ((0, encryptedData_js_1.isEncryptedData)(keyId))
                return keyId;
            if (!(0, turtledash_1.has)(state._vm.authorizedKeys, keyId) ||
                state._vm.authorizedKeys[keyId]._notAfterHeight != null) {
                return undefined;
            }
            if (state._vm.authorizedKeys[keyId]._private) {
                return (0, encryptedData_js_1.encryptedOutgoingData)(contractID, state._vm.authorizedKeys[keyId]._private, keyId);
            }
            else {
                return keyId;
            }
        })
            .filter(Boolean);
        let msg = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_KEY_DEL,
                (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
            ],
            manifest: manifestHash
        });
        if (!atomic) {
            msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, hooks);
        }
        return msg;
    },
    'chelonia/out/keyUpdate': async function (params) {
        const { atomic, contractID, contractName, data, hooks, publishOptions } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const state = contract.state(contractID);
        const payload = data.map((key) => {
            if ((0, encryptedData_js_1.isEncryptedData)(key))
                return key;
            const { oldKeyId } = key;
            if (state._vm.authorizedKeys[oldKeyId]._private) {
                return (0, encryptedData_js_1.encryptedOutgoingData)(contractID, state._vm.authorizedKeys[oldKeyId]._private, key);
            }
            else {
                return key;
            }
        });
        let msg = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_KEY_UPDATE,
                (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
            ],
            manifest: manifestHash
        });
        if (!atomic) {
            msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, hooks);
        }
        return msg;
    },
    'chelonia/out/keyRequest': async function (params) {
        const { originatingContractID, originatingContractName, contractID, contractName, hooks, publishOptions, innerSigningKeyId, encryptionKeyId, innerEncryptionKeyId, encryptKeyRequestMetadata, reference } = params;
        // `encryptKeyRequestMetadata` is optional because it could be desirable
        // sometimes to allow anyone to audit OP_KEY_REQUEST and OP_KEY_SHARE
        // operations. If `encryptKeyRequestMetadata` were always true, it would
        // be harder in these situations to see interactions between two contracts.
        const manifestHash = this.config.contracts.manifests[contractName];
        const originatingManifestHash = this.config.contracts.manifests[originatingContractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        const originatingContract = this.manifestToContract[originatingManifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const rootState = (0, sbp_1.default)(this.config.stateSelector);
        try {
            await (0, sbp_1.default)('chelonia/contract/retain', contractID, { ephemeral: true });
            const state = contract.state(contractID);
            const originatingState = originatingContract.state(originatingContractID);
            const havePendingKeyRequest = Object.values(originatingState._vm.authorizedKeys).findIndex((k) => {
                return (k._notAfterHeight == null &&
                    k.meta?.keyRequest?.contractID === contractID &&
                    state?._volatile?.pendingKeyRequests?.some((pkr) => pkr.name === k.name));
            }) !== -1;
            // If there's a pending key request for this contract, return
            if (havePendingKeyRequest) {
                return;
            }
            const keyRequestReplyKey = (0, crypto_1.keygen)(crypto_1.EDWARDS25519SHA512BATCH);
            const keyRequestReplyKeyId = (0, crypto_1.keyId)(keyRequestReplyKey);
            const keyRequestReplyKeyP = (0, crypto_1.serializeKey)(keyRequestReplyKey, false);
            const keyRequestReplyKeyS = (0, crypto_1.serializeKey)(keyRequestReplyKey, true);
            const signingKeyId = (0, utils_js_1.findSuitableSecretKeyId)(originatingState, [SPMessage_js_1.SPMessage.OP_KEY_ADD], ['sig']);
            if (!signingKeyId) {
                throw new errors_js_1.ChelErrorUnexpected(`Unable to send key request. Originating contract is missing a key with OP_KEY_ADD permission. contractID=${contractID} originatingContractID=${originatingContractID}`);
            }
            const keyAddOp = () => (0, sbp_1.default)('chelonia/out/keyAdd', {
                contractID: originatingContractID,
                contractName: originatingContractName,
                data: [
                    {
                        id: keyRequestReplyKeyId,
                        name: '#krrk-' + keyRequestReplyKeyId,
                        purpose: ['sig'],
                        ringLevel: Number.MAX_SAFE_INTEGER,
                        permissions: params.permissions === '*'
                            ? '*'
                            : Array.isArray(params.permissions)
                                ? [...params.permissions, SPMessage_js_1.SPMessage.OP_KEY_SHARE]
                                : [SPMessage_js_1.SPMessage.OP_KEY_SHARE],
                        allowedActions: params.allowedActions,
                        meta: {
                            private: {
                                content: (0, encryptedData_js_1.encryptedOutgoingData)(originatingContractID, encryptionKeyId, keyRequestReplyKeyS),
                                shareable: false
                            },
                            keyRequest: {
                                ...(reference && {
                                    reference: encryptKeyRequestMetadata
                                        ? (0, encryptedData_js_1.encryptedOutgoingData)(originatingContractID, encryptionKeyId, reference)
                                        : reference
                                }),
                                contractID: encryptKeyRequestMetadata
                                    ? (0, encryptedData_js_1.encryptedOutgoingData)(originatingContractID, encryptionKeyId, contractID)
                                    : contractID
                            }
                        },
                        data: keyRequestReplyKeyP
                    }
                ],
                signingKeyId
            }).catch((e) => {
                console.error(`[chelonia] Error sending OP_KEY_ADD for ${originatingContractID} during key request to ${contractID}`, e);
                throw e;
            });
            const payload = {
                contractID: originatingContractID,
                height: rootState.contracts[originatingContractID].height,
                replyWith: (0, signedData_js_1.signedOutgoingData)(originatingContractID, innerSigningKeyId, {
                    encryptionKeyId,
                    responseKey: (0, encryptedData_js_1.encryptedOutgoingData)(contractID, innerEncryptionKeyId, keyRequestReplyKeyS)
                }, this.transientSecretKeys),
                request: '*'
            };
            let msg = SPMessage_js_1.SPMessage.createV1_0({
                contractID,
                op: [
                    SPMessage_js_1.SPMessage.OP_KEY_REQUEST,
                    (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, encryptKeyRequestMetadata
                        ? (0, encryptedData_js_1.encryptedOutgoingData)(contractID, innerEncryptionKeyId, payload)
                        : payload, this.transientSecretKeys)
                ],
                manifest: manifestHash
            });
            msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, {
                ...hooks,
                // We ensure that both messages are placed into the publish queue
                prepublish: (...args) => {
                    return keyAddOp().then(() => hooks?.prepublish?.(...args));
                }
            });
            return msg;
        }
        finally {
            await (0, sbp_1.default)('chelonia/contract/release', contractID, { ephemeral: true });
        }
    },
    'chelonia/out/keyRequestResponse': async function (params) {
        const { atomic, contractID, contractName, data, hooks, publishOptions } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const payload = data;
        let message = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_KEY_REQUEST_SEEN,
                (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
            ],
            manifest: manifestHash
        });
        if (!atomic) {
            message = await (0, sbp_1.default)('chelonia/private/out/publishEvent', message, publishOptions, hooks);
        }
        return message;
    },
    'chelonia/out/atomic': async function (params) {
        const { contractID, contractName, data, hooks, publishOptions } = params;
        const manifestHash = this.config.contracts.manifests[contractName];
        const contract = this.manifestToContract[manifestHash]?.contract;
        if (!contract) {
            throw new Error('Contract name not found');
        }
        const payload = (await Promise.all(data.map(([selector, opParams]) => {
            if (![
                'chelonia/out/actionEncrypted',
                'chelonia/out/actionUnencrypted',
                'chelonia/out/keyAdd',
                'chelonia/out/keyDel',
                'chelonia/out/keyUpdate',
                'chelonia/out/keyRequestResponse',
                'chelonia/out/keyShare'
            ].includes(selector)) {
                throw new Error('Selector not allowed in OP_ATOMIC: ' + selector);
            }
            return (0, sbp_1.default)(selector, {
                ...opParams,
                ...params,
                data: opParams.data,
                atomic: true
            });
        })))
            .flat()
            .filter(Boolean)
            .map((msg) => {
            return [msg.opType(), msg.opValue()];
        });
        let msg = SPMessage_js_1.SPMessage.createV1_0({
            contractID,
            op: [
                SPMessage_js_1.SPMessage.OP_ATOMIC,
                (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
            ],
            manifest: manifestHash
        });
        msg = await (0, sbp_1.default)('chelonia/private/out/publishEvent', msg, publishOptions, hooks);
        return msg;
    },
    'chelonia/out/protocolUpgrade': async function () { },
    'chelonia/out/propSet': async function () { },
    'chelonia/out/propDel': async function () { },
    'chelonia/out/encryptedOrUnencryptedPubMessage': function ({ contractID, innerSigningKeyId, encryptionKeyId, signingKeyId, data }) {
        const serializedData = outputEncryptedOrUnencryptedMessage.call(this, {
            contractID,
            innerSigningKeyId,
            encryptionKeyId,
            signingKeyId,
            data
        });
        this.pubsub.pub(contractID, serializedData);
    },
    // Note: This is a bare-bones function designed for precise control. In many
    // situations, the `chelonia/kv/queuedSet` selector (in chelonia-utils.js)
    // will be simpler and more appropriate to use.
    // In most situations, you want to use some queuing strategy (which this
    // selector doesn't provide) alongside writing to the KV store. Therefore, as
    // a general rule, you shouldn't be calling this selector directly unless
    // you're building a utility library or if you have very specific needs. In
    // this case, see if `chelonia/kv/queuedSet` covers your needs.
    // `data` is allowed to be falsy, in which case a fetch will occur first and
    // the `onconflict` handler will be called.
    'chelonia/kv/set': async function (contractID, key, data, { ifMatch, innerSigningKeyId, encryptionKeyId, signingKeyId, maxAttempts, onconflict }) {
        maxAttempts = maxAttempts ?? 3;
        const url = `${this.config.connectionURL}/kv/${encodeURIComponent(contractID)}/${encodeURIComponent(key)}`;
        const hasOnconflict = typeof onconflict === 'function';
        let response;
        // The `resolveData` function is tasked with computing merged data, as in
        // merging the existing stored values (after a conflict or initial fetch)
        // and new data. The return value indicates whether there should be a new
        // attempt at storing updated data (if `true`) or not (if `false`)
        const resolveData = async () => {
            let currentValue;
            // Rationale:
            //  * response.ok could be the result of `GET` (no initial data)
            //  * 409 indicates a conflict because the height used is too old
            //  * 412 indicates a conflict (precondition failed) because the data
            //    on the KV store have been updated / is not what we expected
            // All of these situations should trigger parsing the respinse and
            // conlict resolution
            if (response.ok || response.status === 409 || response.status === 412) {
                const serializedDataText = await response.text();
                // We can get 409 even if there's no data on the server. We still need
                // to call `onconflict` in this case, but we don't need to attempt to
                // parse the response.
                // This prevents this from failing in such cases, which can result in
                // race conditions and data not being properly initialised.
                // See <https://github.com/okTurtles/group-income/issues/2780>
                currentValue = serializedDataText
                    ? parseEncryptedOrUnencryptedMessage(this, {
                        contractID,
                        serializedData: JSON.parse(serializedDataText),
                        meta: key
                    })
                    : undefined;
                // Rationale: 404 and 410 both indicate that the store key doesn't exist.
                // These are not treated as errors since we could still set the value.
            }
            else if (response.status !== 404 && response.status !== 410) {
                throw new errors_js_1.ChelErrorUnexpectedHttpResponseCode('[kv/set] Invalid response code: ' + response.status);
            }
            const result = await onconflict({
                contractID,
                key,
                failedData: data,
                status: response.status,
                // If no x-cid or etag header was returned, `ifMatch` would likely be
                // returned as undefined, which will then use the `''` fallback value
                // when writing. This allows 404 / 410 responses to work even if no
                // etag is explicitly given
                etag: response.headers.get('x-cid') || response.headers.get('etag'),
                get currentData() {
                    return currentValue?.data;
                },
                currentValue
            });
            if (!result)
                return false;
            data = result[0];
            ifMatch = result[1];
            return true;
        };
        for (;;) {
            if (data !== undefined) {
                const serializedData = outputEncryptedOrUnencryptedMessage.call(this, {
                    contractID,
                    innerSigningKeyId,
                    encryptionKeyId,
                    signingKeyId,
                    data: data,
                    meta: key
                });
                response = await this.config.fetch(url, {
                    headers: new Headers([
                        ['authorization', utils_js_1.buildShelterAuthorizationHeader.call(this, contractID)],
                        ['if-match', ifMatch || '""']
                    ]),
                    method: 'POST',
                    body: JSON.stringify(serializedData),
                    signal: this.abortController.signal
                });
            }
            else {
                if (!hasOnconflict) {
                    throw TypeError('onconflict required with empty data');
                }
                // If no initial data provided, perform a GET `fetch` to get the current
                // data and CID. Then, `onconflict` will be used to merge the current
                // and new data.
                response = await this.config.fetch(url, {
                    headers: new Headers([
                        ['authorization', utils_js_1.buildShelterAuthorizationHeader.call(this, contractID)]
                    ]),
                    signal: this.abortController.signal
                });
                // This is only for the initial case; the logic is replicated below
                // for subsequent iterations that require conflic resolution.
                if (await resolveData()) {
                    continue;
                }
                else {
                    break;
                }
            }
            if (!response.ok) {
                // Rationale: 409 and 412 indicate conflict resolution is needed
                if (response.status === 409 || response.status === 412) {
                    if (--maxAttempts <= 0) {
                        throw new Error('kv/set conflict setting KV value');
                    }
                    // Only retry if an onconflict handler exists to potentially resolve it
                    await (0, turtledash_1.delay)((0, turtledash_1.randomIntFromRange)(0, 1500));
                    if (hasOnconflict) {
                        if (await resolveData()) {
                            continue;
                        }
                        else {
                            break;
                        }
                    }
                    else {
                        // Can't resolve automatically if there's no conflict handler
                        throw new Error(`kv/set failed with status ${response.status} and no onconflict handler was provided`);
                    }
                }
                throw new errors_js_1.ChelErrorUnexpectedHttpResponseCode('kv/set invalid response status: ' + response.status);
            }
            break;
        }
    },
    'chelonia/kv/get': async function (contractID, key) {
        const response = await this.config.fetch(`${this.config.connectionURL}/kv/${encodeURIComponent(contractID)}/${encodeURIComponent(key)}`, {
            headers: new Headers([
                ['authorization', utils_js_1.buildShelterAuthorizationHeader.call(this, contractID)]
            ]),
            signal: this.abortController.signal
        });
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error('Invalid response status: ' + response.status);
        }
        const data = await response.json();
        return parseEncryptedOrUnencryptedMessage(this, {
            contractID,
            serializedData: data,
            meta: key
        });
    },
    // To set filters for a contract, call with `filter` set to an array of KV
    // keys to receive updates for over the WebSocket. An empty array means that
    // no KV updates will be sent.
    // Calling with a single argument (the contract ID) will remove filters,
    // meaning that KV updates will be sent for _any_ KV key.
    // The last call takes precedence, so, for example, calling with filter
    // set to `['foo', 'bar']` and then with `['baz']` means that KV updates will
    // be received for `baz` only, not for `foo`, `bar` or any other keys.
    'chelonia/kv/setFilter': function (contractID, filter) {
        this.pubsub.setKvFilter(contractID, filter);
    },
    'chelonia/parseEncryptedOrUnencryptedDetachedMessage': function ({ contractID, serializedData, meta }) {
        return parseEncryptedOrUnencryptedMessage(this, {
            contractID,
            serializedData,
            meta
        });
    }
});
function contractNameFromAction(action) {
    const regexResult = exports.ACTION_REGEX.exec(action);
    const contractName = regexResult?.[2];
    if (!contractName)
        throw new Error(`Poorly named action '${action}': missing contract name.`);
    return contractName;
}
function outputEncryptedOrUnencryptedMessage({ contractID, innerSigningKeyId, encryptionKeyId, signingKeyId, data, meta }) {
    const state = (0, sbp_1.default)(this.config.stateSelector)[contractID];
    const signedMessage = innerSigningKeyId
        ? state._vm.authorizedKeys[innerSigningKeyId] &&
            state._vm.authorizedKeys[innerSigningKeyId]?._notAfterHeight == null
            ? (0, signedData_js_1.signedOutgoingData)(contractID, innerSigningKeyId, data, this.transientSecretKeys)
            : (0, signedData_js_1.signedOutgoingDataWithRawKey)(this.transientSecretKeys[innerSigningKeyId], data)
        : data;
    const payload = !encryptionKeyId
        ? signedMessage
        : (0, encryptedData_js_1.encryptedOutgoingData)(contractID, encryptionKeyId, signedMessage);
    const message = (0, signedData_js_1.signedOutgoingData)(contractID, signingKeyId, payload, this.transientSecretKeys);
    const rootState = (0, sbp_1.default)(this.config.stateSelector);
    const height = String(rootState.contracts[contractID].height);
    const serializedData = { ...message.serialize((meta ?? '') + height), height };
    return serializedData;
}
function parseEncryptedOrUnencryptedMessage(ctx, { contractID, serializedData, meta }) {
    if (!serializedData) {
        throw new TypeError('[chelonia] parseEncryptedOrUnencryptedMessage: serializedData is required');
    }
    const state = (0, sbp_1.default)(ctx.config.stateSelector)[contractID];
    const numericHeight = parseInt(serializedData.height);
    const rootState = (0, sbp_1.default)(ctx.config.stateSelector);
    const currentHeight = rootState.contracts[contractID].height;
    if (!(numericHeight >= 0) || !(numericHeight <= currentHeight)) {
        throw new Error(`[chelonia] parseEncryptedOrUnencryptedMessage: Invalid height ${serializedData.height}; it must be between 0 and ${currentHeight}`);
    }
    // Additional data used for verification
    const aad = (meta ?? '') + serializedData.height;
    const v = (0, signedData_js_1.signedIncomingData)(contractID, state, serializedData, numericHeight, aad, (message) => {
        return (0, encryptedData_js_1.maybeEncryptedIncomingData)(contractID, state, message, numericHeight, ctx.transientSecretKeys, aad, undefined);
    });
    // Cached values
    let encryptionKeyId;
    let innerSigningKeyId;
    // Lazy unwrap function
    // We don't use `unwrapMaybeEncryptedData`, which would almost do the same,
    // because it swallows decryption errors, which we want to propagate to
    // consumers of the KV API.
    const unwrap = (() => {
        let result;
        return () => {
            if (!result) {
                try {
                    let unwrapped;
                    // First, we unwrap the signed data
                    unwrapped = v.valueOf();
                    // If this is encrypted data, attempt decryption
                    if ((0, encryptedData_js_1.isEncryptedData)(unwrapped)) {
                        encryptionKeyId = unwrapped.encryptionKeyId;
                        unwrapped = unwrapped.valueOf();
                        // There could be inner signed data (inner signatures), so we unwrap
                        // that too
                        if ((0, signedData_js_1.isSignedData)(unwrapped)) {
                            innerSigningKeyId = unwrapped.signingKeyId;
                            unwrapped = unwrapped.valueOf();
                        }
                        else {
                            innerSigningKeyId = null;
                        }
                    }
                    else {
                        encryptionKeyId = null;
                        innerSigningKeyId = null;
                    }
                    result = [unwrapped];
                }
                catch (e) {
                    result = [undefined, e];
                }
            }
            if (result.length === 2) {
                throw result[1];
            }
            return result[0];
        };
    })();
    const result = {
        get contractID() {
            return contractID;
        },
        get innerSigningKeyId() {
            if (innerSigningKeyId === undefined) {
                try {
                    unwrap();
                }
                catch {
                    // We're not interested in an error, that'd only be for the 'data'
                    // accessor.
                }
            }
            return innerSigningKeyId;
        },
        get encryptionKeyId() {
            if (encryptionKeyId === undefined) {
                try {
                    unwrap();
                }
                catch {
                    // We're not interested in an error, that'd only be for the 'data'
                    // accessor.
                }
            }
            return encryptionKeyId;
        },
        get signingKeyId() {
            return v.signingKeyId;
        },
        get data() {
            return unwrap();
        },
        get signingContractID() {
            return (0, utils_js_1.getContractIDfromKeyId)(contractID, result.signingKeyId, state);
        },
        get innerSigningContractID() {
            return (0, utils_js_1.getContractIDfromKeyId)(contractID, result.innerSigningKeyId, state);
        }
    };
    return result;
}
async function outEncryptedOrUnencryptedAction(opType, params) {
    const { atomic, action, contractID, data, hooks, publishOptions } = params;
    const contractName = contractNameFromAction(action);
    const manifestHash = this.config.contracts.manifests[contractName];
    const { contract } = this.manifestToContract[manifestHash];
    const state = contract.state(contractID);
    const meta = await contract.metadata.create();
    const unencMessage = { action, data, meta };
    const signedMessage = params.innerSigningKeyId
        ? state._vm.authorizedKeys[params.innerSigningKeyId] &&
            state._vm.authorizedKeys[params.innerSigningKeyId]?._notAfterHeight == null
            ? (0, signedData_js_1.signedOutgoingData)(contractID, params.innerSigningKeyId, unencMessage, this.transientSecretKeys)
            : (0, signedData_js_1.signedOutgoingDataWithRawKey)(this.transientSecretKeys[params.innerSigningKeyId], unencMessage)
        : unencMessage;
    if (opType === SPMessage_js_1.SPMessage.OP_ACTION_ENCRYPTED && !params.encryptionKeyId) {
        throw new Error('OP_ACTION_ENCRYPTED requires an encryption key ID be given');
    }
    if (params.encryptionKey) {
        if (params.encryptionKeyId !== (0, crypto_1.keyId)(params.encryptionKey)) {
            throw new Error('OP_ACTION_ENCRYPTED raw encryption key does not match encryptionKeyId');
        }
    }
    const payload = opType === SPMessage_js_1.SPMessage.OP_ACTION_UNENCRYPTED
        ? signedMessage
        : params.encryptionKey
            ? (0, encryptedData_js_1.encryptedOutgoingDataWithRawKey)(params.encryptionKey, signedMessage)
            : (0, encryptedData_js_1.encryptedOutgoingData)(contractID, params.encryptionKeyId, signedMessage);
    let message = SPMessage_js_1.SPMessage.createV1_0({
        contractID,
        op: [
            opType,
            (0, signedData_js_1.signedOutgoingData)(contractID, params.signingKeyId, payload, this.transientSecretKeys)
        ],
        manifest: manifestHash
    });
    if (!atomic) {
        message = await (0, sbp_1.default)('chelonia/private/out/publishEvent', message, publishOptions, hooks);
    }
    return message;
}
// The gettersProxy is what makes Vue-like getters possible. In other words,
// we want to make sure that the getter functions that we defined in each
// contract get passed the 'state' when a getter is accessed.
// We pass in the state by creating a Proxy object that does it for us.
// This allows us to maintain compatibility with Vue.js and integrate
// the contract getters into the Vue-facing getters.
// For this to work, other getters need to be implemented relative to a
// 'current' getter that returns the state itself. For example:
// ```
// {
//   currentMailboxState: (state) => state, // In the contract
//   currentMailboxState: (state) => state[state.currentMailboxId], // In the app
//   lastMessage: (state, getters) => // Shared getter for both app and contract
//     getters.currentMailboxState.messages.slice(-1).pop()
// }
// ```
function gettersProxy(state, getters) {
    const proxyGetters = new Proxy({}, {
        get(_target, prop) {
            return getters[prop](state, proxyGetters);
        }
    });
    return { getters: proxyGetters };
}
(0, sbp_1.default)('sbp/domains/lock', ['chelonia']);
