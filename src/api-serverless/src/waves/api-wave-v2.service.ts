import { collections } from '@/collections';
import { assertUnreachable } from '@/assertions';
import { DropType } from '@/entities/IDrop';
import { WaveEntity } from '@/entities/IWave';
import { enums } from '@/enums';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
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
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { ApiWaveOverviewPage } from '@/api/generated/models/ApiWaveOverviewPage';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';
import {
  SearchWavesParams,
  wavesApiDb,
  WavesApiDb
} from '@/api/waves/waves.api.db';

export interface FindWaveDropsFeedV2Request {
  readonly drop_id: string | null;
  readonly serial_no_limit: number | null;
  readonly wave_id: string;
  readonly amount: number;
  readonly search_strategy: ApiDropSearchStrategy;
  readonly drop_type: ApiDropType | null;
  readonly curation_id: string | null;
}

export interface FindWavesV2Request {
  readonly view: ApiWavesV2ListType;
  readonly page: number;
  readonly page_size: number;
  readonly name?: string;
  readonly author?: string;
  readonly serial_no_less_than?: number;
  readonly group_id?: string;
  readonly direct_message?: boolean;
  readonly overview_type?: ApiWavesOverviewType;
  readonly only_waves_followed_by_authenticated_user?: boolean;
  readonly pinned?: ApiWavesPinFilter | null;
  readonly exclude_followed?: boolean;
  readonly identity?: string;
}

export class ApiWaveV2Service {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly curationsDb: CurationsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identityFetcher: IdentityFetcher,
    private readonly apiDropMapper: ApiDropMapper,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper
  ) {}

  public async findWaves(
    request: FindWavesV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const timerKey = `${this.constructor.name}->findWaves`;
    ctx.timer?.start(timerKey);
    try {
      switch (request.view) {
        case ApiWavesV2ListType.Search:
          return await this.findSearchedWaves(request, ctx);
        case ApiWavesV2ListType.Overview:
          return await this.findOverviewWaves(request, ctx);
        case ApiWavesV2ListType.Hot:
          return await this.findHotWaves(request, ctx);
        case ApiWavesV2ListType.Favourites:
          return await this.findFavouriteWaves(request, ctx);
        default:
          return assertUnreachable(request.view);
      }
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

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

  public async searchDropsContainingPhraseInWave(
    {
      wave_id,
      term,
      size,
      page
    }: { term: string; page: number; size: number; wave_id: string },
    ctx: RequestContext
  ): Promise<ApiDropV2PageWithoutCount> {
    const timerKey = `${this.constructor.name}->searchDropsContainingPhraseInWave`;
    ctx.timer?.start(timerKey);
    try {
      const wave = await this.dropsDb.findWaveByIdOrNull(
        wave_id,
        ctx.connection
      );
      if (!wave) {
        throw new NotFoundException(`Wave ${wave_id} not found`);
      }
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const visibilityGroupId = wave.visibility_group_id;
      if (visibilityGroupId) {
        const groupIdsUserIsEligibleFor =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            contextProfileId,
            ctx.timer
          );
        if (!groupIdsUserIsEligibleFor.includes(visibilityGroupId)) {
          throw new NotFoundException(`Wave ${wave_id} not found`);
        }
      }
      const offset = size * (page - 1);
      const dropEntities = await this.dropsDb.searchDropsContainingPhraseInWave(
        { wave_id, term, limit: size + 1, offset },
        ctx
      );
      const pageDropEntities = dropEntities.slice(0, size);
      const drops = await this.apiDropMapper.mapDrops(pageDropEntities, ctx);
      return {
        data: pageDropEntities.map((drop) => drops[drop.id]),
        next: dropEntities.length > size,
        page
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findWaveCurationDrops(
    {
      wave_id,
      curation_id,
      page,
      page_size
    }: {
      wave_id: string;
      curation_id: string;
      page: number;
      page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiDropV2PageWithoutCount> {
    const timerKey = `${this.constructor.name}->findWaveCurationDrops`;
    ctx.timer?.start(timerKey);
    try {
      if (!(page >= 1) || !(page_size > 0)) {
        throw new BadRequestException(
          `Curation drops pagination requires page >= 1 and page_size > 0`
        );
      }
      const { eligibleGroups } = await this.getReadableWaveContext(ctx);
      const { wave, curationFilter, notFoundMessage } =
        await this.findWaveAndCurationFilter(
          {
            waveId: wave_id,
            curationId: curation_id
          },
          ctx
        );
      if (!this.canSeeWave(wave, eligibleGroups) || !curationFilter) {
        throw new NotFoundException(notFoundMessage);
      }
      const dropEntities = await this.dropsDb.findDropsByCurationPriorityOrder(
        {
          wave_id,
          curation_id: curationFilter,
          limit: page_size + 1,
          offset: page_size * (page - 1)
        },
        ctx
      );
      const pageDropEntities = dropEntities.slice(0, page_size);
      const dropsById = await this.apiDropMapper.mapDrops(
        pageDropEntities,
        ctx
      );
      return {
        data: pageDropEntities.map((drop) => dropsById[drop.id]),
        page,
        next: dropEntities.length > page_size
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async findSearchedWaves(
    request: FindWavesV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const { eligibleGroups } = await this.getReadableWaveContext(ctx);
    const author = request.author
      ? await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
          { identityKey: request.author },
          ctx
        )
      : undefined;
    const searchParams: SearchWavesParams = {
      author,
      name: request.name,
      limit: request.page_size + 1,
      offset: this.getOffset(request),
      serial_no_less_than: request.serial_no_less_than,
      group_id: request.group_id,
      direct_message: request.direct_message
    };
    const waveEntities = await this.wavesApiDb.searchWaves(
      searchParams,
      eligibleGroups,
      ctx
    );
    return await this.mapWaveEntitiesPage(waveEntities, request, ctx);
  }

  private async findOverviewWaves(
    request: FindWavesV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const overviewType = request.overview_type;
    if (!overviewType) {
      throw new BadRequestException(
        `overview_type is required for OVERVIEW view`
      );
    }
    const { authenticatedProfileId, eligibleGroups } =
      await this.getReadableWaveContext(ctx);
    const onlyFollowed =
      request.only_waves_followed_by_authenticated_user ?? false;
    if (onlyFollowed && !authenticatedProfileId) {
      throw new BadRequestException(
        `You can't see waves organised by your behaviour unless you're authenticated`
      );
    }
    const findParams = {
      authenticated_user_id: authenticatedProfileId,
      only_waves_followed_by_authenticated_user: onlyFollowed,
      offset: this.getOffset(request),
      limit: request.page_size + 1,
      eligibleGroups,
      direct_message: request.direct_message,
      pinned: request.pinned ?? null
    };
    const waveEntities =
      overviewType === ApiWavesOverviewType.MostSubscribed
        ? await this.wavesApiDb.findMostSubscribedWaves(findParams)
        : overviewType === ApiWavesOverviewType.RecentlyDroppedTo
          ? await this.wavesApiDb.findRecentlyDroppedToWaves(findParams)
          : assertUnreachable(overviewType);
    return await this.mapWaveEntitiesPage(waveEntities, request, ctx);
  }

  private async findHotWaves(
    request: FindWavesV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const authenticatedProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const excludeFollowed = request.exclude_followed ?? false;
    if (excludeFollowed && !authenticatedProfileId) {
      throw new BadRequestException(
        `You can't exclude followed waves unless you're authenticated`
      );
    }
    const waveEntities = await this.wavesApiDb.findHotWaves({
      cutoffTimestamp: Time.currentMillis() - Time.hours(24).toMillis(),
      limit: request.page_size + 1,
      offset: this.getOffset(request),
      authenticated_user_id: authenticatedProfileId,
      exclude_followed: excludeFollowed
    });
    return await this.mapWaveEntitiesPage(waveEntities, request, ctx);
  }

  private async findFavouriteWaves(
    request: FindWavesV2Request,
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const identity = request.identity;
    if (!identity) {
      throw new BadRequestException(`identity is required for FAVOURITES view`);
    }
    const { eligibleGroups } = await this.getReadableWaveContext(ctx);
    const targetProfileId =
      await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: identity },
        ctx
      );
    const waveEntities = await this.wavesApiDb.findFavouriteWavesOfIdentity(
      {
        identityId: targetProfileId,
        eligibleGroups,
        limit: request.page_size + 1,
        offset: this.getOffset(request)
      },
      ctx
    );
    return await this.mapWaveEntitiesPage(waveEntities, request, ctx);
  }

  private async getReadableWaveContext(ctx: RequestContext): Promise<{
    authenticatedProfileId: string | null;
    eligibleGroups: string[];
  }> {
    const authenticatedProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const eligibleGroups = authenticatedProfileId
      ? await this.userGroupsService.getGroupsUserIsEligibleFor(
          authenticatedProfileId,
          ctx.timer
        )
      : [];
    return {
      authenticatedProfileId,
      eligibleGroups
    };
  }

  private getOffset({
    page,
    page_size
  }: {
    readonly page: number;
    readonly page_size: number;
  }): number {
    return (page - 1) * page_size;
  }

  private async mapWaveEntitiesPage(
    waveEntities: WaveEntity[],
    request: { readonly page: number; readonly page_size: number },
    ctx: RequestContext
  ): Promise<ApiWaveOverviewPage> {
    const pageWaveEntities = waveEntities.slice(0, request.page_size);
    const wavesById = await this.apiWaveOverviewMapper.mapWaves(
      pageWaveEntities,
      ctx
    );
    return {
      data: pageWaveEntities.map((wave) => wavesById[wave.id]),
      page: request.page,
      next: waveEntities.length > request.page_size
    };
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
  wavesApiDb,
  identityFetcher,
  apiDropMapper,
  apiWaveOverviewMapper
);
