import { mock } from '@/tests/mock';
import { DropVotingDb } from '@/api-serverless/src/drops/drop-voting.db';
import { DeployerDropper } from '@/deployer-dropper';
import { DropsDb } from '@/drops/drops.db';
import { WinnerDropVoterVoteEntity } from '@/entities/IWinnerDropVoterVote';
import { Time } from '@/time';
import { WaveDecisionsDb } from '@/waves/wave-decisions.db';
import { WaveDecisionsService } from '@/waves/wave-decisions.service';
import { WaveLeaderboardCalculationService } from '@/waves/wave-leaderboard-calculation.service';

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
});
