import { randomUUID } from 'node:crypto';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PLACEHOLDERS_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_CHAIN_RATING_EVENTS_TABLE,
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
  /** What the mirror could not write, tried again by the next run. */
  readonly retry: MirrorRetry;
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

/** Where a target's ratings were read: for the rating event log. */
export interface RatingEventContext {
  readonly targetPrincipal: string;
  /** The height the ratings were read at: a removed rating's event height. */
  readonly height: number;
  readonly source: 'FEED' | 'FULL_SYNC';
}

interface RatingEvent {
  readonly rater_profile_id: string;
  readonly matter: string;
  readonly matter_category: string;
  readonly old_rating: number;
  readonly new_rating: number;
  readonly rater_principal: string | null;
  readonly height: number;
}

function ratingKey(it: {
  rater_profile_id: string;
  matter: string;
  matter_category: string;
}): string {
  return JSON.stringify([it.rater_profile_id, it.matter, it.matter_category]);
}

function totalKey(it: { matter: string; matter_category: string }): string {
  return JSON.stringify([it.matter, it.matter_category]);
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
      Omit<MirrorState, 'retry'> & { retry_json: string | null }
    >(
      `select next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at,
              bindings_next_height, chain_id, placeholders_at, retry_json
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
      retry: retryOf(row.retry_json)
    };
  }

  async saveState(state: MirrorState, now: number, conn?: Conn) {
    await this.db.execute(
      `insert into ${IDENTITY_CHAIN_MIRROR_STATE_TABLE}
         (id, next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at,
          bindings_next_height, chain_id, placeholders_at, retry_json, updated_at)
       values (:id, :next_height, :sync_from_height, :sync_phase, :sync_after, :last_full_sync_at,
          :bindings_next_height, :chain_id, :placeholders_at, :retry_json, :now)
       on duplicate key update
         next_height = values(next_height),
         bindings_next_height = values(bindings_next_height),
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
  async clearChainMadeMappings(conn: Conn) {
    await this.db.execute(
      `delete from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where origin <> 'LEGACY'`,
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
  async replaceAllPairs(
    pairs: WalletPair[],
    block: number,
    now: number,
    conn: Conn
  ) {
    const wallets = Array.from(
      new Set(pairs.flatMap((it) => [it.wallet1, it.wallet2]))
    );
    const times = await this.pairTimes(wallets, conn);
    await this.db.execute(`delete from ${CONSOLIDATIONS_TABLE}`, undefined, {
      wrappedConnection: conn
    });
    await this.insertPairs(pairs, times, block, now, conn);
  }

  // ---------------------------------------------------------------- ratings

  /**
   * A target's REP and CIC ratings become `wanted` (help-bot credits kept).
   * Each change is also written to the rating event log.
   */
  async replaceTargetRatings(
    targetProfileId: string,
    wanted: RatingRowWrite[],
    now: number,
    events: RatingEventContext,
    conn: Conn
  ): Promise<{ inserted: number; updated: number; deleted: number }> {
    const opts = { wrappedConnection: conn };
    const existing = await this.db.execute<RatingRowWrite>(
      `select rater_profile_id, matter, matter_category, rating
       from ${RATINGS_TABLE}
       where matter_target_id = :target and matter in ('REP', 'CIC')
         and not (matter = 'REP' and matter_category = :helpBot)
       for update`,
      { target: targetProfileId, helpBot: HELP_BOT_CREDIT_CATEGORY },
      opts
    );
    const want = new Map(wanted.map((it) => [ratingKey(it), it]));
    const have = new Map(existing.map((it) => [ratingKey(it), it]));
    const log: RatingEvent[] = [];
    const removed = Array.from(have.entries())
      .filter(([k]) => !want.has(k))
      .map(([, row]) => row);
    const removedPrincipals = await this.principalsOfProfiles(
      removed.map((it) => it.rater_profile_id),
      conn
    );
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
      log.push({
        rater_profile_id: row.rater_profile_id,
        matter: row.matter,
        matter_category: row.matter_category,
        old_rating: Number(row.rating),
        new_rating: 0,
        rater_principal: removedPrincipals.get(row.rater_profile_id) ?? null,
        height: events.height
      });
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
      log.push({
        rater_profile_id: row.rater_profile_id,
        matter: row.matter,
        matter_category: row.matter_category,
        old_rating: old ? Number(old.rating) : 0,
        new_rating: row.rating,
        rater_principal: row.rater_principal ?? null,
        height: row.height ?? events.height
      });
      if (old) updated++;
      else inserted++;
    }
    await this.insertRatingEvents(
      { targetProfileId, wanted, log, now, events },
      conn
    );
    return { inserted, updated, deleted: removed.length };
  }

  /** Principal ids of mapped profiles. */
  private async principalsOfProfiles(
    profileIds: string[],
    conn: Conn
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!profileIds.length) return result;
    const rows = await this.db.execute<{
      profile_id: string;
      principal_id: string;
    }>(
      `select profile_id, principal_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
       where profile_id in (:profileIds)`,
      { profileIds },
      { wrappedConnection: conn }
    );
    rows.forEach((it) => result.set(it.profile_id, it.principal_id));
    return result;
  }

  private async insertRatingEvents(
    input: {
      targetProfileId: string;
      wanted: RatingRowWrite[];
      log: RatingEvent[];
      now: number;
      events: RatingEventContext;
    },
    conn: Conn
  ) {
    const { targetProfileId, wanted, log, now, events } = input;
    if (!log.length) return;
    const totals = new Map<string, number>();
    for (const it of wanted) {
      totals.set(totalKey(it), (totals.get(totalKey(it)) ?? 0) + it.rating);
    }
    for (let i = 0; i < log.length; i += 500) {
      const params: Record<string, unknown> = {
        target: targetProfileId,
        targetPrincipal: events.targetPrincipal.toLowerCase(),
        source: events.source,
        now
      };
      const values = log
        .slice(i, i + 500)
        .map((it, j) => {
          params[`h${j}`] = it.height;
          params[`rp${j}`] = it.rater_principal?.toLowerCase() ?? null;
          params[`r${j}`] = it.rater_profile_id;
          params[`m${j}`] = it.matter;
          params[`c${j}`] = it.matter_category;
          params[`o${j}`] = it.old_rating;
          params[`n${j}`] = it.new_rating;
          params[`t${j}`] = totals.get(totalKey(it)) ?? 0;
          return `(:h${j}, :rp${j}, :r${j}, :targetPrincipal, :target, :m${j}, :c${j}, :o${j}, :n${j}, :t${j}, :source, :now)`;
        })
        .join(', ');
      await this.db.execute(
        `insert into ${IDENTITY_CHAIN_RATING_EVENTS_TABLE}
           (height, rater_principal, rater_profile_id, target_principal, target_profile_id,
            matter, matter_category, old_rating, new_rating, total_after, source, created_at)
         values ${values}`,
        params,
        { wrappedConnection: conn }
      );
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
  async clearWalletBindings(conn: Conn) {
    await this.db.execute(
      `delete from ${IDENTITY_CHAIN_WALLETS_TABLE}`,
      undefined,
      { wrappedConnection: conn }
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
  async replaceWalletDelegations(
    wallet: string,
    wanted: DelegationRowWrite[],
    conn: Conn
  ): Promise<{ written: number; deleted: number }> {
    const opts = { wrappedConnection: conn };
    const existing = await this.db.execute<DelegationRowWrite>(
      `select block, from_address, to_address, collection, use_case, expiry, all_tokens, token_id
       from ${DELEGATIONS_TABLE}
       where from_address = :wallet and use_case <> :consolidation
       for update`,
      { wallet, consolidation: USE_CASE_CONSOLIDATION },
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

  /** Wallets holding delegation rows (not consolidations): for a full sync. */
  async walletsWithDelegations(conn?: Conn): Promise<string[]> {
    const rows = await this.db.execute<{ from_address: string }>(
      `select distinct from_address from ${DELEGATIONS_TABLE} where use_case <> :consolidation`,
      { consolidation: USE_CASE_CONSOLIDATION },
      conn ? { wrappedConnection: conn } : undefined
    );
    return rows.map((it) => it.from_address.toLowerCase());
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
