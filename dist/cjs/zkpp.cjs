"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildUpdateSaltRequestEc = exports.buildRegisterSaltRequest = exports.parseRegisterSalt = exports.saltAgreement = exports.boxKeyPair = exports.hashPassword = exports.decryptSaltUpdate = exports.encryptSaltUpdate = exports.decryptContractSalt = exports.encryptContractSalt = exports.computeCAndHc = exports.hash = exports.hashRawB64url = exports.randomNonce = exports.hashRawStringArray = exports.hashStringArray = exports.base64urlToBase64 = exports.base64ToBase64url = void 0;
const buffer_1 = require("buffer");
const scrypt_async_1 = __importDefault(require("scrypt-async"));
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const zkppConstants_js_1 = require("./zkppConstants.cjs");
// .toString('base64url') only works in Node.js
const base64ToBase64url = (s) => s.replace(/\//g, '_').replace(/\+/g, '-').replace(/=*$/, '');
exports.base64ToBase64url = base64ToBase64url;
const base64urlToBase64 = (s) => s.replace(/_/g, '/').replace(/-/g, '+') + '='.repeat((4 - s.length % 4) % 4);
exports.base64urlToBase64 = base64urlToBase64;
const hashStringArray = (...args) => {
    return tweetnacl_1.default.hash(buffer_1.Buffer.concat(args.map((s) => tweetnacl_1.default.hash(buffer_1.Buffer.from(s)))));
};
exports.hashStringArray = hashStringArray;
const hashRawStringArray = (...args) => {
    return tweetnacl_1.default.hash(buffer_1.Buffer.concat(args.map((s) => buffer_1.Buffer.from(s))));
};
exports.hashRawStringArray = hashRawStringArray;
const randomNonce = () => {
    return (0, exports.base64ToBase64url)(buffer_1.Buffer.from(tweetnacl_1.default.randomBytes(12)).toString('base64'));
};
exports.randomNonce = randomNonce;
const hashRawB64url = (v) => {
    return (0, exports.base64ToBase64url)(buffer_1.Buffer.from(tweetnacl_1.default.hash(buffer_1.Buffer.from(v))).toString('base64'));
};
exports.hashRawB64url = hashRawB64url;
const hash = (v) => {
    return (0, exports.base64ToBase64url)(buffer_1.Buffer.from(tweetnacl_1.default.hash(buffer_1.Buffer.from(v))).toString('base64'));
};
exports.hash = hash;
const computeCAndHc = (r, s, h) => {
    const ħ = (0, exports.hashStringArray)(r, s);
    const c = (0, exports.hashStringArray)(h, ħ);
    const hc = tweetnacl_1.default.hash(c);
    return [c, hc];
};
exports.computeCAndHc = computeCAndHc;
const encryptContractSalt = (c, contractSalt) => {
    const encryptionKey = (0, exports.hashRawStringArray)(zkppConstants_js_1.CS, c).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.secretbox.nonceLength);
    const encryptedContractSalt = tweetnacl_1.default.secretbox(buffer_1.Buffer.from(contractSalt), nonce, encryptionKey);
    return (0, exports.base64ToBase64url)(buffer_1.Buffer.concat([nonce, encryptedContractSalt]).toString('base64'));
};
exports.encryptContractSalt = encryptContractSalt;
const decryptContractSalt = (c, encryptedContractSaltBox) => {
    const encryptionKey = (0, exports.hashRawStringArray)(zkppConstants_js_1.CS, c).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const encryptedContractSaltBoxBuf = buffer_1.Buffer.from((0, exports.base64urlToBase64)(encryptedContractSaltBox), 'base64');
    const nonce = encryptedContractSaltBoxBuf.subarray(0, tweetnacl_1.default.secretbox.nonceLength);
    const encryptedContractSalt = encryptedContractSaltBoxBuf.subarray(tweetnacl_1.default.secretbox.nonceLength);
    const decrypted = tweetnacl_1.default.secretbox.open(encryptedContractSalt, nonce, encryptionKey);
    if (!decrypted)
        throw new Error('Failed to decrypt contract salt');
    return buffer_1.Buffer.from(decrypted).toString();
};
exports.decryptContractSalt = decryptContractSalt;
const encryptSaltUpdate = (secret, recordId, record) => {
    // The nonce is also used to derive a single-use encryption key
    const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.secretbox.nonceLength);
    const encryptionKey = (0, exports.hashRawStringArray)(zkppConstants_js_1.SU, secret, nonce, recordId).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const encryptedRecord = tweetnacl_1.default.secretbox(buffer_1.Buffer.from(record), nonce, encryptionKey);
    return (0, exports.base64ToBase64url)(buffer_1.Buffer.concat([nonce, encryptedRecord]).toString('base64'));
};
exports.encryptSaltUpdate = encryptSaltUpdate;
const decryptSaltUpdate = (secret, recordId, encryptedRecordBox) => {
    // The nonce is also used to derive a single-use encryption key
    const encryptedRecordBoxBuf = buffer_1.Buffer.from((0, exports.base64urlToBase64)(encryptedRecordBox), 'base64');
    const nonce = encryptedRecordBoxBuf.subarray(0, tweetnacl_1.default.secretbox.nonceLength);
    const encryptionKey = (0, exports.hashRawStringArray)(zkppConstants_js_1.SU, secret, nonce, recordId).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const encryptedRecord = encryptedRecordBoxBuf.subarray(tweetnacl_1.default.secretbox.nonceLength);
    const decrypted = tweetnacl_1.default.secretbox.open(encryptedRecord, nonce, encryptionKey);
    if (!decrypted)
        throw new Error('Failed to decrypt salt update');
    return buffer_1.Buffer.from(decrypted).toString();
};
exports.decryptSaltUpdate = decryptSaltUpdate;
const hashPassword = (password, salt) => {
    // NOTE: Type cast needed on `scrypt` because for some reason TypeScript will
    // incorrectly complain about it not taking string arguments.
    return new Promise(resolve => scrypt_async_1.default(password, salt, {
        N: 16384,
        r: 8,
        p: 1,
        dkLen: 32,
        encoding: 'hex'
    }, resolve));
};
exports.hashPassword = hashPassword;
const boxKeyPair = () => {
    return tweetnacl_1.default.box.keyPair();
};
exports.boxKeyPair = boxKeyPair;
const saltAgreement = (publicKey, secretKey) => {
    const publicKeyBuf = buffer_1.Buffer.from((0, exports.base64urlToBase64)(publicKey), 'base64');
    const dhKey = tweetnacl_1.default.box.before(publicKeyBuf, secretKey);
    if (!publicKeyBuf || publicKeyBuf.byteLength !== tweetnacl_1.default.box.publicKeyLength) {
        return false;
    }
    const authSalt = buffer_1.Buffer.from((0, exports.hashStringArray)(zkppConstants_js_1.AUTHSALT, dhKey)).subarray(0, zkppConstants_js_1.SALT_LENGTH_IN_OCTETS).toString('base64');
    const contractSalt = buffer_1.Buffer.from((0, exports.hashStringArray)(zkppConstants_js_1.CONTRACTSALT, dhKey)).subarray(0, zkppConstants_js_1.SALT_LENGTH_IN_OCTETS).toString('base64');
    return [authSalt, contractSalt];
};
exports.saltAgreement = saltAgreement;
const parseRegisterSalt = (publicKey, secretKey, encryptedHashedPassword) => {
    const saltAgreementRes = (0, exports.saltAgreement)(publicKey, secretKey);
    if (!saltAgreementRes) {
        return false;
    }
    const [authSalt, contractSalt] = saltAgreementRes;
    const encryptionKey = tweetnacl_1.default.hash(buffer_1.Buffer.from(authSalt + contractSalt)).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const encryptedHashedPasswordBuf = buffer_1.Buffer.from((0, exports.base64urlToBase64)(encryptedHashedPassword), 'base64');
    const hashedPasswordBuf = tweetnacl_1.default.secretbox.open(encryptedHashedPasswordBuf.subarray(tweetnacl_1.default.box.nonceLength), encryptedHashedPasswordBuf.subarray(0, tweetnacl_1.default.box.nonceLength), encryptionKey);
    if (!hashedPasswordBuf) {
        return false;
    }
    return [authSalt, contractSalt, hashedPasswordBuf, encryptionKey];
};
exports.parseRegisterSalt = parseRegisterSalt;
const buildRegisterSaltRequest = async (publicKey, secretKey, password) => {
    const saltAgreementRes = (0, exports.saltAgreement)(publicKey, secretKey);
    if (!saltAgreementRes) {
        throw new Error('Invalid public or secret key');
    }
    const [authSalt, contractSalt] = saltAgreementRes;
    const hashedPassword = await (0, exports.hashPassword)(password, authSalt);
    const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.box.nonceLength);
    const encryptionKey = tweetnacl_1.default.hash(buffer_1.Buffer.from(authSalt + contractSalt)).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const encryptedHashedPasswordBuf = tweetnacl_1.default.secretbox(buffer_1.Buffer.from(hashedPassword), nonce, encryptionKey);
    return [contractSalt, (0, exports.base64ToBase64url)(buffer_1.Buffer.concat([nonce, encryptedHashedPasswordBuf]).toString('base64')), encryptionKey];
};
exports.buildRegisterSaltRequest = buildRegisterSaltRequest;
// Build the `E_c` (encrypted arguments) to send to the server to negotiate a
// password change. `password` corresponds to the raw user password, `c` is a
// negotiated shared secret between the server and the client. The encrypted
// payload contains the salted user password (using `authSalt`).
// The return value includes the derived contract salt and the `E_c`.
const buildUpdateSaltRequestEc = async (password, c) => {
    // Derive S_A (authentication salt) and S_C (contract salt) as follows:
    //   -> S_T -< BASE64(SHA-512(SHA-512(T) + SHA-512(c))[0..18]) with T being
    //     `AUTHSALT` (for S_A) or `CONTRACTSALT` (for S_C).
    // This way, we ensure both the server and the client contribute to the
    //   salts' entropy. Having more sources of entropy contributes to higher
    //   randomness in the result.
    // When sending the encrypted data, the encrypted information would be
    // `hashedPassword`, which needs to be verified server-side to verify
    // it matches p and would be used to derive S_A and S_C.
    const authSalt = buffer_1.Buffer.from((0, exports.hashStringArray)(zkppConstants_js_1.AUTHSALT, c)).subarray(0, zkppConstants_js_1.SALT_LENGTH_IN_OCTETS).toString('base64');
    const contractSalt = buffer_1.Buffer.from((0, exports.hashStringArray)(zkppConstants_js_1.CONTRACTSALT, c)).subarray(0, zkppConstants_js_1.SALT_LENGTH_IN_OCTETS).toString('base64');
    const encryptionKey = (0, exports.hashRawStringArray)(zkppConstants_js_1.SU, c).slice(0, tweetnacl_1.default.secretbox.keyLength);
    const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.secretbox.nonceLength);
    const hashedPassword = await (0, exports.hashPassword)(password, authSalt);
    const encryptedArgsCiphertext = tweetnacl_1.default.secretbox(buffer_1.Buffer.from(hashedPassword), nonce, encryptionKey);
    const encryptedArgs = buffer_1.Buffer.concat([nonce, encryptedArgsCiphertext]);
    return [contractSalt, (0, exports.base64ToBase64url)(encryptedArgs.toString('base64'))];
};
exports.buildUpdateSaltRequestEc = buildUpdateSaltRequestEc;
