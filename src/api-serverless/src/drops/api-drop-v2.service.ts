import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import { apiDropMapper, ApiDropMapper } from '@/api/drops/api-drop.mapper';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';

export type ApiDropWithWave = ApiDropAndWave;

export class ApiDropV2Service {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly apiDropMapper: ApiDropMapper,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper
  ) {}

  public async findWithWaveByIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiDropWithWave> {
    const timerKey = `${this.constructor.name}->findWithWaveByIdOrThrow`;
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
      const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
        id,
        groupIdsUserIsEligibleFor,
        ctx.connection
      );
      if (!dropEntity) {
        throw new NotFoundException(`Drop ${id} not found`);
      }

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
}

export const apiDropV2Service = new ApiDropV2Service(
  dropsDb,
  userGroupsService,
  apiDropMapper,
  apiWaveOverviewMapper
);
