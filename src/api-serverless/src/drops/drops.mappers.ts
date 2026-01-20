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
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { numbers } from '../../../numbers';
import { collections } from '../../../collections';
import { DropReactionsResult, reactionsDb, ReactionsDb } from './reactions.db';

export class DropsMappers {
  constructor(
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher,
    private readonly dropsDb: DropsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly dropVotingService: DropVotingService,
    private readonly reactionsDb: ReactionsDb
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
      ? enums.resolveOrThrow(ApiDropType, request.drop_type)
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
      drop_type: enums.resolveOrThrow(DropType, request.drop_type),
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
    const waveIds = dropEntities.map((it) => it.id);
    const [waveOverviews, pinnedWaveIds] = await Promise.all([
      this.wavesApiDb.getWavesByDropIds(waveIds, connection),
      this.wavesApiDb.whichOfWavesArePinnedByGivenProfile(
        {
          waveIds,
          profileId: contextProfileId
        },
        { connection }
      )
    ]);
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
            voting_credit_type: enums.resolveOrThrow(
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
            admin_drop_deletion_enabled: wave.admin_drop_deletion_enabled,
            forbid_negative_votes: wave.forbid_negative_votes,
            pinned: pinnedWaveIds.has(wave.id)
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
    const quoteIds = await this.dropsDb.getQuoteIds(rootDropIds, connection);
    const replyDropIds = dropEntities
      .map((it) => it.reply_to_drop_id)
      .filter((it) => it !== null) as string[];
    const dropIds = collections.distinct([
      ...rootDropIds,
      ...quoteIds,
      ...replyDropIds
    ]);
    const [allEntities, dropsParts] = await Promise.all([
      this.dropsDb.getDropsByIds(dropIds, connection),
      this.dropsDb.getDropsParts(dropIds, connection)
    ]);
    const allReplyDropIds = allEntities
      .map((it) => it.reply_to_drop_id)
      .filter((it) => it !== null) as string[];
    const quotedDropIds = collections.distinct(
      Object.values(dropsParts)
        .flat()
        .map((it) => it.quoted_drop_id)
        .filter((it) => it !== null) as string[]
    );
    const allDropIds = collections.distinct([
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
    const participatoryDropIds = participatoryDropEntities.map((it) => it.id);
    const [
      dropsRanks,
      submissionDropsVotingRanges,
      mentions,
      referencedNfts,
      metadata,
      dropsTopVoters,
      dropsVoteCounts,
      dropMedia,
      subscribedActions,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      weightedDropsRanks,
      weightedDropsRates,
      deletedDrops,
      dropsInWavesWhereNegativeVotesAreNotAllowed,
      dropReactions,
      boostsCount,
      boostsByAuthenticatedUser
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
      this.dropVotingDb.findDropsTopContributors(participatoryDropIds, {
        connection
      }),
      this.dropVotingDb.getTallyForDrops(
        { dropIds: participatoryDropIds },
        { connection }
      ),
      this.dropsDb.getDropMedia(allDropIds, connection),
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
      this.dropsDb.findDeletedDrops(allDropIds, connection),
      this.dropsDb.findDropIdsOfWavesWhereNegativeVotesAreNotAllowed(
        allDropIds,
        connection
      ),
      this.reactionsDb.getByDropIds(allDropIds, contextProfileId ?? null, {
        connection
      }),
      this.dropsDb.countBoostsOfGivenDrops(allDropIds, { connection }),
      contextProfileId
        ? this.dropsDb.whichOfGivenDropsAreBoostedByIdentity(
            allDropIds,
            contextProfileId,
            {
              connection
            }
          )
        : Promise.resolve(new Set<string>())
    ]);
    return {
      dropsRanks,
      submissionDropsVotingRanges,
      mentions,
      referencedNfts,
      metadata,
      dropsVoteCounts,
      dropsTopVoters,
      dropMedia,
      dropsParts,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      subscribedActions: Object.entries(subscribedActions).reduce(
        (acc, [id, actions]) => {
          acc[id] = actions.map((it) =>
            enums.resolveOrThrow(ApiDropSubscriptionTargetAction, it)
          );
          return acc;
        },
        {} as Record<string, ApiDropSubscriptionTargetAction[]>
      ),
      deletedDrops,
      allEntities,
      weightedDropsRanks,
      weightedDropsRates,
      dropsInWavesWhereNegativeVotesAreNotAllowed,
      dropReactions,
      boostsCount,
      boostsByAuthenticatedUser
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
      dropsTopVoters,
      dropMedia,
      dropsParts,
      subscribedActions,
      deletedDrops,
      dropsVoteCounts,
      allEntities,
      dropsRanks,
      winDecisions,
      winningDropsTopRaters,
      winningDropsRatersCounts,
      winningDropsRatingsByVoter,
      weightedDropsRanks,
      weightedDropsRates,
      dropsInWavesWhereNegativeVotesAreNotAllowed,
      dropReactions,
      boostsCount,
      boostsByAuthenticatedUser
    } = await this.getAllDropsRelatedData(
      {
        dropEntities: entities,
        contextProfileId
      },
      ctx.connection
    );
    const voterProfileIds = Object.values(dropsTopVoters)
      .map((it) => it.map((r) => r.voter_id))
      .flat();
    const allProfileIds = collections.distinct([
      ...allEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id),
      ...voterProfileIds,
      ...Object.values(deletedDrops).map((it) => it.author_id),
      ...Object.values(winningDropsTopRaters)
        .flat()
        .map((it) => it.voter_id)
    ]);
    const profileMins = await this.identityFetcher.getOverviewsByIds(
      allProfileIds,
      {
        authenticationContext: contextProfileId
          ? AuthenticationContext.fromProfileId(contextProfileId)
          : AuthenticationContext.notAuthenticated()
      }
    );
    const UNKNOWN_PROFILE: ApiProfileMin = {
      id: 'an-unknown-profile',
      handle: 'An unknown profile',
      banner1_color: null,
      banner2_color: null,
      pfp: null,
      cic: 0,
      rep: 0,
      tdh: 0,
      xtdh: 0,
      xtdh_rate: 0,
      tdh_rate: 0,
      level: 0,
      archived: true,
      subscribed_actions: [],
      primary_address: '',
      active_main_stage_submission_ids: [],
      winner_main_stage_drop_ids: [],
      is_wave_creator: false
    };
    const profilesByIds = allProfileIds.reduce(
      (acc, profileId) => {
        acc[profileId] = profileMins[profileId] ?? UNKNOWN_PROFILE;
        return acc;
      },
      {} as Record<string, ApiProfileMin>
    );
    return entities.map<ApiDropWithoutWave>((dropEntity) => {
      return this.toDrop({
        dropEntity,
        deletedDrops,
        profilesByIds,
        dropsParts,
        dropMedia,
        contextProfileId,
        referencedNfts,
        mentions,
        metadata,
        dropsVoteCounts,
        dropsTopVoters,
        subscribedActions,
        submissionDropsVotingRanges,
        dropsRanks,
        winDecisions,
        winningDropsTopRaters,
        winningDropsRatersCounts,
        winningDropsRatingsByVoter,
        allEntities: allEntities.reduce(
          (acc, it) => {
            acc[it.id] = it;
            return acc;
          },
          {} as Record<string, DropEntity>
        ),
        weightedDropsRanks,
        weightedDropsRates,
        dropsInWavesWhereNegativeVotesAreNotAllowed,
        dropReactions,
        boostsCount,
        boostsByAuthenticatedUser
      });
    });
  }

  private toDrop({
    dropEntity,
    deletedDrops,
    profilesByIds,
    dropsParts,
    dropMedia,
    contextProfileId,
    referencedNfts,
    mentions,
    metadata,
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
    dropsInWavesWhereNegativeVotesAreNotAllowed,
    dropReactions,
    boostsCount,
    boostsByAuthenticatedUser
  }: {
    dropEntity: DropEntity;
    deletedDrops: Record<string, DeletedDropEntity>;
    profilesByIds: Record<string, ApiProfileMin>;
    dropsParts: Record<string, DropPartEntity[]>;
    dropMedia: Record<string, DropMediaEntity[]>;
    contextProfileId: string | undefined | null;
    referencedNfts: DropReferencedNftEntity[];
    mentions: DropMentionEntity[];
    metadata: DropMetadataEntity[];
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
    weightedDropsRates: Record<string, { current: number; prediction: number }>;
    dropsInWavesWhereNegativeVotesAreNotAllowed: string[];
    dropReactions: Map<string, DropReactionsResult>;
    boostsCount: Record<string, number>;
    boostsByAuthenticatedUser: Set<string>;
  }): ApiDropWithoutWave {
    const replyToDropId = dropEntity.reply_to_drop_id;
    const dropWinDecision = winDecisions[dropEntity.id];
    const winningContext: ApiDropWinningContext | undefined = dropWinDecision
      ? {
          place: dropWinDecision.ranking,
          decision_time: dropWinDecision.decision_time,
          awards: dropWinDecision.prizes.map((prize) => ({
            type: enums.resolveOrThrow(ApiWaveOutcomeType, prize.type),
            subtype:
              enums.resolve(
                ApiWaveOutcomeSubType,
                prize.subtype as string | undefined
              ) ?? undefined,
            description: prize.description,
            credit:
              enums.resolve(
                ApiWaveOutcomeCredit,
                prize.credit as string | undefined
              ) ?? undefined,
            rep_category: prize.rep_category ?? undefined,
            amount: prize.amount ?? undefined
          }))
        }
      : undefined;
    let raters_count = 0;
    let rating = 0;
    let top_raters: ApiDropRater[] = [];
    let context_profile_context: ApiDropContextProfileContext | null = null;
    let realtime_rating = rating;
    let rating_prediction = rating;
    const contextProfileReaction =
      dropReactions.get(dropEntity.id)?.context_profile_reaction ?? null;
    if (contextProfileId) {
      context_profile_context = {
        rating: 0,
        min_rating: 0,
        max_rating: 0,
        reaction: contextProfileReaction,
        boosted: boostsByAuthenticatedUser.has(dropEntity.id)
      };
    }
    if (dropEntity.drop_type === DropType.WINNER) {
      rating = dropWinDecision.final_vote ?? 0;
      realtime_rating = rating;
      rating_prediction = rating;
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
          max_rating: winningDropsRatingsByVoter[dropEntity.id] ?? 0,
          reaction: contextProfileReaction,
          boosted: boostsByAuthenticatedUser.has(dropEntity.id)
        };
      }
    } else if (dropEntity.drop_type === DropType.PARTICIPATORY) {
      realtime_rating = dropsVoteCounts[dropEntity.id]?.tally ?? 0;
      const weightedDropRate = weightedDropsRates[dropEntity.id];
      rating = weightedDropRate?.current ?? realtime_rating;
      rating_prediction = weightedDropRate?.prediction ?? realtime_rating;
      raters_count =
        dropsVoteCounts[dropEntity.id]?.total_number_of_voters ?? 0;
      top_raters = (dropsTopVoters[dropEntity.id] ?? []).map<ApiDropRater>(
        (voter) => ({
          rating: voter.votes,
          profile: profilesByIds[voter.voter_id]
        })
      );
      if (contextProfileId) {
        let minRating = submissionDropsVotingRanges[dropEntity.id]?.min ?? 0;
        if (
          minRating < 0 &&
          dropsInWavesWhereNegativeVotesAreNotAllowed.includes(dropEntity.id)
        ) {
          minRating = 0;
        }
        context_profile_context = {
          rating: submissionDropsVotingRanges[dropEntity.id]?.current ?? 0,
          min_rating: minRating,
          max_rating: submissionDropsVotingRanges[dropEntity.id]?.max ?? 0,
          reaction: contextProfileReaction,
          boosted: boostsByAuthenticatedUser.has(dropEntity.id)
        };
      }
    }
    top_raters.sort((a, b) => b.rating - a.rating);
    const dropType = enums.resolveOrThrow(ApiDropType, dropEntity.drop_type);
    const rank: number | null =
      weightedDropsRanks[dropEntity.id] ?? dropsRanks[dropEntity.id] ?? null;

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
                  contextProfileId,
                  referencedNfts,
                  mentions,
                  metadata,
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
                  dropsInWavesWhereNegativeVotesAreNotAllowed,
                  dropReactions,
                  boostsCount,
                  boostsByAuthenticatedUser
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
                          contextProfileId,
                          referencedNfts,
                          mentions,
                          metadata,
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
                          dropsInWavesWhereNegativeVotesAreNotAllowed,
                          dropReactions,
                          boostsCount,
                          boostsByAuthenticatedUser
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
                })) ?? []
          };
        }) ?? [],
      parts_count: dropEntity.parts_count,
      created_at: dropEntity.created_at,
      updated_at: numbers.parseIntOrNull(dropEntity.updated_at),
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
      rating_prediction,
      raters_count,
      top_raters,
      context_profile_context,
      subscribed_actions: subscribedActions[dropEntity.id] ?? [],
      winning_context: winningContext,
      is_signed: !!dropEntity.signature,
      reactions: dropReactions.get(dropEntity.id)?.reactions ?? [],
      boosts: boostsCount[dropEntity.id] ?? 0,
      hide_link_preview: !!dropEntity.hide_link_preview
    };
  }
}

export const dropsMappers = new DropsMappers(
  userGroupsService,
  identityFetcher,
  dropsDb,
  wavesApiDb,
  identitySubscriptionsDb,
  dropVotingDb,
  dropVotingService,
  reactionsDb
);
