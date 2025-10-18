"use strict";
// ugly boilerplate because JavaScript is stupid
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#Custom_Error_Types
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChelErrorResourceGone = exports.ChelErrorUnexpectedHttpResponseCode = exports.ChelErrorFetchServerTimeFailed = exports.ChelErrorSignatureKeyNotFound = exports.ChelErrorSignatureKeyUnauthorized = exports.ChelErrorSignatureError = exports.ChelErrorDecryptionKeyNotFound = exports.ChelErrorDecryptionError = exports.ChelErrorForkedChain = exports.ChelErrorUnrecoverable = exports.ChelErrorKeyAlreadyExists = exports.ChelErrorUnexpected = exports.ChelErrorDBConnection = exports.ChelErrorDBBadPreviousHEAD = exports.ChelErrorAlreadyProcessed = exports.ChelErrorWarning = exports.ChelErrorGenerator = void 0;
const ChelErrorGenerator = (name, base = Error) => class extends base {
    constructor(...params) {
        super(...params);
        this.name = name; // string literal so minifier doesn't overwrite
        // Polyfill for cause property
        if (params[1]?.cause !== this.cause) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                writable: true,
                value: params[1]?.cause
            });
        }
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
};
exports.ChelErrorGenerator = ChelErrorGenerator;
exports.ChelErrorWarning = (0, exports.ChelErrorGenerator)('ChelErrorWarning');
exports.ChelErrorAlreadyProcessed = (0, exports.ChelErrorGenerator)('ChelErrorAlreadyProcessed');
exports.ChelErrorDBBadPreviousHEAD = (0, exports.ChelErrorGenerator)('ChelErrorDBBadPreviousHEAD');
exports.ChelErrorDBConnection = (0, exports.ChelErrorGenerator)('ChelErrorDBConnection');
exports.ChelErrorUnexpected = (0, exports.ChelErrorGenerator)('ChelErrorUnexpected');
exports.ChelErrorKeyAlreadyExists = (0, exports.ChelErrorGenerator)('ChelErrorKeyAlreadyExists');
exports.ChelErrorUnrecoverable = (0, exports.ChelErrorGenerator)('ChelErrorUnrecoverable');
exports.ChelErrorForkedChain = (0, exports.ChelErrorGenerator)('ChelErrorForkedChain');
exports.ChelErrorDecryptionError = (0, exports.ChelErrorGenerator)('ChelErrorDecryptionError');
exports.ChelErrorDecryptionKeyNotFound = (0, exports.ChelErrorGenerator)('ChelErrorDecryptionKeyNotFound', exports.ChelErrorDecryptionError);
exports.ChelErrorSignatureError = (0, exports.ChelErrorGenerator)('ChelErrorSignatureError');
exports.ChelErrorSignatureKeyUnauthorized = (0, exports.ChelErrorGenerator)('ChelErrorSignatureKeyUnauthorized', exports.ChelErrorSignatureError);
exports.ChelErrorSignatureKeyNotFound = (0, exports.ChelErrorGenerator)('ChelErrorSignatureKeyNotFound', exports.ChelErrorSignatureError);
exports.ChelErrorFetchServerTimeFailed = (0, exports.ChelErrorGenerator)('ChelErrorFetchServerTimeFailed');
exports.ChelErrorUnexpectedHttpResponseCode = (0, exports.ChelErrorGenerator)('ChelErrorUnexpectedHttpResponseCode');
exports.ChelErrorResourceGone = (0, exports.ChelErrorGenerator)('ChelErrorResourceGone', exports.ChelErrorUnexpectedHttpResponseCode);
