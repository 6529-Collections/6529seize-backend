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

/**
 * Every (wave, author) that has a drop, or had one in a wave that still
 * exists: 6529.io makes a metrics row with a drop's insert and keeps it,
 * at zero, when the drop is deleted (deleted_drops keeps the deleted
 * drop's wave and author). A live drop proves its wave exists, whether or
 * not the rebuild has written the wave's row (a wave that stays on 6529.io
 * has none from the mirror). A deleted drop counts only when its wave
 * still has a live drop or a row: deleting a wave deletes its drops with
 * no record and its wave_metrics row, and leaves its authors' rows as they
 * were, which nothing can rebuild (the step's plan names them).
 */
const DROPPERS = `select wave_id, author_id from drops where wave_id is not null
  union select dd.wave_id, dd.author_id from deleted_drops dd
   where dd.wave_id in (select id from waves)
      or dd.wave_id in (select wave_id from drops)`;

/** Every wave with a drop, or with a deleted drop and a row, in id order. */
async function wavesWithDrops(): Promise<string[]> {
  const rows = await dbSupplier().execute<{ wave_id: string }>(
    `select distinct wave_id from (${DROPPERS}) droppers order by wave_id`
  );
  return rows.map((row) => String(row.wave_id));
}

/**
 * The drop metrics of every wave that has drops, or had them and exists,
 * from the drops alone, as 6529.io keeps them: a wave's row, and a row per
 * wave and author, appear with their first drop (drop inserts upsert them)
 * and stay when the drops are deleted, and their counts and latest drop are what
 * 6529.io's own recount (resyncDropCountsForWaves) makes them, from each
 * drop's created_at rather than a clock (zero when none is left). A wave
 * that never had a drop gets no row here; its subscribers' and scores'
 * owners make those.
 */
export async function rebuildWavesDropMetrics(
  _ctx: RebuildContext
): Promise<void> {
  const waveIds = await wavesWithDrops();
  if (!waveIds.length) {
    logger.info(`[NO DROPS] no wave has or had drops`);
    return;
  }
  await dbSupplier().execute(
    `insert ignore into ${WAVE_METRICS_TABLE} (wave_id)
     select distinct wave_id from (${DROPPERS}) droppers`
  );
  await dbSupplier().execute(
    `insert ignore into ${WAVE_DROPPER_METRICS_TABLE} (wave_id, dropper_id)
     select distinct wave_id, author_id from (${DROPPERS}) droppers`
  );
  for (let at = 0; at < waveIds.length; at += WAVES_PER_STATEMENT) {
    await dropsDb.resyncDropCountsForWaves(
      waveIds.slice(at, at + WAVES_PER_STATEMENT),
      {}
    );
  }
  logger.info(`[DROP METRICS] ${waveIds.length} waves recounted from drops`);
}
