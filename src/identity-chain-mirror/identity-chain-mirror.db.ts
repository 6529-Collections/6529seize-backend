import { randomUUID } from 'node:crypto';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_FIRST_BINDINGS_TABLE,
  IDENTITY_CHAIN_FOUNDER_WAITS_TABLE,
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PLACEHOLDERS_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_CHAIN_RATING_EVENTS_TABLE,
  IDENTITY_CHAIN_RATING_LEDGER_TABLE,
  IDENTITY_CHAIN_REGROUPS_TABLE,
  IDENTITY_CHAIN_WALLETS_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE,
  USE_CASE_CONSOLIDATION
} from '@/constants';
import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import {
  CurrentIdentityState,
  IdentityPlan,
  IdentityRowState,
  ProfileRowState,
  WalletPair
} from './identity-plan';
import { ProfileDocStatement } from './profile-doc';
import { WalletBindingRow } from './wallet-bindings';
import { ledgerKeyOf, totalKeyOf } from './rating-events';
import type { DelegationRowWrite } from './delegation-rows';

export type { DelegationRowWrite };

type Conn = ConnectionWrapper<any>;

export interface MirrorState {
  readonly next_height: number | null;
  readonly sync_from_height: number | null;
  readonly sync_phase: string | null;
  readonly sync_after: string | null;
  readonly last_full_sync_at: number | null;
  /** The next feed height the wallet bindings read (exact before it). */
  readonly bindings_next_height: number | null;
  /** The network id of the chain the mirror read. */
  readonly chain_id: string | null;
  /** When the placeholder profiles were listed; null before. */
  readonly placeholders_at: number | null;
  /**
   * The bindings have followed the feed without a break from the import's
   * start: identity_chain_first_bindings is exact below their cursor.
   */
  readonly bindings_exact: boolean;
  /** The latest TDH day seen on the chain's levels; null before. */
  readonly levels_tdh_day: number | null;
  /** A level sweep under way: the TDH day it is for, null when none. */
  readonly level_sweep_day: number | null;
  /** The sweep's place in the chain's level ranking (null: from the top). */
  readonly level_sweep_after: string | null;
  /** The chain height the latest TDH day was first seen at. */
  readonly levels_day_height: number | null;
  /** The full sync's delegation phase: the next use case to walk. */
  readonly sync_use_case: number | null;
  /** Within that use case, the last wallet written. */
  readonly sync_wallet_after: string | null;
  /** The rows off the chain's level fix: the last key it got to. */
  readonly off_chain_after: string | null;
  /** The highest finalized height reads were pinned to. */
  readonly pin_floor: number | null;
  /** The next feed height the rating events follower reads. */
  readonly events_next_height: number | null;
  /** The rating ledger followed the feed from the import's start. */
  readonly events_exact: boolean;
  /** What the mirror could not write, tried again by the next run. */
  readonly retry: MirrorRetry;
}

/** A wallet's first-ever principal, as the bindings recorded it. */
export interface FirstBinding {
  readonly wallet: string;
  readonly principal_id: string;
  readonly height: number;
}

/**
 * Identities whose rows, targets whose ratings and wallets whose delegations
 * failed to be written, by key (lowercase).
 */
export interface MirrorRetry {
  readonly principals: readonly string[];
  readonly targets: readonly string[];
  readonly wallets: readonly string[];
}

export const NO_RETRY: MirrorRetry = {
  principals: [],
  targets: [],
  wallets: []
};

/** The retry column's lists; anything unreadable is an empty list. */
export function retryOf(json: string | null | undefined): MirrorRetry {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = json ? (JSON.parse(json) ?? {}) : {};
  } catch {
    parsed = {};
  }
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((it): it is string => typeof it === 'string')
      : [];
  return {
    principals: list(parsed.principals),
    targets: list(parsed.targets),
    wallets: list(parsed.wallets)
  };
}

/** A nullable number column. */
export function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function retryJson(retry: MirrorRetry | undefined): string | null {
  const { principals = [], targets = [], wallets = [] } = retry ?? NO_RETRY;
  return principals.length || targets.length || wallets.length
    ? JSON.stringify({ principals, targets, wallets })
    : null;
}

export interface RatingRowWrite {
  readonly rater_profile_id: string;
  readonly matter: 'REP' | 'CIC';
  readonly matter_category: string;
  readonly rating: number;
  /** The rater's principal id, when known. */
  readonly rater_principal?: string | null;
  /** The chain height the rating was last set at, when known. */
  readonly height?: number | null;
}

/** A rating ledger key: the Rating record's own key fields. */
export interface RatingLedgerKey {
  readonly rater: string;
  readonly matterCode: number;
  readonly targetKind: number;
  readonly target: string;
  readonly category: string;
}

/** A row of identity_chain_rating_events. */
export interface RatingEventRow {
  readonly height: number;
  readonly block_time_ms: number;
  readonly rater_principal: string;
  readonly rater_profile_id: string | null;
  readonly target_principal: string;
  readonly target_profile_id: string | null;
  readonly matter: 'REP' | 'CIC';
  readonly matter_category: string;
  readonly old_rating: number;
  readonly new_rating: number;
  readonly total_after: number;
  readonly origin: string;
  readonly by_import: boolean;
  readonly writer: string | null;
}

function ratingKey(it: {
  rater_profile_id: string;
  matter: string;
  matter_category: string;
}): string {
  return JSON.stringify([it.rater_profile_id, it.matter, it.matter_category]);
}

const STATE_ID = 'identity';
const IDENTITY_COLUMNS = [
  'consolidation_key',
  'profile_id',
  'primary_address',
  'handle',
  'normalised_handle',
  'tdh',
  'rep',
  'cic',
  'level_raw',
  'pfp',
  'banner1',
  'banner2',
  'classification',
  'sub_classification',
  'xtdh',
  'produced_xtdh',
  'granted_xtdh',
  'xtdh_rate',
  'basetdh_rate'
] as const;

/**
 * Columns other loops own: tdh and basetdh_rate (the TDH loop), the xTDH
 * columns (the xTDH loop). The mirror writes them only into a row it
 * creates (a new consolidation key), carrying the profile's previous values;
 * it never updates them in a row that exists.
 */
const METRIC_COLUMNS: ReadonlySet<string> = new Set([
  'tdh',
  'basetdh_rate',
  'xtdh',
  'produced_xtdh',
  'granted_xtdh',
  'xtdh_rate'
]);

function numberOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function statementKey(it: {
  statement_group: string;
  statement_type: string;
  statement_value: string;
  statement_comment: string | null;
}): string {
  return JSON.stringify([
    it.statement_group,
    it.statement_type,
    it.statement_value,
    it.statement_comment ?? null
  ]);
}

function delegationKey(it: DelegationRowWrite): string {
  return JSON.stringify([
    it.block,
    it.from_address,
    it.to_address,
    it.collection,
    it.use_case
  ]);
}

function sameDelegation(a: DelegationRowWrite, b: DelegationRowWrite) {
  return (
    Number(a.expiry) === Number(b.expiry) &&
    !!Number(a.all_tokens) === !!Number(b.all_tokens) &&
    Number(a.token_id) === Number(b.token_id)
  );
}

/** The identity mirror's reads and writes, each inside the caller's transaction. */
export class IdentityChainMirrorDb extends LazyDbAccessCompatibleService {
  // ---------------------------------------------------------------- state

  async getState(conn?: Conn): Promise<MirrorState | null> {
    const row = await this.db.oneOrNull<
      Omit<MirrorState, 'retry' | 'bindings_exact'> & {
        retry_json: string | null;
        bindings_exact: number | boolean | null;
      }
    >(
      `select next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at,
              bindings_next_height, chain_id, placeholders_at, bindings_exact,
              levels_tdh_day, level_sweep_day, level_sweep_after, levels_day_height,
              sync_use_case, sync_wallet_after, pin_floor, off_chain_after,
              events_next_height, events_exact, retry_json
       from ${IDENTITY_CHAIN_MIRROR_STATE_TABLE} where id = :id`,
      { id: STATE_ID },
      conn ? { wrappedConnection: conn } : undefined
    );
    if (!row) return null;
    return {
      next_height: numberOrNull(row.next_height),
      sync_from_height: numberOrNull(row.sync_from_height),
      sync_phase: row.sync_phase ?? null,
      sync_after: row.sync_after ?? null,
      last_full_sync_at: numberOrNull(row.last_full_sync_at),
      bindings_next_height: numberOrNull(row.bindings_next_height),
      chain_id: row.chain_id ?? null,
      placeholders_at: numberOrNull(row.placeholders_at),
      bindings_exact: !!Number(row.bindings_exact ?? 0),
      levels_tdh_day: numberOrNull(row.levels_tdh_day),
      level_sweep_day: numberOrNull(row.level_sweep_day),
      level_sweep_after: row.level_sweep_after ?? null,
      levels_day_height: numberOrNull(row.levels_day_height),
      sync_use_case: numberOrNull(row.sync_use_case),
      sync_wallet_after: row.sync_wallet_after ?? null,
      pin_floor: numberOrNull(row.pin_floor),
      off_chain_after: row.off_chain_after ?? null,
      events_next_height: numberOrNull(row.events_next_height),
      events_exact: !!Number(row.events_exact ?? 0),
      retry: retryOf(row.retry_json)
    };
  }

  async saveState(state: MirrorState, now: number, conn?: Conn) {
    await this.db.execute(
      `insert into ${IDENTITY_CHAIN_MIRROR_STATE_TABLE}
         (id, next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at,
          bindings_next_height, chain_id, placeholders_at, bindings_exact,
          levels_tdh_day, level_sweep_day, level_sweep_after, levels_day_height,
          sync_use_case, sync_wallet_after, pin_floor, off_chain_after,
          events_next_height, events_exact, retry_json, updated_at)
       values (:id, :next_height, :sync_from_height, :sync_phase, :sync_after, :last_full_sync_at,
          :bindings_next_height, :chain_id, :placeholders_at, :bindings_exact,
          :levels_tdh_day, :level_sweep_day, :level_sweep_after, :levels_day_height,
          :sync_use_case, :sync_wallet_after, :pin_floor, :off_chain_after,
          :events_next_height, :events_exact, :retry_json, :now)
       on duplicate key update
         events_next_height = values(events_next_height),
         events_exact = values(events_exact),
         off_chain_after = values(off_chain_after),
         next_height = values(next_height),
         sync_wallet_after = values(sync_wallet_after),
         pin_floor = values(pin_floor),
         levels_day_height = values(levels_day_height),
         sync_use_case = values(sync_use_case),
         levels_tdh_day = values(levels_tdh_day),
         level_sweep_day = values(level_sweep_day),
         level_sweep_after = values(level_sweep_after),
         bindings_next_height = values(bindings_next_height),
         bindings_exact = values(bindings_exact),
         chain_id = values(chain_id),
         placeholders_at = values(placeholders_at),
         retry_json = values(retry_json),
         sync_from_height = values(sync_from_height),
         sync_phase = values(sync_phase),
         sync_after = values(sync_after),
         last_full_sync_at = values(last_full_sync_at),
         updated_at = values(updated_at)`,
      {
        id: STATE_ID,
        ...state,
        bindings_exact: state.bindings_exact ? 1 : 0,
        events_exact: state.events_exact ? 1 : 0,
        retry_json: retryJson(state.retry),
        now
      },
      conn ? { wrappedConnection: conn } : undefined
    );
  }

  /**
   * The narrowest consolidation_key column the mirror writes (identities,
   * address_consolidation_keys): 200 characters (four wallets) before the
   * widening migration, 700 (sixteen) after it. Null when it can't be read.
   */
  async consolidationKeyWidth(conn?: Conn): Promise<number | null> {
    const row = await this.db.oneOrNull<{ width: number | string | null }>(
      `select min(character_maximum_length) as width
       from information_schema.columns
       where table_schema = database() and column_name = 'consolidation_key'
         and table_name in (:tables)`,
      { tables: [IDENTITIES_TABLE, ADDRESS_CONSOLIDATION_KEY] },
      conn ? { wrappedConnection: conn } : undefined
    );
    const width = Number(row?.width);
    return Number.isInteger(width) && width > 0 ? width : null;
  }

  // ---------------------------------------------------------------- mapping

  async profileIdOfPrincipal(
    principalId: string,
    conn?: Conn
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ profile_id: string }>(
      `select profile_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where principal_id = :principalId`,
      { principalId },
      conn ? { wrappedConnection: conn } : undefined
    );
    return row?.profile_id ?? null;
  }

  /**
   * The chain's levels of mapped identities as of chain height `height`,
   * as one statement: only level_raw of each profile's identities row
   * changes, and only where no later level was written (the mapping's
   * level_height, set to `height` with it). A profile without a row is left
   * alone.
   */
  async writeLevels(
    levels: { readonly profile_id: string; readonly level_raw: number }[],
    height: number
  ): Promise<void> {
    if (!levels.length) return;
    const params: Record<string, unknown> = {
      ids: levels.map((it) => it.profile_id),
      height
    };
    const cases = levels
      .map((it, i) => {
        params[`p${i}`] = it.profile_id;
        params[`l${i}`] = it.level_raw;
        return `when :p${i} then :l${i}`;
      })
      .join(' ');
    await this.db.execute(
      `update ${IDENTITIES_TABLE} i
       join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = i.profile_id
       set i.level_raw = case i.profile_id ${cases} else i.level_raw end,
           m.level_height = :height
       where i.profile_id in (:ids)
         and (m.level_height is null or m.level_height <= :height)`,
      params
    );
  }

  /**
   * Identities rows of profiles that are not chain identities (no mapping)
   * keep 6529.io's REP and CIC, without the help bot's credits, and a level
   * of REP + TDH: the REP of a credited profile (a small set, from the
   * ratings) becomes its REP ratings outside the credit category, then
   * level_raw becomes rep + tdh where it differs (no xTDH, no credits).
   * Bounded statements: profile ids 500 at a time, rows `chunk` keys at a
   * time. Idempotent. Returns the rows changed of each kind.
   */
  async fixRowsOffTheChain({
    chunk = 1_000,
    repToo = true,
    leaveOut = []
  }: {
    readonly chunk?: number;
    /** With false, only the levels (REP is already without credits). */
    readonly repToo?: boolean;
    /** Profile ids not taken for ones off the chain (identities waiting). */
    readonly leaveOut?: readonly string[];
  } = {}): Promise<{ rep: number; level: number }> {
    const helpBot = HELP_BOT_CREDIT_CATEGORY.toLowerCase();
    const left = new Set(leaveOut.map((it) => it.toLowerCase()));
    // `not in` needs one value at least.
    const skip = left.size ? Array.from(left) : [''];
    const credited = repToo
      ? (
          await this.db.execute<{ profile_id: string }>(
            `select distinct matter_target_id as profile_id from ${RATINGS_TABLE}
             where matter = 'REP' and lower(trim(matter_category)) = :helpBot`,
            { helpBot }
          )
        )
          .map((it) => it.profile_id)
          .filter((it) => !left.has(it.toLowerCase()))
      : [];
    let rep = 0;
    for (let i = 0; i < credited.length; i += 500) {
      const result = await this.db.execute(
        `update ${IDENTITIES_TABLE} i
         left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = i.profile_id
         join (
           select matter_target_id as profile_id,
                  sum(case when lower(trim(matter_category)) = :helpBot
                           then 0 else rating end) as rep
           from ${RATINGS_TABLE}
           where matter = 'REP' and matter_target_id in (:ids)
           group by matter_target_id
         ) r on r.profile_id = i.profile_id
         set i.rep = r.rep
         where m.principal_id is null and i.rep <> r.rep`,
        { helpBot, ids: credited.slice(i, i + 500) }
      );
      rep += this.db.getAffectedRows(result);
    }
    let level = 0;
    let after: string | null = '';
    while (after !== null) {
      const step = await this.fixLevelsOffTheChain({
        after,
        chunks: Number.POSITIVE_INFINITY,
        chunk,
        leaveOut: Array.from(left)
      });
      level += step.level;
      after = step.after;
    }
    return { rep, level };
  }

  /**
   * The level part of fixRowsOffTheChain from the key `after` (''
   * from the first), at most `chunks` chunks of `chunk` rows: level_raw
   * becomes rep + tdh for rows of profiles that are not chain identities
   * (a row without a profile included), but for the profile ids left out.
   * Returns the rows changed and the key to go on from (null: the end).
   */
  async fixLevelsOffTheChain({
    after,
    chunks,
    chunk = 1_000,
    leaveOut = []
  }: {
    readonly after: string;
    readonly chunks: number;
    readonly chunk?: number;
    readonly leaveOut?: readonly string[];
  }): Promise<{ level: number; after: string | null }> {
    // `not in` needs one value at least.
    const skip = leaveOut.length
      ? leaveOut.map((it) => it.toLowerCase())
      : [''];
    let level = 0;
    let from = after;
    for (let i = 0; i < chunks; i++) {
      const bound = await this.db.oneOrNull<{ consolidation_key: string }>(
        `select consolidation_key from ${IDENTITIES_TABLE}
         where consolidation_key > :from
         order by consolidation_key limit 1 offset :last`,
        { from, last: chunk - 1 }
      );
      const result = await this.db.execute(
        `update ${IDENTITIES_TABLE} i
         left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = i.profile_id
         set i.level_raw = i.rep + i.tdh
         where m.principal_id is null
           and i.consolidation_key > :from
           ${bound ? 'and i.consolidation_key <= :upTo' : ''}
           and (i.profile_id is null or i.profile_id not in (:skip))
           and i.level_raw <> i.rep + i.tdh`,
        { from, upTo: bound?.consolidation_key, skip }
      );
      level += this.db.getAffectedRows(result);
      if (!bound) return { level, after: null };
      from = bound.consolidation_key;
    }
    return { level, after: from };
  }

  /** The chain height of an identity's last level write, when known. */
  async levelHeightOf(
    principalId: string,
    conn?: Conn
  ): Promise<number | null> {
    const row = await this.db.oneOrNull<{
      level_height: number | string | null;
    }>(
      `select level_height from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where principal_id = :principalId`,
      { principalId: principalId.toLowerCase() },
      conn ? { wrappedConnection: conn } : undefined
    );
    return numberOrNull(row?.level_height);
  }

  /** An identity's level was written as of `height` (never moved back). */
  async setLevelHeight(principalId: string, height: number, conn: Conn) {
    await this.db.execute(
      `update ${IDENTITY_CHAIN_PRINCIPALS_TABLE} set level_height = :height
       where principal_id = :principalId
         and (level_height is null or level_height < :height)`,
      { principalId: principalId.toLowerCase(), height },
      { wrappedConnection: conn }
    );
  }

  /**
   * Since when no history could tell an identity's founder: the first
   * time asked is now.
   */
  async founderWaitSince(principalId: string, now: number): Promise<number> {
    await this.db.execute(
      `insert ignore into ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE} (principal_id, since)
       values (:principalId, :now)`,
      { principalId: principalId.toLowerCase(), now }
    );
    const row = await this.db.oneOrNull<{ since: number | string }>(
      `select since from ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE} where principal_id = :principalId`,
      { principalId: principalId.toLowerCase() }
    );
    return Number(row?.since ?? now);
  }

  /** The profile id decided for an identity filed without a mapping. */
  async founderDecisionOf(principalId: string): Promise<string | null> {
    const row = await this.db.oneOrNull<{ profile_id: string | null }>(
      `select profile_id from ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE} where principal_id = :principalId`,
      { principalId: principalId.toLowerCase() }
    );
    return row?.profile_id ?? null;
  }

  /** Keeps the profile id decided for an identity filed without a mapping. */
  async founderDecided(principalId: string, profileId: string, now: number) {
    await this.db.execute(
      `insert into ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE} (principal_id, since, profile_id)
       values (:principalId, :now, :profileId)
       on duplicate key update profile_id = values(profile_id)`,
      { principalId: principalId.toLowerCase(), profileId, now }
    );
  }

  /** The founder is told (or the wait is over): no more waiting. */
  async founderWaitDone(principalId: string) {
    await this.db.execute(
      `delete from ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE} where principal_id = :principalId`,
      { principalId: principalId.toLowerCase() }
    );
  }

  /** The mapped profile ids of these principals (lowercase keys). */
  async profileIdsOfPrincipals(
    principalIds: string[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const ids = Array.from(new Set(principalIds.map((it) => it.toLowerCase())));
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.db.execute<{
        principal_id: string;
        profile_id: string;
      }>(
        `select principal_id, profile_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
         where principal_id in (:ids)`,
        { ids: ids.slice(i, i + 1000) }
      );
      rows.forEach((it) =>
        result.set(it.principal_id.toLowerCase(), it.profile_id)
      );
    }
    return result;
  }

  async principalOfProfile(
    profileId: string,
    conn?: Conn
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ principal_id: string }>(
      `select principal_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where profile_id = :profileId`,
      { profileId },
      conn ? { wrappedConnection: conn } : undefined
    );
    return row?.principal_id ?? null;
  }

  /**
   * Lists one chunk of 6529.io's placeholder profiles (handle
   * `id-<wallet>`) that no chain identity holds: the profiles after `after`
   * in id order, up to `limit` of them. Returns the chunk's last profile id,
   * or null after the last chunk. Short transactions, so profile writes
   * aren't held up while the list is taken.
   */
  async listPlaceholderProfiles(
    after: string,
    limit: number
  ): Promise<string | null> {
    const last = await this.db.oneOrNull<{ external_id: string }>(
      `select external_id from ${PROFILES_TABLE}
       where external_id > :after order by external_id limit 1 offset :skip`,
      { after, skip: limit - 1 }
    );
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.execute(
        `insert ignore into ${IDENTITY_CHAIN_PLACEHOLDERS_TABLE} (wallet, profile_id)
         select lower(p.primary_wallet), p.external_id from ${PROFILES_TABLE} p
         left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = p.external_id
         where p.external_id > :after
           ${last ? 'and p.external_id <= :last' : ''}
           and p.normalised_handle = concat('id-', lower(p.primary_wallet))
           and m.principal_id is null`,
        { after, last: last?.external_id ?? null },
        { wrappedConnection: conn }
      )
    );
    return last?.external_id ?? null;
  }

  /**
   * On another chain the mappings of identities made on the old one go (an
   * imported identity's mapping is its legacy id on any chain).
   */
  /**
   * Every mapping's level height goes (a relaunched chain's heights start
   * again): the new chain's levels are written.
   */
  async clearLevelHeights(conn: Conn) {
    await this.db.execute(
      `update ${IDENTITY_CHAIN_PRINCIPALS_TABLE} set level_height = null
       where level_height is not null`,
      undefined,
      { wrappedConnection: conn }
    );
  }

  async clearChainMadeMappings(conn: Conn) {
    await this.db.execute(
      `delete from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where origin <> 'LEGACY'`,
      undefined,
      { wrappedConnection: conn }
    );
    await this.db.execute(
      `delete from ${IDENTITY_CHAIN_FOUNDER_WAITS_TABLE}`,
      undefined,
      { wrappedConnection: conn }
    );
  }

  /**
   * A wallet's listed placeholder profile, when no principal holds it:
   * what an identity made on the chain takes when that wallet founded it.
   */
  async unmappedPlaceholderProfile(
    wallet: string,
    conn?: Conn
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ profile_id: string }>(
      `select c.profile_id from ${IDENTITY_CHAIN_PLACEHOLDERS_TABLE} c
       left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = c.profile_id
       where c.wallet = :wallet and m.principal_id is null`,
      { wallet: wallet.toLowerCase() },
      conn ? { wrappedConnection: conn } : undefined
    );
    return row?.profile_id ?? null;
  }

  async insertMapping(
    principalId: string,
    profileId: string,
    origin: string,
    now: number,
    conn: Conn
  ) {
    await this.db.execute(
      `insert into ${IDENTITY_CHAIN_PRINCIPALS_TABLE} (principal_id, profile_id, origin, created_at)
       values (:principalId, :profileId, :origin, :now)`,
      { principalId, profileId, origin, now },
      { wrappedConnection: conn }
    );
  }

  // ---------------------------------------------------------------- identities

  /** Another profile that holds this normalised handle now. */
  private async holderOf(
    normalised: string,
    exceptProfileId: string,
    conn: Conn
  ): Promise<{ external_id: string; primary_wallet: string } | null> {
    return await this.db.oneOrNull<{
      external_id: string;
      primary_wallet: string;
    }>(
      `select external_id, primary_wallet from ${PROFILES_TABLE}
       where normalised_handle = :normalised and external_id <> :exceptProfileId
       for update`,
      { normalised, exceptProfileId },
      { wrappedConnection: conn }
    );
  }

  async readIdentityState(
    wallets: string[],
    profileId: string,
    chainHandle: string | null,
    primary: string,
    conn: Conn
  ): Promise<CurrentIdentityState> {
    if (!wallets.length) {
      throw new Error(`An identity with no wallets can't be mirrored`);
    }
    const rows = await this.db.execute<IdentityRowState>(
      `select i.* from ${IDENTITIES_TABLE} i
       where i.profile_id = :profileId
          or i.consolidation_key in (
            select a.consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} a
            where a.address in (:wallets))
       for update`,
      { profileId, wallets },
      { wrappedConnection: conn }
    );
    const keys = rows.map((it) => it.consolidation_key);
    const walletsByKey: Record<string, string[]> = {};
    if (keys.length) {
      const addressRows = await this.db.execute<{
        address: string;
        consolidation_key: string;
      }>(
        `select address, consolidation_key from ${ADDRESS_CONSOLIDATION_KEY}
         where consolidation_key in (:keys) for update`,
        { keys },
        { wrappedConnection: conn }
      );
      for (const row of addressRows) {
        const list = walletsByKey[row.consolidation_key] ?? [];
        list.push(row.address.toLowerCase());
        walletsByKey[row.consolidation_key] = list;
      }
    }
    const profile = await this.db.oneOrNull<ProfileRowState>(
      `select external_id, handle, normalised_handle, primary_wallet, pfp_url,
              banner_1, banner_2, website, classification, sub_classification
       from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      { wrappedConnection: conn }
    );
    let handleHolder: CurrentIdentityState['handleHolder'] = null;
    if (chainHandle) {
      const holder = await this.holderOf(
        chainHandle.toLowerCase(),
        profileId,
        conn
      );
      if (holder) {
        const placeholder = `id-${holder.primary_wallet.toLowerCase()}`;
        const placeholderHeld =
          placeholder === chainHandle.toLowerCase() ||
          !!(await this.holderOf(placeholder, holder.external_id, conn));
        handleHolder = {
          external_id: holder.external_id,
          releaseHandle: placeholderHeld
            ? `id-${holder.external_id.toLowerCase()}`
            : placeholder
        };
      }
    }
    const placeholderTaken = !!(await this.holderOf(
      `id-${primary.toLowerCase()}`,
      profileId,
      conn
    ));
    return {
      rows: rows.map((row) => ({
        ...row,
        tdh: numberOf(row.tdh),
        rep: numberOf(row.rep),
        cic: numberOf(row.cic),
        level_raw: numberOf(row.level_raw),
        xtdh: numberOf(row.xtdh),
        produced_xtdh: numberOf(row.produced_xtdh),
        granted_xtdh: numberOf(row.granted_xtdh),
        xtdh_rate: numberOf(row.xtdh_rate),
        basetdh_rate: numberOf(row.basetdh_rate)
      })),
      walletsByKey,
      profile,
      handleHolder,
      placeholderTaken
    };
  }

  async applyIdentityPlan(
    plan: IdentityPlan,
    block: number,
    now: number,
    conn: Conn
  ) {
    const opts = { wrappedConnection: conn };
    if (plan.releaseHandle) {
      const params = {
        externalId: plan.releaseHandle.external_id,
        handle: plan.releaseHandle.handle,
        normalised: plan.releaseHandle.handle.toLowerCase()
      };
      await this.db.execute(
        `update ${PROFILES_TABLE} set handle = :handle, normalised_handle = :normalised
         where external_id = :externalId`,
        params,
        opts
      );
      await this.db.execute(
        `update ${IDENTITIES_TABLE} set handle = :handle, normalised_handle = :normalised
         where profile_id = :externalId`,
        params,
        opts
      );
    }
    if (plan.deleteKeys.length) {
      await this.db.execute(
        `delete from ${ADDRESS_CONSOLIDATION_KEY} where consolidation_key in (:keys)`,
        { keys: plan.deleteKeys },
        opts
      );
      await this.db.execute(
        `delete from ${IDENTITIES_TABLE} where consolidation_key in (:keys)`,
        { keys: plan.deleteKeys },
        opts
      );
    }
    for (const row of [plan.identity, ...plan.rekeyedRows, ...plan.soloRows]) {
      await this.upsertIdentityRow(row, conn);
    }
    for (const address of plan.addressKeys) {
      await this.db.execute(
        `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values (:address, :consolidation_key)
         on duplicate key update consolidation_key = values(consolidation_key)`,
        address,
        opts
      );
    }
    await this.writeProfile(plan, now, conn);
    if (plan.statements) {
      await this.replaceStatements(
        plan.profile.external_id,
        plan.statements,
        now,
        conn
      );
    }
    await this.replacePairs(plan, block, now, conn);
  }

  private async upsertIdentityRow(row: IdentityRowState, conn: Conn) {
    const columns = IDENTITY_COLUMNS.join(', ');
    const values = IDENTITY_COLUMNS.map((it) => `:${it}`).join(', ');
    const updates = IDENTITY_COLUMNS.filter(
      (it) => it !== 'consolidation_key' && !METRIC_COLUMNS.has(it)
    )
      .map((it) => `${it} = values(${it})`)
      .join(', ');
    await this.db.execute(
      `insert into ${IDENTITIES_TABLE} (${columns}) values (${values})
       on duplicate key update ${updates}`,
      { ...row },
      { wrappedConnection: conn }
    );
  }

  private async writeProfile(plan: IdentityPlan, now: number, conn: Conn) {
    const p = plan.profile;
    const params = {
      external_id: p.external_id,
      handle: p.handle,
      normalised_handle: p.normalised_handle,
      primary_wallet: p.primary_wallet,
      pfp_url: p.pfp_url,
      banner_1: p.banner_1,
      banner_2: p.banner_2,
      website: p.website,
      classification: p.classification,
      sub_classification: p.sub_classification,
      now: new Date(now)
    };
    if (p.insert) {
      await this.db.execute(
        `insert into ${PROFILES_TABLE}
           (external_id, handle, normalised_handle, primary_wallet, created_at,
            created_by_wallet, pfp_url, banner_1, banner_2, website,
            classification, sub_classification)
         values (:external_id, :handle, :normalised_handle, :primary_wallet, :now,
            :primary_wallet, :pfp_url, :banner_1, :banner_2, :website,
            :classification, :sub_classification)`,
        params,
        { wrappedConnection: conn }
      );
      return;
    }
    await this.db.execute(
      `update ${PROFILES_TABLE}
       set handle = :handle, normalised_handle = :normalised_handle,
           primary_wallet = :primary_wallet, pfp_url = :pfp_url,
           banner_1 = :banner_1, banner_2 = :banner_2, website = :website,
           classification = :classification,
           sub_classification = :sub_classification, updated_at = :now
       where external_id = :external_id
         and not (handle <=> :handle and normalised_handle <=> :normalised_handle
           and primary_wallet <=> :primary_wallet and pfp_url <=> :pfp_url
           and banner_1 <=> :banner_1 and banner_2 <=> :banner_2
           and website <=> :website and classification <=> :classification
           and sub_classification <=> :sub_classification)`,
      params,
      { wrappedConnection: conn }
    );
  }

  /** Keeps the statements that stay (and their ids); adds and removes the rest. */
  async replaceStatements(
    profileId: string,
    statements: ProfileDocStatement[],
    now: number,
    conn: Conn
  ) {
    const existing = await this.db.execute<{
      id: string;
      statement_group: string;
      statement_type: string;
      statement_value: string;
      statement_comment: string | null;
    }>(
      `select id, statement_group, statement_type, statement_value, statement_comment
       from ${CIC_STATEMENTS_TABLE} where profile_id = :profileId`,
      { profileId },
      { wrappedConnection: conn }
    );
    const wanted = new Map<string, number>();
    for (const it of statements) {
      const key = statementKey({
        statement_group: it.group,
        statement_type: it.type,
        statement_value: it.value,
        statement_comment: it.comment
      });
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    const remove: string[] = [];
    for (const row of existing) {
      const key = statementKey(row);
      const left = wanted.get(key) ?? 0;
      if (left > 0) wanted.set(key, left - 1);
      else remove.push(row.id);
    }
    if (remove.length) {
      await this.db.execute(
        `delete from ${CIC_STATEMENTS_TABLE} where id in (:remove)`,
        { remove },
        { wrappedConnection: conn }
      );
    }
    for (const [key, count] of Array.from(wanted.entries())) {
      const [group, type, value, comment] = JSON.parse(key) as [
        string,
        string,
        string,
        string | null
      ];
      for (let i = 0; i < count; i++) {
        await this.db.execute(
          `insert into ${CIC_STATEMENTS_TABLE}
             (id, profile_id, statement_group, statement_type, statement_comment, statement_value, crated_at)
           values (:id, :profileId, :group, :type, :comment, :value, :now)`,
          {
            id: randomUUID(),
            profileId,
            group,
            type,
            comment,
            value,
            now: new Date(now)
          },
          { wrappedConnection: conn }
        );
      }
    }
  }

  /**
   * The registration times of the existing pairs among these wallets (either
   * direction), so a pair rewritten from the chain keeps them: the TDH
   * grouping reads them for its four-wallet rule.
   */
  private async pairTimes(
    wallets: string[],
    conn: Conn
  ): Promise<Map<string, { first: number | null; second: number | null }>> {
    const times = new Map<
      string,
      { first: number | null; second: number | null }
    >();
    if (!wallets.length) return times;
    const rows = await this.db.execute<{
      wallet1: string;
      wallet2: string;
      wallet1_registered_at: number | string | null;
      wallet2_registered_at: number | string | null;
    }>(
      `select wallet1, wallet2, wallet1_registered_at, wallet2_registered_at
       from ${CONSOLIDATIONS_TABLE}
       where wallet1 in (:wallets) or wallet2 in (:wallets)`,
      { wallets },
      { wrappedConnection: conn }
    );
    const at = (value: number | string | null) =>
      value === null || value === undefined ? null : Number(value);
    for (const row of rows) {
      const a = row.wallet1.toLowerCase();
      const b = row.wallet2.toLowerCase();
      const ascending = a < b;
      times.set(ascending ? `${a}-${b}` : `${b}-${a}`, {
        first: at(
          ascending ? row.wallet1_registered_at : row.wallet2_registered_at
        ),
        second: at(
          ascending ? row.wallet2_registered_at : row.wallet1_registered_at
        )
      });
    }
    return times;
  }

  private async insertPairs(
    pairs: WalletPair[],
    times: Map<string, { first: number | null; second: number | null }>,
    block: number,
    now: number,
    conn: Conn
  ) {
    const nowSeconds = Math.floor(now / 1000);
    for (let i = 0; i < pairs.length; i += 500) {
      const chunk = pairs.slice(i, i + 500);
      const params: Record<string, unknown> = { now: new Date(now), block };
      const values = chunk
        .map((pair, j) => {
          const kept = times.get(`${pair.wallet1}-${pair.wallet2}`);
          params[`w1_${j}`] = pair.wallet1;
          params[`w2_${j}`] = pair.wallet2;
          params[`t1_${j}`] = kept?.first ?? nowSeconds;
          params[`t2_${j}`] = kept?.second ?? nowSeconds;
          return `(:now, :block, :w1_${j}, :w2_${j}, 1, :t1_${j}, :t2_${j})`;
        })
        .join(', ');
      await this.db.execute(
        `insert into ${CONSOLIDATIONS_TABLE}
           (created_at, block, wallet1, wallet2, confirmed, wallet1_registered_at, wallet2_registered_at)
         values ${values}`,
        params,
        { wrappedConnection: conn }
      );
    }
  }

  private async replacePairs(
    plan: IdentityPlan,
    block: number,
    now: number,
    conn: Conn
  ) {
    if (!plan.pairWallets.length) return;
    const times = await this.pairTimes(plan.pairWallets, conn);
    await this.db.execute(
      `delete from ${CONSOLIDATIONS_TABLE}
       where wallet1 in (:wallets) or wallet2 in (:wallets)`,
      { wallets: plan.pairWallets },
      { wrappedConnection: conn }
    );
    await this.insertPairs(plan.pairs, times, block, now, conn);
  }

  /** Every confirmed pair, replaced by the chain's (full sync only). */
  /**
   * Every confirmed pair becomes `pairs`, but for pairs with a wallet in
   * `keepWallets` (identities the mirror doesn't write), which stay as
   * they are.
   */
  async replaceAllPairs(
    pairs: WalletPair[],
    block: number,
    now: number,
    conn: Conn,
    keepWallets: string[] = []
  ) {
    const wallets = Array.from(
      new Set(pairs.flatMap((it) => [it.wallet1, it.wallet2]))
    );
    const times = await this.pairTimes(wallets, conn);
    const keep = Array.from(new Set(keepWallets.map((it) => it.toLowerCase())));
    await this.db.execute(
      keep.length
        ? `delete from ${CONSOLIDATIONS_TABLE}
           where wallet1 not in (:keep) and wallet2 not in (:keep)`
        : `delete from ${CONSOLIDATIONS_TABLE}`,
      keep.length ? { keep } : undefined,
      { wrappedConnection: conn }
    );
    await this.insertPairs(pairs, times, block, now, conn);
  }

  // ---------------------------------------------------------------- ratings

  /**
   * A target's REP and CIC ratings become `wanted` (help-bot credits kept).
   * The rating event log is written from the feed's records, not here.
   */
  async replaceTargetRatings(
    targetProfileId: string,
    wanted: RatingRowWrite[],
    now: number,
    conn: Conn,
    /**
     * Raters (profile ids) whose rows not in `wanted` stay: raters the
     * chain has but whose profile id can't be settled yet.
     */
    { keepRaters = [] }: { keepRaters?: readonly string[] } = {}
  ): Promise<{ inserted: number; updated: number; deleted: number }> {
    const opts = { wrappedConnection: conn };
    const existing = await this.db.execute<RatingRowWrite>(
      `select rater_profile_id, matter, matter_category, rating
       from ${RATINGS_TABLE}
       where matter_target_id = :target and matter in ('REP', 'CIC')
         and not (matter = 'REP' and lower(trim(matter_category)) = :helpBot)
       for update`,
      {
        target: targetProfileId,
        helpBot: HELP_BOT_CREDIT_CATEGORY.toLowerCase()
      },
      opts
    );
    const want = new Map(wanted.map((it) => [ratingKey(it), it]));
    const have = new Map(existing.map((it) => [ratingKey(it), it]));
    const kept = new Set(keepRaters.map((it) => it.toLowerCase()));
    const stays = (row: RatingRowWrite) =>
      kept.has(row.rater_profile_id.toLowerCase());
    const removed = Array.from(have.entries())
      .filter(([k, row]) => !want.has(k) && !stays(row))
      .map(([, row]) => row);
    for (const row of removed) {
      await this.db.execute(
        `delete from ${RATINGS_TABLE}
         where rater_profile_id = :rater and matter_target_id = :target
           and matter = :matter and matter_category = :category`,
        {
          rater: row.rater_profile_id,
          target: targetProfileId,
          matter: row.matter,
          category: row.matter_category
        },
        opts
      );
    }
    let inserted = 0;
    let updated = 0;
    for (const [k, row] of Array.from(want.entries())) {
      const old = have.get(k);
      if (old && Number(old.rating) === row.rating) continue;
      await this.db.execute(
        `insert into ${RATINGS_TABLE}
           (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
         values (:rater, :target, :matter, :category, :rating, :now)
         on duplicate key update rating = values(rating), last_modified = values(last_modified)`,
        {
          rater: row.rater_profile_id,
          target: targetProfileId,
          matter: row.matter,
          category: row.matter_category,
          rating: row.rating,
          now: new Date(now)
        },
        opts
      );
      if (old) updated++;
      else inserted++;
    }
    return { inserted, updated, deleted: removed.length };
  }

  /**
   * Rating event rows written since `createdSince` whose rater or target
   * wasn't mapped get the profile id now mapped, in one statement.
   * Returns the rows changed.
   */
  async fillRatingEventProfiles(createdSince: number): Promise<number> {
    const result = await this.db.execute(
      `update ${IDENTITY_CHAIN_RATING_EVENTS_TABLE} e
       left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} r on r.principal_id = e.rater_principal
       left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} t on t.principal_id = e.target_principal
       set e.rater_profile_id = coalesce(e.rater_profile_id, r.profile_id),
           e.target_profile_id = coalesce(e.target_profile_id, t.profile_id)
       where e.created_at >= :createdSince
         and ((e.rater_profile_id is null and r.profile_id is not null)
           or (e.target_profile_id is null and t.profile_id is not null))`,
      { createdSince }
    );
    return this.db.getAffectedRows(result);
  }

  /**
   * Rating event rows, in the caller's transaction, 500 a statement; a row
   * already there (the same height, rater, target, matter and category: a
   * page read again) is left as it is. Returns the affected rows; when the
   * driver reports found rows, a row already there counts too.
   */
  async insertRatingEvents(
    rows: readonly RatingEventRow[],
    now: number,
    conn: Conn
  ): Promise<number> {
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const params: Record<string, unknown> = { now };
      const values = rows
        .slice(i, i + 500)
        .map((it, j) => {
          params[`h${j}`] = it.height;
          params[`bt${j}`] = it.block_time_ms;
          params[`rp${j}`] = it.rater_principal.toLowerCase();
          params[`r${j}`] = it.rater_profile_id;
          params[`tp${j}`] = it.target_principal.toLowerCase();
          params[`t${j}`] = it.target_profile_id;
          params[`m${j}`] = it.matter;
          params[`c${j}`] = it.matter_category;
          params[`o${j}`] = it.old_rating;
          params[`n${j}`] = it.new_rating;
          params[`ta${j}`] = it.total_after;
          params[`or${j}`] = it.origin;
          params[`bi${j}`] = it.by_import ? 1 : 0;
          params[`w${j}`] = it.writer;
          return `(:h${j}, :bt${j}, :rp${j}, :r${j}, :tp${j}, :t${j}, :m${j}, :c${j}, :o${j}, :n${j}, :ta${j}, :or${j}, :bi${j}, :w${j}, 'FEED', :now)`;
        })
        .join(', ');
      const result = await this.db.execute(
        `insert into ${IDENTITY_CHAIN_RATING_EVENTS_TABLE}
             (height, block_time_ms, rater_principal, rater_profile_id, target_principal,
              target_profile_id, matter, matter_category, old_rating, new_rating, total_after,
              origin, by_import, writer, source, created_at)
           values ${values}
           on duplicate key update id = id`,
        params,
        { wrappedConnection: conn }
      );
      written += this.db.getAffectedRows(result);
    }
    return written;
  }

  /** The rating ledger's rows of these keys (by ledgerKeyOf). */
  async ratingLedgerOf(
    keys: readonly RatingLedgerKey[],
    conn?: Conn
  ): Promise<Map<string, { value: number; height: number }>> {
    const result = new Map<string, { value: number; height: number }>();
    for (let i = 0; i < keys.length; i += 500) {
      const params: Record<string, unknown> = {};
      const tuples = keys
        .slice(i, i + 500)
        .map((it, j) => {
          params[`r${j}`] = it.rater;
          params[`m${j}`] = it.matterCode;
          params[`k${j}`] = it.targetKind;
          params[`t${j}`] = it.target;
          params[`c${j}`] = it.category;
          return `(:r${j}, :m${j}, :k${j}, :t${j}, :c${j})`;
        })
        .join(', ');
      const rows = await this.db.execute<{
        rater_principal: string;
        matter: number | string;
        target_kind: number | string;
        target_principal: string;
        category: string;
        value: number | string;
        height: number | string;
      }>(
        `select rater_principal, matter, target_kind, target_principal, category, value, height
         from ${IDENTITY_CHAIN_RATING_LEDGER_TABLE}
         where (rater_principal, matter, target_kind, target_principal, category) in (${tuples})`,
        params,
        conn ? { wrappedConnection: conn } : undefined
      );
      rows.forEach((it) =>
        result.set(
          ledgerKeyOf({
            rater: it.rater_principal,
            matterCode: Number(it.matter),
            targetKind: Number(it.target_kind),
            target: it.target_principal,
            category: it.category
          }),
          { value: Number(it.value), height: Number(it.height) }
        )
      );
    }
    return result;
  }

  /** The ledger's totals of targets by matter and category (totalKeyOf). */
  async ratingLedgerTotalsOf(
    keys: readonly {
      readonly targetKind: number;
      readonly target: string;
      readonly matterCode: number;
      readonly category: string;
    }[],
    conn?: Conn
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (let i = 0; i < keys.length; i += 500) {
      const params: Record<string, unknown> = {};
      const tuples = keys
        .slice(i, i + 500)
        .map((it, j) => {
          params[`k${j}`] = it.targetKind;
          params[`t${j}`] = it.target;
          params[`m${j}`] = it.matterCode;
          params[`c${j}`] = it.category;
          return `(:k${j}, :t${j}, :m${j}, :c${j})`;
        })
        .join(', ');
      const rows = await this.db.execute<{
        target_kind: number | string;
        target_principal: string;
        matter: number | string;
        category: string;
        total: number | string;
      }>(
        `select target_kind, target_principal, matter, category, sum(value) as total
         from ${IDENTITY_CHAIN_RATING_LEDGER_TABLE}
         where (target_kind, target_principal, matter, category) in (${tuples})
         group by target_kind, target_principal, matter, category`,
        params,
        conn ? { wrappedConnection: conn } : undefined
      );
      rows.forEach((it) =>
        result.set(
          totalKeyOf({
            targetKind: Number(it.target_kind),
            target: it.target_principal,
            matterCode: Number(it.matter),
            category: it.category
          }),
          Number(it.total)
        )
      );
    }
    return result;
  }

  /** Ledger rows set (a value) and taken away (a removed rating). */
  async writeRatingLedger(
    upserts: readonly (RatingLedgerKey & { value: number; height: number })[],
    deletes: readonly RatingLedgerKey[],
    conn: Conn
  ) {
    const opts = { wrappedConnection: conn };
    for (let i = 0; i < upserts.length; i += 500) {
      const params: Record<string, unknown> = {};
      const values = upserts
        .slice(i, i + 500)
        .map((it, j) => {
          params[`r${j}`] = it.rater;
          params[`m${j}`] = it.matterCode;
          params[`k${j}`] = it.targetKind;
          params[`t${j}`] = it.target;
          params[`c${j}`] = it.category;
          params[`v${j}`] = it.value;
          params[`h${j}`] = it.height;
          return `(:r${j}, :m${j}, :k${j}, :t${j}, :c${j}, :v${j}, :h${j})`;
        })
        .join(', ');
      await this.db.execute(
        `insert into ${IDENTITY_CHAIN_RATING_LEDGER_TABLE}
           (rater_principal, matter, target_kind, target_principal, category, value, height)
         values ${values}
         on duplicate key update value = values(value), height = values(height)`,
        params,
        opts
      );
    }
    for (const it of deletes) {
      await this.db.execute(
        `delete from ${IDENTITY_CHAIN_RATING_LEDGER_TABLE}
         where rater_principal = :rater and matter = :matter and target_kind = :kind
           and target_principal = :target and category = :category`,
        {
          rater: it.rater,
          matter: it.matterCode,
          kind: it.targetKind,
          target: it.target,
          category: it.category
        },
        opts
      );
    }
  }

  /** A relaunched chain's ratings start again: its ledger and events. */
  async clearRatingEvents(conn: Conn) {
    for (const table of [
      IDENTITY_CHAIN_RATING_LEDGER_TABLE,
      IDENTITY_CHAIN_RATING_EVENTS_TABLE
    ]) {
      await this.db.execute(`delete from ${table}`, undefined, {
        wrappedConnection: conn
      });
    }
  }

  // ---------------------------------------------------------------- wallets

  /** The stored bindings of these wallets (locked inside a transaction). */
  async walletBindings(
    wallets: string[],
    conn?: Conn
  ): Promise<Map<string, WalletBindingRow>> {
    const result = new Map<string, WalletBindingRow>();
    for (let i = 0; i < wallets.length; i += 1000) {
      const rows = await this.db.execute<WalletBindingRow>(
        `select wallet, principal_id, bound_from_height
         from ${IDENTITY_CHAIN_WALLETS_TABLE} where wallet in (:wallets)
         ${conn ? 'for update' : ''}`,
        { wallets: wallets.slice(i, i + 1000) },
        conn ? { wrappedConnection: conn } : undefined
      );
      rows.forEach((row) =>
        result.set(row.wallet, {
          wallet: row.wallet,
          principal_id: row.principal_id,
          bound_from_height: Number(row.bound_from_height)
        })
      );
    }
    return result;
  }

  async writeWalletBindings(
    upserts: WalletBindingRow[],
    deletes: string[],
    now: number,
    conn: Conn
  ) {
    const opts = { wrappedConnection: conn };
    for (let i = 0; i < deletes.length; i += 1000) {
      await this.db.execute(
        `delete from ${IDENTITY_CHAIN_WALLETS_TABLE} where wallet in (:wallets)`,
        { wallets: deletes.slice(i, i + 1000) },
        opts
      );
    }
    for (let i = 0; i < upserts.length; i += 500) {
      const params: Record<string, unknown> = { now };
      const values = upserts
        .slice(i, i + 500)
        .map((row, j) => {
          params[`w${j}`] = row.wallet;
          params[`p${j}`] = row.principal_id;
          params[`h${j}`] = row.bound_from_height;
          return `(:w${j}, :p${j}, :h${j}, :now)`;
        })
        .join(', ');
      await this.db.execute(
        `insert into ${IDENTITY_CHAIN_WALLETS_TABLE}
           (wallet, principal_id, bound_from_height, updated_at)
         values ${values}
         on duplicate key update principal_id = values(principal_id),
           bound_from_height = values(bound_from_height),
           updated_at = values(updated_at)`,
        params,
        opts
      );
    }
  }

  /**
   * A wallet's binding and the next height the bindings read (they are exact
   * before it), in one read, so the two agree.
   */
  async walletBindingAt(wallet: string): Promise<{
    binding: WalletBindingRow | null;
    nextHeight: number | null;
    chainId: string | null;
  }> {
    const row = await this.db.oneOrNull<{
      bindings_next_height: number | string | null;
      chain_id: string | null;
      wallet: string | null;
      principal_id: string | null;
      bound_from_height: number | string | null;
    }>(
      `select s.bindings_next_height, s.chain_id, w.wallet, w.principal_id, w.bound_from_height
       from ${IDENTITY_CHAIN_MIRROR_STATE_TABLE} s
       left join ${IDENTITY_CHAIN_WALLETS_TABLE} w on w.wallet = :wallet
       where s.id = :id`,
      { wallet, id: STATE_ID }
    );
    const binding =
      row?.wallet && row.principal_id
        ? {
            wallet: row.wallet,
            principal_id: row.principal_id,
            bound_from_height: Number(row.bound_from_height)
          }
        : null;
    return {
      binding,
      nextHeight: numberOrNull(row?.bindings_next_height),
      chainId: row?.chain_id ?? null
    };
  }

  /** Every binding goes (the bindings start again). */
  /** Empties the wallet bindings and the first bindings recorded with them. */
  async clearWalletBindings(conn: Conn) {
    for (const table of [
      IDENTITY_CHAIN_WALLETS_TABLE,
      IDENTITY_CHAIN_FIRST_BINDINGS_TABLE
    ]) {
      await this.db.execute(`delete from ${table}`, undefined, {
        wrappedConnection: conn
      });
    }
  }

  /** Records first bindings; a wallet that has one keeps it. */
  async recordFirstBindings(rows: FirstBinding[], conn: Conn) {
    for (let i = 0; i < rows.length; i += 500) {
      const params: Record<string, unknown> = {};
      const values = rows
        .slice(i, i + 500)
        .map((it, j) => {
          params[`w${j}`] = it.wallet.toLowerCase();
          params[`p${j}`] = it.principal_id.toLowerCase();
          params[`h${j}`] = it.height;
          return `(:w${j}, :p${j}, :h${j})`;
        })
        .join(', ');
      await this.db.execute(
        `insert ignore into ${IDENTITY_CHAIN_FIRST_BINDINGS_TABLE} (wallet, principal_id, height)
         values ${values}`,
        params,
        { wrappedConnection: conn }
      );
    }
  }

  /**
   * A wallet's recorded first binding, and whether the bindings are exact
   * (followed from the import's start) and how far: with no record, an
   * exact table followed past a height says the wallet was bound to none
   * up to it.
   */
  async firstBindingOf(wallet: string): Promise<{
    first: FirstBinding | null;
    exact: boolean;
    nextHeight: number | null;
  }> {
    const row = await this.db.oneOrNull<{
      bindings_exact: number | boolean | null;
      bindings_next_height: number | string | null;
      wallet: string | null;
      principal_id: string | null;
      height: number | string | null;
    }>(
      `select s.bindings_exact, s.bindings_next_height, f.wallet, f.principal_id, f.height
       from ${IDENTITY_CHAIN_MIRROR_STATE_TABLE} s
       left join ${IDENTITY_CHAIN_FIRST_BINDINGS_TABLE} f on f.wallet = :wallet
       where s.id = :id`,
      { wallet: wallet.toLowerCase(), id: STATE_ID }
    );
    return {
      first:
        row?.wallet && row.principal_id
          ? {
              wallet: row.wallet,
              principal_id: row.principal_id.toLowerCase(),
              height: Number(row.height)
            }
          : null,
      exact: !!Number(row?.bindings_exact ?? 0),
      nextHeight: numberOrNull(row?.bindings_next_height)
    };
  }

  /** Queues regrouped wallets for re-keying, in the mirror's transaction. */
  async queueRegroups(wallets: string[], now: number, conn: Conn) {
    for (let i = 0; i < wallets.length; i += 500) {
      const params: Record<string, unknown> = { now };
      const values = wallets
        .slice(i, i + 500)
        .map((it, j) => {
          params[`w${j}`] = it.toLowerCase();
          return `(:w${j}, :now)`;
        })
        .join(', ');
      await this.db.execute(
        `insert into ${IDENTITY_CHAIN_REGROUPS_TABLE} (wallet, queued_at) values ${values}
         on duplicate key update queued_at = values(queued_at), started_at = null`,
        params,
        { wrappedConnection: conn }
      );
    }
  }

  /** Wallets waiting to be re-keyed, oldest first. */
  async pendingRegroups(limit: number): Promise<string[]> {
    const rows = await this.db.execute<{ wallet: string }>(
      `select wallet from ${IDENTITY_CHAIN_REGROUPS_TABLE}
       order by queued_at asc, wallet asc limit :limit`,
      { limit }
    );
    return rows.map((it) => it.wallet);
  }

  /** Wallets a re-keying batch took up and didn't finish. */
  async unfinishedRegroups(): Promise<number> {
    const row = await this.db.oneOrNull<{ n: number | string }>(
      `select count(*) as n from ${IDENTITY_CHAIN_REGROUPS_TABLE}
       where started_at is not null`
    );
    return Number(row?.n ?? 0);
  }

  /** A re-keying batch takes these wallets up. */
  async regroupsStarted(wallets: string[], now: number) {
    // Only this batch is marked: the count of marks is the last batch's.
    await this.db.execute(
      `update ${IDENTITY_CHAIN_REGROUPS_TABLE} set started_at = null
       where started_at is not null`
    );
    for (let i = 0; i < wallets.length; i += 1000) {
      await this.db.execute(
        `update ${IDENTITY_CHAIN_REGROUPS_TABLE} set started_at = :now
         where wallet in (:wallets)`,
        { wallets: wallets.slice(i, i + 1000), now }
      );
    }
  }

  /** Re-keyed: off the queue, unless queued again since `before`. */
  async regroupsDone(wallets: string[], before: number) {
    for (let i = 0; i < wallets.length; i += 1000) {
      await this.db.execute(
        `delete from ${IDENTITY_CHAIN_REGROUPS_TABLE}
         where wallet in (:wallets) and queued_at <= :before`,
        { wallets: wallets.slice(i, i + 1000), before }
      );
    }
    // A batch finished: the next one is full size again.
    await this.db.execute(
      `update ${IDENTITY_CHAIN_REGROUPS_TABLE} set started_at = null
       where started_at is not null`
    );
  }

  /** Every wallet with a stored binding (a rebuild's reconciliation). */
  async boundWallets(conn?: Conn): Promise<string[]> {
    const rows = await this.db.execute<{ wallet: string }>(
      `select wallet from ${IDENTITY_CHAIN_WALLETS_TABLE}`,
      undefined,
      conn ? { wrappedConnection: conn } : undefined
    );
    return rows.map((it) => it.wallet);
  }

  // ---------------------------------------------------------------- delegations

  /** A wallet's delegation rows (not consolidations) become `wanted`. */
  /**
   * A wallet's delegation rows (not consolidations) become `wanted`; with
   * `useCase`, only that use case's rows.
   */
  async replaceWalletDelegations(
    wallet: string,
    wanted: DelegationRowWrite[],
    conn: Conn,
    useCase?: number
  ): Promise<{ written: number; deleted: number }> {
    const opts = { wrappedConnection: conn };
    const existing = await this.db.execute<DelegationRowWrite>(
      `select block, from_address, to_address, collection, use_case, expiry, all_tokens, token_id
       from ${DELEGATIONS_TABLE}
       where from_address = :wallet and use_case <> :consolidation
         ${useCase === undefined ? '' : 'and use_case = :useCase'}
       for update`,
      { wallet, consolidation: USE_CASE_CONSOLIDATION, useCase },
      opts
    );
    const want = new Map(wanted.map((it) => [delegationKey(it), it]));
    const have = new Map(
      existing.map((it) => [
        delegationKey({
          ...it,
          block: Number(it.block),
          use_case: Number(it.use_case)
        }),
        it
      ])
    );
    let deleted = 0;
    let written = 0;
    for (const [k, row] of Array.from(have.entries())) {
      if (want.has(k)) continue;
      await this.db.execute(
        `delete from ${DELEGATIONS_TABLE}
         where block = :block and from_address = :from_address and to_address = :to_address
           and collection = :collection and use_case = :use_case`,
        { ...row },
        opts
      );
      deleted++;
    }
    for (const [k, row] of Array.from(want.entries())) {
      const old = have.get(k);
      if (old && sameDelegation(old, row)) continue;
      await this.db.execute(
        `insert into ${DELEGATIONS_TABLE}
           (block, from_address, to_address, collection, use_case, expiry, all_tokens, token_id)
         values (:block, :from_address, :to_address, :collection, :use_case, :expiry, :all_tokens, :token_id)
         on duplicate key update expiry = values(expiry), all_tokens = values(all_tokens),
           token_id = values(token_id)`,
        { ...row },
        opts
      );
      written++;
    }
    return { written, deleted };
  }

  /**
   * Wallets holding delegation rows (not consolidations), of one use case
   * when given: for a full sync.
   */
  async walletsWithDelegations(
    conn?: Conn,
    useCase?: number
  ): Promise<string[]> {
    const rows = await this.db.execute<{ from_address: string }>(
      `select distinct from_address from ${DELEGATIONS_TABLE}
       where use_case <> :consolidation
         ${useCase === undefined ? '' : 'and use_case = :useCase'}`,
      { consolidation: USE_CASE_CONSOLIDATION, useCase },
      conn ? { wrappedConnection: conn } : undefined
    );
    return rows.map((it) => it.from_address.toLowerCase());
  }

  /** Delegation rows of a use case the chain doesn't have go. */
  async deleteDelegationsOutside(useCases: readonly number[]) {
    await this.db.execute(
      `delete from ${DELEGATIONS_TABLE}
       where use_case <> :consolidation and use_case not in (:useCases)`,
      { consolidation: USE_CASE_CONSOLIDATION, useCases }
    );
  }

  /** Principals whose 6529.io rows hold these wallets now. */
  async principalsOfWallets(wallets: string[], conn?: Conn): Promise<string[]> {
    if (!wallets.length) return [];
    const rows = await this.db.execute<{ principal_id: string }>(
      `select distinct m.principal_id
       from ${ADDRESS_CONSOLIDATION_KEY} a
       join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
       join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = i.profile_id
       where a.address in (:wallets)`,
      { wallets },
      conn ? { wrappedConnection: conn } : undefined
    );
    return rows.map((it) => it.principal_id.toLowerCase());
  }
}

export const identityChainMirrorDb = new IdentityChainMirrorDb(dbSupplier);
