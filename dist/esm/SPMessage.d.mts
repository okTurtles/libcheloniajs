import type { Key } from '@chelonia/crypto';
import { CURVE25519XSALSA20POLY1305, EDWARDS25519SHA512BATCH, XSALSA20POLY1305 } from '@chelonia/crypto';
import { serdesDeserializeSymbol, serdesSerializeSymbol, serdesTagSymbol } from '@chelonia/serdes';
import type { EncryptedData } from './encryptedData.mjs';
import type { SignedData } from './signedData.mjs';
import type { ChelContractState, JSONObject, JSONType } from './types.mjs';
export type SPKeyType = typeof EDWARDS25519SHA512BATCH | typeof CURVE25519XSALSA20POLY1305 | typeof XSALSA20POLY1305;
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
export type SPOpContract = {
    type: string;
    keys: (SPKey | EncryptedData<SPKey>)[];
    parentContract?: string;
};
export type ProtoSPOpActionUnencrypted = {
    action: string;
    data: JSONType;
    meta: JSONObject;
};
export type SPOpActionUnencrypted = ProtoSPOpActionUnencrypted | SignedData<ProtoSPOpActionUnencrypted>;
export type SPOpActionEncrypted = EncryptedData<SPOpActionUnencrypted>;
export type SPOpKeyAdd = (SPKey | EncryptedData<SPKey>)[];
export type SPOpKeyDel = (string | EncryptedData<string>)[];
export type SPOpPropSet = {
    key: string;
    value: JSONType;
};
export type ProtoSPOpKeyShare = {
    contractID: string;
    keys: SPKey[];
    foreignContractID?: string;
    keyRequestHash?: string;
    keyRequestHeight?: number;
};
export type SPOpKeyShare = ProtoSPOpKeyShare | EncryptedData<ProtoSPOpKeyShare>;
export type ProtoSPOpKeyRequest = {
    contractID: string;
    height: number;
    replyWith: SignedData<{
        encryptionKeyId: string;
        responseKey: EncryptedData<string>;
    }>;
    request: string;
};
export type SPOpKeyRequest = ProtoSPOpKeyRequest | EncryptedData<ProtoSPOpKeyRequest>;
export type ProtoSPOpKeyRequestSeen = {
    keyRequestHash: string;
    keyShareHash?: string;
    success: boolean;
};
export type SPOpKeyRequestSeen = ProtoSPOpKeyRequestSeen | EncryptedData<ProtoSPOpKeyRequestSeen>;
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
export type SPOpType = 'c' | 'a' | 'ae' | 'au' | 'ka' | 'kd' | 'ku' | 'pu' | 'ps' | 'pd' | 'ks' | 'kr' | 'krs';
type ProtoSPOpValue = SPOpContract | SPOpActionEncrypted | SPOpActionUnencrypted | SPOpKeyAdd | SPOpKeyDel | SPOpPropSet | SPOpKeyShare | SPOpKeyRequest | SPOpKeyRequestSeen | SPOpKeyUpdate;
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
export type SPOpMap = ProtoSPOpMap & {
    a: SPOpAtomic;
};
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
    mapping: {
        key: string;
        value: string;
    };
    head: SPHead;
    signedMessageData: SignedData<SPOpValue>;
};
export declare class SPMessage {
    _mapping: {
        key: string;
        value: string;
    };
    _head: SPHead;
    _message: SPOpValue;
    _signedMessageData: SignedData<SPOpValue>;
    _direction: SPMsgDirection;
    _decryptedValue?: unknown;
    _innerSigningKeyId?: string;
    static OP_CONTRACT: "c";
    static OP_ACTION_ENCRYPTED: "ae";
    static OP_ACTION_UNENCRYPTED: "au";
    static OP_KEY_ADD: "ka";
    static OP_KEY_DEL: "kd";
    static OP_KEY_UPDATE: "ku";
    static OP_PROTOCOL_UPGRADE: "pu";
    static OP_PROP_SET: "ps";
    static OP_PROP_DEL: "pd";
    static OP_CONTRACT_AUTH: "ca";
    static OP_CONTRACT_DEAUTH: "cd";
    static OP_ATOMIC: "a";
    static OP_KEY_SHARE: "ks";
    static OP_KEY_REQUEST: "kr";
    static OP_KEY_REQUEST_SEEN: "krs";
    static createV1_0({ contractID, previousHEAD, previousKeyOp, height, op, manifest }: {
        contractID: string | null;
        previousHEAD?: string | null;
        previousKeyOp?: string | null;
        height?: number;
        op: SPOpRaw;
        manifest: string;
    }): SPMessage;
    static cloneWith(targetHead: SPHead, targetOp: SPOpRaw, sources: Partial<SPHead>): SPMessage;
    static deserialize(value: string, additionalKeys?: Record<string, Key | string>, state?: ChelContractState, unwrapMaybeEncryptedDataFn?: (data: SPKey | EncryptedData<SPKey>) => {
        encryptionKeyId: string | null;
        data: SPKey;
    } | undefined): SPMessage;
    static deserializeHEAD(value: string): {
        head: SPHead;
        hash: string;
        contractID: string;
        isFirstMessage: boolean;
        description: () => string;
    };
    constructor(params: SPMsgParams);
    decryptedValue(): unknown | undefined;
    innerSigningKeyId(): string | undefined;
    head(): SPHead;
    message(): SPOpValue;
    op(): SPOp;
    rawOp(): SPOpRaw;
    opType(): SPOpType;
    opValue(): SPOpValue;
    signingKeyId(): string;
    manifest(): string;
    description(): string;
    isFirstMessage(): boolean;
    contractID(): string;
    serialize(): string;
    hash(): string;
    previousKeyOp(): string | null;
    height(): number;
    id(): string;
    direction(): 'incoming' | 'outgoing';
    isKeyOp(): boolean;
    static get [serdesTagSymbol](): string;
    static [serdesSerializeSymbol](m: SPMessage): unknown[];
    static [serdesDeserializeSymbol]([serialized, direction, decryptedValue, innerSigningKeyId]: [
        string,
        SPMsgDirection,
        object,
        string
    ]): SPMessage;
}
export {};
