import { inSequence } from '@/db/in-sequence';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { IdentityEntity } from '../entities/IIdentity';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DROP_BOOSTS_TABLE,
  DROPS_TABLE,
  ENS_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  MEMES_PREVOTE_ARTIST_PROFILES_TABLE,
  NFTS_TABLE,
  PROFILES_ARCHIVE_TABLE,
  PROFILES_TABLE,
  TDH_NFT_TABLE,
  UUID_REGEX,
  WALLET_REGEX,
  WALLETS_TDH_TABLE,
  WAVES_TABLE,
  X_TDH_COEFFICIENT,
  MEME_COLLABORATION_INVITATIONS_TABLE
} from '@/constants';
import { Profile, ProfileClassification } from '../entities/IProfile';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { randomUUID } from 'crypto';
import { RequestContext } from '../request.context';
import { Timer } from '../time';
import { Wallet } from '../entities/IWallet';
import { collections } from '../collections';
import { env } from '../env';
import { DropType } from '../entities/IDrop';
import { appFeatures } from '../app-features';
import { nativeMainStageEntriesSource } from '@/competitions/competition-main-stage.repository';
import { legacyTypedDropsSql } from '@/competitions/legacy-typed-drops';
import {
  chunkSqlInListValues,
  querySqlInListChunks,
  SQL_IN_LIST_CHUNK_BYTES,
  SQL_IN_LIST_PAGE_VALUES
} from '@/db/sql-in-list-chunks';
import {
  isLegacyCompetitionGetFacadeScope,
  legacyGetView,
  withoutLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import {
  groupWaveVotingCreditNftsByContract,
  normalizeWaveVotingCreditNfts,
  waveVotingCreditNftKey
} from '@/waves/wave-voting-credit-nfts';

const mysql = require('mysql');

export interface WaveMentionSearchCandidate {
  readonly id: string;
  readonly handle: string;
  readonly display: string | null;
  readonly pfp: string | null;
  readonly level_raw: number;
}

/**
 * The main stage wave's drops of one type by the profiles in :profileIds.
 * Only drop_type needs the legacy compatibility projection: inside the
 * legacy GET facade it comes from base tables with the view's rows (see
 * legacyTypedDropsSql), because reading the view defeats the index.
 * Call it before entering withoutLegacyCompetitionGetFacade (it reads the
 * caller's scope), and run the SQL inside it so the base tables are not
 * rewritten.
 */
function mainStageTypedDropsSql(
  dropType: DropType.PARTICIPATORY | DropType.WINNER,
  legacyFacade: boolean
): string {
  return legacyFacade
    ? legacyTypedDropsSql(dropType, {
        profileIds: ':profileIds',
        waveId: ':mainStageWaveId'
      })
    : `select author_id as profile_id, id as drop_id from ${DROPS_TABLE}
      where author_id in (:profileIds) and wave_id = :mainStageWaveId
        and drop_type = '${dropType}'`;
}

function groupDropIdsByProfile(
  rows: { profile_id: string; drop_id: string }[]
): Record<string, string[]> {
  return rows.reduce(
    (acc, it) => {
      if (!acc[it.profile_id]) {
        acc[it.profile_id] = [];
      }
      acc[it.profile_id].push(it.drop_id);
      return acc;
    },
    {} as Record<string, string[]>
  );
}

export class IdentitiesDb extends LazyDbAccessCompatibleService {
  async getEverythingRelatedToIdentitiesByAddresses(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      {
        consolidations: AddressConsolidationKey[];
        identity: IdentityEntity;
        profile: Profile | null;
      }
    >
  > {
    if (!addresses.length) {
      return {};
    }
    const consolidations = await this.db.execute<AddressConsolidationKey>(
      `
      select * from ${ADDRESS_CONSOLIDATION_KEY} where address in (:addresses)
    `,
      { addresses },
      { wrappedConnection: connection }
    );
    const identities = await this.db.execute<IdentityEntity>(
      `select * from ${IDENTITIES_TABLE} identity where identity.consolidation_key in (
      select distinct i.consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses)
      )`,
      { addresses },
      { wrappedConnection: connection }
    );
    const profiles = await this.db.execute<Profile>(
      `select p.* from ${PROFILES_TABLE} p where p.external_id in (
      select distinct i.profile_id from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses) and i.handle is not null
      )`,
      { addresses },
      { wrappedConnection: connection }
    );
    return addresses.reduce(
      (acc, address) => {
        const consolidationKeys = consolidations.filter(
          (consolidation) => consolidation.address === address
        );
        if (consolidationKeys.length > 0) {
          const consolidationKey = consolidationKeys[0].consolidation_key;
          const identity = identities.find(
            (i) => i.consolidation_key === consolidationKey
          );
          if (!identity) {
            return acc;
          }
          const profile =
            profiles.find((p) => p.external_id === identity.profile_id) ?? null;
          acc[address] = {
            consolidations: consolidationKeys,
            identity,
            profile
          };
        }
        return acc;
      },
      {} as Record<
        string,
        {
          consolidations: AddressConsolidationKey[];
          identity: IdentityEntity;
          profile: Profile | null;
        }
      >
    );
  }

  public async insertIdentity(
    identityEntity: IdentityEntity,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        insert into ${IDENTITIES_TABLE} (consolidation_key,
                                         profile_id,
                                         primary_address,
                                         handle,
                                         normalised_handle,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw,
                                         pfp,
                                         banner1,
                                         banner2,
                                         classification,
                                         sub_classification,
                                         xtdh,
                                         produced_xtdh,
                                         granted_xtdh)
        values (:consolidation_key,
                :profile_id,
                :primary_address,
                :handle,
                :normalised_handle,
                :tdh,
                :rep,
                :cic,
                :level_raw,
                :pfp,
                :banner1,
                :banner2,
                :classification,
                :sub_classification,
                :xtdh,
                :produced_xtdh,
                :granted_xtdh)
    `,
      identityEntity,
      { wrappedConnection: connection }
    );
    for (const address of identityEntity.consolidation_key.split('-')) {
      await this.db.execute(
        `
          insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
          values (:address, :consolidation_key) on duplicate key update consolidation_key = :consolidation_key
        `,
        { address, consolidation_key: identityEntity.consolidation_key },
        { wrappedConnection: connection }
      );
    }
  }

  public async insertIdentitiesOnAddressesOnly(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (!addresses.length) {
      return;
    }
    const identitiesSql = `insert into ${IDENTITIES_TABLE} (
                                         profile_id,
                                         consolidation_key,
                                         primary_address,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw)
        values ${addresses
          .map(
            (address) =>
              `(${mysql.escape(randomUUID())}, ${mysql.escape(
                address
              )}, ${mysql.escape(address)}, 0, 0, 0, 0)`
          )
          .join(',')}`;
    const paramsSql = `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
        values ${addresses
          .map(
            (address) => `(${mysql.escape(address)}, ${mysql.escape(address)})`
          )
          .join(',')}`;
    await Promise.all([
      this.db.execute(identitiesSql, undefined, {
        wrappedConnection: connection
      }),
      this.db.execute(paramsSql, undefined, {
        wrappedConnection: connection
      })
    ]);
  }

  async updateIdentityProfile(
    consolidationKey: string,
    profile: {
      profile_id: string;
      handle: string;
      classification: ProfileClassification | null;
      normalised_handle: string;
      sub_classification: string | null;
      banner1: string | null;
      banner2: string | null;
      pfp: string | null;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      update ${IDENTITIES_TABLE} 
      set profile_id = :profile_id,
          handle = :handle,
          banner2 = :banner2,
          classification = :classification,
          normalised_handle = :normalised_handle,
          sub_classification = :sub_classification,
          banner1 = :banner1,
          pfp = :pfp
      where consolidation_key = :consolidationKey
    `,
      { consolidationKey, ...profile },
      { wrappedConnection: connection }
    );
  }

  async deleteAddressConsolidations(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (addresses.length === 0) return;
    await this.db.execute(
      `
      delete from ${ADDRESS_CONSOLIDATION_KEY} where address in (:addresses)
    `,
      { addresses },
      { wrappedConnection: connection }
    );
  }

  async deleteIdentities(
    param: { consolidationKeys: string[] },
    connection: ConnectionWrapper<any>
  ) {
    if (param.consolidationKeys.length === 0) return;
    await this.db.execute(
      `
      delete from ${IDENTITIES_TABLE} where consolidation_key in (:consolidationKeys)
    `,
      param,
      { wrappedConnection: connection }
    );
  }

  async bulkInsertIdentities(
    identities: IdentityEntity[],
    connection: ConnectionWrapper<any>
  ) {
    if (!identities.length) {
      return;
    }

    const identityRows = identities.map((identity) => ({
      profile_id: identity.profile_id ?? null,
      consolidation_key: identity.consolidation_key,
      primary_address: identity.primary_address,
      handle: identity.handle ?? null,
      normalised_handle: identity.normalised_handle ?? null,
      tdh: identity.tdh ?? 0,
      rep: identity.rep ?? 0,
      cic: identity.cic ?? 0,
      level_raw: identity.level_raw ?? 0,
      pfp: identity.pfp ?? null,
      banner1: identity.banner1 ?? null,
      banner2: identity.banner2 ?? null,
      classification: identity.classification ?? null,
      sub_classification: identity.sub_classification ?? null
    }));

    await this.db.bulkUpsert(
      IDENTITIES_TABLE,
      identityRows,
      [
        'profile_id',
        'consolidation_key',
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
        'sub_classification'
      ],
      [
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
        'sub_classification'
      ],
      undefined,
      { connection }
    );

    const addressRows = identities.flatMap((identity) =>
      identity.consolidation_key.split('-').map((address) => ({
        address,
        consolidation_key: identity.consolidation_key
      }))
    );

    await this.db.bulkUpsert(
      ADDRESS_CONSOLIDATION_KEY,
      addressRows,
      ['address', 'consolidation_key'],
      ['consolidation_key'],
      undefined,
      { connection }
    );
  }

  async getIdentityByProfileId(
    id: string,
    connectionHolder?: ConnectionWrapper<any>
  ) {
    return await this.db.oneOrNull<IdentityEntity>(
      `select * from ${IDENTITIES_TABLE} where profile_id = :id`,
      { id },
      { wrappedConnection: connectionHolder }
    );
  }

  public async getSingleNftVotingCreditByProfileId(
    profileId: string,
    creditNft: { contract: string; tokenId: number },
    ctx: RequestContext
  ): Promise<number> {
    const creditKey = `${creditNft.contract.toLowerCase()}:${creditNft.tokenId}`;
    return (
      (
        await this.getSingleNftVotingCreditsByProfileId(
          profileId,
          [creditNft],
          ctx
        )
      )[creditKey] ?? 0
    );
  }

  public async getSingleNftVotingCreditsByProfileId(
    profileId: string,
    creditNfts: { contract: string; tokenId: number }[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    const timerKey = `${this.constructor.name}->getSingleNftVotingCreditsByProfileId`;
    ctx.timer?.start(timerKey);
    try {
      const normalizedCreditNfts = normalizeWaveVotingCreditNfts(creditNfts);
      if (!normalizedCreditNfts.length) {
        return {};
      }
      const credits = (
        await Promise.all(
          groupWaveVotingCreditNftsByContract(normalizedCreditNfts).map(
            ({ contract, tokenIds }) =>
              this.db.execute<{
                contract: string;
                token_id: number;
                boosted_tdh: number;
              }>(
                `
                  SELECT t.contract AS contract,
                         t.id AS token_id,
                         MAX(t.boosted_tdh) AS boosted_tdh
                  FROM ${TDH_NFT_TABLE} t
                  JOIN (
                    SELECT DISTINCT consolidation_key
                    FROM ${IDENTITIES_TABLE}
                    WHERE profile_id = :profileId
                  ) i
                    ON i.consolidation_key = t.consolidation_key
                  WHERE t.contract = :contract
                    AND t.id IN (:tokenIds)
                  GROUP BY t.contract, t.id
                `,
                {
                  profileId,
                  contract,
                  tokenIds
                },
                { wrappedConnection: ctx.connection }
              )
          )
        )
      ).flat();
      const creditByKey = normalizedCreditNfts.reduce(
        (acc, creditNft) => {
          acc[waveVotingCreditNftKey(creditNft.contract, creditNft.tokenId)] =
            0;
          return acc;
        },
        {} as Record<string, number>
      );
      for (const credit of credits) {
        creditByKey[
          waveVotingCreditNftKey(credit.contract, Number(credit.token_id))
        ] = credit.boosted_tdh ?? 0;
      }
      return creditByKey;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async getIdentityByHandle(
    handle: string,
    ctx: RequestContext
  ): Promise<IdentityEntity | null> {
    return await this.db.oneOrNull<IdentityEntity>(
      `select * from ${IDENTITIES_TABLE} where normalised_handle = :handle`,
      { handle: handle.toLowerCase() },
      { wrappedConnection: ctx.connection }
    );
  }

  /**
   * Copies identities.primary_address to profiles.primary_wallet for the given
   * profiles where they differ. Callers pass every profile whose identity or
   * profile row they changed (consolidation step B: the identities it wrote
   * and the merged profiles); no other profile is read or locked.
   */
  async syncProfileAddressesFromIdentitiesToProfiles(
    profileIds: string[],
    connection: ConnectionWrapper<any>
  ) {
    // A broad UPDATE locks unchanged profiles until the consolidation's
    // transaction commits, blocking posting's moderation lock. Discover
    // differences without locks, then force indexed writes only for those
    // stable profile IDs. Callers finish identity consolidation writes on this
    // connection first. Concurrent primary-address writers update profiles and
    // identities together in updatePrimaryAddress; this snapshot need not
    // chase their later commits.
    const sortedIds = collections
      .distinct(profileIds)
      .sort((a, b) => a.localeCompare(b));
    for (const ids of chunkSqlInListValues(
      sortedIds,
      SQL_IN_LIST_CHUNK_BYTES,
      SQL_IN_LIST_PAGE_VALUES
    )) {
      // external_id is a nonunique index here; the profile PK is its handle.
      const changedProfiles: { external_id: string }[] = await this.db.execute(
        `select distinct p.external_id
         from ${PROFILES_TABLE} p force index (idx_profile_external_id)
         join ${IDENTITIES_TABLE} i on i.profile_id = p.external_id
         where p.external_id in (:profileIds)
           and p.primary_wallet != i.primary_address
         order by p.external_id asc`,
        { profileIds: ids },
        { wrappedConnection: connection }
      );
      // An IN batch can still choose a full index scan and lock unchanged
      // rows. Point lookups keep that lock scope narrow. The connection is
      // shared, so writes must execute sequentially.
      for (const profile of changedProfiles) {
        await this.db.execute(
          `update ${PROFILES_TABLE} p force index (idx_profile_external_id)
           join ${IDENTITIES_TABLE} i on i.profile_id = p.external_id
           set p.primary_wallet = i.primary_address
           where p.external_id = :profileId
             and p.primary_wallet != i.primary_address`,
          { profileId: profile.external_id },
          { wrappedConnection: connection }
        );
      }
    }
  }

  async updateIdentityProfilesOfIds(profileIds: string[], ctx: RequestContext) {
    if (!profileIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->updateIdentityProfilesOfIds`);
    await this.db.execute(
      `update ${IDENTITIES_TABLE} inner join ${PROFILES_TABLE} on ${IDENTITIES_TABLE}.profile_id = ${PROFILES_TABLE}.external_id
                           set
                               ${IDENTITIES_TABLE}.handle = ${PROFILES_TABLE}.handle,
                               ${IDENTITIES_TABLE}.normalised_handle = ${PROFILES_TABLE}.normalised_handle,
                               ${IDENTITIES_TABLE}.classification = ${PROFILES_TABLE}.classification
                           where ${IDENTITIES_TABLE}.profile_id in (:profileIds)`,
      { profileIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->updateIdentityProfilesOfIds`);
  }

  async bulkUpdateReps(
    repBulkUpdates: { profileId: string; newRep: number }[],
    ctx: RequestContext
  ) {
    if (appFeatures.isExperimentalBulkRepEnabled()) {
      if (!repBulkUpdates.length) return;
      const sql = `
        UPDATE ${IDENTITIES_TABLE} 
        SET rep = rep + CASE profile_id ${repBulkUpdates.map((_, i) => `WHEN :profileId${i} THEN :newRep${i}`).join(' ')} END,
            level_raw = level_raw + CASE profile_id ${repBulkUpdates.map((_, i) => `WHEN :profileId${i} THEN :newRep${i}`).join(' ')} END
        WHERE profile_id IN (${repBulkUpdates.map((_, i) => `:profileId${i}`).join(', ')})
      `;

      const params = repBulkUpdates.reduce(
        (acc, update, i) => {
          acc[`profileId${i}`] = update.profileId;
          acc[`newRep${i}`] = update.newRep;
          return acc;
        },
        {} as Record<string, any>
      );

      await this.db.execute(sql, params, { wrappedConnection: ctx.connection });
    } else {
      await inSequence(
        repBulkUpdates.map(
          (update) => () =>
            this.db.execute(
              `update ${IDENTITIES_TABLE} set rep = rep + :newRep, level_raw = level_raw + :newRep where profile_id = :profileId`,
              update,
              { wrappedConnection: ctx.connection }
            )
        )
      );
    }
  }

  async searchIdentitiesWithDisplays(
    param: {
      limit: number;
      handle: string | null;
      classification: ProfileClassification | null;
      subclassification: string | null;
    },
    base: {
      sql: string;
      params: Record<string, any>;
    } | null,
    ctx: RequestContext
  ): Promise<(IdentityEntity & { display: string | null })[]> {
    ctx.timer?.start(`${this.constructor.name}->searchIdentities`);
    try {
      const handle = param.handle?.toLowerCase() ?? null;
      const queryParams: Record<string, unknown> = {
        ...(base?.params ?? {}),
        limit: param.limit
      };
      const whereClauses: string[] = [];

      if (handle !== null) {
        whereClauses.push('i.normalised_handle like :likeHandle');
        queryParams['likeHandle'] = `%${handle}%`;
        queryParams['prefixHandle'] = `${handle}%`;
        queryParams['handle'] = handle;
      }
      if (param.classification !== null) {
        whereClauses.push('i.classification = :classification');
        queryParams['classification'] = param.classification;
      }
      if (param.subclassification !== null) {
        whereClauses.push('i.sub_classification = :subclassification');
        queryParams['subclassification'] = param.subclassification;
      }

      const prelude = base?.sql ?? '';
      const join = base
        ? `join user_groups_view ug on i.profile_id = ug.profile_id`
        : '';
      const where = whereClauses.length
        ? `where ${whereClauses.join('\n        and ')}`
        : '';
      const orderBy =
        handle === null
          ? 'i.level_raw desc'
          : `(i.normalised_handle = :handle) desc,
      (i.normalised_handle like :prefixHandle) desc,
      i.level_raw desc,
      i.normalised_handle asc,
      i.profile_id asc`;

      const query = `
      ${prelude}
      select i.*, cwt.consolidation_display as display
      from ${IDENTITIES_TABLE} i
      ${join}
      left join ${CONSOLIDATED_WALLETS_TDH_TABLE} cwt
        on i.consolidation_key = cwt.consolidation_key
      ${where}
      order by
        ${orderBy}
      limit :limit
    `;

      return await this.db.execute<IdentityEntity & { display: string | null }>(
        query,
        queryParams,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->searchIdentities`);
    }
  }

  async searchWaveMentionCandidates(
    param: {
      handle: string;
      limit: number;
      excludedProfileId: string | null;
    },
    eligibility: {
      sql: string;
      params: Record<string, any>;
    } | null,
    ctx: RequestContext
  ): Promise<WaveMentionSearchCandidate[]> {
    const timerKey = `${this.constructor.name}->searchWaveMentionCandidates`;
    ctx.timer?.start(timerKey);
    try {
      const eligibilityJoin = eligibility
        ? `join user_groups_view ug on ug.profile_id = i.profile_id`
        : '';
      const excludedProfileClause = param.excludedProfileId
        ? `and i.profile_id <> :mentionExcludedProfileId`
        : '';
      return await this.db.execute<WaveMentionSearchCandidate>(
        `
          ${eligibility?.sql ?? ''}
          select
            i.profile_id as id,
            i.handle,
            cwt.consolidation_display as display,
            i.pfp,
            i.level_raw
          from ${IDENTITIES_TABLE} i force index (identity_normalised_handle_idx)
          ${eligibilityJoin}
          left join ${CONSOLIDATED_WALLETS_TDH_TABLE} cwt
            on cwt.consolidation_key = i.consolidation_key
          where i.profile_id is not null
            and i.handle is not null
            and i.normalised_handle like :mentionHandlePrefix
            ${excludedProfileClause}
          order by
            i.level_raw desc,
            i.normalised_handle asc,
            i.profile_id asc
          limit :mentionLimit
        `,
        {
          ...(eligibility?.params ?? {}),
          mentionHandlePrefix: `${param.handle.toLowerCase()}%`,
          mentionExcludedProfileId: param.excludedProfileId,
          mentionLimit: param.limit
        },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async getProfileIdByWallet(
    wallet: string,
    timer?: Timer
  ): Promise<string | null> {
    timer?.start(`${this.constructor.name}->getProfileIdByWallet`);
    const profileId = await this.db
      .oneOrNull<{ profile_id: string }>(
        `
      select i.profile_id as profile_id from ${IDENTITIES_TABLE} i
      join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
      where a.address = :wallet
      `,
        { wallet }
      )
      .then((it) => it?.profile_id ?? null);
    timer?.stop(`${this.constructor.name}->getProfileIdByWallet`);
    return profileId;
  }

  async getIdentityByWallet(
    wallet: string,
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityEntity | null> {
    return this.db.oneOrNull<IdentityEntity>(
      `
    select i.* from ${IDENTITIES_TABLE} i
    join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
    where a.address = :wallet
    `,
      { wallet },
      { wrappedConnection: connection }
    );
  }

  async getProfileIdByIdentityKeyFast(
    {
      identityKey
    }: {
      identityKey: string;
    },
    ctx: RequestContext
  ): Promise<string | null> {
    const key = identityKey.toLowerCase();
    const timerKey = `${this.constructor.name}->getProfileIdByIdentityKeyFast`;
    try {
      ctx.timer?.start(timerKey);
      if (UUID_REGEX.exec(key)) {
        return await this.db
          .oneOrNull<{
            profile_id: string;
          }>(
            `select profile_id from ${IDENTITIES_TABLE} where profile_id = :profileId`,
            { profileId: key },
            { wrappedConnection: ctx.connection }
          )
          .then((it) => it?.profile_id ?? null);
      }
      if (WALLET_REGEX.exec(key)) {
        return await this.db
          .oneOrNull<{ profile_id: string }>(
            `
              select i.profile_id as profile_id from ${IDENTITIES_TABLE} i
              join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
              where a.address = :wallet
            `,
            { wallet: key },
            { wrappedConnection: ctx.connection }
          )
          .then((it) => it?.profile_id ?? null);
      }
      if (key.endsWith('.eth')) {
        return await this.db
          .oneOrNull<{ profile_id: string }>(
            `
              select i.profile_id as profile_id
              from ${ENS_TABLE} e
              join ${ADDRESS_CONSOLIDATION_KEY} a on lower(e.wallet) = a.address
              join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
              where lower(e.display) = :ens
            `,
            { ens: key },
            { wrappedConnection: ctx.connection }
          )
          .then((it) => it?.profile_id ?? null);
      }
      return await this.db
        .oneOrNull<{
          profile_id: string;
        }>(
          `select profile_id from ${IDENTITIES_TABLE} where normalised_handle = :handle`,
          { handle: key },
          { wrappedConnection: ctx.connection }
        )
        .then((it) => it?.profile_id ?? null);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async getConsolidationInfoForAddress(
    address: string,
    connection?: ConnectionWrapper<any>
  ): Promise<
    {
      blockNo: number;
      consolidation_display: string | null;
      balance: number;
      wallets: string[];
    }[]
  > {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute<{
        balance: number;
        consolidation_display: string;
        block: number;
        wallets: string;
      }>(
        `
        SELECT 
               t.balance,
               t.consolidation_display,
               t.block,
               t.wallets
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} t
                 join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = t.consolidation_key
        WHERE a.address = :address
        `,
        { address: address.toLowerCase() },
        opts
      )
      .then((result) => {
        return result.map((it) => ({
          blockNo: it.block,
          consolidation_display: it.consolidation_display,
          balance: it.balance,
          wallets: JSON.parse(it.wallets)
        }));
      });
  }

  public async getWalletsTdhs(
    {
      wallets,
      blockNo
    }: {
      wallets: string[];
      blockNo: number;
    },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    const normalisedWallets = wallets.map((w) => w.toLowerCase());
    if (!normalisedWallets.length) {
      return {};
    }
    const result: { wallet: string; tdh: number }[] = await this.db.execute(
      `select lower(wallet) as wallet, boosted_tdh as tdh from ${WALLETS_TDH_TABLE} where block = :blockNo and lower(wallet) in (:wallets)`,
      {
        blockNo,
        wallets: normalisedWallets
      },
      { wrappedConnection: ctx.connection }
    );
    return normalisedWallets.reduce(
      (acc: Record<string, number>, wallet: string) => {
        acc[wallet.toLowerCase()] =
          result.find((r) => r.wallet.toLowerCase() === wallet.toLowerCase())
            ?.tdh ?? 0;
        return acc;
      },
      {}
    );
  }

  public async getPrediscoveredEnsNames(
    walletAddresses: string[],
    ctx: RequestContext
  ): Promise<Wallet[]> {
    if (!walletAddresses.length) {
      return [];
    }
    const results: Wallet[] = await this.db.execute(
      `SELECT wallet as address, display as ens FROM ${ENS_TABLE} WHERE LOWER(wallet) IN (:walletAddresses)`,
      {
        walletAddresses: walletAddresses.map((walletAddress) =>
          walletAddress.toLowerCase()
        )
      },
      { wrappedConnection: ctx.connection }
    );
    return walletAddresses.map((walletAddress) => ({
      address: walletAddress,
      ens: results.find((row) => row.address.toLowerCase() === walletAddress)
        ?.ens
    }));
  }

  async getIdentitiesByIds(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute<IdentityEntity>(
      `select * from ${IDENTITIES_TABLE} where profile_id in (:ids)`,
      { ids },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async getIdentitiesForOverviewsByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<
    {
      id: string;
      handle?: string;
      primary_address: string;
      pfp?: string;
      level_raw: number;
      classification: ProfileClassification;
    }[]
  > {
    ctx.timer?.start(
      `${this.constructor.name}->getIdentitiesForOverviewaByIds`
    );
    try {
      if (!ids.length) {
        return [];
      }
      const dbResponse = await this.db.execute<{
        id: string;
        handle: string | null;
        primary_address: string;
        pfp: string | null;
        level_raw: number;
        classification: ProfileClassification;
      }>(
        `
       select 
        i.profile_id as id,
        i.handle as handle,
        i.primary_address as primary_address,
        i.pfp as pfp,
        i.level_raw as level_raw,
        i.classification as classification
       from ${IDENTITIES_TABLE} i where i.profile_id in (:ids)`,
        { ids },
        { wrappedConnection: ctx.connection }
      );
      return dbResponse.map((it) => ({
        id: it.id,
        handle: it.handle === null ? undefined : it.handle,
        primary_address: it.primary_address,
        pfp: it.pfp === null ? undefined : it.pfp,
        level_raw: it.level_raw,
        classification: it.classification
      }));
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getIdentitiesForOverviewaByIds`
      );
    }
  }

  async findProfileHandlesByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    if (!ids.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->findProfileHandlesByIds`);
    try {
      const rows = await this.db.execute<{
        id: string;
        handle: string | null;
      }>(
        `
        select profile_id as id, handle
        from ${IDENTITIES_TABLE}
        where profile_id in (:ids)
          and handle is not null
      `,
        { ids },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => {
          if (row.handle !== null) {
            acc[row.id] = row.handle;
          }
          return acc;
        },
        {} as Record<string, string>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findProfileHandlesByIds`);
    }
  }

  async getNewestVersionHandlesOfArchivedProfiles(
    profileIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<
    {
      external_id: string;
      handle: string | null;
      banner1: string | null;
      banner2: string | null;
      primary_address: string;
      classification: ProfileClassification | null;
      sub_classification: string | null;
    }[]
  > {
    if (profileIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `with prof_ids_w_latest_versions as (select external_id, max(id) as id from ${PROFILES_ARCHIVE_TABLE} group by 1)
            select p.external_id as external_id,
                   p.handle as handle,
                   p.banner_1 as banner1,
                   p.banner_2 as banner2,
                   p.primary_wallet as primary_address,
                   p.classification as classification,
                   p.sub_classification as sub_classification
            from ${PROFILES_ARCHIVE_TABLE} p
                     join prof_ids_w_latest_versions l on p.id = l.id
            where l.external_id in (:profileIds)`,
      { profileIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  public async updateProfilePfpUri(
    thumbnailUri: string,
    profileId: string,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${PROFILES_TABLE}
       set pfp_url = :pfp
       where external_id = :profileId`,
      {
        pfp: thumbnailUri,
        profileId
      },
      { wrappedConnection: connection }
    );
    await this.db.execute(
      `update ${IDENTITIES_TABLE}
       set pfp = :pfp
       where profile_id = :profileId`,
      {
        pfp: thumbnailUri,
        profileId
      },
      { wrappedConnection: connection }
    );
    await this.getIdentityByProfileId(profileId, connection).then(
      async (it) => {
        if (it) {
          await this.insertProfileArchiveRecord(it, connection);
        }
      }
    );
  }

  public async getMemeThumbnailUriById(
    id: number,
    connection?: ConnectionWrapper<any>
  ): Promise<string | null> {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    const result = await this.db.execute(
      `select thumbnail from ${NFTS_TABLE} where id = :id and contract = :contract order by id asc limit 1`,
      {
        id,
        contract: MEMES_CONTRACT
      },
      opts
    );
    return result.at(0)?.thumbnail ?? null;
  }

  public async insertProfileArchiveRecord(
    param: Omit<
      IdentityEntity,
      | 'cic'
      | 'rep'
      | 'tdh'
      | 'level_raw'
      | 'consolidation_key'
      | 'xtdh'
      | 'produced_xtdh'
      | 'granted_xtdh'
      | 'xtdh_rate'
      | 'basetdh_rate'
    >,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${PROFILES_ARCHIVE_TABLE}
       (handle,
        normalised_handle,
        primary_wallet,
        created_at,
        created_by_wallet,
        banner_1,
        banner_2,
        website,
        classification,
        updated_at,
        updated_by_wallet,
        external_id,
        sub_classification,
        pfp_url
       )
       values (:handle,
               :normalisedHandle,
               :primaryWallet,
               :createdAt,
               :createdByWallet,
               :banner1,
               :banner2,
               :website,
               :classification,
               :updatedAt,
               :updatedByWallet,
               :externalId,
               :subClassification,
               :pfp_url)`,
      {
        handle: param.handle,
        normalisedHandle: param.normalised_handle,
        primaryWallet: param.primary_address,
        createdAt: new Date(),
        createdByWallet: param.primary_address,
        updatedAt: new Date(),
        updatedByWallet: param.primary_address,
        banner1: param.banner1 ?? null,
        banner2: param.banner2 ?? null,
        website: null,
        classification: param.classification,
        externalId: param.profile_id,
        subClassification: param.sub_classification ?? null,
        pfp_url: param.pfp ?? null
      },
      { wrappedConnection: connection }
    );
  }

  async getHandlesByPrimaryWallets(
    addresses: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    if (!addresses.length) {
      return [];
    }
    const result = await this.db.execute(
      `select handle from ${IDENTITIES_TABLE} where primary_address in (:addresses)`,
      { addresses },
      { wrappedConnection: connection }
    );
    return result.map((it) => it.handle);
  }

  async getConsolidationKeyFromTdhConsolidations(
    wallet: string
  ): Promise<string | null> {
    return this.db
      .oneOrNull<{ consolidation_key: string }>(
        `
      SELECT consolidation_key FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} where consolidation_key like :wallet
      `,
        { wallet: `%${wallet.toLowerCase()}%` }
      )
      .then((it) => it?.consolidation_key ?? null);
  }

  async updatePrimaryAddress(
    param: {
      profileId: string;
      primaryAddress: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await inSequence([
      () =>
        this.db.execute(
          `update ${PROFILES_TABLE} set primary_wallet = :primaryAddress where external_id = :profileId`,
          param,
          { wrappedConnection: connection }
        ),
      () =>
        this.db.execute(
          `update ${IDENTITIES_TABLE} set primary_address = :primaryAddress where profile_id = :profileId`,
          param,
          { wrappedConnection: connection }
        )
    ]);
  }

  async updateWalletsEnsName(
    param: { wallet: string; ensName: string | null },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${ENS_TABLE} (display, wallet, created_at) values (:ensName, :wallet, current_time) on duplicate key update display = :ensName`,
      param,
      { wrappedConnection: connection }
    );
  }

  async searchCommunityMembersWhereEnsLike({
    limit,
    onlyProfileOwners,
    ensCandidate,
    sortByLevel = false
  }: {
    limit: number;
    onlyProfileOwners: boolean;
    ensCandidate: string;
    sortByLevel?: boolean;
  }): Promise<(IdentityEntity & { ens: string })[]> {
    if (ensCandidate.endsWith('eth') && ensCandidate.length <= 6) {
      return [];
    }
    {
      const orderBy = sortByLevel
        ? `
          i.level_raw desc,
          lower(e.display) asc,
          i.profile_id asc
        `
        : 'i.tdh desc';
      const sql = `
      select i.*,
             e.display as ens
      from ${IDENTITIES_TABLE} i
               join ${ADDRESS_CONSOLIDATION_KEY} a on i.consolidation_key = a.consolidation_key
               left join ${ENS_TABLE} e on a.address = lower(e.wallet)
      where e.display like concat('%', :ensCandidate ,'%') 
      ${onlyProfileOwners ? ' and i.profile_id is not null ' : ''}
      order by ${orderBy}
      limit :limit
    `;
      return this.db.execute(sql, { ensCandidate: ensCandidate, limit });
    }
  }

  async searchCommunityMembersWhereHandleLike({
    limit,
    handle,
    sortByLevel = false
  }: {
    limit: number;
    handle: string;
    sortByLevel?: boolean;
  }): Promise<(IdentityEntity & { ens: string })[]> {
    const orderBy = sortByLevel
      ? `
        case
          when i.normalised_handle not like 'id-0x%'
            and i.normalised_handle = lower(:handle) then 300
          when i.normalised_handle not like 'id-0x%'
            and i.normalised_handle like concat(lower(:handle), '%') then 200
          when i.normalised_handle not like 'id-0x%' then 100
          when lower(e.display) like concat('%', lower(:handle), '%') then 50
          else 0
        end desc,
        i.level_raw desc,
        i.normalised_handle asc,
        i.profile_id asc
      `
      : 'i.tdh desc';
    const sql = `
      select
          i.*,
          e.display as ens
      from ${IDENTITIES_TABLE} i
           left join ${ENS_TABLE} e on lower(e.wallet) = i.primary_address
      where i.normalised_handle like concat('%', lower(:handle), '%')
      order by ${orderBy}
      limit :limit
    `;
    return this.db.execute(sql, { handle, limit });
  }

  public async getIdsByHandles(
    handles: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, string>> {
    if (!handles.length) {
      return {};
    }
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute<{
        profile_id: string;
        handle: string;
      }>(
        `select profile_id, handle from ${IDENTITIES_TABLE} where normalised_handle in (:handles)`,
        { handles: handles.map((it) => it.toLowerCase()) },
        opts
      )
      .then((result) =>
        result.reduce(
          (acc, it) => {
            acc[it.handle] = it.profile_id;
            return acc;
          },
          {} as Record<string, string>
        )
      );
  }

  async getProfileTdh(profileId: string): Promise<number> {
    return this.db
      .oneOrNull<{ tdh: number }>(
        `
        select tdh from ${IDENTITIES_TABLE} where profile_id = :profileId`,
        { profileId }
      )
      .then((result) => result?.tdh ?? 0);
  }

  async getTdhAndXTdhCombinedAndFloored(profileId: string): Promise<number> {
    return this.db
      .oneOrNull<{ res: number }>(
        `
        select floor(tdh + xtdh) as res from ${IDENTITIES_TABLE} where profile_id = :profileId`,
        { profileId }
      )
      .then((result) => result?.res ?? 0);
  }

  async getProfileHandlesByIds(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    ctx.timer?.start(`${this.constructor.name}->getProfileHandlesByIds`);
    const distinctProfileIds = collections.distinct(profileIds);
    if (!distinctProfileIds.length) {
      return {};
    }
    const result = await this.db
      .execute<{ profile_id: string; handle: string }>(
        `select profile_id, handle from ${IDENTITIES_TABLE} where profile_id in (:profileIds)`,
        {
          profileIds: distinctProfileIds
        },
        { wrappedConnection: ctx.connection }
      )
      .then((result) =>
        result.reduce(
          (
            acc: Record<string, string>,
            it: { profile_id: string; handle: string }
          ) => {
            acc[it.profile_id] = it.handle;
            return acc;
          },
          {}
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getProfileHandlesByIds`);
    return result;
  }

  /**
   * The main stage's drops of one type by these profiles: legacy typed
   * drops, native entries and accepted collaborations. The statement inlines
   * the profile list once per source, so the list is chunked to keep each
   * statement under the RDS Proxy pinning size. Every row belongs to one
   * listed profile, so the chunks' rows together are exactly the full query's.
   */
  private async findMainStageDropRows(
    profileIds: string[],
    dropType: DropType.PARTICIPATORY | DropType.WINNER,
    ctx: RequestContext
  ): Promise<{ profile_id: string; drop_id: string }[]> {
    const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
    const status = dropType === DropType.WINNER ? 'WINNER' : 'ACTIVE';
    // Decided in the caller's scope, before the facade is switched off.
    const typedDrops = mainStageTypedDropsSql(
      dropType,
      isLegacyCompetitionGetFacadeScope()
    );
    const sql = `
      ${typedDrops}
      union select submitter_id as profile_id, drop_id from (${nativeMainStageEntriesSource(status)}) native_entry
      where submitter_id in (:profileIds)
      union select invitation.profile_id, invitation.drop_id
      from ${MEME_COLLABORATION_INVITATIONS_TABLE} invitation
      join (${nativeMainStageEntriesSource(status)}) collaboration_entry on collaboration_entry.drop_id=invitation.drop_id
      where invitation.profile_id in (:profileIds) and invitation.status='ACCEPTED'
      `;
    const listCopies = sql.split(':profileIds').length - 1;
    return withoutLegacyCompetitionGetFacade(() =>
      querySqlInListChunks(
        profileIds,
        (chunk) =>
          this.db.execute<{ profile_id: string; drop_id: string }>(
            sql,
            { profileIds: chunk, mainStageWaveId },
            { wrappedConnection: ctx.connection }
          ),
        {
          maxBytes: Math.floor(SQL_IN_LIST_CHUNK_BYTES / listCopies),
          // One caller-owned connection runs one statement at a time.
          sequential: !!ctx.connection
        }
      )
    );
  }

  async getActiveMainStageDropIds(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, string[]>> {
    if (!profileIds.length) {
      return {};
    }
    const results = await this.findMainStageDropRows(
      profileIds,
      DropType.PARTICIPATORY,
      ctx
    );
    const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
      results.map((row) => row.drop_id),
      ctx
    );
    return groupDropIdsByProfile(
      results.filter((row) => !hiddenDropIds.has(row.drop_id))
    );
  }

  async getMainStageWinnerDropIds(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, string[]>> {
    if (!profileIds.length) {
      return {};
    }
    return groupDropIdsByProfile(
      await this.findMainStageDropRows(profileIds, DropType.WINNER, ctx)
    );
  }

  async getArtistOfPrevoteCards(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number[]>> {
    if (!profileIds.length) {
      return {};
    }
    const results = await this.db.execute<{
      profile_id: string;
      card_no: number;
    }>(
      `
      select profile_id, card_no
      from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}
      where profile_id in (:profileIds)
      order by card_no asc
      `,
      { profileIds },
      { wrappedConnection: ctx.connection }
    );
    return results.reduce(
      (acc, it) => {
        if (!acc[it.profile_id]) {
          acc[it.profile_id] = [];
        }
        acc[it.profile_id].push(it.card_no);
        return acc;
      },
      {} as Record<string, number[]>
    );
  }

  async getProducedXTdhRate(id: string, ctx: RequestContext): Promise<number> {
    const row = await this.db.oneOrNull<{ basetdh_rate: number }>(
      `
    select basetdh_rate from identities where profile_id = :id
    `,
      { id },
      { wrappedConnection: ctx.connection }
    );

    return (row?.basetdh_rate ?? 0) * X_TDH_COEFFICIENT;
  }

  async migrateBoosterIdsInBoosts(
    param: { previous_id: string; new_id: string | undefined },
    ctx: RequestContext
  ) {
    if (param.new_id) {
      await this.db.execute(
        `INSERT INTO ${DROP_BOOSTS_TABLE} (drop_id, booster_id, boosted_at, wave_id)
       SELECT drop_id, :new_id, boosted_at, wave_id
       FROM ${DROP_BOOSTS_TABLE}
       WHERE booster_id = :previous_id
       ON DUPLICATE KEY UPDATE booster_id = VALUES(booster_id)`,
        param,
        { wrappedConnection: ctx.connection }
      );
    }

    await this.db.execute(
      `DELETE FROM ${DROP_BOOSTS_TABLE}
     WHERE booster_id = :previous_id`,
      param,
      { wrappedConnection: ctx.connection }
    );
  }

  async getWaveCreatorProfileIds(
    profileIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Set<string>> {
    if (!profileIds.length) {
      return new Set();
    }
    const results = await this.db.execute<{ created_by: string }>(
      `SELECT DISTINCT created_by FROM ${WAVES_TABLE} WHERE created_by IN (:profileIds) AND is_direct_message = false`,
      { profileIds },
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Set(results.map((it) => it.created_by));
  }
}

export const identitiesDb = new IdentitiesDb(dbSupplier);
