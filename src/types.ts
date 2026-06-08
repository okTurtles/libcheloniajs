/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'
import type { SPMessage, SPMsgDirection, SPOpType } from './SPMessage.js'
import type { EncryptedData } from './encryptedData.js'
import type { PubSubClient } from './pubsub/index.js'
import type { SignedDataContext } from './signedData.js'
import type { KvNoop } from './kv.js'

export type JSONType = null | string | number | boolean | JSONObject | JSONArray;
export interface JSONObject {
  [x: string]: JSONType;
}
export type JSONArray = Array<JSONType>;

export type ResType =
  | ResTypeErr
  | ResTypeOK
  | ResTypeAlready
  | ResTypeSub
  | ResTypeUnsub
  | ResTypeEntry
  | ResTypePub;
export type ResTypeErr = 'error';
export type ResTypeOK = 'success';
export type ResTypeAlready = 'already';
export type ResTypeSub = 'sub';
export type ResTypeUnsub = 'unsub';
export type ResTypePub = 'pub';
export type ResTypeEntry = 'entry';

export type CheloniaConfig = {
  // eslint-disable-next-line no-unused-vars
  [_ in `preOp_${SPOpType}`]?: (message: SPMessage, state: ChelContractState) => boolean;
} & {
  // eslint-disable-next-line no-unused-vars
  [_ in `postOp_${SPOpType}`]?: (message: SPMessage, state: ChelContractState) => boolean;
} & {
  connectionURL: string;
  stateSelector: string;
  contracts: {
    defaults: {
      // '<module name>' => resolved module import
      modules: Record<string, unknown>;
      exposedGlobals: object;
      allowedDomains: string[];
      allowedSelectors: string[];
      preferSlim: boolean;
    };
    // TODO: Currently not used
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
  // Strict ordering will throw on past events with ChelErrorAlreadyProcessed
  // Similarly, future events will not be reingested and will throw
  // with ChelErrorDBBadPreviousHEAD
  strictOrdering: boolean;
  // Store information such as the date the message was received (_private_hidx=)
  saveMessageMetadata: boolean;
  connectionOptions: {
    maxRetries: number;
    reconnectOnTimeout: boolean;
  };
  preOp?: (message: SPMessage, state: ChelContractState) => boolean;
  postOp?: (message: SPMessage, state: ChelContractState) => boolean;
  hooks: Partial<{
    preHandleEvent: { (message: SPMessage): Promise<void> } | null;
    postHandleEvent: { (message: SPMessage): Promise<void> } | null;
    processError: {
      (e: unknown, message: SPMessage | null | undefined, meta: object | null | undefined): void;
    } | null;
    sideEffectError: { (e: unknown, message?: SPMessage): void } | null;
    handleEventError: { (e: unknown, message?: SPMessage): void } | null;
    syncContractError: { (e: unknown, contractID: string): void } | null;
    pubsubError: { (e: unknown, socket: PubSubClient): void } | null;
  }>;
  skipDecryptionAttempts: boolean;
  unwrapMaybeEncryptedData: <T>(data: T | EncryptedData<T>) =>
    | {
        encryptionKeyId: string | null;
        data: T;
      }
    | undefined;
  journal?: JournalConfig | null;
};

// JSON-Patch (RFC 6902) strict subset emitted/consumed by the journal.
// Only add/remove/replace are produced. `path` is a JSON-Pointer (RFC 6901).
// `value` is required on add/replace and absent on remove, mirroring RFC
// 6902 so the output is consumable by any standards-conformant JSON Patch
// implementation (and vice versa).
export type JournalPatch =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type JournalEntry =
  | {
      kind: 'snapshot';
      hash: string;
      height: number;
      opType: string;
      // The event's `SPMessage.description()` output (raw, never passed
      // through `redactions`). For unencrypted ops this can include the
      // action name and action-data fragments; treat it as journal-visible.
      // Callers worried about leakage should either strip `description`
      // before persisting `entries` or rely exclusively on encrypted ops.
      description?: string;
      // Redacted deep clone of the per-contract state AFTER this event was
      // processed. May be `null` if the contract state was undefined (e.g.,
      // failed first-message processing).
      state: unknown;
      // Populated when the event's `processMutation` threw and Chelonia
      // discarded the mutation. Snapshots are emitted on the first entry
      // for a contract and on resync / forward-gap re-seeds, so a failure
      // on any of those paths would otherwise lose the captured error
      // detail that patch entries preserve. Same shape, same trust level,
      // and same NOT-redacted caveat as the patch variant's `error`.
      error?: { name: string; message: string };
    }
  | {
      kind: 'patch';
      hash: string;
      height: number;
      opType: string;
      // See the note on the snapshot variant: `description` is NOT redacted.
      description?: string;
      patch: JournalPatch[];
      // Populated when the event's `processMutation` threw and Chelonia
      // discarded the mutation (the resulting patch is therefore empty).
      // Captured as plain fields rather than the live `Error` so the
      // journal stays JSON-serializable. `name` mirrors `Error.name`
      // (e.g. `'ChelErrorDecryptionKeyNotFound'`); `message` is the raw
      // error message and is NOT passed through `redactions` — for
      // unencrypted ops it can echo action data, treat it at the same
      // trust level as `description`.
      error?: { name: string; message: string };
    };

// A single redaction directive. `path` uses dotted segments and supports a
// literal `*` segment to match any single key (object key or array index).
// `redact` is invoked with the value found at the path, the resolved
// segments, and the contract's name/type (e.g. `gi.contracts/group`) so a
// shared redactor can branch on which contract the value belongs to. It
// MUST return a redacted replacement value and MUST NOT mutate the input.
export type JournalRedaction = {
  path: string;
  redact: (value: unknown, fullPath: string[], contractName: string) => unknown;
};

export type JournalConfig = {
  enabled?: boolean;
  snapshotInterval?: number;
  // When omitted or empty, applies to all contracts (provided `enabled` is
  // true). Otherwise only listed contractIDs are journaled.
  contractIDs?: string[];
  redactions?: JournalRedaction[];
  diff?: (before: unknown, after: unknown) => JournalPatch[];
  applyPatch?: (state: unknown, patches: JournalPatch[]) => unknown;
};

// ---------------------------------------------------------------------------
// KV slot API (see KV-REVAMPED.md and src/kv.ts).
// ---------------------------------------------------------------------------

// Reducer signature for `chelonia/kv/update`. The reducer receives the latest
// known value (mirror on first attempt; server `currentData` on conflict
// retry), or `undefined` when no mirror value and no `defaultValue` exist, and
// returns the next value, or the `KV_NOOP` sentinel to abort the write. See
// KV-REVAMPED.md §3.3.
export type KvUpdater<T> = (prev: T | undefined) => T | KvNoop;

// Status of a KV slot's mirror entry. See KV-REVAMPED.md §5.
export type KvLoadStatus = 'non-init' | 'loading' | 'loaded' | 'error';

// Shape of a single KV mirror entry under `rootState._kv[contractID][key]`.
// See KV-REVAMPED.md §5.
export type KvMirrorEntry = {
  value: JSONType | undefined;
  etag: string | null;
  status: KvLoadStatus;
  lastError?: { name: string; message: string };
};

// Context passed to `onUpdate` and embedded in the `CHELONIA_KV_UPDATED`
// event payload. See KV-REVAMPED.md §4.1.
export type KvUpdateCtx = {
  contractID: string;
  // Resolved from `rootState.contracts[contractID].type`
  // (fallback: `rootState[contractID]._vm.type`).
  contractType: string;
  key: string;
  reason: 'load' | 'remote' | 'local' | 'reconnect';
  etag: string | null;
  // Mirror value before this update; `undefined` on first load.
  previousValue: JSONType | undefined;
};

// Public subset of the internal `SlotDefinition`. Accepted by
// `chelonia/kv/defineSlot`. See KV-REVAMPED.md §4.1.
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
  schema?: { parse: (value: unknown) => JSONType };
  match?: (contractID: string, contractState: object, rootState: object) => boolean;
  encryptionKeyName?: string;
  signingKeyName?: string;
  // Optional default reducer factory; enables the `value`-form of
  // `chelonia/kv/update`. See KV-REVAMPED.md §4.1 / §4.2.
  defaultUpdater?: (value: JSONType) => KvUpdater<JSONType>;
  autoSubscribe?: boolean;
  autoLoad?: 'on-sync' | 'on-demand' | 'never';
  refreshOnReconnect?: boolean;
  onUpdate?: (value: JSONType | undefined, ctx: KvUpdateCtx) => void | Promise<void>;
};

export type SlotDefinitionSource =
  | { kind: 'defineContract'; manifest: string }
  | { kind: 'defineSlot' }

// Note: there is intentionally no public-facing `_source` field on
// `KvSlotDefinition`. The manifest-ownership marker is passed
// out-of-band as a second argument to the internal
// `chelonia/kv/_defineSlotInternal` selector, so userland callers
// cannot spoof `kind: 'defineContract'` and trick
// `_cleanupContractSlots` into unregistering another contract's
// slots.

// Internal, resolved form of a slot definition. Built from a
// `KvSlotDefinition` at `chelonia/kv/defineSlot` time: defaults applied,
// `resolvedDefault` computed, `contractType` narrowed to a single string
// (the public form accepts an array; each entry is stored as its own
// `SlotDefinition`). NOT re-exported from `index.ts` — internal only.
export type SlotDefinition = {
  contractType: string;
  key: string;
  defaultValue?: JSONType | (() => JSONType);
  resolvedDefault: JSONType | undefined;
  schema?: { parse: (value: unknown) => JSONType };
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
  getters: Record<
    string,
    <T extends object, K extends keyof T>(state: ChelContractState, obj: T) => T[K]
  >;
  name: string;
  manifest: string;
  metadata: {
    create: () => object | Promise<object>;
    validate: (
      meta: object,
      { state, contractID, ...gProxy }: { state: ChelContractState; contractID: string },
    ) => void | Promise<void>;
  };
  sbp: typeof sbp;
  state: (contractID: string) => ChelContractState;
  actions: Record<
    string,
    {
      validate: (
        data: object,
        {
          state,
          meta,
          message,
          contractID,
          ...gProxy
        }: {
          state: ChelContractState;
          meta: object;
          message: ChelContractProcessMessageObject;
          contractID: string;
        },
      ) => void | Promise<void>;
      process: (
        message: ChelContractProcessMessageObject,
        { state, ...gProxy }: { state: ChelContractState },
      ) => void | Promise<void>;
      sideEffect?: (
        mutation: ChelContractSideeffectMutationObject,
        { state, ...gProxy }: { state: ChelContractState },
      ) => void | Promise<void>;
    }
  >;
  methods: Record<string, (...args: unknown[]) => unknown>;
  // Optional declarative KV slot block — sugar over
  // `chelonia/kv/defineSlot`. See KV-REVAMPED.md §4.8. Each entry is
  // registered as if the consumer had called `defineSlot` with
  // `contractType: manifest` and `key` set from the entry name.
  kv?: Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>;
};
export type CheloniaContext = {
  config: CheloniaConfig;
  _instance: object;
  abortController: AbortController;
  state: {
    contracts: Record<string, { type: string; HEAD: string }>;
    pending: string[];
    [x: string]: unknown;
  };
  manifestToContract: Record<
    string,
    { slim: boolean; info: string; contract: CheloniaContractCtx, name: string }
  >;
  whitelistedActions: Record<string, true>;
  currentSyncs: Record<string, { firstSync: boolean }>;
  postSyncOperations: Record<string, Record<string, Parameters<typeof sbp>>>;
  sideEffectStacks: Record<string, Parameters<typeof sbp>[]>;
  sideEffectStack: (contractID: string) => Array<Parameters<typeof sbp>>;
  setPostSyncOp: (contractID: string, key: string, op: Parameters<typeof sbp>) => void;
  transientSecretKeys: Record<string, Key>;
  ephemeralReferenceCount: Record<string, number>;
  subscriptionSet: Set<string>;
  pending: { contractID: string }[];
  pubsub: import('./pubsub/index.js').PubSubClient;
  contractsModifiedListener: (
    contracts: Set<string>,
    { added, removed }: { added: string[]; removed: string[] },
  ) => void;
  kvReconnectListener?: (client: import('./pubsub/index.js').PubSubClient) => void;
  kvContractsModifiedListener?: (
    contracts: Set<string>,
    { added, removed }: { added: string[]; removed: string[] },
  ) => void;
  defContractSelectors: string[];
  defContractManifest: string;
  defContractSBP: typeof sbp;
  defContract: CheloniaContractCtx;
  // KV slot registry — see KV-REVAMPED.md §11.2.
  // Primary registry keyed by `${contractType}::${key}`.
  kvSlots: Map<string, SlotDefinition>;
  // Secondary index for O(1) pubsub dispatch: contractID → (key → slot).
  kvSlotsByContractID: Map<string, Map<string, SlotDefinition>>;
  // Effective filter cache per contract — used to coalesce setFilter.
  kvActiveFilters: Map<string, Set<string>>;
  // Microtask flush set for setFilter coalescing (see §11.5).
  kvFilterDirty: Set<string>;
  // Locally-generated write nonces awaiting self-echo suppression.
  // Keyed by `${contractID}::${key}`.
  kvLocalEchoNonces: Map<string, Set<string>>;
  // Per-contract count of queued/in-flight `chelonia/kv/update` /
  // `chelonia/kv/clear` operations. Incremented at call time (before the
  // write body is enqueued, while the slot may still be active) and
  // decremented when the queued body settles. `chelonia/kv/_waitInFlight`
  // drains every contract with a non-zero count so a write whose slot
  // index entry / echo nonce was removed mid-flight (e.g. contract
  // release, match→false) still settles before `chelonia/reset` tears
  // down state.
  kvPendingWrites: Map<string, number>;
  // Previous `kv` block per manifest, used by `defineContract`
  // replacement to diff against the new block.
  defContractKvByManifest: Map<string, Record<string, Omit<KvSlotDefinition, 'key' | 'contractType'>>>;
};

export type ChelContractManifestBody = {
  name: string;
  version: string;
  contract: { hash: string; file: string };
  contractSlim: { hash: string; file: string };
  signingKeys: string[];
};

export type ChelContractManifest = {
  head: string; // '{ manifestVersion : 1.0.0" }'
  body: string; // 'ChelContractManifestBody'
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
  alternatives?: Record<string, { type?: string; meta?: unknown; size: number }>;
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
    invites?: Record<
      string,
      {
        status: string;
        initialQuantity?: number;
        quantity?: number;
        expires?: number;
        inviteSecret: string;
        responses: string[];
      }
    >;
    type: string;
    pendingWatch?: Record<string, [fkName: string, fkId: string][]>;
    keyshares?: Record<
      string,
      { success?: boolean; contractID: string; height: number; hash?: string }
    >;
    sharedKeyIds?: {
      id: string;
      contractID: string;
      height: number;
      // List of contract IDs the key share is addressed to
      foreignContractIDs?: (
        | [contractID: string, firstShareHeight: number]
        | [contractID: string, firstShareHeight: number, lastShareHeight: number]
      )[];
      keyRequestHash?: string;
      keyRequestHeight?: number;
    }[];
    pendingKeyshares?: Record<
      string,
      | [isPrivate: boolean, height: number, signingKeyId: string]
      | [
          isPrivate: boolean,
          height: number,
          signingKeyId: string,
          SignedDataContext,
        ]
      | [
          isPrivate: boolean,
          height: number,
          signingKeyId: string,
          SignedDataContext,
          request: string,
          manifest: string,
          skipInviteAccounting: boolean
        ]
    >;
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
  // By default, assume that all subentries are contracts
  [x: string]: ChelContractState;
} & {
  // Contract meta-information
  contracts: Record<
    string,
    {
      type?: string;
      HEAD: string;
      height: number;
      previousKeyOp: string;
      missingDecryptionKeyIds?: string[];
      _journal?: { entries: JournalEntry[] };
    }
  >;
  // Secret keys. Format secretKeys[keyId] = serializedSecretKey
  secretKeys: Record<string, string>;
  // KV slot mirror — see KV-REVAMPED.md §5. Indexed by contractID then
  // slot key. `null` is reserved as the wire-level clear sentinel and
  // MUST NOT appear as a stored value.
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
  etag: string | null
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
