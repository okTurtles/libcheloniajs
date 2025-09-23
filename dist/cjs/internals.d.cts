import './db.cjs';
export type PublishOptions = {
    maxAttempts?: number;
    headers?: Record<string, string>;
    billableContractID?: string;
    bearer?: string;
    disableAutoDedup?: boolean;
};
declare const _default: string[];
export default _default;
