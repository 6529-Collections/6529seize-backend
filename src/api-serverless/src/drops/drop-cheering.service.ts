import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { RequestContext } from '../../../request.context';
import { DropType } from '../../../entities/IDrop';
import { clappingService, ClappingService } from './clapping.service';
import * as process from 'node:process';
import {
  voteForDropUseCase,
  VoteForDropUseCase
} from '../../../drops/vote-for-drop.use-case';

export class DropCheeringService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly clappingService: ClappingService,
    private readonly voteForDrop: VoteForDropUseCase
  ) {}

  async updateCheers(
    param: {
      drop_id: string;
      rater_profile_id: string;
      groupIdsUserIsEligibleFor: string[];
      cheersChange: number;
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
            claps: param.cheersChange,
            wave_id: dropEntity.wave_id,
            proxy_id: null
          },
          ctxWithConnection
        );
      } else {
        if (process.env.NON_CHAT_DROP_VOTING_ENABLED !== 'true') {
          throw new Error(`Voting not implemented`);
        }
        await this.voteForDrop.execute(
          {
            drop_id: dropId,
            voter_id: param.rater_profile_id,
            votes: param.cheersChange,
            wave_id: dropEntity.wave_id,
            proxy_id: null
          },
          ctxWithConnection
        );
      }
    });
    await giveReadReplicaTimeToCatchUp();
  }
}

export const dropCheeringService = new DropCheeringService(
  dropsDb,
  clappingService,
  voteForDropUseCase
);
