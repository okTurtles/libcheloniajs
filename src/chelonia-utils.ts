import sbp from '@sbp/sbp'
import { ChelErrorKvConflict } from './errors.js'
import type { ChelKvOnConflictCallback, JSONType, KvHeightAheadMode } from './types.js'

// This file contains non-core parts of Chelonia, i.e., functionality that is
// useful but optional. The threshold for something being 'optional' generally
// is something that can be implemented externally using only public Chelonia
// selectors. (An exception: `queuedSet` uses the private
// `chelonia/kv/_withHeightRecovery`, the height recovery that `kv/update`
// and `kv/clear` also use.)
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
  // Raw `chelonia/kv/set` never syncs the contract, though: its callers
  // handle `isKvHeightAhead(e)` themselves (sync the contract with
  // `chelonia/contract/sync`, outside the queue, then retry).
  //
  // When the server value is ahead of the local contract
  // (`ChelErrorKvHeightAhead`), the contract is synced outside the queue and
  // the write is retried (`onHeightAhead: 'sync'`, the default), up to
  // `maxHeightRecoveries` times. Pass `onHeightAhead: 'reject'` to get the
  // error instead. See KV-REVAMPED.md §4.2 step 5a. `allowUnverifiedConflict`
  // is passed on to `chelonia/kv/set`.
  //
  // Running out of `maxAttempts` resolving `412` conflicts rejects with
  // `ChelErrorKvConflict` (`.cause` is `{ currentData, etag }`), like
  // `chelonia/kv/update` and `chelonia/kv/clear`; match it with
  // `isKvConflict(e)`.
  'chelonia/kv/queuedSet': ({
    contractID,
    key,
    data,
    onconflict,
    allowUnverifiedConflict,
    ifMatch,
    maxAttempts,
    signal,
    onHeightAhead,
    maxHeightRecoveries,
    encryptionKeyName = 'cek',
    signingKeyName = 'csk'
  }: {
    contractID: string;
    key: string;
    data: JSONType;
    onconflict?: ChelKvOnConflictCallback;
    allowUnverifiedConflict?: boolean;
    ifMatch?: string;
    maxAttempts?: number;
    signal?: AbortSignal;
    onHeightAhead?: KvHeightAheadMode;
    maxHeightRecoveries?: number;
    encryptionKeyName: string;
    signingKeyName: string;
  }): Promise<{ etag: string | null }> => {
    return sbp('chelonia/kv/_withHeightRecovery', contractID, () => {
      return sbp('chelonia/queueInvocation', contractID, () => {
        return sbp('chelonia/kv/set', contractID, key, data, {
          ifMatch,
          encryptionKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, encryptionKeyName),
          signingKeyId: sbp('chelonia/contract/currentKeyIdByName', contractID, signingKeyName),
          onconflict,
          allowUnverifiedConflict,
          maxAttempts,
          signal
        })
      })
    }, { onHeightAhead, maxHeightRecoveries, signal }, `queuedSet: ${contractID}::${key}`)
      .catch((e: unknown) => {
        // `kv/set`'s internal error for running out of attempts (only
        // `ChelErrorKvHeightAhead` is retried above, so this is outside the
        // recovery loop). The cause keeps its `{ currentData, etag }` shape.
        if ((e as Error | undefined)?.name === 'ChelErrorKvMaxAttempts') {
          throw new ChelErrorKvConflict(
            `[chelonia/kv] queuedSet: ${contractID}::${key} ran out of attempts ` +
            'resolving conflicts',
            { cause: (e as Error).cause }
          )
        }
        throw e
      })
  }
}) as string[]
