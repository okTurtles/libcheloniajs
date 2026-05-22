import type { Key } from '@chelonia/crypto'
import {
  CURVE25519XSALSA20POLY1305,
  EDWARDS25519SHA512BATCH,
  XSALSA20POLY1305,
  keyId
} from '@chelonia/crypto'
import { serdesDeserializeSymbol, serdesSerializeSymbol, serdesTagSymbol } from '@chelonia/serdes'
import { has } from 'turtledash'
import type { EncryptedData } from './encryptedData.js'
import {
  encryptedIncomingData,
  encryptedIncomingForeignData,
  maybeEncryptedIncomingData,
  unwrapMaybeEncryptedData
} from './encryptedData.js'
import { createCID, multicodes } from './functions.js'
import type { RawSignedData, SignedData } from './signedData.js'
import {
  isRawSignedData,
  isSignedData,
  rawSignedIncomingData,
  signedIncomingData
} from './signedData.js'
import type { ChelContractKey, ChelContractState, JSONObject, JSONType } from './types.js'

export type SPKeyType =
  | typeof EDWARDS25519SHA512BATCH
  | typeof CURVE25519XSALSA20POLY1305
  | typeof XSALSA20POLY1305;

export type SPKeyPurpose = 'enc' | 'sig' | 'sak';

export type SPKey = {
  id: string;
  name: string;
  purpose: SPKeyPurpose[];
  ringLevel: number;
  permissions: '*' | string[];
  allowedActions?: '*' | string[];
  permissionsContext?: '*' | string[];
  meta?: {
    quantity?: number;
    expires?: number;
    private?: {
      transient?: boolean;
      content?: EncryptedData<string>;
      shareable?: boolean;
      oldKeys?: string;
    };
    keyRequest?: {
      contractID?: string;
      reference?: string | EncryptedData<string>;
    };
  };
  data: string;
  foreignKey?: string;
  _notBeforeHeight: number;
  _notAfterHeight?: number;
  _private?: string;
};
// Allows server to check if the user is allowed to register this type of contract
// TODO: rename 'type' to 'contractName':
export type SPOpContract = {
  type: string;
  keys: (SPKey | EncryptedData<SPKey>)[];
  parentContract?: string;
};
export type ProtoSPOpActionUnencrypted = { action: string; data: JSONType; meta: JSONObject };
export type SPOpActionUnencrypted =
  | ProtoSPOpActionUnencrypted
  | SignedData<ProtoSPOpActionUnencrypted>;
// encrypted version of SPOpActionUnencrypted
export type SPOpActionEncrypted = EncryptedData<SPOpActionUnencrypted>;
export type SPOpKeyAdd = (SPKey | EncryptedData<SPKey>)[];
export type SPOpKeyDel = (string | EncryptedData<string>)[];
export type SPOpPropSet = { key: string; value: JSONType };
export type ProtoSPOpKeyShare = {
  contractID: string;
  keys: SPKey[];
  foreignContractID?: string;
  keyRequestHash?: string;
  keyRequestHeight?: number;
};
export type SPOpKeyShare = ProtoSPOpKeyShare | EncryptedData<ProtoSPOpKeyShare>;
// TODO: THIS CODE SHOULD BE DELETED IF WE RECREATE GROUPS
//       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
export type ProtoSPOpKeyRequestV1 = {
  contractID: string;
  height: number;
  replyWith: SignedData<{
    encryptionKeyId: string;
    responseKey: EncryptedData<string>;
  }>;
  request: string;
};
export type SPOpKeyRequestV1 = ProtoSPOpKeyRequestV1 | EncryptedData<ProtoSPOpKeyRequestV1>;
// END: TODO THIS CODE SHOULD BE DELETED
// Same data and structure as ProtoSPOpKeyRequestV1. Difference between V1 and
// V2 is an unencrypted wrapper.
// We re-declare the type for clarity and because the V2 structure could change
// in the future (e.g., we might add new fields to ProtoSPOpKeyRequestInnerV2)
export type ProtoSPOpKeyRequestInnerV2 = ProtoSPOpKeyRequestV1;
export type SPOpKeyRequestV2 = {
  skipInviteAccounting?: boolean;
  innerData: ProtoSPOpKeyRequestInnerV2 | EncryptedData<ProtoSPOpKeyRequestInnerV2>
};
export type SPOpKeyRequest = SPOpKeyRequestV1 | SPOpKeyRequestV2
export type ProtoSPOpKeyRequestSeenV1 = {
  keyRequestHash: string;
  keyShareHash?: string;
  success: boolean;
};
// TODO: THIS CODE SHOULD BE DELETED IF WE RECREATE GROUPS
//       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
export type SPOpKeyRequestSeenV1 = |
  ProtoSPOpKeyRequestSeenV1 |
  EncryptedData<ProtoSPOpKeyRequestSeenV1>;
export type ProtoSPOpKeyRequestSeenInnerV2 = {
  keyShareHash?: string;
  success: boolean;
};
// END: TODO THIS CODE SHOULD BE DELETED
export type SPOpKeyRequestSeenInnerV2 = |
  ProtoSPOpKeyRequestSeenInnerV2 |
  EncryptedData<ProtoSPOpKeyRequestSeenInnerV2>;
export type SPOpKeyRequestSeenV2 = {
  keyRequestHash: string;
  skipInviteAccounting?: boolean;
  innerData: SPOpKeyRequestSeenInnerV2
};
export type SPOpKeyRequestSeen = SPOpKeyRequestSeenV1 | SPOpKeyRequestSeenV2;
export type SPKeyUpdate = {
  name: string;
  id?: string;
  oldKeyId: string;
  data?: string;
  purpose?: string[];
  permissions?: string[];
  allowedActions?: '*' | string[];
  permissionsContext?: '*' | string[];
  meta?: {
    quantity?: number;
    expires?: number;
    private?: {
      transient?: boolean;
      content?: string;
      shareable?: boolean;
      oldKeys?: string;
    };
  };
};
export type SPOpKeyUpdate = (SPKeyUpdate | EncryptedData<SPKeyUpdate>)[];

export type SPOpType =
  | 'c'
  | 'a'
  | 'ae'
  | 'au'
  | 'ka'
  | 'kd'
  | 'ku'
  | 'pu'
  | 'ps'
  | 'pd'
  | 'ks'
  | 'kr'
  | 'krs';
type ProtoSPOpValue =
  | SPOpContract
  | SPOpActionEncrypted
  | SPOpActionUnencrypted
  | SPOpKeyAdd
  | SPOpKeyDel
  | SPOpPropSet
  | SPOpKeyShare
  | SPOpKeyRequest
  | SPOpKeyRequestSeen
  | SPOpKeyUpdate;
export type ProtoSPOpMap = {
  c: SPOpContract;
  ae: SPOpActionEncrypted;
  au: SPOpActionUnencrypted;
  ka: SPOpKeyAdd;
  kd: SPOpKeyDel;
  ku: SPOpKeyUpdate;
  pu: never;
  ps: SPOpPropSet;
  pd: never;
  ks: SPOpKeyShare;
  kr: SPOpKeyRequest;
  krs: SPOpKeyRequestSeen;
};
export type SPOpAtomic = {
  [K in keyof ProtoSPOpMap]: [K, ProtoSPOpMap[K]];
}[keyof ProtoSPOpMap][];
export type SPOpValue = ProtoSPOpValue | SPOpAtomic;
export type SPOpRaw = [SPOpType, SignedData<SPOpValue>];
export type SPOpMap = ProtoSPOpMap & { a: SPOpAtomic };
export type SPOp = {
  [K in keyof SPOpMap]: [K, SPOpMap[K]];
}[keyof SPOpMap];

export type SPMsgDirection = 'incoming' | 'outgoing';
export type SPHead = {
  version: '1.0.0';
  op: SPOpType;
  height: number;
  contractID: string | null;
  previousKeyOp: string | null;
  previousHEAD: string | null;
  manifest: string;
};
type SPMsgParams = {
  direction: SPMsgDirection;
  mapping: { key: string; value: string };
  head: SPHead;
  signedMessageData: SignedData<SPOpValue>;
};

// Takes a raw message and processes it so that EncryptedData and SignedData
// attributes are defined
const decryptedAndVerifiedDeserializedMessage = (
  head: SPHead,
  headJSON: string,
  contractID: string,
  parsedMessage: SPOpValue,
  additionalKeys: Record<string, Key | string> | undefined,
  state: ChelContractState
): SPOpValue => {
  const op = head.op
  const height = head.height

  const message: SPOpValue =
    op === SPMessage.OP_ACTION_ENCRYPTED
      ? encryptedIncomingData<SPOpActionUnencrypted>(
        contractID,
        state,
          parsedMessage as [string, string],
          height,
          additionalKeys,
          headJSON,
          undefined
      )
      : parsedMessage

  // If the operation is SPMessage.OP_KEY_ADD or SPMessage.OP_KEY_UPDATE,
  // extract encrypted data from key.meta?.private?.content
  if (([SPMessage.OP_KEY_ADD, SPMessage.OP_KEY_UPDATE] as SPOpType[]).includes(op as SPOpType)) {
    return (message as SPOpKeyAdd | SPOpKeyUpdate).map((key) => {
      return maybeEncryptedIncomingData<SPKey>(
        contractID,
        state,
        key as SPKey,
        height,
        additionalKeys,
        headJSON,
        (key) => {
          if (key.meta?.private?.content) {
            key.meta.private.content = encryptedIncomingData<string>(
              contractID,
              state,
              key.meta.private.content as unknown as [string, string],
              height,
              additionalKeys,
              headJSON,
              (value) => {
                // Validator function to verify the key matches its expected ID
                const computedKeyId = keyId(value)
                if (computedKeyId !== key.id) {
                  throw new Error(
                    `Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`
                  )
                }
              }
            )
          }
          // key.meta?.keyRequest?.contractID could be optionally encrypted
          if (key.meta?.keyRequest?.reference) {
            try {
              key.meta.keyRequest.reference = maybeEncryptedIncomingData<string>(
                contractID,
                state,
                key.meta.keyRequest.reference as string,
                height,
                additionalKeys,
                headJSON
              )?.valueOf()
            } catch {
              // If we couldn't decrypt it, this value is of no use to us (we
              // can't keep track of key requests and key shares), so we delete it
              delete key.meta.keyRequest.reference
            }
          }
          // key.meta?.keyRequest?.contractID could be optionally encrypted
          if (key.meta?.keyRequest?.contractID) {
            try {
              key.meta.keyRequest.contractID = maybeEncryptedIncomingData<string>(
                contractID,
                state,
                key.meta.keyRequest.contractID,
                height,
                additionalKeys,
                headJSON
              )?.valueOf()
            } catch {
              // If we couldn't decrypt it, this value is of no use to us (we
              // can't keep track of key requests and key shares), so we delete it
              delete key.meta.keyRequest.contractID
            }
          }
        }
      )
    })
  }

  // If the operation is SPMessage.OP_CONTRACT,
  // extract encrypted data from keys?.[].meta?.private?.content
  if (op === SPMessage.OP_CONTRACT) {
    (message as SPOpContract).keys = (message as SPOpContract).keys?.map((key) => {
      return maybeEncryptedIncomingData<SPKey>(
        contractID,
        state,
        key as SPKey,
        height,
        additionalKeys,
        headJSON,
        (key) => {
          if (!key.meta?.private?.content) return
          // The following two lines are commented out because this feature
          // (using a foreign decryption contract) doesn't seem to be in use and
          // the use case seems unclear.
          // const decryptionFn = key.meta.private.foreignContractID ? encryptedIncomingForeignData : encryptedIncomingData
          // const decryptionContract = key.meta.private.foreignContractID ? key.meta.private.foreignContractID : contractID
          const decryptionFn = encryptedIncomingData
          const decryptionContract = contractID
          key.meta.private.content = decryptionFn<string>(
            decryptionContract,
            state as never,
            key.meta.private.content as unknown as [string, string],
            height as never,
            additionalKeys,
            headJSON,
            (value) => {
              const computedKeyId = keyId(value)
              if (computedKeyId !== key.id) {
                throw new Error(
                  `Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`
                )
              }
            }
          )
        }
      )
    })
  }

  // If the operation is SPMessage.OP_KEY_SHARE,
  // extract encrypted data from keys?.[].meta?.private?.content
  if (op === SPMessage.OP_KEY_SHARE) {
    return maybeEncryptedIncomingData<ProtoSPOpKeyShare>(
      contractID,
      state,
      message as ProtoSPOpKeyShare,
      height,
      additionalKeys,
      headJSON,
      (message) => {
        message.keys?.forEach((key) => {
          if (!key.meta?.private?.content) return
          const decryptionFn = message.foreignContractID
            ? encryptedIncomingForeignData
            : encryptedIncomingData
          const decryptionContract = message.foreignContractID || contractID
          key.meta.private.content = decryptionFn<string>(
            decryptionContract,
            state as never,
            key.meta.private.content as unknown as [string, string],
            height as never,
            additionalKeys,
            headJSON,
            (value) => {
              const computedKeyId = keyId(value)
              if (computedKeyId !== key.id) {
                throw new Error(
                  `Key ID mismatch. Expected to decrypt key ID ${key.id} but got ${computedKeyId}`
                )
              }
            }
          )
        })
      }
    )
  }

  // If the operation is OP_KEY_REQUEST, the payload might be EncryptedData
  // The ReplyWith attribute is SignedData
  if (op === SPMessage.OP_KEY_REQUEST) {
    // TODO: THIS CODE SHOULD BE RE-FACTORED IF WE RECREATE GROUPS
    //       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
    return maybeEncryptedIncomingData<ProtoSPOpKeyRequestV1 | SPOpKeyRequestV2>(
      contractID,
      state,
      message as ProtoSPOpKeyRequestV1,
      height,
      additionalKeys,
      headJSON,
      (msg, id) => {
        // V2 format has `innerData`, V1 does not. V2 always has an _unencrypted_
        // outer layer.
        if (!id && has(msg, 'innerData')) {
          (msg as SPOpKeyRequestV2).innerData =
            maybeEncryptedIncomingData<ProtoSPOpKeyRequestInnerV2>(
              contractID,
              state,
              (msg as SPOpKeyRequestV2).innerData as ProtoSPOpKeyRequestInnerV2,
              height,
              additionalKeys,
              headJSON,
              (innerMsg) => {
                innerMsg.replyWith = signedIncomingData(
                  innerMsg.contractID,
                  undefined,
                  innerMsg.replyWith as unknown as RawSignedData,
                  innerMsg.height,
                  headJSON
                )
              }
            )
        } else {
          (msg as ProtoSPOpKeyRequestV1).replyWith = signedIncomingData(
            (msg as ProtoSPOpKeyRequestV1).contractID,
            undefined,
            (msg as ProtoSPOpKeyRequestV1).replyWith as unknown as RawSignedData,
            (msg as ProtoSPOpKeyRequestV1).height,
            headJSON
          )
        }
      }
    ) as SPOpKeyRequest
  }

  // If the operation is OP_ACTION_UNENCRYPTED, it may contain an inner
  // signature
  // Actions must be signed using a key for the current contract
  if (op === SPMessage.OP_ACTION_UNENCRYPTED && isRawSignedData(message)) {
    return signedIncomingData<ProtoSPOpActionUnencrypted>(
      contractID,
      state,
      message,
      height,
      headJSON
    )
  }

  // Inner signatures are handled by EncryptedData
  if (op === SPMessage.OP_ACTION_ENCRYPTED) {
    return message
  }

  if (op === SPMessage.OP_KEY_DEL) {
    return (message as SPOpKeyDel).map((key) => {
      return maybeEncryptedIncomingData<string>(
        contractID,
        state,
        key as unknown as string,
        height,
        additionalKeys,
        headJSON,
        undefined
      )
    })
  }

  if (op === SPMessage.OP_KEY_REQUEST_SEEN) {
    // TODO: THIS CODE SHOULD BE RE-FACTORED IF WE RECREATE GROUPS
    //       AS THIS OLD V1 STUFF WON'T BE NECESSARY.
    return maybeEncryptedIncomingData<ProtoSPOpKeyRequestSeenV1 | SPOpKeyRequestSeenV2>(
      contractID,
      state,
      parsedMessage as unknown as ProtoSPOpKeyRequestSeenV1 | SPOpKeyRequestSeenV2,
      height,
      additionalKeys,
      headJSON,
      (data, id) => {
        if (!id && has(data, 'innerData')) {
          const dataV2 = data as SPOpKeyRequestSeenV2
          if (dataV2.innerData) {
            dataV2.innerData = maybeEncryptedIncomingData<ProtoSPOpKeyRequestSeenInnerV2>(
              contractID,
              state,
              dataV2.innerData as unknown as ProtoSPOpKeyRequestSeenInnerV2,
              height,
              additionalKeys,
              headJSON
            )
          }
        }
      }
    ) as SPOpKeyRequestSeen
  }

  // If the operation is OP_ATOMIC, call this function recursively
  if (op === SPMessage.OP_ATOMIC) {
    return (message as SPOpAtomic).map(([opT, opV]) => [
      opT,
      decryptedAndVerifiedDeserializedMessage(
        { ...head, op: opT },
        headJSON,
        contractID,
        opV,
        additionalKeys,
        state
      )
    ]) as SPOpAtomic
  }

  return message
}

export class SPMessage {
  // flow type annotations to make flow happy
  _mapping: { key: string; value: string }
  _head: SPHead
  _message!: SPOpValue
  _signedMessageData: SignedData<SPOpValue>
  _direction: SPMsgDirection
  _decryptedValue?: unknown
  _innerSigningKeyId?: string

  static OP_CONTRACT = 'c' as const
  static OP_ACTION_ENCRYPTED = 'ae' as const // e2e-encrypted action
  static OP_ACTION_UNENCRYPTED = 'au' as const // publicly readable action
  static OP_KEY_ADD = 'ka' as const // add this key to the list of keys allowed to write to this contract, or update an existing key
  static OP_KEY_DEL = 'kd' as const // remove this key from authorized keys
  static OP_KEY_UPDATE = 'ku' as const // update key in authorized keys
  static OP_PROTOCOL_UPGRADE = 'pu' as const
  static OP_PROP_SET = 'ps' as const // set a public key/value pair
  static OP_PROP_DEL = 'pd' as const // delete a public key/value pair
  static OP_CONTRACT_AUTH = 'ca' as const // authorize a contract
  static OP_CONTRACT_DEAUTH = 'cd' as const // deauthorize a contract
  static OP_ATOMIC = 'a' as const // atomic op
  static OP_KEY_SHARE = 'ks' as const // key share
  static OP_KEY_REQUEST = 'kr' as const // key request
  static OP_KEY_REQUEST_SEEN = 'krs' as const // key request response

  // eslint-disable-next-line camelcase
  static createV1_0 ({
    contractID,
    previousHEAD = null,
    previousKeyOp = null,
    // Height will be automatically set to the correct value when sending
    // The reason to set it to Number.MAX_SAFE_INTEGER is so that we can
    // temporarily process outgoing messages with signature validation
    // still working
    height = Number.MAX_SAFE_INTEGER,
    op,
    manifest
  }: {
    contractID: string | null;
    previousHEAD?: string | null;
    previousKeyOp?: string | null;
    height?: number;
    op: SPOpRaw;
    manifest: string;
  }): SPMessage {
    const head: SPHead = {
      version: '1.0.0',
      previousHEAD,
      previousKeyOp,
      height,
      contractID,
      op: op[0],
      manifest
    }
    return new this(messageToParams(head, op[1]))
  }

  // SPMessage.cloneWith could be used when make a SPMessage object having the same id()
  // https://github.com/okTurtles/group-income/issues/1503
  static cloneWith (targetHead: SPHead, targetOp: SPOpRaw, sources: Partial<SPHead>): SPMessage {
    const head = Object.assign({}, targetHead, sources)
    return new this(messageToParams(head, targetOp[1]))
  }

  static deserialize (
    value: string,
    additionalKeys?: Record<string, Key | string>,
    state?: ChelContractState,
    unwrapMaybeEncryptedDataFn: (
      data: SPKey | EncryptedData<SPKey>,
    ) => { encryptionKeyId: string | null; data: SPKey } | undefined = unwrapMaybeEncryptedData
  ): SPMessage {
    if (!value) throw new Error(`deserialize bad value: ${value}`)
    const { head: headJSON, ...parsedValue } = JSON.parse(value)
    const head = JSON.parse(headJSON)
    const contractID =
      head.op === SPMessage.OP_CONTRACT
        ? createCID(value, multicodes.SHELTER_CONTRACT_DATA)
        : head.contractID

    // Special case for OP_CONTRACT, since the keys are not yet present in the
    // state
    if (!state?._vm?.authorizedKeys && head.op === SPMessage.OP_CONTRACT) {
      const value = rawSignedIncomingData<SPOpContract>(parsedValue)
      const authorizedKeys = Object.fromEntries(
        value
          .valueOf()
          ?.keys.map((wk) => {
            const k = unwrapMaybeEncryptedDataFn(wk)
            if (!k) return null
            return [k.data.id, k.data] as [string, ChelContractKey]
          })
          // eslint-disable-next-line no-use-before-define
          .filter(Boolean as unknown as ((x: unknown) => x is [string, ChelContractKey]))
      )
      state = {
        _vm: {
          type: head.type,
          authorizedKeys
        }
      }
    }

    const signedMessageData = signedIncomingData<SPOpValue>(
      contractID,
      state,
      parsedValue,
      head.height,
      headJSON,
      (message) =>
        decryptedAndVerifiedDeserializedMessage(
          head,
          headJSON,
          contractID,
          message,
          additionalKeys,
          state!
        )
    )

    return new this({
      direction: 'incoming',
      mapping: { key: createCID(value, multicodes.SHELTER_CONTRACT_DATA), value },
      head,
      signedMessageData
    })
  }

  static deserializeHEAD (value: string): {
    head: SPHead;
    hash: string;
    contractID: string;
    isFirstMessage: boolean;
    description: () => string;
  } {
    if (!value) throw new Error(`deserialize bad value: ${value}`)
    let head: SPHead, hash: string
    const result = {
      get head () {
        if (head === undefined) {
          head = JSON.parse(JSON.parse(value).head)
        }
        return head
      },
      get hash () {
        if (!hash) {
          hash = createCID(value, multicodes.SHELTER_CONTRACT_DATA)
        }
        return hash
      },
      get contractID () {
        return result.head?.contractID ?? result.hash
      },
      // `description` is not a getter to prevent the value from being copied
      // if the object is cloned or serialized
      description (): string {
        const type = this.head.op
        return `<op_${type}|${this.hash} of ${this.contractID}>`
      },
      get isFirstMessage (): boolean {
        return !result.head?.contractID
      }
    }
    return result
  }

  constructor (params: SPMsgParams) {
    this._direction = params.direction
    this._mapping = params.mapping
    this._head = params.head
    this._signedMessageData = params.signedMessageData

    // perform basic sanity check
    const type = this.opType()
    let atomicTopLevel = true
    const validate = (type: string, message: SPOpValue) => {
      switch (type) {
        case SPMessage.OP_CONTRACT:
          if (!this.isFirstMessage() || !atomicTopLevel) { throw new Error('OP_CONTRACT: must be first message') }
          break
        case SPMessage.OP_ATOMIC:
          if (!atomicTopLevel) {
            throw new Error('OP_ATOMIC not allowed inside of OP_ATOMIC')
          }
          if (!Array.isArray(message)) {
            throw new TypeError('OP_ATOMIC must be of an array type')
          }
          atomicTopLevel = false;
          (message as SPOpAtomic).forEach(([t, m]) => validate(t, m))
          break
        case SPMessage.OP_KEY_ADD:
        case SPMessage.OP_KEY_DEL:
        case SPMessage.OP_KEY_UPDATE:
          if (!Array.isArray(message)) { throw new TypeError('OP_KEY_{ADD|DEL|UPDATE} must be of an array type') }
          break
        case SPMessage.OP_KEY_SHARE:
        case SPMessage.OP_KEY_REQUEST:
        case SPMessage.OP_KEY_REQUEST_SEEN:
        case SPMessage.OP_ACTION_ENCRYPTED:
        case SPMessage.OP_ACTION_UNENCRYPTED:
          // nothing for now
          break
        default:
          throw new Error(`unsupported op: ${type}`)
      }
    }

    // this._message is set as a getter to verify the signature only once the
    // message contents are read
    Object.defineProperty(this, '_message', {
      get: ((validated?: boolean) => () => {
        const message = this._signedMessageData.valueOf()
        // If we haven't validated the message, validate it now
        if (!validated) {
          validate(type, message)
          validated = true
        }
        return message
      })()
    })
  }

  decryptedValue (): unknown | undefined {
    if (this._decryptedValue) return this._decryptedValue
    try {
      const value = this.message()
      // TODO: This uses `unwrapMaybeEncryptedData` instead of a configurable
      // version based on `skipDecryptionAttempts`. This is fine based on current
      // use, and also something else might be confusing based on the explicit
      // name of this function, `decryptedValue`.
      const data = unwrapMaybeEncryptedData(value)
      // Did decryption succeed? (unwrapMaybeEncryptedData will return undefined
      // on failure)
      if (data?.data) {
        // The data inside could be signed. In this case, we unwrap that to get
        // to the inner contents
        if (isSignedData(data.data)) {
          this._innerSigningKeyId = data.data.signingKeyId
          this._decryptedValue = data.data.valueOf()
        } else {
          this._decryptedValue = data.data
        }
      }
      return this._decryptedValue
    } catch {
      // Signature or encryption error
      // We don't log this error because it's already logged when the value is
      // retrieved
      return undefined
    }
  }

  innerSigningKeyId (): string | undefined {
    if (!this._decryptedValue) {
      this.decryptedValue()
    }
    return this._innerSigningKeyId
  }

  head (): SPHead {
    return this._head
  }

  message (): SPOpValue {
    return this._message
  }

  op (): SPOp {
    return [this.head().op, this.message()] as SPOp
  }

  rawOp (): SPOpRaw {
    return [this.head().op, this._signedMessageData]
  }

  opType (): SPOpType {
    return this.head().op
  }

  opValue (): SPOpValue {
    return this.message()
  }

  signingKeyId (): string {
    return this._signedMessageData.signingKeyId
  }

  manifest (): string {
    return this.head().manifest
  }

  description (): string {
    const type = this.opType()
    let desc = `<op_${type}`
    if (type === SPMessage.OP_ACTION_UNENCRYPTED) {
      try {
        const value = this.opValue().valueOf() as ProtoSPOpActionUnencrypted
        if (typeof value.action === 'string') {
          desc += `|${value.action}`
        }
      } catch (e) {
        console.warn('Error on .description()', this.hash(), e)
      }
    }
    return `${desc}|${this.hash()} of ${this.contractID()}>`
  }

  isFirstMessage (): boolean {
    return !this.head().contractID
  }

  contractID (): string {
    return this.head().contractID || this.hash()
  }

  serialize (): string {
    return this._mapping.value
  }

  hash (): string {
    return this._mapping.key
  }

  previousKeyOp (): string | null {
    return this._head.previousKeyOp
  }

  height (): number {
    return this._head.height
  }

  id (): string {
    // TODO: Schedule for later removal
    throw new Error('SPMessage.id() was called but it has been removed')
  }

  direction (): 'incoming' | 'outgoing' {
    return this._direction
  }

  // `isKeyOp` is used to filter out non-key operations for providing an
  // abbreviated chain fo snapshot validation
  isKeyOp (): boolean {
    let value: SPOpValue
    return !!(
      (keyOps as SPOpType[]).includes(this.opType()) ||
      (this.opType() === SPMessage.OP_ATOMIC &&
        Array.isArray((value = this.opValue())) &&
        (value as SPOpAtomic).some(([opT]) => {
          return (keyOps as SPOpType[]).includes(opT)
        }))
    )
  }

  static get [serdesTagSymbol] () {
    return 'SPMessage'
  }

  static [serdesSerializeSymbol] (m: SPMessage) {
    return [m.serialize(), m.direction(), m.decryptedValue(), m.innerSigningKeyId()]
  }

  static [serdesDeserializeSymbol] ([serialized, direction, decryptedValue, innerSigningKeyId]: [
    string,
    SPMsgDirection,
    object,
    string,
  ]) {
    const m = SPMessage.deserialize(serialized)
    m._direction = direction
    m._decryptedValue = decryptedValue
    m._innerSigningKeyId = innerSigningKeyId
    return m
  }
}

function messageToParams (head: SPHead, message: SignedData<SPOpValue>): SPMsgParams {
  // NOTE: the JSON strings generated here must be preserved forever.
  //       do not ever regenerate this message using the contructor.
  //       instead store it using serialize() and restore it using deserialize().
  //       The issue is that different implementations of JavaScript engines might generate different strings
  //       when serializing JS objects using JSON.stringify
  //       and that would lead to different hashes resulting from createCID.
  //       So to get around this we save the serialized string upon creation
  //       and keep a copy of it (instead of regenerating it as needed).
  //       https://github.com/okTurtles/group-income/pull/1513#discussion_r1142809095
  let mapping: { key: string; value: string }
  return {
    direction: has(message, 'recreate') ? 'outgoing' : 'incoming',
    // Lazy computation of mapping to prevent us from serializing outgoing
    // atomic operations
    get mapping () {
      if (!mapping) {
        const headJSON = JSON.stringify(head)
        const messageJSON = { ...message.serialize(headJSON), head: headJSON }
        const value = JSON.stringify(messageJSON)

        mapping = {
          key: createCID(value, multicodes.SHELTER_CONTRACT_DATA),
          value
        }
      }
      return mapping
    },
    head,
    signedMessageData: message
  }
}

// Operations that affect valid keys
const keyOps = [
  SPMessage.OP_CONTRACT,
  SPMessage.OP_KEY_ADD,
  SPMessage.OP_KEY_DEL,
  SPMessage.OP_KEY_UPDATE
]
