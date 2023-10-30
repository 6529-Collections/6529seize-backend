import { Profile } from './entities/IProfile';
import * as tdh_consolidation from './tdh_consolidation';
import * as ens from './ens';
import { sqlExecutor } from './sql-executor';
import { PROFILES_TABLE, WALLET_REGEX } from './constants';
import { BadRequestException } from './exceptions';
import * as tdhs from './tdh';
import * as nfts from './nfts';
import * as path from 'path';
import { scalePfpAndPersistToS3 } from './api-serverless/src/users/s3';
import { Wallet } from './entities/IWallet';

export interface CreateOrUpdateProfileCommand {
  handle: string;
  primary_wallet: string;
  banner_1?: string;
  banner_2?: string;
  website?: string;
  creator_or_updater_wallet: string;
}

export interface ProfileAndConsolidations {
  readonly profile: Profile | null;
  readonly consolidation: {
    wallets: { wallet: Wallet; tdh: number }[];
    tdh: number;
  };
}

async function getProfileByEnsName(query: string) {
  const wallet = await ens.reverseResolveEnsName(query);
  if (!wallet) {
    return null;
  }
  const { consolidatedWallets, tdh, blockNo } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(wallet);
  if (consolidatedWallets.length === 0) {
    return null;
  }
  const profile = await getWalletsNewestProfile(wallet);
  const walletTdhs = await tdhs.getWalletsTdhs({
    wallets: consolidatedWallets,
    blockNo
  });
  const wallets = await ens.getPrediscoveredEnsNames(consolidatedWallets);
  return {
    profile: profile ?? null,
    consolidation: {
      wallets: wallets.map((w) => ({
        wallet: w,
        tdh: walletTdhs[w.address]
      })),
      tdh
    }
  };
}

async function getProfileByWallet(query: string) {
  const { consolidatedWallets, tdh, blockNo } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(query);
  if (consolidatedWallets.length === 0) {
    return null;
  }
  const profile = await getWalletsNewestProfile(query);
  const walletTdhs = await tdhs.getWalletsTdhs({
    wallets: consolidatedWallets,
    blockNo
  });
  const wallets = await ens.getPrediscoveredEnsNames(consolidatedWallets);
  return {
    profile: profile ?? null,
    consolidation: {
      wallets: wallets.map((w) => ({
        wallet: w,
        tdh: walletTdhs[w.address]
      })),
      tdh
    }
  };
}

export async function getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
  handleOrEnsOrWalletAddress: string
): Promise<ProfileAndConsolidations | null> {
  const query = handleOrEnsOrWalletAddress.toLowerCase();
  if (query.endsWith('.eth')) {
    return await getProfileByEnsName(query);
  } else if (query.match(WALLET_REGEX)) {
    return await getProfileByWallet(query);
  } else {
    const profile = await getProfileByHandle(query);
    if (!profile) {
      return null;
    }
    const { consolidatedWallets, tdh, blockNo } =
      await tdh_consolidation.getWalletTdhAndConsolidatedWallets(
        profile.primary_wallet.toLowerCase()
      );
    const walletTdhs = await tdhs.getWalletsTdhs({
      wallets: consolidatedWallets,
      blockNo
    });
    const wallets = await ens.getPrediscoveredEnsNames(consolidatedWallets);
    return {
      profile: profile ?? null,
      consolidation: {
        wallets: wallets.map((w) => ({
          wallet: w,
          tdh: walletTdhs[w.address]
        })),
        tdh
      }
    };
  }
}

async function getProfileByHandle(handle: string): Promise<Profile> {
  const result = await sqlExecutor.execute(
    `select * from ${PROFILES_TABLE} where normalised_handle = :handle`,
    { handle: handle.toLowerCase() }
  );
  return result.at(0);
}

async function getWalletsNewestProfile(
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

export async function getProfilesByAnyWallets(
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
  banner_1,
  banner_2,
  website,
  creator_or_updater_wallet
}: CreateOrUpdateProfileCommand): Promise<ProfileAndConsolidations> {
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
        banner_1,
        banner_2,
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
        banner_1,
        banner_2,
        website,
        creator_or_updater_wallet
      }
    });
  }
  const updatedProfile =
    await getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(handle);
  return updatedProfile!;
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
         banner_1      = :banner1,
         banner_2      = :banner2,
         website           = :website
     where normalised_handle = :oldHandle`,
    {
      oldHandle,
      handle: command.handle,
      normalisedHandle: command.handle.toLowerCase(),
      primaryWallet: command.primary_wallet.toLowerCase(),
      updatedByWallet: command.creator_or_updater_wallet.toLowerCase(),
      banner1: command.banner_1 ?? null,
      banner2: command.banner_2 ?? null,
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
      banner_1,
      banner_2,
      website)
     values (:handle,
             :normalisedHandle,
             :primaryWallet,
             current_time,
             :createdByWallet,
             :banner1,
             :banner2,
             :website)`,
    {
      handle: command.handle,
      normalisedHandle: command.handle.toLowerCase(),
      primaryWallet: command.primary_wallet.toLowerCase(),
      createdByWallet: command.creator_or_updater_wallet.toLowerCase(),
      banner1: command.banner_1 ?? null,
      banner2: command.banner_2 ?? null,
      website: command.website ?? null
    }
  );
}

export async function getProfileHandlesByPrimaryWallets(
  wallets: string[]
): Promise<Record<string, string>> {
  if (!wallets.length) {
    return {};
  }
  const profiles = await getProfilesByWallets(wallets);
  return wallets.reduce((result, wallet) => {
    const handle = profiles.find(
      (profile) => profile.primary_wallet.toLowerCase() === wallet.toLowerCase()
    )?.handle;
    if (handle) {
      result[wallet.toLowerCase()] = handle;
    }
    return result;
  }, {} as Record<string, string>);
}

async function getOrCreatePfpFileUri({
  meme,
  file
}: {
  file?: Express.Multer.File;
  meme?: number;
}): Promise<string> {
  if (meme) {
    return await nfts.getMemeThumbnailUriById(meme).then((uri) => {
      if (uri) {
        return uri;
      }
      throw new BadRequestException(`Meme ${meme} not found`);
    });
  } else if (file) {
    const extension = path.extname(file.originalname)?.toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
      throw new BadRequestException('Invalid file type');
    }
    return await scalePfpAndPersistToS3(file, extension);
  } else {
    throw new BadRequestException('No PFP provided');
  }
}

export async function updateProfilePfp({
  authenticatedWallet,
  handleOrWallet,
  memeOrFile
}: {
  authenticatedWallet: string;
  handleOrWallet: string;
  memeOrFile: { file?: Express.Multer.File; meme?: number };
}): Promise<{ pfp_url: string }> {
  const { meme, file } = memeOrFile;
  if (!meme && !file) {
    throw new BadRequestException('No PFP provided');
  }
  const profile = await getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
    handleOrWallet
  ).then((it) => {
    if (it?.profile) {
      if (
        it.consolidation.wallets.some(
          (it) => it.wallet.address === authenticatedWallet
        )
      ) {
        return it.profile;
      }
      throw new BadRequestException(`Not authorised to update profile`);
    }
    throw new BadRequestException(`Profile for ${handleOrWallet} not found`);
  });
  const thumbnailUri = await getOrCreatePfpFileUri({ meme, file });
  await sqlExecutor.execute(
    `update ${PROFILES_TABLE} set pfp_url = :pfp where normalised_handle = :handle`,
    {
      pfp: thumbnailUri,
      handle: profile.normalised_handle
    }
  );
  return { pfp_url: thumbnailUri };
}
