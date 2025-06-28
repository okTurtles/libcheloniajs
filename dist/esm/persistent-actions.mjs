import '@sbp/okturtles.events';
import sbp from '@sbp/sbp';
import { PERSISTENT_ACTION_FAILURE, PERSISTENT_ACTION_SUCCESS, PERSISTENT_ACTION_TOTAL_FAILURE } from './events.mjs';
// Using `Symbol` to prevent enumeration; this avoids JSON serialization.
const timer = Symbol('timer');
const coerceToError = (arg) => {
    if (arg && arg instanceof Error)
        return arg;
    console.warn(tag, 'Please use Error objects when throwing or rejecting');
    return new Error((typeof arg === 'string' ? arg : JSON.stringify(arg)) ?? 'undefined');
};
const defaultOptions = {
    maxAttempts: Number.POSITIVE_INFINITY,
    retrySeconds: 30
};
const tag = '[chelonia.persistentActions]';
export class PersistentAction {
    id;
    invocation;
    options;
    status;
    [timer];
    constructor(invocation, options = {}) {
        this.id = crypto.randomUUID();
        this.invocation = invocation;
        this.options = { ...defaultOptions, ...options };
        this.status = {
            attempting: false,
            failedAttemptsSoFar: 0,
            lastError: '',
            nextRetry: '',
            resolved: false
        };
    }
    async attempt() {
        // Bail out if the action is already attempting or resolved.
        // TODO: should we also check whether the skipCondition call is pending?
        if (this.status.attempting || this.status.resolved)
            return;
        if (await this.trySBP(this.options.skipCondition))
            this.cancel();
        // We need to check this again because cancel() could have been called while awaiting the trySBP call.
        if (this.status.resolved)
            return;
        try {
            this.status.attempting = true;
            const result = await sbp(...this.invocation);
            this.status.attempting = false;
            this.handleSuccess(result);
        }
        catch (error) {
            this.status.attempting = false;
            await this.handleError(coerceToError(error));
        }
    }
    cancel() {
        if (this[timer])
            clearTimeout(this[timer]);
        this.status.nextRetry = '';
        this.status.resolved = true;
    }
    async handleError(error) {
        const { id, options, status } = this;
        // Update relevant status fields before calling any optional code.
        status.failedAttemptsSoFar++;
        status.lastError = error.message;
        const anyAttemptLeft = options.maxAttempts > status.failedAttemptsSoFar;
        if (!anyAttemptLeft)
            status.resolved = true;
        status.nextRetry = anyAttemptLeft && !status.resolved
            ? new Date(Date.now() + options.retrySeconds * 1e3).toISOString()
            : '';
        // Perform any optional SBP invocation.
        // The event has to be fired first for the action to be immediately removed from the list.
        sbp('okTurtles.events/emit', PERSISTENT_ACTION_FAILURE, { error, id });
        await this.trySBP(options.errorInvocation);
        if (!anyAttemptLeft) {
            sbp('okTurtles.events/emit', PERSISTENT_ACTION_TOTAL_FAILURE, { error, id });
            await this.trySBP(options.totalFailureInvocation);
        }
        // Schedule a retry if appropriate.
        if (status.nextRetry) {
            // Note: there should be no older active timeout to clear.
            this[timer] = setTimeout(() => {
                this.attempt().catch((e) => {
                    console.error('Error attempting persistent action', id, e);
                });
            }, this.options.retrySeconds * 1e3);
        }
    }
    handleSuccess(result) {
        const { id, status } = this;
        status.lastError = '';
        status.nextRetry = '';
        status.resolved = true;
        sbp('okTurtles.events/emit', PERSISTENT_ACTION_SUCCESS, { id, result });
    }
    async trySBP(invocation) {
        try {
            return invocation ? await sbp(...invocation) : undefined;
        }
        catch (error) {
            console.error(tag, coerceToError(error).message);
        }
    }
}
export default sbp('sbp/selectors/register', {
    'chelonia.persistentActions/_init'() {
        this.actionsByID = Object.create(null);
        this.checkDatabaseKey = () => {
            if (!this.databaseKey)
                throw new TypeError(`${tag} No database key configured`);
        };
        sbp('okTurtles.events/on', PERSISTENT_ACTION_SUCCESS, ({ id }) => {
            sbp('chelonia.persistentActions/cancel', id);
        });
        sbp('okTurtles.events/on', PERSISTENT_ACTION_TOTAL_FAILURE, ({ id }) => {
            sbp('chelonia.persistentActions/cancel', id);
        });
    },
    // Cancels a specific action by its ID.
    // The action won't be retried again, but an async action cannot be aborted if its promise is stil attempting.
    async 'chelonia.persistentActions/cancel'(id) {
        if (id in this.actionsByID) {
            this.actionsByID[id].cancel();
            // Note: this renders the `.status` update in `.cancel()` meainingless, as
            // the action will be immediately removed. TODO: Implement as periodic
            // prune action so that actions are removed some time after completion.
            // This way, one could implement action status reporting to clients.
            delete this.actionsByID[id];
            return await sbp('chelonia.persistentActions/save');
        }
    },
    // TODO: validation
    'chelonia.persistentActions/configure'({ databaseKey, options = {} }) {
        this.databaseKey = databaseKey;
        for (const key in options) {
            if (key in defaultOptions) {
                defaultOptions[key] = options[key];
            }
            else {
                throw new TypeError(`${tag} Unknown option: ${key}`);
            }
        }
    },
    'chelonia.persistentActions/enqueue'(...args) {
        const ids = [];
        for (const arg of args) {
            const action = Array.isArray(arg)
                ? new PersistentAction(arg)
                : new PersistentAction(arg.invocation, arg);
            this.actionsByID[action.id] = action;
            ids.push(action.id);
        }
        sbp('chelonia.persistentActions/save').catch((e) => {
            console.error('Error saving persistent actions', e);
        });
        for (const id of ids) {
            this.actionsByID[id].attempt().catch((e) => {
                console.error('Error attempting persistent action', id, e);
            });
        }
        return ids;
    },
    // Forces retrying a given persisted action immediately, rather than waiting for the scheduled retry.
    // - 'status.failedAttemptsSoFar' will still be increased upon failure.
    // - Does nothing if a retry is already running.
    // - Does nothing if the action has already been resolved, rejected or cancelled.
    'chelonia.persistentActions/forceRetry'(id) {
        if (id in this.actionsByID) {
            return this.actionsByID[id].attempt();
        }
    },
    // Loads and tries every stored persistent action under the configured database key.
    async 'chelonia.persistentActions/load'() {
        this.checkDatabaseKey();
        const storedActions = JSON.parse((await sbp('chelonia.db/get', this.databaseKey)) ?? '[]');
        for (const { id, invocation, options } of storedActions) {
            this.actionsByID[id] = new PersistentAction(invocation, options);
            // Use the stored ID instead of the autogenerated one.
            // TODO: find a cleaner alternative.
            this.actionsByID[id].id = id;
        }
        return sbp('chelonia.persistentActions/retryAll');
    },
    // Retry all existing persisted actions.
    // TODO: add some delay between actions so as not to spam the server,
    // or have a way to issue them all at once in a single network call.
    'chelonia.persistentActions/retryAll'() {
        return Promise.allSettled(Object.keys(this.actionsByID).map(id => sbp('chelonia.persistentActions/forceRetry', id)));
    },
    // Updates the database version of the attempting action list.
    'chelonia.persistentActions/save'() {
        this.checkDatabaseKey();
        return sbp('chelonia.db/set', this.databaseKey, JSON.stringify(Object.values(this.actionsByID)));
    },
    'chelonia.persistentActions/status'() {
        return Object.values(this.actionsByID)
            .map((action) => ({ id: action.id, invocation: action.invocation, ...action.status }));
    },
    // Pauses every currently loaded action, and removes them from memory.
    // Note: persistent storage is not affected, so that these actions can be later loaded again and retried.
    'chelonia.persistentActions/unload'() {
        for (const id in this.actionsByID) {
            // Clear the action's timeout, but don't cancel it so that it can later resumed.
            if (this.actionsByID[id][timer]) {
                clearTimeout(this.actionsByID[id][timer]);
            }
            delete this.actionsByID[id];
        }
    }
});
