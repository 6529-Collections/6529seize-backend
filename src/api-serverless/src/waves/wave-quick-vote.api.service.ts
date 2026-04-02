import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiUndiscoveredDrop } from '@/api/generated/models/ApiUndiscoveredDrop';
import { DropsMappers, dropsMappers } from '@/api/drops/drops.mappers';
import {
  UserGroupsService,
  userGroupsService
} from '@/api/community-members/user-groups.service';
import { WaveType } from '@/entities/IWave';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { DropEntity } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import {
  WaveQuickVoteDb,
  waveQuickVoteDb
} from '@/api/waves/wave-quick-vote.db';
import { WavesApiDb, wavesApiDb } from '@/api/waves/waves.api.db';

export class WaveQuickVoteApiService {
  constructor(
    private readonly waveQuickVoteDb: WaveQuickVoteDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly dropsMappers: DropsMappers
  ) {}

  async findUndiscoveredDrop(
    param: { waveId: string; identityId: string; skip?: number },
    ctx: RequestContext
  ): Promise<ApiUndiscoveredDrop> {
    ctx.timer?.start(`${this.constructor.name}->findUndiscoveredDrop`);
    try {
      await this.assertQuickVoteEligibility(param, ctx);
      const quickVoteParams = {
        identity_id: param.identityId,
        wave_id: param.waveId
      };
      const offset = param.skip ?? 0;
      const [totalCount, undiscoveredCount] = await Promise.all([
        this.waveQuickVoteDb.countUnvotedDrops(quickVoteParams, ctx),
        this.waveQuickVoteDb.countUndiscoveredDrops(quickVoteParams, ctx)
      ]);
      const leftToVoteInCurrentRound = undiscoveredCount;
      let drop: DropEntity | null;
      if (offset < undiscoveredCount) {
        drop =
          offset === 0
            ? await this.waveQuickVoteDb.findNextUndiscoveredDrop(
                quickVoteParams,
                ctx
              )
            : await this.waveQuickVoteDb.findUndiscoveredDropBySkip(
                { ...quickVoteParams, skip: offset },
                ctx
              );
      } else {
        const skippedOffset = Math.max(offset - undiscoveredCount, 0);
        drop = await this.waveQuickVoteDb.findSkippedUnvotedDropBySkip(
          { ...quickVoteParams, skip: skippedOffset },
          ctx
        );
      }
      if (!drop) {
        return {
          drop: null,
          total_count: totalCount,
          left_to_vote_in_current_round: leftToVoteInCurrentRound
        };
      }
      const apiDrop = await this.toApiDrop(drop, param.identityId, ctx);
      return {
        drop: apiDrop,
        total_count: totalCount,
        left_to_vote_in_current_round: leftToVoteInCurrentRound
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findUndiscoveredDrop`);
    }
  }

  private async assertQuickVoteEligibility(
    param: { waveId: string; identityId: string },
    ctx: RequestContext
  ): Promise<void> {
    const [wave, groupsUserIsEligibleFor] = await Promise.all([
      this.wavesApiDb.findWaveById(param.waveId, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(
        param.identityId,
        ctx.timer
      )
    ]);
    if (!wave) {
      throw new NotFoundException(`Wave ${param.waveId} not found`);
    }
    if (
      wave.visibility_group_id !== null &&
      !groupsUserIsEligibleFor.includes(wave.visibility_group_id)
    ) {
      throw new NotFoundException(`Wave ${param.waveId} not found`);
    }
    if (wave.type === WaveType.CHAT) {
      throw new BadRequestException(`Voting is not allowed in chat waves`);
    }
    if (
      wave.voting_group_id !== null &&
      !groupsUserIsEligibleFor.includes(wave.voting_group_id)
    ) {
      throw new ForbiddenException(
        `Voter is not eligible to vote in this wave`
      );
    }
  }

  private async toApiDrop(
    drop: DropEntity,
    identityId: string,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    return this.dropsMappers
      .convertToDropFulls(
        {
          dropEntities: [drop],
          contextProfileId: identityId,
          authenticationContext: ctx.authenticationContext
        },
        ctx.connection
      )
      .then((drops) => drops[0]!);
  }
}

export const waveQuickVoteApiService = new WaveQuickVoteApiService(
  waveQuickVoteDb,
  wavesApiDb,
  userGroupsService,
  dropsMappers
);
