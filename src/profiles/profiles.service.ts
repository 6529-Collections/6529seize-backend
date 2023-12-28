import { profilesDb, ProfilesDb } from './profiles.db';
import { WALLET_REGEX } from '../constants';
import { getAlchemyInstance } from '../alchemy';
import { Alchemy } from 'alchemy-sdk';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from './profile.types';
import { calculateLevel } from './profile-level';
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
import { cicService, CicService } from '../cic/cic.service';
import {
  RepService,
  repService
} from '../api-serverless/src/profiles/rep.service';

export class ProfilesService {
  private readonly logger = Logger.get('PROFILES_SERVICE');

  constructor(
    private readonly profilesDb: ProfilesDb,
    private readonly ratingsService: RatingsService,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly cicService: CicService,
    private readonly repService: RepService,
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
    const rep = profile?.external_id
      ? await this.repService.getRepForProfile(profile.external_id)
      : 0;
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
      level: calculateLevel({ tdh, rep }),
      rep,
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
    const rep = profile?.external_id
      ? await this.repService.getRepForProfile(profile?.external_id)
      : 0;
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
      level: calculateLevel({ tdh, rep }),
      cic,
      rep
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
      const rep = profile?.external_id
        ? await this.repService.getRepForProfile(profile?.external_id)
        : 0;
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
        level: calculateLevel({ tdh, rep }),
        cic,
        rep
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
          const tdhInfo = await this.getWalletTdhBlockNoAndConsolidatedWallets(
            primary_wallet
          );
          if (tdhInfo.block_date) {
            await this.profilesDb.insertProfileTdh(
              {
                profile_id: profileId,
                block: tdhInfo.blockNo,
                tdh: tdhInfo.tdh,
                boosted_tdh: tdhInfo.tdh,
                created_at: new Date(),
                block_date: tdhInfo.block_date
              },
              connectionHolder
            );
          }
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

  public async mergeProfiles(connectionHolder: ConnectionWrapper<any>) {
    const start = Time.now();
    const archivalCandidates =
      await this.profilesDb.getProfilesArchivalCandidates(connectionHolder);
    const groups = archivalCandidates.reduce((result, profile) => {
      const key = profile.consolidation_key;
      if (!result[key]) {
        result[key] = [];
      }
      result[key].push(profile);
      return result;
    }, {} as Record<string, (Profile & { cic_rating: number })[]>);
    const profileSets = Object.values(groups).map((profiles) => {
      const sorted = [...profiles].sort((a, d) => d.cic_rating - a.cic_rating);
      const target = sorted.at(0)!;
      const toBeMerged = sorted.slice(1);
      return { target, toBeMerged };
    });
    this.logger.info(`Archiving profiles in ${profileSets.length} sets`);
    for (const profileSet of profileSets) {
      await this.mergeProfileSet(profileSet, connectionHolder);
    }
    this.logger.info(
      `${profileSets
        .map((it) => it.toBeMerged.length)
        .reduce(
          (a, d) => a + d,
          0
        )} profiles merged with other profiles ${start.diffFromNow()}`
    );
  }

  private async mergeProfileSet(
    {
      toBeMerged,
      target
    }: {
      toBeMerged: Profile[];
      target: Profile;
    },
    connectionHolder: ConnectionWrapper<any>
  ) {
    for (const profileToBeMerged of toBeMerged) {
      const start = Time.now();
      this.logger.info(
        `Merging profile ${profileToBeMerged.external_id}/${profileToBeMerged.handle} to profile ${target.external_id}/${target.handle}`
      );
      await this.mergeProfileStatements(
        profileToBeMerged,
        target,
        connectionHolder
      );
      await this.mergeRatings(profileToBeMerged, target, connectionHolder);
      await this.profilesDb.deleteProfile(
        { id: profileToBeMerged.external_id },
        connectionHolder
      );
      await this.profileActivityLogsDb.insert(
        {
          profile_id: profileToBeMerged.external_id,
          target_id: null,
          type: ProfileActivityLogType.PROFILE_ARCHIVED,
          contents: JSON.stringify({
            handle: profileToBeMerged.handle,
            reason: 'CONFLICTING_CONSOLIDATION'
          })
        },
        connectionHolder
      );
      this.logger.info(
        `Profile ${profileToBeMerged.external_id}/${
          profileToBeMerged.handle
        } deleted and merged to profile ${target.external_id}/${
          target.handle
        } on ${start.diffFromNow()}`
      );
    }
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

  public async getProfileIdsAndHandlesByPrimaryWallets(
    wallets: string[]
  ): Promise<Record<string, { id: string; handle: string }>> {
    if (!wallets.length) {
      return {};
    }
    const profiles = await this.getProfilesByWallets(wallets);
    return wallets.reduce((result, wallet) => {
      const profile = profiles.find(
        (profile) =>
          profile.primary_wallet.toLowerCase() === wallet.toLowerCase()
      );
      if (profile) {
        result[wallet.toLowerCase()] = {
          id: profile.external_id,
          handle: profile.handle
        };
      }
      return result;
    }, {} as Record<string, { id: string; handle: string }>);
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
    block_date: Date | null;
    raw_tdh: number;
  }> {
    const normalisedWallet = wallet.toLowerCase();
    if (!WALLET_REGEX.exec(normalisedWallet)) {
      return {
        tdh: 0,
        consolidatedWallets: [],
        blockNo: 0,
        consolidation_key: null,
        consolidation_display: null,
        block_date: null,
        raw_tdh: 0
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
            consolidation_display: null,
            block_date: null,
            raw_tdh: 0
          };
        }
        const result = resultRows[0];
        if (
          !result.wallets
            .map((it) => it.toLowerCase())
            .includes(normalisedWallet.toLowerCase())
        ) {
          result.wallets.push(normalisedWallet.toLowerCase());
        }
        return {
          tdh: result.tdh,
          consolidatedWallets: result.wallets.map((it) => it.toLowerCase()),
          blockNo: result.blockNo,
          consolidation_key: result.consolidation_key,
          consolidation_display: result.consolidation_display,
          block_date: result.block_date,
          raw_tdh: result.raw_tdh
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

  private async mergeProfileStatements(
    source: Profile,
    target: Profile,
    connectionHolder: ConnectionWrapper<any>
  ) {
    const sourceStatements = await this.cicService.getCicStatementsByProfileId(
      source.external_id
    );
    const targetStatements = await this.cicService.getCicStatementsByProfileId(
      target.external_id
    );
    const missingTargetStatements = sourceStatements.filter(
      (sourceStatement) => {
        return !targetStatements.find(
          (targetStatement) =>
            targetStatement.statement_group ===
              sourceStatement.statement_group &&
            targetStatement.statement_type === sourceStatement.statement_type &&
            targetStatement.statement_comment ===
              sourceStatement.statement_comment &&
            targetStatement.statement_value === sourceStatement.statement_value
        );
      }
    );
    for (const statement of missingTargetStatements) {
      await this.cicService.insertStatement(
        {
          ...statement,
          profile_id: target.external_id
        },
        connectionHolder
      );
    }
    for (const sourceStatement of sourceStatements) {
      await this.cicService.deleteStatement(sourceStatement, connectionHolder);
    }
  }

  private async mergeRatings(
    sourceProfile: Profile,
    targetProfile: Profile,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.ratingsService.transferAllGivenProfileRatings(
      sourceProfile,
      targetProfile,
      connectionHolder
    );
    await this.ratingsService.transferAllReceivedProfileRatings(
      sourceProfile,
      targetProfile,
      connectionHolder
    );
  }

  async searchCommunityMemberMinimalsOfClosestMatches({
    param,
    limit
  }: {
    param: string;
    limit: number;
  }): Promise<CommunityMemberMinimal[]> {
    if (param.length < 3 || param.length > 100) {
      return [];
    }
    if (WALLET_REGEX.exec(param)) {
      return await this.searchCommunityMemberByWallet(param);
    } else {
      const membersByHandles =
        await this.profilesDb.searchCommunityMembersWhereHandleLike({
          handle: param,
          limit: limit * 3
        });
      const profilesByEnsNames =
        await this.profilesDb.searchCommunityMembersWhereEnsLike({
          handle: param,
          limit: limit * 3
        });
      const members = [...membersByHandles, ...profilesByEnsNames]
        .reduce((acc, prof) => {
          if (!acc.find((it) => it.display === prof.display)) {
            acc.push(prof);
          }
          return acc;
        }, [] as (Profile & { display: string; tdh: number; wallet: string })[])
        .sort((a, d) => {
          if (a.handle && !d.handle) {
            return -1;
          } else if (!a.handle && d.handle) {
            return 1;
          }
          return d.tdh - a.tdh;
        })
        .slice(0, limit);
      const profileIds = members
        .map((it) => it.external_id)
        .filter((it) => !!it);
      const foundProfilesCicsByProfileIds =
        await this.ratingsService.getSummedRatingsOnMatterByTargetIds({
          matter: RateMatter.CIC,
          matter_target_ids: profileIds
        });
      const profileRepsByProfileIds = await this.repService.getRepForProfiles(
        profileIds
      );
      return members.map((member) => {
        const cic = foundProfilesCicsByProfileIds[member.external_id];
        return {
          handle: member.handle,
          normalised_handle: member.normalised_handle,
          primary_wallet: member.primary_wallet,
          tdh: member.tdh,
          level: calculateLevel({
            tdh: member.tdh,
            rep: profileRepsByProfileIds[member.external_id] ?? 0
          }),
          cic_rating: cic ?? 0,
          display: member.display,
          wallet: member.wallet
        };
      });
    }
  }

  private async searchCommunityMemberByWallet(
    wallet: string
  ): Promise<CommunityMemberMinimal[]> {
    const profileAndConsolidationsInfo = await this.getProfileByWallet(wallet);
    if (!profileAndConsolidationsInfo) {
      return [];
    }
    const { profile, consolidation, cic, level } = profileAndConsolidationsInfo;
    let display = consolidation.consolidation_display;
    if (!display && !profile) {
      return [];
    }
    if (!display) {
      const wallets = await this.profilesDb.getPrediscoveredEnsNames([
        profile!.primary_wallet.toLowerCase()
      ]);
      const walletResp = wallets.at(0);
      display = walletResp?.ens ?? wallet;
    }
    return [
      {
        handle: profile?.handle ?? null,
        normalised_handle: profile?.normalised_handle ?? null,
        primary_wallet: profile?.primary_wallet ?? null,
        tdh: consolidation.tdh,
        level: level,
        cic_rating: cic.cic_rating ?? 0,
        display: display,
        wallet
      }
    ];
  }
}

export interface CommunityMemberMinimal {
  readonly handle: string | null;
  readonly normalised_handle: string | null;
  readonly primary_wallet: string | null;
  readonly display: string | null;
  readonly tdh: number;
  readonly level: number;
  readonly cic_rating: number;
  readonly wallet: string;
}

export const profilesService = new ProfilesService(
  profilesDb,
  ratingsService,
  profileActivityLogsDb,
  cicService,
  repService,
  getAlchemyInstance
);
