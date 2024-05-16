import { dropsDb, DropsDb } from '../../../drops/drops.db';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { ConnectionWrapper } from '../../../sql-executor';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { DropEntity } from '../../../entities/IDrop';
import { distinct } from '../../../helpers';
import { DropActivityLogsQuery } from './drops.routes';
import { Page, PageSortDirection } from '../page-request';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Drop } from '../generated/models/Drop';
import { DropMentionedUser } from '../generated/models/DropMentionedUser';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { DropMedia } from '../generated/models/DropMedia';
import { DropMetadata } from '../generated/models/DropMetadata';
import {
  DropActivityLog,
  DropActivityLogTypeEnum
} from '../generated/models/DropActivityLog';
import { ProfileMin } from '../generated/models/ProfileMin';
import { DropPart } from '../generated/models/DropPart';
import { DropComment } from '../generated/models/DropComment';
import { Time } from '../../../time';
import {
  CommunityMemberCriteriaService,
  communityMemberCriteriaService
} from '../community-members/community-member-criteria.service';
import { AuthenticationContext } from '../../../auth-context';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { dropVotingDb, DropVotingDb } from './drop.voting.db';
import { DropVoter } from '../generated/models/DropVoter';
import { WaveCreditType, WaveScopeType } from '../../../entities/IWave';

export class DropsApiService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly profilesService: ProfilesService,
    private readonly communityMemberCriteriaService: CommunityMemberCriteriaService
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      authenticationContext,
      min_part_id,
      max_part_id
    }: {
      dropId: string;
      authenticationContext: AuthenticationContext;
      min_part_id: number;
      max_part_id: number;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop> {
    const contextProfileId = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const criteriasUserIsEligible =
      await this.communityMemberCriteriaService.getCriteriaIdsUserIsEligibleFor(
        contextProfileId
      );
    const dropEntity = await this.dropsDb
      .findDropById(dropId, criteriasUserIsEligible, connection)
      .then(async (drop) => {
        if (!drop) {
          throw new NotFoundException(`Drop ${dropId} not found`);
        }

        return drop;
      });
    return this.convertToDropFulls(
      {
        dropEntities: [dropEntity],
        contextProfileId: contextProfileId,
        min_part_id,
        max_part_id,
        criteriasUserIsEligible
      },
      connection
    ).then((it) => it[0]);
  }

  public async findLatestDrops({
    amount,
    curation_criteria_id,
    wave_id,
    serial_no_less_than,
    min_part_id,
    max_part_id,
    authenticationContext
  }: {
    curation_criteria_id: string | null;
    serial_no_less_than: number | null;
    wave_id: string | null;
    min_part_id: number;
    max_part_id: number;
    amount: number;
    authenticationContext: AuthenticationContext;
  }): Promise<Drop[]> {
    const context_profile_id = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const eligible_curations =
      await this.communityMemberCriteriaService.getCriteriaIdsUserIsEligibleFor(
        context_profile_id
      );
    if (
      curation_criteria_id &&
      !eligible_curations.includes(curation_criteria_id)
    ) {
      return [];
    }
    const dropEntities = await this.dropsDb.findLatestDrops({
      amount,
      serial_no_less_than,
      curation_criteria_id,
      eligible_curations,
      wave_id
    });
    return await this.convertToDropFulls({
      dropEntities: dropEntities,
      contextProfileId: context_profile_id,
      min_part_id,
      max_part_id,
      criteriasUserIsEligible: eligible_curations
    });
  }

  private getDropsReadContextProfileId(
    authenticationContext: AuthenticationContext
  ): string {
    const context_profile_id = authenticationContext.getActingAsId();
    if (!context_profile_id) {
      throw new ForbiddenException(
        `Please create a profile before browsing drops`
      );
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Profile ${context_profile_id} hasn't given profile ${authenticationContext.authenticatedProfileId} right to read waves`
      );
    }
    return context_profile_id;
  }

  private async convertToDropFulls(
    {
      dropEntities,
      contextProfileId,
      min_part_id,
      max_part_id,
      criteriasUserIsEligible
    }: {
      dropEntities: DropEntity[];
      contextProfileId?: string;
      min_part_id: number;
      max_part_id: number;
      criteriasUserIsEligible: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const {
      mentions,
      referencedNfts,
      metadata,
      dropsTopVoters,
      dropsVotes,
      dropsVotesByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts,
      ratesCredits
    } = await this.getAllDropsRelatedData(
      {
        dropIds,
        contextProfileId: contextProfileId,
        min_part_id,
        max_part_id,
        criteriasUserIsEligible
      },
      connection
    );
    const voterProfileIds = Object.values(dropsTopVoters)
      .map((it) => it.map((r) => r.voter_id))
      .flat();
    const allProfileIds = distinct([
      ...dropEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id),
      ...voterProfileIds
    ]);
    const profileMins = await this.profilesService.getProfileMinsByIds(
      allProfileIds
    );
    const profilesByIds = allProfileIds.reduce((acc, profileId) => {
      acc[profileId] = (profileMins.find(
        (it) => it.id === profileId
      ) as ProfileMin) ?? {
        id: 'an-unknown-profile',
        handle: 'An unknown profile',
        pfp: null,
        cic: 0,
        rep: 0,
        tdh: 0,
        level: 0,
        archived: true
      };
      return acc;
    }, {} as Record<string, ProfileMin>);
    return dropEntities.map<Drop>((dropEntity) => ({
      id: dropEntity.id,
      serial_no: dropEntity.serial_no,
      wave_id: dropEntity.wave_id,
      author: profilesByIds[dropEntity.author_id]!,
      title: dropEntity.title,
      parts:
        dropsParts[dropEntity.id]?.map<DropPart>((it) => ({
          content: it.content,
          quoted_drop:
            it.quoted_drop_id && it.quoted_drop_part_id
              ? {
                  drop_id: it.quoted_drop_id,
                  drop_part_id: it.quoted_drop_part_id
                }
              : null,
          part_id: it.drop_part_id,
          media:
            (dropMedia[dropEntity.id] ?? [])
              .filter((m) => m.drop_part_id === it.drop_part_id)
              .map<DropMedia>((it) => ({
                url: it.url,
                mime_type: it.mime_type
              })) ?? [],
          discussion_comments_count:
            dropsCommentsCounts[it.drop_id]?.[it.drop_part_id]?.count ?? 0,
          quotes_count:
            dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]?.total ?? 0,
          context_profile_context: contextProfileId
            ? {
                discussion_comments_count:
                  dropsCommentsCounts[it.drop_id]?.[it.drop_part_id]
                    ?.context_profile_count ?? 0,
                quotes_count:
                  dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]
                    ?.by_context_profile ?? 0
              }
            : null
        })) ?? [],
      parts_count: dropEntity.parts_count,
      created_at: dropEntity.created_at,
      referenced_nfts: referencedNfts
        .filter((it) => it.drop_id === dropEntity.id)
        .map<DropReferencedNFT>((it) => ({
          contract: it.contract,
          token: it.token,
          name: it.name
        })),
      mentioned_users: mentions
        .filter((it) => it.drop_id === dropEntity.id)
        .map<DropMentionedUser>((it) => ({
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content,
          current_handle: profilesByIds[it.mentioned_profile_id]?.handle ?? null
        })),
      metadata: metadata
        .filter((it) => it.drop_id === dropEntity.id)
        .map<DropMetadata>((it) => ({
          data_key: it.data_key,
          data_value: it.data_value
        })),
      vote: dropsVotes[dropEntity.id]?.vote ?? 0,
      voters_count: dropsVotes[dropEntity.id]?.cnt ?? 0,
      top_voters: (dropsTopVoters[dropEntity.id] ?? [])
        .map<DropVoter>((voter) => ({
          vote: voter.vote,
          profile: profilesByIds[voter.voter_id]!
        }))
        .sort((a, b) => b.vote - a.vote),
      voting_logs_count: dropLogsStats[dropEntity.id]?.rating_logs_count ?? 0,
      context_profile_context: contextProfileId
        ? {
            vote: dropsVotesByContextProfile[dropEntity.id] ?? 0,
            total_credit: ratesCredits[dropEntity.id] ?? 0
          }
        : null
    }));
  }

  private async getAllDropsRelatedData(
    {
      dropIds,
      contextProfileId,
      min_part_id,
      max_part_id,
      criteriasUserIsEligible
    }: {
      dropIds: string[];
      contextProfileId: string;
      min_part_id: number;
      max_part_id: number;
      criteriasUserIsEligible: string[];
    },
    connection?: ConnectionWrapper<any>
  ) {
    const [
      allProfileIncomningReps,
      profileTdh,
      dropsWaves,
      mentions,
      referencedNfts,
      metadata,
      dropsTopVoters,
      dropsVotes,
      dropsVotesByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts
    ] = await Promise.all([
      this.profilesService.getAllProfileIncomingReps(contextProfileId),
      this.profilesService.getProfileTdh(contextProfileId),
      this.dropsDb.findDropsWaves(dropIds, connection),
      this.dropsDb.findMentionsByDropIds(dropIds, connection),
      this.dropsDb.findReferencedNftsByDropIds(dropIds, connection),
      this.dropsDb.findMetadataByDropIds(dropIds, connection),
      this.dropVotingDb.findTopVoters(dropIds, connection),
      this.dropVotingDb.findDropsTotalRatingsStats(dropIds, connection),
      this.dropVotingDb.findVotesForVoterAndDrops(
        contextProfileId,
        dropIds,
        connection
      ),
      this.dropsDb.getDropLogsStats(
        { dropIds, profileId: contextProfileId },
        connection
      ),
      this.dropsDb.getDropsQuoteCounts(
        dropIds,
        contextProfileId,
        min_part_id,
        max_part_id,
        connection
      ),
      this.dropsDb.getDropMedia(dropIds, min_part_id, max_part_id, connection),
      this.dropsDb.getDropsParts(dropIds, min_part_id, max_part_id, connection),
      this.dropsDb.countDiscussionCommentsByDropIds(
        { dropIds, context_profile_id: contextProfileId },
        connection
      )
    ]);
    const ratesCredits = dropIds.reduce((acc, dropId) => {
      const dropWave = dropsWaves[dropId];
      if (
        dropWave.visibility_scope_type === WaveScopeType.CURATED &&
        !criteriasUserIsEligible.includes(dropWave.visibility_scope_curation_id)
      ) {
        acc[dropId] = 0;
        return acc;
      }
      if (dropWave.voting_credit_type === WaveCreditType.TDH) {
        acc[dropId] = profileTdh;
        return acc;
      } else if (dropWave.voting_credit_type === WaveCreditType.REP) {
        const creditCategory = dropWave.voting_credit_category;
        const creditor = dropWave.voting_credit_creditor;
        allProfileIncomningReps
          .filter(
            (it) =>
              (!creditCategory || it.matter_category === creditCategory) &&
              (!creditor || it.rater_profile_id === creditor)
          )
          .reduce((acc, rep) => {
            return acc + rep.rating;
          }, 0);
      } else if (dropWave.voting_credit_type === WaveCreditType.UNIQUE) {
        acc[dropId] = 1;
      } else {
        acc[dropId] = 0;
      }
      acc[dropId] = profileTdh;
      return acc;
    }, {} as Record<string, number>);
    return {
      ratesCredits,
      mentions,
      referencedNfts,
      metadata,
      dropsTopVoters,
      dropsVotes,
      dropsVotesByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts
    };
  }

  async findProfilesLatestDrops(param: {
    amount: number;
    profile_id: string;
    serial_no_less_than: number | null;
    authenticationContext: AuthenticationContext;
  }): Promise<Drop[]> {
    const contextProfileId = this.getDropsReadContextProfileId(
      param.authenticationContext
    );
    const criteriasUserIsEligible =
      await this.communityMemberCriteriaService.getCriteriaIdsUserIsEligibleFor(
        contextProfileId
      );
    const dropEntities = await this.dropsDb.findProfileDrops(
      param,
      criteriasUserIsEligible
    );
    return await this.convertToDropFulls({
      dropEntities,
      contextProfileId,
      min_part_id: 1,
      max_part_id: 1,
      criteriasUserIsEligible
    });
  }

  async findLogs(query: DropActivityLogsQuery): Promise<Page<DropActivityLog>> {
    const [logs, count] = await Promise.all([
      this.dropsDb.findLogsByDropId(query),
      this.dropsDb
        .countLogsByDropIds([query.drop_id], query.log_type)
        .then((it) => it[query.drop_id] ?? 0)
    ]);
    const commentAuthorIds = logs.map((it) => it.profile_id);
    const profileMins = await this.profilesService.getProfileMinsByIds(
      commentAuthorIds
    );
    return {
      count,
      page: query.page,
      next: logs.length === query.page_size,
      data: logs.map((log) => ({
        ...log,
        created_at: Time.fromDate(log.created_at).toMillis(),
        target_id: log.target_id!,
        type: log.type as unknown as DropActivityLogTypeEnum,
        author:
          (profileMins.find((it) => it.id === log.profile_id) as ProfileMin) ??
          null
      }))
    };
  }

  async commentDrop(commentRequest: {
    drop_id: string;
    drop_part_id: number;
    comment: string;
    author_id: string;
  }): Promise<DropComment> {
    const comment = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const commentId = await this.dropsDb.insertDiscussionComment(
          commentRequest,
          connection
        );
        const comment = await this.dropsDb.findDiscussionCommentById(
          commentId,
          connection
        );
        if (!comment) {
          throw new Error(
            `Something went wrong. Couldn't find the comment that was just inserted`
          );
        }
        const authorProfile = await this.profilesService
          .getProfileMinsByIds([comment.author_id])
          .then((it) => it[0] ?? null);
        return {
          id: comment.id,
          author: authorProfile as ProfileMin,
          comment: comment.comment,
          created_at: comment.created_at
        };
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return comment;
  }

  async findDropPartComments(param: {
    sort_direction: PageSortDirection;
    drop_id: string;
    drop_part_id: number;
    sort: string;
    page: number;
    page_size: number;
  }): Promise<Page<DropComment>> {
    const count = await this.dropsDb
      .countDiscussionCommentsByDropIds({ dropIds: [param.drop_id] })
      .then(
        (result) => result[param.drop_id]?.[param.drop_part_id]?.count ?? 0
      );
    const comments = await this.dropsDb.findDiscussionCommentsByDropId(param);
    const relatedProfiles = await this.profilesService.getProfileMinsByIds(
      distinct(comments.map((it) => it.author_id))
    );
    return {
      count,
      page: param.page,
      next: count > param.page_size * param.page,
      data: comments.map((comment) => ({
        id: comment.id,
        comment: comment.comment,
        created_at: comment.created_at,
        author: relatedProfiles.find(
          (profile) => profile.id === comment.author_id
        )! as unknown as ProfileMin
      }))
    };
  }
}

export const dropsService = new DropsApiService(
  dropsDb,
  dropVotingDb,
  profilesService,
  communityMemberCriteriaService
);
