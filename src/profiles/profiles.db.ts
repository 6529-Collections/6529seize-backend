import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  ENS_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  NFTS_TABLE,
  PROFILES_ARCHIVE_TABLE,
  PROFILES_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';
import { Wallet } from '../entities/IWallet';
import { Profile } from '../entities/IProfile';
import { CreateOrUpdateProfileCommand } from './profile.types';
import { randomUUID } from 'crypto';
import { distinct } from '../helpers';
import { getLevelFromScore } from './profile-level';

export class ProfilesDb extends LazyDbAccessCompatibleService {
  public async getConsolidationInfoForWallet(
    wallet: string,
    connection?: ConnectionWrapper<any>
  ): Promise<
    {
      tdh: number;
      wallets: string[];
      blockNo: number;
      consolidation_key: string | null;
      consolidation_display: string | null;
      block_date: Date | null;
      raw_tdh: number;
      balance: number;
    }[]
  > {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute(
        `
        SELECT t.block,
               t.balance,
               t.boosted_tdh as tdh,
               t.tdh         as raw_tdh,
               b.created_at  as block_date,
               t.wallets,
               t.consolidation_key,
               t.consolidation_display,
               t.block
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} t
                 join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = t.consolidation_key
                 LEFT JOIN ${TDH_BLOCKS_TABLE} b on t.block = b.block_number
        WHERE a.address = :wallet
        `,
        { wallet: wallet.toLowerCase() },
        opts
      )
      .then((result) =>
        result.map(
          (it: {
            tdh: number;
            wallets: string;
            block: number;
            consolidation_key: string | null;
            consolidation_display: string | null;
            block_date: string | null;
            raw_tdh: number;
            balance: number;
          }) => ({
            tdh: it.tdh,
            wallets: JSON.parse(it.wallets),
            blockNo: it.block,
            consolidation_key: it.consolidation_key,
            consolidation_display: it.consolidation_display,
            block_date: it.block_date ? new Date(it.block_date) : null,
            raw_tdh: it.raw_tdh,
            balance: it.balance
          })
        )
      );
  }

  public async getPrediscoveredEnsNames(
    walletAddresses: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Wallet[]> {
    if (!walletAddresses.length) {
      return [];
    }
    const opts = connection ? { wrappedConnection: connection } : undefined;
    const results: Wallet[] = await this.db.execute(
      `SELECT wallet as address, display as ens FROM ${ENS_TABLE} WHERE LOWER(wallet) IN (:walletAddresses)`,
      {
        walletAddresses: walletAddresses.map((walletAddress) =>
          walletAddress.toLowerCase()
        )
      },
      opts
    );
    return walletAddresses.map((walletAddress) => ({
      address: walletAddress,
      ens: results.find((row) => row.address.toLowerCase() === walletAddress)
        ?.ens
    }));
  }

  public async getProfilesByWallets(
    wallets: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Profile[]> {
    if (wallets.length === 0) {
      return [];
    }
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute(
        `select * from ${PROFILES_TABLE} where primary_wallet in (:wallets)`,
        { wallets: wallets.map((w) => w.toLowerCase()) },
        opts
      )
      .then((result) =>
        result.map((profile: Profile) => {
          profile.created_at = new Date(profile.created_at);
          profile.updated_at = profile.updated_at
            ? new Date(profile.updated_at)
            : null;
          return profile;
        })
      );
  }

  public async getWalletsTdhs(
    {
      wallets,
      blockNo
    }: {
      wallets: string[];
      blockNo: number;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    const normalisedWallets = wallets.map((w) => w.toLowerCase());
    if (!normalisedWallets.length) {
      return {};
    }
    const opts = connection ? { wrappedConnection: connection } : undefined;
    const result: { wallet: string; tdh: number }[] = await this.db.execute(
      `select lower(wallet) as wallet, boosted_tdh as tdh from ${WALLETS_TDH_TABLE} where block = :blockNo and lower(wallet) in (:wallets)`,
      {
        blockNo,
        wallets: normalisedWallets
      },
      opts
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

  public async getProfileByHandle(
    handle: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Profile | null> {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    const result = await this.db
      .execute(
        `select * from ${PROFILES_TABLE} where normalised_handle = :handle`,
        { handle: handle.toLowerCase() },
        opts
      )
      .then((result) =>
        result.map((profile: Profile) => {
          profile.created_at = new Date(profile.created_at);
          profile.updated_at = profile.updated_at
            ? new Date(profile.updated_at)
            : null;
          return profile;
        })
      );
    return result.at(0) ?? null;
  }

  private async insertProfileArchiveRecord(
    param: Profile,
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
        sub_classification)
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
               :subClassification)`,
      {
        handle: param.handle,
        normalisedHandle: param.normalised_handle,
        primaryWallet: param.primary_wallet,
        createdAt: new Date(param.created_at),
        createdByWallet: param.created_by_wallet,
        updatedAt: param.updated_at ? new Date(param.updated_at) : null,
        updatedByWallet: param.updated_by_wallet,
        banner1: param.banner_1 ?? null,
        banner2: param.banner_2 ?? null,
        website: param.website ?? null,
        classification: param.classification,
        externalId: param.external_id,
        subClassification: param.sub_classification ?? null
      },
      { wrappedConnection: connection?.connection }
    );
  }

  public async updateProfileRecord(
    {
      command,
      oldHandle
    }: {
      command: CreateOrUpdateProfileCommand;
      oldHandle: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${PROFILES_TABLE}
       set handle            = :handle,
           normalised_handle = :normalisedHandle,
           updated_at        = current_time,
           updated_by_wallet = :updatedByWallet,
           banner_1          = :banner1,
           banner_2          = :banner2,
           website           = :website,
           classification    = :classification
       where normalised_handle = :oldHandle`,
      {
        oldHandle,
        handle: command.handle,
        normalisedHandle: command.handle.toLowerCase(),
        updatedByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification
      },
      { wrappedConnection: connection }
    );
    const profile = await this.getProfileByHandle(command.handle, connection);
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connection);
    }
  }

  public async insertProfileRecord(
    {
      command
    }: {
      command: CreateOrUpdateProfileCommand;
    },
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    const profileId = randomUUID();
    const wallet = command.creator_or_updater_wallet.toLowerCase();
    await this.db.execute(
      `insert into ${PROFILES_TABLE}
       (handle,
        normalised_handle,
        primary_wallet,
        created_at,
        created_by_wallet,
        banner_1,
        banner_2,
        website,
        classification,
        external_id,
        sub_classification)
       values (:handle,
               :normalisedHandle,
               :primaryWallet,
               current_time,
               :createdByWallet,
               :banner1,
               :banner2,
               :website,
               :classification,
               :externalId,
               :subClassification)`,
      {
        handle: command.handle,
        normalisedHandle: command.handle.toLowerCase(),
        primaryWallet: wallet,
        createdByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification,
        externalId: profileId,
        subClassification: command.sub_classification
      },
      { wrappedConnection: connection }
    );
    const profile = await this.getProfileByHandle(command.handle, connection);
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connection);
    }
    return profileId;
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

  public async updateProfilePfpUri(
    thumbnailUri: string,
    profile: Profile,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${PROFILES_TABLE}
       set pfp_url = :pfp
       where normalised_handle = :handle`,
      {
        pfp: thumbnailUri,
        handle: profile.normalised_handle
      },
      { wrappedConnection: connectionHolder }
    );
    await this.db.execute(
      `update ${IDENTITIES_TABLE}
       set pfp = :pfp
       where normalised_handle = :handle`,
      {
        pfp: thumbnailUri,
        handle: profile.normalised_handle
      },
      { wrappedConnection: connectionHolder }
    );
    await this.getProfileByHandle(
      profile.handle,
      connectionHolder.connection
    ).then(async (it) => {
      if (it) {
        await this.insertProfileArchiveRecord(
          profile,
          connectionHolder.connection
        );
      }
    });
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
    profileIds: string[]
  ): Promise<Record<string, string>> {
    const distinctProfileIds = distinct(profileIds);
    if (!distinctProfileIds.length) {
      return {};
    }
    return this.db
      .execute(
        `select external_id, handle from ${PROFILES_TABLE} where external_id in (:profileIds)`,
        {
          profileIds: distinctProfileIds
        }
      )
      .then((result) =>
        result.reduce(
          (
            acc: Record<string, string>,
            it: { external_id: string; handle: string }
          ) => {
            acc[it.external_id] = it.handle;
            return acc;
          },
          {}
        )
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
  }): Promise<(Profile & { tdh: number; display: string; wallet: string })[]> {
    if (ensCandidate.endsWith('eth') && ensCandidate.length <= 6) {
      return [];
    }
    {
      const sql = `
      select p.*,
             ifnull(i.tdh, 0) as tdh,
             coalesce(t.consolidation_display, e.display, i.primary_address) as display,
             e.wallet as wallet
      from ${ENS_TABLE} e
               left join ${ADDRESS_CONSOLIDATION_KEY} c on c.address = lower(e.wallet)
               left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = c.consolidation_key
               left join ${IDENTITIES_TABLE} i on i.consolidation_key = c.consolidation_key
               ${
                 onlyProfileOwners ? '' : 'left'
               } join ${PROFILES_TABLE} p on p.external_id = i.profile_id
      where e.display like concat('%', :ensCandidate ,'%')
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
  }): Promise<(Profile & { tdh: number; display: string; wallet: string })[]> {
    const sql = `
      select
          p.*,
          ifnull(i.tdh, 0) as tdh,
          coalesce(t.consolidation_display, e.display, i.primary_address) as display,
          e.wallet as wallet
      from ${PROFILES_TABLE} p
               join ${IDENTITIES_TABLE} i on i.profile_id = p.external_id
               left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = c.consolidation_key
               left join ${ENS_TABLE} e on lower(e.wallet) = i.primary_address
      where p.normalised_handle like concat('%', lower(:handle), '%')
      order by i.tdh desc
      limit :limit
    `;
    return this.db.execute(sql, { handle, limit });
  }

  async deleteProfile(
    { id }: { id: string },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${PROFILES_TABLE} where external_id = :id`,
      { id },
      { wrappedConnection: connectionHolder }
    );
  }

  async updateWalletsEnsName(
    param: { wallet: string; ensName: string | null },
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${ENS_TABLE} (display, wallet, created_at) values (:ensName, :wallet, current_time) on duplicate key update display = :ensName`,
      param,
      { wrappedConnection: connection }
    );
  }

  async updatePrimaryAddress(param: {
    profileId: string;
    primaryAddress: string;
  }) {
    await this.db.execute(
      `update ${PROFILES_TABLE} set primary_wallet = :primaryAddress where external_id = :profileId`,
      param
    );
  }

  async getProfileMinsByIds(ids: string[]): Promise<ProfileOverview[]> {
    if (!ids.length) {
      return [];
    }
    return this.db
      .execute(
        `select profile_id as id, handle, pfp, cic, rep, tdh, banner1 as banner1_color, banner2 as banner2_color, level_raw as level from ${IDENTITIES_TABLE} where profile_id in (:ids)`,
        { ids }
      )
      .then((result) =>
        result.map((it: ProfileOverview) => ({
          ...it,
          level: getLevelFromScore(it.level),
          archived: false
        }))
      );
  }

  async getNewestVersionHandlesOfArchivedProfiles(
    profileIds: string[]
  ): Promise<
    {
      external_id: string;
      handle: string;
      banner1_color: string | null;
      banner2_color: string | null;
    }[]
  > {
    if (profileIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `with prof_ids_w_latest_versions as (select external_id, max(id) as id from ${PROFILES_ARCHIVE_TABLE} group by 1)
            select p.external_id as external_id, p.handle as handle, p.banner_1 as banner1_color, p.banner_2 as banner2_color
            from ${PROFILES_ARCHIVE_TABLE} p
                     join prof_ids_w_latest_versions l on p.id = l.id
            where l.external_id in (:profileIds)`,
      { profileIds }
    );
  }

  async getProfileById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Profile | null> {
    return this.db.oneOrNull<Profile>(
      `select * from ${PROFILES_TABLE} where external_id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export interface ProfileOverview {
  id: string;
  handle: string;
  pfp: string | null;
  cic: number;
  rep: number;
  tdh: number;
  level: number;
  banner1_color: string | null;
  banner2_color: string | null;
  archived: boolean;
}

export const profilesDb = new ProfilesDb(dbSupplier);
