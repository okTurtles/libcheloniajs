import type { Key } from '@chelonia/crypto';
import type { ChelContractState } from './types.mjs';
export type RawSignedData<T extends object = object> = T & {
    _signedData: [data: string, keyId: string, signature: string];
};
export type SignedDataContext<T extends object = object> = [
    contractID: string,
    rawSignedData: RawSignedData<T>,
    height: number,
    additionalData: string
];
export interface SignedData<T, U extends object = object> {
    signingKeyId: string;
    valueOf: () => T;
    serialize: (additionalData?: string) => RawSignedData<U>;
    context?: SignedDataContext<U>;
    toString: (additionalData?: string) => string;
    recreate?: (data: T) => SignedData<T, U>;
    toJSON?: () => RawSignedData<U>;
    get: (k: keyof U) => U[typeof k] | undefined;
    set?: (k: keyof U, v: U[typeof k]) => void;
}
export declare const isSignedData: <T, U extends object = object>(o: unknown) => o is SignedData<T, U>;
export declare const signedOutgoingData: <T, U extends object = object>(stateOrContractID: string | ChelContractState, sKeyId: string, data: T, additionalKeys?: Record<string, Key | string>) => SignedData<T, U>;
export declare const signedOutgoingDataWithRawKey: <T, U extends object = object>(key: Key, data: T) => SignedData<T, U>;
export declare const signedIncomingData: <T, V = T, U extends object = object>(contractID: string, state: object | null | undefined, data: RawSignedData<U>, height: number, additionalData: string, mapperFn?: (value: V) => T) => SignedData<T, U>;
export declare const signedDataKeyId: (data: unknown) => string;
export declare const isRawSignedData: (data: unknown) => data is RawSignedData;
export declare const rawSignedIncomingData: <T, U extends object = object>(data: RawSignedData<U>) => SignedData<T, U>;
