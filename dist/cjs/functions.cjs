"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSubscriptionId = exports.bytesToB64 = exports.strToB64 = exports.strToBuf = exports.bufToB64 = exports.b64ToStr = exports.b64ToBuf = exports.maybeParseCID = exports.parseCID = exports.multicodes = void 0;
exports.createCIDfromStream = createCIDfromStream;
exports.createCID = createCID;
exports.blake32Hash = blake32Hash;
const base58_1 = require("@chelonia/multiformats/bases/base58");
const blake2b_1 = require("@chelonia/multiformats/blake2b");
const blake2bstream_1 = require("@chelonia/multiformats/blake2bstream");
const cid_1 = require("@chelonia/multiformats/cid");
// Use 'buffer' instead of 'node:buffer' to polyfill in the browser
const buffer_1 = require("buffer");
const turtledash_1 = require("turtledash");
// Values from https://github.com/multiformats/multicodec/blob/master/table.csv
exports.multicodes = {
    RAW: 0x00,
    JSON: 0x0200,
    SHELTER_CONTRACT_MANIFEST: 0x511e00,
    SHELTER_CONTRACT_TEXT: 0x511e01,
    SHELTER_CONTRACT_DATA: 0x511e02,
    SHELTER_FILE_MANIFEST: 0x511e03,
    SHELTER_FILE_CHUNK: 0x511e04
};
const parseCID = (cid) => {
    if (!cid || cid.length < 52 || cid.length > 64) {
        throw new RangeError('CID length too short or too long');
    }
    const parsed = cid_1.CID.parse(cid, base58_1.base58btc);
    if (parsed.version !== 1 ||
        parsed.multihash.code !== blake2b_1.blake2b256.code ||
        !Object.values(exports.multicodes).includes(parsed.code)) {
        throw new Error('Invalid CID');
    }
    return parsed;
};
exports.parseCID = parseCID;
const maybeParseCID = (cid) => {
    try {
        return (0, exports.parseCID)(cid);
    }
    catch {
        // Ignore errors if the CID couldn't be parsed
        return null;
    }
};
exports.maybeParseCID = maybeParseCID;
// Makes the `Buffer` global available in the browser if needed.
if (typeof globalThis === 'object' && !(0, turtledash_1.has)(globalThis, 'Buffer')) {
    globalThis.Buffer = buffer_1.Buffer;
}
async function createCIDfromStream(data, multicode = exports.multicodes.RAW) {
    const uint8array = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const digest = await blake2bstream_1.blake2b256stream.digest(uint8array);
    return cid_1.CID.create(1, multicode, digest).toString(base58_1.base58btc);
}
// TODO: implement a streaming hashing function for large files.
// Note: in fact this returns a serialized CID, not a CID object.
function createCID(data, multicode = exports.multicodes.RAW) {
    const uint8array = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const digest = blake2b_1.blake2b256.digest(uint8array);
    return cid_1.CID.create(1, multicode, digest).toString(base58_1.base58btc);
}
function blake32Hash(data) {
    const uint8array = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const digest = blake2b_1.blake2b256.digest(uint8array);
    // While `digest.digest` is only 32 bytes long in this case,
    // `digest.bytes` is 36 bytes because it includes a multiformat prefix.
    return base58_1.base58btc.encode(digest.bytes);
}
// NOTE: to preserve consistency across browser and node, we use the Buffer
//       class. We could use btoa and atob in web browsers (functions that
//       are unavailable on Node.js), but they do not support Unicode,
//       and you have to jump through some hoops to get it to work:
//       https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/btoa#Unicode_strings
//       These hoops might result in inconsistencies between Node.js and the frontend.
const b64ToBuf = (b64) => buffer_1.Buffer.from(b64, 'base64');
exports.b64ToBuf = b64ToBuf;
const b64ToStr = (b64) => (0, exports.b64ToBuf)(b64).toString('utf8');
exports.b64ToStr = b64ToStr;
const bufToB64 = (buf) => buffer_1.Buffer.from(buf).toString('base64');
exports.bufToB64 = bufToB64;
const strToBuf = (str) => buffer_1.Buffer.from(str, 'utf8');
exports.strToBuf = strToBuf;
const strToB64 = (str) => (0, exports.strToBuf)(str).toString('base64');
exports.strToB64 = strToB64;
const bytesToB64 = (ary) => buffer_1.Buffer.from(ary).toString('base64');
exports.bytesToB64 = bytesToB64;
// Generate an UUID from a `PushSubscription'
const getSubscriptionId = async (subscriptionInfo) => {
    const textEncoder = new TextEncoder();
    // <https://w3c.github.io/push-api/#pushsubscription-interface>
    const endpoint = textEncoder.encode(subscriptionInfo.endpoint);
    // <https://w3c.github.io/push-api/#pushencryptionkeyname-enumeration>
    const p256dh = textEncoder.encode(subscriptionInfo.keys.p256dh);
    const auth = textEncoder.encode(subscriptionInfo.keys.auth);
    const canonicalForm = new ArrayBuffer(8 +
        (4 + endpoint.byteLength) + (2 + p256dh.byteLength) +
        (2 + auth.byteLength));
    const canonicalFormU8 = new Uint8Array(canonicalForm);
    const canonicalFormDV = new DataView(canonicalForm);
    let offset = 0;
    canonicalFormDV.setFloat64(offset, subscriptionInfo.expirationTime == null
        ? NaN
        : subscriptionInfo.expirationTime, false);
    offset += 8;
    canonicalFormDV.setUint32(offset, endpoint.byteLength, false);
    offset += 4;
    canonicalFormU8.set(endpoint, offset);
    offset += endpoint.byteLength;
    canonicalFormDV.setUint16(offset, p256dh.byteLength, false);
    offset += 2;
    canonicalFormU8.set(p256dh, offset);
    offset += p256dh.byteLength;
    canonicalFormDV.setUint16(offset, auth.byteLength, false);
    offset += 2;
    canonicalFormU8.set(auth, offset);
    const digest = await crypto.subtle.digest('SHA-384', canonicalForm);
    const id = buffer_1.Buffer.from(digest.slice(0, 16));
    id[6] = 0x80 | (id[6] & 0x0F);
    id[8] = 0x80 | (id[8] & 0x3F);
    return [
        id.slice(0, 4),
        id.slice(4, 6),
        id.slice(6, 8),
        id.slice(8, 10),
        id.slice(10, 16)
    ].map((p) => p.toString('hex')).join('-');
};
exports.getSubscriptionId = getSubscriptionId;
