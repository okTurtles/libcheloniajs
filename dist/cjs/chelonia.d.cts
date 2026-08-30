import '@sbp/okturtles.eventqueue';
import '@sbp/okturtles.events';
import type { SPKey, SPKeyUpdate, SPOpKeyDel, SPOpKeyRequestSeen, SPOpKeyShare } from './SPMessage.cjs';
import type { Key } from '@chelonia/crypto';
import { SPMessage } from './SPMessage.cjs';
import './chelonia-utils.cjs';
import './keys.cjs';
import { type AtomicInvocation, type KeyMap, type KeySpecMap, type MarkedKeySpec, type MarkedKeyUpdateSpec, type KeyUpdateSpecMap } from './keys.cjs';
import type { EncryptedData } from './encryptedData.cjs';
import './files.cjs';
import { type PublishOptions } from './internals.cjs';
import './kv.cjs';
import './time-sync.cjs';
import { ChelContractState } from './types.cjs';
export type { PublishOptions };
type OutgoingHooks = {
    prepublishContract?: (msg: SPMessage) => void;
    prepublish?: (msg: SPMessage) => Promise<void> | void;
    postpublish?: (msg: SPMessage) => Promise<void> | void;
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
export type ChelActionParams = {
    action: string;
    server?: string;
    contractID: string;
    data: object;
    signingKeyId?: string;
    signingKeyName?: string;
    innerSigningKeyId?: string | null;
    innerSigningKeyName?: string | null;
    encryptionKeyId?: string | null | undefined;
    encryptionKeyName?: string | null | undefined;
    encryptionKey?: Key | null | undefined;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void> | void;
        postpublish?: (msg: SPMessage) => Promise<void> | void;
    };
    publishOptions?: PublishOptions;
    atomic?: boolean;
};
export type ChelKeyAddParams = {
    contractName: string;
    contractID: string;
    data: (SPKey | EncryptedData<SPKey> | MarkedKeySpec)[] | KeySpecMap;
    signingKeyId?: string;
    signingKeyName?: string;
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
    signingKeyId?: string;
    signingKeyName?: string;
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
    data: (SPKeyUpdate | EncryptedData<SPKeyUpdate> | MarkedKeyUpdateSpec)[] | KeyUpdateSpecMap;
    signingKeyId?: string;
    signingKeyName?: string;
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
    signingKeyName?: string;
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
    signingKeyId?: string;
    signingKeyName?: string;
    innerSigningKeyId?: string;
    innerSigningKeyName?: string;
    encryptionKeyId?: string;
    encryptionKeyName?: string;
    innerEncryptionKeyId?: string;
    innerEncryptionKeyName?: string;
    encryptKeyRequestMetadata?: boolean;
    permissions?: '*' | string[];
    allowedActions?: '*' | string[];
    reference?: string;
    request?: string;
    keyRequestResponseId?: string;
    skipInviteAccounting?: boolean;
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
    signingKeyId?: string;
    signingKeyName?: string;
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
    publishOptions?: PublishOptions;
    atomic: boolean;
};
export type ChelAtomicParams = {
    contractName: string;
    contractID: string;
    signingKeyId?: string;
    signingKeyName?: string;
    data: AtomicInvocation[];
    hooks?: {
        prepublishContract?: (msg: SPMessage) => void;
        prepublish?: (msg: SPMessage) => Promise<void>;
        postpublish?: (msg: SPMessage) => Promise<void>;
    };
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
