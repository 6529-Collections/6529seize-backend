import { profilesDb, ProfilesDb } from './profiles.db';
import { UUID_REGEX, WALLET_REGEX } from '../constants';
import { getAlchemyInstance } from '../alchemy';
import { Alchemy } from 'alchemy-sdk';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from './profile.types';
import { calculateLevel, getLevelFromScore } from './profile-level';
import { Profile, ProfileClassification } from '../entities/IProfile';
import * as tdh_consolidation from '../tdhLoop/tdh_consolidation';
import * as tdhs from '../tdhLoop/tdh';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../exceptions';
import { ConnectionWrapper } from '../sql-executor';
import { Logger } from '../logging';
import { Time } from '../time';
import {
  NewProfileActivityLog,
  profileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { ratingsService, RatingsService } from '../rates/ratings.service';
import { RateMatter } from '../entities/IRating';
import { cicService, CicService } from '../cic/cic.service';
import {
  RepService,
  repService
} from '../api-serverless/src/profiles/rep.service';
import { randomUUID } from 'crypto';
import {
  areEqualAddresses,
  distinct,
  replaceEmojisWithHex,
  resolveEnum,
  uniqueShortId
} from '../helpers';
import {
  getDelegationPrimaryAddressForConsolidation,
  getHighestTdhAddressForConsolidationKey
} from '../delegationsLoop/db.delegations';
import {
  profileProxiesDb,
  ProfileProxiesDb
} from '../profile-proxies/profile-proxies.db';
import { userGroupsDb, UserGroupsDb } from '../user-groups/user-groups.db';
import { IdentitiesDb, identitiesDb } from '../identities/identities.db';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from '../notifications/identity-notifications.db';
import { RequestContext } from '../request.context';
import { IdentityEntity } from '../entities/IIdentity';
import {
  clappingDb,
  ClappingDb
} from '../api-serverless/src/drops/clapping.db';
import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import { ApiIdentity } from '../api-serverless/src/generated/models/ApiIdentity';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { wavesApiDb } from '../api-serverless/src/waves/waves.api.db';
import { ProfileProxyActionType } from '../entities/IProfileProxyAction';
import { identitySubscriptionsDb } from '../api-serverless/src/identity-subscriptions/identity-subscriptions.db';
import { ApiProfileClassification } from '../api-serverless/src/generated/models/ApiProfileClassification';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';

export class ProfilesService {
  private readonly logger = Logger.get('PROFILES_SERVICE');

  constructor(
    private readonly profilesDb: ProfilesDb,
    private readonly ratingsService: RatingsService,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly cicService: CicService,
    private readonly repService: RepService,
    private readonly userGroupsDb: UserGroupsDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly notificationsDb: IdentityNotificationsDb,
    private readonly clappingDb: ClappingDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  public async getProfileHandlesByPrimaryWallets(
    addresses: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    return this.profilesDb.getHandlesByPrimaryWallets(addresses, connection);
  }

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
      balance,
      input_identity: id
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
      balance,
      input_identity: query
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
      balance,
      input_identity: query
    };
  }

  public async getProfilesByWallets(
    wallets: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Profile[]> {
    return this.profilesDb.getProfilesByWallets(wallets, connection);
  }

  public async getProfileAndConsolidationsByIdentity(
    identity: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileAndConsolidations | null> {
    const query = identity.toLowerCase();
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
        balance,
        input_identity: identity
      };
    }
  }

  public async createOrUpdateProfile({
    handle,
    banner_1,
    banner_2,
    website,
    creator_or_updater_wallet,
    classification,
    sub_classification,
    pfp_url
  }: CreateOrUpdateProfileCommand): Promise<ApiIdentity> {
    return await this.profilesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.createOrUpdateProfileWithGivenTransaction(
          {
            creator_or_updater_wallet,
            handle,
            banner_1,
            banner_2,
            website,
            classification,
            sub_classification,
            pfp_url
          },
          { connection }
        );
      }
    );
  }

  public async makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
    addresses: string[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    if (!addresses.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->createProfilesAndIdentitiesForThoseWhoAreMissingAndGetProfileIdsByAddresses`
    );
    let allIdentitiesAndProfiles =
      await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
        addresses,
        ctx.connection!
      );
    const addressesMissingIdentities = addresses.filter(
      (it) => !allIdentitiesAndProfiles[it]
    );
    const newIdentities = addressesMissingIdentities.map<IdentityEntity>(
      (address) => ({
        primary_address: address,
        profile_id: randomUUID(),
        consolidation_key: address,
        handle: null,
        normalised_handle: null,
        tdh: 0,
        rep: 0,
        cic: 0,
        level_raw: 0,
        pfp: null,
        banner1: null,
        banner2: null,
        classification: null,
        sub_classification: null
      })
    );
    if (newIdentities.length) {
      await identitiesDb.bulkInsertIdentities(newIdentities, ctx.connection!);
      allIdentitiesAndProfiles =
        await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
          addresses,
          ctx.connection!
        );
    }
    const identitiesMissingProfiles = Object.entries(
      Object.values(allIdentitiesAndProfiles)
        .filter((it) => !it.profile)
        .reduce((acc, it) => {
          acc[it.identity.primary_address] = it.identity.profile_id!;
          return acc;
        }, {} as Record<string, string>)
    ).map(([address, profileId]) => ({ address, profileId }));
    const authenticationContext = ctx.authenticationContext;
    if (!authenticationContext?.authenticatedWallet) {
      throw new BadRequestException(
        'Not authenticated. Can not create profiles'
      );
    }
    const now = Time.now().toDate();
    const authenticatedWallet = authenticationContext.authenticatedWallet;
    const newProfileEntities = identitiesMissingProfiles.map<Profile>(
      ({ address, profileId }) => ({
        external_id: profileId,
        handle: `id-${address}`,
        normalised_handle: `id-${address}`,
        primary_wallet: address,
        created_by_wallet: authenticatedWallet,
        classification: ProfileClassification.PSEUDONYM,
        created_at: now
      })
    );
    const newProfileCreationLogs = newProfileEntities
      .map<ProfileActivityLog[]>((profile) => [
        {
          id: uniqueShortId(),
          profile_id: profile.external_id,
          target_id: null,
          type: ProfileActivityLogType.HANDLE_EDIT,
          contents: JSON.stringify({
            authenticated_wallet: authenticatedWallet,
            new_value: profile.handle
          }),
          proxy_id: null,
          created_at: now,
          additional_data_1: null,
          additional_data_2: null
        },
        {
          id: uniqueShortId(),
          profile_id: profile.external_id,
          target_id: null,
          type: ProfileActivityLogType.CLASSIFICATION_EDIT,
          contents: JSON.stringify({
            authenticated_wallet: authenticatedWallet,
            new_value: profile.classification
          }),
          proxy_id: null,
          created_at: now,
          additional_data_1: null,
          additional_data_2: null
        }
      ])
      .flat();
    if (newProfileEntities.length) {
      await Promise.all([
        this.profilesDb.bulkInsertProfiles(newProfileEntities, ctx),
        profileActivityLogsDb.bulkInsertProfileActivityLogs(
          newProfileCreationLogs,
          ctx
        )
      ]);
      await identitiesDb.updateIdentityProfilesOfIds(
        newProfileEntities.map((it) => it.external_id),
        ctx
      );
      allIdentitiesAndProfiles =
        await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
          addresses,
          ctx.connection!
        );
    }

    ctx.timer?.stop(
      `${this.constructor.name}->createProfilesAndIdentitiesForThoseWhoAreMissingAndGetProfileIdsByAddresses`
    );
    return Object.entries(allIdentitiesAndProfiles).reduce(
      (acc, [address, { identity }]) => {
        acc[address] = identity.profile_id!;
        return acc;
      },
      {} as Record<string, string>
    );
  }

  public async createOrUpdateProfileWithGivenTransaction(
    {
      handle,
      banner_1,
      banner_2,
      website,
      creator_or_updater_wallet,
      classification,
      sub_classification,
      pfp_url
    }: CreateOrUpdateProfileCommand,
    ctx: RequestContext
  ): Promise<ApiIdentity> {
    const identityResponse =
      await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
        [creator_or_updater_wallet],
        ctx.connection!
      );
    let creatorOrUpdatorIdentityResponse =
      identityResponse[creator_or_updater_wallet];
    if (!creatorOrUpdatorIdentityResponse) {
      const id = randomUUID();
      await identitiesDb.insertIdentity(
        {
          consolidation_key: creator_or_updater_wallet,
          primary_address: creator_or_updater_wallet,
          profile_id: id,
          handle: null,
          normalised_handle: null,
          tdh: 0,
          rep: 0,
          cic: 0,
          level_raw: 0,
          pfp: pfp_url,
          banner1: null,
          banner2: null,
          classification: null,
          sub_classification: null
        },
        ctx.connection!
      );
      creatorOrUpdatorIdentityResponse = await identitiesDb
        .getEverythingRelatedToIdentitiesByAddresses(
          [creator_or_updater_wallet],
          ctx.connection!
        )
        .then((it) => it[creator_or_updater_wallet]);
    }
    const creatorOrUpdatorProfile = creatorOrUpdatorIdentityResponse?.profile;
    const someoneElsesProfileWithSameHandle = await this.identitiesDb
      .getIdentityByHandle(handle, ctx.connection!)
      .then((it) => {
        if (
          it &&
          creatorOrUpdatorProfile &&
          it.profile_id === creatorOrUpdatorProfile.external_id
        ) {
          return null;
        }
        return it ?? null;
      });
    if (someoneElsesProfileWithSameHandle) {
      throw new BadRequestException(`Handle ${handle} is already taken`);
    }
    const identityId = creatorOrUpdatorIdentityResponse.identity.profile_id!;
    const createProfileCommand: CreateOrUpdateProfileCommand = {
      handle,
      banner_1,
      banner_2,
      website,
      creator_or_updater_wallet,
      classification,
      sub_classification,
      pfp_url
    };
    if (!creatorOrUpdatorProfile) {
      await this.profilesDb.insertProfileRecord(
        identityId,
        {
          command: createProfileCommand
        },
        ctx.connection!
      );
      await this.createProfileEditLogs({
        profileId: identityId,
        profileBeforeChange: null,
        newHandle: handle,
        newBanner1: banner_1 ?? undefined,
        newBanner2: banner_2 ?? undefined,
        authenticatedWallet: creator_or_updater_wallet,
        newClassification: classification,
        connectionHolder: ctx.connection!,
        newSubClassification: sub_classification,
        newPfpUrl: pfp_url
      });
    } else {
      const identityId = creatorOrUpdatorIdentityResponse.identity.profile_id!;
      await this.profilesDb.updateProfileRecord(
        {
          oldHandle: creatorOrUpdatorProfile.normalised_handle,
          command: {
            handle,
            banner_1,
            banner_2,
            website,
            creator_or_updater_wallet,
            classification,
            sub_classification,
            pfp_url
          }
        },
        ctx.connection!
      );
      await this.createProfileEditLogs({
        profileId: identityId,
        profileBeforeChange: creatorOrUpdatorProfile,
        newHandle: handle,
        newBanner1: banner_1 ?? undefined,
        newBanner2: banner_2 ?? undefined,
        newSubClassification: sub_classification,
        authenticatedWallet: creator_or_updater_wallet,
        newClassification: classification,
        newPfpUrl: pfp_url,
        connectionHolder: ctx.connection!
      });
    }
    await identitiesDb.updateIdentityProfile(
      creatorOrUpdatorIdentityResponse.identity.consolidation_key,
      {
        profile_id: identityId,
        handle: createProfileCommand.handle,
        normalised_handle: createProfileCommand.handle.toLowerCase(),
        banner1: createProfileCommand.banner_1 ?? null,
        banner2: createProfileCommand.banner_2 ?? null,
        classification: createProfileCommand.classification,
        sub_classification: createProfileCommand.sub_classification,
        pfp: pfp_url
      },
      ctx.connection!
    );
    const updatedIdentity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        {
          identityKey: handle
        },
        ctx
      );
    return updatedIdentity!;
  }

  async mergeProfileSet(
    {
      toBeMerged,
      target
    }: {
      toBeMerged: string[];
      target: string;
    },
    connectionHolder: ConnectionWrapper<any>
  ) {
    const targetIdentity = await identitiesDb.getIdentityByProfileId(
      target,
      connectionHolder
    );
    if (!targetIdentity) {
      throw new Error(`Expected target identity ${target} but didn't find it`);
    }
    for (const sourceIdentity of toBeMerged) {
      const start = Time.now();
      this.logger.info(
        `Merging identity ${sourceIdentity} to identity ${target}`
      );
      const sourceProfile = await this.profilesDb.getProfileById(
        sourceIdentity,
        connectionHolder
      );
      if (sourceProfile) {
        await this.mergeProfileStatements(
          sourceIdentity,
          target,
          connectionHolder
        );
        await this.mergeRatings(sourceIdentity, target, connectionHolder);
        await this.mergeProxies(sourceIdentity, target, connectionHolder);
        await this.mergeGroups(sourceIdentity, target, connectionHolder);
        await this.mergeWaves(sourceIdentity, target, connectionHolder);
        await this.mergeDrops(sourceIdentity, target, connectionHolder);
        await this.mergeNotifications(sourceIdentity, target, connectionHolder);
        await this.mergeIdentitySubscriptions(
          sourceIdentity,
          target,
          connectionHolder
        );
        await this.mergeClappingStuff(sourceIdentity, target, connectionHolder);
        await this.mergeVotingStuff(sourceIdentity, target, connectionHolder);
        const targetProfile = await this.profilesDb.getProfileById(
          target,
          connectionHolder
        );
        if (targetProfile) {
          await this.profilesDb.deleteProfile(
            { id: sourceIdentity },
            connectionHolder
          );
        } else {
          await this.profilesDb.updateProfileId(
            { from: sourceIdentity, to: target },
            connectionHolder
          );
        }
        await profileActivityLogsDb.changeSourceProfileIdInLogs(
          {
            oldSourceId: sourceIdentity,
            newSourceId: target
          },
          connectionHolder
        );

        await profileActivityLogsDb.changeTargetProfileIdInLogs(
          {
            oldSourceId: sourceIdentity,
            newSourceId: target
          },
          connectionHolder
        );
        await profileActivityLogsDb.insert(
          {
            profile_id: sourceIdentity,
            target_id: null,
            type: ProfileActivityLogType.PROFILE_ARCHIVED,
            contents: JSON.stringify({
              handle: sourceProfile.handle,
              reason: 'CONFLICTING_CONSOLIDATION'
            }),
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connectionHolder
        );
        this.logger.info(
          `Profile ${sourceIdentity} deleted and merged to profile ${target} on ${start.diffFromNow()}`
        );
      }
      await this.mergeProfileGroups(
        sourceIdentity,
        targetIdentity.profile_id!,
        connectionHolder
      );
      this.logger.info(
        `Merged identity ${sourceIdentity} to identity ${target}`
      );
    }
  }

  private async createProfileEditLogs({
    profileId,
    profileBeforeChange,
    newHandle,
    newClassification,
    newBanner1,
    newBanner2,
    authenticatedWallet,
    connectionHolder,
    newSubClassification,
    newPfpUrl
  }: {
    profileId: string;
    profileBeforeChange: Profile | null;
    newHandle: string;
    newClassification: string;
    newBanner1?: string;
    newBanner2?: string;
    authenticatedWallet: string;
    newSubClassification: string | null;
    newPfpUrl: string | null;
    connectionHolder: ConnectionWrapper<any>;
  }) {
    const logEvents: NewProfileActivityLog[] = [];
    if (profileBeforeChange === null) {
      logEvents.push({
        profile_id: profileId,
        target_id: null,
        type: ProfileActivityLogType.PROFILE_CREATED,
        contents: JSON.stringify({}),
        proxy_id: null,
        additional_data_1: null,
        additional_data_2: null
      });
    }
    if (profileBeforeChange?.normalised_handle !== newHandle.toLowerCase()) {
      logEvents.push({
        profile_id: profileId,
        target_id: null,
        type: ProfileActivityLogType.HANDLE_EDIT,
        contents: JSON.stringify({
          authenticated_wallet: authenticatedWallet,
          old_value: profileBeforeChange?.handle ?? null,
          new_value: newHandle
        }),
        proxy_id: null,
        additional_data_1: null,
        additional_data_2: null
      });
    }
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
    if (newPfpUrl !== null) {
      this.addEventToArrayIfChanged(
        profileBeforeChange?.pfp_url ?? null,
        newPfpUrl ?? null,
        logEvents,
        profileId,
        ProfileActivityLogType.PFP_EDIT,
        authenticatedWallet
      );
    }
    await profileActivityLogsDb.insertMany(logEvents, connectionHolder);
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
        }),
        proxy_id: null,
        additional_data_1: null,
        additional_data_2: null
      });
    }
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

  private async mergeProfileStatements(
    source: string,
    target: string,
    connection: ConnectionWrapper<any>
  ) {
    const sourceStatements = await this.cicService.getCicStatementsByProfileId(
      source,
      connection
    );
    const targetStatements = await this.cicService.getCicStatementsByProfileId(
      target,
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
          profile_id: target
        },
        connection,
        true
      );
    }
    for (const sourceStatement of sourceStatements) {
      await this.cicService.deleteStatement(sourceStatement, connection, true);
    }
  }

  private async mergeRatings(
    sourceProfile: string,
    targetProfile: string,
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

  private async mergeProxies(
    sourceProfile: string,
    targetProfile: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.profileProxiesDb.deleteAllProxiesAndActionsForProfile(
      sourceProfile,
      connectionHolder
    );
  }

  private async mergeGroups(
    profileToBeMerged: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.userGroupsDb.migrateProfileIdsInGroups(
      profileToBeMerged,
      target,
      connectionHolder
    );
  }

  private async mergeWaves(
    profileToBeMerged: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.profilesDb.migrateAuthorIdsInWaves(
      profileToBeMerged,
      target,
      connectionHolder
    );
  }

  private async mergeDrops(
    profileToBeMerged: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.profilesDb.migrateAuthorIdsInDrops(
      profileToBeMerged,
      target,
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
    connection?: ConnectionWrapper<any>
  ) {
    const ensName = await this.supplyAlchemy().core.lookupAddress(wallet);
    await this.profilesDb.updateWalletsEnsName(
      { wallet, ensName: ensName ? replaceEmojisWithHex(ensName) : null },
      connection
    );
  }

  public async updatePrimaryAddresses(addresses: Set<string>) {
    for (const address of Array.from(addresses)) {
      const profile = await this.getProfileByWallet(address);
      if (profile?.profile && profile.consolidation.consolidation_key) {
        const primaryAddress = await this.determinePrimaryAddress(
          profile.consolidation.wallets.map((it) => it.wallet.address),
          profile.consolidation.consolidation_key
        );
        const currentPrimaryAddress = profile.profile.primary_wallet;
        if (!areEqualAddresses(primaryAddress, currentPrimaryAddress)) {
          await this.updateProfilePrimaryAddress(
            profile.profile.external_id,
            primaryAddress
          );
        }
      }
    }
  }

  async determinePrimaryAddress(
    wallets: string[],
    consolidationKey: string
  ): Promise<string> {
    if (wallets.length === 1) {
      return wallets[0];
    }

    const delegationPrimaryAddress =
      await getDelegationPrimaryAddressForConsolidation(consolidationKey);
    if (delegationPrimaryAddress) {
      return delegationPrimaryAddress;
    }

    const highestTdhAddress = await getHighestTdhAddressForConsolidationKey(
      consolidationKey
    );
    if (highestTdhAddress) {
      return highestTdhAddress;
    }

    return wallets[0];
  }

  public async updateProfilePrimaryAddress(
    profileId: string,
    primaryAddress: string
  ) {
    await this.profilesDb.updatePrimaryAddress({
      profileId,
      primaryAddress
    });
    await this.refreshPrimaryWalletEns(primaryAddress);
  }

  private async mergeProfileGroups(
    sourceIdentity: string,
    targetIdentity: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    const sourceGroups =
      await this.userGroupsDb.findProfileGroupsWhereProfileIdIn(
        sourceIdentity,
        connectionHolder
      );
    const targetGroups =
      await this.userGroupsDb.findProfileGroupsWhereProfileIdIn(
        targetIdentity,
        connectionHolder
      );
    const distinctGroups = distinct([...sourceGroups, ...targetGroups]);
    if (distinctGroups) {
      await this.userGroupsDb.deleteProfileIdsInProfileGroups(
        [sourceIdentity, targetIdentity],
        connectionHolder
      );
      await this.userGroupsDb.insertProfileIdsInProfileGroups(
        targetIdentity,
        distinctGroups,
        connectionHolder
      );
    }
  }

  private async mergeNotifications(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.notificationsDb.updateIdentityIdsInNotifications(
      sourceIdentity,
      target,
      connectionHolder
    );
  }

  private async mergeIdentitySubscriptions(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await identitySubscriptionsDb.updateIdentityIdsInSubscriptions(
      sourceIdentity,
      target,
      connectionHolder
    );
  }

  private async mergeClappingStuff(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.clappingDb.mergeOnProfileIdChange(
      { previous_id: sourceIdentity, new_id: target },
      { connection: connectionHolder }
    );
  }

  private async mergeVotingStuff(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.dropVotingDb.mergeOnProfileIdChange(
      { previous_id: sourceIdentity, new_id: target },
      { connection: connectionHolder }
    );
  }

  public async retrieveOrGenerateRefreshToken(address: string) {
    return this.profilesDb.retrieveOrGenerateRefreshToken(address);
  }

  public async redeemRefreshToken(address: string, refreshToken: string) {
    return await this.profilesDb.redeemRefreshToken(address, refreshToken);
  }

  async searchIdentities(
    param: {
      limit: number;
      handle: string;
      wave_id: string | null;
      group_id: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiIdentity[]> {
    let context_group_id: string | null = null;
    if (param.wave_id || param.group_id) {
      const authenticationContext = ctx.authenticationContext;
      const eligibleGroups = authenticationContext?.hasRightsTo(
        ProfileProxyActionType.READ_WAVE
      )
        ? await userGroupsService.getGroupsUserIsEligibleFor(
            authenticationContext?.authenticatedProfileId ?? null,
            ctx.timer
          )
        : [];
      if (param.wave_id) {
        const givenWave = await wavesApiDb
          .findWavesByIds([param.wave_id], eligibleGroups, ctx.connection)
          .then((it) => it.at(0) ?? null);
        if (!givenWave) {
          throw new NotFoundException(`Wave ${param.wave_id} not found`);
        }
        context_group_id = givenWave.visibility_group_id;
      } else if (param.group_id) {
        if (eligibleGroups.includes(param.group_id)) {
          context_group_id = param.group_id;
        } else {
          throw new ForbiddenException(
            `You are not eligible to access this group`
          );
        }
      }
    }
    const base = await userGroupsService.getSqlAndParamsByGroupId(
      context_group_id,
      ctx
    );
    const identityEntities = await identitiesDb.searchIdentitiesWithDisplays(
      param,
      base,
      ctx
    );
    return identityEntities.map<ApiIdentity>((it) => {
      const classification = it.classification
        ? resolveEnum(ApiProfileClassification, it.classification as string) ??
          ApiProfileClassification.Pseudonym
        : ApiProfileClassification.Pseudonym;
      return {
        id: it.profile_id,
        handle: it.handle,
        normalised_handle: it.normalised_handle,
        pfp: it.pfp,
        primary_wallet: it.primary_address,
        rep: it.rep,
        cic: it.cic,
        level: getLevelFromScore(it.level_raw),
        tdh: it.tdh,
        display: it.display ?? it.primary_address,
        banner1: it.banner1,
        banner2: it.banner2,
        consolidation_key: it.consolidation_key,
        classification,
        sub_classification: it.sub_classification
      };
    });
  }

  async getAllWalletsByProfileId(profileId: string): Promise<string[]> {
    return this.profilesDb.getAllWalletsByProfileId(profileId);
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
  profileProxiesDb,
  cicService,
  repService,
  userGroupsDb,
  identitiesDb,
  identityNotificationsDb,
  clappingDb,
  dropVotingDb,
  getAlchemyInstance
);
