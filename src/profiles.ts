import { Profile } from './entities/IProfile';
import * as tdh_consolidation from './tdh_consolidation';
import { sqlExecutor } from './sql-executor';
import { PROFILES_TABLE } from './constants';
import { BadRequestException } from './bad-request.exception';

export interface CreateOrUpdateProfileCommand {
  handle: string;
  primary_wallet: string;
  pfp_url?: string;
  banner_1_url?: string;
  banner_2_url?: string;
  website?: string;
  creator_or_updater_wallet: string;
}

export async function getProfileByHandle(handle: string): Promise<Profile> {
  const result = await sqlExecutor.execute(
    `select * from ${PROFILES_TABLE} where normalised_handle = :handle`,
    { handle: handle.toLowerCase() }
  );
  return result.at(0);
}

export async function getWalletsNewestProfile(
  wallet: string
): Promise<Profile | undefined> {
  const { consolidatedWallets } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(wallet);
  const profiles = await getProfilesByWallets(consolidatedWallets);
  return profiles
    .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
    .at(0);
}

export async function getProfilesByWallets(
  wallets: string[]
): Promise<Profile[]> {
  if (wallets.length === 0) {
    return [];
  }
  return sqlExecutor.execute(
    `select * from ${PROFILES_TABLE} where primary_wallet in (:wallets)`,
    { wallets: wallets.map((w) => w.toLowerCase()) }
  );
}

export async function createOrUpdateProfile({
  handle,
  primary_wallet,
  pfp_url,
  banner_1_url,
  banner_2_url,
  website,
  creator_or_updater_wallet
}: CreateOrUpdateProfileCommand): Promise<Profile> {
  const { consolidatedWallets: creatorOrUpdaterWalletConsolidatedWallets } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(
      creator_or_updater_wallet
    );
  const isPrimaryWalletValid = creatorOrUpdaterWalletConsolidatedWallets
    .map((it) => it.toLowerCase())
    .includes(primary_wallet.toLowerCase());
  if (!isPrimaryWalletValid) {
    throw new BadRequestException(
      `Primary wallet ${primary_wallet} is not in the same consolidation group as authenticated wallet ${creator_or_updater_wallet}`
    );
  }

  const creatorOrUpdaterProfiles = await getProfilesByWallets(
    creatorOrUpdaterWalletConsolidatedWallets
  );
  if (
    !creatorOrUpdaterProfiles.find(
      (p) => p.normalised_handle === handle.toLowerCase()
    )
  ) {
    const preExistingProfile = await getProfileByHandle(handle);
    if (preExistingProfile) {
      throw new BadRequestException(`Handle ${handle} is already taken`);
    }
  }
  if (creatorOrUpdaterProfiles.length === 0) {
    await insertProfileRecord({
      command: {
        handle,
        primary_wallet,
        pfp_url,
        banner_1_url,
        banner_2_url,
        website,
        creator_or_updater_wallet
      }
    });
  } else {
    const latestProfile = creatorOrUpdaterProfiles
      .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
      .at(0);
    const isNameTaken =
      creatorOrUpdaterProfiles
        .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
        .findIndex((p) => p.normalised_handle === handle.toLowerCase()) > 0;
    const isPrimaryWalletTaken =
      creatorOrUpdaterProfiles
        .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
        .findIndex(
          (p) => p.primary_wallet.toLowerCase() === primary_wallet.toLowerCase()
        ) > 0;
    if (isNameTaken || isPrimaryWalletTaken) {
      throw new BadRequestException(
        `Handle ${handle} or primary wallet ${primary_wallet} is already taken`
      );
    }
    await updateProfileRecord({
      oldHandle: latestProfile!.normalised_handle,
      command: {
        handle,
        primary_wallet,
        pfp_url,
        banner_1_url,
        banner_2_url,
        website,
        creator_or_updater_wallet
      }
    });
  }
  return getProfileByHandle(handle);
}

async function updateProfileRecord({
  command,
  oldHandle
}: {
  command: CreateOrUpdateProfileCommand;
  oldHandle: string;
}) {
  await sqlExecutor.execute(
    `update ${PROFILES_TABLE}
     set handle            = :handle,
         normalised_handle = :normalisedHandle,
         primary_wallet    = :primaryWallet,
         updated_at        = current_time,
         updated_by_wallet = :updatedByWallet,
         pfp_url           = :pfpUrl,
         banner_1_url      = :banner1Url,
         banner_2_url      = :banner2Url,
         website           = :website
     where normalised_handle = :oldHandle`,
    {
      oldHandle,
      handle: command.handle,
      normalisedHandle: command.handle.toLowerCase(),
      primaryWallet: command.primary_wallet.toLowerCase(),
      updatedByWallet: command.creator_or_updater_wallet.toLowerCase(),
      pfpUrl: command.pfp_url ?? null,
      banner1Url: command.banner_1_url ?? null,
      banner2Url: command.banner_2_url ?? null,
      website: command.website ?? null
    }
  );
}

async function insertProfileRecord({
  command
}: {
  command: CreateOrUpdateProfileCommand;
}) {
  await sqlExecutor.execute(
    `insert into ${PROFILES_TABLE}
     (handle,
      normalised_handle,
      primary_wallet,
      created_at,
      created_by_wallet,
      pfp_url,
      banner_1_url,
      banner_2_url,
      website)
     values (:handle,
             :normalisedHandle,
             :primaryWallet,
             current_time,
             :createdByWallet,
             :pfpUrl,
             :banner1Url,
             :banner2Url,
             :website)`,
    {
      handle: command.handle,
      normalisedHandle: command.handle.toLowerCase(),
      primaryWallet: command.primary_wallet.toLowerCase(),
      createdByWallet: command.creator_or_updater_wallet.toLowerCase(),
      pfpUrl: command.pfp_url ?? null,
      banner1Url: command.banner_1_url ?? null,
      banner2Url: command.banner_2_url ?? null,
      website: command.website ?? null
    }
  );
}
