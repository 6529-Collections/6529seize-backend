import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { IdentityEntity } from '../entities/IIdentity';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  ENS_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  NFTS_TABLE,
  PROFILES_ARCHIVE_TABLE,
  PROFILES_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';
import { Profile, ProfileClassification } from '../entities/IProfile';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { randomUUID } from 'crypto';
import { RequestContext } from '../request.context';
import { Timer } from '../time';
import { Wallet } from '../entities/IWallet';
import { collections } from '../collections';

const mysql = require('mysql');

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
    const identities = await this.db
      .execute<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE} identity where identity.consolidation_key in (
      select distinct i.consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses)
      )`,
        { addresses },
        { wrappedConnection: connection }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          level_raw: +it.level_raw,
          cic: +it.cic,
          rep: +it.rep,
          tdh: +it.tdh
        }))
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
                                         sub_classification)
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
                :sub_classification)
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
      classification: ProfileClassification;
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
    const identitiesSql = `insert into ${IDENTITIES_TABLE} (
                                         profile_id,
                                         consolidation_key,
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
                                         sub_classification)
        values ${identities
          .map(
            (identity) =>
              `(${mysql.escape(identity.profile_id!)}, ${mysql.escape(
                identity.consolidation_key
              )}, ${mysql.escape(identity.primary_address)}, ${mysql.escape(
                identity.handle
              )}, ${mysql.escape(identity.normalised_handle)}, ${mysql.escape(
                identity.tdh
              )}, 0, 0, ${mysql.escape(identity.level_raw)}, ${mysql.escape(
                identity.pfp
              )}, ${mysql.escape(identity.banner1)}, ${mysql.escape(
                identity.banner2
              )}, ${mysql.escape(identity.classification)}, ${mysql.escape(
                identity.sub_classification
              )})`
          )
          .join(',')}`;
    await this.db.execute(identitiesSql, undefined, {
      wrappedConnection: connection
    });
    const addressesSql = `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
        values ${identities
          .map((identity) =>
            identity.consolidation_key
              .split('-')
              .map((address) => ({
                address,
                consolidationKey: identity.consolidation_key
              }))
              .flat()
              .map(
                ({ address, consolidationKey }) =>
                  `(${mysql.escape(address)}, ${mysql.escape(
                    consolidationKey
                  )})`
              )
          )
          .flat()
          .join(',')}`;
    await this.db.execute(addressesSql, undefined, {
      wrappedConnection: connection
    });
  }

  async getIdentityByProfileId(
    id: string,
    connectionHolder?: ConnectionWrapper<any>
  ) {
    return await this.db
      .oneOrNull<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE} where profile_id = :id`,
        { id },
        { wrappedConnection: connectionHolder }
      )
      .then((it) => {
        if (!it) {
          return null;
        }
        return {
          ...it,
          level_raw: +it.level_raw,
          rep: +it.rep,
          cic: +it.cic,
          tdh: +it.tdh
        };
      });
  }

  async getIdentityByHandle(
    handle: string,
    ctx: RequestContext
  ): Promise<IdentityEntity | null> {
    return await this.db
      .oneOrNull<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE} where normalised_handle = :handle`,
        { handle: handle.toLowerCase() },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => {
        if (!it) {
          return null;
        }
        return {
          ...it,
          level_raw: +it.level_raw,
          rep: +it.rep,
          cic: +it.cic,
          tdh: +it.tdh
        };
      });
  }

  async syncProfileAddressesFromIdentitiesToProfiles(
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${PROFILES_TABLE} join ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.profile_id = ${PROFILES_TABLE}.external_id
                           set ${PROFILES_TABLE}.primary_wallet = ${IDENTITIES_TABLE}.primary_address
                           where ${PROFILES_TABLE}.primary_wallet != ${IDENTITIES_TABLE}.primary_address`,
      undefined,
      { wrappedConnection: connection }
    );
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
                               ${IDENTITIES_TABLE}.normalised_handle = ${PROFILES_TABLE}.classification,
                               ${IDENTITIES_TABLE}.classification = ${PROFILES_TABLE}.normalised_handle
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
    await Promise.all(
      repBulkUpdates.map((update) =>
        this.db.execute(
          `update ${IDENTITIES_TABLE} set rep = rep + :newRep, level_raw = level_raw + :newRep where profile_id = :profileId`,
          update,
          { wrappedConnection: ctx.connection }
        )
      )
    );
  }

  async searchIdentitiesWithDisplays(
    param: { limit: number; handle: string },
    base: {
      sql: string;
      params: Record<string, any>;
    } | null,
    ctx: RequestContext
  ): Promise<(IdentityEntity & { display: string | null })[]> {
    ctx.timer?.start(`${this.constructor.name}->searchIdentities`);
    if (base === null) {
      const results = await this.db.execute<
        IdentityEntity & { display: string | null }
      >(
        `
      select i.*, cwt.consolidation_display as display from ${IDENTITIES_TABLE} i
       left join ${CONSOLIDATED_WALLETS_TDH_TABLE} cwt on i.consolidation_key = cwt.consolidation_key
       where i.normalised_handle like :likeHandle
       order by locate(:handle, i.normalised_handle) asc
       limit :limit
    `,
        {
          limit: param.limit,
          likeHandle: `%${param.handle.toLowerCase()}%`,
          handle: param.handle.toLowerCase()
        },
        {
          wrappedConnection: ctx.connection
        }
      );
      ctx.timer?.stop(`${this.constructor.name}->searchIdentities`);
      return results;
    } else {
      const results = await this.db.execute<
        IdentityEntity & { display: string | null }
      >(
        `
      ${base.sql}
      select i.*, cwt.consolidation_display as display from ${IDENTITIES_TABLE} i
       join user_groups_view ug on i.profile_id = ug.profile_id
       left join ${CONSOLIDATED_WALLETS_TDH_TABLE} cwt on i.consolidation_key = cwt.consolidation_key
       where i.normalised_handle like :likeHandle
       order by locate(:handle, i.normalised_handle) asc
       limit :limit
    `,
        {
          ...base.params,
          limit: param.limit,
          likeHandle: `%${param.handle.toLowerCase()}%`,
          handle: param.handle.toLowerCase()
        },
        {
          wrappedConnection: ctx.connection
        }
      );
      ctx.timer?.stop(`${this.constructor.name}->searchIdentities`);
      return results;
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
    return this.db
      .oneOrNull<IdentityEntity>(
        `
    select i.* from ${IDENTITIES_TABLE} i
    join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
    where a.address = :wallet
    `,
        { wallet },
        { wrappedConnection: connection }
      )
      .then((it) => {
        if (!it) {
          return null;
        }
        return {
          ...it,
          level_raw: +it.level_raw,
          rep: +it.rep,
          cic: +it.cic,
          tdh: +it.tdh
        };
      });
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
    return this.db
      .execute<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE} where profile_id in (:ids)`,
        { ids },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((result) =>
        result.map((it) => ({
          ...it,
          level_raw: +it.level_raw,
          rep: +it.rep,
          cic: +it.cic,
          tdh: +it.tdh
        }))
      );
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
    }[]
  > {
    if (profileIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `with prof_ids_w_latest_versions as (select external_id, max(id) as id from ${PROFILES_ARCHIVE_TABLE} group by 1)
            select p.external_id as external_id, p.handle as handle, p.banner_1 as banner1, p.banner_2 as banner2, p.primary_wallet as primary_address
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
      'cic' | 'rep' | 'tdh' | 'level_raw' | 'consolidation_key'
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
    await Promise.all([
      this.db.execute(
        `update ${PROFILES_TABLE} set primary_wallet = :primaryAddress where external_id = :profileId`,
        param,
        { wrappedConnection: connection }
      ),
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
    ensCandidate
  }: {
    limit: number;
    onlyProfileOwners: boolean;
    ensCandidate: string;
  }): Promise<(IdentityEntity & { ens: string })[]> {
    if (ensCandidate.endsWith('eth') && ensCandidate.length <= 6) {
      return [];
    }
    {
      const sql = `
      select i.*,
             e.display as display
      from ${IDENTITIES_TABLE} i
               join ${ADDRESS_CONSOLIDATION_KEY} a on i.consolidation_key = a.consolidation_key
               left join ${ENS_TABLE} e on a.address = lower(e.wallet)
      where e.display like concat('%', :ensCandidate ,'%') 
      ${onlyProfileOwners ? ' and i.profile_id is not null ' : ''}
      order by i.tdh desc
      limit :limit
    `;
      return this.db.execute(sql, { ensCandidate: ensCandidate, limit });
    }
  }

  async searchCommunityMembersWhereHandleLike({
    limit,
    handle
  }: {
    limit: number;
    handle: string;
  }): Promise<(IdentityEntity & { ens: string })[]> {
    const sql = `
      select
          i.*,
          e.display as ens
      from ${IDENTITIES_TABLE} i
           left join ${ENS_TABLE} e on lower(e.wallet) = i.primary_address
      where i.normalised_handle like concat('%', lower(:handle), '%')
      order by i.tdh desc
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
}

export const identitiesDb = new IdentitiesDb(dbSupplier);
