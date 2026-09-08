import '@sbp/okturtles.eventqueue';
import '@sbp/okturtles.events';
import type { SPKey, SPKeyUpdate, SPOpKeyDel, SPOpKeyRequestSeen, SPOpKeyShare } from './SPMessage.mjs';
import type { Key } from '@chelonia/crypto';
import { SPMessage } from './SPMessage.mjs';
import './chelonia-utils.mjs';
import './keys.mjs';
import { type AtomicInvocation, type KeyMap, type KeySpecMap, type MarkedKeySpec, type MarkedKeyUpdateSpec, type KeyUpdateSpecMap } from './keys.mjs';
import type { EncryptedData } from './encryptedData.mjs';
import './files.mjs';
import { type PublishOptions } from './internals.mjs';
import './kv.mjs';
import './time-sync.mjs';
import { ChelContractState } from './types.mjs';
export type { PublishOptions };
type OutgoingHooks = {
    prepublishContract?: (msg: SPMessage) => void;
    prepublish?: (msg: SPMessage) => Promise<void> | void;
    postpublish?: (msg: SPMessage) => Promise<void> | void;
};
type SigningKeyRef = {
    signingKeyId: string;
    signingKeyName?: string;
} | {
    signingKeyId?: undefined;
    signingKeyName: string;
};
type InnerSigningKeyRef = {
    innerSigningKeyId: string;
    innerSigningKeyName?: string;
} | {
    innerSigningKeyId?: undefined;
    innerSigningKeyName: string;
};
type EncryptionKeyRef = {
    encryptionKeyId: string;
    encryptionKeyName?: string;
} | {
    encryptionKeyId?: undefined;
    encryptionKeyName: string;
};
type InnerEncryptionKeyRef = {
    innerEncryptionKeyId: string;
    innerEncryptionKeyName?: string;
} | {
    innerEncryptionKeyId?: undefined;
    innerEncryptionKeyName: string;
};
export type NestedInvocationParams<T> = Omit<T, 'signingKeyId' | 'signingKeyName' | 'contractID' | 'contractName' | 'atomic'> & {
    signingKeyId?: string;
    signingKeyName?: string;
    contractID?: string;
    contractName?: string;
    atomic?: boolean;
};
export type RegistrationKeyReferences = {
    signingKeyId?: string;
    signingKeyName?: string;
    actionSigningKeyId?: string;
    actionSigningKeyName?: string;
    actionEncryptionKeyId?: string | null | undefined;
    actionEncryptionKeyName?: string | null | undefined;
};
export type ChelRegParamsLegacy = {
    contractName: string;
    server?: string;
    data: object;
    signingKeyId: string;
    actionSigningKeyId: string;
    actionEncryptionKeyId?: string | null | undefined;
    keys: (SPKey | EncryptedData<SPKey>)[];
    namespaceRegistration?: string | null | undefined;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        postpublishContract?: (msg: SPMessage) => void;
        preSendCheck?: (msg: SPMessage, state: ChelContractState) => void;
        beforeRequest?: (msg1: SPMessage, msg2: SPMessage) => Promise<void> | void;
        prepublish?: (msg: SPMessage) => Promise<void> | void;
        postpublish?: (msg: SPMessage) => Promise<void> | void;
        onprocessed?: (msg: SPMessage) => Promise<void> | void;
    };
    publishOptions?: PublishOptions;
};
export type ChelRegParamsSpec = RegistrationKeyReferences & {
    contractName: string;
    server?: string;
    data: object | ((K: KeyMap) => object);
    keys: KeySpecMap | MarkedKeySpec[];
    autoSak?: false | {
        encryptWith: string;
    };
    onKeysReady?: (K: KeyMap) => void | Promise<void>;
    namespaceRegistration?: string | null | undefined;
    hooks?: ChelRegParamsLegacy['hooks'];
    publishOptions?: PublishOptions;
};
export type ChelRegParams = ChelRegParamsLegacy | ChelRegParamsSpec;
export type ChelActionParams = SigningKeyRef & {
    action: string;
    server?: string;
    contractID: string;
    data: object;
    innerSigningKeyId?: string | null;
    innerSigningKeyName?: string | null;
    encryptionKeyId?: string | null | undefined;
    encryptionKeyName?: string | null | undefined;
    encryptionKey?: Key | null | undefined;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic?: boolean;
};
export type ChelKeyAddParams = SigningKeyRef & {
    contractName: string;
    contractID: string;
    data: (SPKey | EncryptedData<SPKey> | MarkedKeySpec)[] | KeySpecMap;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
    skipExistingKeyCheck?: boolean;
};
export type ChelKeyDelParams = SigningKeyRef & {
    contractName: string;
    contractID: string;
    data: SPOpKeyDel;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyUpdateParams = SigningKeyRef & {
    contractName: string;
    contractID: string;
    data: (SPKeyUpdate | EncryptedData<SPKeyUpdate> | MarkedKeyUpdateSpec)[] | KeyUpdateSpecMap;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyShareParams = {
    originatingContractID?: string;
    originatingContractName?: string;
    contractID: string;
    contractName: string;
    data: SPOpKeyShare;
    signingKeyId?: string;
    signingKeyName?: string;
    signingKey?: Key;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyRequestParams = SigningKeyRef & InnerSigningKeyRef & EncryptionKeyRef & InnerEncryptionKeyRef & {
    originatingContractID: string;
    originatingContractName: string;
    contractName: string;
    contractID: string;
    encryptKeyRequestMetadata?: boolean;
    permissions?: '*' | string[];
    allowedActions?: '*' | string[];
    reference?: string;
    request?: string;
    keyRequestResponseId?: string;
    skipInviteAccounting?: boolean;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyRequestResponseParams = SigningKeyRef & {
    contractName: string;
    contractID: string;
    data: SPOpKeyRequestSeen;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelAtomicParams = SigningKeyRef & {
    contractName: string;
    contractID: string;
    data: AtomicInvocation[];
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
};
export type ChelShareKeysParams = {
    contractID: string;
    contractName: string;
    subjectContractID: string;
    keyIds?: string[] | '*';
    keyNames?: string[] | '*';
    encryptionKeyId?: string;
    encryptionKeyName?: string;
    signingKeyId?: string;
    signingKeyName?: string;
    foreignContractID?: string;
    hooks?: OutgoingHooks;
    publishOptions?: PublishOptions;
    atomic?: boolean;
};
export { SPMessage };
export declare const ACTION_REGEX: RegExp;
declare const _default: string[];
export default _default;
