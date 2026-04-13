import { randomUUID } from 'node:crypto';
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
import { ApiDropCuration } from '@/api/generated/models/ApiDropCuration';
import { ApiDropCurationRequest } from '@/api/generated/models/ApiDropCurationRequest';
import { ApiWaveCuration } from '@/api/generated/models/ApiWaveCuration';
import { ApiWaveCurationRequest } from '@/api/generated/models/ApiWaveCurationRequest';
import {
  assertWaveVisibleOrThrow,
  getAuthenticatedNonProxyProfileIdOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveManagementContextOrThrow
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { CurationsDb, curationsDb } from '@/api/curations/curations.db';
import { WaveCurationEntity } from '@/entities/IWaveCuration';

export class CurationsApiService {
  constructor(
    private readonly curationsDb: CurationsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async findWaveCurations(
    waveId: string,
    ctx: RequestContext
  ): Promise<ApiWaveCuration[]> {
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const wave = await this.wavesApiDb.findWaveById(waveId, ctx.connection);
    assertWaveVisibleOrThrow(
      wave,
      groupsUserIsEligibleFor,
      `Wave ${waveId} not found`
    );
    return await this.curationsDb
      .findWaveCurationsByWaveId(waveId, ctx.connection)
      .then((entities) => this.waveCurationsToApi(entities));
  }

  public async createWaveCuration(
    waveId: string,
    request: ApiWaveCurationRequest,
    ctx: RequestContext
  ): Promise<ApiWaveCuration> {
    return await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const validatedName = this.validateNameOrThrow(request.name);
        await this.assertCommunityGroupCanBeUsed(request.group_id, txCtx);
        await this.assertCurationNameIsUniqueInWave(
          {
            waveId: wave.id,
            name: validatedName
          },
          txCtx
        );
        const lockedCurations =
          await this.curationsDb.lockWaveCurationsByWaveId(wave.id, txCtx);
        const priorityOrder = this.resolveRequestedPriorityOrderOrThrow({
          requestedPriorityOrder: request.priority_order,
          maxPriorityOrder: lockedCurations.length + 1
        });
        if (priorityOrder <= lockedCurations.length) {
          await this.curationsDb.incrementWaveCurationPriorityOrderRange(
            {
              wave_id: wave.id,
              from_priority_order: priorityOrder
            },
            txCtx
          );
        }
        const now = Time.currentMillis();
        const entity: WaveCurationEntity = {
          id: randomUUID(),
          name: validatedName,
          wave_id: wave.id,
          community_group_id: request.group_id,
          created_at: now,
          updated_at: now,
          priority_order: priorityOrder
        };
        await this.curationsDb.insertWaveCuration(entity, txCtx);
        return this.waveCurationToApi(entity);
      }
    );
  }

  public async updateWaveCuration(
    waveId: string,
    curationId: string,
    request: ApiWaveCurationRequest,
    ctx: RequestContext
  ): Promise<ApiWaveCuration> {
    return await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const lockedCurations =
          await this.curationsDb.lockWaveCurationsByWaveId(wave.id, txCtx);
        const targetCuration = lockedCurations.find(
          (curation) => curation.id === curationId
        );
        if (!targetCuration) {
          throw new NotFoundException(`Curation ${curationId} not found`);
        }
        const currentPriorityOrder = this.resolveCurrentPriorityOrder(
          targetCuration,
          lockedCurations
        );
        const validatedName = this.validateNameOrThrow(request.name);
        await this.assertCommunityGroupCanBeUsed(request.group_id, txCtx);
        await this.assertCurationNameIsUniqueInWave(
          {
            waveId: wave.id,
            name: validatedName,
            ignoreId: curationId
          },
          txCtx
        );
        const requestedPriorityOrder = request.priority_order;
        if (requestedPriorityOrder !== undefined) {
          this.assertPriorityOrderWithinBoundariesOrThrow({
            priorityOrder: requestedPriorityOrder,
            maxPriorityOrder: lockedCurations.length + 1
          });
        }
        const nextPriorityOrder =
          requestedPriorityOrder === undefined
            ? currentPriorityOrder
            : Math.min(requestedPriorityOrder, lockedCurations.length);
        if (nextPriorityOrder < currentPriorityOrder) {
          await this.curationsDb.incrementWaveCurationPriorityOrderRange(
            {
              wave_id: wave.id,
              from_priority_order: nextPriorityOrder,
              to_priority_order: currentPriorityOrder - 1
            },
            txCtx
          );
        } else if (nextPriorityOrder > currentPriorityOrder) {
          await this.curationsDb.decrementWaveCurationPriorityOrderRange(
            {
              wave_id: wave.id,
              from_priority_order: currentPriorityOrder + 1,
              to_priority_order: nextPriorityOrder
            },
            txCtx
          );
        }
        await this.curationsDb.updateWaveCuration(
          {
            id: curationId,
            wave_id: wave.id,
            name: validatedName,
            community_group_id: request.group_id,
            updated_at: Time.currentMillis(),
            priority_order: nextPriorityOrder
          },
          txCtx
        );
        const updated = await this.curationsDb.findWaveCurationById(
          { id: curationId, wave_id: wave.id },
          connection
        );
        if (!updated) {
          throw new NotFoundException(`Curation ${curationId} not found`);
        }
        return this.waveCurationToApi(updated);
      }
    );
  }

  public async deleteWaveCuration(
    waveId: string,
    curationId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.curationsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveCurations(waveId, txCtx);
        const lockedCurations =
          await this.curationsDb.lockWaveCurationsByWaveId(wave.id, txCtx);
        const targetCuration = lockedCurations.find(
          (curation) => curation.id === curationId
        );
        if (!targetCuration) {
          throw new NotFoundException(`Curation ${curationId} not found`);
        }
        const currentPriorityOrder = this.resolveCurrentPriorityOrder(
          targetCuration,
          lockedCurations
        );
        await this.curationsDb.deleteDropCurationsByCurationId(
          curationId,
          txCtx
        );
        await this.curationsDb.deleteWaveCuration(
          { id: curationId, wave_id: wave.id },
          txCtx
        );
        if (currentPriorityOrder < lockedCurations.length) {
          await this.curationsDb.decrementWaveCurationPriorityOrderRange(
            {
              wave_id: wave.id,
              from_priority_order: currentPriorityOrder + 1
            },
            txCtx
          );
        }
      }
    );
  }

  public async addDropCuration(
    dropId: string,
    request: ApiDropCurationRequest,
    ctx: RequestContext
  ) {
    const { profileId, drop, wave, curation } =
      await this.getCurationContextForAuthenticatedCurator(
        dropId,
        request.curation_id,
        ctx
      );
    await this.curationsDb.upsertDropCuration(
      {
        drop_id: drop.id,
        curation_id: curation.id,
        curated_by: profileId,
        wave_id: wave.id
      },
      ctx
    );
  }

  public async removeDropCuration(
    dropId: string,
    request: ApiDropCurationRequest,
    ctx: RequestContext
  ) {
    const { drop, curation } =
      await this.getCurationContextForAuthenticatedCurator(
        dropId,
        request.curation_id,
        ctx
      );
    await this.curationsDb.deleteDropCuration(
      {
        drop_id: drop.id,
        curation_id: curation.id
      },
      ctx
    );
  }

  public async findDropCurations(
    dropId: string,
    ctx: RequestContext
  ): Promise<ApiDropCuration[]> {
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const drop = await this.dropsDb.findDropById(dropId, ctx.connection);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const wave = await this.wavesApiDb.findWaveById(
      drop.wave_id,
      ctx.connection
    );
    assertWaveVisibleOrThrow(
      wave,
      groupsUserIsEligibleFor,
      `Drop ${dropId} not found`
    );
    const [waveCurations, dropCurationIds, curatorEligibleGroupIds] =
      await Promise.all([
        this.curationsDb.findWaveCurationsByWaveId(wave!.id, ctx.connection),
        this.curationsDb.findCurationIdsForDropId(drop.id, ctx.connection),
        this.getEligibleGroupIdsForAuthenticatedCurator(ctx)
      ]);
    return waveCurations.map((entity, index) =>
      this.dropCurationToApi(entity, {
        dropIncluded: dropCurationIds.has(entity.id),
        authenticatedUserCanCurate: curatorEligibleGroupIds.includes(
          entity.community_group_id
        ),
        fallbackPriorityOrder: index + 1
      })
    );
  }

  private async getCurationContextForAuthenticatedCurator(
    dropId: string,
    curationId: string,
    ctx: RequestContext
  ): Promise<{
    profileId: string;
    drop: {
      id: string;
      wave_id: string;
    };
    wave: {
      id: string;
    };
    curation: WaveCurationEntity;
  }> {
    const profileId = getAuthenticatedNonProxyProfileIdOrThrow(
      ctx,
      `Proxies can't curate drops`
    );
    const drop = await this.dropsDb.findDropById(dropId, ctx.connection);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const wave = await this.wavesApiDb.findWaveById(
      drop.wave_id,
      ctx.connection
    );
    if (!wave) {
      throw new NotFoundException(`Wave ${drop.wave_id} not found`);
    }
    const curation = await this.curationsDb.findWaveCurationById(
      {
        id: curationId,
        wave_id: wave.id
      },
      ctx.connection
    );
    if (!curation) {
      throw new NotFoundException(`Curation ${curationId} not found`);
    }
    await this.assertProfileCanCurateCuration(
      {
        profileId,
        curation
      },
      ctx
    );
    return { profileId, drop, wave, curation };
  }

  private async assertCanManageWaveCurations(
    waveId: string,
    ctx: RequestContext
  ): Promise<{
    wave: {
      id: string;
      admin_group_id: string | null;
      created_by: string;
    };
    profileId: string;
  }> {
    return await getWaveManagementContextOrThrow({
      waveId,
      ctx,
      wavesApiDb: this.wavesApiDb,
      userGroupsService: this.userGroupsService,
      proxyErrorMessage: `Proxies can't manage curations`,
      forbiddenMessage: `You can't manage curations in wave ${waveId}`,
      allowCreator: true,
      requireAdminGroup: false
    });
  }

  private async assertProfileCanCurateCuration(
    param: { profileId: string; curation: WaveCurationEntity },
    ctx: RequestContext
  ): Promise<void> {
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        param.profileId,
        ctx.timer
      );
    if (!groupsUserIsEligibleFor.includes(param.curation.community_group_id)) {
      throw new ForbiddenException(
        `You are not eligible to curate in this curation`
      );
    }
  }

  private async getEligibleGroupIdsForAuthenticatedCurator(
    ctx: RequestContext
  ): Promise<string[]> {
    const authenticationContext = ctx.authenticationContext;
    if (
      !authenticationContext?.isUserFullyAuthenticated() ||
      authenticationContext.isAuthenticatedAsProxy()
    ) {
      return [];
    }
    const profileId = authenticationContext.getActingAsId();
    if (!profileId) {
      return [];
    }
    return await this.userGroupsService.getGroupsUserIsEligibleFor(
      profileId,
      ctx.timer
    );
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
      throw new BadRequestException(`Curation name must be 1-50 chars`);
    }
    return normalized;
  }

  private async assertCurationNameIsUniqueInWave(
    param: { waveId: string; name: string; ignoreId?: string },
    ctx: RequestContext
  ): Promise<void> {
    const existing = await this.curationsDb.findWaveCurationByName(
      {
        wave_id: param.waveId,
        name: param.name
      },
      ctx.connection
    );
    if (existing && existing.id !== param.ignoreId) {
      throw new BadRequestException(
        `Curation name '${param.name}' already exists in this wave`
      );
    }
  }

  private resolveRequestedPriorityOrderOrThrow(param: {
    requestedPriorityOrder: number | undefined;
    maxPriorityOrder: number;
  }): number {
    const priorityOrder =
      param.requestedPriorityOrder ?? param.maxPriorityOrder;
    this.assertPriorityOrderWithinBoundariesOrThrow({
      priorityOrder,
      maxPriorityOrder: param.maxPriorityOrder
    });
    return priorityOrder;
  }

  private assertPriorityOrderWithinBoundariesOrThrow(param: {
    priorityOrder: number;
    maxPriorityOrder: number;
  }): void {
    if (
      !Number.isInteger(param.priorityOrder) ||
      param.priorityOrder < 1 ||
      param.priorityOrder > param.maxPriorityOrder
    ) {
      throw new BadRequestException(
        `Curation priority_order must be between 1 and ${param.maxPriorityOrder}`
      );
    }
  }

  private resolveCurrentPriorityOrder(
    targetCuration: WaveCurationEntity,
    orderedCurations: WaveCurationEntity[]
  ): number {
    return (
      targetCuration.priority_order ??
      orderedCurations.findIndex(
        (curation) => curation.id === targetCuration.id
      ) + 1
    );
  }

  private waveCurationsToApi(
    entities: WaveCurationEntity[]
  ): ApiWaveCuration[] {
    return entities.map((entity, index) =>
      this.waveCurationToApi(entity, index + 1)
    );
  }

  private waveCurationToApi(
    entity: WaveCurationEntity,
    fallbackPriorityOrder?: number
  ): ApiWaveCuration {
    const priorityOrder = entity.priority_order ?? fallbackPriorityOrder;
    if (priorityOrder === undefined) {
      throw new Error(`Curation ${entity.id} is missing priority_order`);
    }
    return {
      id: entity.id,
      name: entity.name,
      wave_id: entity.wave_id,
      group_id: entity.community_group_id,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      priority_order: priorityOrder
    };
  }

  private dropCurationToApi(
    entity: WaveCurationEntity,
    param: {
      dropIncluded: boolean;
      authenticatedUserCanCurate: boolean;
      fallbackPriorityOrder?: number;
    }
  ): ApiDropCuration {
    return {
      ...this.waveCurationToApi(entity, param.fallbackPriorityOrder),
      drop_included: param.dropIncluded,
      authenticated_user_can_curate: param.authenticatedUserCanCurate
    };
  }
}

export const curationsApiService = new CurationsApiService(
  curationsDb,
  wavesApiDb,
  dropsDb,
  userGroupsService
);
