import { dropVotingDb } from '@/api-serverless/src/drops/drop-voting.db';
import { userNotifier } from '@/notifications/user.notifier';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { dropsDb } from '@/drops/drops.db';
import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';

describe('revokeTdhBasedDropWavesOverVotes', () => {
  const connection = {} as any;

  beforeEach(() => {
    jest
      .spyOn(dropsDb, 'findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts')
      .mockResolvedValue([
        {
          profile_id: 'voter-1',
          wave_id: 'wave-1',
          credit_limit: 1,
          total_given_votes: 2
        } as any
      ]);
    jest.spyOn(dropsDb, 'findDropVotesForWaves').mockResolvedValue([
      {
        drop_id: 'drop-1',
        votes: -1,
        author_id: 'author-1',
        visibility_group_id: null
      } as any
    ]);
    jest
      .spyOn(dropVotingDb, 'lockDropsCurrentRealVote')
      .mockResolvedValue(undefined);
    jest
      .spyOn(dropVotingDb, 'getDropVoterStateForDrop')
      .mockResolvedValue({ votes: -1 } as any);
    jest.spyOn(dropVotingDb, 'upsertState').mockResolvedValue(undefined);
    jest
      .spyOn(dropVotingDb, 'upsertAggregateDropRank')
      .mockResolvedValue(undefined);
    jest.spyOn(dropVotingDb, 'getAggregateDropRankVote').mockResolvedValue(123);
    jest
      .spyOn(dropVotingDb, 'snapShotDropsRealVoteInTimeBasedOnRank')
      .mockResolvedValue(undefined);
    jest
      .spyOn(dropVotingDb, 'snapshotDropVotersRealVoteInTimeBasedOnVoterState')
      .mockResolvedValue(undefined);
    jest.spyOn(profileActivityLogsDb, 'insert').mockResolvedValue(undefined);
    jest.spyOn(userNotifier, 'notifyOfDropVote').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips drop vote side effects when revocation leaves the vote unchanged', async () => {
    await revokeTdhBasedDropWavesOverVotes(connection);

    expect(dropVotingDb.upsertState).not.toHaveBeenCalled();
    expect(dropVotingDb.upsertAggregateDropRank).not.toHaveBeenCalled();
    expect(userNotifier.notifyOfDropVote).not.toHaveBeenCalled();
    expect(dropVotingDb.getAggregateDropRankVote).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insert).not.toHaveBeenCalled();
    expect(
      dropVotingDb.snapShotDropsRealVoteInTimeBasedOnRank
    ).not.toHaveBeenCalled();
    expect(
      dropVotingDb.snapshotDropVotersRealVoteInTimeBasedOnVoterState
    ).not.toHaveBeenCalled();
  });
});
