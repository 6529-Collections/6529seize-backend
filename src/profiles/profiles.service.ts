import { profilesDb, ProfilesDb } from './profiles.db';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from './profile.types';
import { Profile, ProfileClassification } from '../entities/IProfile';
import { BadRequestException } from '../exceptions';
import { ConnectionWrapper } from '../sql-executor';
import { Logger } from '../logging';
import { Time } from '../time';
import {
  NewProfileActivityLog,
  profileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { ratingsService, RatingsService } from '../rates/ratings.service';
import { cicService, CicService } from '../cic/cic.service';
import { randomUUID } from 'crypto';
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
import {
  reactionsDb,
  ReactionsDb
} from '../api-serverless/src/drops/reactions.db';
import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import {
  dropBookmarksDb,
  DropBookmarksDb
} from '../api-serverless/src/drops/drop-bookmarks.db';
import { ApiIdentity } from '../api-serverless/src/generated/models/ApiIdentity';
import { identitySubscriptionsDb } from '../api-serverless/src/identity-subscriptions/identity-subscriptions.db';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import { enums } from '../enums';
import { collections } from '../collections';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { xTdhRepository, XTdhRepository } from '../xtdh/xtdh.repository';

export class ProfilesService {
  private readonly logger = Logger.get('PROFILES_SERVICE');

  constructor(
    private readonly profilesDb: ProfilesDb,
    private readonly ratingsService: RatingsService,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly cicService: CicService,
    private readonly userGroupsDb: UserGroupsDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly notificationsDb: IdentityNotificationsDb,
    private readonly reactionsDb: ReactionsDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly xTdhRepository: XTdhRepository,
    private readonly dropBookmarksDb: DropBookmarksDb
  ) {}

  public async getProfileAndConsolidationsByIdentity(
    identity: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileAndConsolidations | null> {
    const apiIdentity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: identity },
        { connection }
      );
    if (!apiIdentity) {
      return null;
    }
    let profile: Profile | null = null;
    if (apiIdentity.id) {
      profile = {
        external_id: apiIdentity.id,
        handle: apiIdentity.handle!,
        normalised_handle: apiIdentity.normalised_handle!,
        primary_wallet: apiIdentity.primary_wallet,
        created_at: new Date(),
        created_by_wallet: apiIdentity.primary_wallet,
        updated_at: null,
        pfp_url: apiIdentity.pfp ?? undefined,
        banner_1: apiIdentity.banner1 ?? undefined,
        banner_2: apiIdentity.banner2 ?? undefined,
        classification: apiIdentity.classification
          ? (enums.resolve(
              ProfileClassification,
              apiIdentity.classification.toString()
            ) ?? ProfileClassification.PSEUDONYM)
          : ProfileClassification.PSEUDONYM,
        sub_classification: apiIdentity.sub_classification
      };
    }
    return {
      profile,
      consolidation: {
        wallets:
          apiIdentity.wallets?.map((it) => ({
            tdh: it.tdh,
            wallet: {
              address: it.wallet,
              ens: it.display.endsWith(`.eth`) ? it.display : undefined
            }
          })) ?? [],
        tdh: apiIdentity.tdh,
        consolidation_key: apiIdentity.consolidation_key,
        consolidation_display: apiIdentity.display
      },
      level: apiIdentity.level,
      cic: { cic_rating: apiIdentity.cic, contributor_count: 100 },
      rep: apiIdentity.rep,
      balance: 0,
      input_identity: identity
    };
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
    await identitiesService.bulkCreateIdentities(addresses, ctx);
    const allIdentitiesAndProfiles =
      await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
        addresses,
        ctx.connection!
      );
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
          sub_classification: null,
          xtdh: 0,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh_rate: 0,
          basetdh_rate: 0
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
        await this.mergeXTdhGrants(sourceIdentity, target, connectionHolder);
        await this.mergeIdentitySubscriptions(
          sourceIdentity,
          target,
          connectionHolder
        );
        await this.mergeReactionsStuff(
          sourceIdentity,
          target,
          connectionHolder
        );
        await this.mergeVotingStuff(sourceIdentity, target, connectionHolder);
        await this.mergeBookmarks(sourceIdentity, target, connectionHolder);
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
        await this.mergeBoosts(sourceIdentity, target, connectionHolder);
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
    const distinctGroups = collections.distinct([
      ...sourceGroups,
      ...targetGroups
    ]);
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

  private async mergeReactionsStuff(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.reactionsDb.mergeOnProfileIdChange(
      { previous_id: sourceIdentity, new_id: target },
      { connection: connectionHolder }
    );
  }

  private async mergeBoosts(
    sourceIdentity: string,
    target: string | undefined,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.identitiesDb.migrateBoosterIdsInBoosts(
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

  private async mergeBookmarks(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.dropBookmarksDb.mergeOnProfileIdChange(
      { previous_id: sourceIdentity, new_id: target },
      { connection: connectionHolder }
    );
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
    _: string,
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

  private async mergeXTdhGrants(
    source: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.xTdhRepository.migrateGrantorId(
      source,
      target,
      connectionHolder
    );
  }
}

export const profilesService = new ProfilesService(
  profilesDb,
  ratingsService,
  profileProxiesDb,
  cicService,
  userGroupsDb,
  identitiesDb,
  identityNotificationsDb,
  reactionsDb,
  dropVotingDb,
  xTdhRepository,
  dropBookmarksDb
);
