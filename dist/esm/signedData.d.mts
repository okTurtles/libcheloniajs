import type { Key } from '@chelonia/crypto';
import type { ChelContractState } from './types.mjs';
export interface SignedData<T, U extends object = object> {
    signingKeyId: string;
    valueOf: () => T;
    serialize: (additionalData?: string) => U & {
        _signedData: [string, string, string];
    };
    context?: [string, U & {
        _signedData: [string, string, string];
    }, number, string];
    toString: (additionalData?: string) => string;
    recreate?: (data: T) => SignedData<T, U>;
    toJSON?: () => U & {
        _signedData: [string, string, string];
    };
    get: (k: keyof U) => U[typeof k] | undefined;
    set?: (k: keyof U, v: U[typeof k]) => void;
}
export declare const isSignedData: <T, U extends object = object>(o: unknown) => o is SignedData<T, U>;
export declare const signedOutgoingData: <T, U extends object = object>(stateOrContractID: string | ChelContractState, sKeyId: string, data: T, additionalKeys?: Record<string, Key | string>) => SignedData<T, U>;
export declare const signedOutgoingDataWithRawKey: <T, U extends object = object>(key: Key, data: T) => SignedData<T, U>;
export declare const signedIncomingData: <T, V = T, U extends object = object>(contractID: string, state: object | null | undefined, data: U & {
    _signedData: [string, string, string];
}, height: number, additionalData: string, mapperFn?: (value: V) => T) => SignedData<T, U>;
export declare const signedDataKeyId: (data: unknown) => string;
export declare const isRawSignedData: (data: unknown) => data is {
    _signedData: [string, string, string];
};
export declare const rawSignedIncomingData: <T, U extends object = object>(data: U & {
    _signedData: [string, string, string];
}) => SignedData<T, U>;
