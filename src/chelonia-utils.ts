import sbp from '@sbp/sbp'
import { ChelErrorKvConflict } from './errors.js'
import { isKvMaxAttempts } from './internal-errors.js'
import { kvSetHeightWaitMs } from './kv-height.js'
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
  // handle `isKvHeightAhead(e)` themselves (pass `heightWaitMs: 0`, sync the
  // contract with `chelonia/contract/sync`, outside the queue, then retry,
  // keeping the write's error if the sync fails; see docs/kv.md). Such a
  // loop doesn't share one sync among concurrent writes, isn't aborted by
  // `chelonia/reset`, and doesn't retry when its sync fails but the
  // contract reached the height anyway, as this selector does.
  //
  // When the server value is ahead of the local contract
  // (`ChelErrorKvHeightAhead`), the contract is synced outside the queue and
  // the write is retried (`onHeightAhead: 'sync'`, the default), up to
  // `maxHeightRecoveries` times, without `kv/set`'s passive wait for the
  // height. Pass `onHeightAhead: 'reject'` to get the error instead (after
  // that wait). See KV-REVAMPED.md §4.2 step 5a. `allowUnverifiedConflict`
  // is passed on to `chelonia/kv/set`.
  //
  // Running out of `maxAttempts` resolving `412` conflicts, or a `412`
  // without `onconflict`, rejects with `ChelErrorKvConflict`, like
  // `chelonia/kv/update` and `chelonia/kv/clear`; match it with
  // `isKvConflict(e)`. Its `.cause` is `kv/set`'s: `{ currentStatus,
  // currentData, etag }` from the last server response, with `currentData`
  // only when that value is known (`'present'` and decodable, or
  // `'absent'`). The exception is a conflict whose last value is ahead of
  // the local contract (with an `onconflict`): `kv/set` rejects with
  // `ChelErrorKvHeightAhead`, which is recovered from as above (and is the
  // rejection once the recoveries run out).
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
          // The recovery below syncs: no passive wait with the lane held.
          heightWaitMs: kvSetHeightWaitMs({ onHeightAhead, maxHeightRecoveries }),
          signal
        })
      })
    }, { onHeightAhead, maxHeightRecoveries, signal }, `queuedSet: ${contractID}::${key}`)
      .catch((e: unknown) => {
        // `kv/set`'s internal error for running out of attempts, or for a
        // `412` without `onconflict` (only `ChelErrorKvHeightAhead` is
        // retried above, so this is outside the recovery loop). The cause
        // keeps `kv/set`'s shape: there is no slot to normalize it against.
        if (isKvMaxAttempts(e)) {
          throw new ChelErrorKvConflict(
            `[chelonia/kv] queuedSet: ${contractID}::${key} ` + (
              typeof onconflict === 'function'
                ? 'ran out of attempts resolving conflicts'
                : 'conflicts with the server value, and no onconflict handler was provided'
            ),
            { cause: (e as Error).cause }
          )
        }
        throw e
      })
  }
}) as string[]
