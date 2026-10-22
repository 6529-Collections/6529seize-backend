import { Timer } from '@/time';
import { ConnectionWrapper } from '@/sql-executor';
import { VoteForDropModel } from '@/drops/vote-for-drop.model';
import { dropVotingDb, DropVotingDb } from '@/api/drops/drop-voting.db';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { ratingsDb, RatingsDb } from '@/rates/ratings.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { userNotifier, UserNotifier } from '@/notifications/user.notifier';
import { metricsRecorder, MetricsRecorder } from '@/metrics/MetricsRecorder';
import { ForbiddenException } from '@/exceptions';
import { competitionRepository } from '@/competitions/competition.repository';
import { voteForMigratedLegacyEntry } from '@/competitions/legacy-competition-vote.service';

export class VoteForDropUseCase {
  constructor(
    private readonly votingDb: DropVotingDb,
    _identitiesDb: IdentitiesDb,
    _wavesDb: WavesApiDb,
    _dropsDb: DropsDb,
    _ratingsDb: RatingsDb,
    _userGroupsService: UserGroupsService,
    _userNotifier: UserNotifier,
    _metricsRecorder: MetricsRecorder
  ) {}

  public async execute(
    { voter_id, drop_id, wave_id, votes, proxy_id }: VoteForDropModel,
    ctx: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
    }
  ): Promise<boolean> {
    if (!ctx.connection) {
      return await this.votingDb.executeNativeQueriesInTransaction(
        async (connection) => {
          return await this.execute(
            { voter_id, drop_id, wave_id, votes, proxy_id },
            { ...ctx, connection }
          );
        },
        { isolationLevel: 'READ COMMITTED' }
      );
    }
    const owner = await competitionRepository.lockOriginalPrimary(wave_id, ctx);
    if (!owner)
      throw new ForbiddenException(
        'This drop does not belong to a competition'
      );
    return voteForMigratedLegacyEntry(
      owner,
      { voter_id, drop_id, wave_id, votes, proxy_id },
      ctx
    );
  }
}

export const voteForDropUseCase = new VoteForDropUseCase(
  dropVotingDb,
  identitiesDb,
  wavesApiDb,
  dropsDb,
  ratingsDb,
  userGroupsService,
  userNotifier,
  metricsRecorder
);
