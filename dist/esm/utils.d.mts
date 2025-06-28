import type { SPKey, SPKeyPurpose, SPKeyUpdate, SPOpValue } from './SPMessage.mjs';
import { SPMessage } from './SPMessage.mjs';
import type { EncryptedData } from './encryptedData.mjs';
import { ChelContractKey, ChelContractState, ChelRootState, CheloniaConfig, CheloniaContext, JSONType } from './types.mjs';
export declare const findKeyIdByName: (state: ChelContractState, name: string) => string | null | undefined;
export declare const findForeignKeysByContractID: (state: ChelContractState, contractID: string) => string[] | undefined;
export declare const findRevokedKeyIdsByName: (state: ChelContractState, name: string) => string[];
export declare const findSuitableSecretKeyId: (state: ChelContractState, permissions: "*" | string[], purposes: SPKeyPurpose[], ringLevel?: number, allowedActions?: "*" | string[]) => string | null | undefined;
export declare const findContractIDByForeignKeyId: (state: ChelContractState, keyId: string) => string | null | undefined;
export declare const findSuitablePublicKeyIds: (state: ChelContractState, permissions: "*" | string[], purposes: SPKeyPurpose[], ringLevel?: number) => string[] | null | undefined;
export declare const validateKeyPermissions: (msg: SPMessage, config: CheloniaConfig, state: {
    _vm: {
        authorizedKeys: ChelContractState["_vm"]["authorizedKeys"];
    };
}, signingKeyId: string, opT: string, opV: SPOpValue) => boolean;
export declare const validateKeyAddPermissions: (this: CheloniaContext, contractID: string, signingKey: ChelContractKey, state: ChelContractState, v: (ChelContractKey | SPKey | EncryptedData<SPKey>)[], skipPrivateCheck?: boolean) => void;
export declare const validateKeyDelPermissions: (this: CheloniaContext, contractID: string, signingKey: ChelContractKey, state: ChelContractState, v: (string | EncryptedData<string>)[]) => void;
export declare const validateKeyUpdatePermissions: (this: CheloniaContext, contractID: string, signingKey: ChelContractKey, state: ChelContractState, v: (SPKeyUpdate | EncryptedData<SPKeyUpdate>)[]) => [ChelContractKey[], Record<string, string>];
export declare const keyAdditionProcessor: (this: CheloniaContext, _msg: SPMessage, hash: string, keys: (ChelContractKey | SPKey | EncryptedData<SPKey>)[], state: ChelContractState, contractID: string, _signingKey: ChelContractKey, internalSideEffectStack?: (({ state, message }: {
    state: ChelContractState;
    message: SPMessage;
}) => void)[]) => void;
export declare const subscribeToForeignKeyContracts: (this: CheloniaContext, contractID: string, state: ChelContractState) => void;
export declare const recreateEvent: (entry: SPMessage, state: ChelContractState, contractsState: ChelRootState["contracts"][string]) => undefined | SPMessage;
export declare const getContractIDfromKeyId: (contractID: string, signingKeyId: string | null | undefined, state: ChelContractState) => string | null | undefined;
export declare function eventsAfter(this: CheloniaContext, contractID: string, sinceHeight: number, limit?: number, sinceHash?: string, { stream }?: {
    stream: boolean;
}): ReadableStream<string> | Promise<string[]>;
export declare function buildShelterAuthorizationHeader(this: CheloniaContext, contractID: string, state?: ChelContractState): string;
export declare function verifyShelterAuthorizationHeader(authorization: string, rootState?: object): string;
export declare const clearObject: (o: object) => void;
export declare const reactiveClearObject: <T extends object>(o: T, fn: (o: T, k: keyof T) => void) => void;
export declare const checkCanBeGarbageCollected: (this: CheloniaContext, id: string) => boolean;
export declare const collectEventStream: <T>(s: ReadableStream<T>) => Promise<T[]>;
export declare const logEvtError: (msg: SPMessage, ...args: unknown[]) => void;
export declare const handleFetchResult: (type: "text" | "json" | "blob") => ((r: Response) => Promise<string | JSONType | Blob>);
