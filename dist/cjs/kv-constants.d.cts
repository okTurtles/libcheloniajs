export declare const KV_NOOP: unique symbol;
export type KvNoop = typeof KV_NOOP;
export declare const KV_NOOP_ABORT_SYMBOL: unique symbol;
export declare const KV_NOOP_ABORT_ERROR_NAME = "KvNoopAbort";
export declare const KV_ECHO_CID_MAX = 128;
export declare const KV_ECHO_TTL_MS = 300000;
export declare const KV_KEY_SEPARATOR = "::";
export declare const KV_FILTER_RETRY_MS = 2000;
export declare const KV_DEFAULT_ENCRYPTION_KEY_NAME = "cek";
export declare const KV_DEFAULT_SIGNING_KEY_NAME = "csk";
export declare const KV_LOAD_STATUS: {
    readonly NON_INIT: "non-init";
    readonly LOADING: "loading";
    readonly LOADED: "loaded";
    readonly ERROR: "error";
};
export declare const KV_UPDATE_REASON: {
    readonly LOAD: "load";
    readonly REMOTE: "remote";
    readonly LOCAL: "local";
    readonly RECONNECT: "reconnect";
};
export declare const KV_VALIDATION_REASON_REVALIDATE = "re-validate";
export declare const KV_AUTO_LOAD: {
    readonly ON_SYNC: "on-sync";
    readonly ON_DEMAND: "on-demand";
    readonly NEVER: "never";
};
