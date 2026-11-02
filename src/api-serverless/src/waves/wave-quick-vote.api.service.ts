import { assertWaveAndParentVisibleOrThrow } from './wave-access.helpers';
import { ApiUndiscoveredDrops } from '@/api/generated/models/ApiUndiscoveredDrops';
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
import { RequestContext } from '@/request.context';
import {
  WaveQuickVoteDb,
  waveQuickVoteDb
} from '@/api/waves/wave-quick-vote.db';
import { WavesApiDb, wavesApiDb } from '@/api/waves/waves.api.db';
import { isApproveWaveClosed } from '@/waves/wave-approve.helpers';

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
    const result = await this.findUndiscoveredDrops(
      { ...param, limit: 1 },
      ctx
    );
    return {
      drop: result.drops[0] ?? null,
      total_count: result.total_count,
      left_to_vote_in_current_round: result.left_to_vote_in_current_round
    };
  }

  async findUndiscoveredDrops(
    param: { waveId: string; identityId: string; limit: number; skip?: number },
    ctx: RequestContext
  ): Promise<ApiUndiscoveredDrops> {
    const timerName = `${this.constructor.name}->findUndiscoveredDrops`;
    ctx.timer?.start(timerName);
    try {
      await this.assertQuickVoteEligibility(param, ctx);
      const quickVoteParams = {
        identity_id: param.identityId,
        wave_id: param.waveId
      };
      const counts = await this.waveQuickVoteDb.countDrops(
        quickVoteParams,
        ctx
      );
      const offset = param.skip ?? 0;
      const undiscoveredLimit = Math.min(
        param.limit,
        Math.max(counts.left_to_vote_in_current_round - offset, 0)
      );
      const drops =
        undiscoveredLimit > 0
          ? await this.waveQuickVoteDb.findDrops(
              { ...quickVoteParams, skip: offset, limit: undiscoveredLimit },
              false,
              ctx
            )
          : [];
      // Votes or skips can change after the count read. Fill the remainder from
      // the rows actually returned rather than leaving holes in the preview.
      const skippedLimit = param.limit - drops.length;
      if (skippedLimit > 0) {
        drops.push(
          ...(await this.waveQuickVoteDb.findDrops(
            {
              ...quickVoteParams,
              skip: Math.max(offset - counts.left_to_vote_in_current_round, 0),
              limit: skippedLimit
            },
            true,
            ctx
          ))
        );
      }
      const apiDrops =
        drops.length > 0
          ? await this.dropsMappers.convertToDropFulls(
              {
                dropEntities: drops,
                contextProfileId: param.identityId,
                authenticationContext: ctx.authenticationContext
              },
              ctx.connection
            )
          : [];
      return { drops: apiDrops, ...counts };
    } finally {
      ctx.timer?.stop(timerName);
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
    await assertWaveAndParentVisibleOrThrow({
      wave,
      groupsUserIsEligibleFor,
      message: `Wave ${param.waveId} not found`,
      wavesApiDb: this.wavesApiDb,
      ctx
    });
    if (wave.type === WaveType.CHAT) {
      throw new BadRequestException(`Voting is not allowed in chat waves`);
    }
    const noOfDecisionsDone = await this.wavesApiDb
      .countWaveDecisionsByWaveIds([wave.id], ctx)
      .then((it) => it[wave.id] ?? 0);
    if (
      isApproveWaveClosed({
        waveType: wave.type,
        maxWinners: wave.max_winners ?? null,
        decisionsDone: noOfDecisionsDone
      })
    ) {
      throw new BadRequestException(`Voting is closed in this wave`);
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
}

export const waveQuickVoteApiService = new WaveQuickVoteApiService(
  waveQuickVoteDb,
  wavesApiDb,
  userGroupsService,
  dropsMappers
);
