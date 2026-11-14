/**
 * User metadata the chat media backfill sets on the objects it rewrites:
 * restore only touches its own writes, and video conversion does not run
 * again for a rewritten video (its renditions were made from the same
 * frames and stay).
 */
export const BACKFILL_RUN_METADATA_KEY = 'metadata-backfill-run';
