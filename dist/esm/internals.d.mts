import './db.mjs';
export type PublishOptions = {
    maxAttempts?: number;
    headers?: Record<string, string>;
    billableContractID?: string;
    bearer?: string;
    disableAutoDedup?: boolean;
};
declare const _default: string[];
export default _default;
export declare const clearReprocessDebounceForContract: (contractID: string) => void;
export declare const clearReprocessDebounceAll: () => void;
