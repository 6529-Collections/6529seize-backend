import { mock } from 'ts-jest-mocker';
import { DropVotingDb } from '@/api-serverless/src/drops/drop-voting.db';
import { DeployerDropper } from '@/deployer-dropper';
import { DropsDb } from '@/drops/drops.db';
import { WinnerDropVoterVoteEntity } from '@/entities/IWinnerDropVoterVote';
import { Time } from '@/time';
import { wavesApiDb } from '@/api-serverless/src/waves/waves.api.db';
import { WaveDecisionsDb } from '@/waves/wave-decisions.db';
import { WaveDecisionsService } from '@/waves/wave-decisions.service';
import { WaveLeaderboardCalculationService } from '@/waves/wave-leaderboard-calculation.service';
import * as pushNotificationsService from '@/api/push-notifications/push-notifications.service';

describe('WaveDecisionsService', () => {
  let service: WaveDecisionsService;
  let waveDecisionsDb: WaveDecisionsDb;
  let waveLeaderboardCalculationService: WaveLeaderboardCalculationService;
  let dropVotingDb: DropVotingDb;
  let dropsDb: DropsDb;
  let deployerDropper: DeployerDropper;

  beforeEach(() => {
    waveDecisionsDb = mock();
    waveLeaderboardCalculationService = mock();
    dropVotingDb = mock();
    dropsDb = mock();
    deployerDropper = mock();
    jest
      .spyOn(pushNotificationsService, 'sendIdentityPushNotifications')
      .mockResolvedValue(undefined);
    jest.spyOn(wavesApiDb, 'getWavesOutcomes').mockResolvedValue({});
    jest
      .spyOn(wavesApiDb, 'getWavesOutcomesDistributionItems')
      .mockResolvedValue({});
    service = new WaveDecisionsService(
      waveDecisionsDb,
      waveLeaderboardCalculationService,
      dropVotingDb,
      dropsDb,
      deployerDropper
    );
  });

  it('archives current voter states for non-timelocked winner decisions', async () => {
    const winnerVotes: WinnerDropVoterVoteEntity[] = [
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        votes: 7,
        wave_id: 'wave-1'
      },
      {
        voter_id: 'voter-2',
        drop_id: 'drop-1',
        votes: -2,
        wave_id: 'wave-1'
      }
    ];
    (dropVotingDb.getCurrentVoterStatesForDrops as jest.Mock).mockResolvedValue(
      winnerVotes
    );
    (dropVotingDb.insertWinnerDropsVoterVotes as jest.Mock).mockResolvedValue(
      undefined
    );

    await service.transferFinalVotesToArchive(
      {
        dropIds: ['drop-1'],
        decision_time: Time.millis(1_000),
        time_lock_ms: null,
        waveId: 'wave-1'
      },
      {}
    );

    expect(dropVotingDb.getCurrentVoterStatesForDrops).toHaveBeenCalledWith(
      ['drop-1'],
      {}
    );
    expect(
      dropVotingDb.getAllVoteChangeLogsForGivenDropsInTimeframe
    ).not.toHaveBeenCalled();
    expect(dropVotingDb.insertWinnerDropsVoterVotes).toHaveBeenCalledWith(
      winnerVotes,
      {}
    );
  });

  it('reconstructs archived voter states for timelocked winner decisions', async () => {
    (
      dropVotingDb.getAllVoteChangeLogsForGivenDropsInTimeframe as jest.Mock
    ).mockResolvedValue({
      'drop-1': {
        'voter-1': [
          {
            drop_id: 'drop-1',
            voter_id: 'voter-1',
            vote: 5,
            timestamp: 700
          }
        ]
      }
    });
    (
      waveLeaderboardCalculationService.calculateFinalVoteForDrop as jest.Mock
    ).mockReturnValue(5);
    (dropVotingDb.insertWinnerDropsVoterVotes as jest.Mock).mockResolvedValue(
      undefined
    );

    await service.transferFinalVotesToArchive(
      {
        dropIds: ['drop-1'],
        decision_time: Time.millis(1_000),
        time_lock_ms: 500,
        waveId: 'wave-1'
      },
      {}
    );

    expect(dropVotingDb.getCurrentVoterStatesForDrops).not.toHaveBeenCalled();
    expect(
      dropVotingDb.getAllVoteChangeLogsForGivenDropsInTimeframe
    ).toHaveBeenCalledWith(
      {
        timeLockStart: 500,
        dropIds: ['drop-1']
      },
      {}
    );
    const calculateFinalVoteCall = (
      waveLeaderboardCalculationService.calculateFinalVoteForDrop as jest.Mock
    ).mock.calls[0][0];
    expect(calculateFinalVoteCall.voteStates).toEqual([
      {
        drop_id: 'drop-1',
        voter_id: 'voter-1',
        vote: 5,
        timestamp: 700,
        wave_id: 'wave-1'
      }
    ]);
    expect(calculateFinalVoteCall.startTime.toMillis()).toBe(500);
    expect(calculateFinalVoteCall.endTime.toMillis()).toBe(1_000);
    expect(dropVotingDb.insertWinnerDropsVoterVotes).toHaveBeenCalledWith(
      [
        {
          voter_id: 'voter-1',
          drop_id: 'drop-1',
          votes: 5,
          wave_id: 'wave-1'
        }
      ],
      {}
    );
  });

  it('formalizes approve winners oldest-first and respects remaining slots', async () => {
    const latestDecisionTime = Time.currentMillis() + 1_000;
    (waveDecisionsDb.getApproveWinnerCandidates as jest.Mock).mockResolvedValue(
      [
        {
          wave_id: 'wave-1',
          drop_id: 'drop-older',
          created_at: 10,
          vote: 12,
          time_lock_ms: null,
          max_winners: 5,
          decisions_done: 4,
          latest_decision_time: latestDecisionTime
        },
        {
          wave_id: 'wave-1',
          drop_id: 'drop-newer',
          created_at: 20,
          vote: 14,
          time_lock_ms: null,
          max_winners: 5,
          decisions_done: 4,
          latest_decision_time: latestDecisionTime
        }
      ]
    );
    (
      waveDecisionsDb.executeNativeQueriesInTransaction as jest.Mock
    ).mockImplementation(async (fn) => fn({}));
    const formalizeDecision = jest
      .spyOn(service as any, 'formalizeDecision')
      .mockResolvedValue({
        claimBuildDropId: null,
        pendingPushNotificationIds: []
      });

    await (service as any).createApproveDecisions({} as any);

    expect(formalizeDecision).toHaveBeenCalledTimes(1);
    expect(formalizeDecision).toHaveBeenCalledWith(
      {
        decisionTime: latestDecisionTime + 1,
        waveId: 'wave-1',
        outcomes: [],
        time_lock_ms: null,
        winnerDrops: [
          {
            drop_id: 'drop-older',
            vote: 12,
            rank: 1
          }
        ]
      },
      {
        connection: {},
        timer: {}
      }
    );
  });
});
