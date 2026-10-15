"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sbp_1 = __importDefault(require("@sbp/sbp"));
const errors_js_1 = require("./errors.cjs");
const internal_errors_js_1 = require("./internal-errors.cjs");
const kv_height_js_1 = require("./kv-height.cjs");
// This file contains non-core parts of Chelonia, i.e., functionality that is
// useful but optional. The threshold for something being 'optional' generally
// is something that can be implemented externally using only public Chelonia
// selectors (here plus the library's error predicates and internal helpers:
// `queueAbortable`, and the `maxAttempts` check).
// Optional functionality can make certain assumptions about contracts or
// actions to make things simpler or easier to implement.
// Currently, a single selector is defined: 'chelonia/kv/queuedSet'.
// TODO: Other things should be moved to this file, such as `encryptedAction`
// (the wrapper) and 'gi.actions/out/rotateKeys'.
exports.default = (0, sbp_1.default)('sbp/selectors/register', {
    // This selector is a wrapper for the `chelonia/kv/set` selector that uses
    // the contract queue and allows referring to keys by name, with default key
    // names set to `csk` and `cek` for signatures and encryption, respectively.
    // For most 'simple' use cases, this selector is a better choice than
    // `chelonia/kv/set`. However, the `chelonia/kv/set` primitive is needed if
    // the queueing logic needs to be more advanced, the key to use requires
    // custom logic or _if the `onconflict` callback also needs to be queued_.
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
    // waiting or syncing: nothing retries the write then (a deferred reload
    // only refreshes a slot's mirror, and only for a value that is ahead, not
    // after a stale-stamp `409`), so use it only when the caller re-issues the
    // write itself.
    // Pass `maxHeightRecoveries: 0` to wait passively without syncing. See
    // KV-REVAMPED.md §4.2 step 5a. A write that recovers is enqueued again,
    // so a later write to the same key can commit before it (as with an
    // app-level retry). `signal` ends the write at once while it is queued
    // (it then sends nothing). Awaited from the contract's own lanes (one of
    // its `sideEffect`s, a raw pubsub handler or a `queueInvocation` body for
    // it, an `onUpdate` of one of its slots), it never settles; a synchronous
    // call from such an `onUpdate` rejects with `ChelErrorKvReentrant` (see
    // docs/kv.md, "How height recovery runs").
    // `allowUnverifiedConflict` is passed on to `chelonia/kv/set`.
    //
    // Running out of `maxAttempts` resolving `412` conflicts, or a `412`
    // without `onconflict`, rejects with `ChelErrorKvConflict`, like
    // `chelonia/kv/update` and `chelonia/kv/clear`; match it with
    // `isKvConflict(e)`. Its `.cause` is `kv/set`'s: `{ currentStatus,
    // currentData, etag }` from the last server response, with `currentData`
    // only when that value is known (`'present'` and decodable, or
    // `'absent'`), and `currentStatus` only when the last response could be
    // read and decoded. The exception is a conflict whose last value is ahead of
    // the local contract (with an `onconflict`, and without
    // `allowUnverifiedConflict`): `kv/set` rejects with
    // `ChelErrorKvHeightAhead`, which is recovered from as above (and is the
    // rejection once the recoveries run out). A blind write
    // (`allowUnverifiedConflict`) doesn't depend on the value, so that is a
    // conflict too.
    'chelonia/kv/queuedSet': ({ contractID, key, data, onconflict, allowUnverifiedConflict, ifMatch, maxAttempts, signal, onHeightAhead, maxHeightRecoveries, encryptionKeyName = 'cek', signingKeyName = 'csk' }) => {
        const label = `queuedSet: ${contractID}::${key}`;
        if (!(0, kv_height_js_1.isValidMaxAttempts)(maxAttempts)) {
            return Promise.reject(new errors_js_1.ChelErrorKvUpdateInvalid(`[chelonia/kv] ${label}: \`maxAttempts\` must be an integer >= 1`));
        }
        return (0, sbp_1.default)('chelonia/kv/withHeightRecovery', contractID, ({ heightWaitMs }) => {
            // `signal` also ends the wait while the write is still queued.
            return (0, kv_height_js_1.queueAbortable)(contractID, [signal], () => {
                return (0, sbp_1.default)('chelonia/kv/set', contractID, key, data, {
                    ifMatch,
                    encryptionKeyId: (0, sbp_1.default)('chelonia/contract/currentKeyIdByName', contractID, encryptionKeyName),
                    signingKeyId: (0, sbp_1.default)('chelonia/contract/currentKeyIdByName', contractID, signingKeyName),
                    onconflict,
                    allowUnverifiedConflict,
                    maxAttempts,
                    heightWaitMs,
                    signal
                });
            }).result;
        }, {
            onHeightAhead, maxHeightRecoveries, signal, label
        })
            .catch((e) => {
            // `kv/set`'s internal error for running out of attempts, or for a
            // `412` without `onconflict` (only `ChelErrorKvHeightAhead` is
            // retried above, so this is outside the recovery loop). The cause
            // keeps `kv/set`'s shape: there is no slot to normalize it against.
            if ((0, internal_errors_js_1.isKvMaxAttempts)(e)) {
                throw new errors_js_1.ChelErrorKvConflict(`[chelonia/kv] queuedSet: ${contractID}::${key} ` + (typeof onconflict === 'function'
                    ? 'ran out of attempts resolving conflicts'
                    : 'conflicts with the server value, and no onconflict handler was provided'), { cause: e.cause });
            }
            throw e;
        });
    }
});
