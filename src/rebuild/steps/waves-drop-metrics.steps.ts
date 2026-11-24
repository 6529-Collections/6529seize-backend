import { WAVE_DROPPER_METRICS_TABLE, WAVE_METRICS_TABLE } from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { dbSupplier } from '@/sql-executor';

const logger = Logger.get('WAVES_REBUILD_DROP_METRICS');

/** wave_metrics' columns that come from drops: this step's. */
export const DROP_METRIC_COLUMNS = [
  'drops_count',
  'participatory_drops_count',
  'latest_drop_timestamp'
] as const;

/** How many waves one recount statement takes. */
const WAVES_PER_STATEMENT = 500;

/** Every wave that has a drop, in id order. */
async function wavesWithDrops(): Promise<string[]> {
  const rows = await dbSupplier().execute<{ wave_id: string }>(
    `select distinct wave_id from drops
      where wave_id is not null
      order by wave_id`
  );
  return rows.map((row) => String(row.wave_id));
}

/**
 * The drop metrics of every wave with drops, from the drops alone, as
 * 6529.io keeps them: a wave's row, and a row per wave and author, appear
 * with their first drop (drop inserts upsert them), and their counts and
 * latest drop are what 6529.io's own recount (resyncDropCountsForWaves)
 * makes them, from each drop's created_at rather than a clock. A wave
 * without drops gets no row here; its subscribers' and scores' owners
 * make those.
 */
export async function rebuildWavesDropMetrics(
  _ctx: RebuildContext
): Promise<void> {
  const waveIds = await wavesWithDrops();
  if (!waveIds.length) {
    logger.info(`[NO DROPS] no wave has drops`);
    return;
  }
  await dbSupplier().execute(
    `insert ignore into ${WAVE_METRICS_TABLE} (wave_id)
     select distinct wave_id from drops where wave_id is not null`
  );
  await dbSupplier().execute(
    `insert ignore into ${WAVE_DROPPER_METRICS_TABLE} (wave_id, dropper_id)
     select distinct wave_id, author_id from drops where wave_id is not null`
  );
  for (let at = 0; at < waveIds.length; at += WAVES_PER_STATEMENT) {
    await dropsDb.resyncDropCountsForWaves(
      waveIds.slice(at, at + WAVES_PER_STATEMENT),
      {}
    );
  }
  logger.info(`[DROP METRICS] ${waveIds.length} waves recounted from drops`);
}
