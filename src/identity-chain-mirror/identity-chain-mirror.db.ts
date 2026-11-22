import { randomUUID } from 'node:crypto';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
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

type Conn = ConnectionWrapper<any>;

export interface MirrorState {
  readonly next_height: number | null;
  readonly sync_from_height: number | null;
  readonly sync_phase: string | null;
  readonly sync_after: string | null;
  readonly last_full_sync_at: number | null;
}

export interface RatingRowWrite {
  readonly rater_profile_id: string;
  readonly matter: 'REP' | 'CIC';
  readonly matter_category: string;
  readonly rating: number;
}

export interface DelegationRowWrite {
  readonly block: number;
  readonly from_address: string;
  readonly to_address: string;
  readonly collection: string;
  readonly use_case: number;
  readonly expiry: number;
  readonly all_tokens: boolean;
  readonly token_id: number;
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
    const row = await this.db.oneOrNull<MirrorState>(
      `select next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at
       from ${IDENTITY_CHAIN_MIRROR_STATE_TABLE} where id = :id`,
      { id: STATE_ID },
      conn ? { wrappedConnection: conn } : undefined
    );
    if (!row) return null;
    const num = (value: unknown) =>
      value === null || value === undefined ? null : Number(value);
    return {
      next_height: num(row.next_height),
      sync_from_height: num(row.sync_from_height),
      sync_phase: row.sync_phase ?? null,
      sync_after: row.sync_after ?? null,
      last_full_sync_at: num(row.last_full_sync_at)
    };
  }

  async saveState(state: MirrorState, now: number, conn?: Conn) {
    await this.db.execute(
      `insert into ${IDENTITY_CHAIN_MIRROR_STATE_TABLE}
         (id, next_height, sync_from_height, sync_phase, sync_after, last_full_sync_at, updated_at)
       values (:id, :next_height, :sync_from_height, :sync_phase, :sync_after, :last_full_sync_at, :now)
       on duplicate key update
         next_height = values(next_height),
         sync_from_height = values(sync_from_height),
         sync_phase = values(sync_phase),
         sync_after = values(sync_after),
         last_full_sync_at = values(last_full_sync_at),
         updated_at = values(updated_at)`,
      { id: STATE_ID, ...state, now },
      conn ? { wrappedConnection: conn } : undefined
    );
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

  async profileExists(profileId: string, conn?: Conn): Promise<boolean> {
    const row = await this.db.oneOrNull<{ n: number }>(
      `select 1 as n from ${PROFILES_TABLE} where external_id = :profileId limit 1`,
      { profileId },
      conn ? { wrappedConnection: conn } : undefined
    );
    return !!row;
  }

  /**
   * Profiles of the wallets' current identity rows that no principal holds
   * yet, with each one's handle and wallet.
   */
  async unmappedProfilesOfWallets(
    wallets: string[],
    conn?: Conn
  ): Promise<{ profile_id: string; handle: string; address: string }[]> {
    if (!wallets.length) return [];
    return await this.db.execute(
      `select i.profile_id, p.handle, a.address
       from ${ADDRESS_CONSOLIDATION_KEY} a
       join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
       join ${PROFILES_TABLE} p on p.external_id = i.profile_id
       left join ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m on m.profile_id = i.profile_id
       where a.address in (:wallets) and m.principal_id is null`,
      { wallets },
      conn ? { wrappedConnection: conn } : undefined
    );
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
    const updates = IDENTITY_COLUMNS.filter((it) => it !== 'consolidation_key')
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

  /** A target's REP and CIC ratings become `wanted` (help-bot credits kept). */
  async replaceTargetRatings(
    targetProfileId: string,
    wanted: RatingRowWrite[],
    now: number,
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
    const key = (it: RatingRowWrite) =>
      JSON.stringify([it.rater_profile_id, it.matter, it.matter_category]);
    const want = new Map(wanted.map((it) => [key(it), it]));
    const have = new Map(existing.map((it) => [key(it), it]));
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    for (const [k, row] of Array.from(have.entries())) {
      if (!want.has(k)) {
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
        deleted++;
      }
    }
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
    return { inserted, updated, deleted };
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
