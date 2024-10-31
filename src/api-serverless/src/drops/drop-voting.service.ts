import { RequestContext } from '../../../request.context';
import { Time } from '../../../time';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropEntity, DropType } from '../../../entities/IDrop';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';
import { DropVotingDb, dropVotingDb } from './drop-voting.db';
import {
  WaveCreditScopeType,
  WaveCreditType,
  WaveType
} from '../../../entities/IWave';
import { ConnectionWrapper } from '../../../sql-executor';
import { distinct } from '../../../helpers';

export class DropVotingService {
  constructor(
    private readonly votingDb: DropVotingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}

  public async vote(
    {
      voter_id,
      drop_id,
      wave_id,
      votes,
      proxy_id
    }: {
      voter_id: string;
      drop_id: string;
      wave_id: string;
      votes: number;
      proxy_id: string | null;
    },
    ctx: RequestContext
  ) {
    if (!ctx.connection) {
      await this.votingDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.vote(
            { voter_id, drop_id, wave_id, votes, proxy_id },
            { ...ctx, connection }
          );
        }
      );
      return;
    }
    await this.votingDb.lockAggregateDropRank(drop_id, ctx.connection);
    const now = Time.now();
    const [
      drop,
      groupsVoterIsEligibleFor,
      wave,
      currentVote,
      creditSpentBeforeThisVote,
      voterTotalCredit
    ] = await Promise.all([
      this.dropsDb.findDropById(drop_id, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(voter_id, ctx.timer),
      this.wavesDb.findById(wave_id, ctx.connection),
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
      this.identitiesDb
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

    if (wave.voting_credit_type !== WaveCreditType.TDH) {
      throw new BadRequestException(
        `Voting in waves with credit type ${wave.voting_credit_type} not yet supported`
      );
    }
    if (wave.time_lock_ms !== null && wave.time_lock_ms > 0) {
      throw new BadRequestException(
        `Voting in time locked waves not yet supported`
      );
    }
    if (wave.voting_credit_scope_type !== WaveCreditScopeType.WAVE) {
      throw new BadRequestException(
        `Voting im waves with credit scope type ${wave.voting_credit_scope_type} not yet supported`
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

  async findCreditLeftForVotingForDrops(
    profileId: string | null | undefined,
    dropEntities: DropEntity[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { min: number; max: number; current: number }>> {
    if (!profileId) {
      return {};
    }
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(profileId);
    const participationDrops = dropEntities.filter(
      (drop) => drop.drop_type === DropType.PARTICIPATORY
    );
    const relevantWaveIds = distinct(
      participationDrops.map((drop) => drop.wave_id)
    );
    const relevantWaves = await this.wavesDb.findWavesByIds(
      relevantWaveIds,
      groupIdsUserIsEligibleFor,
      connection
    );
    const wavesIdsWhereVotingIsImplemented = relevantWaves
      .filter((it) => {
        return (
          it.voting_credit_type === WaveCreditType.TDH &&
          it.voting_credit_scope_type === WaveCreditScopeType.WAVE &&
          it.time_lock_ms === null
        );
      })
      .map((it) => it.id);
    const relevantParticipationDrops = participationDrops.filter((drop) =>
      wavesIdsWhereVotingIsImplemented.includes(drop.wave_id)
    );
    const relevantParticipationDropIds = relevantParticipationDrops.map(
      (it) => it.id
    );
    const [activeVotes, totalVotesInRelevantWaves, tdh] = await Promise.all([
      this.votingDb.getVotersActiveVoteForDrops(
        {
          dropIds: relevantParticipationDropIds,
          voterId: profileId
        },
        {}
      ),
      this.votingDb.getVotersTotalVotesInWaves(
        { waveIds: wavesIdsWhereVotingIsImplemented, voterId: profileId },
        { connection }
      ),
      this.identitiesDb
        .getIdentityByProfileId(profileId)
        ?.then((identity) => identity?.tdh ?? 0)
    ]);
    return relevantParticipationDropIds.reduce((acc, dropId) => {
      const waveId = relevantParticipationDrops.find(
        (it) => it.id === dropId
      )?.wave_id;
      if (waveId) {
        const totalVotesInWave = totalVotesInRelevantWaves[waveId];
        const activeVote = activeVotes[dropId];
        if (totalVotesInWave !== undefined && activeVote !== undefined) {
          const creditLeft = Math.max(0, tdh - totalVotesInWave);
          if (activeVote < 0) {
            acc[dropId] = {
              min: activeVote - creditLeft,
              current: activeVote,
              max: -activeVote + creditLeft
            };
          } else if (activeVote > 0) {
            acc[dropId] = {
              min: -activeVote - creditLeft,
              current: activeVote,
              max: activeVote + creditLeft
            };
          } else {
            acc[dropId] = {
              min: creditLeft,
              current: activeVote,
              max: -creditLeft
            };
          }
        }
      }
      return acc;
    }, {} as Record<string, { min: number; current: number; max: number }>);
  }

  public async deleteVotes(dropId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForDrop(dropId, ctx),
      this.votingDb.deleteCreditSpendings(dropId, ctx),
      this.votingDb.deleteDropRanks(dropId, ctx)
    ]);
  }

  public async deleteVoteByWave(waveId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForWave(waveId, ctx),
      this.votingDb.deleteCreditSpendingsForWave(waveId, ctx),
      this.votingDb.deleteDropRanksForWave(waveId, ctx)
    ]);
  }
}

export const dropVotingService = new DropVotingService(
  dropVotingDb,
  identitiesDb,
  wavesApiDb,
  dropsDb,
  userGroupsService,
  userNotifier,
  profileActivityLogsDb
);
