import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { DROPS_TABLE } from '@/constants';
import { applyOnlineIndex } from './online-index-schema';

/** Add only this index; refuse a blocking DDL algorithm or incompatible state. */
export async function applyWaveScoreInputIndexSchema(
  source: DataSource = getDataSource()
): Promise<number> {
  return applyOnlineIndex(
    {
      table: DROPS_TABLE,
      index: 'idx_drop_wave_author_created',
      columns: ['wave_id', 'author_id', 'created_at'],
      label: 'Wave score input index'
    },
    source
  );
}
