import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  LATEST_TDH_HISTORY_TABLE,
  RECENT_TDH_HISTORY_TABLE,
  TDH_CHAIN_DAYS_TABLE,
  TDH_HISTORY_TABLE,
  TDH_NFT_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { NEXTGEN_TOKENS_TDH_TABLE } from '@/nextgen/nextgen_constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { compareText } from './p28';
import { TdhChainDay } from './tdh-chain.types';

export type TdhChainDayMode = 'SHADOW' | 'CHAIN';
export type TdhChainDayStatus = 'INGESTED' | 'KEYS_DEFERRED' | 'FAILED';

export interface TdhChainDayRow {
  readonly cycleDay: number;
  readonly mode: TdhChainDayMode;
  readonly status: TdhChainDayStatus;
  readonly deferredKeys: readonly string[];
}

export interface SaveTdhChainDay {
  readonly day: TdhChainDay;
  readonly mode: TdhChainDayMode;
  readonly status: TdhChainDayStatus;
  readonly verdict: 'MATCH' | 'MISMATCH' | null;
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

export class TdhChainDaysDb extends LazyDbAccessCompatibleService {
  async latest(): Promise<TdhChainDayRow | null> {
    const rows = await this.db.execute<{
      cycle_day: number;
      mode: TdhChainDayMode;
      status: TdhChainDayStatus;
      deferred_keys: string | string[] | null;
    }>(
      `select cycle_day, mode, status, deferred_keys from ${TDH_CHAIN_DAYS_TABLE}
       order by cycle_day desc limit 1`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    const r = rows[0];
    if (!r) return null;
    const keys =
      typeof r.deferred_keys === 'string'
        ? JSON.parse(r.deferred_keys)
        : (r.deferred_keys ?? []);
    return {
      cycleDay: Number(r.cycle_day),
      mode: r.mode,
      status: r.status,
      deferredKeys: keys
    };
  }

  async save(s: SaveTdhChainDay): Promise<void> {
    const h = s.day.header;
    await this.db.execute(
      `insert into ${TDH_CHAIN_DAYS_TABLE} (
         cycle_day, mode, status, block, boundary, cutoff_hash,
         cutoff_timestamp, wallet_root, wallet_count, identity_count,
         total_tdh, token_root, token_count, apply_height, apply_time_ms,
         verdict, compare_summary, deferred_keys, updated_at
       ) values (
         :cycleDay, :mode, :status, :block, :boundary, :cutoffHash,
         :cutoffTimestamp, :walletRoot, :walletCount, :identityCount,
         :totalTdh, :tokenRoot, :tokenCount, :applyHeight, :applyTimeMs,
         :verdict, :summary, :deferredKeys, :now
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
         deferred_keys = values(deferred_keys), updated_at = values(updated_at)`,
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
      }
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
