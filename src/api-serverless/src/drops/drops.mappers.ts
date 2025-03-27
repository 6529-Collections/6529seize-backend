import {
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity,
  DropType
} from '../../../entities/IDrop';
import { ConnectionWrapper } from '../../../sql-executor';
import { ApiDrop } from '../generated/models/ApiDrop';
import {
  distinct,
  isExperimentalModeOn,
  parseIntOrNull,
  resolveEnum,
  resolveEnumOrThrow
} from '../../../helpers';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiDropPart } from '../generated/models/ApiDropPart';
import { ApiDropMedia } from '../generated/models/ApiDropMedia';
import { ApiDropReferencedNFT } from '../generated/models/ApiDropReferencedNFT';
import { ApiDropMentionedUser } from '../generated/models/ApiDropMentionedUser';
import { ApiDropMetadata } from '../generated/models/ApiDropMetadata';
import { ApiDropRater } from '../generated/models/ApiDropRater';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { ApiDropSubscriptionTargetAction } from '../generated/models/ApiDropSubscriptionTargetAction';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { ApiDropWithoutWave } from '../generated/models/ApiDropWithoutWave';
import { RequestContext } from '../../../request.context';
import { AuthenticationContext } from '../../../auth-context';
import { ApiWaveMin } from '../generated/models/ApiWaveMin';
import { DeletedDropEntity } from '../../../entities/IDeletedDrop';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel
} from '../../../drops/create-or-update-drop.model';
import { ApiDropType } from '../generated/models/ApiDropType';
import { clappingDb, ClappingDb } from './clapping.db';
import { clappingService } from './clapping.service';
import { dropVotingService, DropVotingService } from './drop-voting.service';
import { dropVotingDb, DropVotingDb } from './drop-voting.db';
import { ApiWaveCreditType as WaveCreditTypeApi } from '../generated/models/ApiWaveCreditType';
import { WaveDecisionWinnerDropEntity } from '../../../entities/IWaveDecision';
import { ApiDropWinningContext } from '../generated/models/ApiDropWinningContext';
import { ApiWaveOutcomeType } from '../generated/models/ApiWaveOutcomeType';
import { ApiWaveOutcomeSubType } from '../generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeCredit } from '../generated/models/ApiWaveOutcomeCredit';
import { WinnerDropVoterVoteEntity } from '../../../entities/IWinnerDropVoterVote';
import { ApiDropContextProfileContext } from '../generated/models/ApiDropContextProfileContext';
import { Time } from '../../../time';

export class DropsMappers {
  constructor(
    private readonly userGroupsService: UserGroupsService,
    private readonly profilesService: ProfilesApiService,
    private readonly dropsDb: DropsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly clappingDb: ClappingDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly dropVotingService: DropVotingService
  ) {}

  public createDropApiToUseCaseModel({
    request,
    authorId,
    proxyId
  }: {
    request: ApiCreateDropRequest;
    authorId: string;
    proxyId?: string;
  }): CreateOrUpdateDropModel {
    const dropType = request.drop_type
      ? resolveEnumOrThrow(ApiDropType, request.drop_type)
      : ApiDropType.Chat;
    return this.updateDropApiToUseCaseModel({
      request: {
        ...request,
        drop_type: dropType
      },
      authorId,
      proxyId,
      replyTo: request.reply_to ?? null,
      waveId: request.wave_id
    });
  }

  public updateDropApiToUseCaseModel({
    request,
    authorId,
    proxyId,
    replyTo,
    waveId,
    dropId
  }: {
    request: ApiUpdateDropRequest & { drop_type: ApiDropType };
    waveId: string;
    replyTo: DropPartIdentifierModel | null;
    authorId: string;
    proxyId?: string;
    dropId?: string;
  }): CreateOrUpdateDropModel {
    return {
      author_identity: authorId,
      author_id: authorId,
      proxy_identity: proxyId,
      proxy_id: proxyId,
      drop_id: dropId ?? null,
      drop_type: resolveEnumOrThrow(DropType, request.drop_type),
      wave_id: waveId,
      reply_to: replyTo,
      title: request.title ?? null,
      parts: request.parts.map((it) => ({
        content: it.content ?? null,
        media: it.media.map((media) => ({
          url: media.url,
          mime_type: media.mime_type
        })),
        quoted_drop: it.quoted_drop
          ? {
              drop_id: it.quoted_drop.drop_id,
              drop_part_id: it.quoted_drop.drop_part_id
            }
          : null
      })),
      referenced_nfts: request.referenced_nfts.map((it) => ({
        contract: it.contract,
        token: it.token,
        name: it.name
      })),
      mentioned_users: request.mentioned_users.map((it) => ({
        handle: it.handle_in_content
      })),
      metadata: request.metadata.map((it) => ({
        data_key: it.data_key,
        data_value: it.data_value
      })),
      mentions_all: request.mentions_all ?? false,
      signature: request.signature
    };
  }

  public async convertToDropFulls(
    {
      dropEntities,
      contextProfileId
    }: {
      dropEntities: DropEntity[];
      contextProfileId?: string | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<ApiDrop[]> {
    const dWoW = await this.convertToDropsWithoutWaves(dropEntities, {
      connection,
      authenticationContext: contextProfileId
        ? AuthenticationContext.fromProfileId(contextProfileId)
        : AuthenticationContext.notAuthenticated()
    });
    const waveOverviews = await this.wavesApiDb.getWaveOverviewsByDropIds(
      dropEntities.map((it) => it.id),
      connection
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        contextProfileId ?? null
      );
    return dWoW.map<ApiDrop>((d) => {
      const wave = waveOverviews[d.id];
      const waveMin: ApiWaveMin | null = wave
        ? {
            id: wave.id,
            name: wave.name,
            picture: wave.picture,
            description_drop_id: wave.description_drop_id,
            authenticated_user_eligible_to_chat:
              wave.chat_enabled &&
              (wave.chat_group_id === null ||
                group_ids_user_is_eligible_for.includes(wave.chat_group_id)),
            authenticated_user_eligible_to_vote:
              wave.voting_group_id === null ||
              group_ids_user_is_eligible_for.includes(wave.voting_group_id),
            authenticated_user_eligible_to_participate:
              wave.participation_group_id === null ||
              group_ids_user_is_eligible_for.includes(
                wave.participation_group_id
              ),
            authenticated_user_admin:
              wave.admin_group_id !== null &&
              group_ids_user_is_eligible_for.includes(wave.admin_group_id),
            voting_credit_type: resolveEnumOrThrow(
              WaveCreditTypeApi,
              wave.voting_credit_type
            ),
            voting_period_start: wave.voting_period_start,
            voting_period_end: wave.voting_period_end,
            visibility_group_id: wave.visibility_group_id,
            chat_group_id: wave.chat_group_id,
            admin_group_id: wave.admin_group_id,
            participation_group_id: wave.participation_group_id,
            voting_group_id: wave.voting_group_id,
            admin_drop_deletion_enabled: wave.admin_drop_deletion_enabled
          }
        : null;
      return {
        ...d,
        wave: waveMin as any
      };
    });
  }

  private async getAllDropsRelatedData(
    {
      dropEntities,
      contextProfileId
    }: {
      dropEntities: DropEntity[];
      contextProfileId?: string | null;
    },
    connection?: ConnectionWrapper<any>
  ) {
    const rootDropIds = dropEntities.map((it) => it.id);
    const quoteIds = Object.values(
      await this.dropsDb.getDropsParts(rootDropIds, connection)
    )
      .flat()
      .map((it) => it.quoted_drop_id)
      .filter((it) => it !== null) as string[];
    const replyDropIds = dropEntities
      .map((it) => it.reply_to_drop_id)
      .filter((it) => it !== null) as string[];
    const dropIds = distinct([...rootDropIds, ...quoteIds, ...replyDropIds]);
    const [allEntities, dropsParts] = await Promise.all([
      this.dropsDb.getDropsByIds(dropIds, connection),
      this.dropsDb.getDropsParts(dropIds, connection)
    ]);
    const allReplyDropIds = allEntities
      .map((it) => it.reply_to_drop_id)
      .filter((it) => it !== null) as string[];
    const quotedDropIds = distinct(
      Object.values(dropsParts)
        .flat()
        .map((it) => it.quoted_drop_id)
        .filter((it) => it !== null) as string[]
    );
    const allDropIds = distinct([
      ...quotedDropIds,
      ...allReplyDropIds,
      ...dropIds
    ]);
    const winningDropIds = allEntities
      .filter((it) => it.drop_type === DropType.WINNER)
      .map((it) => it.id);
    const participatoryDropEntities = allEntities.filter(
      (it) => it.drop_type === DropType.PARTICIPATORY
    );
    const chatDropIds = allEntities
      .filter((it) => it.drop_type === DropType.CHAT)
      .map((it) => it.id);
    const participatoryDropIds = participatoryDropEntities.map((it) => it.id);
    const [
      dropsRanks,
      submissionDropsVotingRanges,
      mentions,
      referencedNfts,
      metadata,
      dropsTopClappers,
      dropsTopVoters,
      clapsLeftForContextProfile,
      dropsVoteCounts,
      dropsQuoteCounts,
      dropMedia,
      dropsRepliesCounts,
      subscribedActions,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      weightedDropsRanks,
      weightedDropsRates,
      waveEndingTimesByDropIds
    ] = await Promise.all([
      this.dropVotingDb.getParticipationDropsRealtimeRanks(
        participatoryDropIds,
        {
          connection
        }
      ),
      this.dropVotingService.findCreditLeftForVotingForDrops(
        contextProfileId,
        participatoryDropEntities,
        connection
      ),
      this.dropsDb.findMentionsByDropIds(allDropIds, connection),
      this.dropsDb.findReferencedNftsByDropIds(allDropIds, connection),
      this.dropsDb.findMetadataByDropIds(allDropIds, connection),
      this.clappingDb.findDropsTopContributors(chatDropIds, contextProfileId, {
        connection
      }),
      this.dropVotingDb.findDropsTopContributors(participatoryDropIds, {
        connection
      }),
      contextProfileId
        ? clappingService.findCreditLeftForClapping(contextProfileId)
        : Promise.resolve(0),
      this.dropVotingDb.getTallyForDrops(
        { dropIds: participatoryDropIds },
        { connection }
      ),
      this.dropsDb.getDropsQuoteCounts(
        allDropIds,
        contextProfileId,
        connection
      ),
      this.dropsDb.getDropMedia(allDropIds, connection),
      this.dropsDb.countRepliesByDropIds(
        {
          dropIds: allDropIds,
          context_profile_id: contextProfileId,
          drop_type: null
        },
        connection
      ),
      !contextProfileId
        ? Promise.resolve({} as Record<string, ActivityEventAction[]>)
        : this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets(
            {
              subscriber_id: contextProfileId,
              target_ids: dropIds,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          ),
      this.dropsDb.getWinDecisionsForDrops(winningDropIds, { connection }),
      this.dropVotingDb.getWinningDropsTopRaters(winningDropIds, {
        connection
      }),
      this.dropVotingDb.getWinningDropsRatersCount(winningDropIds, {
        connection
      }),
      !contextProfileId
        ? Promise.resolve({} as Record<string, number>)
        : this.dropVotingDb.getWinningDropsRatingsByVoter(
            winningDropIds,
            contextProfileId,
            { connection }
          ),
      this.dropVotingDb.getTimeLockedDropsWeightedVotes(participatoryDropIds, {
        connection
      }),
      this.dropVotingDb.getWeightedDropRates(participatoryDropIds, {
        connection
      }),
      this.dropsDb.getWaveEndingTimesByDropIds(dropIds, { connection })
    ]);
    const deletedDrops = await this.dropsDb.findDeletedDrops(
      allDropIds,
      connection
    );
    return {
      dropsRanks,
      submissionDropsVotingRanges,
      mentions,
      referencedNfts,
      metadata,
      dropsTopClappers,
      dropsVoteCounts,
      dropsTopVoters,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      clapsLeftForContextProfile,
      dropsRepliesCounts,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      subscribedActions: Object.entries(subscribedActions).reduce(
        (acc, [id, actions]) => {
          acc[id] = actions.map((it) =>
            resolveEnumOrThrow(ApiDropSubscriptionTargetAction, it)
          );
          return acc;
        },
        {} as Record<string, ApiDropSubscriptionTargetAction[]>
      ),
      deletedDrops,
      allEntities,
      weightedDropsRanks,
      weightedDropsRates,
      waveEndingTimesByDropIds
    };
  }

  async convertToDropsWithoutWaves(
    entities: DropEntity[],
    ctx: RequestContext
  ): Promise<ApiDropWithoutWave[]> {
    const contextProfileId = ctx.authenticationContext?.getActingAsId() ?? null;
    const {
      submissionDropsVotingRanges,
      mentions,
      referencedNfts,
      metadata,
      dropsTopClappers,
      dropsTopVoters,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsRepliesCounts,
      subscribedActions,
      deletedDrops,
      clapsLeftForContextProfile,
      dropsVoteCounts,
      allEntities,
      dropsRanks,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      weightedDropsRanks,
      weightedDropsRates,
      waveEndingTimesByDropIds
    } = await this.getAllDropsRelatedData(
      {
        dropEntities: entities,
        contextProfileId
      },
      ctx.connection
    );
    const clapperProfileIds = Object.values(dropsTopClappers)
      .map((it) => it.map((r) => r.clapper_id))
      .flat();
    const voterProfileIds = Object.values(dropsTopVoters)
      .map((it) => it.map((r) => r.voter_id))
      .flat();
    const allProfileIds = distinct([
      ...allEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id),
      ...clapperProfileIds,
      ...voterProfileIds,
      ...Object.values(deletedDrops).map((it) => it.author_id),
      ...Object.values(winningDropsTopRaters)
        .flat()
        .map((it) => it.voter_id)
    ]);
    const profileMins = await this.profilesService.getProfileMinsByIds({
      ids: allProfileIds,
      authenticatedProfileId: contextProfileId
    });
    const UNKNOWN_PROFILE: ApiProfileMin = {
      id: 'an-unknown-profile',
      handle: 'An unknown profile',
      banner1_color: null,
      banner2_color: null,
      pfp: null,
      cic: 0,
      rep: 0,
      tdh: 0,
      level: 0,
      archived: true,
      subscribed_actions: []
    };
    const profilesByIds = allProfileIds.reduce((acc, profileId) => {
      acc[profileId] = profileMins[profileId] ?? UNKNOWN_PROFILE;
      return acc;
    }, {} as Record<string, ApiProfileMin>);
    return entities.map<ApiDropWithoutWave>((dropEntity) => {
      return this.toDrop({
        dropEntity,
        deletedDrops,
        profilesByIds,
        dropsParts,
        dropMedia,
        dropsRepliesCounts,
        dropsQuoteCounts,
        contextProfileId,
        clapsLeftForContextProfile,
        referencedNfts,
        mentions,
        metadata,
        dropsTopClappers,
        dropsVoteCounts,
        dropsTopVoters,
        subscribedActions,
        submissionDropsVotingRanges,
        dropsRanks,
        winDecisions,
        winningDropsTopRaters,
        winningDropsRatersCounts,
        winningDropsRatingsByVoter,
        allEntities: allEntities.reduce((acc, it) => {
          acc[it.id] = it;
          return acc;
        }, {} as Record<string, DropEntity>),
        weightedDropsRanks,
        weightedDropsRates,
        waveEndingTimesByDropIds
      });
    });
  }

  private toDrop({
    dropEntity,
    deletedDrops,
    profilesByIds,
    dropsParts,
    dropMedia,
    dropsRepliesCounts,
    dropsQuoteCounts,
    clapsLeftForContextProfile,
    contextProfileId,
    referencedNfts,
    mentions,
    metadata,
    dropsTopClappers,
    dropsTopVoters,
    subscribedActions,
    submissionDropsVotingRanges,
    dropsVoteCounts,
    dropsRanks,
    winDecisions,
    winningDropsTopRaters,
    winningDropsRatersCounts,
    winningDropsRatingsByVoter,
    allEntities,
    weightedDropsRanks,
    weightedDropsRates,
    waveEndingTimesByDropIds
  }: {
    dropEntity: DropEntity;
    deletedDrops: Record<string, DeletedDropEntity>;
    profilesByIds: Record<string, ApiProfileMin>;
    dropsParts: Record<string, DropPartEntity[]>;
    dropMedia: Record<string, DropMediaEntity[]>;
    clapsLeftForContextProfile: number;
    dropsRepliesCounts: Record<
      string,
      Record<number, { count: number; context_profile_count: number }>
    >;
    dropsQuoteCounts: Record<
      string,
      Record<number, { total: number; by_context_profile: number | null }>
    >;
    contextProfileId: string | undefined | null;
    referencedNfts: DropReferencedNftEntity[];
    mentions: DropMentionEntity[];
    metadata: DropMetadataEntity[];
    dropsTopClappers: Record<
      string,
      {
        claps: number;
        clapper_id: string;
        total_clappers: number;
        total_claps: number;
      }[]
    >;
    dropsTopVoters: Record<string, { votes: number; voter_id: string }[]>;
    dropsVoteCounts: Record<
      string,
      { tally: number; total_number_of_voters: number }
    >;
    subscribedActions: Record<string, ApiDropSubscriptionTargetAction[]>;
    submissionDropsVotingRanges: Record<
      string,
      { min: number; max: number; current: number }
    >;
    dropsRanks: Record<string, number>;
    winDecisions: Record<string, WaveDecisionWinnerDropEntity>;
    winningDropsTopRaters: Record<string, WinnerDropVoterVoteEntity[]>;
    winningDropsRatersCounts: Record<string, number>;
    winningDropsRatingsByVoter: Record<string, number>;
    allEntities: Record<string, DropEntity>;
    weightedDropsRanks: Record<string, number>;
    weightedDropsRates: Record<string, number>;
    waveEndingTimesByDropIds: Record<string, number>;
  }): ApiDropWithoutWave {
    const replyToDropId = dropEntity.reply_to_drop_id;
    const dropWinDecision = winDecisions[dropEntity.id];
    const winningContext: ApiDropWinningContext | undefined = dropWinDecision
      ? {
          place: dropWinDecision.ranking,
          decision_time: dropWinDecision.decision_time,
          awards: dropWinDecision.prizes.map((prize) => ({
            type: resolveEnumOrThrow(ApiWaveOutcomeType, prize.type),
            subtype:
              resolveEnum(
                ApiWaveOutcomeSubType,
                prize.subtype as string | undefined
              ) ?? undefined,
            description: prize.description,
            credit:
              resolveEnum(
                ApiWaveOutcomeCredit,
                prize.credit as string | undefined
              ) ?? undefined,
            rep_category: prize.rep_category ?? undefined,
            amount: prize.amount ?? undefined
          }))
        }
      : undefined;
    const dropTopClappers = dropsTopClappers[dropEntity.id];
    let raters_count = dropTopClappers?.at(0)?.total_clappers ?? 0;
    let rating = dropTopClappers?.at(0)?.total_claps ?? 0;
    let top_raters = (dropTopClappers ?? []).map<ApiDropRater>((rater) => ({
      rating: rater.claps,
      profile: profilesByIds[rater.clapper_id]
    }));
    let context_profile_context: ApiDropContextProfileContext | null = null;
    let realtime_rating = rating;
    if (contextProfileId) {
      const clapsByClapper =
        dropTopClappers?.find((cl) => cl.clapper_id === contextProfileId)
          ?.claps ?? 0;
      context_profile_context = {
        rating: clapsByClapper,
        min_rating: clapsByClapper - clapsLeftForContextProfile,
        max_rating: clapsByClapper + clapsLeftForContextProfile
      };
    }
    if (dropEntity.drop_type === DropType.WINNER) {
      rating = dropWinDecision.final_vote ?? 0;
      realtime_rating = rating;
      raters_count = winningDropsRatersCounts[dropEntity.id] ?? 0;
      top_raters = (
        winningDropsTopRaters[dropEntity.id] ?? []
      ).map<ApiDropRater>((voter) => ({
        rating: voter.votes,
        profile: profilesByIds[voter.voter_id]
      }));
      if (contextProfileId) {
        context_profile_context = {
          rating: winningDropsRatingsByVoter[dropEntity.id] ?? 0,
          min_rating: winningDropsRatingsByVoter[dropEntity.id] ?? 0,
          max_rating: winningDropsRatingsByVoter[dropEntity.id] ?? 0
        };
      }
    } else if (dropEntity.drop_type === DropType.PARTICIPATORY) {
      realtime_rating = dropsVoteCounts[dropEntity.id].tally ?? 0;
      rating = weightedDropsRates[dropEntity.id] ?? realtime_rating;
      raters_count =
        dropsVoteCounts[dropEntity.id]?.total_number_of_voters ?? 0;
      top_raters = (dropsTopVoters[dropEntity.id] ?? []).map<ApiDropRater>(
        (voter) => ({
          rating: voter.votes,
          profile: profilesByIds[voter.voter_id]
        })
      );
      if (contextProfileId) {
        context_profile_context = {
          rating: submissionDropsVotingRanges[dropEntity.id]?.current ?? 0,
          min_rating: submissionDropsVotingRanges[dropEntity.id]?.min ?? 0,
          max_rating: submissionDropsVotingRanges[dropEntity.id]?.max ?? 0
        };
      }
    }
    top_raters.sort((a, b) => b.rating - a.rating);
    let dropType = resolveEnumOrThrow(ApiDropType, dropEntity.drop_type);
    let rank: number | null =
      weightedDropsRanks[dropEntity.id] ?? dropsRanks[dropEntity.id] ?? null;
    if (!isExperimentalModeOn()) {
      const waveEndingTime = waveEndingTimesByDropIds[dropEntity.id];
      const waveHasEnded =
        waveEndingTime && waveEndingTime > Time.currentMillis();
      if (!waveHasEnded) {
        if (dropType === ApiDropType.Participatory) {
          rank = null;
        } else if (dropType === ApiDropType.Winner) {
          rank = winningContext?.place ?? null;
        }
      }
      if (dropType === ApiDropType.Winner) {
        dropType = ApiDropType.Participatory;
      }
    }
    return {
      id: dropEntity.id,
      serial_no: dropEntity.serial_no,
      drop_type: dropType,
      rank,
      reply_to: replyToDropId
        ? {
            is_deleted: !!deletedDrops[replyToDropId],
            drop_id: replyToDropId,
            drop_part_id: dropEntity.reply_to_part_id ?? 0,
            drop: allEntities[replyToDropId]
              ? this.toDrop({
                  dropEntity: allEntities[replyToDropId],
                  deletedDrops,
                  profilesByIds,
                  dropsParts,
                  dropMedia,
                  clapsLeftForContextProfile,
                  dropsRepliesCounts,
                  dropsQuoteCounts,
                  contextProfileId,
                  referencedNfts,
                  mentions,
                  metadata,
                  dropsTopClappers,
                  dropsTopVoters,
                  dropsVoteCounts,
                  subscribedActions,
                  submissionDropsVotingRanges,
                  dropsRanks,
                  allEntities,
                  winDecisions,
                  winningDropsTopRaters,
                  winningDropsRatersCounts,
                  winningDropsRatingsByVoter,
                  weightedDropsRanks,
                  weightedDropsRates,
                  waveEndingTimesByDropIds
                })
              : undefined
          }
        : undefined,
      author: profilesByIds[dropEntity.author_id],
      title: dropEntity.title,
      parts:
        dropsParts[dropEntity.id]?.map<ApiDropPart>((it) => {
          const quotedDropId = it.quoted_drop_id;
          return {
            content: it.content,
            quoted_drop:
              quotedDropId && it.quoted_drop_part_id
                ? {
                    is_deleted: !!deletedDrops[quotedDropId],
                    drop_id: quotedDropId,
                    drop_part_id: it.quoted_drop_part_id,
                    drop: allEntities[quotedDropId]
                      ? this.toDrop({
                          dropEntity: allEntities[quotedDropId],
                          deletedDrops,
                          profilesByIds,
                          dropsParts,
                          dropMedia,
                          dropsRepliesCounts,
                          dropsQuoteCounts,
                          clapsLeftForContextProfile,
                          contextProfileId,
                          referencedNfts,
                          mentions,
                          metadata,
                          dropsTopClappers,
                          dropsVoteCounts,
                          dropsTopVoters,
                          subscribedActions,
                          submissionDropsVotingRanges,
                          dropsRanks,
                          allEntities,
                          winDecisions,
                          winningDropsTopRaters,
                          winningDropsRatersCounts,
                          winningDropsRatingsByVoter,
                          weightedDropsRanks,
                          weightedDropsRates,
                          waveEndingTimesByDropIds
                        })
                      : undefined
                  }
                : null,
            part_id: it.drop_part_id,
            media:
              (dropMedia[dropEntity.id] ?? [])
                .filter((m) => m.drop_part_id === it.drop_part_id)
                .map<ApiDropMedia>((it) => ({
                  url: it.url,
                  mime_type: it.mime_type
                })) ?? [],
            replies_count:
              dropsRepliesCounts[it.drop_id]?.[it.drop_part_id]?.count ?? 0,
            quotes_count:
              dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]?.total ?? 0,
            context_profile_context: contextProfileId
              ? {
                  replies_count:
                    dropsRepliesCounts[it.drop_id]?.[it.drop_part_id]
                      ?.context_profile_count ?? 0,
                  quotes_count:
                    dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]
                      ?.by_context_profile ?? 0
                }
              : null
          };
        }) ?? [],
      parts_count: dropEntity.parts_count,
      created_at: dropEntity.created_at,
      updated_at: parseIntOrNull(dropEntity.updated_at),
      referenced_nfts: referencedNfts
        .filter((it) => it.drop_id === dropEntity.id)
        .map<ApiDropReferencedNFT>((it) => ({
          contract: it.contract,
          token: it.token,
          name: it.name
        })),
      mentioned_users: mentions
        .filter((it) => it.drop_id === dropEntity.id)
        .map<ApiDropMentionedUser>((it) => ({
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content,
          current_handle: profilesByIds[it.mentioned_profile_id]?.handle ?? null
        })),
      metadata: metadata
        .filter((it) => it.drop_id === dropEntity.id)
        .map<ApiDropMetadata>((it) => ({
          data_key: it.data_key,
          data_value: it.data_value
        })),
      rating,
      realtime_rating,
      raters_count,
      top_raters,
      context_profile_context,
      subscribed_actions: subscribedActions[dropEntity.id] ?? [],
      winning_context: winningContext,
      is_signed: !!dropEntity.signature
    };
  }
}

export const dropsMappers = new DropsMappers(
  userGroupsService,
  profilesApiService,
  dropsDb,
  wavesApiDb,
  identitySubscriptionsDb,
  clappingDb,
  dropVotingDb,
  dropVotingService
);
