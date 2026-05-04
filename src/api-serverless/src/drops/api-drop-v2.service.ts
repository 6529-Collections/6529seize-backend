import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { apiDropMapper, ApiDropMapper } from '@/api/drops/api-drop.mapper';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { ApiDropPartV2 } from '@/api/generated/models/ApiDropPartV2';
import { AttachmentEntity, DropAttachmentEntity } from '@/entities/IAttachment';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { ApiDropBoostV2 } from '@/api/generated/models/ApiDropBoostV2';
import { ApiDropV2Page } from '@/api/generated/models/ApiDropV2Page';
import { ApiDropVoteEditLog } from '@/api/generated/models/ApiDropVoteEditLog';
import { PageSortDirection } from '@/api/page-request';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { ApiDropVotersPage } from '@/api/generated/models/ApiDropVotersPage';
import { DropEntity, DropType } from '@/entities/IDrop';
import { ApiDropReactionV2 } from '@/api/generated/models/ApiDropReactionV2';
import { reactionsDb, ReactionsDb } from '@/api/drops/reactions.db';

export type ApiDropWithWave = ApiDropAndWave;
export type DropVotersSearchParams = {
  page_size: number;
  page: number;
  sort_direction: PageSortDirection;
};

export type DropVoteEditLogsSearchParams = {
  offset: number;
  limit: number;
  sort_direction: PageSortDirection;
};

export interface FindBoostedDropsV2Request {
  author: string | null;
  booster: string | null;
  wave_id: string | null;
  min_boosts: number | null;
  count_only_boosts_after: number;
  page_size: number;
  page: number;
  sort_direction: ApiPageSortDirection;
  sort: 'last_boosted_at' | 'first_boosted_at' | 'drop_created_at' | 'boosts';
}

export class ApiDropV2Service {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly apiDropMapper: ApiDropMapper,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper,
    private readonly identityFetcher: IdentityFetcher,
    private readonly attachmentsDb: AttachmentsDb,
    private readonly reactionsDb: ReactionsDb
  ) {}

  public async findWithWaveByIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiDropWithWave> {
    const timerKey = `${this.constructor.name}->findWithWaveByIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      const dropEntity = await this.findVisibleDropByIdOrThrow(id, ctx);

      const apiDropByIdPromise = this.apiDropMapper.mapDrops([dropEntity], ctx);
      const apiWaveByIdPromise = this.dropsDb
        .findWaveByIdOrNull(dropEntity.wave_id, ctx.connection)
        .then((waveEntity) => {
          if (!waveEntity) {
            throw new NotFoundException(`Drop ${id} not found`);
          }
          return this.apiWaveOverviewMapper.mapWaves([waveEntity], ctx);
        });

      const [apiDropById, apiWaveById] = await Promise.all([
        apiDropByIdPromise,
        apiWaveByIdPromise
      ]);

      return {
        drop: apiDropById[dropEntity.id],
        wave: apiWaveById[dropEntity.wave_id]
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findMetadataByDropIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiDropMetadataV2[]> {
    const timerKey = `${this.constructor.name}->findMetadataByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      await this.findVisibleDropByIdOrThrow(id, ctx);

      const metadata = await this.dropsDb.findMetadataByDropId(id, ctx);
      const identityProfileIds = metadata
        .filter(
          (row) =>
            row.data_key === 'identity' && row.data_value.trim().length > 0
        )
        .map((row) => row.data_value);
      const resolvedProfilesById = identityProfileIds.length
        ? await this.identityFetcher.getDropResolvedIdentityProfilesV2ByIds(
            { ids: identityProfileIds },
            ctx
          )
        : {};

      return metadata.map((row) => {
        const apiMetadata: ApiDropMetadataV2 = {
          data_key: row.data_key,
          data_value: row.data_value
        };
        if (row.data_key === 'identity') {
          const resolvedProfile = resolvedProfilesById[row.data_value];
          if (resolvedProfile) {
            apiMetadata.resolved_profile = resolvedProfile;
          }
        }
        return apiMetadata;
      });
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findPartByDropIdOrThrow(
    id: string,
    partNo: number,
    ctx: RequestContext
  ): Promise<ApiDropPartV2> {
    const timerKey = `${this.constructor.name}->findPartByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      const dropEntity = await this.findVisibleDropByIdOrThrow(
        id,
        ctx,
        `Drop ${id} part ${partNo} not found`
      );
      if (partNo > dropEntity.parts_count) {
        throw new NotFoundException(`Drop ${id} part ${partNo} not found`);
      }

      const dropAttachmentsPromise = this.attachmentsDb.getDropPartAttachments(
        id,
        partNo,
        ctx
      );
      const attachmentsByIdPromise = dropAttachmentsPromise.then(
        (dropAttachments) =>
          this.findAttachmentsByDropAttachments(dropAttachments, ctx)
      );
      const [part, media, dropAttachments, attachmentsById] = await Promise.all(
        [
          this.dropsDb.findDropPartByDropIdAndPartNo(id, partNo, ctx),
          this.dropsDb.findDropPartMedia(id, partNo, ctx),
          dropAttachmentsPromise,
          attachmentsByIdPromise
        ]
      );
      if (!part) {
        throw new NotFoundException(`Drop ${id} part ${partNo} not found`);
      }

      const apiPart: ApiDropPartV2 = {
        part_no: part.drop_part_id
      };
      if (part.content !== null) {
        apiPart.content = part.content;
      }
      const apiMedia = media.map((row) => ({
        url: row.url,
        mime_type: row.mime_type
      }));
      if (apiMedia.length) {
        apiPart.media = apiMedia;
      }
      const apiAttachments = this.mapAttachments(
        dropAttachments,
        attachmentsById
      );
      if (apiAttachments.length) {
        apiPart.attachments = apiAttachments;
      }
      if (part.quoted_drop_id && part.quoted_drop_part_id) {
        apiPart.quoted_drop = {
          drop_id: part.quoted_drop_id,
          drop_part_id: part.quoted_drop_part_id
        };
      }
      return apiPart;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findBoostsByDropIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiDropBoostV2[]> {
    const timerKey = `${this.constructor.name}->findBoostsByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      await this.findVisibleDropByIdOrThrow(id, ctx);

      const boosts = await this.dropsDb.findDropBoostsByDropId(id, ctx);
      if (!boosts.length) {
        return [];
      }
      const boosterIds = Array.from(
        new Set(boosts.map((boost) => boost.booster_id))
      );
      const boostersById =
        await this.identityFetcher.getApiIdentityOverviewsByIds(
          boosterIds,
          ctx
        );
      return boosts.map((boost) => ({
        booster: boostersById[boost.booster_id],
        boosted_at: boost.boosted_at
      }));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findReactionsByDropIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiDropReactionV2[]> {
    const timerKey = `${this.constructor.name}->findReactionsByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      await this.findVisibleDropByIdOrThrow(id, ctx);

      const rows = await this.reactionsDb.getReactionProfilesByDropId(id, ctx);
      if (!rows.length) {
        return [];
      }

      const reactorsById =
        await this.identityFetcher.getApiIdentityOverviewsByIds(
          Array.from(new Set(rows.map((row) => row.profile_id))),
          ctx
        );
      const reactionProfileIds = new Map<string, string[]>();
      for (const row of rows) {
        const profileIds = reactionProfileIds.get(row.reaction) ?? [];
        profileIds.push(row.profile_id);
        reactionProfileIds.set(row.reaction, profileIds);
      }
      return Array.from(reactionProfileIds.entries()).map(
        ([reaction, profileIds]) => ({
          reaction,
          reactors: profileIds.map((profileId) => reactorsById[profileId])
        })
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findBoostedDrops(
    req: FindBoostedDropsV2Request,
    ctx: RequestContext
  ): Promise<ApiDropV2Page> {
    const timerKey = `${this.constructor.name}->findBoostedDrops`;
    ctx.timer?.start(timerKey);
    try {
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const groupIdsUserIsEligibleFor =
        await this.userGroupsService.getGroupsUserIsEligibleFor(
          contextProfileId,
          ctx.timer
        );
      const boosterId =
        req.booster === null
          ? null
          : await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
              { identityKey: req.booster },
              ctx
            );
      const authorId =
        req.author === null
          ? null
          : await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
              { identityKey: req.author },
              ctx
            );
      const offset = req.page_size * (req.page - 1);
      const [dropEntities, count] = await Promise.all([
        this.dropsDb.findBoostedDrops(
          {
            wave_id: req.wave_id,
            eligibile_groups: groupIdsUserIsEligibleFor,
            limit: req.page_size,
            offset,
            booster_id: boosterId,
            author_id: authorId,
            order_by: req.sort,
            order: req.sort_direction,
            min_boosts: req.min_boosts,
            count_only_boosts_after: req.count_only_boosts_after
          },
          ctx
        ),
        this.dropsDb.countBoostedDrops(
          {
            wave_id: req.wave_id,
            eligibile_groups: groupIdsUserIsEligibleFor,
            booster_id: boosterId,
            author_id: authorId,
            min_boosts: req.min_boosts,
            count_only_boosts_after: req.count_only_boosts_after
          },
          ctx
        )
      ]);
      const dropsById = await this.apiDropMapper.mapDrops(dropEntities, ctx);
      return {
        data: dropEntities.map((drop) => dropsById[drop.id]),
        count,
        page: req.page,
        next: count > req.page_size * req.page
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findVoteEditLogsByDropIdOrThrow(
    id: string,
    params: DropVoteEditLogsSearchParams,
    ctx: RequestContext
  ): Promise<ApiDropVoteEditLog[]> {
    const timerKey = `${this.constructor.name}->findVoteEditLogsByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      const dropEntity = await this.findVisibleDropByIdOrThrow(id, ctx);

      const logs = await this.dropsDb.findDropVoteEditLogEntities(
        {
          wave_id: dropEntity.wave_id,
          drop_id: id,
          offset: params.offset,
          limit: params.limit,
          sort_direction: params.sort_direction
        },
        ctx
      );
      if (!logs.length) {
        return [];
      }
      const voterIds = Array.from(new Set(logs.map((log) => log.profile_id)));
      const votersById =
        await this.identityFetcher.getApiIdentityOverviewsByIds(voterIds, ctx);
      return logs.map((log) => {
        const contents = this.parseVoteEditLogContents(log.contents);
        return {
          id: log.id,
          old_vote: this.parseVoteValue(contents.oldVote),
          new_vote: this.parseVoteValue(contents.newVote),
          created_at: new Date(log.created_at).getTime(),
          voter: votersById[log.profile_id]
        };
      });
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findVotersByDropIdOrThrow(
    id: string,
    params: DropVotersSearchParams,
    ctx: RequestContext
  ): Promise<ApiDropVotersPage> {
    const timerKey = `${this.constructor.name}->findVotersByDropIdOrThrow`;
    ctx.timer?.start(timerKey);
    try {
      const dropEntity = await this.findVisibleDropByIdOrThrow(id, ctx);

      const [rows, totalCount] =
        dropEntity.drop_type === DropType.WINNER
          ? await Promise.all([
              this.dropsDb
                .getWinnerDropVoters(
                  {
                    drop_id: id,
                    page: params.page,
                    page_size: params.page_size,
                    direction: params.sort_direction
                  },
                  ctx
                )
                .then((voters) =>
                  voters.map((voter) => ({
                    voter_id: voter.voter_id,
                    vote: voter.votes
                  }))
                ),
              this.dropsDb.countWinnerDropVoters(id, ctx)
            ])
          : await Promise.all([
              this.dropsDb.findDropVotersByAbsoluteVote(
                {
                  wave_id: dropEntity.wave_id,
                  drop_id: id,
                  page: params.page,
                  page_size: params.page_size,
                  sort_direction: params.sort_direction
                },
                ctx
              ),
              this.dropsDb.countDropVotersByAbsoluteVote(
                {
                  wave_id: dropEntity.wave_id,
                  drop_id: id
                },
                ctx
              )
            ]);

      const votersById = rows.length
        ? await this.identityFetcher.getApiIdentityOverviewsByIds(
            rows.map((row) => row.voter_id),
            ctx
          )
        : {};
      return {
        page: params.page,
        count: totalCount,
        next: totalCount > params.page_size * params.page,
        data: rows.map((row) => ({
          voter: votersById[row.voter_id],
          vote: Number(row.vote)
        }))
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async findVisibleDropByIdOrThrow(
    id: string,
    ctx: RequestContext,
    notFoundMessage = `Drop ${id} not found`
  ): Promise<DropEntity> {
    const contextProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        contextProfileId,
        ctx.timer
      );
    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      id,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    if (!dropEntity) {
      throw new NotFoundException(notFoundMessage);
    }
    return dropEntity;
  }

  private parseVoteEditLogContents(contents: string): {
    oldVote?: unknown;
    newVote?: unknown;
  } {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    return parsed as { oldVote?: unknown; newVote?: unknown };
  }

  private parseVoteValue(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  private async findAttachmentsByDropAttachments(
    dropAttachments: DropAttachmentEntity[],
    ctx: RequestContext
  ) {
    const attachmentIds = Array.from(
      new Set(dropAttachments.map((attachment) => attachment.attachment_id))
    );
    return attachmentIds.length
      ? this.attachmentsDb.findAttachmentsByIds(attachmentIds, ctx.connection)
      : {};
  }

  private mapAttachments(
    dropAttachments: DropAttachmentEntity[],
    attachmentsById: Record<string, AttachmentEntity>
  ): ApiAttachment[] {
    return dropAttachments
      .map((dropAttachment) => attachmentsById[dropAttachment.attachment_id])
      .filter((attachment): attachment is AttachmentEntity => !!attachment)
      .map((attachment) => {
        const apiAttachment = mapAttachmentToApiAttachment(attachment);
        if (apiAttachment.url === null) {
          delete apiAttachment.url;
        }
        if (apiAttachment.error_reason === null) {
          delete apiAttachment.error_reason;
        }
        return apiAttachment;
      });
  }
}

export const apiDropV2Service = new ApiDropV2Service(
  dropsDb,
  userGroupsService,
  apiDropMapper,
  apiWaveOverviewMapper,
  identityFetcher,
  attachmentsDb,
  reactionsDb
);
