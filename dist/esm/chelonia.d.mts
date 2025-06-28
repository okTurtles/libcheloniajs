import '@sbp/okturtles.eventqueue';
import '@sbp/okturtles.events';
import type { SPKey, SPOpKeyAdd, SPOpKeyDel, SPOpKeyRequestSeen, SPOpKeyShare, SPOpKeyUpdate } from './SPMessage.mjs';
import type { Key } from '@chelonia/crypto';
import { SPMessage } from './SPMessage.mjs';
import './chelonia-utils.mjs';
import type { EncryptedData } from './encryptedData.mjs';
import './files.mjs';
import './internals.mjs';
import './time-sync.mjs';
import { ChelContractState } from './types.mjs';
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
    publishOptions?: {
        headers?: Record<string, string> | null | undefined;
        billableContractID?: string | null | undefined;
        maxAttempts?: number | null | undefined;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
    atomic: boolean;
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
    publishOptions?: {
        maxAttempts?: number;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
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
    publishOptions?: {
        maxAttempts: number;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
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
    publishOptions?: {
        maxAttempts?: number;
    };
};
export { SPMessage };
export declare const ACTION_REGEX: RegExp;
declare const _default: string[];
export default _default;
