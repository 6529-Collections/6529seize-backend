import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  LATEST_TDH_HISTORY_TABLE,
  RECENT_TDH_HISTORY_TABLE,
  TDH_BLOCKS_TABLE,
  TDH_CHAIN_DAYS_TABLE,
  TDH_HISTORY_TABLE,
  TDH_NFT_TABLE,
  UPLOADS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { NEXTGEN_TOKENS_TDH_TABLE } from '@/nextgen/nextgen_constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { CompareVerdict } from './chain-day-compare';
import { compareText } from './p28';
import { TdhChainDay } from './tdh-chain.types';

export type TdhChainDayMode = 'SHADOW' | 'CHAIN';

/**
 * - FAILED: the day failed a check; nothing was written.
 * - SKIPPED: a newer TDH day was already in the tables; nothing was written.
 * - WRITTEN: the TDH tables hold the day; follow-up steps are still due.
 * - INGESTED: done (in SHADOW, compared and recorded).
 */
export type TdhChainDayStatus = 'FAILED' | 'SKIPPED' | 'WRITTEN' | 'INGESTED';

/**
 * MATCH_WITHOUT_TOKENS: everything compared matched, but the chain side had
 * no token list, so per-card values were not compared.
 */
export type TdhChainVerdict = CompareVerdict;

/** The follow-up steps of a CHAIN write, in order. Each runs once. */
export const CHAIN_DAY_STEPS = [
  'nfts',
  'history',
  'metrics',
  'uploads',
  'dayFiles'
] as const;
export type ChainDayStep = (typeof CHAIN_DAY_STEPS)[number];

export interface TdhChainDayRow {
  readonly cycleDay: number;
  readonly mode: TdhChainDayMode;
  readonly status: TdhChainDayStatus;
  readonly verdict: TdhChainVerdict | null;
  readonly deferredKeys: readonly string[];
  readonly stepsDone: readonly ChainDayStep[];
  readonly boundary: number;
  readonly block: number;
}

export interface SaveTdhChainDay {
  readonly day: TdhChainDay;
  readonly mode: TdhChainDayMode;
  readonly status: TdhChainDayStatus;
  readonly verdict: TdhChainVerdict | null;
  readonly summary: unknown;
  readonly deferredKeys: readonly string[];
  readonly now: number;
}

/**
 * The tables a TDH write puts a consolidation key into. The narrowest of
 * them decides which keys fit (see `splitByKeyWidth`).
 */
export const TDH_KEY_TABLES = [
  CONSOLIDATED_WALLETS_TDH_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_NFT_TABLE,
  NEXTGEN_TOKENS_TDH_TABLE,
  TDH_HISTORY_TABLE,
  RECENT_TDH_HISTORY_TABLE,
  LATEST_TDH_HISTORY_TABLE
];

function jsonList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string' && value) return JSON.parse(value) as T[];
  return [];
}

interface DayRowRecord {
  cycle_day: number;
  mode: TdhChainDayMode;
  status: TdhChainDayStatus;
  verdict: TdhChainVerdict | null;
  deferred_keys: unknown;
  steps_done: unknown;
  boundary: number;
  block: number;
}

function toRow(r: DayRowRecord): TdhChainDayRow {
  return {
    cycleDay: Number(r.cycle_day),
    mode: r.mode,
    status: r.status,
    verdict: r.verdict ?? null,
    deferredKeys: jsonList<string>(r.deferred_keys),
    stepsDone: jsonList<ChainDayStep>(r.steps_done),
    boundary: Number(r.boundary),
    block: Number(r.block)
  };
}

const ROW_COLUMNS =
  'cycle_day, mode, status, verdict, deferred_keys, steps_done, boundary, block';

export class TdhChainDaysDb extends LazyDbAccessCompatibleService {
  /** The newest day of any status. */
  async latest(): Promise<TdhChainDayRow | null> {
    const rows = await this.db.execute<DayRowRecord>(
      `select ${ROW_COLUMNS} from ${TDH_CHAIN_DAYS_TABLE}
       order by cycle_day desc limit 1`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** The newest day the chain mode wrote into the TDH tables. */
  async latestWritten(): Promise<TdhChainDayRow | null> {
    const rows = await this.db.execute<DayRowRecord>(
      `select ${ROW_COLUMNS} from ${TDH_CHAIN_DAYS_TABLE}
       where mode = 'CHAIN' and status in ('WRITTEN', 'INGESTED')
       order by cycle_day desc limit 1`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * Records a day. With `connection`, inside the caller's transaction: the
   * CHAIN write records its day in the transaction that writes the tables.
   * A new record starts with no follow-up step done.
   */
  async save(
    s: SaveTdhChainDay,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const h = s.day.header;
    await this.db.execute(
      `insert into ${TDH_CHAIN_DAYS_TABLE} (
         cycle_day, mode, status, block, boundary, cutoff_hash,
         cutoff_timestamp, wallet_root, wallet_count, identity_count,
         total_tdh, token_root, token_count, apply_height, apply_time_ms,
         verdict, compare_summary, deferred_keys, steps_done, updated_at
       ) values (
         :cycleDay, :mode, :status, :block, :boundary, :cutoffHash,
         :cutoffTimestamp, :walletRoot, :walletCount, :identityCount,
         :totalTdh, :tokenRoot, :tokenCount, :applyHeight, :applyTimeMs,
         :verdict, :summary, :deferredKeys, '[]', :now
       ) on duplicate key update
         mode = values(mode), status = values(status), block = values(block),
         boundary = values(boundary), cutoff_hash = values(cutoff_hash),
         cutoff_timestamp = values(cutoff_timestamp),
         wallet_root = values(wallet_root), wallet_count = values(wallet_count),
         identity_count = values(identity_count), total_tdh = values(total_tdh),
         token_root = values(token_root), token_count = values(token_count),
         apply_height = values(apply_height),
         apply_time_ms = values(apply_time_ms), verdict = values(verdict),
         compare_summary = values(compare_summary),
         deferred_keys = values(deferred_keys), steps_done = '[]',
         updated_at = values(updated_at)`,
      {
        cycleDay: h.cycleDay,
        mode: s.mode,
        status: s.status,
        block: h.cutoffNumber,
        boundary: h.boundary,
        cutoffHash: h.cutoffHash,
        cutoffTimestamp: h.cutoffTimestamp,
        walletRoot: h.walletRoot,
        walletCount: h.walletCount,
        identityCount: h.identityCount,
        totalTdh: h.totalTdh,
        tokenRoot: h.tokenRoot,
        tokenCount: h.tokenCount,
        applyHeight: s.day.apply.applyHeight,
        applyTimeMs: s.day.apply.applyTimeMs,
        verdict: s.verdict,
        summary: JSON.stringify(s.summary),
        deferredKeys: JSON.stringify(s.deferredKeys),
        now: s.now
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  /**
   * Marks a follow-up step done; the day is INGESTED once every step is.
   * Returns the steps done so far.
   */
  async markStepDone(
    cycleDay: number,
    step: ChainDayStep,
    now: number
  ): Promise<ChainDayStep[]> {
    const rows = await this.db.execute<{ steps_done: unknown }>(
      `select steps_done from ${TDH_CHAIN_DAYS_TABLE} where cycle_day = :cycleDay`,
      { cycleDay },
      { forcePool: DbPoolName.WRITE }
    );
    const done = new Set(jsonList<ChainDayStep>(rows[0]?.steps_done));
    done.add(step);
    const steps = CHAIN_DAY_STEPS.filter((s) => done.has(s));
    const status =
      steps.length === CHAIN_DAY_STEPS.length ? 'INGESTED' : 'WRITTEN';
    await this.db.execute(
      `update ${TDH_CHAIN_DAYS_TABLE}
       set steps_done = :steps, status = :status, updated_at = :now
       where cycle_day = :cycleDay and status = 'WRITTEN'`,
      { cycleDay, steps: JSON.stringify(steps), status, now }
    );
    return steps;
  }

  /** Whether the day's files are already published. */
  async dayFilesPublished(cycleDay: number): Promise<boolean> {
    const rows = await this.db.execute<{ url: string | null }>(
      `select wallets_file_url as url from ${TDH_CHAIN_DAYS_TABLE}
       where cycle_day = :cycleDay`,
      { cycleDay },
      { forcePool: DbPoolName.WRITE }
    );
    return !!rows[0]?.url;
  }

  async saveDayFiles(
    cycleDay: number,
    files: {
      walletsUrl: string;
      walletsSha256: string;
      tokensUrl: string | null;
      tokensSha256: string | null;
    }
  ): Promise<void> {
    await this.db.execute(
      `update ${TDH_CHAIN_DAYS_TABLE}
       set wallets_file_url = :walletsUrl, wallets_file_sha256 = :walletsSha256,
           tokens_file_url = :tokensUrl, tokens_file_sha256 = :tokensSha256
       where cycle_day = :cycleDay`,
      { cycleDay, ...files }
    );
  }

  /** The narrowest `consolidation_key` column the TDH writes use. */
  async consolidationKeyWidth(): Promise<number> {
    const rows = await this.db.execute<{ width: number | null }>(
      `select min(character_maximum_length) as width
       from information_schema.columns
       where table_schema = database()
         and column_name = 'consolidation_key'
         and table_name in (:tables)`,
      { tables: TDH_KEY_TABLES },
      { forcePool: DbPoolName.WRITE }
    );
    const width = Number(rows[0]?.width ?? 0);
    if (!(width > 0)) {
      throw new Error('could not read the consolidation_key column width');
    }
    return width;
  }

  /** The highest block the TDH tables hold a day of, or 0. */
  async latestTdhBlock(): Promise<number> {
    const rows = await this.db.execute<{ block: number | null }>(
      `select max(block_number) as block from ${TDH_BLOCKS_TABLE}`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return Number(rows[0]?.block ?? 0);
  }

  /** Whether the day's upload (wallet or consolidated) is already listed. */
  async uploadExists(
    consolidated: boolean,
    date: string,
    block: number
  ): Promise<boolean> {
    const rows = await this.db.execute<{ n: number }>(
      `select count(*) as n from ${consolidated ? CONSOLIDATED_UPLOADS_TABLE : UPLOADS_TABLE}
       where date = :date and block = :block`,
      { date, block },
      { forcePool: DbPoolName.WRITE }
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }
}

export const tdhChainDaysDb = new TdhChainDaysDb(dbSupplier);

/**
 * Splits rows into those whose consolidation key fits the columns and the
 * keys that don't. A key that doesn't fit is left out of the whole write,
 * every table at once, and queued on the day's row: never a crash and never
 * half an identity written (coordinator's ruling on the key width, 22 Nov).
 */
export function splitByKeyWidth<T extends { consolidation_key: string }>(
  rows: readonly T[],
  width: number
): { fit: T[]; deferred: string[] } {
  const fit: T[] = [];
  const deferred = new Set<string>();
  for (const row of rows) {
    if (row.consolidation_key.length > width) {
      deferred.add(row.consolidation_key);
    } else {
      fit.push(row);
    }
  }
  return { fit, deferred: Array.from(deferred).sort(compareText) };
}
