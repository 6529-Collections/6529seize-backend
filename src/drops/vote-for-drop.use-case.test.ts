import { mock } from 'ts-jest-mocker';
import { DropVotingDb } from '@/api-serverless/src/drops/drop-voting.db';
import { UserGroupsService } from '@/api-serverless/src/community-members/user-groups.service';
import { WavesApiDb } from '@/api-serverless/src/waves/waves.api.db';
import { DropType } from '@/entities/IDrop';
import { WaveCreditType, WaveType } from '@/entities/IWave';
import { IdentitiesDb } from '@/identities/identities.db';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { UserNotifier } from '@/notifications/user.notifier';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { RatingsDb } from '@/rates/ratings.db';
import { DropsDb } from './drops.db';
import { VoteForDropUseCase } from './vote-for-drop.use-case';

describe('VoteForDropUseCase', () => {
  let votingDb: DropVotingDb;
  let identitiesDb: IdentitiesDb;
  let wavesDb: WavesApiDb;
  let dropsDb: DropsDb;
  let ratingsDb: RatingsDb;
  let userGroupsService: UserGroupsService;
  let userNotifier: UserNotifier;
  let metricsRecorder: MetricsRecorder;
  let useCase: VoteForDropUseCase;

  const connection = {} as any;
  const wave = {
    id: 'wave-1',
    voting_credit_type: WaveCreditType.TDH,
    voting_credit_category: null,
    voting_credit_creditor: null,
    voting_group_id: null,
    voting_period_start: null,
    voting_period_end: null,
    next_decision_time: null,
    forbid_negative_votes: false,
    visibility_group_id: null,
    type: WaveType.RANK,
    max_winners: null
  } as any;
  const drop = {
    id: 'drop-1',
    wave_id: 'wave-1',
    author_id: 'author-1',
    drop_type: DropType.PARTICIPATORY
  } as any;

  beforeEach(() => {
    votingDb = mock();
    identitiesDb = mock();
    wavesDb = mock();
    dropsDb = mock();
    ratingsDb = mock();
    userGroupsService = mock();
    userNotifier = mock();
    metricsRecorder = mock();

    useCase = new VoteForDropUseCase(
      votingDb,
      identitiesDb,
      wavesDb,
      dropsDb,
      ratingsDb,
      userGroupsService,
      userNotifier,
      metricsRecorder
    );

    jest.spyOn(profileActivityLogsDb, 'insert').mockResolvedValue(undefined);
    (votingDb.lockDropsCurrentRealVote as jest.Mock).mockResolvedValue(
      undefined
    );
    (wavesDb.findById as jest.Mock).mockResolvedValue(wave);
    (wavesDb.countWaveDecisionsByWaveIds as jest.Mock).mockResolvedValue({});
    (dropsDb.findDropById as jest.Mock).mockResolvedValue(drop);
    (
      userGroupsService.getGroupsUserIsEligibleFor as jest.Mock
    ).mockResolvedValue([]);
    (votingDb.getDropVoterStateForDrop as jest.Mock).mockResolvedValue(2);
    (
      votingDb.getVotingCreditLockedInWaveForVoter as jest.Mock
    ).mockResolvedValue(10);
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      tdh: 10,
      xtdh: 0
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns false and skips side effects when the vote is unchanged', async () => {
    const result = await useCase.execute(
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        votes: 2,
        proxy_id: null
      },
      { connection }
    );

    expect(result).toBe(false);
    expect(votingDb.upsertState).not.toHaveBeenCalled();
    expect(votingDb.upsertAggregateDropRank).not.toHaveBeenCalled();
    expect(metricsRecorder.recordVote).not.toHaveBeenCalled();
    expect(metricsRecorder.recordActiveIdentity).not.toHaveBeenCalled();
    expect(
      votingDb.snapShotDropsRealVoteInTimeBasedOnRank
    ).not.toHaveBeenCalled();
    expect(
      votingDb.snapshotDropVotersRealVoteInTimeBasedOnVoterState
    ).not.toHaveBeenCalled();
    expect(votingDb.insertCreditSpending).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insert).not.toHaveBeenCalled();
    expect(userNotifier.notifyOfDropVote).not.toHaveBeenCalled();
  });

  it('does not count wave decisions for waves that cannot be approve-closed', async () => {
    await useCase.execute(
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        votes: 2,
        proxy_id: null
      },
      { connection }
    );

    expect(wavesDb.countWaveDecisionsByWaveIds).not.toHaveBeenCalled();
  });

  it('rejects voting in closed approve waves', async () => {
    (wavesDb.findById as jest.Mock).mockResolvedValue({
      ...wave,
      type: WaveType.APPROVE,
      max_winners: 1
    });
    (wavesDb.countWaveDecisionsByWaveIds as jest.Mock).mockResolvedValue({
      'wave-1': 1
    });

    await expect(
      useCase.execute(
        {
          voter_id: 'voter-1',
          drop_id: 'drop-1',
          wave_id: 'wave-1',
          votes: 3,
          proxy_id: null
        },
        { connection }
      )
    ).rejects.toThrow(`Voting is closed in this wave`);
  });
});
