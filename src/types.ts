/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'
import type { SPMessage, SPMsgDirection, SPOpType } from './SPMessage.js'
import type { PubSubClient } from './pubsub/index.js'

export type JSONType =
    | null
    | string
    | number
    | boolean
    | JSONObject
    | JSONArray;
export interface JSONObject {
  [x: string]: JSONType;
}
export type JSONArray = Array<JSONType>;

export type ResType =
  | ResTypeErr | ResTypeOK | ResTypeAlready
  | ResTypeSub | ResTypeUnsub | ResTypeEntry | ResTypePub
export type ResTypeErr = 'error'
export type ResTypeOK = 'success'
export type ResTypeAlready = 'already'
export type ResTypeSub = 'sub'
export type ResTypeUnsub = 'unsub'
export type ResTypePub = 'pub'
export type ResTypeEntry = 'entry'

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
  connectionOptions: {
    maxRetries: number;
    reconnectOnTimeout: boolean;
  }; preOp?: (message: SPMessage, state: ChelContractState) => boolean;
  postOp?: (message: SPMessage, state: ChelContractState) => boolean;
  hooks: Partial<{
    preHandleEvent: { (message: SPMessage): Promise<void>; } | null;
    postHandleEvent: { (message: SPMessage): Promise<void>; } | null;
    processError: { (e: unknown, message: SPMessage | null | undefined, meta: object | null | undefined): void; } | null;
    sideEffectError: { (e: unknown, message?: SPMessage): void; } | null;
    handleEventError: { (e: unknown, message?: SPMessage): void; } | null;
    syncContractError: { (e: unknown, contractID: string): void; } | null;
    pubsubError: { (e: unknown, socket: PubSubClient): void; } | null;
  }>;
};

export type SendMessageHooks = Partial<{
  prepublish: (entry: SPMessage) => void | Promise<void>,
  onprocessed: (entry: SPMessage) => void,
  preSendCheck: (entry: SPMessage, state: ChelContractState) => boolean | Promise<boolean>,
  beforeRequest: (newEntry: SPMessage, oldEntry: SPMessage) => void | Promise<void>,
  postpublish: (entry: SPMessage) => void | Promise<void>,
}>

export type ChelContractProcessMessageObject = Readonly<{
  data: object,
  meta: object,
  hash: string,
  height: number,
  contractID: string,
  direction: SPMsgDirection,
  signingKeyId: string,
  signingContractID: string,
  innerSigningKeyId?: string | null | undefined,
  innerSigningContractID?: string | null | undefined
}>
export type ChelContractSideeffectMutationObject = Readonly<{
  data: object,
  meta: object,
  hash: string,
  height: number,
  contractID: string,
  description: string,
  direction: SPMsgDirection,
  signingKeyId: string,
  signingContractID: string,
  innerSigningKeyId?: string | null | undefined,
  innerSigningContractID?: string | null | undefined
}>

export type CheloniaContractCtx = {
  getters: Record<string, <T extends object, K extends keyof T> (state: ChelContractState, obj: T) => T[K]>,
  name: string,
  manifest: string,
  metadata: {
    create: () => object | Promise<object>
    validate: (meta: object, { state, contractID, ...gProxy }: { state: ChelContractState, contractID: string }) => void | Promise<void>,
  }
  sbp: typeof sbp
  state: (contractID: string) => ChelContractState,
  actions: Record<string, {
    validate: (data: object, { state, meta, message, contractID, ...gProxy }: { state: ChelContractState, meta: object, message: ChelContractProcessMessageObject, contractID: string }) => void | Promise<void>
    process: (message: ChelContractProcessMessageObject, { state, ...gProxy }: { state: ChelContractState }) => void | Promise<void>
    sideEffect?: (mutation: ChelContractSideeffectMutationObject, { state, ...gProxy }: { state: ChelContractState }) => void | Promise<void>
  }>,
  methods: Record<string, string>
}
export type CheloniaContext = {
  config: CheloniaConfig,
  _instance: object,
  abortController: AbortController,
  state: {
    contracts: Record<string, { type: string, HEAD: string }>,
    pending: string[],
    [x: string]: unknown
  },
  manifestToContract: Record<string, { slim: boolean, info: string, contract: CheloniaContractCtx }>,
  whitelistedActions: Record<string, true>,
  currentSyncs: Record<string, { firstSync: boolean }>,
  postSyncOperations: Record<string, Record<string, Parameters<typeof sbp>>>,
  sideEffectStacks: Record<string, Parameters<typeof sbp>[]>,
  sideEffectStack: (contractID: string) => Array<Parameters<typeof sbp>>,
  setPostSyncOp: (contractID: string, key: string, op: Parameters<typeof sbp>) => void,
  transientSecretKeys: Record<string, Key>,
  ephemeralReferenceCount: Record<string, number>,
  subscriptionSet: Set<string>,
  pending: { contractID: string }[],
  pubsub: import('./pubsub/index.js').PubSubClient,
  contractsModifiedListener: (contracts: Set<string>, { added, removed }: { added: string[], removed: string[] }) => void,
  defContractSelectors: string[],
  defContractManifest: string,
  defContractSBP: typeof sbp,
  defContract: CheloniaContractCtx
}

export type ChelContractManifestBody = {
  name: string,
  version: string,
  contract: { hash: string, file: string },
  contractSlim: { hash: string, file: string },
  signingKeys: string[]
}

export type ChelContractManifest = {
  head: string, // '{ manifestVersion : 1.0.0" }'
  body: string // 'ChelContractManifestBody'
  signature: {
    keyId: string,
    value: string
  }
}

export type ChelFileManifest = {
  version: '1.0.0',
  type?: string,
  meta?: unknown,
  cipher: string,
  'cipher-params'?: unknown,
  size: number,
  chunks: [number, string][],
  'name-map'?: Record<string, string>,
  alternatives?: Record<string, { type?: string, meta?: unknown, size: number }>
}

export type ChelContractKey = {
  id: string,
  name: string,
  purpose: string[],
  ringLevel: number,
  permissions: '*' | string[],
  allowedActions?: '*' | string[],
  _notBeforeHeight: number,
  _notAfterHeight?: number | undefined,
  _private?: string,
  foreignKey?: string,
  meta?: {
    quantity?: number,
    expires?: number,
    private?: {
      transient?: boolean,
      content?: string,
      shareable?: boolean,
      oldKeys?: string,
    },
    keyRequest?: {
      contractID: string,
      reference: string,
      responded: string
    }
  }
  data: string
}

export type ChelContractState = {
  _vm: {
    authorizedKeys: Record<string, ChelContractKey>,
    invites?: Record<string, {
      status: string,
      initialQuantity: number,
      quantity: number,
      expires: number,
      inviteSecret: string,
      responses: string[],
    }>,
    type: string,
    pendingWatch?: Record<string, [fkName: string, fkId: string][]>,
    keyshares?: Record<string, { success: boolean, contractID: string, height: number, hash?: string }>,
    sharedKeyIds?: { id: string, contractID: string, height: number, keyRequestHash?: string, keyRequestHeight?: number }[],
    pendingKeyshares: Record<string,
      | [isPrivate: boolean, height: number, signingKeyId: string]
      | [isPrivate: boolean, height: number, signingKeyId: string, [string, { _signedData: [string, string, string] }, number, string]]
    >,
    props: Record<string, JSONType>
  },
  _volatile?: {
    pendingKeyRequests?: {
      contractID: string,
      hash: string,
      name: string,
      reference?: string
    }[],
    pendingKeyRevocations?: Record<string, 'del' | true>,
    watch?: [fkName: string, fkId: string][],
    dirty?: boolean,
    resyncing?: boolean,
  }
}

export type ChelRootState = {
  [x: string]: ChelContractState
} & {
  contracts: Record<string, {
    type?: string,
    HEAD: string,
    height: number,
    previousKeyOp: string,
    missingDecryptionKeyIds?: string[]
  }>
}

export type Response = {
  type: ResType;
  err?: string;
  data?: JSONType
}

export type ParsedEncryptedOrUnencryptedMessage<T> = Readonly<{
  contractID: string,
  innerSigningKeyId?: string | null | undefined,
  encryptionKeyId?: string | null | undefined,
  signingKeyId: string,
  data: T,
  signingContractID?: string | null | undefined,
  innerSigningContractID?: string | null | undefined,
}>

export type ChelKvOnConflictCallback = (
  args: { contractID: string, key: string, failedData?: JSONType, status: number, etag: string | null | undefined, currentData: JSONType | undefined, currentValue: ParsedEncryptedOrUnencryptedMessage<JSONType> | undefined }
) => Promise<[JSONType, string]>
