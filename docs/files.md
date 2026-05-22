# Encrypted files

`@chelonia/lib` ships a small file-storage layer that encrypts content
on the client, splits it into chunks, and uploads a signed manifest
plus the chunks to the relay. Downloads verify the manifest hash,
decrypt the chunks, and return a `Blob`.

All three selectors live in `src/files.ts` and are registered when
you `import '@chelonia/lib'`.

| Selector | Purpose |
|---|---|
| `chelonia/fileUpload` | Encrypt + upload one or more `Blob` chunks. |
| `chelonia/fileDownload` | Fetch + verify + decrypt a manifest by CID. |
| `chelonia/fileDelete` | Delete one or more manifests by CID. |

## Table of contents

1. [Cipher choices](#cipher-choices)
2. [Upload](#upload)
3. [Download](#download)
4. [Delete](#delete)
5. [Manifests on disk](#manifests-on-disk)
6. [Common pitfalls](#common-pitfalls)

---

## Cipher choices

The `cipher` field on the manifest selects how Chelonia encrypts
chunks before upload (`src/files.ts`):

| `cipher` | Behaviour |
|---|---|
| `'aes256gcm'` | AES-256-GCM with a random IKM. The IKM is returned in `downloadParams` and is required to decrypt; it is **not** persisted to the relay. |
| `'none'` | Plaintext upload. Use only for already-encrypted or public payloads. |

The `aes256gcm` handler chunks the stream at the configured record
size (default `rs = 64*1024`). Chunk hashes are recorded in the
manifest so download verifies integrity end-to-end.

---

## Upload

```js
import sbp from '@sbp/sbp'

const { download, delete: deletionToken } = await sbp('chelonia/fileUpload',
  [blob1, blob2],            // one Blob or an array of Blobs
  {
    cipher: 'aes256gcm',     // see "Cipher choices"
    type: 'image/png',       // optional; recorded on the manifest
    meta: { width: 64 },     // optional; opaque app-defined metadata
    'name-map': { '0': 'a.png', '1': 'b.png' },   // optional
    alternatives: {          // optional; alt encodings (e.g. thumbnails)
      thumb: { type: 'image/webp', size: 8192 }
    }
  },
  {
    // Optional. Required if the relay charges for uploads and you
    // want to attribute the cost to a specific contract.
    billableContractID: identityContractID
  }
)
```

### Return value

```
{
  download: {
    manifestCid: '<base58btc CID of the manifest>',
    downloadParams: { IKM: '...', rs: 65536 }   // shape depends on cipher
  },
  delete: '<deletion token string>'
}
```

- `download.manifestCid` is the canonical reference. Pass it (together
  with `downloadParams`) to `chelonia/fileDownload` to retrieve the
  payload.
- `download.downloadParams` for `aes256gcm` contains the decryption
  key material. **Treat it as a secret.** Wrap it in `Secret<...>`
  when persisting next to other state.
- `delete` is a deletion token: present it (or a `billableContractID`)
  to `chelonia/fileDelete` to remove the manifest and its chunks.
  Store it somewhere the user controls; without it the file is only
  removable by the billable contract.

### Streaming

Both `chunks` and the resulting upload are streamed: the chunks are
passed through `Blob.stream()` and re-encoded as `multipart/form-data`
via `encodeMultipartMessage`, so large files don't require holding the
full payload in memory in supported environments.

### Authorization

If `billableContractID` is set, Chelonia builds a `Shelter`
Authorization header via `buildShelterAuthorizationHeader` so the relay
can charge the upload to that contract. Otherwise the upload is
anonymous (and likely rate-limited or rejected by your relay's policy).

---

## Download

```js
const blobOrFalse = await sbp('chelonia/fileDownload',
  new Secret({ manifestCid, downloadParams }),
  // Optional. Lets you peek at the manifest *before* decryption and
  // bail out by returning `false`. Useful for size checks, MIME
  // sniffing, or warning users about unexpectedly large downloads.
  (manifest) => manifest.size < 50 * 1024 * 1024
)

if (blobOrFalse === false) {
  // Manifest checker rejected the download.
} else {
  // `blobOrFalse` is a Blob with the decrypted, reassembled payload.
  const blob = blobOrFalse
}
```

- The first argument is wrapped in `Secret<...>` because
  `downloadParams` carries the decryption key for `aes256gcm`.
- The manifest CID is verified against the bytes Chelonia received
  (`createCID(...) !== manifestCid` throws), so a tampered or wrong
  CID fails fast.
- The `manifestChecker` is optional. Return `false` to abort the
  download without touching the chunks; throw to surface a custom
  error.
- The return value is the decrypted, reassembled payload as a `Blob`.
  Chunk hashes are validated inside the cipher handler.

---

## Delete

```js
await sbp('chelonia/fileDelete', manifestCid, {
  [manifestCid]: {
    // Provide exactly one of these:
    token: deletionToken,            // from `fileUpload` result
    // billableContractID: identityContractID
  }
})

// Or bulk-delete:
await sbp('chelonia/fileDelete', [cidA, cidB], {
  [cidA]: { token: tokenA },
  [cidB]: { billableContractID: identityContractID }
})
```

Returns `Promise.allSettled` results so partial failures don't take
the whole batch down. Each entry requires **either** a `token` **or**
a `billableContractID`; passing both (or neither) throws a
`TypeError`.

---

## Manifests on disk

The on-relay manifest is JSON of shape `ChelFileManifest`
(`src/types.ts`):

```ts
{
  version: '1.0.0'
  type?: string             // MIME type, free-form
  meta?: unknown            // app-defined
  cipher: string            // 'aes256gcm' | 'none'
  'cipher-params'?: unknown // cipher-specific (e.g. record size)
  size: number              // total decrypted size in bytes
  chunks: [number, string][] // [byteLength, chunkCid][]
  'name-map'?: Record<string, string>
  alternatives?: Record<string, { type?: string; meta?: unknown; size: number }>
}
```

The manifest is content-addressed via
`createCID(coerce(manifestBinary), multicodes.SHELTER_FILE_MANIFEST)`,
so `manifestCid` doubles as an integrity check.

---

## Common pitfalls

- **Losing `downloadParams`.** For `cipher: 'aes256gcm'`, losing the
  `IKM` makes the file unrecoverable. Persist it (encrypted, e.g. via
  Chelonia's KV store) at the same time as the `manifestCid`.
- **Confusing `manifestCid` with the chunk CIDs.** Only the manifest
  CID is returned. Chunks are referenced *from* the manifest.
- **Forgetting the deletion token.** Without it, deletion requires the
  `billableContractID` that paid for the upload. Anonymous uploads
  that lose the token are effectively permanent.
- **Manifest checker called too late.** `manifestChecker` runs after
  the manifest has been fetched and verified but **before** any chunk
  bytes are pulled. Use it for cheap go/no-go decisions; don't try to
  inspect chunks from it.
- **Mixing ciphers per chunk.** `cipher` applies to the whole manifest.
  If you need mixed encryption, upload separate manifests.
