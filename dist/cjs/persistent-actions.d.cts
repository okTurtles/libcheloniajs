import '@sbp/okturtles.events';
import sbp from '@sbp/sbp';
declare const timer: unique symbol;
type SbpInvocation = Parameters<typeof sbp>;
export type UUIDV4 = `${string}-${string}-${string}-${string}-${string}`;
type PersistentActionOptions = {
    errorInvocation?: SbpInvocation;
    maxAttempts: number;
    retrySeconds: number;
    skipCondition?: SbpInvocation;
    totalFailureInvocation?: SbpInvocation;
};
export type PersistentActionStatus = {
    attempting: boolean;
    failedAttemptsSoFar: number;
    lastError: string;
    nextRetry: string;
    resolved: boolean;
};
export type PersistentActionError = {
    id: UUIDV4;
    error: Error;
};
export type PersistentActionSuccess = {
    id: UUIDV4;
    result: unknown;
};
export type PersistentActionSbpStatus = {
    id: UUIDV4;
    invocation: SbpInvocation;
    attempting: boolean;
    failedAttemptsSoFar: number;
    lastError: string;
    nextRetry: string;
    resolved: boolean;
};
export declare class PersistentAction {
    id: UUIDV4;
    invocation: SbpInvocation;
    options: PersistentActionOptions;
    status: PersistentActionStatus;
    [timer]?: ReturnType<typeof setTimeout>;
    constructor(invocation: SbpInvocation, options?: Partial<PersistentActionOptions>);
    attempt(): Promise<void>;
    cancel(): void;
    handleError(error: Error): Promise<void>;
    handleSuccess(result: unknown): void;
    trySBP(invocation: SbpInvocation | void): Promise<unknown>;
}
declare const _default: string[];
export default _default;
