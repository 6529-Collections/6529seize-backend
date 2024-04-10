import { dropsDb, DropsDb } from './drops.db';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { ConnectionWrapper } from '../sql-executor';
import { DropActivityLog, DropFull } from './drops.types';
import { NotFoundException } from '../exceptions';
import { ProfileMin } from '../profiles/profile-min';
import { Drop } from '../entities/IDrop';
import { distinct } from '../helpers';
import { DropActivityLogsQuery } from '../api-serverless/src/drops/drops.routes';
import { Page } from '../api-serverless/src/page-request';
import { giveReadReplicaTimeToCatchUp } from '../api-serverless/src/api-helpers';

export class DropsService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly profilesService: ProfilesService
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      inputProfileId
    }: {
      dropId: number;
      inputProfileId?: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<DropFull> {
    const dropEntity = await this.dropsDb
      .findDropById(dropId, connection)
      .then((drop) => {
        if (!drop) {
          throw new NotFoundException(`Drop ${dropId} not found`);
        }
        return drop;
      });
    return this.convertToDropFulls(
      { dropEntities: [dropEntity], inputProfileId },
      connection
    ).then((it) => it[0]);
  }

  public async findLatestDrops({
    amount,
    curation_criteria_id,
    id_less_than,
    root_drop_id,
    input_profile_id
  }: {
    curation_criteria_id: string | null;
    id_less_than: number | null;
    root_drop_id: number | null;
    amount: number;
    input_profile_id?: string;
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findLatestDropsGroupedInStorms({
      amount,
      id_less_than,
      curation_criteria_id,
      root_drop_id
    });
    return await this.convertToDropFulls({
      dropEntities: dropEntities,
      inputProfileId: input_profile_id
    });
  }

  private async convertToDropFulls(
    {
      dropEntities,
      inputProfileId
    }: {
      dropEntities: (Drop & { max_storm_sequence: number })[];
      inputProfileId?: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<DropFull[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsInputProfileCategories,
      dropsRatings,
      dropsRatingsByInputProfile,
      dropLogsStats,
      dropsQuoteCounts
    } = await this.getAllDropsRelatedData(
      {
        dropIds,
        inputProfileId
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
    const missingProfileIds = allProfileIds.filter(
      (it) => !profileMins.some((profile) => profile.id === it)
    );
    const profileArchiveLatests =
      await this.profilesService.getNewestVersionOfArchivedProfileHandles(
        missingProfileIds
      );
    const profilesByIds = allProfileIds.reduce((acc, profileId) => {
      const activeProfile = profileMins.find((it) => it.id === profileId);
      let profileMin = activeProfile;
      if (!profileMin) {
        const archivedProfile = profileArchiveLatests.find(
          (it) => it.external_id === profileId
        );
        if (archivedProfile) {
          profileMin = {
            id: archivedProfile.external_id,
            handle: archivedProfile.handle,
            pfp: null,
            cic: 0,
            rep: 0,
            tdh: 0,
            level: 0
          };
        } else {
          profileMin = {
            id: 'an-unknown-profile',
            handle: 'An unknown profile',
            pfp: null,
            cic: 0,
            rep: 0,
            tdh: 0,
            level: 0
          };
        }
      }
      acc[profileId] = {
        profile: profileMin,
        archived: !activeProfile
      };
      return acc;
    }, {} as Record<string, { profile: ProfileMin; archived: boolean }>);
    return dropEntities.map((dropEntity) => ({
      id: dropEntity.id,
      author: profilesByIds[dropEntity.author_id].profile,
      author_archived: profilesByIds[dropEntity.author_id]!.archived,
      title: dropEntity.title,
      content: dropEntity.content,
      created_at: dropEntity.created_at,
      root_drop_id: dropEntity.root_drop_id,
      storm_sequence: dropEntity.storm_sequence,
      max_storm_sequence: dropEntity.max_storm_sequence,
      quoted_drop_id: dropEntity.quoted_drop_id,
      media_url: dropEntity.media_url,
      media_mime_type: dropEntity.media_mime_type,
      referenced_nfts: referencedNfts.filter(
        (it) => it.drop_id === dropEntity.id
      ),
      mentioned_users: mentions
        .filter((it) => it.drop_id === dropEntity.id)
        .map((it) => ({
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content,
          current_handle:
            profilesByIds[it.mentioned_profile_id]?.profile.handle ?? null
        })),
      metadata: metadata.filter((it) => it.drop_id === dropEntity.id),
      rep: dropsRatings[dropEntity.id]?.rating ?? 0,
      total_number_of_rep_givers:
        dropsRatings[dropEntity.id]?.distinct_raters ?? 0,
      total_number_of_categories:
        dropsRatings[dropEntity.id]?.distinct_categories ?? 0,
      top_rep_givers: (dropsTopRaters[dropEntity.id] ?? [])
        .map((rater) => ({
          rep_given: rater.rating,
          profile: profilesByIds[rater.rater_profile_id]!.profile
        }))
        .sort((a, b) => b.rep_given - a.rep_given),
      top_rep_categories: (dropsTopCategories[dropEntity.id] ?? [])
        .map((cat) => ({ rep_given: cat.rating, category: cat.category }))
        .sort((a, b) => b.rep_given - a.rep_given),
      rep_given_by_input_profile: inputProfileId
        ? dropsRatingsByInputProfile[dropEntity.id] ?? 0
        : null,
      input_profile_categories: inputProfileId
        ? (dropsInputProfileCategories[dropEntity.id] ?? []).map((cat) => ({
            category: cat.category,
            rep_given: cat.total_rating,
            rep_given_by_input_profile: cat.profile_rating
          }))
        : null,
      discussion_comments_count:
        dropLogsStats[dropEntity.id]?.discussion_comments_count ?? 0,
      rep_logs_count: dropLogsStats[dropEntity.id]?.rep_logs_count ?? 0,
      input_profile_discussion_comments_count:
        dropLogsStats[dropEntity.id]?.input_profile_discussion_comments_count ??
        null,
      quote_count: dropsQuoteCounts[dropEntity.id]?.total ?? 0,
      quote_count_by_input_profile: inputProfileId
        ? dropsQuoteCounts[dropEntity.id]?.by_input_profile ?? 0
        : null
    }));
  }

  private async getAllDropsRelatedData(
    { dropIds, inputProfileId }: { dropIds: number[]; inputProfileId?: string },
    connection?: ConnectionWrapper<any>
  ) {
    const [
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsInputProfileCategories,
      dropsRatings,
      dropsRatingsByInputProfile,
      dropLogsStats,
      dropsQuoteCounts
    ] = await Promise.all([
      this.dropsDb.findMentionsByDropIds(dropIds, connection),
      this.dropsDb.findReferencedNftsByDropIds(dropIds, connection),
      this.dropsDb.findMetadataByDropIds(dropIds, connection),
      this.dropsDb.findDropsTopRepRaters(dropIds, connection),
      this.dropsDb.findDropsTopRepCategories(dropIds, connection),
      this.findInputProfilesCategoryRepsForDrops(
        inputProfileId,
        dropIds,
        connection
      ),
      this.dropsDb.findDropsTotalRepStats(dropIds, connection),
      this.findInputProfilesTotalRepsForDrops(
        inputProfileId,
        dropIds,
        connection
      ),
      this.dropsDb.getDropLogsStats({ dropIds, inputProfileId }, connection),
      this.dropsDb.getDropsQuoteCounts(dropIds, inputProfileId, connection)
    ]);
    return {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsTopCategories,
      dropsInputProfileCategories,
      dropsRatings,
      dropsRatingsByInputProfile,
      dropLogsStats,
      dropsQuoteCounts
    };
  }

  private async findInputProfilesCategoryRepsForDrops(
    inputProfileId: string | undefined,
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      number,
      { category: string; profile_rating: number; total_rating: number }[]
    >
  > {
    if (!inputProfileId) {
      return {};
    }
    return this.dropsDb.findDropsCategoryRepsByProfile(
      dropIds,
      inputProfileId,
      connection
    );
  }

  private async findInputProfilesTotalRepsForDrops(
    inputProfileId: string | undefined,
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<number, number>> {
    if (!inputProfileId) {
      return {};
    }
    return this.dropsDb.findDropsTotalRepByProfile(
      dropIds,
      inputProfileId,
      connection
    );
  }

  async findProfilesLatestDrops(param: {
    amount: number;
    profile_id: string;
    id_less_than: number | null;
    inputProfileId?: string;
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findProfileRootDrops(param);
    return await this.convertToDropFulls({
      dropEntities,
      inputProfileId: param.inputProfileId
    });
  }

  async findAvailableTdhForRepForProfile(
    profileId: string
  ): Promise<{ available_tdh_for_rep: number }> {
    const tdhAvailable = await this.dropsDb.findRepLeftForDropsForProfile({
      profileId
    });
    return { available_tdh_for_rep: tdhAvailable };
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
        author: profileMins.find((it) => it.id === comment.profile_id) ?? null
      }))
    };
  }

  async commentDrop(commentRequest: {
    drop_id: number;
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
          author: authorProfile
        };
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return comment;
  }
}

export const dropsService = new DropsService(dropsDb, profilesService);
