import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';

/**
 * Whole tables dumped to S3 every day (plus the latest
 * `nftdelegation_blocks` row). Public chain data only: private
 * content (DMs, private waves, moderation evidence) must never be added here
 * (D146; db-dumps-daily-tables.test.ts enforces it).
 */
export const DB_DUMPS_DAILY_TABLES = [
  TRANSACTIONS_TABLE,
  DELEGATIONS_TABLE,
  CONSOLIDATIONS_TABLE
] as const;
