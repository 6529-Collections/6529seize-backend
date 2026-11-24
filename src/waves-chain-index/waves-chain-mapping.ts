import { DbQueryOptions } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';

/**
 * Which of 6529.io's waves the 6529 chain holds, read from the chain index's
 * tables (src/waves-chain-index; entities/IWavesChainIndex.ts).
 *
 * After switch-on a wave has moved to the chain when the chain holds it:
 * chain_waves names it by its legacy id (a wave the import carried keeps
 * 6529.io's id) or by its chain id (a wave made on the chain keeps its chain
 * id on 6529.io). Every other wave stays on 6529.io, served from MySQL,
 * whatever else would say it moves: a wave the import didn't carry stays.
 *
 * The mapping counts only once the index has finished a full read of the
 * chain (waves_chain_index_state.last_full_at): before that, chain_waves may
 * lack waves the chain holds, so the mapping tells nothing yet. Before the
 * index's schema is deployed its tables don't exist, which reads the same.
 *
 * Self-contained (the chain index's module is not imported), so code that
 * runs where the index's module isn't can ask it.
 */

/** The chain index's state table and its row (WavesChainIndexStateEntity). */
export const CHAIN_INDEX_STATE_TABLE_NAME = 'waves_chain_index_state';
export const CHAIN_INDEX_STATE_ROW = 'waves';
/** The chain index's waves (ChainWaveEntity): wave_id, legacy_id. */
export const CHAIN_WAVES_TABLE_NAME = 'chain_waves';

type Reader = Pick<SqlExecutor, 'execute'>;

/** A MySQL "table doesn't exist" error, as the driver reports it. */
export function isMissingTableError(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  } | null;
  return (
    e?.code === 'ER_NO_SUCH_TABLE' ||
    e?.errno === 1146 ||
    e?.driverError?.code === 'ER_NO_SUCH_TABLE' ||
    e?.driverError?.errno === 1146
  );
}

/**
 * Whether the chain index has finished a full read, so its mapping is the
 * test of which waves moved. False before, and while its tables are not
 * there.
 */
export async function chainIndexReady(
  db: Reader,
  options?: DbQueryOptions
): Promise<boolean> {
  try {
    const rows = await db.execute<{ last_full_at: number | string | null }>(
      `select last_full_at from ${CHAIN_INDEX_STATE_TABLE_NAME}
        where name = :name`,
      { name: CHAIN_INDEX_STATE_ROW },
      options
    );
    const at = rows[0]?.last_full_at;
    return at !== null && at !== undefined;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

/**
 * The SQL condition "the chain holds the wave whose 6529.io id is `idSql`"
 * (a column or a parameter). Use it only once chainIndexReady says so.
 */
export function waveOnChainSql(idSql: string): string {
  return `(exists (select 1 from ${CHAIN_WAVES_TABLE_NAME} cwm_legacy where cwm_legacy.legacy_id = ${idSql}) or exists (select 1 from ${CHAIN_WAVES_TABLE_NAME} cwm_chain where cwm_chain.wave_id = ${idSql}))`;
}

/**
 * Of these 6529.io wave ids, the ones the chain holds, in lowercase. Ask
 * only once chainIndexReady says so: before, a wave the chain holds may be
 * missing.
 */
export async function wavesOnChain(
  db: Reader,
  waveIds: readonly string[],
  options?: DbQueryOptions
): Promise<Set<string>> {
  const ids = Array.from(
    new Set(waveIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
  );
  if (!ids.length) return new Set();
  const rows = await db.execute<{
    wave_id: string;
    legacy_id: string | null;
  }>(
    `select wave_id, legacy_id from ${CHAIN_WAVES_TABLE_NAME}
      where legacy_id in (:ids) or wave_id in (:ids)`,
    { ids },
    options
  );
  const wanted = new Set(ids);
  const held = new Set<string>();
  for (const row of rows) {
    for (const id of [row.wave_id, row.legacy_id]) {
      const key = id?.toLowerCase();
      if (key && wanted.has(key)) held.add(key);
    }
  }
  return held;
}
