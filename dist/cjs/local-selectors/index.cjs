"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// This file provides utility functions that are local regardless of whether
// Chelonia is running in a different context and calls are being forwarded
// using `chelonia/*`
const sbp_1 = __importDefault(require("@sbp/sbp"));
const turtledash_1 = require("turtledash");
const events_js_1 = require("../events.cjs");
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    // This selector sets up event listeners on EVENT_HANDLED and CONTRACTS_MODIFIED
    // to keep Chelonia state in sync with some external state (e.g., Vuex).
    // This needs to be called from the context that owns this external state
    // (e.g., the tab in which the app is running) and because 'full' Chelonia may
    // be available in this context, we cannot use `chelonia/configure`.
    // _If there is no external state to be kept in sync with Chelonia, this selector doesn't need to be called_
    //
    // For example, **if Chelonia is running on a service worker**, the following
    // would be done.
    // 1. The service worker calls `chelonia/configure` and forwards EVENT_HANDLED
    //    and CONTRACTS_MODIFIED events to all clients (tabs)
    //    Note: `chelonia/configure` is called by the context running Chelonia
    // 2. Each tab uses `chelonia/*` to forward calls to Chelonia to the SW.
    //    Note: Except selectors defined in this file
    // 3. Each tab calls this selector once to set up event listeners on EVENT_HANDLED
    //    and CONTRACTS_MODIFIED, which will keep each tab's state updated every
    //    time Chelonia handles an event.
    //
    // Returns a teardown function that removes all listeners. Call it on logout
    // to prevent listener accumulation across sessions.
    'chelonia/externalStateSetup': function ({ stateSelector, reactiveSet = Reflect.set.bind(Reflect), reactiveDel = Reflect.deleteProperty.bind(Reflect) }) {
        this.stateSelector = stateSelector;
        const handles = [];
        handles.push((0, sbp_1.default)('okTurtles.events/on', events_js_1.EVENT_HANDLED, (contractID, message) => {
            // The purpose of putting things immediately into a queue is to have
            // state mutations happen in a well-defined order. This is done for two
            // purposes:
            //   1. It avoids race conditions
            //   2. It allows the app to use the EVENT_HANDLED queue to ensure that
            //      the SW state has been copied over to the local state. This is
            //      useful in the same sense that `chelonia/contract/wait` is useful
            //      (i.e., set up a barrier / sync checkpoint).
            (0, sbp_1.default)('okTurtles.eventQueue/queueEvent', events_js_1.EVENT_HANDLED, async () => {
                const { contractState, cheloniaState } = await (0, sbp_1.default)('chelonia/contract/fullState', contractID);
                const externalState = (0, sbp_1.default)(stateSelector);
                if (cheloniaState) {
                    if (!externalState.contracts) {
                        reactiveSet(externalState, 'contracts', Object.create(null));
                    }
                    reactiveSet(externalState.contracts, contractID, (0, turtledash_1.cloneDeep)(cheloniaState));
                }
                else if (externalState.contracts) {
                    reactiveDel(externalState.contracts, contractID);
                }
                if (contractState) {
                    reactiveSet(externalState, contractID, (0, turtledash_1.cloneDeep)(contractState));
                }
                else {
                    reactiveDel(externalState, contractID);
                }
                // This EVENT_HANDLED_READY event lets the current context (e.g., tab)
                // know that an event has been processed _and_ committed to the state
                // (as opposed to EVENT_HANDLED, which means the event was processed by
                // _Chelonia_ but state changes may not be reflected in the current tab
                // yet).
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.EVENT_HANDLED_READY, contractID, message);
            });
        }));
        handles.push((0, sbp_1.default)('okTurtles.events/on', events_js_1.CONTRACTS_MODIFIED, (subscriptionSet, { added, removed, permanent }) => {
            (0, sbp_1.default)('okTurtles.eventQueue/queueEvent', events_js_1.EVENT_HANDLED, async () => {
                const states = added.length ? await (0, sbp_1.default)('chelonia/contract/fullState', added) : {};
                const externalState = (0, sbp_1.default)(stateSelector);
                if (!externalState.contracts) {
                    reactiveSet(externalState, 'contracts', Object.create(null));
                }
                removed.forEach((contractID) => {
                    if (permanent) {
                        reactiveSet(externalState.contracts, contractID, null);
                    }
                    else {
                        reactiveDel(externalState.contracts, contractID);
                    }
                    reactiveDel(externalState, contractID);
                    // Drop KV mirror for removed contracts
                    if (externalState._kv) {
                        reactiveDel(externalState._kv, contractID);
                    }
                });
                for (const contractID of added) {
                    const { contractState, cheloniaState } = states[contractID];
                    if (cheloniaState) {
                        reactiveSet(externalState.contracts, contractID, (0, turtledash_1.cloneDeep)(cheloniaState));
                    }
                    if (contractState) {
                        reactiveSet(externalState, contractID, (0, turtledash_1.cloneDeep)(contractState));
                    }
                }
                (0, sbp_1.default)('okTurtles.events/emit', events_js_1.CONTRACTS_MODIFIED_READY, subscriptionSet, {
                    added,
                    removed
                });
            });
        }));
        // Mirror `rootState._kv[contractID]` into the external store on every
        // KV value change. KV updates don't fire EVENT_HANDLED (on-chain only).
        handles.push((0, sbp_1.default)('okTurtles.events/on', events_js_1.CHELONIA_KV_UPDATED, ({ contractID }) => {
            (0, sbp_1.default)('okTurtles.eventQueue/queueEvent', events_js_1.EVENT_HANDLED, async () => {
                const { cheloniaState } = await (0, sbp_1.default)('chelonia/contract/fullState', contractID);
                const externalState = (0, sbp_1.default)(stateSelector);
                const kvSlice = cheloniaState?._kv?.[contractID];
                if (kvSlice) {
                    if (!externalState._kv) {
                        reactiveSet(externalState, '_kv', Object.create(null));
                    }
                    reactiveSet(externalState._kv, contractID, (0, turtledash_1.cloneDeep)(kvSlice));
                }
                else if (externalState._kv) {
                    reactiveDel(externalState._kv, contractID);
                }
            });
        }));
        // Re-project on status changes (e.g. 'loaded' → 'error') where the value
        // is unchanged but status / lastError need to be visible in the store.
        handles.push((0, sbp_1.default)('okTurtles.events/on', events_js_1.CHELONIA_KV_STATUS_CHANGED, ({ contractID }) => {
            (0, sbp_1.default)('okTurtles.eventQueue/queueEvent', events_js_1.EVENT_HANDLED, async () => {
                const { cheloniaState } = await (0, sbp_1.default)('chelonia/contract/fullState', contractID);
                const externalState = (0, sbp_1.default)(stateSelector);
                const kvSlice = cheloniaState?._kv?.[contractID];
                if (kvSlice) {
                    if (!externalState._kv) {
                        reactiveSet(externalState, '_kv', Object.create(null));
                    }
                    reactiveSet(externalState._kv, contractID, (0, turtledash_1.cloneDeep)(kvSlice));
                }
                else if (externalState._kv) {
                    reactiveDel(externalState._kv, contractID);
                }
            });
        }));
        return () => {
            for (const off of handles)
                off();
            handles.length = 0;
        };
    },
    // This function is similar in purpose to `chelonia/contract/wait`, except
    // that it's also designed to take into account delays copying Chelonia state
    // to an external state (e.g., when using `chelonia/externalStateSetup`).
    'chelonia/externalStateWait': async function (contractID) {
        await (0, sbp_1.default)('chelonia/contract/wait', contractID);
        const { cheloniaState } = await (0, sbp_1.default)('chelonia/contract/fullState', contractID);
        const localState = (0, sbp_1.default)(this.stateSelector);
        // If the current 'local' state has a height higher than or equal to the
        // Chelonia height, we've processed all events and don't need to wait any
        // longer.
        if (!cheloniaState || cheloniaState.height <= localState.contracts[contractID]?.height)
            return;
        // Otherwise, listen for `EVENT_HANDLED_READY` events till we have reached
        // the necessary height.
        return new Promise((resolve) => {
            const removeListener = (0, sbp_1.default)('okTurtles.events/on', events_js_1.EVENT_HANDLED_READY, (cID) => {
                if (cID !== contractID)
                    return;
                const localState = (0, sbp_1.default)(this.stateSelector);
                if (cheloniaState.height <= localState.contracts[contractID]?.height) {
                    resolve();
                    removeListener();
                }
            });
        });
    }
});
