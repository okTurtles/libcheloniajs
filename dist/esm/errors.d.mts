type ErrorConstructorType = {
    new (...args: ConstructorParameters<typeof Error>): Error;
};
export declare const ChelErrorGenerator: (name: string, base?: ErrorConstructorType) => {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorWarning: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorAlreadyProcessed: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorDBBadPreviousHEAD: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorDBConnection: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorUnexpected: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorKeyAlreadyExists: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorUnrecoverable: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorForkedChain: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorDecryptionError: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorDecryptionKeyNotFound: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorSignatureError: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorSignatureKeyUnauthorized: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorSignatureKeyNotFound: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorFetchServerTimeFailed: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorUnexpectedHttpResponseCode: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export declare const ChelErrorResourceGone: {
    new (message?: string | undefined, options?: ErrorOptions | undefined): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
};
export {};
