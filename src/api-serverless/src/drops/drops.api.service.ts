import { dropsDb, DropsDb } from '../../../drops/drops.db';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { ConnectionWrapper } from '../../../sql-executor';
import { NotFoundException } from '../../../exceptions';
import { DropEntity } from '../../../entities/IDrop';
import { distinct } from '../../../helpers';
import { DropActivityLogsQuery } from './drops.routes';
import { Page } from '../page-request';
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

export class DropsApiService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly profilesService: ProfilesService
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      contextProfileId
    }: {
      dropId: string;
      contextProfileId?: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop> {
    const dropEntity = await this.dropsDb
      .findDropById(dropId, connection)
      .then((drop) => {
        if (!drop) {
          throw new NotFoundException(`Drop ${dropId} not found`);
        }
        return drop;
      });
    return this.convertToDropFulls(
      { dropEntities: [dropEntity], contextProfileId: contextProfileId },
      connection
    ).then((it) => it[0]);
  }

  public async findLatestDrops({
    amount,
    curation_criteria_id,
    serial_no_less_than,
    root_drop_id,
    context_profile_id
  }: {
    curation_criteria_id: string | null;
    serial_no_less_than: number | null;
    root_drop_id: string | null;
    amount: number;
    context_profile_id?: string;
  }): Promise<Drop[]> {
    const dropEntities = await this.dropsDb.findLatestDropsGroupedInStorms({
      amount,
      serial_no_less_than,
      curation_criteria_id,
      root_drop_id
    });
    return await this.convertToDropFulls({
      dropEntities: dropEntities,
      contextProfileId: context_profile_id
    });
  }

  private async convertToDropFulls(
    {
      dropEntities,
      contextProfileId
    }: {
      dropEntities: (DropEntity & { max_storm_sequence: number })[];
      contextProfileId?: string;
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
      dropMedia
    } = await this.getAllDropsRelatedData(
      {
        dropIds,
        contextProfileId: contextProfileId
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
    return dropEntities.map((dropEntity) => ({
      id: dropEntity.id,
      serial_no: dropEntity.serial_no,
      author: profilesByIds[dropEntity.author_id]!,
      title: dropEntity.title,
      content: dropEntity.content,
      created_at: dropEntity.created_at,
      root_drop_id: dropEntity.root_drop_id,
      storm_sequence: dropEntity.storm_sequence,
      max_storm_sequence: dropEntity.max_storm_sequence,
      quoted_drop_id: dropEntity.quoted_drop_id,
      media:
        dropMedia[dropEntity.id]?.map<DropMedia>((it) => ({
          url: it.url,
          mime_type: it.mime_type
        })) ?? [],
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
      discussion_comments_count:
        dropLogsStats[dropEntity.id]?.discussion_comments_count ?? 0,
      rating_logs_count: dropLogsStats[dropEntity.id]?.rating_logs_count ?? 0,

      quotes_count: dropsQuoteCounts[dropEntity.id]?.total ?? 0,
      context_profile_context: contextProfileId
        ? {
            categories: (dropsContextProfileCategories[dropEntity.id] ?? [])
              .map<DropRatingCategory>((cat) => ({
                category: cat.category,
                rating: cat.profile_rating
              }))
              .sort((a, b) => b.rating - a.rating),
            rating: dropsRatingsByContextProfile[dropEntity.id] ?? 0,
            discussion_comments_count:
              dropLogsStats[dropEntity.id]
                ?.context_profile_discussion_comments_count ?? 0,
            quotes_count:
              dropsQuoteCounts[dropEntity.id]?.by_context_profile ?? 0
          }
        : null
    }));
  }

  private async getAllDropsRelatedData(
    {
      dropIds,
      contextProfileId
    }: { dropIds: string[]; contextProfileId?: string },
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
      dropMedia
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
      this.dropsDb.getDropsQuoteCounts(dropIds, contextProfileId, connection),
      this.dropsDb.getDropMedia(dropIds, connection)
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
      dropMedia
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
    contextProfileId?: string;
  }): Promise<Drop[]> {
    const dropEntities = await this.dropsDb.findProfileRootDrops(param);
    return await this.convertToDropFulls({
      dropEntities,
      contextProfileId: param.contextProfileId
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

  async findDiscussionComments(
    query: DropActivityLogsQuery
  ): Promise<Page<DropActivityLog>> {
    const [comments, count] = await Promise.all([
      this.dropsDb.findDropActivityLogByDropId(query),
      this.dropsDb.countDiscussionCommentsByDropId(
        query.drop_id,
        query.log_type
      )
    ]);
    const commentAuthorIds = comments.map((it) => it.profile_id);
    const profileMins = await this.profilesService.getProfileMinsByIds(
      commentAuthorIds
    );
    return {
      count,
      page: query.page,
      next: comments.length === query.page_size,
      data: comments.map((comment) => ({
        ...comment,
        target_id: comment.target_id!,
        type: comment.type as unknown as DropActivityLogTypeEnum,
        author:
          (profileMins.find(
            (it) => it.id === comment.profile_id
          ) as ProfileMin) ?? null
      }))
    };
  }

  async commentDrop(commentRequest: {
    drop_id: string;
    content: string;
    author_id: string;
  }): Promise<DropActivityLog> {
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
            `Something went wrong. Couldnt't find the comment that was just inserted`
          );
        }
        const authorProfile = await this.profilesService
          .getProfileMinsByIds([comment.profile_id])
          .then((it) => it[0] ?? null);
        return {
          ...comment,
          target_id: comment.target_id!,
          type: comment.type as unknown as DropActivityLogTypeEnum,
          author: authorProfile as ProfileMin
        };
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return comment;
  }
}

export const dropsService = new DropsApiService(dropsDb, profilesService);
