"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.noneHandlers = exports.aes256gcmHandlers = void 0;
const encodeMultipartMessage_1 = __importDefault(require("@apeleghq/multipart-parser/encodeMultipartMessage"));
const decrypt_1 = __importDefault(require("@apeleghq/rfc8188/decrypt"));
const encodings_1 = require("@apeleghq/rfc8188/encodings");
const encrypt_1 = __importDefault(require("@apeleghq/rfc8188/encrypt"));
const crypto_1 = require("@chelonia/crypto");
const bytes_1 = require("@chelonia/multiformats/bytes");
const sbp_1 = __importDefault(require("@sbp/sbp"));
const buffer_1 = require("buffer");
const turtledash_1 = require("turtledash");
const functions_js_1 = require("./functions.cjs");
const utils_js_1 = require("./utils.cjs");
// Snippet from <https://github.com/WebKit/standards-positions/issues/24#issuecomment-1181821440>
// Node.js supports request streams, but also this check isn't meant for Node.js
// This part only checks for client-side support. Later, when we try uploading
// a file for the first time, we'll check if requests work, as streams are not
// supported in HTTP/1.1 and lower versions.
let supportsRequestStreams = typeof window !== 'object' || (() => {
    let duplexAccessed = false;
    const hasContentType = new Request('', {
        body: new ReadableStream(),
        method: 'POST',
        get duplex() {
            duplexAccessed = true;
            return 'half';
        }
    }).headers.has('content-type');
    return duplexAccessed && !hasContentType;
})();
const streamToUint8Array = async (s) => {
    const reader = s.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
        const result = await reader.read();
        if (result.done)
            break;
        chunks.push((0, bytes_1.coerce)(result.value));
        length += result.value.byteLength;
    }
    const body = new Uint8Array(length);
    chunks.reduce((offset, chunk) => {
        body.set(chunk, offset);
        return offset + chunk.byteLength;
    }, 0);
    return body;
};
// Check for streaming support, as of today (Feb 2024) only Blink-
// based browsers support this (i.e., Firefox and Safari don't).
const ArrayBufferToUint8ArrayStream = async function (connectionURL, s) {
    // Even if the browser supports streams, some browsers (e.g., Chrome) also
    // require that the server support HTTP/2
    if (supportsRequestStreams === true) {
        await this.config.fetch(`${connectionURL}/streams-test`, {
            method: 'POST',
            body: new ReadableStream({ start(c) { c.enqueue(buffer_1.Buffer.from('ok')); c.close(); } }),
            duplex: 'half'
        }).then((r) => {
            if (!r.ok)
                throw new Error('Unexpected response');
            // supportsRequestStreams is tri-state
            supportsRequestStreams = 2;
        }).catch(() => {
            console.info('files: Disabling streams support because the streams test failed');
            supportsRequestStreams = false;
        });
    }
    if (!supportsRequestStreams) {
        return await streamToUint8Array(s);
    }
    return s.pipeThrough(
    // eslint-disable-next-line no-undef
    new TransformStream({
        transform(chunk, controller) {
            controller.enqueue((0, bytes_1.coerce)(chunk));
        }
    }));
};
const computeChunkDescriptors = (inStream) => {
    let length = 0;
    const [lengthStream, cidStream] = inStream.tee();
    const lengthPromise = new Promise((resolve, reject) => {
        lengthStream.pipeTo(new WritableStream({
            write(chunk) {
                length += chunk.byteLength;
            },
            close() {
                resolve(length);
            },
            abort(reason) {
                reject(reason);
            }
        }));
    });
    const cidPromise = (0, functions_js_1.createCIDfromStream)(cidStream, functions_js_1.multicodes.SHELTER_FILE_CHUNK);
    return Promise.all([lengthPromise, cidPromise]);
};
const fileStream = (chelonia, manifest) => {
    const dataGenerator = async function* () {
        let readSize = 0;
        for (const chunk of manifest.chunks) {
            if (!Array.isArray(chunk) ||
                typeof chunk[0] !== 'number' ||
                typeof chunk[1] !== 'string') {
                throw new Error('Invalid chunk descriptor');
            }
            const chunkResponse = await chelonia.config.fetch(`${chelonia.config.connectionURL}/file/${chunk[1]}`, {
                method: 'GET',
                signal: chelonia.abortController.signal
            });
            if (!chunkResponse.ok) {
                throw new Error('Unable to retrieve manifest');
            }
            // TODO: We're reading the chunks in their entirety instead of using the
            // stream interface. In the future, this can be changed to get a stream
            // instead. Ensure then that the following checks are replaced with a
            // streaming version (length and CID)
            const chunkBinary = await chunkResponse.arrayBuffer();
            if (chunkBinary.byteLength !== chunk[0])
                throw new Error('mismatched chunk size');
            readSize += chunkBinary.byteLength;
            if (readSize > manifest.size)
                throw new Error('read size exceeds declared size');
            if ((0, functions_js_1.createCID)((0, bytes_1.coerce)(chunkBinary), functions_js_1.multicodes.SHELTER_FILE_CHUNK) !== chunk[1])
                throw new Error('mismatched chunk hash');
            yield chunkBinary;
        }
        // Now that we're done, we check to see if we read the correct size
        // If all went well, we should have and this would never throw. However,
        // if the payload was tampered with, we could have read a different size
        // than expected. This will throw at the end, after all chunks are processed
        // and after some or all of the data have already been consumed.
        // If integrity of the entire payload is important, consumers must buffer
        // the stream and wait until the end before any processing.
        if (readSize !== manifest.size)
            throw new Error('mismatched size');
    };
    const dataIterator = dataGenerator();
    return new ReadableStream({
        async pull(controller) {
            try {
                const chunk = await dataIterator.next();
                if (chunk.done) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk.value);
            }
            catch (e) {
                controller.error(e);
            }
        }
    });
};
exports.aes256gcmHandlers = {
    upload: (_chelonia, manifestOptions) => {
        // IKM stands for Input Keying Material, and is a random value used to
        // derive the encryption used in the chunks. See RFC 8188 for how the
        // actual encryption key gets derived from the IKM.
        const params = manifestOptions['cipher-params'];
        let IKM = params?.IKM;
        const recordSize = (params?.rs ?? 1 << 16);
        if (!IKM) {
            IKM = new Uint8Array(33);
            self.crypto.getRandomValues(IKM);
        }
        // The keyId is only used as a sanity check but otherwise it is not needed
        // Because the keyId is computed from the IKM, which is a secret, it is
        // truncated to just eight characters so that it doesn't disclose too much
        // information about the IKM (in theory, since it's a random string 33 bytes
        // long, a full hash shouldn't disclose too much information anyhow).
        // The reason the keyId is not _needed_ is that the IKM is part of the
        // downloadParams, so anyone downloading a file should have the required
        // context, and there is exactly one valid IKM for any downloadParams.
        // By truncating the keyId, the only way to fully verify whether a given
        // IKM decrypts a file is by attempting decryption.
        // A side-effect of truncating the keyId is that, if the IKM were shared
        // some other way (e.g., using the OP_KEY_SHARE mechanism), because of
        // collisions it may not always be possible to look up the correct IKM.
        // Therefore, a handler that uses a different strategy than the one used
        // here (namely, including the IKM in the downloadParams) may need to use
        // longer key IDs, possibly a full hash.
        const keyId = (0, functions_js_1.blake32Hash)('aes256gcm-keyId' + (0, functions_js_1.blake32Hash)(IKM)).slice(-8);
        const binaryKeyId = buffer_1.Buffer.from(keyId);
        return {
            cipherParams: {
                keyId
            },
            streamHandler: async (stream) => {
                return await (0, encrypt_1.default)(encodings_1.aes256gcm, stream, recordSize, binaryKeyId, IKM);
            },
            downloadParams: {
                IKM: buffer_1.Buffer.from(IKM).toString('base64'),
                rs: recordSize
            }
        };
    },
    download: (chelonia, downloadParams, manifest) => {
        const IKMb64 = downloadParams.IKM;
        if (!IKMb64) {
            throw new Error('Missing IKM in downloadParams');
        }
        const IKM = buffer_1.Buffer.from(IKMb64, 'base64');
        const keyId = (0, functions_js_1.blake32Hash)('aes256gcm-keyId' + (0, functions_js_1.blake32Hash)(IKM)).slice(-8);
        if (!manifest['cipher-params'] || !manifest['cipher-params'].keyId) {
            throw new Error('Missing cipher-params');
        }
        if (keyId !== manifest['cipher-params'].keyId) {
            throw new Error('Key ID mismatch');
        }
        const maxRecordSize = downloadParams.rs ?? 1 << 27; // 128 MiB
        return {
            payloadHandler: async () => {
                const bytes = await streamToUint8Array((0, decrypt_1.default)(encodings_1.aes256gcm, fileStream(chelonia, manifest), (actualKeyId) => {
                    if (buffer_1.Buffer.from(actualKeyId).toString() !== keyId) {
                        throw new Error('Invalid key ID');
                    }
                    return IKM;
                }, maxRecordSize));
                return new Blob([bytes], { type: manifest.type || 'application/octet-stream' });
            }
        };
    }
};
exports.noneHandlers = {
    upload: () => {
        return {
            cipherParams: undefined,
            streamHandler: (stream) => {
                return stream;
            },
            downloadParams: undefined
        };
    },
    download: (chelonia, _downloadParams, manifest) => {
        return {
            payloadHandler: async () => {
                const bytes = await streamToUint8Array(fileStream(chelonia, manifest));
                return new Blob([bytes], { type: manifest.type || 'application/octet-stream' });
            }
        };
    }
};
// TODO: Move into Chelonia config
const cipherHandlers = {
    aes256gcm: exports.aes256gcmHandlers,
    none: exports.noneHandlers
};
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    'chelonia/fileUpload': async function (chunks, manifestOptions, { billableContractID } = {}) {
        if (!Array.isArray(chunks))
            chunks = [chunks];
        const chunkDescriptors = [];
        const cipherHandler = await cipherHandlers[manifestOptions.cipher]?.upload?.(this, manifestOptions);
        if (!cipherHandler)
            throw new Error('Unsupported cipher');
        const cipherParams = cipherHandler.cipherParams;
        const transferParts = await Promise.all(chunks.map(async (chunk, i) => {
            const stream = chunk.stream();
            const encryptedStream = await cipherHandler.streamHandler(stream);
            const [body, s] = encryptedStream.tee();
            chunkDescriptors.push(computeChunkDescriptors(s));
            return {
                headers: new Headers([
                    ['content-disposition', `form-data; name="${i}"; filename="${i}"`],
                    ['content-type', 'application/octet-stream']
                ]),
                body
            };
        }));
        transferParts.push({
            headers: new Headers([
                ['content-disposition', 'form-data; name="manifest"; filename="manifest.json"'],
                ['content-type', 'application/vnd.shelter.filemanifest']
            ]),
            body: new ReadableStream({
                async start(controller) {
                    const chunks = await Promise.all(chunkDescriptors);
                    const manifest = {
                        version: '1.0.0',
                        // ?? undefined coerces null and undefined to undefined
                        // This ensures that null or undefined values don't make it to the
                        // JSON (otherwise, null values _would_ be stringified as 'null')
                        type: manifestOptions.type ?? undefined,
                        meta: manifestOptions.meta ?? undefined,
                        cipher: manifestOptions.cipher,
                        'cipher-params': cipherParams,
                        size: chunks.reduce((acc, [cv]) => acc + cv, 0),
                        chunks,
                        'name-map': manifestOptions['name-map'] ?? undefined,
                        alternatives: manifestOptions.alternatives ?? undefined
                    };
                    controller.enqueue(buffer_1.Buffer.from(JSON.stringify(manifest)));
                    controller.close();
                }
            })
        });
        // TODO: Using `self.crypto.randomUUID` breaks the tests. Maybe upgrading
        // Cypress would fix this.
        const boundary = typeof self.crypto?.randomUUID === 'function'
            ? self.crypto.randomUUID()
            // If randomUUID not available, we instead compute a random boundary
            // The indirect call to Math.random (`(0, Math.random)`) is to explicitly
            // mark that we intend on using Math.random, even though it's not a
            // CSPRNG, so that it's not reported as a bug in by static analysis tools.
            : new Array(36).fill('').map(() => 'abcdefghijklmnopqrstuvwxyz'[(0, Math.random)() * 26 | 0]).join('');
        const stream = (0, encodeMultipartMessage_1.default)(boundary, transferParts);
        const deletionToken = 'deletionToken' + (0, crypto_1.generateSalt)();
        const deletionTokenHash = (0, functions_js_1.blake32Hash)(deletionToken);
        const uploadResponse = await this.config.fetch(`${this.config.connectionURL}/file`, {
            method: 'POST',
            signal: this.abortController.signal,
            body: await ArrayBufferToUint8ArrayStream.call(this, this.config.connectionURL, stream),
            headers: new Headers([
                ...(billableContractID ? [['authorization', utils_js_1.buildShelterAuthorizationHeader.call(this, billableContractID)]] : []),
                ['content-type', `multipart/form-data; boundary=${boundary}`],
                ['shelter-deletion-token-digest', deletionTokenHash]
            ]),
            duplex: 'half'
        });
        if (!uploadResponse.ok)
            throw new Error('Error uploading file');
        return {
            download: {
                manifestCid: await uploadResponse.text(),
                downloadParams: cipherHandler.downloadParams
            },
            delete: deletionToken
        };
    },
    'chelonia/fileDownload': async function (downloadOptions, manifestChecker) {
        // Using a function to prevent accidental logging
        const { manifestCid, downloadParams } = downloadOptions.valueOf();
        const manifestResponse = await this.config.fetch(`${this.config.connectionURL}/file/${manifestCid}`, {
            method: 'GET',
            signal: this.abortController.signal
        });
        if (!manifestResponse.ok) {
            throw new Error('Unable to retrieve manifest');
        }
        const manifestBinary = await manifestResponse.arrayBuffer();
        if ((0, functions_js_1.createCID)((0, bytes_1.coerce)(manifestBinary), functions_js_1.multicodes.SHELTER_FILE_MANIFEST) !== manifestCid)
            throw new Error('mismatched manifest hash');
        const manifest = JSON.parse(buffer_1.Buffer.from(manifestBinary).toString());
        if (typeof manifest !== 'object')
            throw new Error('manifest format is invalid');
        if (manifest.version !== '1.0.0')
            throw new Error('unsupported manifest version');
        if (!Array.isArray(manifest.chunks))
            throw new Error('missing required field: chunks');
        if (manifestChecker) {
            const proceed = await manifestChecker?.(manifest);
            if (!proceed)
                return false;
        }
        const cipherHandler = await cipherHandlers[manifest.cipher]?.download?.(this, downloadParams, manifest);
        if (!cipherHandler)
            throw new Error('Unsupported cipher');
        return cipherHandler.payloadHandler();
    },
    'chelonia/fileDelete': async function (manifestCid, credentials = {}) {
        if (!manifestCid) {
            throw new TypeError('A manifest CID must be provided');
        }
        if (!Array.isArray(manifestCid))
            manifestCid = [manifestCid];
        return await Promise.allSettled(manifestCid.map(async (cid) => {
            const hasCredential = (0, turtledash_1.has)(credentials, cid);
            const hasToken = (0, turtledash_1.has)(credentials[cid], 'token') && credentials[cid].token;
            const hasBillableContractID = (0, turtledash_1.has)(credentials[cid], 'billableContractID') && credentials[cid].billableContractID;
            if (!hasCredential || hasToken === hasBillableContractID) {
                throw new TypeError(`Either a token or a billable contract ID must be provided for ${cid}`);
            }
            const response = await this.config.fetch(`${this.config.connectionURL}/deleteFile/${cid}`, {
                method: 'POST',
                signal: this.abortController.signal,
                headers: new Headers([
                    ['authorization',
                        hasToken
                            ? `bearer ${credentials[cid].token.valueOf()}`
                            : utils_js_1.buildShelterAuthorizationHeader.call(this, credentials[cid].billableContractID)]
                ])
            });
            if (!response.ok) {
                throw new Error(`Unable to delete file ${cid}`);
            }
        }));
    }
});
