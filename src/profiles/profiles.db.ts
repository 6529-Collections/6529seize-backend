import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  ENS_TABLE,
  MEMES_CONTRACT,
  NFTS_TABLE,
  PROFILE_TDH_LOGS_TABLE,
  PROFILE_TDHS_TABLE,
  PROFILES_ARCHIVE_TABLE,
  PROFILES_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';
import { Wallet } from '../entities/IWallet';
import { Profile } from '../entities/IProfile';
import { DbPoolName } from '../db-query.options';
import { CreateOrUpdateProfileCommand } from './profile.types';
import { randomUUID } from 'crypto';
import { ProfileTdh } from '../entities/IProfileTDH';
import { distinct } from '../helpers';

export class ProfilesDb extends LazyDbAccessCompatibleService {
  public async getConsolidationInfoForWallet(wallet: string): Promise<
    {
      tdh: number;
      wallets: string[];
      blockNo: number;
      consolidation_key: string | null;
      consolidation_display: string | null;
    }[]
  > {
    return this.db
      .execute(
        `SELECT block, boosted_tdh as tdh, wallets, consolidation_key, consolidation_display FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE LOWER(consolidation_key) LIKE :wallet`,
        { wallet: `%${wallet.toLowerCase()}%` }
      )
      .then((result) =>
        result.map(
          (it: {
            tdh: number;
            wallets: string;
            block: number;
            consolidation_key: string | null;
            consolidation_display: string | null;
          }) => ({
            tdh: it.tdh,
            wallets: JSON.parse(it.wallets),
            blockNo: it.block,
            consolidation_key: it.consolidation_key,
            consolidation_display: it.consolidation_display
          })
        )
      );
  }

  public async getProfileIdsByWalletsNewestFirst(
    wallets: string[]
  ): Promise<string[]> {
    return this.db
      .execute(
        `select external_id from ${PROFILES_TABLE} where lower(primary_wallet) in (:wallets) order by created_at desc`,
        {
          wallets: wallets
        }
      )
      ?.then((result) =>
        result.map((it: { external_id: string }) => it.external_id)
      );
  }

  public async getPrimaryWalletByExternalId(
    external_id: string
  ): Promise<string | null> {
    return this.db
      .execute(
        `select primary_wallet from ${PROFILES_TABLE} where external_id = :externalId limit 1`,
        {
          externalId: external_id
        }
      )
      ?.then((result) => result.at(0)?.primary_wallet ?? null);
  }

  public async getPrediscoveredEnsNames(
    walletAddresses: string[]
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
      }
    );
    return walletAddresses.map((walletAddress) => ({
      address: walletAddress,
      ens: results.find((row) => row.address === walletAddress)?.ens
    }));
  }

  public async getProfilesByWallets(wallets: string[]): Promise<Profile[]> {
    if (wallets.length === 0) {
      return [];
    }
    return this.db
      .execute(
        `select * from ${PROFILES_TABLE} where primary_wallet in (:wallets)`,
        { wallets: wallets.map((w) => w.toLowerCase()) },
        { forcePool: DbPoolName.WRITE }
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

  public async getWalletsTdhs({
    wallets,
    blockNo
  }: {
    wallets: string[];
    blockNo: number;
  }): Promise<Record<string, number>> {
    const normalisedWallets = wallets.map((w) => w.toLowerCase());
    if (!normalisedWallets.length) {
      return {};
    }
    const result: { wallet: string; tdh: number }[] = await this.db.execute(
      `select wallet, boosted_tdh as tdh from ${WALLETS_TDH_TABLE} where block = :blockNo and lower(wallet) in (:wallets)`,
      {
        blockNo,
        wallets: normalisedWallets
      }
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
    const result = await this.db
      .execute(
        `select * from ${PROFILES_TABLE} where normalised_handle = :handle`,
        { handle: handle.toLowerCase() },
        { forcePool: DbPoolName.WRITE, wrappedConnection: connection }
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
      external_id)
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
             :externalId
             )`,
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
        externalId: param.external_id!
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
    connectionHolder: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${PROFILES_TABLE}
         set handle            = :handle,
             normalised_handle = :normalisedHandle,
             primary_wallet    = :primaryWallet,
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
        primaryWallet: command.primary_wallet.toLowerCase(),
        updatedByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification
      },
      { wrappedConnection: connectionHolder.connection }
    );
    const profile = await this.getProfileByHandle(
      command.handle,
      connectionHolder
    );
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connectionHolder);
    }
  }

  public async insertProfileRecord(
    {
      command
    }: {
      command: CreateOrUpdateProfileCommand;
    },
    connectionHolder: ConnectionWrapper<any>
  ): Promise<string> {
    const profileId = randomUUID();
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
      external_id)
     values (:handle,
             :normalisedHandle,
             :primaryWallet,
             current_time,
             :createdByWallet,
             :banner1,
             :banner2,
             :website,
             :classification,
             :externalId
             )`,
      {
        handle: command.handle,
        normalisedHandle: command.handle.toLowerCase(),
        primaryWallet: command.primary_wallet.toLowerCase(),
        createdByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification,
        externalId: profileId
      },
      { wrappedConnection: connectionHolder.connection }
    );
    const profile = await this.getProfileByHandle(
      command.handle,
      connectionHolder
    );
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connectionHolder);
    }
    return profileId;
  }

  public async getMemeThumbnailUriById(id: number): Promise<string | null> {
    const result = await this.db.execute(
      `select thumbnail from ${NFTS_TABLE} where id = :id and contract = :contract order by id asc limit 1`,
      {
        id,
        contract: MEMES_CONTRACT
      }
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
      { wrappedConnection: connectionHolder.connection }
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

  public async getAllPotentialProfileTdhs(
    blockNo: number,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<ProfileTdh[]> {
    const now = new Date();
    const blockDate = await this.getBlockDateByBlockNo(blockNo);
    return this.db
      .execute(
        `select 
        p.external_id as profile_id, 
        c.tdh as tdh,
        c.block as block,
        c.boosted_tdh as boosted_tdh from ${PROFILES_TABLE} p 
        left join ${CONSOLIDATED_WALLETS_TDH_TABLE} c on LOWER(c.consolidation_key) LIKE concat('%', LOWER(p.primary_wallet), '%')
        where c.block = :blockNo`,
        {
          blockNo
        },
        {
          wrappedConnection: connectionHolder
        }
      )
      .then((result) =>
        result.map(
          (it: {
            profile_id: string;
            tdh: number | null;
            boosted_tdh: number | null;
            block: number;
          }) => ({
            profile_id: it.profile_id,
            tdh: it.tdh ?? 0,
            boosted_tdh: it.boosted_tdh ?? 0,
            created_at: now,
            block: it.block,
            block_date: blockDate
          })
        )
      );
  }

  public async getMaxRecordedProfileTdhBlock(
    connectionHolder: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select max(block) as block from ${PROFILE_TDH_LOGS_TABLE}`,
        undefined,
        {
          wrappedConnection: connectionHolder
        }
      )
      .then((result) => result.at(0)?.block ?? 0);
  }

  async deleteProfileTdhLogsByBlock(
    block: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${PROFILE_TDH_LOGS_TABLE} where block = :block`,
      { block },
      { wrappedConnection: connectionHolder.connection }
    );
  }

  async getProfileTdh(profileId: string): Promise<number> {
    return this.db
      .execute(
        `select boosted_tdh from ${PROFILE_TDHS_TABLE} where profile_id = :profileId`,
        { profileId }
      )
      .then((result) => result.at(0)?.boosted_tdh ?? 0);
  }

  async updateProfileTdhs(
    newProfileTdhs: ProfileTdh[],
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(`delete from  ${PROFILE_TDHS_TABLE}`, {
      wrappedConnection: connectionHolder
    });
    for (const newProfileTdh of newProfileTdhs) {
      await this.db.execute(
        `insert into ${PROFILE_TDH_LOGS_TABLE} (profile_id, tdh, boosted_tdh, block, created_at, block_date) values (:profileId, :tdh, :boostedTdh, :block, :createdAt, :blockDate)`,
        {
          profileId: newProfileTdh.profile_id,
          tdh: newProfileTdh.tdh,
          boostedTdh: newProfileTdh.boosted_tdh,
          block: newProfileTdh.block,
          createdAt: newProfileTdh.created_at,
          blockDate: newProfileTdh.block_date
        },
        {
          wrappedConnection: connectionHolder
        }
      );
      await this.db.execute(
        `insert into ${PROFILE_TDHS_TABLE} (profile_id, tdh, boosted_tdh, created_at, block, block_date) values (:profileId, :tdh, :boostedTdh, :createdAt, :block, :blockDate)`,
        {
          profileId: newProfileTdh.profile_id,
          tdh: newProfileTdh.tdh,
          boostedTdh: newProfileTdh.boosted_tdh,
          createdAt: newProfileTdh.created_at,
          block: newProfileTdh.block,
          blockDate: newProfileTdh.block_date
        }
      );
    }
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

  private async getBlockDateByBlockNo(blockNo: number): Promise<Date> {
    const blockDateStr = await this.db
      .execute(
        `select created_at from ${TDH_BLOCKS_TABLE} where block_number = :blockNo`,
        { blockNo }
      )
      .then((result) => result.at(0)?.created_at);
    if (!blockDateStr) {
      throw new Error(`Block date not found for block ${blockNo}`);
    }
    return new Date(blockDateStr);
  }
}

export const profilesDb = new ProfilesDb(dbSupplier);
