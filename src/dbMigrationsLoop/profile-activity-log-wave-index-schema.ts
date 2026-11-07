import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { WAVE_LOG_INDEX } from '@/drops/wave-log-index';
import { applyOnlineIndex } from './online-index-schema';

/**
 * Adds the (wave, type, created_at) index whole-wave activity-log reads use.
 * It runs only in its own schema scope: the table is large, so the build is
 * scheduled and timed by an operator, never part of a routine migration run.
 */
export async function applyProfileActivityLogWaveIndexSchema(
  source: DataSource = getDataSource()
): Promise<number> {
  return applyOnlineIndex(
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      index: WAVE_LOG_INDEX,
      columns: ['additional_data_2', 'type', 'created_at'],
      label: 'Profile activity log wave index'
    },
    source
  );
}
