import sbp from '@sbp/sbp'
import { ChelErrorKvConflict, ChelErrorUnexpected } from './errors.js'
import { isKvMaxAttempts } from './internal-errors.js'
import { assertValidMaxAttempts } from './kv-height.js'
import type {
  ChelKvOnConflictCallback, JSONType, KvHeightAheadMode, KvHeightRecoveryAttempt
} from './types.js'
import { resolveKvKeyIds } from './utils.js'

// This file contains non-core parts of Chelonia, i.e., functionality that is
// useful but optional. The threshold for something being 'optional' generally
// is something that can be implemented externally using only public Chelonia
// selectors (here plus the library's error predicates, the `maxAttempts`
// check and the key lookup that slot writes share).
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
  // As for slot writes, a missing named key (encryption or signing) rejects
  // with `ChelErrorKvUpdateInvalid` instead of writing plaintext or sending
  // the write unsigned; pass `encryptionKeyName: null` to store plaintext.
  // Raw `chelonia/kv/set` never syncs the contract, though: wrap such a call
  // in `chelonia/kv/withHeightRecovery`, as this selector does (see
  // docs/kv.md).
  //
  // When the server value is ahead of the local contract
  // (`ChelErrorKvHeightAhead`), the write waits (holding no lane) for a sync
  // of the contract, which runs on the contract's internal lane, and is
  // retried (`onHeightAhead: 'sync'`, the default), up to
  // `maxHeightRecoveries` times, without `kv/set`'s passive wait for the
  // height, except on the last attempt, where that wait is the write's only
  // chance. Pass `onHeightAhead: 'reject'` to get the error at once, without
  // waiting or syncing: nothing retries the write then, so use it only
  // when the caller re-issues the write itself.
  // Pass `maxHeightRecoveries: 0` to wait passively without syncing. See
  // KV-REVAMPED.md §4.2 step 5a. A write that recovers is enqueued again,
  // so a later write to the same key can commit before it (as with an
  // app-level retry). `signal` and `chelonia/reset` end the write at once
  // while it is queued (it then sends nothing), and a write whose queued
  // work never runs rejects (see `KvHeightRecoveryAttempt`'s `queue`).
  // Awaited from code that the contract's lanes await (one of its
  // `sideEffect`s, a `queueInvocation` body for it, an `onconflict`, an
  // `onUpdate` of one of its slots), it never settles; a synchronous
  // call from such an `onUpdate` rejects with `ChelErrorKvReentrant` (see
  // docs/kv.md, "How height recovery runs").
  // `allowUnverifiedConflict` is passed on to `chelonia/kv/set`.
  //
  // Running out of `maxAttempts` resolving `412` conflicts, or a `412`
  // without `onconflict`, rejects with `ChelErrorKvConflict`, like
  // `chelonia/kv/update` and `chelonia/kv/clear`; match it with
  // `isKvConflict(e)`. Its `.cause` is `kv/set`'s: `{ currentStatus,
  // currentData, requiredHeight, etag }` from the last server response.
  // `currentStatus` is there when that response could be read and, for a
  // `'present'` value, decoded (an `'ahead'` or `'malformed'` value isn't
  // decoded); `currentData` only when the value is known (`'present'` and
  // decodable, or `'absent'`); `requiredHeight` (the value's height stamp)
  // only when it is `'ahead'`. The exception is a conflict whose last value
  // is ahead of the local contract (with an `onconflict`, and without
  // `allowUnverifiedConflict`): `kv/set` rejects with
  // `ChelErrorKvHeightAhead`, which is recovered from as above (and is the
  // rejection once the recoveries run out). A blind write
  // (`allowUnverifiedConflict`) doesn't depend on the value, so that is a
  // conflict too. A server value whose height stamp is malformed rejects
  // with `ChelErrorKvHeightMalformed` (`isKvHeightMalformed(e)`), except
  // for a blind write, which may overwrite it.
  'chelonia/kv/queuedSet': async ({
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
    maxAttempts?: number | null;
    signal?: AbortSignal;
    onHeightAhead?: KvHeightAheadMode | null;
    maxHeightRecoveries?: number | null;
    encryptionKeyName?: string | null;
    signingKeyName?: string;
  }): Promise<{ etag: string | null }> => {
    const label = `queuedSet: ${contractID}::${key}`
    // Throws, so it rejects: this is an `async` function.
    assertValidMaxAttempts(label, maxAttempts)
    const recovering = sbp('chelonia/kv/withHeightRecovery', contractID, (
      { heightWaitMs, queue }: KvHeightRecoveryAttempt
    ) => {
      // `signal` (and `chelonia/reset`) also end the wait while the write is
      // still queued.
      return queue(() => {
        // Resolved here, on the lane, as slot writes do.
        const { encryptionKeyId, signingKeyId } = resolveKvKeyIds(
          contractID, key, { encryptionKeyName, signingKeyName }, 'queuedSet'
        )
        return sbp('chelonia/kv/set', contractID, key, data, {
          ifMatch,
          encryptionKeyId,
          signingKeyId,
          onconflict,
          allowUnverifiedConflict,
          maxAttempts,
          heightWaitMs,
          signal
        })
      })
    }, {
      onHeightAhead, maxHeightRecoveries, signal, label, operation: 'queuedSet'
    }) as Promise<{ etag: string | null }> | undefined
    if (recovering === undefined) {
      throw new ChelErrorUnexpected(`[chelonia/kv] ${label}: withHeightRecovery was vetoed`)
    }
    return recovering.catch((e: unknown) => {
      // `kv/set`'s internal error for running out of attempts, or for a
      // `412` without `onconflict` (only `ChelErrorKvHeightAhead` is
      // retried above, so this is outside the recovery loop). The cause
      // keeps `kv/set`'s shape: there is no slot to normalize it against.
      if (isKvMaxAttempts(e)) {
        throw new ChelErrorKvConflict(
          `[chelonia/kv] ${label} ` + (
            typeof onconflict === 'function'
              ? 'ran out of attempts resolving conflicts'
              : 'conflicts with the server value, and no onconflict handler was provided'
          ),
          { cause: e.cause }
        )
      }
      throw e
    })
  }
}) as string[]
