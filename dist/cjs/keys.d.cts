import type { Key } from '@chelonia/crypto';
import type { SPKey, SPKeyMeta, SPKeyPurpose, SPKeyType, SPOpKeyUpdate } from './SPMessage.cjs';
import type { ChelContractState, CheloniaContext } from './types.cjs';
import type { ChelActionParams, ChelKeyAddParams, ChelKeyDelParams, ChelKeyRequestResponseParams, ChelKeyShareParams, ChelKeyUpdateParams, ChelShareKeysParams, NestedInvocationParams } from './chelonia.cjs';
export type KeySpecWrapTarget = string | {
    contractID: string;
    name: string;
} | {
    key: Key;
};
export type KeySpec = {
    name?: string;
    key?: Key;
    type?: SPKeyType;
    encryptWith?: KeySpecWrapTarget;
    purpose?: SPKeyPurpose[];
    ringLevel?: number;
    permissions?: '*' | string[];
    allowedActions?: '*' | string[];
    transient?: boolean;
    shareable?: boolean;
    quantity?: number;
    expires?: number;
    foreignKeyFrom?: [contractID: string, keyName: string];
    foreignKey?: string;
    meta?: SPKeyMeta;
    data?: string;
};
export type MarkedKeySpec = KeySpec & {
    alias: string;
};
export type KeySpecMap = Record<string, KeySpec>;
export type GeneratedKey = {
    name: string;
    id: string;
    key?: Key;
    spkey: SPKey;
};
export type KeyMap = Record<string, GeneratedKey>;
export type KeyExpansionContext = {
    contractID?: string;
    contractState?: ChelContractState;
    getContractState?: (contractID: string) => ChelContractState | undefined;
};
export type KeyUpdateSpec = {
    name?: string;
    oldKeyId?: string;
    oldKeyName?: string;
    key?: Key;
    rotate?: boolean;
    encryptWith?: KeySpecWrapTarget;
    purpose?: SPKeyPurpose[];
    permissions?: '*' | string[];
    allowedActions?: '*' | string[];
    transient?: boolean;
    shareable?: boolean;
    meta?: SPKeyMeta;
};
export type MarkedKeyUpdateSpec = KeyUpdateSpec & {
    alias: string;
};
export type KeyUpdateSpecMap = Record<string, KeyUpdateSpec>;
export type RotationKeyMap = Record<string, {
    id: string;
    key: Key;
}>;
export type KeyUpdateExpansionResult = {
    updates: SPOpKeyUpdate;
    newKeys: RotationKeyMap;
};
export type AtomicInvocation = ['chelonia/out/actionEncrypted', NestedInvocationParams<ChelActionParams>] | ['chelonia/out/actionUnencrypted', NestedInvocationParams<ChelActionParams>] | ['chelonia/out/keyAdd', NestedInvocationParams<ChelKeyAddParams>] | ['chelonia/out/keyDel', NestedInvocationParams<ChelKeyDelParams>] | ['chelonia/out/keyUpdate', NestedInvocationParams<ChelKeyUpdateParams>] | [
    'chelonia/out/keyRequestResponse',
    NestedInvocationParams<ChelKeyRequestResponseParams>
] | ['chelonia/out/keyShare', NestedInvocationParams<ChelKeyShareParams>] | ['chelonia/out/shareKeys', NestedInvocationParams<ChelShareKeysParams>];
export declare const keySpec: (alias: string, spec?: KeySpec) => MarkedKeySpec;
export declare const isKeySpec: (value: unknown) => value is MarkedKeySpec;
export declare const keyUpdateSpec: (alias: string, spec?: KeyUpdateSpec) => MarkedKeyUpdateSpec;
export declare const isKeyUpdateSpec: (value: unknown) => value is MarkedKeyUpdateSpec;
export type NormalizedKeySpec = {
    alias: string;
    spec: KeySpec;
};
export declare const normalizeKeySpecs: (input: KeySpecMap | MarkedKeySpec[]) => NormalizedKeySpec[];
export type NormalizedKeyUpdateSpec = {
    alias: string;
    spec: KeyUpdateSpec;
};
export declare const normalizeKeyUpdateSpecs: (input: KeyUpdateSpecMap | MarkedKeyUpdateSpec[]) => NormalizedKeyUpdateSpec[];
export declare const resolveGeneratedKeyReference: (keyMap: KeyMap, id: string | null | undefined, name: string | null | undefined, label: string, required?: boolean) => string | null | undefined;
export declare const resolveStateKeyReference: (state: ChelContractState | undefined, id: string | null | undefined, name: string | null | undefined, label: string, required?: boolean) => string | null | undefined;
export declare const expandKeySpecs: (params: {
    keys: KeySpecMap | MarkedKeySpec[];
    context?: KeyExpansionContext;
}) => KeyMap;
export declare const expandKeyUpdateSpecs: (params: {
    updates: KeyUpdateSpecMap | MarkedKeyUpdateSpec[];
    contractID: string;
    contractState: ChelContractState;
}) => KeyUpdateExpansionResult;
export declare const storeGeneratedSecretKeys: (ctx: CheloniaContext, keys: Iterable<{
    key?: Key;
}>) => void;
declare const _default: string[];
export default _default;
