/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'
import { PubSubClient } from './pubsub/index.js'
import { SPMessage } from './SPMessage.js'

export type JSONType =
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
  connectionURL: string,
  stateSelector: string,
  contracts: {
    defaults: {
      // '<module name>' => resolved module import
      modules: Record<string, unknown>,
      exposedGlobals: object,
      allowedDomains: string[],
      allowedSelectors: string[],
      preferSlim: boolean,
    },
    // TODO: Currently not used
    overrides: object,
    manifests: Record<string, string>
  },
  whitelisted: (action: string) => boolean,
  reactiveSet: <T> (obj: T, key: keyof T, value: T[typeof key]) => void
  fetch: typeof fetch,
  reactiveDel: <T> (obj: T, key: keyof T) => void,
  acceptAllMessages: boolean,
  skipActionProcessing: boolean,
  skipSideEffects: boolean,
  strictProcessing: boolean,
  // Strict ordering will throw on past events with ChelErrorAlreadyProcessed
  // Similarly, future events will not be reingested and will throw
  // with ChelErrorDBBadPreviousHEAD
  strictOrdering: boolean,
  connectionOptions: {
    maxRetries: number,
    reconnectOnTimeout: boolean,
  },
  preOp?: (message: SPMessage, state: ChelContractState) => boolean,
  hooks: {
    preHandleEvent?: { (message: SPMessage): Promise<void> } | null,
    postHandleEvent?: { (message: SPMessage): Promise<void> } | null,
    processError?: { (e: unknown, message: SPMessage | null | undefined, meta: object | null | undefined): void } | null,
    sideEffectError?: { (e: unknown, message?: SPMessage): void } | null,
    handleEventError?: { (e: unknown, message?: SPMessage): void } | null,
    syncContractError?: { (e: unknown, contractID: string): void } | null,
    pubsubError?: { (e: unknown, socket: PubSubClient): void } | null
  }
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
  manifestToContract: Record<string, { slim: boolean, info: string, contract: {
    metadata: {
      create: () => object | Promise<object>
    }
    state: (contractID: string) => ChelContractState
  } }>,
  whitelistedActions: Record<string, string>,
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
  defContractSelectors: string[]
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
      responses: string[]
    }>,
    type: string,
    pendingWatch?: Record<string, [fkName: string, fkId: string][]>,
    keyshares?: Record<string, { success: boolean, contractID: string, height: number, hash?: string }>,
    sharedKeyIds?: { id: string, contractID: string, height: number, keyRequestHash?: string, keyRequestHeight?: number }[],
    pendingKeyshares: Record<string, [isPrivate: boolean, height: number, signingKeyId: string] | [isPrivate: boolean, height: number, signingKeyId: string, ...unknown[]]>,
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
export type ChelKvOnConflictCallback = (
  args: { contractID: string, key: string, failedData?: JSONType, status: number, etag: string | null | undefined, currentData: JSONType, currentValue: JSONType }
) => Promise<[JSONType, string]>
