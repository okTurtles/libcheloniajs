/* eslint-disable no-use-before-define */

import type { Key } from '@chelonia/crypto'
import type sbp from '@sbp/sbp'

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
  hooks: {
    preHandleEvent: null, // async (message: SPMessage) => {}
    postHandleEvent: null, // async (message: SPMessage) => {}
    processError: null, // (e: Error, message: SPMessage) => {}
    sideEffectError: null, // (e: Error, message: SPMessage) => {}
    handleEventError: null, // (e: Error, message: SPMessage) => {}
    syncContractError: null, // (e: Error, contractID: string) => {}
    pubsubError: null // (e:Error, socket: Socket)
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
  manifestToContract: Record<string, string>,
  whitelistedActions: Record<string, string>,
  currentSyncs: Record<string, { firstSync: boolean }>,
  postSyncOperations: Record<string, Record<string, Parameters<typeof sbp>>>,
  sideEffectStacks: Record<string, Parameters<typeof sbp>[]>,
  sideEffectStack: (contractID: string) => Array<Parameters<typeof sbp>>,
  setPostSyncOp: (contractID: string, key: string, op: Parameters<typeof sbp>) => void,
  transientSecretKeys: Record<string, Key>,
  ephemeralReferenceCount: Record<string, number>,
  subscriptionSet: Set<string>,
  pending: string[]
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
  meta?: {
    quantity?: number,
    expires?: number,
    private?: {
      transient?: boolean,
      content?: string,
      shareable?: boolean,
      oldKeys?: string
    }
  }
  data: string
}

export type ChelContractState = {
  _vm: {
    authorizedKeys: Record<string, ChelContractKey>
  }
}

export type Response = {
  type: ResType;
  err?: string;
  data?: JSONType
}
export type ChelKvOnConflictCallback = (
  args: { contractID: string, key: string, failedData: JSONType, status: number, etag: string | null | undefined, currentData: JSONType, currentValue: JSONType }
) => Promise<[JSONType, string]>
