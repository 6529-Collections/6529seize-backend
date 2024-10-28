import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time } from '../../../time';
import { RequestContext } from '../../../request.context';
import { DropType } from '../../../entities/IDrop';
import { clappingService, ClappingService } from './clapping.service';
import * as process from 'node:process';

export class DropVotingService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly clappingService: ClappingService
  ) {}

  async updateVote(
    param: {
      drop_id: string;
      rater_profile_id: string;
      groupIdsUserIsEligibleFor: string[];
      rating: number;
      category: string;
    },
    ctx: RequestContext
  ) {
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const dropId = param.drop_id;
      const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
        dropId,
        param.groupIdsUserIsEligibleFor,
        connection
      );
      const ctxWithConnection = { ...ctx, connection };
      if (!dropEntity) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }
      if (dropEntity.drop_type === DropType.CHAT) {
        await this.clappingService.clap(
          {
            drop_id: dropId,
            clapper_id: param.rater_profile_id,
            claps: param.rating,
            wave_id: dropEntity.wave_id,
            proxy_id: null
          },
          ctxWithConnection
        );
      } else {
        if (process.env.NON_CHAT_DROP_VOTING_ENABLED !== 'true') {
          throw new Error(`Voting not implemented`);
        }
        if (dropEntity.author_id === param.rater_profile_id) {
          throw new BadRequestException(`You can't rate your own drop`);
        }
        const wave = await this.dropsDb.findWaveByIdOrThrow(
          dropEntity.wave_id,
          connection
        );
        if (
          wave.voting_period_start !== null &&
          wave.voting_period_start > Time.currentMillis()
        ) {
          throw new BadRequestException(
            `Voting period for this drop hasn't started`
          );
        }
        if (
          wave.voting_period_end !== null &&
          wave.voting_period_end < Time.currentMillis()
        ) {
          throw new BadRequestException(
            `Voting period for this drop has ended`
          );
        }
        if (
          wave.voting_group_id !== null &&
          !param.groupIdsUserIsEligibleFor.includes(wave.voting_group_id)
        ) {
          throw new BadRequestException(
            `User is not eligible to vote in this wave`
          );
        }
      }
    });
    await giveReadReplicaTimeToCatchUp();
  }
}

export const dropRaterService = new DropVotingService(dropsDb, clappingService);
