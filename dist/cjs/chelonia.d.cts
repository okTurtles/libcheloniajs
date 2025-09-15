import '@sbp/okturtles.eventqueue';
import '@sbp/okturtles.events';
import type { SPKey, SPOpKeyAdd, SPOpKeyDel, SPOpKeyRequestSeen, SPOpKeyShare, SPOpKeyUpdate } from './SPMessage.cjs';
import type { Key } from '@chelonia/crypto';
import { SPMessage } from './SPMessage.cjs';
import './chelonia-utils.cjs';
import type { EncryptedData } from './encryptedData.cjs';
import './files.cjs';
import './internals.cjs';
import type { PublishOptions } from './internals.cjs';
import './time-sync.cjs';
import { ChelContractState } from './types.cjs';
export type { PublishOptions };
export type ChelRegParams = {
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
export type ChelActionParams = {
    action: string;
    server?: string;
    contractID: string;
    data: object;
    signingKeyId: string;
    innerSigningKeyId: string;
    encryptionKeyId?: string | null | undefined;
    encryptionKey?: Key | null | undefined;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void> | void;
        postpublish?: (msg: SPMessage) => Promise<void> | void;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyAddParams = {
    contractName: string;
    contractID: string;
    data: SPOpKeyAdd;
    signingKeyId: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void> | void;
        postpublish?: (msg: SPMessage) => Promise<void> | void;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
    skipExistingKeyCheck?: boolean;
};
export type ChelKeyDelParams = {
    contractName: string;
    contractID: string;
    data: SPOpKeyDel;
    signingKeyId: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyUpdateParams = {
    contractName: string;
    contractID: string;
    data: SPOpKeyUpdate;
    signingKeyId: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
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
    signingKey?: Key;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyRequestParams = {
    originatingContractID: string;
    originatingContractName: string;
    contractName: string;
    contractID: string;
    signingKeyId: string;
    innerSigningKeyId: string;
    encryptionKeyId: string;
    innerEncryptionKeyId: string;
    encryptKeyRequestMetadata?: boolean;
    permissions?: '*' | string[];
    allowedActions?: '*' | string[];
    reference?: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelKeyRequestResponseParams = {
    contractName: string;
    contractID: string;
    data: SPOpKeyRequestSeen;
    signingKeyId: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelAtomicParams = {
    originatingContractID: string;
    originatingContractName: string;
    contractName: string;
    contractID: string;
    signingKeyId: string;
    data: [sel: string, data: ChelActionParams | ChelKeyRequestParams | ChelKeyShareParams][];
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
};
export { SPMessage };
export declare const ACTION_REGEX: RegExp;
declare const _default: string[];
export default _default;
