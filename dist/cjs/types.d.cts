import type { Key } from '@chelonia/crypto';
import type sbp from '@sbp/sbp';
import type { SPMessage, SPMsgDirection, SPOpType } from './SPMessage.cjs';
import type { EncryptedData } from './encryptedData.cjs';
import type { PubSubClient } from './pubsub/index.cjs';
import type { SignedDataContext } from './signedData.cjs';
import type { KvNoop } from './kv.cjs';
export type JSONType = null | string | number | boolean | JSONObject | JSONArray;
export interface JSONObject {
    [x: string]: JSONType;
}
export type JSONArray = Array<JSONType>;
export type ResType = ResTypeErr | ResTypeOK | ResTypeAlready | ResTypeSub | ResTypeUnsub | ResTypeEntry | ResTypePub;
export type ResTypeErr = 'error';
export type ResTypeOK = 'success';
export type ResTypeAlready = 'already';
export type ResTypeSub = 'sub';
export type ResTypeUnsub = 'unsub';
export type ResTypePub = 'pub';
export type ResTypeEntry = 'entry';
export type CheloniaConfig = {
    [_ in `preOp_${SPOpType}`]?: (message: SPMessage, state: ChelContractState) => boolean;
} & {
    [_ in `postOp_${SPOpType}`]?: (message: SPMessage, state: ChelContractState) => boolean;
} & {
    connectionURL: string;
    stateSelector: string;
    contracts: {
        defaults: {
            modules: Record<string, unknown>;
            exposedGlobals: object;
            allowedDomains: string[];
            allowedSelectors: string[];
            preferSlim: boolean;
        };
        overrides: object;
        manifests: Record<string, string>;
    };
    whitelisted: (action: string) => boolean;
    reactiveSet: <T>(obj: T, key: keyof T, value: T[typeof key]) => void;
    fetch: typeof fetch;
    reactiveDel: <T>(obj: T, key: keyof T) => void;
    acceptAllMessages: boolean;
    skipActionProcessing: boolean;
    skipSideEffects: boolean;
    strictProcessing: boolean;
    strictOrdering: boolean;
    saveMessageMetadata: boolean;
    connectionOptions: {
        maxRetries: number;
        reconnectOnTimeout: boolean;
    };
    preOp?: (message: SPMessage, state: ChelContractState) => boolean;
    postOp?: (message: SPMessage, state: ChelContractState) => boolean;
    hooks: Partial<{
        preHandleEvent: {
            (message: SPMessage): Promise<void>;
        } | null;
        postHandleEvent: {
            (message: SPMessage): Promise<void>;
        } | null;
        processError: {
            (e: unknown, message: SPMessage | null | undefined, meta: object | null | undefined): void;
        } | null;
        sideEffectError: {
            (e: unknown, message?: SPMessage): void;
        } | null;
        handleEventError: {
            (e: unknown, message?: SPMessage): void;
        } | null;
        syncContractError: {
            (e: unknown, contractID: string): void;
        } | null;
        pubsubError: {
            (e: unknown, socket: PubSubClient): void;
        } | null;
    }>;
    skipDecryptionAttempts: boolean;
    unwrapMaybeEncryptedData: <T>(data: T | EncryptedData<T>) => {
        encryptionKeyId: string | null;
        data: T;
    } | undefined;
    journal?: JournalConfig | null;
};
export type JournalPatch = {
    op: 'add' | 'replace';
    path: string;
    value: unknown;
} | {
    op: 'remove';
    path: string;
};
export type JournalEntry = {
    kind: 'snapshot';
    hash: string;
    height: number;
    opType: string;
    description?: string;
    state: unknown;
    error?: {
        name: string;
        message: string;
    };
} | {
    kind: 'patch';
    hash: string;
    height: number;
    opType: string;
    description?: string;
    patch: JournalPatch[];
    error?: {
        name: string;
        message: string;
    };
};
export type JournalRedaction = {
    path: string;
    redact: (value: unknown, fullPath: string[], contractName: string) => unknown;
};
export type JournalConfig = {
    enabled?: boolean;
    snapshotInterval?: number;
    contractIDs?: string[];
    redactions?: JournalRedaction[];
    diff?: (before: unknown, after: unknown) => JournalPatch[];
    applyPatch?: (state: unknown, patches: JournalPatch[]) => unknown;
};
export type KvUpdater<T> = (prev: T) => T | KvNoop;
export type KvLoadStatus = 'non-init' | 'loading' | 'loaded' | 'error';
export type KvMirrorEntry = {
    value: JSONType | undefined;
    etag: string | null;
    status: KvLoadStatus;
    lastError?: {
        name: string;
        message: string;
    };
};
export type KvUpdateCtx = {
    contractID: string;
    contractType: string;
    key: string;
    reason: 'load' | 'remote' | 'local' | 'reconnect';
    etag: string | null;
    previousValue: JSONType | undefined;
};
export type KvSlotDefinition = {
    contractType: string | string[];
    key: string;
    defaultValue?: JSONType | (() => JSONType);
    /**
     * Synchronous validator with a `parse(value)` method (Zod-shaped).
     * Runs on writes, remote updates, reconnect, and first activation of
     * persisted mirror entries; reads return already-validated values and
     * substitute the default for entries currently in `error` status (see
     * KV-REVAMPED.md §6).
     *
     * Side effect of registration: if the schema is a `.transform()`
     * (or otherwise mutating) parser, `defineSlot` runs the resolved
     * `defaultValue` through `schema.parse` once and stores the
     * **post-parse** value as the slot's effective default. Every
     * subsequent `chelonia/kv/read` that returns the default returns
     * a deep clone of that post-parse value, not the raw
     * `defaultValue` you passed in. The parse must be idempotent
     * (`parse(parse(x))` structurally equal to `parse(x)`), which
     * `defineSlot` enforces at registration time.
     */
    schema?: {
        parse: (value: unknown) => JSONType;
    };
    match?: (contractID: string, contractState: object, rootState: object) => boolean;
    encryptionKeyName?: string;
    signingKeyName?: string;
    defaultUpdater?: (value: JSONType) => KvUpdater<JSONType>;
    autoSubscribe?: boolean;
    autoLoad?: 'on-sync' | 'on-demand' | 'never';
    refreshOnReconnect?: boolean;
    onUpdate?: (value: JSONType | undefined, ctx: KvUpdateCtx) => void | Promise<void>;
};
export type SlotDefinitionSource = {
    kind: 'defineContract';
    manifest: string;
} | {
    kind: 'defineSlot';
};
export type SlotDefinition = {
    contractType: string;
    key: string;
    defaultValue?: JSONType | (() => JSONType);
    resolvedDefault: JSONType | undefined;
    schema?: {
        parse: (value: unknown) => JSONType;
    };
    match?: (contractID: string, contractState: object, rootState: object) => boolean;
    encryptionKeyName: string;
    signingKeyName: string;
    defaultUpdater?: (value: JSONType) => KvUpdater<JSONType>;
    autoSubscribe: boolean;
    autoLoad: 'on-sync' | 'on-demand' | 'never';
    refreshOnReconnect: boolean;
    onUpdate?: (value: JSONType | undefined, ctx: KvUpdateCtx) => void | Promise<void>;
    source?: SlotDefinitionSource;
};
export type SendMessageHooks = Partial<{
    prepublish: (entry: SPMessage) => void | Promise<void>;
    onprocessed: (entry: SPMessage) => void;
    preSendCheck: (entry: SPMessage, state: ChelContractState) => boolean | Promise<boolean>;
    beforeRequest: (newEntry: SPMessage, oldEntry: SPMessage) => void | Promise<void>;
    postpublish: (entry: SPMessage) => void | Promise<void>;
}>;
export type ChelContractProcessMessageObject = Readonly<{
    data: object;
    meta: object;
    hash: string;
    height: number;
    contractID: string;
    direction: SPMsgDirection;
    signingKeyId: string;
    signingContractID: string;
    innerSigningKeyId?: string | null | undefined;
    innerSigningContractID?: string | null | undefined;
}>;
export type ChelContractSideeffectMutationObject = Readonly<{
    data: object;
    meta: object;
    hash: string;
    height: number;
    contractID: string;
    description: string;
    direction: SPMsgDirection;
    signingKeyId: string;
    signingContractID: string;
    innerSigningKeyId?: string | null | undefined;
    innerSigningContractID?: string | null | undefined;
}>;
export type CheloniaContractCtx = {
    getters: Record<string, <T extends object, K extends keyof T>(state: ChelContractState, obj: T) => T[K]>;
    name: string;
    manifest: string;
    metadata: {
        create: () => object | Promise<object>;
        validate: (meta: object, { state, contractID, ...gProxy }: {
            state: ChelContractState;
            contractID: string;
        }) => void | Promise<void>;
    };
    sbp: typeof sbp;
    state: (contractID: string) => ChelContractState;
    actions: Record<string, {
        validate: (data: object, { state, meta, message, contractID, ...gProxy }: {
            state: ChelContractState;
            meta: object;
            message: ChelContractProcessMessageObject;
            contractID: string;
        }) => void | Promise<void>;
        process: (message: ChelContractProcessMessageObject, { state, ...gProxy }: {
            state: ChelContractState;
        }) => void | Promise<void>;
        sideEffect?: (mutation: ChelContractSideeffectMutationObject, { state, ...gProxy }: {
            state: ChelContractState;
        }) => void | Promise<void>;
    }>;
    methods: Record<string, (...args: unknown[]) => unknown>;
    kv?: Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>;
};
export type CheloniaContext = {
    config: CheloniaConfig;
    _instance: object;
    abortController: AbortController;
    state: {
        contracts: Record<string, {
            type: string;
            HEAD: string;
        }>;
        pending: string[];
        [x: string]: unknown;
    };
    manifestToContract: Record<string, {
        slim: boolean;
        info: string;
        contract: CheloniaContractCtx;
        name: string;
    }>;
    whitelistedActions: Record<string, true>;
    currentSyncs: Record<string, {
        firstSync: boolean;
    }>;
    postSyncOperations: Record<string, Record<string, Parameters<typeof sbp>>>;
    sideEffectStacks: Record<string, Parameters<typeof sbp>[]>;
    sideEffectStack: (contractID: string) => Array<Parameters<typeof sbp>>;
    setPostSyncOp: (contractID: string, key: string, op: Parameters<typeof sbp>) => void;
    transientSecretKeys: Record<string, Key>;
    ephemeralReferenceCount: Record<string, number>;
    subscriptionSet: Set<string>;
    pending: {
        contractID: string;
    }[];
    pubsub: import('./pubsub/index.cjs').PubSubClient;
    contractsModifiedListener: (contracts: Set<string>, { added, removed }: {
        added: string[];
        removed: string[];
    }) => void;
    kvReconnectListener?: (client: import('./pubsub/index.cjs').PubSubClient) => void;
    kvContractsModifiedListener?: (contracts: Set<string>, { added, removed }: {
        added: string[];
        removed: string[];
    }) => void;
    defContractSelectors: string[];
    defContractManifest: string;
    defContractSBP: typeof sbp;
    defContract: CheloniaContractCtx;
    kvSlots: Map<string, SlotDefinition>;
    kvSlotsByContractID: Map<string, Map<string, SlotDefinition>>;
    kvActiveFilters: Map<string, Set<string>>;
    kvFilterDirty: Set<string>;
    kvLocalEchoNonces: Map<string, string[]>;
    defContractKvByManifest: Map<string, Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>>;
};
export type ChelContractManifestBody = {
    name: string;
    version: string;
    contract: {
        hash: string;
        file: string;
    };
    contractSlim: {
        hash: string;
        file: string;
    };
    signingKeys: string[];
};
export type ChelContractManifest = {
    head: string;
    body: string;
    signature: {
        keyId: string;
        value: string;
    };
};
export type ChelFileManifest = {
    version: '1.0.0';
    type?: string;
    meta?: unknown;
    cipher: string;
    'cipher-params'?: unknown;
    size: number;
    chunks: [number, string][];
    'name-map'?: Record<string, string>;
    alternatives?: Record<string, {
        type?: string;
        meta?: unknown;
        size: number;
    }>;
};
export type ChelContractKey = {
    id: string;
    name: string;
    purpose: string[];
    ringLevel: number;
    permissions: '*' | string[];
    allowedActions?: '*' | string[];
    _notBeforeHeight: number;
    _notAfterHeight?: number | undefined;
    _private?: string;
    foreignKey?: string;
    meta?: {
        quantity?: number;
        expires?: number;
        private?: {
            transient?: boolean;
            content?: string;
            shareable?: boolean;
            oldKeys?: string;
        };
        keyRequest?: {
            contractID: string;
            reference: string;
            responded: string;
        };
    };
    data: string;
};
export type ChelContractState = {
    _vm: {
        authorizedKeys: Record<string, ChelContractKey>;
        invites?: Record<string, {
            status: string;
            initialQuantity?: number;
            quantity?: number;
            expires?: number;
            inviteSecret: string;
            responses: string[];
        }>;
        type: string;
        pendingWatch?: Record<string, [fkName: string, fkId: string][]>;
        keyshares?: Record<string, {
            success?: boolean;
            contractID: string;
            height: number;
            hash?: string;
        }>;
        sharedKeyIds?: {
            id: string;
            contractID: string;
            height: number;
            foreignContractIDs?: ([contractID: string, firstShareHeight: number] | [contractID: string, firstShareHeight: number, lastShareHeight: number])[];
            keyRequestHash?: string;
            keyRequestHeight?: number;
        }[];
        pendingKeyshares?: Record<string, [isPrivate: boolean, height: number, signingKeyId: string] | [
            isPrivate: boolean,
            height: number,
            signingKeyId: string,
            SignedDataContext
        ] | [
            isPrivate: boolean,
            height: number,
            signingKeyId: string,
            SignedDataContext,
            request: string,
            manifest: string,
            skipInviteAccounting: boolean
        ]>;
        props?: Record<string, JSONType>;
    };
    _volatile?: {
        pendingKeyRequests?: {
            contractID: string;
            hash: string;
            name: string;
            reference?: string;
        }[];
        pendingKeyRevocations?: Record<string, 'del' | true>;
        watch?: [fkName: string, fkId: string][];
        dirty?: boolean;
        resyncing?: boolean;
    };
};
export type ChelRootState = {
    [x: string]: ChelContractState;
} & {
    contracts: Record<string, {
        type?: string;
        HEAD: string;
        height: number;
        previousKeyOp: string;
        missingDecryptionKeyIds?: string[];
        _journal?: {
            entries: JournalEntry[];
        };
    }>;
    secretKeys: Record<string, string>;
    _kv?: Record<string, Record<string, KvMirrorEntry>>;
};
export type Response = {
    type: ResType;
    err?: string;
    data?: JSONType;
};
export type ParsedEncryptedOrUnencryptedMessage<T> = Readonly<{
    contractID: string;
    innerSigningKeyId?: string | null | undefined;
    encryptionKeyId?: string | null | undefined;
    signingKeyId: string;
    data: T;
    signingContractID?: string | null | undefined;
    innerSigningContractID?: string | null | undefined;
}>;
export type ChelKvGetResult<T = JSONType> = ParsedEncryptedOrUnencryptedMessage<T> & {
    etag: string | null;
};
/**
 * Callback supplied to `chelonia/kv/set` to resolve a `409` / `412`
 * conflict (or to populate the body when `data` was omitted and the
 * primitive performs a fetch-first GET — see the `data === undefined`
 * branch in `src/chelonia.ts`).
 *
 * Return either:
 *   - `[newData, ifMatch]` to retry the write with `newData` against
 *     etag `ifMatch`. `ifMatch` may be `undefined` when the server
 *     returned neither `x-cid` nor `etag` (typical for 404 / 410
 *     fall-throughs) — the primitive substitutes `''` at the wire so
 *     the POST still goes through.
 *   - **any falsy value** (`false`, `null`, `undefined`, `0`, `''`)
 *     to abort the write without an HTTP call. The slot API
 *     (`chelonia/kv/update`) relies on this to honour `KV_NOOP` and
 *     to short-circuit empty-data GETs.
 *
 * NOTE: this is a behaviour change vs. pre-KV-revamp consumers, who
 * could only return a tuple. Any consumer that previously returned a
 * non-tuple falsy value (rare — historically this threw downstream)
 * will now silently no-op. Direct callers of `chelonia/kv/set` should
 * audit their implementations accordingly; the high-level
 * `chelonia/kv/update` API is unaffected.
 */
export type ChelKvOnConflictCallback = (args: {
    contractID: string;
    key: string;
    failedData?: JSONType;
    status: number;
    etag: string | null | undefined;
    currentData: JSONType | undefined;
    currentValue: ParsedEncryptedOrUnencryptedMessage<JSONType> | undefined;
}) => Promise<[JSONType, string | undefined] | false>;
