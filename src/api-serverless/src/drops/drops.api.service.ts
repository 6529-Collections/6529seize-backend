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
import { DropRater } from '../generated/models/DropRater';
import { DropRatingCategory } from '../generated/models/DropRatingCategory';
import {
  DropActivityLog,
  DropActivityLogTypeEnum
} from '../generated/models/DropActivityLog';
import { ProfileMin } from '../generated/models/ProfileMin';
import { DropPart } from '../generated/models/DropPart';
import { DropComment } from '../generated/models/DropComment';
import { Time } from '../../../time';
import {
  UserGroupsService,
  userGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';

export class DropsApiService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly profilesService: ProfilesService,
    private readonly userGroupsService: UserGroupsService
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
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(contextProfileId);
    const dropEntity = await this.dropsDb
      .findDropById(dropId, group_ids_user_is_eligible_for, connection)
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
        max_part_id
      },
      connection
    ).then((it) => it[0]);
  }

  public async findLatestDrops({
    amount,
    group_id,
    wave_id,
    serial_no_less_than,
    min_part_id,
    max_part_id,
    authenticationContext
  }: {
    group_id: string | null;
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
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        context_profile_id
      );
    if (group_id && !group_ids_user_is_eligible_for.includes(group_id)) {
      return [];
    }
    const dropEntities = await this.dropsDb.findLatestDrops({
      amount,
      serial_no_less_than,
      group_id,
      group_ids_user_is_eligible_for: group_ids_user_is_eligible_for,
      wave_id
    });
    return await this.convertToDropFulls({
      dropEntities: dropEntities,
      contextProfileId: context_profile_id,
      min_part_id,
      max_part_id
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
      max_part_id
    }: {
      dropEntities: DropEntity[];
      contextProfileId?: string;
      min_part_id: number;
      max_part_id: number;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsContextProfileCategories,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts
    } = await this.getAllDropsRelatedData(
      {
        dropIds,
        contextProfileId: contextProfileId,
        min_part_id,
        max_part_id
      },
      connection
    );
    const raterProfileIds = Object.values(dropsTopRaters)
      .map((it) => it.map((r) => r.rater_profile_id))
      .flat();
    const allProfileIds = distinct([
      ...dropEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id),
      ...raterProfileIds
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
      rating: dropsRatings[dropEntity.id]?.rating ?? 0,
      raters_count: dropsRatings[dropEntity.id]?.distinct_raters ?? 0,
      rating_categories_count:
        dropsRatings[dropEntity.id]?.distinct_categories ?? 0,
      top_raters: (dropsTopRaters[dropEntity.id] ?? [])
        .map<DropRater>((rater) => ({
          rating: rater.rating,
          profile: profilesByIds[rater.rater_profile_id]!
        }))
        .sort((a, b) => b.rating - a.rating),
      top_rating_categories: (dropsTopCategories[dropEntity.id] ?? [])
        .map<DropRatingCategory>((cat) => ({
          rating: cat.rating,
          category: cat.category
        }))
        .sort((a, b) => b.rating - a.rating),
      rating_logs_count: dropLogsStats[dropEntity.id]?.rating_logs_count ?? 0,
      context_profile_context: contextProfileId
        ? {
            categories: (dropsContextProfileCategories[dropEntity.id] ?? [])
              .map<DropRatingCategory>((cat) => ({
                category: cat.category,
                rating: cat.profile_rating
              }))
              .sort((a, b) => b.rating - a.rating),
            rating: dropsRatingsByContextProfile[dropEntity.id] ?? 0
          }
        : null
    }));
  }

  private async getAllDropsRelatedData(
    {
      dropIds,
      contextProfileId,
      min_part_id,
      max_part_id
    }: {
      dropIds: string[];
      contextProfileId?: string;
      min_part_id: number;
      max_part_id: number;
    },
    connection?: ConnectionWrapper<any>
  ) {
    const [
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsContextProfileCategories,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts
    ] = await Promise.all([
      this.dropsDb.findMentionsByDropIds(dropIds, connection),
      this.dropsDb.findReferencedNftsByDropIds(dropIds, connection),
      this.dropsDb.findMetadataByDropIds(dropIds, connection),
      this.dropsDb.findDropsTopRaters(dropIds, connection),
      this.dropsDb.findDropsTopRatingCategories(dropIds, connection),
      this.findContextProfilesCategoryRatingsForDrops(
        contextProfileId,
        dropIds,
        connection
      ),
      this.dropsDb.findDropsTotalRatingsStats(dropIds, connection),
      this.findContextProfilesTotalRatingsForDrops(
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
    return {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsContextProfileCategories,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropLogsStats,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsCommentsCounts
    };
  }

  private async findContextProfilesCategoryRatingsForDrops(
    contextProfileId: string | undefined,
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      { category: string; profile_rating: number; total_rating: number }[]
    >
  > {
    if (!contextProfileId) {
      return {};
    }
    return this.dropsDb.findDropsCategoryRatingsByProfile(
      dropIds,
      contextProfileId,
      connection
    );
  }

  private async findContextProfilesTotalRatingsForDrops(
    contextProfileId: string | undefined,
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    if (!contextProfileId) {
      return {};
    }
    return this.dropsDb.findDropsTotalRatingsByProfile(
      dropIds,
      contextProfileId,
      connection
    );
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
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(contextProfileId);
    const dropEntities = await this.dropsDb.findProfileDrops(
      param,
      group_ids_user_is_eligible_for
    );
    return await this.convertToDropFulls({
      dropEntities,
      contextProfileId,
      min_part_id: 1,
      max_part_id: 1
    });
  }

  async findAvailableCreditForRatingForProfile(
    profileId: string
  ): Promise<{ available_credit_for_rating: number }> {
    const creditLeft = await this.dropsDb.findCreditLeftForDropsForProfile({
      profileId
    });
    return { available_credit_for_rating: creditLeft };
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
  profilesService,
  userGroupsService
);
