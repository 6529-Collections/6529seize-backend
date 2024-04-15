import { profilesDb, ProfilesDb } from './profiles.db';
import { UUID_REGEX, WALLET_REGEX } from '../constants';
import { getAlchemyInstance } from '../alchemy';
import { Alchemy } from 'alchemy-sdk';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from './profile.types';
import { calculateLevel } from './profile-level';
import { Profile } from '../entities/IProfile';
import * as tdh_consolidation from '../tdhLoop/tdh_consolidation';
import * as tdhs from '../tdhLoop/tdh';
import { BadRequestException } from '../exceptions';
import * as path from 'path';
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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { ProfileMin } from './profile-min';

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

  private async getProfileAndConsolidationsById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileAndConsolidations | null> {
    const profile = await this.profilesDb.getProfileById(id, connection);
    if (!profile) {
      return null;
    }
    const primaryWallet = profile.primary_wallet;
    const {
      consolidatedWallets,
      tdh,
      blockNo,
      consolidation_key,
      consolidation_display,
      balance
    } = await this.getWalletTdhBlockNoAndConsolidatedWallets(
      primaryWallet,
      connection
    );
    const walletTdhs = await this.profilesDb.getWalletsTdhs(
      {
        wallets: consolidatedWallets,
        blockNo
      },
      connection
    );
    const wallets = await this.profilesDb.getPrediscoveredEnsNames(
      consolidatedWallets,
      connection
    );
    const cic = await this.getCic(profile, connection);
    const rep = await this.repService.getRepForProfile(
      profile.external_id,
      connection
    );
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
      cic,
      balance
    };
  }

  public async getProfileByEnsName(
    query: string,
    connection?: ConnectionWrapper<any>
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
      consolidation_display,
      balance
    } = await this.getWalletTdhBlockNoAndConsolidatedWallets(
      wallet,
      connection
    );
    if (consolidatedWallets.length === 0) {
      return null;
    }
    const profile = await this.getWalletsNewestProfile(wallet, connection);
    const walletTdhs = await this.profilesDb.getWalletsTdhs(
      {
        wallets: consolidatedWallets,
        blockNo
      },
      connection
    );
    const wallets = await this.profilesDb.getPrediscoveredEnsNames(
      consolidatedWallets,
      connection
    );
    const cic = await this.getCic(profile, connection);
    const rep = profile?.external_id
      ? await this.repService.getRepForProfile(profile.external_id, connection)
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
      cic,
      balance
    };
  }

  private async getCic(
    profile: Profile | undefined,
    connection?: ConnectionWrapper<any>
  ) {
    const profileId = profile?.external_id;
    return profileId
      ? await this.ratingsService
          .getAggregatedRatingOnMatter(
            {
              rater_profile_id: null,
              matter: RateMatter.CIC,
              matter_target_id: profileId,
              matter_category: RateMatter.CIC
            },
            connection
          )
          .then((res) => ({
            cic_rating: res.rating,
            contributor_count: res.contributor_count
          }))
      : { cic_rating: 0, contributor_count: 0 };
  }

  public async getProfileByWallet(
    query: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileAndConsolidations | null> {
    const {
      consolidatedWallets,
      tdh,
      blockNo,
      consolidation_key,
      consolidation_display,
      balance
    } = await this.getWalletTdhBlockNoAndConsolidatedWallets(query, connection);
    if (consolidatedWallets.length === 0) {
      return null;
    }
    const profile = await this.getWalletsNewestProfile(query, connection);
    const walletTdhs = await this.profilesDb.getWalletsTdhs(
      {
        wallets: consolidatedWallets,
        blockNo
      },
      connection
    );
    const wallets = await this.profilesDb.getPrediscoveredEnsNames(
      consolidatedWallets,
      connection
    );
    const cic = await this.getCic(profile, connection);
    const rep = profile?.external_id
      ? await this.repService.getRepForProfile(profile?.external_id, connection)
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
      rep,
      balance
    };
  }

  public async getProfilesByWallets(
    wallets: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Profile[]> {
    return this.profilesDb.getProfilesByWallets(wallets, connection);
  }

  public async getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
    handleOrEnsOrWalletAddress: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileAndConsolidations | null> {
    const query = handleOrEnsOrWalletAddress.toLowerCase();
    if (UUID_REGEX.exec(query)) {
      return this.getProfileAndConsolidationsById(query, connection);
    } else if (query.endsWith('.eth')) {
      return await this.getProfileByEnsName(query, connection);
    } else if (WALLET_REGEX.exec(query)) {
      return await this.getProfileByWallet(query, connection);
    } else {
      const profile = await this.profilesDb.getProfileByHandle(
        query,
        connection
      );
      if (!profile) {
        return null;
      }
      const {
        consolidatedWallets,
        tdh,
        blockNo,
        consolidation_key,
        consolidation_display,
        balance
      } = await tdh_consolidation.getWalletTdhAndConsolidatedWallets(
        profile.primary_wallet.toLowerCase(),
        connection
      );
      const walletTdhs = await tdhs.getWalletsTdhs(
        {
          wallets: consolidatedWallets,
          blockNo
        },
        connection
      );
      const wallets = await this.profilesDb.getPrediscoveredEnsNames(
        consolidatedWallets,
        connection
      );
      const cic = await this.getCic(profile, connection);
      const rep = profile?.external_id
        ? await this.repService.getRepForProfile(
            profile?.external_id,
            connection
          )
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
        rep,
        balance
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
    classification,
    sub_classification
  }: CreateOrUpdateProfileCommand): Promise<ProfileAndConsolidations> {
    return await this.profilesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const {
          consolidatedWallets: creatorOrUpdaterWalletConsolidatedWallets
        } = await this.getWalletTdhBlockNoAndConsolidatedWallets(
          creator_or_updater_wallet,
          connection
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
          creatorOrUpdaterWalletConsolidatedWallets,
          connection
        );
        if (
          !creatorOrUpdaterProfiles.find(
            (p) => p.normalised_handle === handle.toLowerCase()
          )
        ) {
          const preExistingProfile = await this.profilesDb.getProfileByHandle(
            handle,
            connection
          );
          if (preExistingProfile) {
            throw new BadRequestException(`Handle ${handle} is already taken`);
          }
        }
        if (creatorOrUpdaterProfiles.length === 0) {
          const profileId = await this.profilesDb.insertProfileRecord(
            {
              command: {
                handle,
                primary_wallet,
                banner_1,
                banner_2,
                website,
                creator_or_updater_wallet,
                classification,
                sub_classification
              }
            },
            connection
          );
          await this.refreshPrimaryWalletEns(primary_wallet, connection);
          await this.createProfileEditLogs({
            profileId: profileId,
            profileBeforeChange: null,
            newHandle: handle,
            newPrimaryWallet: primary_wallet,
            newBanner1: banner_1,
            newBanner2: banner_2,
            authenticatedWallet: creator_or_updater_wallet,
            newClassification: classification,
            connectionHolder: connection,
            newSubClassification: sub_classification
          });
        } else {
          const latestProfile = creatorOrUpdaterProfiles
            .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
            .at(0)!;
          const isNameTaken =
            creatorOrUpdaterProfiles
              .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
              .findIndex((p) => p.normalised_handle === handle.toLowerCase()) >
            0;
          const isPrimaryWalletTaken =
            creatorOrUpdaterProfiles
              .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
              .findIndex(
                (p) =>
                  p.primary_wallet.toLowerCase() ===
                  primary_wallet.toLowerCase()
              ) > 0;
          if (isNameTaken || isPrimaryWalletTaken) {
            throw new BadRequestException(
              `Handle ${handle} or primary wallet ${primary_wallet} is already taken`
            );
          }
          await this.refreshPrimaryWalletEns(primary_wallet, connection);
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
                classification,
                sub_classification
              }
            },
            connection
          );
          await this.createProfileEditLogs({
            profileId: latestProfile.external_id,
            profileBeforeChange: latestProfile,
            newHandle: handle,
            newPrimaryWallet: primary_wallet,
            newBanner1: banner_1,
            newBanner2: banner_2,
            newSubClassification: sub_classification,
            authenticatedWallet: creator_or_updater_wallet,
            newClassification: classification,
            connectionHolder: connection
          });
        }
        const updatedProfile =
          await this.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            handle,
            connection
          );
        return updatedProfile!;
      }
    );
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
    connectionHolder,
    newSubClassification
  }: {
    profileId: string;
    profileBeforeChange: Profile | null;
    newHandle: string;
    newPrimaryWallet: string;
    newClassification: string;
    newBanner1?: string;
    newBanner2?: string;
    authenticatedWallet: string;
    newSubClassification: string | null;
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
      profileBeforeChange?.sub_classification ?? null,
      newSubClassification ?? null,
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
    return await this.profilesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const profile =
          await this.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            handleOrWallet,
            connection
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
        const thumbnailUri = await this.getOrCreatePfpFileUri(
          { meme, file },
          connection
        );

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
        return { pfp_url: thumbnailUri };
      }
    );
  }

  private async getWalletsNewestProfile(
    wallet: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Profile | undefined> {
    const { consolidatedWallets } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(wallet);
    const profiles = await this.getProfilesByWallets(
      consolidatedWallets,
      connection
    );
    return profiles
      .sort((a, d) => d.created_at.getTime() - a.created_at.getTime())
      .at(0);
  }

  private async getWalletTdhBlockNoAndConsolidatedWallets(
    wallet: string,
    connection?: ConnectionWrapper<any>
  ): Promise<{
    tdh: number;
    consolidatedWallets: string[];
    blockNo: number;
    consolidation_key: string | null;
    consolidation_display: string | null;
    block_date: Date | null;
    raw_tdh: number;
    balance: number;
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
        raw_tdh: 0,
        balance: 0
      };
    }
    return this.profilesDb
      .getConsolidationInfoForWallet(normalisedWallet, connection)
      .then((resultRows) => {
        if (!resultRows.length) {
          return {
            tdh: 0,
            consolidatedWallets: [normalisedWallet],
            blockNo: 0,
            consolidation_key: null,
            consolidation_display: null,
            block_date: null,
            raw_tdh: 0,
            balance: 0
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
          raw_tdh: result.raw_tdh,
          balance: result.balance
        };
      });
  }

  private async getOrCreatePfpFileUri(
    {
      meme,
      file
    }: {
      file?: Express.Multer.File;
      meme?: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    if (meme) {
      return await this.profilesDb
        .getMemeThumbnailUriById(meme, connection)
        .then((uri) => {
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
      return await this.uploadPfpToS3(file, extension);
    } else {
      throw new BadRequestException('No PFP provided');
    }
  }

  private async mergeProfileStatements(
    source: Profile,
    target: Profile,
    connection: ConnectionWrapper<any>
  ) {
    const sourceStatements = await this.cicService.getCicStatementsByProfileId(
      source.external_id,
      connection
    );
    const targetStatements = await this.cicService.getCicStatementsByProfileId(
      target.external_id,
      connection
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
        connection
      );
    }
    for (const sourceStatement of sourceStatements) {
      await this.cicService.deleteStatement(sourceStatement, connection);
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
    onlyProfileOwners,
    limit
  }: {
    param: string;
    onlyProfileOwners: boolean;
    limit: number;
  }): Promise<CommunityMemberMinimal[]> {
    if (param.length < 3 || param.length > 100) {
      return [];
    }
    if (WALLET_REGEX.exec(param)) {
      const communityMember = await this.searchCommunityMemberByWallet(
        param,
        onlyProfileOwners
      );
      return communityMember ? [communityMember] : [];
    } else {
      const membersByHandles =
        await this.profilesDb.searchCommunityMembersWhereHandleLike({
          handle: param,
          limit: limit * 3
        });
      const profilesByEnsNames =
        await this.profilesDb.searchCommunityMembersWhereEnsLike({
          ensCandidate: param,
          onlyProfileOwners,
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
          profile_id: member.external_id,
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
          wallet: member.wallet,
          pfp: member.pfp_url ?? null
        };
      });
    }
  }

  private async searchCommunityMemberByWallet(
    wallet: string,
    onlyProfileOwners: boolean
  ): Promise<CommunityMemberMinimal | null> {
    const profileAndConsolidationsInfo = await this.getProfileByWallet(wallet);
    if (
      !profileAndConsolidationsInfo ||
      (onlyProfileOwners && !profileAndConsolidationsInfo.profile)
    ) {
      return null;
    }
    const { profile, consolidation, cic, level } = profileAndConsolidationsInfo;
    let display = consolidation.consolidation_display;
    if (!display && !profile) {
      return null;
    }
    if (!display) {
      const wallets = await this.profilesDb.getPrediscoveredEnsNames([
        profile!.primary_wallet.toLowerCase()
      ]);
      const walletResp = wallets.at(0);
      display = walletResp?.ens ?? wallet;
    }
    return {
      profile_id: profile?.external_id ?? null,
      handle: profile?.handle ?? null,
      normalised_handle: profile?.normalised_handle ?? null,
      primary_wallet: profile?.primary_wallet ?? null,
      tdh: consolidation.tdh,
      level: level,
      cic_rating: cic.cic_rating ?? 0,
      display: display,
      pfp: profile?.pfp_url ?? null,
      wallet
    };
  }

  private async refreshPrimaryWalletEns(
    wallet: string,
    connection: ConnectionWrapper<any>
  ) {
    const ensName = await this.supplyAlchemy().core.lookupAddress(wallet);
    await this.profilesDb.updateWalletsEnsName({ wallet, ensName }, connection);
  }

  private async uploadPfpToS3(file: any, fileExtension: string) {
    const s3 = new S3Client({ region: 'eu-west-1' });

    const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

    const keyExtension: string = fileExtension !== '.gif' ? 'webp' : 'gif';

    const key = `pfp/${process.env.NODE_ENV}/${randomUUID()}.${keyExtension}`;

    const uploadedScaledImage = await s3.send(
      new PutObjectCommand({
        Bucket: myBucket,
        Key: key,
        Body: file.buffer,
        ContentType: `image/${keyExtension}`
      })
    );
    if (uploadedScaledImage.$metadata.httpStatusCode == 200) {
      return `https://d3lqz0a4bldqgf.cloudfront.net/${key}?d=${Date.now()}`;
    }
    throw new Error('Failed to upload image');
  }

  async getProfileMinsByIds(ids: string[]): Promise<ProfileMin[]> {
    return this.profilesDb.getProfileMinsByIds(ids);
  }

  async getProfileHandlesByIds(ids: string[]): Promise<Record<string, string>> {
    const dbResult = await this.profilesDb.getProfileIdsAndHandlesByIds(ids);
    return dbResult.reduce((acc, it) => {
      acc[it.id] = it.handle;
      return acc;
    }, {} as Record<string, string>);
  }

  async getNewestVersionOfArchivedProfile(
    profileId: string
  ): Promise<Profile | null> {
    return this.profilesDb.getNewestVersionOfArchivedProfile(profileId);
  }

  async getNewestVersionOfArchivedProfileHandles(
    profileIds: string[]
  ): Promise<{ external_id: string; handle: string }[]> {
    return this.profilesDb.getNewestVersionHandlesOfArchivedProfiles(
      profileIds
    );
  }
}

export interface CommunityMemberMinimal {
  readonly profile_id: string | null;
  readonly handle: string | null;
  readonly normalised_handle: string | null;
  readonly primary_wallet: string | null;
  readonly display: string | null;
  readonly tdh: number;
  readonly level: number;
  readonly cic_rating: number;
  readonly wallet: string;
  readonly pfp: string | null;
}

export const profilesService = new ProfilesService(
  profilesDb,
  ratingsService,
  profileActivityLogsDb,
  cicService,
  repService,
  getAlchemyInstance
);
