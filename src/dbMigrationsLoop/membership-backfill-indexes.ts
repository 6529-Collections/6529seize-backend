import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';

/** Retained index metadata for the retired staging backfill; no runtime consumer. */
export const MEMBERSHIP_BACKFILL_INDEXES = [
  {
    table: MEMBERSHIP_SOURCE_STATES_TABLE,
    name: 'idx_mss_scope_updated_target',
    columns: ['scope', 'updated_at_millis', 'target_id']
  },
  {
    table: MEMBERSHIP_SOURCE_STATES_TABLE,
    name: 'idx_mss_scope_active_target',
    columns: ['scope', 'active_jobs', 'target_id']
  },
  {
    table: MEMBERSHIP_REFRESH_TARGETS_TABLE,
    name: 'idx_mrt_scope_updated_target',
    columns: ['scope', 'updated_at_millis', 'target_id']
  }
] as const;
