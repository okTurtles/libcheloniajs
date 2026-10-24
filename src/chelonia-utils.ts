import sbp from '@sbp/sbp'
import { ChelErrorKvConflict } from './errors.js'
import { isKvMaxAttempts } from './internal-errors.js'
import { assertMaxAttempts, assertNotReentrant, resolveKvKeyIds } from './kv-checks.js'
import { KV_DEFAULT_ENCRYPTION_KEY_NAME, KV_DEFAULT_SIGNING_KEY_NAME } from './kv-constants.js'
import { withHeightRecovery } from './kv-height.js'
import type {
  ChelKvOnConflictCallback, CheloniaContext, JSONType, KvHeightRecoveryOptions
} from './types.js'

// This file contains non-core parts of Chelonia, i.e., functionality that is
// useful but optional. The threshold for something being 'optional' generally
// is something that can be implemented externally using only public Chelonia
// selectors.
// Optional functionality can make certain assumptions about contracts or
// actions to make things simpler or easier to implement.
// Currently, a single selector is defined: 'chelonia/kv/queuedSet'.
// TODO: Other things should be moved to this file, such as `encryptedAction`
// (the wrapper) and 'gi.actions/out/rotateKeys'.

export default sbp('sbp/selectors/register', {
  // This selector is a wrapper for the `chelonia/kv/set` selector that uses
  // the contract queue and allows referring to keys by name, with default key
  // names set to `csk` and `cek` for signatures and encryption, respectively.
  // For most 'simple' use cases, this selector is a better choice than
  // `chelonia/kv/set`. However, the `chelonia/kv/set` primitive is needed if
  // the queueing logic needs to be more advanced, the key to use requires
  // custom logic or _if the `onconflict` callback also needs to be queued_.
  // Like `chelonia/kv/withHeightRecovery`, it syncs the contract and retries
  // when the contract is behind the value's height.
  'chelonia/kv/queuedSet': async function (this: CheloniaContext, {
    contractID,
    key,
    data,
    onconflict,
    ifMatch,
    maxAttempts,
    allowUnverifiedConflict,
    onHeightAhead,
    maxHeightRecoveries,
    signal,
    encryptionKeyName = KV_DEFAULT_ENCRYPTION_KEY_NAME,
    signingKeyName = KV_DEFAULT_SIGNING_KEY_NAME
  }: {
    contractID: string;
    key: string;
    data: JSONType;
    onconflict?: ChelKvOnConflictCallback;
    ifMatch?: string;
    maxAttempts?: number | null;
    allowUnverifiedConflict?: boolean;
    // `null` writes plaintext
    encryptionKeyName?: string | null;
    signingKeyName?: string;
  } & KvHeightRecoveryOptions): Promise<{ etag: string | null }> {
    const label = `queuedSet: ${contractID}::${key}`
    assertMaxAttempts(maxAttempts, label)
    assertNotReentrant(this, contractID, key, 'queuedSet')
    try {
      return await withHeightRecovery(this, contractID, ({ heightWaitMs, queue }) =>
        queue(async () => sbp('chelonia/kv/set', contractID, key, data, {
          ...resolveKvKeyIds(contractID, { encryptionKeyName, signingKeyName }, label),
          ifMatch,
          onconflict,
          allowUnverifiedConflict,
          maxAttempts,
          heightWaitMs,
          signal
        }) as Promise<{ etag: string | null }>),
      { onHeightAhead, maxHeightRecoveries, signal }, label)
    } catch (e) {
      if (!isKvMaxAttempts(e)) throw e
      throw new ChelErrorKvConflict(`[chelonia/kv] ${label} ` + (onconflict
        ? 'ran out of attempts resolving conflicts'
        : 'got a conflict, and no onconflict handler was provided'
      ), { cause: e.cause })
    }
  }
}) as string[]
