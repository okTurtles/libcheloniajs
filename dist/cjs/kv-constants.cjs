"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KV_AUTO_LOAD = exports.KV_VALIDATION_REASON_REVALIDATE = exports.KV_UPDATE_REASON = exports.KV_LOAD_STATUS = exports.KV_DEFAULT_SIGNING_KEY_NAME = exports.KV_DEFAULT_ENCRYPTION_KEY_NAME = exports.KV_FILTER_RETRY_MS = exports.KV_KEY_SEPARATOR = exports.KV_ECHO_TTL_MS = exports.KV_ECHO_CID_MAX = exports.KV_NOOP_ABORT_ERROR_NAME = exports.KV_NOOP_ABORT_SYMBOL = exports.KV_NOOP = void 0;
// Reserved sentinel returned by a `KvUpdater` to abort a write without
// touching the server (replaces the legacy `return null` idiom from
// `chelonia/kv/set`'s `onconflict`).
//
// `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the sentinel
// survives realm boundaries — iframes, workers, and the dual ESM/CJS
// load of `@chelonia/lib`. The string key is namespaced
// (`@chelonia/lib/KV_NOOP`) to make a userland collision implausible.
exports.KV_NOOP = Symbol.for('@chelonia/lib/KV_NOOP');
// Internal marker for the `KV_NOOP` retry-abort path. It also uses
// `Symbol.for(...)` so the catch side can identify the abort across
// realms and across simultaneous ESM/CJS loads without relying on
// `instanceof`.
exports.KV_NOOP_ABORT_SYMBOL = Symbol.for('@chelonia/lib/KV_NOOP_ABORT');
exports.KV_NOOP_ABORT_ERROR_NAME = 'KvNoopAbort';
exports.KV_ECHO_CID_MAX = 128;
exports.KV_ECHO_TTL_MS = 300000;
exports.KV_KEY_SEPARATOR = '::';
// Backoff before retrying a `setFilter` flush that failed transiently
// (e.g. a server error while the socket stayed up). The dirty mark is
// re-added and a single deferred retry is scheduled so the server's
// filter set converges without waiting for the next slot change to
// re-dirty the contract. Reconnect re-establishes filters independently,
// so this only matters for failures that do not drop the socket.
exports.KV_FILTER_RETRY_MS = 2000;
exports.KV_DEFAULT_ENCRYPTION_KEY_NAME = 'cek';
exports.KV_DEFAULT_SIGNING_KEY_NAME = 'csk';
exports.KV_LOAD_STATUS = {
    NON_INIT: 'non-init',
    LOADING: 'loading',
    LOADED: 'loaded',
    ERROR: 'error'
};
exports.KV_UPDATE_REASON = {
    LOAD: 'load',
    REMOTE: 'remote',
    LOCAL: 'local',
    RECONNECT: 'reconnect'
};
exports.KV_VALIDATION_REASON_REVALIDATE = 're-validate';
exports.KV_AUTO_LOAD = {
    ON_SYNC: 'on-sync',
    ON_DEMAND: 'on-demand',
    NEVER: 'never'
};
