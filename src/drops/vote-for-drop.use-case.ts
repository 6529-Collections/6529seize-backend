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
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { WaveCreditType, WaveType } from '../entities/IWave';
import { BadRequestException, ForbiddenException } from '../exceptions';
import { DropType } from '../entities/IDrop';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { metricsRecorder, MetricsRecorder } from '../metrics/MetricsRecorder';

export class VoteForDropUseCase {
  constructor(
    private readonly votingDb: DropVotingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly ratingsDb: RatingsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier,
    private readonly metricsRecorder: MetricsRecorder
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
    await this.votingDb.lockDropsCurrentRealVote(drop_id, ctx);
    const now = Time.now();
    const wave = await this.wavesDb.findById(wave_id, ctx.connection);
    if (
      wave &&
      wave.next_decision_time !== null &&
      wave.next_decision_time < Time.currentMillis()
    ) {
      throw new ForbiddenException(
        `Wave has unresolved decisions and votes can't be edited at the moment. Try again later`
      );
    }
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
      this.votingDb.getDropVoterStateForDrop(
        { voterId: voter_id, drop_id: drop_id },
        ctx
      ),
      this.votingDb.getVotingCreditLockedInWaveForVoter(
        {
          waveId: wave_id,
          voterId: voter_id
        },
        ctx
      ),
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
            ?.then((identity) => {
              const tdh = identity?.tdh ?? 0;
              const xtdh = identity?.xtdh ?? 0;
              if (wave?.voting_credit_type === WaveCreditType.TDH) return tdh;
              if (wave?.voting_credit_type === WaveCreditType.XTDH) return xtdh;
              if (wave?.voting_credit_type === WaveCreditType.TDH_PLUS_XTDH) {
                return tdh + xtdh;
              }
              return 0;
            })
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
    if (drop.drop_type !== DropType.PARTICIPATORY) {
      throw new BadRequestException(`You can't vote on this drop`);
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
    const change = votes - currentVote;
    const newVote = currentVote + change;
    const diff = Math.abs(newVote) - Math.abs(currentVote);

    if (diff + creditSpentBeforeThisVote > voterTotalCredit) {
      throw new BadRequestException('Not enough credit to vote');
    }
    if (wave.forbid_negative_votes && newVote < 0) {
      throw new BadRequestException(
        `Negative votes are not allowed in this wave`
      );
    }
    await Promise.all([
      this.votingDb.upsertState(
        {
          voter_id: voter_id,
          drop_id: drop_id,
          wave_id: wave.id,
          votes: newVote
        },
        ctx
      ),
      this.votingDb.upsertAggregateDropRank(
        {
          drop_id,
          wave_id,
          change
        },
        ctx
      ),
      this.metricsRecorder.recordVote(
        { wave_id, vote_change: change, voter_id },
        ctx
      ),
      this.metricsRecorder.recordActiveIdentity(
        { identityId: drop.author_id },
        ctx
      )
    ]);
    await Promise.all([
      this.votingDb.snapShotDropsRealVoteInTimeBasedOnRank(
        drop_id,
        now.toMillis(),
        ctx
      ),
      this.votingDb.snapshotDropVotersRealVoteInTimeBasedOnVoterState(
        {
          voterId: voter_id,
          dropId: drop_id,
          now: now.toMillis()
        },
        ctx
      ),
      this.votingDb.insertCreditSpending(
        {
          voter_id,
          drop_id,
          credit_spent: diff,
          created_at: now.toMillis(),
          wave_id: wave_id
        },
        ctx
      ),
      profileActivityLogsDb.insert(
        {
          profile_id: voter_id,
          type: ProfileActivityLogType.DROP_VOTE_EDIT,
          target_id: drop_id,
          contents: JSON.stringify({
            oldVote: currentVote,
            newVote: votes
          }),
          additional_data_1: drop.author_id,
          additional_data_2: drop.wave_id,
          proxy_id: proxy_id
        },
        ctx.connection,
        ctx.timer
      )
    ]);
    if (drop.author_id !== voter_id) {
      await this.userNotifier.notifyOfDropVote(
        {
          voter_id,
          drop_id: drop_id,
          drop_author_id: drop.author_id,
          vote: votes,
          wave_id: wave_id
        },
        wave.visibility_group_id,
        ctx.connection
      );
    }
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
