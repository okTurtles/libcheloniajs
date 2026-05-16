/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'
import type { SPMessage, SPMsgDirection, SPOpType } from './SPMessage.js'
import type { EncryptedData } from './encryptedData.js'
import type { PubSubClient } from './pubsub/index.js'
import type { SignedDataContext } from './signedData.js'

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
  journal?: JournalConfig;
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
    }
  | {
      kind: 'patch';
      hash: string;
      height: number;
      opType: string;
      // See the note on the snapshot variant: `description` is NOT redacted.
      description?: string;
      patch: JournalPatch[];
    };

// A single redaction directive. `path` uses dotted segments and supports a
// literal `*` segment to match any single key (object key or array index).
// `redact` is invoked with the value found at the path and the resolved
// segments; it MUST return a redacted replacement value and MUST NOT mutate
// the input.
export type JournalRedaction = {
  path: string;
  redact: (value: unknown, fullPath: string[]) => unknown;
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
  methods: Record<string, string>;
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
  defContractSelectors: string[];
  defContractManifest: string;
  defContractSBP: typeof sbp;
  defContract: CheloniaContractCtx;
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

export type ChelKvOnConflictCallback = (args: {
  contractID: string;
  key: string;
  failedData?: JSONType;
  status: number;
  etag: string | null | undefined;
  currentData: JSONType | undefined;
  currentValue: ParsedEncryptedOrUnencryptedMessage<JSONType> | undefined;
}) => Promise<[JSONType, string]>;
