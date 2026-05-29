export declare const REINGEST_PER_CONTRACT_CAP = 20;
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
export declare const noteFutureEvent: (contractID: string, hash: string, height: number) => "added" | "duplicate";
/**
 * Drop a previously-recorded hash, signalling that the contract caught
 * up and the missed event was successfully processed. Returns `true`
 * if the hash was present (and is now removed), `false` otherwise.
 * Empty per-contract sets are pruned so `pendingReingestCount` reflects
 * reality and the map doesn't accumulate dead keys.
 */
export declare const noteReingestSuccess: (contractID: string, hash: string) => boolean;
/**
 * Remove entries whose recorded height is ≤ `processedHeight`. Called
 * from the in-order success branch in `checkMessageOrdering`: once the
 * contract has advanced past a recorded gap height, that entry is stale
 * regardless of whether the exact hash matched (the gap may have been
 * filled by a different message, e.g. a fork).
 *
 * Returns the number of entries pruned.
 */
export declare const pruneStaleEntries: (contractID: string, processedHeight: number) => number;
export declare const hasPendingReingest: (contractID: string, hash: string) => boolean;
export declare const pendingReingestCount: (contractID: string) => number;
/**
 * Drop all pending entries for a single contract. Called from
 * `chelonia/private/removeImmediately` (both resync and non-resync
 * paths — see module header).
 */
export declare const clearReingestTrackerForContract: (contractID: string) => void;
/**
 * Drop the entire tracker. Called from `chelonia/reset`.
 */
export declare const clearReingestTrackerAll: () => void;
