import { ApiWaveMetadata } from '@/api/generated/models/ApiWaveMetadata';
import {
  assertWaveAndParentVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveManagementContextOrThrow
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import {
  waveMetadataDb,
  WaveMetadata,
  WaveMetadataDb
} from '@/api/waves/wave-metadata.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';

export class WaveMetadataApiService {
  constructor(
    private readonly waveMetadataDb: WaveMetadataDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async list(
    waveId: string,
    ctx: RequestContext
  ): Promise<ApiWaveMetadata[]> {
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const wave = await this.wavesApiDb.findWaveById(waveId, ctx.connection);
    await assertWaveAndParentVisibleOrThrow({
      wave,
      groupsUserIsEligibleFor,
      message: `Wave ${waveId} not found`,
      wavesApiDb: this.wavesApiDb,
      ctx
    });
    const metadata = await this.waveMetadataDb.listByWaveId(waveId, ctx);
    return metadata.map((row) => this.toApiWaveMetadata(row));
  }

  public async create(
    {
      waveId,
      dataKey,
      dataValue
    }: {
      waveId: string;
      dataKey: string;
      dataValue: string;
    },
    ctx: RequestContext
  ): Promise<ApiWaveMetadata> {
    await this.assertCanManageWaveMetadata(waveId, ctx);
    const metadata = await this.waveMetadataDb.create(
      { waveId, dataKey, dataValue },
      ctx
    );
    return this.toApiWaveMetadata(metadata);
  }

  public async delete(
    {
      waveId,
      metadataId
    }: {
      waveId: string;
      metadataId: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveMetadata> {
    await this.assertCanManageWaveMetadata(waveId, ctx);
    const metadata = await this.waveMetadataDb.deleteByIdAndWaveId(
      metadataId,
      waveId,
      ctx
    );
    if (!metadata) {
      throw new NotFoundException(
        `Wave metadata ${metadataId} not found for wave ${waveId}`
      );
    }
    return this.toApiWaveMetadata(metadata);
  }

  private async assertCanManageWaveMetadata(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    await getWaveManagementContextOrThrow({
      waveId,
      ctx,
      wavesApiDb: this.wavesApiDb,
      userGroupsService: this.userGroupsService,
      proxyErrorMessage: `Proxies can't manage wave metadata`,
      forbiddenMessage: `You can't manage metadata for a wave you didn't create and are not an admin of`,
      allowCreator: true,
      requireAdminGroup: false
    });
  }

  private toApiWaveMetadata(metadata: WaveMetadata): ApiWaveMetadata {
    return {
      id: metadata.id,
      data_key: metadata.data_key,
      data_value: metadata.data_value
    };
  }
}

export const waveMetadataApiService = new WaveMetadataApiService(
  waveMetadataDb,
  wavesApiDb,
  userGroupsService
);
