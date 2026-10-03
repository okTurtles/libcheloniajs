/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'
import type { SPMessage, SPMsgDirection, SPOpType } from './SPMessage.js'
import type { EncryptedData } from './encryptedData.js'
import type { PubSubClient } from './pubsub/index.js'
import type { SignedDataContext } from './signedData.js'
import type {
  KV_AUTO_LOAD,
  KV_LOAD_STATUS,
  KV_UPDATE_REASON,
  KvNoop
} from './kv-constants.js'

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

// A v4 UUID. Loose on purpose: it only pins the five hyphen-separated groups,
// which is enough to keep an arbitrary string out.
export type UUIDV4 = `${string}-${string}-${string}-${string}-${string}`;

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
//
// `redacted` marks an operation that exists solely to record that a
// redacted value changed: the underlying state moved, but its redacted
// projection did not, so the operation writes the redacted value back over
// itself (an identity edit). Applying it is a no-op, and RFC 6902 §4
// requires appliers to ignore members it does not define, so the marker is
// safe to feed to any conformant JSON Patch implementation.
//
// `redacted?: undefined` is declared on the `remove` arm so the member is
// readable on an un-narrowed `JournalPatch` (reading it there yields
// `undefined`) while still rejecting a literal `redacted` on a remove op.
export type JournalPatch =
  | { op: 'add' | 'replace'; path: string; value: unknown; redacted?: true }
  | { op: 'remove'; path: string; redacted?: undefined };

// A single redacted leaf recorded while `applyRedactions` walked the state:
// the value found there before redaction and the value that replaced it.
//
// `original` is a live reference into the state that was passed to
// `applyRedactions`, not a copy: it exists so change detection can compare
// pre-redaction values, and it is never persisted. Treat it as read-only and
// read it before the underlying state can change. `replacement` is the value
// that actually ended up in the projection, so it is safe to keep.
export type RedactionSite = {
  original: unknown;
  replacement: unknown;
};

// Redacted leaves keyed by their RFC-6901 JSON-Pointer path.
export type RedactionSiteMap = Map<string, RedactionSite>;

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
      // Populated when the configured `redactions` threw while projecting
      // this event's state. This is a journal-side failure: `state` is
      // `null` because no projection could be produced, and the field is
      // recorded so a null state is not misread as "the contract state
      // was undefined". Independent of `error`, which says whether the
      // *event* also failed — both can be present at once.
      redactionError?: { name: string; message: string };
      // Copied forward from the patch entry that triggered an
      // auto-snapshot at a snapshot boundary, so trimming cannot orphan
      // the detail. See the patch variant for the semantics.
      diffError?: { name: string; message: string };
      // Set when this snapshot's `state` was recovered by replaying the
      // journal window rather than taken from the event's own post-state,
      // which happens when that event's redacted projection failed. The
      // snapshot is still replay-equivalent — `reconstruct` returns the
      // same value before and after the window is trimmed down to it — but
      // its `state` predates the events whose projections failed, so it is
      // NOT the contract state at this entry's `height`. Always accompanied
      // by `redactionError`.
      replayed?: true;
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
      // Populated when the configured `diff` threw while journaling this
      // event. The event itself processed fine — this is a journal-side
      // failure, recorded so the resulting `patch: []` is not misread as
      // "this event changed nothing". `reconstruct` silently misses this
      // event's changes until the next snapshot re-seeds the window.
      // Same NOT-redacted caveat as `error`.
      diffError?: { name: string; message: string };
      // Populated when the configured `redactions` threw while projecting
      // this event's before- or after-state. The diff is skipped entirely
      // (`patch: []`) rather than diffing against a missing projection,
      // which would emit a bogus whole-root operation. Same staleness and
      // NOT-redacted caveats as `diffError`. Unlike `diffError` this can
      // accompany `error`: an errored event still runs the
      // after-projection, so a throwing redactor is reachable there.
      redactionError?: { name: string; message: string };
    };

// A single redaction directive. `path` uses dotted segments and supports a
// literal `*` segment to match any single key (object key or array index).
// `redact` is invoked with the value found at the path, a disposable copy
// of the resolved segments, and the contract's name/type (e.g.
// `gi.contracts/group`) so a shared redactor can branch on which contract
// the value belongs to. It MUST be pure, MUST NOT mutate its arguments,
// and MUST return a JSON-safe replacement (null / string / boolean /
// finite number / arrays / plain objects thereof): the journal is
// persisted as plain JSON. Non-JSON-safe results are substituted with a
// sentinel (see `REDACTION_NON_JSON_SAFE_SENTINEL`).
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
  // When true (the default), a change to a value whose redacted projection
  // is constant is still recorded, as an identity `replace` carrying
  // `redacted: true`. Without it such changes are invisible in the journal
  // and indistinguishable from an event that did nothing. Set to false to
  // emit only the minimal diff (e.g. when a custom `diff` / `applyPatch`
  // pair does not use RFC-6901 pointers).
  markRedactedChanges?: boolean;
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
export type KvLoadStatus = typeof KV_LOAD_STATUS[keyof typeof KV_LOAD_STATUS];

// Shape of a single KV mirror entry under `rootState._kv[contractID][key]`.
// See KV-REVAMPED.md §5.
export type KvMirrorEntry = {
  value: JSONType | undefined;
  etag: string | null;
  status: KvLoadStatus;
  lastError?: { name: string; message: string };
  // `true` once the slot has reached a terminal outcome since it was last
  // activated: a load (value or 404), an applied remote frame, a committed
  // local write or clear, or a terminal error. Tells a settled `'non-init'`
  // (the server has no value) apart from a pending one. Always present on
  // entries of active slots; entries persisted by older versions may lack
  // it until their slot is activated, so treat a missing value as `false`.
  // See KV-REVAMPED.md §4.3.
  settled?: boolean;
};

// What `chelonia/kv/set` knows about the server value it received with a
// conflict (or fetch-first GET) response. See KV-REVAMPED.md §3.4.
//   - 'absent':  the server holds no value for the key.
//   - 'present': the server value was decoded and verified.
//   - 'ahead':   the server value was written at a contract height the
//                local contract has not reached, so it cannot be verified.
export type KvServerValueStatus = 'absent' | 'present' | 'ahead';

// `.cause` of `ChelErrorKvHeightAhead`.
export type KvHeightAheadCause = {
  // The local contract must reach this height before the operation can
  // succeed. Read from the unverified server value (or inferred from a 409);
  // only ever used as a wait target.
  requiredHeight: number;
  // `true` when `requiredHeight` is the height stamp of a value the server
  // returned; `false` when it is a lower bound inferred from a 409.
  exact: boolean;
  // The local contract height when the error was raised.
  localHeight: number | undefined;
  // The server's ETag for the key, when the response carried one.
  etag: string | null;
  // HTTP status of the response that revealed the height gap.
  status: number;
};

// What `chelonia/kv/update`, `chelonia/kv/clear` and
// `chelonia/kv/queuedSet` do when the server value is ahead of the local
// contract: sync the contract outside the queue lane and try again
// (`'sync'`, the default), or reject with `ChelErrorKvHeightAhead`.
export type KvHeightAheadMode = 'sync' | 'reject';

// A callback waiting for a contract to reach `minHeight`. See
// `src/kv-height.ts`.
export type KvHeightListener = { minHeight: number; fire: () => void };

// A slot load deferred until the local contract reaches `requiredHeight`.
// See `kvHeightWaits` below and `src/kv.ts`.
export type KvHeightWait = {
  contractID: string;
  key: string;
  requiredHeight: number;
  // The `reason` of the first registration for the key. Later registrations
  // merged into this wait raise `requiredHeight` but keep this `reason`, so
  // the reload reports the first trigger (e.g. `'load'` even when a later
  // pubsub frame raised the height). The reloaded value is the latest.
  reason: Exclude<KvUpdateCtx['reason'], 'local'>;
  // Removes the height listener backing this wait.
  off: () => void;
  // Fallback timer; `undefined` once it has fired.
  timer: ReturnType<typeof setTimeout> | undefined;
};

// Context passed to `onUpdate` and embedded in the `CHELONIA_KV_UPDATED`
// event payload. See KV-REVAMPED.md §4.1.
export type KvUpdateCtx = {
  contractID: string;
  // Resolved from `rootState.contracts[contractID].type`
  // (fallback: `rootState[contractID]._vm.type`).
  contractType: string;
  key: string;
  reason: typeof KV_UPDATE_REASON[keyof typeof KV_UPDATE_REASON];
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
  encryptionKeyName?: string | null;
  signingKeyName?: string;
  // Optional default reducer factory; enables the `value`-form of
  // `chelonia/kv/update`. See KV-REVAMPED.md §4.1 / §4.2.
  defaultUpdater?: (value: JSONType) => KvUpdater<JSONType>;
  autoSubscribe?: boolean;
  autoLoad?: typeof KV_AUTO_LOAD[keyof typeof KV_AUTO_LOAD];
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
  encryptionKeyName: string | null;
  signingKeyName: string;
  defaultUpdater?: (value: JSONType) => KvUpdater<JSONType>;
  autoSubscribe: boolean;
  autoLoad: typeof KV_AUTO_LOAD[keyof typeof KV_AUTO_LOAD];
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
  // `contractType` set to the contract name and `key` set from the entry name.
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
    contracts: string[],
    { added, removed }: { added: string[]; removed: string[] },
  ) => void;
  kvReconnectListener?: (client: import('./pubsub/index.js').PubSubClient) => void;
  kvContractsModifiedListener?: (
    contracts: string[],
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
  // Re-entrancy guard for the setFilter flush loop — ensures a single
  // draining loop instead of concurrent racing flushes (see §11.5).
  kvFlushInFlight: boolean;
  // Contracts whose last `setFilter` flush failed transiently and are
  // awaiting a backoff retry. Held separately from `kvFilterDirty` so the
  // drain loop does not hot-spin re-sending a failing filter within the
  // same pass; a single deferred timer moves these back into
  // `kvFilterDirty` and re-flushes so the server's filter set converges
  // without waiting for the next slot change to re-dirty the contract.
  kvFilterRetry: Set<string>;
  // Handle for the deferred timer scheduled by `scheduleFilterRetry`.
  // Tracked so `chelonia/reset` can `clearTimeout` it and release the
  // closure pinning `ctx` immediately, rather than waiting for the timer
  // to fire (harmlessly) against the now-empty `kvFilterRetry` set.
  kvFilterRetryTimer?: ReturnType<typeof setTimeout>;
  // Server-issued data CIDs awaiting self-echo suppression.
  // Keyed by `${contractID}::${key}`; inner map value carries expiry + source.
  kvLocalEchoCIDs: Map<string, Map<string, { expiry: number; fromConflict: boolean }>>;
  kvReconnectRefresh: Set<string>;
  // Per-contract count of queued/in-flight `chelonia/kv/update` /
  // `chelonia/kv/clear` operations. Incremented at call time (before the
  // write body is enqueued, while the slot may still be active) and
  // decremented when the queued body settles. `chelonia/kv/_waitInFlight`
  // drains every contract with a non-zero count so a write whose slot
  // index entry / echo CID was removed mid-flight (e.g. contract
  // release, match→false) still settles before `chelonia/reset` tears
  // down state.
  kvPendingWrites: Map<string, number>;
  // Per-contract count of queued/in-flight `chelonia/kv/_loadSlotNow`
  // fetches (autoload, explicit sync, reconnect refresh, and the
  // authoritative GETs `_handleRemote` issues for conflict resolution /
  // no-cid frames). Incremented inside the load body and decremented
  // when it settles. NOTE: a load initiated via the public queued
  // wrapper `_loadSlot` is counted twice — once on schedule (in
  // `_loadSlot`) and again on entry (in `_loadSlotNow`) — because both
  // the wrapper and the inner function serve direct callers that need
  // the counter. The only consumer is `defineSlot`'s `> 0` gate, so the
  // inflation is harmless; do NOT rely on the exact count for telemetry
  // or "exactly one load in flight" assertions. `defineSlot`'s
  // post-reconcile gate consults this so replacing a slot whose load is
  // merely queued (not yet running, so its status is still `loaded`)
  // schedules a fresh load for the replacement instead of revalidating a
  // value the superseded load is about to discard at its staleness guard
  // — which would otherwise leave the mirror silently stale.
  kvPendingLoads: Map<string, number>;
  // Per-contract count of `onUpdate` callbacks currently executing
  // inside the contract's `chelonia/queueInvocation` lane. A KV write
  // selector (`update`/`clear`/`sync`) invoked while this is non-zero
  // for the same contract would enqueue behind the lane that is blocked
  // awaiting the callback → permanent deadlock, so those selectors
  // reject with `ChelErrorKvReentrant` instead. Keyed by `contractID`
  // to match the lane granularity exactly (cross-contract writes from
  // `onUpdate` are safe and not rejected).
  kvOnUpdateActive: Map<string, number>;
  // Callbacks waiting for a contract to reach a height, keyed by
  // contractID. Fired from `handleEvent.applyProcessResult` once the local
  // height is committed. Used both by the passive waits in
  // `chelonia/kv/set` and by `kvHeightWaits`. Runtime-only; see
  // `src/kv-height.ts`.
  kvHeightListeners: Map<string, Set<KvHeightListener>>;
  // Slots whose load (or pubsub frame) returned a value written at a
  // height the local contract has not reached, keyed by
  // `${contractID}::${key}`. The slot reloads once the height is reached;
  // a fallback timer forces a contract sync if it isn't. Runtime-only.
  kvHeightWaits: Map<string, KvHeightWait>;
  // In-flight forced contract syncs started to recover from
  // `ChelErrorKvHeightAhead`, keyed by contractID and shared by every
  // operation recovering on that contract. Awaited by
  // `chelonia/kv/_waitInFlight`. Runtime-only.
  kvRecoveries: Map<string, Promise<void>>;
  // Aborted by `chelonia/reset` as soon as it aborts the old session, and
  // replaced once the reset has torn that session down. While it is
  // aborted, no height wait can be registered and no height-recovery sync
  // can start: either would run into the next session. Runtime-only.
  kvHeightSession: AbortController;
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
 * NOTE: the type now advertises `false` as a valid return value where
 * previously the type only permitted a tuple. The runtime `if (!result)
 * return false` guard already existed pre-revamp, so a falsy return
 * always silently aborted at runtime — this is a type-level change, not
 * a runtime behaviour change. Direct callers of `chelonia/kv/set` need
 * not audit for a runtime regression; the high-level
 * `chelonia/kv/update` API is unaffected.
 */
export type ChelKvOnConflictCallback = (args: {
  contractID: string;
  key: string;
  failedData?: JSONType;
  status: number;
  etag: string | null | undefined;
  /**
   * What is known about the server value. `'absent'` means the server
   * holds no value, `'present'` that `currentData` is the verified server
   * value. `'ahead'` is only ever passed when the caller set
   * `allowUnverifiedConflict: true`; without it, `chelonia/kv/set` rejects
   * with `ChelErrorKvHeightAhead` instead of calling `onconflict`.
   * See KV-REVAMPED.md §3.4.
   */
  currentStatus: KvServerValueStatus;
  /**
   * Set when `currentStatus` is `'ahead'`: the contract height the local
   * contract must reach before the server value can be verified.
   */
  requiredHeight?: number;
  /**
   * The decrypted/verified server data for the conflicting key.
   * `undefined` means the server holds no value (`currentStatus` is
   * `'absent'`).
   *
   * **Throws on access.** The runtime value is a lazy getter (see
   * `resolveData` in `src/chelonia.ts`) that forces decryption and
   * signature verification the first time it is read, and may reject
   * with `ChelErrorDecryptionError` or `ChelErrorSignatureError`. When
   * `currentStatus` is `'ahead'` it throws `ChelErrorKvHeightAhead`.
   * Access it inside a `try`/`catch` (falling back to `undefined` or
   * re-throwing as appropriate), or read `currentValue.data` directly
   * with the same precaution. The bundled slot API (`chelonia/kv/update`,
   * `chelonia/kv/clear`) already guards access; this note applies to
   * direct `chelonia/kv/set` callers supplying a custom `onconflict`.
   */
  currentData: JSONType | undefined;
  currentValue: ParsedEncryptedOrUnencryptedMessage<JSONType> | undefined;
}) => Promise<[JSONType, string | undefined] | false>;
