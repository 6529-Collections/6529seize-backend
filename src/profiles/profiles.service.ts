import { profilesDb, ProfilesDb } from './profiles.db';
import { WALLET_REGEX } from '../constants';
import { getAlchemyInstance } from '../alchemy';
import { Alchemy } from 'alchemy-sdk';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from './profile.types';
import { tdh2Level } from './profile-level';
import { Profile } from '../entities/IProfile';
import * as tdh_consolidation from '../tdh_consolidation';
import * as tdhs from '../tdh';
import { BadRequestException } from '../exceptions';
import { distinct } from '../helpers';
import * as path from 'path';
import { scalePfpAndPersistToS3 } from '../api-serverless/src/users/s3';

export class ProfilesService {
  constructor(
    private readonly profilesDb: ProfilesDb,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  public async getProfileIdByWallet(wallet: string): Promise<string | null> {
    const { consolidatedWallets } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(wallet);

    return this.profilesDb
      .getProfileIdsByWalletsNewestFirst(consolidatedWallets)
      .then((result) => result[0] ?? null);
  }

  public async getPrimaryWalletByProfileId(
    profileId: string
  ): Promise<string | null> {
    return profilesDb.getPrimaryWalletByExternalId(profileId);
  }

  public async getProfileByEnsName(
    query: string
  ): Promise<ProfileAndConsolidations | null> {
    const wallet = await this.supplyAlchemy().core.resolveName(query);
    if (!wallet) {
      return null;
    }
    const { consolidatedWallets, tdh, blockNo } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(wallet);
    if (consolidatedWallets.length === 0) {
      return null;
    }
    const profile = await this.getWalletsNewestProfile(wallet);
    const walletTdhs = await this.profilesDb.getWalletsTdhs({
      wallets: consolidatedWallets,
      blockNo
    });
    const wallets = await this.profilesDb.getPrediscoveredEnsNames(
      consolidatedWallets
    );
    return {
      profile: profile ?? null,
      consolidation: {
        wallets: wallets.map((w) => ({
          wallet: w,
          tdh: walletTdhs[w.address]
        })),
        tdh
      },
      level: tdh2Level(tdh)
    };
  }

  public async getProfileByWallet(
    query: string
  ): Promise<ProfileAndConsolidations | null> {
    const { consolidatedWallets, tdh, blockNo } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(query);
    if (consolidatedWallets.length === 0) {
      return null;
    }
    const profile = await this.getWalletsNewestProfile(query);
    const walletTdhs = await this.profilesDb.getWalletsTdhs({
      wallets: consolidatedWallets,
      blockNo
    });
    const wallets = await this.profilesDb.getPrediscoveredEnsNames(
      consolidatedWallets
    );
    return {
      profile: profile ?? null,
      consolidation: {
        wallets: wallets.map((w) => ({
          wallet: w,
          tdh: walletTdhs[w.address]
        })),
        tdh
      },
      level: tdh2Level(tdh)
    };
  }

  public async getProfilesByWallets(wallets: string[]): Promise<Profile[]> {
    return this.profilesDb.getProfilesByWallets(wallets);
  }

  public async getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
    handleOrEnsOrWalletAddress: string
  ): Promise<ProfileAndConsolidations | null> {
    const query = handleOrEnsOrWalletAddress.toLowerCase();
    if (query.endsWith('.eth')) {
      return await this.getProfileByEnsName(query);
    } else if (WALLET_REGEX.exec(query)) {
      return await this.getProfileByWallet(query);
    } else {
      const profile = await this.profilesDb.getProfileByHandle(query);
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
      const wallets = await this.profilesDb.getPrediscoveredEnsNames(
        consolidatedWallets
      );
      return {
        profile: profile ?? null,
        consolidation: {
          wallets: wallets.map((w) => ({
            wallet: w,
            tdh: walletTdhs[w.address]
          })),
          tdh
        },
        level: tdh2Level(tdh)
      };
    }
  }

  public async createOrUpdateProfile({
    handle,
    primary_wallet,
    banner_1,
    banner_2,
    website,
    creator_or_updater_wallet,
    classification
  }: CreateOrUpdateProfileCommand): Promise<ProfileAndConsolidations> {
    const { consolidatedWallets: creatorOrUpdaterWalletConsolidatedWallets } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(
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

    const creatorOrUpdaterProfiles = await this.getProfilesByWallets(
      creatorOrUpdaterWalletConsolidatedWallets
    );
    if (
      !creatorOrUpdaterProfiles.find(
        (p) => p.normalised_handle === handle.toLowerCase()
      )
    ) {
      const preExistingProfile = await this.profilesDb.getProfileByHandle(
        handle
      );
      if (preExistingProfile) {
        throw new BadRequestException(`Handle ${handle} is already taken`);
      }
    }
    if (creatorOrUpdaterProfiles.length === 0) {
      await this.profilesDb.insertProfileRecord({
        command: {
          handle,
          primary_wallet,
          banner_1,
          banner_2,
          website,
          creator_or_updater_wallet,
          classification
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
            (p) =>
              p.primary_wallet.toLowerCase() === primary_wallet.toLowerCase()
          ) > 0;
      if (isNameTaken || isPrimaryWalletTaken) {
        throw new BadRequestException(
          `Handle ${handle} or primary wallet ${primary_wallet} is already taken`
        );
      }
      await this.profilesDb.updateProfileRecord({
        oldHandle: latestProfile!.normalised_handle,
        command: {
          handle,
          primary_wallet,
          banner_1,
          banner_2,
          website,
          creator_or_updater_wallet,
          classification
        }
      });
    }
    const updatedProfile =
      await this.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handle
      );
    return updatedProfile!;
  }

  public async enhanceDataWithHandlesAndLevel(
    data: { wallets?: string; wallet?: string; boostedTdh?: number }[]
  ) {
    const resultWallets: string[] = distinct(
      data
        .map((d: { wallets?: string; wallet?: string }) =>
          d.wallet ? [d.wallet] : d.wallets ? JSON.parse(d.wallets) : []
        )
        .flat()
    );
    const walletsToHandles = await this.getProfileHandlesByPrimaryWallets(
      resultWallets
    );

    return data.map(
      (d: { wallets?: string; wallet?: string; boosted_tdh?: number }) => {
        const parsedWallets = d.wallet
          ? [d.wallet]
          : d.wallets
          ? JSON.parse(d.wallets)
          : [];
        const resolvedWallet = parsedWallets.find(
          (w: string) => walletsToHandles[w.toLowerCase()]
        );
        (d as any).level = tdh2Level(d.boosted_tdh ?? 0);
        if (!resolvedWallet) {
          return d;
        }
        return {
          ...d,
          handle: walletsToHandles[resolvedWallet.toLowerCase()]
        };
      }
    );
  }

  public async updateProfilePfp({
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
    const profile =
      await this.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
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
        throw new BadRequestException(
          `Profile for ${handleOrWallet} not found`
        );
      });
    const thumbnailUri = await this.getOrCreatePfpFileUri({ meme, file });
    await profilesDb.updateProfilePfpUri(thumbnailUri, profile);
    return { pfp_url: thumbnailUri };
  }

  public async getProfileHandlesByPrimaryWallets(
    wallets: string[]
  ): Promise<Record<string, string>> {
    if (!wallets.length) {
      return {};
    }
    const profiles = await this.getProfilesByWallets(wallets);
    return wallets.reduce((result, wallet) => {
      const handle = profiles.find(
        (profile) =>
          profile.primary_wallet.toLowerCase() === wallet.toLowerCase()
      )?.handle;
      if (handle) {
        result[wallet.toLowerCase()] = handle;
      }
      return result;
    }, {} as Record<string, string>);
  }

  private async getWalletsNewestProfile(
    wallet: string
  ): Promise<Profile | undefined> {
    const { consolidatedWallets } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(wallet);
    const profiles = await this.getProfilesByWallets(consolidatedWallets);
    return profiles
      .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
      .at(0);
  }

  private async getWalletTdhBlockNoAndConsolidatedWallets(
    wallet: string
  ): Promise<{ tdh: number; consolidatedWallets: string[]; blockNo: number }> {
    const normalisedWallet = wallet.toLowerCase();
    if (!WALLET_REGEX.exec(normalisedWallet)) {
      return { tdh: 0, consolidatedWallets: [], blockNo: 0 };
    }
    return this.profilesDb
      .getConsolidationInfoForWallet(normalisedWallet)
      .then((resultRows) => {
        if (!resultRows.length) {
          return {
            tdh: 0,
            consolidatedWallets: [normalisedWallet],
            blockNo: 0
          };
        }
        const result = resultRows[0];
        if (!result.wallets.includes(normalisedWallet)) {
          result.wallets.push(normalisedWallet);
        }
        return {
          tdh: result.tdh,
          consolidatedWallets: result.wallets,
          blockNo: result.blockNo
        };
      });
  }

  private async getOrCreatePfpFileUri({
    meme,
    file
  }: {
    file?: Express.Multer.File;
    meme?: number;
  }): Promise<string> {
    if (meme) {
      return await this.profilesDb.getMemeThumbnailUriById(meme).then((uri) => {
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
}

export const profilesService = new ProfilesService(
  profilesDb,
  getAlchemyInstance
);
