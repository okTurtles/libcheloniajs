import { ChelFileManifest, CheloniaContext } from './types.cjs';
export declare const aes256gcmHandlers: {
    upload: (_chelonia: CheloniaContext, manifestOptions: ChelFileManifest) => {
        cipherParams: {
            keyId: string;
        };
        streamHandler: (stream: ReadableStream) => Promise<ReadableStream<ArrayBufferLike>>;
        downloadParams: {
            IKM: string;
            rs: number;
        };
    };
    download: (chelonia: CheloniaContext, downloadParams: {
        IKM?: string;
        rs?: number;
    }, manifest: ChelFileManifest) => {
        payloadHandler: () => Promise<Blob>;
    };
};
export declare const noneHandlers: {
    upload: () => {
        cipherParams: undefined;
        streamHandler: (stream: ReadableStream) => ReadableStream<any>;
        downloadParams: undefined;
    };
    download: (chelonia: CheloniaContext, _downloadParams: object, manifest: ChelFileManifest) => {
        payloadHandler: () => Promise<Blob>;
    };
};
declare const _default: string[];
export default _default;
