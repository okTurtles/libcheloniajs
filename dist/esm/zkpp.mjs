import { Buffer } from 'buffer';
import scrypt from 'scrypt-async';
import nacl from 'tweetnacl';
import { AUTHSALT, CONTRACTSALT, CS, SALT_LENGTH_IN_OCTETS, SU } from './zkppConstants.mjs';
// .toString('base64url') only works in Node.js
export const base64ToBase64url = (s) => s.replace(/\//g, '_').replace(/\+/g, '-').replace(/=*$/, '');
export const base64urlToBase64 = (s) => s.replace(/_/g, '/').replace(/-/g, '+') + '='.repeat((4 - s.length % 4) % 4);
export const hashStringArray = (...args) => {
    return nacl.hash(Buffer.concat(args.map((s) => nacl.hash(Buffer.from(s)))));
};
export const hashRawStringArray = (...args) => {
    return nacl.hash(Buffer.concat(args.map((s) => Buffer.from(s))));
};
export const randomNonce = () => {
    return base64ToBase64url(Buffer.from(nacl.randomBytes(12)).toString('base64'));
};
export const hashRawB64url = (v) => {
    return base64ToBase64url(Buffer.from(nacl.hash(Buffer.from(v))).toString('base64'));
};
export const hash = (v) => {
    return base64ToBase64url(Buffer.from(nacl.hash(Buffer.from(v))).toString('base64'));
};
export const computeCAndHc = (r, s, h) => {
    const ħ = hashStringArray(r, s);
    const c = hashStringArray(h, ħ);
    const hc = nacl.hash(c);
    return [c, hc];
};
export const encryptContractSalt = (c, contractSalt) => {
    const encryptionKey = hashRawStringArray(CS, c).slice(0, nacl.secretbox.keyLength);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encryptedContractSalt = nacl.secretbox(Buffer.from(contractSalt), nonce, encryptionKey);
    return base64ToBase64url(Buffer.concat([nonce, encryptedContractSalt]).toString('base64'));
};
export const decryptContractSalt = (c, encryptedContractSaltBox) => {
    const encryptionKey = hashRawStringArray(CS, c).slice(0, nacl.secretbox.keyLength);
    const encryptedContractSaltBoxBuf = Buffer.from(base64urlToBase64(encryptedContractSaltBox), 'base64');
    const nonce = encryptedContractSaltBoxBuf.subarray(0, nacl.secretbox.nonceLength);
    const encryptedContractSalt = encryptedContractSaltBoxBuf.subarray(nacl.secretbox.nonceLength);
    const decrypted = nacl.secretbox.open(encryptedContractSalt, nonce, encryptionKey);
    if (!decrypted)
        throw new Error('Failed to decrypt contract salt');
    return Buffer.from(decrypted).toString();
};
export const encryptSaltUpdate = (secret, recordId, record) => {
    // The nonce is also used to derive a single-use encryption key
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encryptionKey = hashRawStringArray(SU, secret, nonce, recordId).slice(0, nacl.secretbox.keyLength);
    const encryptedRecord = nacl.secretbox(Buffer.from(record), nonce, encryptionKey);
    return base64ToBase64url(Buffer.concat([nonce, encryptedRecord]).toString('base64'));
};
export const decryptSaltUpdate = (secret, recordId, encryptedRecordBox) => {
    // The nonce is also used to derive a single-use encryption key
    const encryptedRecordBoxBuf = Buffer.from(base64urlToBase64(encryptedRecordBox), 'base64');
    const nonce = encryptedRecordBoxBuf.subarray(0, nacl.secretbox.nonceLength);
    const encryptionKey = hashRawStringArray(SU, secret, nonce, recordId).slice(0, nacl.secretbox.keyLength);
    const encryptedRecord = encryptedRecordBoxBuf.subarray(nacl.secretbox.nonceLength);
    const decrypted = nacl.secretbox.open(encryptedRecord, nonce, encryptionKey);
    if (!decrypted)
        throw new Error('Failed to decrypt salt update');
    return Buffer.from(decrypted).toString();
};
export const hashPassword = (password, salt) => {
    // NOTE: Type cast needed on `scrypt` because for some reason TypeScript will
    // incorrectly complain about it not taking string arguments.
    return new Promise(resolve => scrypt(password, salt, {
        N: 16384,
        r: 8,
        p: 1,
        dkLen: 32,
        encoding: 'hex'
    }, resolve));
};
export const boxKeyPair = () => {
    return nacl.box.keyPair();
};
export const saltAgreement = (publicKey, secretKey) => {
    const publicKeyBuf = Buffer.from(base64urlToBase64(publicKey), 'base64');
    const dhKey = nacl.box.before(publicKeyBuf, secretKey);
    if (!publicKeyBuf || publicKeyBuf.byteLength !== nacl.box.publicKeyLength) {
        return false;
    }
    const authSalt = Buffer.from(hashStringArray(AUTHSALT, dhKey)).subarray(0, SALT_LENGTH_IN_OCTETS).toString('base64');
    const contractSalt = Buffer.from(hashStringArray(CONTRACTSALT, dhKey)).subarray(0, SALT_LENGTH_IN_OCTETS).toString('base64');
    return [authSalt, contractSalt];
};
export const parseRegisterSalt = (publicKey, secretKey, encryptedHashedPassword) => {
    const saltAgreementRes = saltAgreement(publicKey, secretKey);
    if (!saltAgreementRes) {
        return false;
    }
    const [authSalt, contractSalt] = saltAgreementRes;
    const encryptionKey = nacl.hash(Buffer.from(authSalt + contractSalt)).slice(0, nacl.secretbox.keyLength);
    const encryptedHashedPasswordBuf = Buffer.from(base64urlToBase64(encryptedHashedPassword), 'base64');
    const hashedPasswordBuf = nacl.secretbox.open(encryptedHashedPasswordBuf.subarray(nacl.box.nonceLength), encryptedHashedPasswordBuf.subarray(0, nacl.box.nonceLength), encryptionKey);
    if (!hashedPasswordBuf) {
        return false;
    }
    return [authSalt, contractSalt, hashedPasswordBuf, encryptionKey];
};
export const buildRegisterSaltRequest = async (publicKey, secretKey, password) => {
    const saltAgreementRes = saltAgreement(publicKey, secretKey);
    if (!saltAgreementRes) {
        throw new Error('Invalid public or secret key');
    }
    const [authSalt, contractSalt] = saltAgreementRes;
    const hashedPassword = await hashPassword(password, authSalt);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encryptionKey = nacl.hash(Buffer.from(authSalt + contractSalt)).slice(0, nacl.secretbox.keyLength);
    const encryptedHashedPasswordBuf = nacl.secretbox(Buffer.from(hashedPassword), nonce, encryptionKey);
    return [contractSalt, base64ToBase64url(Buffer.concat([nonce, encryptedHashedPasswordBuf]).toString('base64')), encryptionKey];
};
// Build the `E_c` (encrypted arguments) to send to the server to negotiate a
// password change. `password` corresponds to the raw user password, `c` is a
// negotiated shared secret between the server and the client. The encrypted
// payload contains the salted user password (using `authSalt`).
// The return value includes the derived contract salt and the `E_c`.
export const buildUpdateSaltRequestEc = async (password, c) => {
    // Derive S_A (authentication salt) and S_C (contract salt) as follows:
    //   -> S_T -< BASE64(SHA-512(SHA-512(T) + SHA-512(c))[0..18]) with T being
    //     `AUTHSALT` (for S_A) or `CONTRACTSALT` (for S_C).
    // This way, we ensure both the server and the client contribute to the
    //   salts' entropy. Having more sources of entropy contributes to higher
    //   randomness in the result.
    // When sending the encrypted data, the encrypted information would be
    // `hashedPassword`, which needs to be verified server-side to verify
    // it matches p and would be used to derive S_A and S_C.
    const authSalt = Buffer.from(hashStringArray(AUTHSALT, c)).subarray(0, SALT_LENGTH_IN_OCTETS).toString('base64');
    const contractSalt = Buffer.from(hashStringArray(CONTRACTSALT, c)).subarray(0, SALT_LENGTH_IN_OCTETS).toString('base64');
    const encryptionKey = hashRawStringArray(SU, c).slice(0, nacl.secretbox.keyLength);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const hashedPassword = await hashPassword(password, authSalt);
    const encryptedArgsCiphertext = nacl.secretbox(Buffer.from(hashedPassword), nonce, encryptionKey);
    const encryptedArgs = Buffer.concat([nonce, encryptedArgsCiphertext]);
    return [contractSalt, base64ToBase64url(encryptedArgs.toString('base64'))];
};
