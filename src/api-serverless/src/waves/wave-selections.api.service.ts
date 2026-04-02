import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper } from '@/sql-executor';
import { Time } from '@/time';
import { DropsDb, dropsDb } from '@/drops/drops.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { ApiWaveSelection } from '@/api/generated/models/ApiWaveSelection';
import { ApiWaveSelectionDropRequest } from '@/api/generated/models/ApiWaveSelectionDropRequest';
import { ApiWaveSelectionRequest } from '@/api/generated/models/ApiWaveSelectionRequest';
import {
  assertWaveVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveManagementContextOrThrow
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { mapWaveSelectionEntityToApiWaveSelection } from '@/api/waves/wave-selections.helpers';
import {
  WaveSelectionsDb,
  waveSelectionsDb
} from '@/api/waves/wave-selections.db';
import { WaveSelectionEntity } from '@/entities/IWaveSelection';

export class WaveSelectionsApiService {
  constructor(
    private readonly waveSelectionsDb: WaveSelectionsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async findWaveSelections(
    waveId: string,
    ctx: RequestContext
  ): Promise<ApiWaveSelection[]> {
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
    return await this.waveSelectionsDb
      .findWaveSelectionsByWaveIds([waveId], ctx.connection)
      .then((entities) =>
        entities.map((entity) =>
          mapWaveSelectionEntityToApiWaveSelection(entity)
        )
      );
  }

  public async createWaveSelection(
    waveId: string,
    request: ApiWaveSelectionRequest,
    ctx: RequestContext
  ): Promise<ApiWaveSelection> {
    return await this.waveSelectionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveSelections(
          waveId,
          txCtx
        );
        const now = Time.currentMillis();
        const entity: WaveSelectionEntity = {
          id: randomUUID(),
          title: this.validateTitleOrThrow(request.title),
          wave_id: wave.id,
          created_at: now,
          updated_at: now
        };
        await this.waveSelectionsDb.insertWaveSelection(entity, txCtx);
        return mapWaveSelectionEntityToApiWaveSelection(entity);
      }
    );
  }

  public async deleteWaveSelection(
    waveId: string,
    selectionId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.waveSelectionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveSelections(
          waveId,
          txCtx
        );
        await this.getWaveSelectionOrThrow({
          selectionId,
          waveId: wave.id,
          connection
        });
        await Promise.all([
          this.waveSelectionsDb.deleteWaveSelectionDropsBySelectionId(
            selectionId,
            txCtx
          ),
          this.waveSelectionsDb.deleteWaveSelection(
            { id: selectionId, wave_id: wave.id },
            txCtx
          )
        ]);
      }
    );
  }

  public async addDropToWaveSelection(
    waveId: string,
    selectionId: string,
    request: ApiWaveSelectionDropRequest,
    ctx: RequestContext
  ): Promise<void> {
    await this.waveSelectionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveSelections(
          waveId,
          txCtx
        );
        await this.getWaveSelectionOrThrow({
          selectionId,
          waveId: wave.id,
          connection
        });
        const drop = await this.dropsDb.findDropById(
          request.drop_id,
          connection
        );
        if (!drop) {
          throw new NotFoundException(`Drop ${request.drop_id} not found`);
        }
        if (drop.wave_id !== wave.id) {
          throw new BadRequestException(
            `Selection can only contain drops from the same wave`
          );
        }
        const now = Time.currentMillis();
        await this.waveSelectionsDb.upsertWaveSelectionDrop(
          {
            selection_id: selectionId,
            drop_id: request.drop_id,
            wave_id: wave.id,
            created_at: now,
            updated_at: now
          },
          txCtx
        );
      }
    );
  }

  public async removeDropFromWaveSelection(
    waveId: string,
    selectionId: string,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.waveSelectionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const { wave } = await this.assertCanManageWaveSelections(
          waveId,
          txCtx
        );
        await this.getWaveSelectionOrThrow({
          selectionId,
          waveId: wave.id,
          connection
        });
        await this.waveSelectionsDb.deleteWaveSelectionDrop(
          {
            selection_id: selectionId,
            drop_id: dropId
          },
          txCtx
        );
      }
    );
  }

  private validateTitleOrThrow(title: string): string {
    const trimmed = title.trim();
    if (!trimmed.length) {
      throw new BadRequestException(`Selection title is required`);
    }
    if (trimmed.length > 250) {
      throw new BadRequestException(
        `Selection title cannot exceed 250 characters`
      );
    }
    return trimmed;
  }

  private async getWaveSelectionOrThrow({
    selectionId,
    waveId,
    connection
  }: {
    selectionId: string;
    waveId: string;
    connection?: ConnectionWrapper<any>;
  }) {
    const selection = await this.waveSelectionsDb.findWaveSelectionById(
      {
        id: selectionId,
        wave_id: waveId
      },
      connection
    );
    if (!selection) {
      throw new NotFoundException(`Selection ${selectionId} not found`);
    }
    return selection;
  }

  private async assertCanManageWaveSelections(
    waveId: string,
    ctx: RequestContext
  ): Promise<{
    wave: {
      id: string;
      admin_group_id: string | null;
    };
    profileId: string;
  }> {
    return await getWaveManagementContextOrThrow({
      waveId,
      ctx,
      wavesApiDb: this.wavesApiDb,
      userGroupsService: this.userGroupsService,
      proxyErrorMessage: `Proxies can't manage wave selections`,
      forbiddenMessage: `You can't manage selections in wave ${waveId}`,
      allowCreator: false,
      requireAdminGroup: true
    });
  }
}

export const waveSelectionsApiService = new WaveSelectionsApiService(
  waveSelectionsDb,
  wavesApiDb,
  dropsDb,
  userGroupsService
);
