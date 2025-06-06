import type { Key } from '@chelonia/crypto';
import type { ChelContractState } from './types.cjs';
export interface EncryptedData<T> {
    encryptionKeyId: string;
    valueOf: () => T;
    serialize: (additionalData?: string) => [string, string];
    toString: (additionalData?: string) => string;
    toJSON?: () => [string, string];
}
export declare const isEncryptedData: <T>(o: unknown) => o is EncryptedData<T>;
export declare const encryptedOutgoingData: <T>(stateOrContractID: string | ChelContractState, eKeyId: string, data: T) => EncryptedData<T>;
export declare const encryptedOutgoingDataWithRawKey: <T>(key: Key, data: T) => EncryptedData<T>;
export declare const encryptedIncomingData: <T>(contractID: string, state: ChelContractState, data: [string, string], height: number, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void) => EncryptedData<T>;
export declare const encryptedIncomingForeignData: <T>(contractID: string, _0: never, data: [string, string], _1: never, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void) => EncryptedData<T>;
export declare const encryptedIncomingDataWithRawKey: <T>(key: Key, data: [string, string], additionalData?: string) => EncryptedData<T>;
export declare const encryptedDataKeyId: (data: unknown) => string;
export declare const isRawEncryptedData: (data: unknown) => data is [string, string];
export declare const unwrapMaybeEncryptedData: <T>(data: T | EncryptedData<T>) => {
    encryptionKeyId: string | null;
    data: T;
} | undefined;
export declare const maybeEncryptedIncomingData: <T>(contractID: string, state: ChelContractState, data: T | [string, string], height: number, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void) => T | EncryptedData<T>;
