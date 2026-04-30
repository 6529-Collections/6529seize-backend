import { collections } from '@/collections';
import { DropType } from '@/entities/IDrop';
import { WaveEntity } from '@/entities/IWave';
import { enums } from '@/enums';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { curationsDb, CurationsDb } from '@/api/curations/curations.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { apiDropMapper, ApiDropMapper } from '@/api/drops/api-drop.mapper';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropTraceItem } from '@/api/generated/models/ApiDropTraceItem';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';

export interface FindWaveDropsFeedV2Request {
  readonly drop_id: string | null;
  readonly serial_no_limit: number | null;
  readonly wave_id: string;
  readonly amount: number;
  readonly search_strategy: ApiDropSearchStrategy;
  readonly drop_type: ApiDropType | null;
  readonly curation_id: string | null;
}

export class ApiWaveV2Service {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly curationsDb: CurationsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly apiDropMapper: ApiDropMapper,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper
  ) {}

  public async findDropsFeed(
    request: FindWaveDropsFeedV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveDropsFeedV2> {
    const timerKey = `${this.constructor.name}->findDropsFeed`;
    ctx.timer?.start(timerKey);
    try {
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const groupIdsUserIsEligibleForPromise =
        this.userGroupsService.getGroupsUserIsEligibleFor(
          contextProfileId,
          ctx.timer
        );
      const waveAndCurationFilterPromise = this.findWaveAndCurationFilter(
        {
          waveId: request.wave_id,
          curationId: request.curation_id
        },
        ctx
      );
      const [
        groupIdsUserIsEligibleFor,
        { wave, curationFilter, notFoundMessage }
      ] = await Promise.all([
        groupIdsUserIsEligibleForPromise,
        waveAndCurationFilterPromise
      ]);
      if (!this.canSeeWave(wave, groupIdsUserIsEligibleFor)) {
        throw new NotFoundException(notFoundMessage);
      }

      return request.drop_id
        ? await this.findReplyFeed(
            {
              ...request,
              drop_id: request.drop_id,
              wave,
              curationFilter,
              groupIdsUserIsEligibleFor
            },
            ctx
          )
        : await this.findWaveFeed(
            {
              ...request,
              wave,
              curationFilter
            },
            ctx
          );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async findWaveAndCurationFilter(
    {
      waveId,
      curationId
    }: {
      readonly waveId: string;
      readonly curationId: string | null;
    },
    ctx: RequestContext
  ): Promise<{
    wave: WaveEntity | null;
    curationFilter: string | null;
    notFoundMessage: string;
  }> {
    const [wave, curation] = await Promise.all([
      this.dropsDb.findWaveByIdOrNull(waveId, ctx.connection),
      curationId
        ? this.curationsDb.findWaveCurationById(
            { id: curationId },
            ctx.connection
          )
        : Promise.resolve(null)
    ]);

    if (curationId) {
      if (curation?.wave_id !== waveId) {
        throw new NotFoundException(`Curation ${curationId} not found`);
      }
      return {
        wave,
        curationFilter: curation.id,
        notFoundMessage: `Curation ${curationId} not found`
      };
    }
    return {
      wave,
      curationFilter: null,
      notFoundMessage: `Wave ${waveId} not found`
    };
  }

  private async findWaveFeed(
    {
      wave,
      amount,
      serial_no_limit,
      search_strategy,
      curationFilter,
      drop_type
    }: FindWaveDropsFeedV2Request & {
      readonly wave: WaveEntity;
      readonly curationFilter: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiWaveDropsFeedV2> {
    const [dropEntities, apiWaveById] = await Promise.all([
      this.dropsDb.findLatestDropsSimple(
        {
          wave_id: wave.id,
          amount,
          serial_no_limit,
          search_strategy,
          curation_id: curationFilter,
          drop_type: this.resolveDropType(drop_type)
        },
        ctx
      ),
      this.apiWaveOverviewMapper.mapWaves([wave], ctx)
    ]);
    const apiDropById = await this.apiDropMapper.mapDrops(dropEntities, ctx);
    return {
      drops: dropEntities.map((drop) => apiDropById[drop.id]),
      wave: apiWaveById[wave.id]
    };
  }

  private async findReplyFeed(
    {
      wave,
      drop_id,
      amount,
      serial_no_limit,
      search_strategy,
      curationFilter,
      drop_type,
      groupIdsUserIsEligibleFor
    }: Omit<FindWaveDropsFeedV2Request, 'drop_id'> & {
      readonly drop_id: string;
      readonly wave: WaveEntity;
      readonly curationFilter: string | null;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<ApiWaveDropsFeedV2> {
    const dropId = drop_id;
    const resolvedDropType = this.resolveDropType(drop_type);
    const [rootDrop, trace, dropEntities, apiWaveById] = await Promise.all([
      this.dropsDb.findDropByIdWithEligibilityCheck(
        dropId,
        groupIdsUserIsEligibleFor,
        ctx.connection
      ),
      this.dropsDb.getTraceForDrop(dropId, ctx),
      this.dropsDb.findLatestDropRepliesSimple(
        {
          drop_id: dropId,
          amount,
          serial_no_limit,
          search_strategy,
          curation_id: curationFilter,
          drop_type: resolvedDropType
        },
        ctx
      ),
      this.apiWaveOverviewMapper.mapWaves([wave], ctx)
    ]);
    if (rootDrop?.wave_id !== wave.id) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }

    const dropEntitiesToMap = collections.distinctBy(
      [rootDrop, ...dropEntities],
      (drop) => drop.id
    );
    const apiDropById = await this.apiDropMapper.mapDrops(
      dropEntitiesToMap,
      ctx
    );

    return {
      drops: dropEntities.map((drop) => apiDropById[drop.id]),
      wave: apiWaveById[wave.id],
      trace: trace.map<ApiDropTraceItem>((item) => ({
        drop_id: item.drop_id,
        is_deleted: item.is_deleted
      })),
      root_drop: apiDropById[rootDrop.id]
    };
  }

  private canSeeWave(
    wave: WaveEntity | null,
    groupIdsUserIsEligibleFor: string[]
  ): wave is WaveEntity {
    return (
      !!wave &&
      (!wave.visibility_group_id ||
        groupIdsUserIsEligibleFor.includes(wave.visibility_group_id))
    );
  }

  private resolveDropType(dropType: ApiDropType | null): DropType | null {
    return dropType ? enums.resolveOrThrow(DropType, dropType) : null;
  }
}

export const apiWaveV2Service = new ApiWaveV2Service(
  dropsDb,
  curationsDb,
  userGroupsService,
  apiDropMapper,
  apiWaveOverviewMapper
);
