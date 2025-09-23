// ugly boilerplate because JavaScript is stupid
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#Custom_Error_Types
export const ChelErrorGenerator = (name, base = Error) => ((class extends base {
    constructor(...params) {
        super(...params);
        this.name = name; // string literal so minifier doesn't overwrite
        // Polyfill for cause property
        if (params[1]?.cause !== this.cause) {
            Object.defineProperty(this, 'cause', { configurable: true, writable: true, value: params[1]?.cause });
        }
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}));
export const ChelErrorWarning = ChelErrorGenerator('ChelErrorWarning');
export const ChelErrorAlreadyProcessed = ChelErrorGenerator('ChelErrorAlreadyProcessed');
export const ChelErrorDBBadPreviousHEAD = ChelErrorGenerator('ChelErrorDBBadPreviousHEAD');
export const ChelErrorDBConnection = ChelErrorGenerator('ChelErrorDBConnection');
export const ChelErrorUnexpected = ChelErrorGenerator('ChelErrorUnexpected');
export const ChelErrorKeyAlreadyExists = ChelErrorGenerator('ChelErrorKeyAlreadyExists');
export const ChelErrorUnrecoverable = ChelErrorGenerator('ChelErrorUnrecoverable');
export const ChelErrorForkedChain = ChelErrorGenerator('ChelErrorForkedChain');
export const ChelErrorDecryptionError = ChelErrorGenerator('ChelErrorDecryptionError');
export const ChelErrorDecryptionKeyNotFound = ChelErrorGenerator('ChelErrorDecryptionKeyNotFound', ChelErrorDecryptionError);
export const ChelErrorSignatureError = ChelErrorGenerator('ChelErrorSignatureError');
export const ChelErrorSignatureKeyUnauthorized = ChelErrorGenerator('ChelErrorSignatureKeyUnauthorized', ChelErrorSignatureError);
export const ChelErrorSignatureKeyNotFound = ChelErrorGenerator('ChelErrorSignatureKeyNotFound', ChelErrorSignatureError);
export const ChelErrorFetchServerTimeFailed = ChelErrorGenerator('ChelErrorFetchServerTimeFailed');
export const ChelErrorUnexpectedHttpResponseCode = ChelErrorGenerator('ChelErrorUnexpectedHttpResponseCode');
export const ChelErrorResourceGone = ChelErrorGenerator('ChelErrorResourceGone', ChelErrorUnexpectedHttpResponseCode);
