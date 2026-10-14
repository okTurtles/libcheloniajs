export declare const ChelErrorKvMaxAttempts: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare function isKvMaxAttempts(e: unknown): e is Error & {
    name: 'ChelErrorKvMaxAttempts';
};
