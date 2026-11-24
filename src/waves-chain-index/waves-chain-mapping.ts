import { DbQueryOptions } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';

/**
 * Which of 6529.io's waves the 6529 chain holds, read from the chain index's
 * tables (src/waves-chain-index; entities/IWavesChainIndex.ts).
 *
 * After switch-on a wave has moved to the chain when the chain holds it:
 * chain_waves names it by its legacy id, on a row the import made (origin
 * `legacy`: a wave the import carried keeps 6529.io's id), or by its chain
 * id, on a row made on the chain (origin `native`: such a wave keeps its
 * chain id on 6529.io). Every other
 * wave stays on 6529.io, served from MySQL, whatever else would say it
 * moves: a wave the import didn't carry stays.
 *
 * The mapping counts only once the index has finished a full read of the
 * chain (waves_chain_index_state.last_full_at), on the chain's network when
 * one is named (WAVES_SETTLEMENT_NETWORK_ID): before that, chain_waves may
 * lack waves the chain holds, or hold another chain's. Before the index's
 * schema is deployed its tables don't exist, which reads the same.
 *
 * A wave the chain doesn't hold may still be one made on the chain since
 * the index last read it. chainIndexProgress gives the time the index has
 * read through, so a reader can tell "not yet" from "not on the chain".
 *
 * Self-contained (the chain index's module is not imported), so code that
 * runs where the index's code isn't can ask it.
 */

/** The chain index's state table and its row (WavesChainIndexStateEntity). */
export const CHAIN_INDEX_STATE_TABLE_NAME = 'waves_chain_index_state';
export const CHAIN_INDEX_STATE_ROW = 'waves';
/** The chain index's waves (ChainWaveEntity): wave_id, legacy_id, origin. */
export const CHAIN_WAVES_TABLE_NAME = 'chain_waves';
/** chain_waves.origin of a wave the import carried. */
export const IMPORTED_ORIGIN = 'legacy';
/** chain_waves.origin of a wave made on the chain. */
export const NATIVE_ORIGIN = 'native';
/** The chain's network id (0x and 64 hex digits), when set. */
export const CHAIN_NETWORK_ID_ENV = 'WAVES_SETTLEMENT_NETWORK_ID';
/**
 * How far before its last save the index may have read the chain: one run
 * (under a minute) and the chain's finality lag, with room to spare.
 */
export const READ_THROUGH_MARGIN_MS = 15 * 60_000;
/** Full-read phases before which a skipped feed may still lack a wave. */
const PHASES_BEFORE_WAVES_DONE = new Set(['groups', 'waves']);

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

/** The chain's network id from WAVES_SETTLEMENT_NETWORK_ID, or null. */
export function expectedChainNetwork(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return env[CHAIN_NETWORK_ID_ENV]?.trim().toLowerCase() || null;
}

export interface ChainIndexProgress {
  /**
   * The index has finished a full read, on the expected network when one
   * is given: its mapping is the test of which waves moved.
   */
  readonly ready: boolean;
  /**
   * A time (6529.io's clock, ms) by which every wave the chain had made is
   * in chain_waves: the index's last save while it was caught up with its
   * last read of the chain, without an error and past a full read's waves
   * phase, less READ_THROUGH_MARGIN_MS. Null when it isn't caught up.
   */
  readonly readThrough: number | null;
}

const NOT_READY: ChainIndexProgress = { ready: false, readThrough: null };

interface StateRow {
  readonly last_full_at: number | string | null;
  readonly network: string | null;
  readonly last_error: string | null;
  readonly feed_next: number | string | null;
  readonly read_height: number | string | null;
  readonly feed_part: number | string | null;
  readonly full_phase: string | null;
  readonly updated_at: number | string | null;
}

const present = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

/**
 * Where the chain index stands (ChainIndexProgress). Not ready while its
 * tables aren't there.
 */
export async function chainIndexProgress(
  db: Reader,
  options?: DbQueryOptions,
  expectedNetwork: string | null = null
): Promise<ChainIndexProgress> {
  let rows: StateRow[];
  try {
    rows = await db.execute<StateRow>(
      `select last_full_at, network, last_error, feed_next, read_height,
              feed_part, full_phase, updated_at
         from ${CHAIN_INDEX_STATE_TABLE_NAME}
        where name = :name`,
      { name: CHAIN_INDEX_STATE_ROW },
      options
    );
  } catch (error) {
    if (isMissingTableError(error)) return NOT_READY;
    throw error;
  }
  const row = rows[0];
  if (!row || !present(row.last_full_at)) return NOT_READY;
  const expected = expectedNetwork?.trim().toLowerCase() || null;
  if (
    expected !== null &&
    (row.network ?? '').trim().toLowerCase() !== expected
  ) {
    return NOT_READY;
  }
  const caughtUp =
    !present(row.last_error) &&
    present(row.feed_next) &&
    present(row.read_height) &&
    Number(row.feed_next) > Number(row.read_height) &&
    Number(row.feed_part ?? 0) === 0 &&
    !PHASES_BEFORE_WAVES_DONE.has(row.full_phase ?? '') &&
    present(row.updated_at);
  return {
    ready: true,
    readThrough: caughtUp
      ? Number(row.updated_at) - READ_THROUGH_MARGIN_MS
      : null
  };
}

/**
 * Whether the chain index has finished a full read (on the expected
 * network when one is given), so its mapping is the test of which waves
 * moved. False before, and while its tables are not there.
 */
export async function chainIndexReady(
  db: Reader,
  options?: DbQueryOptions,
  expectedNetwork: string | null = null
): Promise<boolean> {
  return (await chainIndexProgress(db, options, expectedNetwork)).ready;
}

/**
 * The SQL condition "the chain holds the wave whose 6529.io id is `idSql`"
 * (a column or a parameter). Use it only once chainIndexReady says so.
 */
export function waveOnChainSql(idSql: string): string {
  return `(exists (select 1 from ${CHAIN_WAVES_TABLE_NAME} cwm_legacy where cwm_legacy.legacy_id = ${idSql} and cwm_legacy.origin = '${IMPORTED_ORIGIN}') or exists (select 1 from ${CHAIN_WAVES_TABLE_NAME} cwm_chain where cwm_chain.wave_id = ${idSql} and cwm_chain.origin = '${NATIVE_ORIGIN}'))`;
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
    origin: string | null;
  }>(
    `select wave_id, legacy_id, origin from ${CHAIN_WAVES_TABLE_NAME}
      where (legacy_id in (:ids) and origin = '${IMPORTED_ORIGIN}')
         or (wave_id in (:ids) and origin = '${NATIVE_ORIGIN}')`,
    { ids },
    options
  );
  const wanted = new Set(ids);
  const held = new Set<string>();
  for (const row of rows) {
    const chainId = row.wave_id?.toLowerCase();
    if (chainId && row.origin === NATIVE_ORIGIN && wanted.has(chainId)) {
      held.add(chainId);
    }
    const legacyId = row.legacy_id?.toLowerCase();
    if (legacyId && row.origin === IMPORTED_ORIGIN && wanted.has(legacyId)) {
      held.add(legacyId);
    }
  }
  return held;
}
