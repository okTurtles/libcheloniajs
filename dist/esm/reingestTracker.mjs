// Per-contract bookkeeping for re-ingest attempts on "future" events.
//
// When `checkMessageOrdering` sees an event whose height is strictly
// greater than `latestProcessedHeight + 1`, there is a gap in the
// per-contract log and the event cannot be applied yet. The handler
// records the hash here and schedules a forced re-sync to backfill the
// missing events. When the missed event is re-delivered after that
// re-sync, the hash is dropped from this tracker via
// `noteReingestSuccess`.
//
// Design notes (why this is per-contract):
//
//   * The previous implementation kept a single module-level
//     `string[]` shared across every contract, with a global cap of
//     100. That meant one chatty contract could exhaust the cap and
//     starve every other contract, and during a manual "Re-sync and
//     rebuild data" (which fans out a forced re-sync over *all* the
//     user's contracts in parallel) the cumulative churn routinely
//     blew through 100 entries — even though no individual contract
//     was in a pathological state. The cap exists to catch a single
//     contract stuck in a re-ingest loop; making it per-contract
//     restores that intent.
//
//   * The tracker must be explicitly cleared on two paths:
//       - `chelonia/reset`: tears chelonia down. Any pending hashes
//         belong to the old session and would otherwise survive into
//         a new session as module state.
//       - `chelonia/private/removeImmediately(cid, { resync: true })`:
//         wipes `state.contracts[cid].height` and replays the contract
//         from height 0. Any hashes recorded against the pre-resync
//         timeline are stale; leaving them in the tracker turns the
//         next live delivery of those hashes into
//         `ChelErrorDBBadPreviousHEAD('Already attempted to reingest
//         ...')` even though, post-resync, the chain is internally
//         consistent again. The non-resync path also clears, because
//         the contract is being torn down (release-to-zero / permanent
//         deletion) and the entries can never re-ingest there.
//
// This module exposes a small functional API and no SBP selectors —
// it is consumed directly by `internals.ts` (the producer/consumer of
// gap events) and `chelonia.ts` (the reset hook).
import { ChelErrorUnrecoverable } from './errors.mjs';
// Per-contract cap. Catches a single contract stuck in a re-ingest
// loop without blowing up under cross-contract parallelism. The
// previous global cap was 100; a per-contract value an order of
// magnitude smaller is appropriate now that the cap is no longer
// shared.
export const REINGEST_PER_CONTRACT_CAP = 20;
const trackers = new Map();
const ensure = (contractID) => {
    let s = trackers.get(contractID);
    if (!s) {
        s = new Set();
        trackers.set(contractID, s);
    }
    return s;
};
/**
 * Record that an event was observed "from the future" for this
 * contract.
 *
 * Returns `'duplicate'` if this hash was already recorded (the caller
 * should treat that as "we already tried to re-ingest this and it's
 * still showing up as a gap" and escalate to an error).
 *
 * Returns `'added'` if this is a new gap event. The caller is then
 * expected to schedule a forced re-sync.
 *
 * Throws `ChelErrorUnrecoverable` if the per-contract cap would be
 * exceeded. The cap is per-contract; reaching it indicates this
 * specific contract is wedged.
 */
export const noteFutureEvent = (contractID, hash) => {
    const s = ensure(contractID);
    if (s.has(hash))
        return 'duplicate';
    if (s.size >= REINGEST_PER_CONTRACT_CAP) {
        throw new ChelErrorUnrecoverable(`more than ${REINGEST_PER_CONTRACT_CAP} different bad previousHEAD errors for contract ${contractID}`);
    }
    s.add(hash);
    return 'added';
};
/**
 * Drop a previously-recorded hash, signalling that the contract caught
 * up and the missed event was successfully processed. Returns `true`
 * if the hash was present (and is now removed), `false` otherwise.
 * Empty per-contract sets are pruned so `pendingReingestCount` reflects
 * reality and the map doesn't accumulate dead keys.
 */
export const noteReingestSuccess = (contractID, hash) => {
    const s = trackers.get(contractID);
    if (!s)
        return false;
    const had = s.delete(hash);
    if (s.size === 0)
        trackers.delete(contractID);
    return had;
};
export const hasPendingReingest = (contractID, hash) => {
    return !!trackers.get(contractID)?.has(hash);
};
export const pendingReingestCount = (contractID) => {
    return trackers.get(contractID)?.size ?? 0;
};
/**
 * Drop all pending entries for a single contract. Called from
 * `chelonia/private/removeImmediately` (both resync and non-resync
 * paths — see module header).
 */
export const clearReingestTrackerForContract = (contractID) => {
    trackers.delete(contractID);
};
/**
 * Drop the entire tracker. Called from `chelonia/reset`.
 */
export const clearReingestTrackerAll = () => {
    trackers.clear();
};
