import { Time, Timer } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { VoteForDropModel } from './vote-for-drop.model';
import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import { identitiesDb, IdentitiesDb } from '../identities/identities.db';
import {
  wavesApiDb,
  WavesApiDb
} from '../api-serverless/src/waves/waves.api.db';
import { dropsDb, DropsDb } from './drops.db';
import { ratingsDb, RatingsDb } from '../rates/ratings.db';
import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { userNotifier, UserNotifier } from '../notifications/user.notifier';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import { WaveCreditType, WaveType } from '../entities/IWave';
import { BadRequestException, ForbiddenException } from '../exceptions';
import { DropType } from '../entities/IDrop';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';

export class VoteForDropUseCase {
  constructor(
    private readonly votingDb: DropVotingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly ratingsDb: RatingsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}

  public async execute(
    { voter_id, drop_id, wave_id, votes, proxy_id }: VoteForDropModel,
    ctx: {
      timer?: Timer;
      connection: ConnectionWrapper<any>;
    }
  ) {
    if (!ctx.connection) {
      await this.votingDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.execute(
            { voter_id, drop_id, wave_id, votes, proxy_id },
            { ...ctx, connection }
          );
        }
      );
      return;
    }
    await this.votingDb.lockAggregateDropRank(drop_id, ctx.connection);
    const now = Time.now();
    const wave = await this.wavesDb.findById(wave_id, ctx.connection);
    const isRepWave = wave?.voting_credit_type === WaveCreditType.REP;
    const [
      drop,
      groupsVoterIsEligibleFor,
      currentVote,
      creditSpentBeforeThisVote,
      voterTotalCredit
    ] = await Promise.all([
      this.dropsDb.findDropById(drop_id, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(voter_id, ctx.timer),
      this.votingDb.getCurrentState(
        { voterId: voter_id, drop_id: drop_id },
        ctx
      ),
      this.votingDb
        .getCreditSpentInWaves(
          {
            waveIds: [wave_id],
            voterId: voter_id
          },
          ctx
        )
        .then((it) => it[wave_id] ?? 0),
      isRepWave
        ? this.ratingsDb.getRepRating(
            {
              target_profile_id: voter_id,
              category: wave?.voting_credit_category ?? null,
              rater_profile_id: wave?.voting_credit_creditor ?? null
            },
            ctx
          )
        : this.identitiesDb
            .getIdentityByProfileId(voter_id, ctx.connection)
            ?.then((identity) => identity?.tdh ?? 0)
    ]);

    if (!drop || drop.wave_id !== wave?.id) {
      throw new BadRequestException('Drop not found');
    }
    if (!wave) {
      throw new BadRequestException('Wave not found');
    }
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
      throw new BadRequestException(`Voting period for this drop has ended`);
    }
    if (drop.drop_type === DropType.CHAT) {
      throw new BadRequestException(`You can't vote on a chat drop`);
    }
    if (drop.author_id === voter_id) {
      throw new BadRequestException(`You can't vote on your own drop`);
    }
    if (
      wave.voting_group_id !== null &&
      !groupsVoterIsEligibleFor.includes(wave.voting_group_id)
    ) {
      throw new ForbiddenException(
        'Voter is not eligible to vote in this wave'
      );
    }
    if (wave.type === WaveType.CHAT) {
      throw new ForbiddenException('Voting is not allowed in chat waves');
    }
    const creditSpentWithCurrentVotes = Math.abs(votes - currentVote);

    if (
      creditSpentWithCurrentVotes + creditSpentBeforeThisVote >
      voterTotalCredit
    ) {
      throw new BadRequestException('Not enough credit to vote');
    }
    if (wave.time_lock_ms !== null && wave.time_lock_ms > 0) {
      throw new BadRequestException(
        `Voting in time locked waves not yet supported`
      );
    }
    const change = votes - currentVote;

    await Promise.all([
      this.votingDb.upsertAggregateDropRank(
        {
          drop_id,
          wave_id,
          change
        },
        ctx
      ),
      this.votingDb.upsertState(
        {
          voter_id,
          drop_id,
          votes,
          wave_id
        },
        ctx
      ),
      this.votingDb.insertCreditSpending(
        {
          voter_id,
          drop_id,
          credit_spent: creditSpentWithCurrentVotes,
          created_at: now.toMillis(),
          wave_id: wave_id
        },
        ctx
      ),
      this.profileActivityLogsDb.insert(
        {
          profile_id: voter_id,
          type: ProfileActivityLogType.DROP_VOTE_EDIT,
          target_id: drop_id,
          contents: JSON.stringify({
            oldVote: currentVote,
            newVote: votes
          }),
          additional_data_1: null,
          additional_data_2: null,
          proxy_id: proxy_id
        },
        ctx.connection,
        ctx.timer
      ),
      this.userNotifier.notifyOfDropVote(
        {
          voter_id,
          drop_id: drop_id,
          drop_author_id: drop.author_id,
          vote: votes,
          wave_id: wave_id
        },
        wave.visibility_group_id,
        ctx.connection
      )
    ]);
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
  profileActivityLogsDb
);