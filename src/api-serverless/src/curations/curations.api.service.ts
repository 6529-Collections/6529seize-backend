import { randomUUID } from 'node:crypto';
import { collections } from '@/collections';
import { DropType } from '@/entities/IDrop';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { WaveType } from '@/entities/IWave';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { DropsDb, dropsDb } from '@/drops/drops.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { ApiProfileMinsPage } from '@/api/generated/models/ApiProfileMinsPage';
import { ApiWaveCurationGroup } from '@/api/generated/models/ApiWaveCurationGroup';
import { ApiWaveCurationGroupRequest } from '@/api/generated/models/ApiWaveCurationGroupRequest';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { CurationsDb, curationsDb } from '@/api/curations/curations.db';
import { WaveCurationGroupEntity } from '@/entities/IWaveCurationGroup';

export class CurationsApiService {
  constructor(
    private readonly curationsDb: CurationsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async findWaveCurationGroups(
    waveId: string,
    ctx: RequestContext
  ): Promise<ApiWaveCurationGroup[]> {
    const groupsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleForReadContext(ctx);
    const wave = await this.wavesApiDb.findWaveById(waveId, ctx.connection);
    this.assertWaveVisibleOrThrow(
      wave,
      groupsUserIsEligibleFor,
      `Wave ${waveId} not found`
    );
    return await this.curationsDb
      .findWaveCurationGroupsByWaveId(waveId, ctx.connection)
      .then((entities) =>
        entities.map((entity) => this.waveCurationGroupToApi(entity))
      );
  }

  public async createWaveCurationGroup(
    waveId: string,
    request: ApiWaveCurationGroupRequest,
    ctx: RequestContext
  ): Promise<ApiWaveCurationGroup> {
    return await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const validatedName = this.validateNameOrThrow(request.name);
        await this.assertCommunityGroupCanBeUsed(request.group_id, txCtx);
        await this.assertGroupNameIsUniqueInWave(
          {
            waveId: wave.id,
            name: validatedName
          },
          txCtx
        );
        const now = Time.currentMillis();
        const entity: WaveCurationGroupEntity = {
          id: randomUUID(),
          name: validatedName,
          wave_id: wave.id,
          community_group_id: request.group_id,
          created_at: now,
          updated_at: now
        };
        await this.curationsDb.insertWaveCurationGroup(entity, txCtx);
        return this.waveCurationGroupToApi(entity);
      }
    );
  }

  public async updateWaveCurationGroup(
    waveId: string,
    curationGroupId: string,
    request: ApiWaveCurationGroupRequest,
    ctx: RequestContext
  ): Promise<ApiWaveCurationGroup> {
    return await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const targetGroup = await this.curationsDb.findWaveCurationGroupById(
          { id: curationGroupId, wave_id: wave.id },
          connection
        );
        if (!targetGroup) {
          throw new NotFoundException(
            `Curation group ${curationGroupId} not found`
          );
        }
        const validatedName = this.validateNameOrThrow(request.name);
        await this.assertCommunityGroupCanBeUsed(request.group_id, txCtx);
        await this.assertGroupNameIsUniqueInWave(
          {
            waveId: wave.id,
            name: validatedName,
            ignoreId: curationGroupId
          },
          txCtx
        );
        await this.curationsDb.updateWaveCurationGroup(
          {
            id: curationGroupId,
            wave_id: wave.id,
            name: validatedName,
            community_group_id: request.group_id,
            updated_at: Time.currentMillis()
          },
          txCtx
        );
        const updated = await this.curationsDb.findWaveCurationGroupById(
          { id: curationGroupId, wave_id: wave.id },
          connection
        );
        if (!updated) {
          throw new NotFoundException(
            `Curation group ${curationGroupId} not found`
          );
        }
        return this.waveCurationGroupToApi(updated);
      }
    );
  }

  public async deleteWaveCurationGroup(
    waveId: string,
    curationGroupId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const targetGroup = await this.curationsDb.findWaveCurationGroupById(
          { id: curationGroupId, wave_id: wave.id },
          connection
        );
        if (!targetGroup) {
          throw new NotFoundException(
            `Curation group ${curationGroupId} not found`
          );
        }
        await this.curationsDb.deleteWaveCurationGroup(
          { id: curationGroupId, wave_id: wave.id },
          txCtx
        );
      }
    );
  }

  public async addDropCuration(dropId: string, ctx: RequestContext) {
    const { profileId, drop, wave } =
      await this.getCuratableDropContextForAuthenticatedCurator(dropId, ctx);
    await this.curationsDb.upsertDropCuration(
      {
        drop_id: drop.id,
        curator_id: profileId,
        wave_id: wave.id
      },
      ctx
    );
  }

  public async removeDropCuration(dropId: string, ctx: RequestContext) {
    const { profileId, drop } =
      await this.getCuratableDropContextForAuthenticatedCurator(dropId, ctx);
    await this.curationsDb.deleteDropCuration(
      {
        drop_id: drop.id,
        curator_id: profileId
      },
      ctx
    );
  }

  public async getCuratorIdsForLeaderboardFilter(
    param: { waveId: string; curationGroupId: string },
    ctx: RequestContext
  ): Promise<string[]> {
    const curationGroup = await this.curationsDb.findWaveCurationGroupById(
      { id: param.curationGroupId, wave_id: param.waveId },
      ctx.connection
    );
    if (!curationGroup) {
      throw new NotFoundException(
        `Curation group ${param.curationGroupId} not found`
      );
    }
    return collections.distinct(
      await this.userGroupsService.findIdentitiesInGroups(
        [curationGroup.community_group_id],
        ctx
      )
    );
  }

  public async findDropCurators(
    params: {
      dropId: string;
      page: number;
      page_size: number;
      sort_direction: ApiPageSortDirection;
    },
    ctx: RequestContext
  ): Promise<ApiProfileMinsPage> {
    const groupsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleForReadContext(ctx);
    const drop = await this.dropsDb.findDropById(params.dropId, ctx.connection);
    if (!drop) {
      throw new NotFoundException(`Drop ${params.dropId} not found`);
    }
    const wave = await this.wavesApiDb.findWaveById(
      drop.wave_id,
      ctx.connection
    );
    this.assertWaveVisibleOrThrow(
      wave,
      groupsUserIsEligibleFor,
      `Drop ${params.dropId} not found`
    );

    const sort_order: 'ASC' | 'DESC' =
      params.sort_direction === ApiPageSortDirection.Asc ? 'ASC' : 'DESC';
    const offset = params.page_size * (params.page - 1);
    const [curatorIds, count] = await Promise.all([
      this.curationsDb.findCuratorIdsByDropId(
        {
          drop_id: params.dropId,
          limit: params.page_size,
          offset,
          sort_order
        },
        ctx
      ),
      this.curationsDb.countCurationsByDropId(params.dropId, ctx)
    ]);
    const profilesById = await this.identityFetcher.getOverviewsByIds(
      curatorIds,
      ctx
    );
    const profiles = curatorIds
      .map((curatorId) => profilesById[curatorId])
      .filter((profile): profile is ApiProfileMin => Boolean(profile));

    return {
      data: profiles,
      count,
      page: params.page,
      next: count > params.page_size * params.page
    };
  }

  private async getCuratableDropContextForAuthenticatedCurator(
    dropId: string,
    ctx: RequestContext
  ): Promise<{
    profileId: string;
    drop: {
      id: string;
      wave_id: string;
      drop_type: DropType;
    };
    wave: {
      id: string;
      type: WaveType;
    };
  }> {
    const profileId = this.getAuthenticatedProfileIdOrThrow(ctx);
    const drop = await this.dropsDb.findDropById(dropId, ctx.connection);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    if (
      drop.drop_type !== DropType.PARTICIPATORY &&
      drop.drop_type !== DropType.WINNER
    ) {
      throw new BadRequestException(
        `Only PARTICIPATORY and WINNER drops can be curated`
      );
    }
    const wave = await this.wavesApiDb.findWaveById(
      drop.wave_id,
      ctx.connection
    );
    if (!wave) {
      throw new NotFoundException(`Wave ${drop.wave_id} not found`);
    }
    this.assertWaveTypeSupportsCurations(wave.type);
    await this.assertProfileCanCurateInWave(
      {
        profileId,
        waveId: wave.id
      },
      ctx
    );
    return { profileId, drop, wave };
  }

  private async getGroupsUserIsEligibleForReadContext(
    ctx: RequestContext
  ): Promise<string[]> {
    const authenticationContext = ctx.authenticationContext;
    let profileId: string | null = null;
    if (authenticationContext?.isUserFullyAuthenticated()) {
      if (
        !authenticationContext.isAuthenticatedAsProxy() ||
        authenticationContext.hasProxyAction(ProfileProxyActionType.READ_WAVE)
      ) {
        profileId = authenticationContext.getActingAsId();
      }
    }
    return await this.userGroupsService.getGroupsUserIsEligibleFor(
      profileId,
      ctx.timer
    );
  }

  private assertWaveVisibleOrThrow(
    wave: {
      visibility_group_id: string | null;
    } | null,
    groupsUserIsEligibleFor: string[],
    message: string
  ) {
    if (
      !wave ||
      (wave.visibility_group_id &&
        !groupsUserIsEligibleFor.includes(wave.visibility_group_id))
    ) {
      throw new NotFoundException(message);
    }
  }

  private getAuthenticatedProfileIdOrThrow(ctx: RequestContext): string {
    const authenticationContext = ctx.authenticationContext;
    if (!authenticationContext?.isUserFullyAuthenticated()) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't curate drops`);
    }
    return authenticationContext.getActingAsId()!;
  }

  private async assertCanManageWaveCurations(
    waveId: string,
    ctx: RequestContext
  ): Promise<{
    wave: {
      id: string;
      type: WaveType;
      admin_group_id: string | null;
      created_by: string;
    };
    profileId: string;
  }> {
    const authenticationContext = ctx.authenticationContext;
    if (!authenticationContext?.isUserFullyAuthenticated()) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't manage curation groups`);
    }
    const profileId = authenticationContext.getActingAsId()!;
    const wave = await this.wavesApiDb.findWaveById(waveId, ctx.connection);
    if (!wave) {
      throw new NotFoundException(`Wave ${waveId} not found`);
    }
    this.assertWaveTypeSupportsCurations(wave.type);
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        profileId,
        ctx.timer
      );
    const isAdmin =
      wave.created_by === profileId ||
      (wave.admin_group_id !== null &&
        groupsUserIsEligibleFor.includes(wave.admin_group_id));
    if (!isAdmin) {
      throw new ForbiddenException(
        `You can't manage curation groups in wave ${waveId}`
      );
    }
    return { wave, profileId };
  }

  private async assertProfileCanCurateInWave(
    param: { profileId: string; waveId: string },
    ctx: RequestContext
  ): Promise<void> {
    const curationGroups =
      await this.curationsDb.findWaveCurationGroupsByWaveId(
        param.waveId,
        ctx.connection
      );
    if (!curationGroups.length) {
      throw new ForbiddenException(
        `You are not eligible to curate in this wave`
      );
    }
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        param.profileId,
        ctx.timer
      );
    const canCurate = curationGroups.some((group) =>
      groupsUserIsEligibleFor.includes(group.community_group_id)
    );
    if (!canCurate) {
      throw new ForbiddenException(
        `You are not eligible to curate in this wave`
      );
    }
  }

  private assertWaveTypeSupportsCurations(waveType: WaveType): void {
    if (waveType !== WaveType.RANK && waveType !== WaveType.APPROVE) {
      throw new BadRequestException(
        `Curations are supported only in RANK and APPROVE waves`
      );
    }
  }

  private async assertCommunityGroupCanBeUsed(
    groupId: string,
    ctx: RequestContext
  ): Promise<void> {
    const group = await this.curationsDb.findCommunityGroupById(
      groupId,
      ctx.connection
    );
    if (!group) {
      throw new BadRequestException(`Group ${groupId} not found`);
    }
    if (group.is_private) {
      throw new BadRequestException(`Group ${groupId} is private`);
    }
  }

  private validateNameOrThrow(name: string): string {
    const normalized = name.trim();
    if (!normalized.length || normalized.length > 50) {
      throw new BadRequestException(`Curation group name must be 1-50 chars`);
    }
    return normalized;
  }

  private async assertGroupNameIsUniqueInWave(
    param: { waveId: string; name: string; ignoreId?: string },
    ctx: RequestContext
  ): Promise<void> {
    const existing = await this.curationsDb.findWaveCurationGroupByName(
      {
        wave_id: param.waveId,
        name: param.name
      },
      ctx.connection
    );
    if (existing && existing.id !== param.ignoreId) {
      throw new BadRequestException(
        `Curation group name '${param.name}' already exists in this wave`
      );
    }
  }

  private waveCurationGroupToApi(
    entity: WaveCurationGroupEntity
  ): ApiWaveCurationGroup {
    return {
      id: entity.id,
      name: entity.name,
      wave_id: entity.wave_id,
      group_id: entity.community_group_id,
      created_at: entity.created_at,
      updated_at: entity.updated_at
    };
  }
}

export const curationsApiService = new CurationsApiService(
  curationsDb,
  wavesApiDb,
  dropsDb,
  userGroupsService,
  identityFetcher
);
