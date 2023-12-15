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
import * as path from 'path';
import { scalePfpAndPersistToS3 } from '../api-serverless/src/users/s3';
import { ConnectionWrapper } from '../sql-executor';
import { Logger } from '../logging';
import { Time } from '../time';
import {
  NewProfileActivityLog,
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { ratingsService, RatingsService } from '../rates/ratings.service';
import { RateMatter } from '../entities/IRating';

export class ProfilesService {
  private readonly logger = Logger.get('PROFILES_SERVICE');

  constructor(
    private readonly profilesDb: ProfilesDb,
    private readonly ratingsService: RatingsService,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  public async getProfileByEnsName(
    query: string
  ): Promise<ProfileAndConsolidations | null> {
    const wallet = await this.supplyAlchemy().core.resolveName(query);
    if (!wallet) {
      return null;
    }
    const {
      consolidatedWallets,
      tdh,
      blockNo,
      consolidation_key,
      consolidation_display
    } = await this.getWalletTdhBlockNoAndConsolidatedWallets(wallet);
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
    const cic = await this.getCic(profile);
    return {
      profile: profile ?? null,
      consolidation: {
        consolidation_key,
        consolidation_display,
        wallets: wallets.map((w) => ({
          wallet: w,
          tdh: walletTdhs[w.address]
        })),
        tdh
      },
      level: tdh2Level(tdh),
      cic
    };
  }

  private async getCic(profile?: Profile) {
    const profileId = profile?.external_id;
    return profileId
      ? await this.ratingsService
          .getAggregatedRatingOnMatter({
            rater_profile_id: null,
            matter: RateMatter.CIC,
            matter_target_id: profileId,
            matter_category: RateMatter.CIC
          })
          .then((res) => ({
            cic_rating: res.rating,
            contributor_count: res.contributor_count
          }))
      : { cic_rating: 0, contributor_count: 0 };
  }

  public async getProfileByWallet(
    query: string
  ): Promise<ProfileAndConsolidations | null> {
    const {
      consolidatedWallets,
      tdh,
      blockNo,
      consolidation_key,
      consolidation_display
    } = await this.getWalletTdhBlockNoAndConsolidatedWallets(query);
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
    const cic = await this.getCic(profile);
    return {
      profile: profile ?? null,
      consolidation: {
        consolidation_display,
        consolidation_key,
        wallets: wallets.map((w) => ({
          wallet: w,
          tdh: walletTdhs[w.address]
        })),
        tdh
      },
      level: tdh2Level(tdh),
      cic
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
      const {
        consolidatedWallets,
        tdh,
        blockNo,
        consolidation_key,
        consolidation_display
      } = await tdh_consolidation.getWalletTdhAndConsolidatedWallets(
        profile.primary_wallet.toLowerCase()
      );
      const walletTdhs = await tdhs.getWalletsTdhs({
        wallets: consolidatedWallets,
        blockNo
      });
      const wallets = await this.profilesDb.getPrediscoveredEnsNames(
        consolidatedWallets
      );
      const cic = await this.getCic(profile);
      return {
        profile: profile ?? null,
        consolidation: {
          wallets: wallets.map((w) => ({
            wallet: w,
            tdh: walletTdhs[w.address]
          })),
          tdh,
          consolidation_key,
          consolidation_display
        },
        level: tdh2Level(tdh),
        cic
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
      await this.profilesDb.executeNativeQueriesInTransaction(
        async (connectionHolder) => {
          const profileId = await this.profilesDb.insertProfileRecord(
            {
              command: {
                handle,
                primary_wallet,
                banner_1,
                banner_2,
                website,
                creator_or_updater_wallet,
                classification
              }
            },
            connectionHolder
          );
          await this.createProfileEditLogs({
            profileId: profileId,
            profileBeforeChange: null,
            newHandle: handle,
            newPrimaryWallet: primary_wallet,
            newBanner1: banner_1,
            newBanner2: banner_2,
            authenticatedWallet: creator_or_updater_wallet,
            newClassification: classification,
            connectionHolder
          });
        }
      );
    } else {
      const latestProfile = creatorOrUpdaterProfiles
        .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
        .at(0)!;
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
      await this.profilesDb.executeNativeQueriesInTransaction(
        async (connectionHolder) => {
          await this.profilesDb.updateProfileRecord(
            {
              oldHandle: latestProfile.normalised_handle,
              command: {
                handle,
                primary_wallet,
                banner_1,
                banner_2,
                website,
                creator_or_updater_wallet,
                classification
              }
            },
            connectionHolder
          );
          await this.createProfileEditLogs({
            profileId: latestProfile.external_id,
            profileBeforeChange: latestProfile,
            newHandle: handle,
            newPrimaryWallet: primary_wallet,
            newBanner1: banner_1,
            newBanner2: banner_2,
            authenticatedWallet: creator_or_updater_wallet,
            newClassification: classification,
            connectionHolder
          });
        }
      );
    }
    const updatedProfile =
      await this.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handle
      );
    return updatedProfile!;
  }

  private async createProfileEditLogs({
    profileId,
    profileBeforeChange,
    newHandle,
    newPrimaryWallet,
    newClassification,
    newBanner1,
    newBanner2,
    authenticatedWallet,
    connectionHolder
  }: {
    profileId: string;
    profileBeforeChange: Profile | null;
    newHandle: string;
    newPrimaryWallet: string;
    newClassification: string;
    newBanner1?: string;
    newBanner2?: string;
    authenticatedWallet: string;
    connectionHolder: ConnectionWrapper<any>;
  }) {
    const logEvents: NewProfileActivityLog[] = [];
    if (profileBeforeChange?.normalised_handle !== newHandle.toLowerCase()) {
      logEvents.push({
        profile_id: profileId,
        target_id: null,
        type: ProfileActivityLogType.HANDLE_EDIT,
        contents: JSON.stringify({
          authenticated_wallet: authenticatedWallet,
          old_value: profileBeforeChange?.handle ?? null,
          new_value: newHandle
        })
      });
    }
    this.addEventToArrayIfChanged(
      profileBeforeChange?.primary_wallet ?? null,
      newPrimaryWallet ?? null,
      logEvents,
      profileId,
      ProfileActivityLogType.PRIMARY_WALLET_EDIT,
      authenticatedWallet
    );
    this.addEventToArrayIfChanged(
      profileBeforeChange?.classification ?? null,
      newClassification ?? null,
      logEvents,
      profileId,
      ProfileActivityLogType.CLASSIFICATION_EDIT,
      authenticatedWallet
    );
    this.addEventToArrayIfChanged(
      profileBeforeChange?.banner_1 ?? null,
      newBanner1 ?? null,
      logEvents,
      profileId,
      ProfileActivityLogType.BANNER_1_EDIT,
      authenticatedWallet
    );
    this.addEventToArrayIfChanged(
      profileBeforeChange?.banner_2 ?? null,
      newBanner2 ?? null,
      logEvents,
      profileId,
      ProfileActivityLogType.BANNER_2_EDIT,
      authenticatedWallet
    );
    await this.profileActivityLogsDb.insertMany(logEvents, connectionHolder);
  }

  private addEventToArrayIfChanged(
    oldValue: string | null,
    newValue: string | null,
    logEvents: NewProfileActivityLog[],
    profileId: string,
    logType: ProfileActivityLogType,
    authenticatedWallet: string
  ) {
    if (oldValue !== newValue) {
      logEvents.push({
        profile_id: profileId,
        target_id: null,
        type: logType,
        contents: JSON.stringify({
          authenticated_wallet: authenticatedWallet,
          old_value: oldValue,
          new_value: newValue
        })
      });
    }
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
    await this.profilesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profilesDb.updateProfilePfpUri(
          thumbnailUri,
          profile,
          connection
        );
        if ((thumbnailUri ?? null) !== (profile.pfp_url ?? null)) {
          await this.profileActivityLogsDb.insert(
            {
              profile_id: profile.external_id,
              target_id: null,
              type: ProfileActivityLogType.PFP_EDIT,
              contents: JSON.stringify({
                authenticated_wallet: authenticatedWallet,
                old_value: profile.pfp_url ?? null,
                new_value: thumbnailUri
              })
            },
            connection
          );
        }
      }
    );

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

  public async updateProfileTdhs(
    blockNo: number,
    connectionHolder?: ConnectionWrapper<any>
  ) {
    if (connectionHolder) {
      await this.updateProfileTdhsInternal(blockNo, connectionHolder);
    } else {
      await this.profilesDb.executeNativeQueriesInTransaction(
        async (connectionHolder) => {
          await this.updateProfileTdhsInternal(blockNo, connectionHolder);
        }
      );
    }
  }

  private async updateProfileTdhsInternal(
    blockNo: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    this.logger.info(`Starting to update profile TDHs for block ${blockNo}`);
    const start = Time.now();
    const maxRecordedBlock =
      await this.profilesDb.getMaxRecordedProfileTdhBlock(connectionHolder);
    if (maxRecordedBlock >= blockNo) {
      await this.profilesDb.deleteProfileTdhLogsByBlock(
        blockNo,
        connectionHolder
      );
    }
    const newProfileTdhs = await profilesDb.getAllPotentialProfileTdhs(
      blockNo,
      connectionHolder
    );
    await profilesDb.updateProfileTdhs(newProfileTdhs, connectionHolder);
    this.logger.info(
      `Finished profile TDHs update for block ${blockNo} with ${
        newProfileTdhs.length
      } records in ${start.diffFromNow()}`
    );
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
  ): Promise<{
    tdh: number;
    consolidatedWallets: string[];
    blockNo: number;
    consolidation_key: string | null;
    consolidation_display: string | null;
  }> {
    const normalisedWallet = wallet.toLowerCase();
    if (!WALLET_REGEX.exec(normalisedWallet)) {
      return {
        tdh: 0,
        consolidatedWallets: [],
        blockNo: 0,
        consolidation_key: null,
        consolidation_display: null
      };
    }
    return this.profilesDb
      .getConsolidationInfoForWallet(normalisedWallet)
      .then((resultRows) => {
        if (!resultRows.length) {
          return {
            tdh: 0,
            consolidatedWallets: [normalisedWallet],
            blockNo: 0,
            consolidation_key: null,
            consolidation_display: null
          };
        }
        const result = resultRows[0];
        if (!result.wallets.includes(normalisedWallet)) {
          result.wallets.push(normalisedWallet);
        }
        return {
          tdh: result.tdh,
          consolidatedWallets: result.wallets,
          blockNo: result.blockNo,
          consolidation_key: result.consolidation_key,
          consolidation_display: result.consolidation_display
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
  ratingsService,
  profileActivityLogsDb,
  getAlchemyInstance
);
