import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { WaveLeaderboardCalculationService } from './wave-leaderboard-calculation.service';
import { DropVotingDb } from '../api-serverless/src/drops/drop-voting.db';
import { Time } from '../time';

describe('WaveLeaderboardCalculationService', () => {
  let service: WaveLeaderboardCalculationService;
  let dropVotingDb: DropVotingDb;

  beforeEach(() => {
    dropVotingDb = mock();
    service = new WaveLeaderboardCalculationService(dropVotingDb);
  });
  describe('calculateFinalVoteForDrop', () => {
    it('no vote states results to 0', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(0);
    });

    it('all votes in the future results to 0', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(200).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(0);
    });

    it('votes in the past have full weight', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(-200).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(100);
    });

    it('votes exactly at the start time have full weight', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(100);
    });

    it('multiple equal votes exactly at the same do not mess eachother up', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          },
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(100);
    });

    it('multiple equal subsequent votes do not mess eachother up', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          },
          {
            timestamp: Time.millis(50).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(100);
    });

    it('votes are actually weighted by the time they were active', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          },
          {
            timestamp: Time.millis(50).toMillis(),
            vote: 50,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(75);
    });

    it('final vote is rounded down', () => {
      const actual = service.calculateFinalVoteForDrop({
        voteStates: [
          {
            timestamp: Time.millis(0).toMillis(),
            vote: 100,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          },
          {
            timestamp: Time.millis(50).toMillis(),
            vote: 25,
            drop_id: 'a-drop-id',
            wave_id: 'a-wave-id'
          }
        ],
        startTime: Time.millis(0),
        endTime: Time.millis(100)
      });
      expect(actual).toEqual(62);
    });
  });

  describe('calculateLeaderboardEntryForDrop', () => {
    beforeEach(() => {
      (
        dropVotingDb.executeNativeQueriesInTransaction as jest.Mock
      ).mockImplementation(async (callback) => callback({}));
      (dropVotingDb.upsertWaveLeaderboardEntry as jest.Mock).mockResolvedValue(
        undefined
      );
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue(null);
    });

    it('starts weighted over-threshold time when weighted vote reaches threshold', async () => {
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 0,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(0),
          endTime: Time.millis(1_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.getDropVoteStatesInTimespan).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          fromTime: -1_000,
          toTime: 1_000
        },
        expect.anything()
      );
      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: 500
        }),
        expect.anything()
      );
    });

    it('does not track over-threshold time when threshold duration is disabled', async () => {
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 0,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 0,
          startTime: Time.millis(0),
          endTime: Time.millis(1_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.getDropVoteStatesInTimespan).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          fromTime: 0,
          toTime: 1_000
        },
        expect.anything()
      );
      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: null
        }),
        expect.anything()
      );
    });

    it('finds crossing between previous snapshot and current time-lock window', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 1_000,
        over_threshold_since_ms: null
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 1_000,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(2_000),
          endTime: Time.millis(3_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.getDropVoteStatesInTimespan).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          fromTime: 0,
          toTime: 3_000
        },
        expect.anything()
      );
      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: 1_500
        }),
        expect.anything()
      );
    });

    it('uses the locked cleared threshold state when recalculating', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 0,
        over_threshold_since_ms: null
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: -1_000,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(2_000),
          endTime: Time.millis(3_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate
      ).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          waveId: 'wave-id'
        },
        expect.anything()
      );
      expect(dropVotingDb.getDropVoteStatesInTimespan).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          fromTime: -1_000,
          toTime: 3_000
        },
        expect.anything()
      );
      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: 0
        }),
        expect.anything()
      );
    });

    it('preserves weighted over-threshold time while weighted vote stays over threshold', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 500,
        over_threshold_since_ms: 500
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 0,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(0),
          endTime: Time.millis(1_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: 500
        }),
        expect.anything()
      );
    });

    it('clears weighted over-threshold time when weighted vote falls below threshold', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 500,
        over_threshold_since_ms: 500
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 0,
            vote: 40,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(0),
          endTime: Time.millis(1_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 40,
          over_threshold_since_ms: null
        }),
        expect.anything()
      );
    });

    it('resets weighted over-threshold time when weighted vote dips between snapshots', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 1_000,
        over_threshold_since_ms: 500
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 0,
            vote: 100,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          },
          {
            timestamp: 1_000,
            vote: 0,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          },
          {
            timestamp: 1_500,
            vote: 200,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 60,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(1_000),
          endTime: Time.millis(2_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.getDropVoteStatesInTimespan).toHaveBeenCalledWith(
        {
          dropId: 'drop-id',
          fromTime: 0,
          toTime: 2_000
        },
        expect.anything()
      );
      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 100,
          over_threshold_since_ms: 1_600
        }),
        expect.anything()
      );
    });

    it('uses the crossing after the last below-threshold segment', async () => {
      (
        dropVotingDb.getWaveLeaderboardEntryThresholdStateForUpdate as jest.Mock
      ).mockResolvedValue({
        leaderboard_timestamp: 1_000,
        over_threshold_since_ms: 500
      });
      (dropVotingDb.getDropVoteStatesInTimespan as jest.Mock).mockResolvedValue(
        [
          {
            timestamp: 1_000,
            vote: 200,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          },
          {
            timestamp: 1_500,
            vote: -200,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          },
          {
            timestamp: 2_000,
            vote: 200,
            drop_id: 'drop-id',
            wave_id: 'wave-id'
          }
        ]
      );

      await service.calculateLeaderboardEntryForDrop(
        {
          dropId: 'drop-id',
          waveId: 'wave-id',
          winningMinThreshold: 50,
          winningThresholdMinDurationMs: 1,
          startTime: Time.millis(2_000),
          endTime: Time.millis(3_000),
          nextDecisionTime: null
        },
        {}
      );

      expect(dropVotingDb.upsertWaveLeaderboardEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          vote: 200,
          over_threshold_since_ms: 2_625
        }),
        expect.anything()
      );
    });
  });

  describe('calculateWaveLeaderBoardInTimeAndGetTopNDropsWithVotes', () => {
    it('orders drops with equal final votes by most recent vote increase', async () => {
      when(dropVotingDb.getWavesParticipatoryDropsVoteStatesInTimespan)
        .calledWith(
          {
            fromTime: 0,
            toTime: 1000,
            waveId: 'wave-id'
          },
          expect.anything()
        )
        .mockResolvedValue([
          { drop_id: 'A', wave_id: 'wave-id', vote: 100, timestamp: 0 },
          { drop_id: 'B', wave_id: 'wave-id', vote: 100, timestamp: 0 },
          { drop_id: 'C', wave_id: 'wave-id', vote: 50, timestamp: 0 }
        ]);

      when(dropVotingDb.getLastVoteIncreaseTimesForEachDrop)
        .calledWith(['B', 'A'], expect.anything())
        .mockResolvedValue({ A: 1000, B: 2000 });

      const result =
        await service.calculateWaveLeaderBoardInTimeAndGetTopNDropsWithVotes(
          {
            waveId: 'wave-id',
            startTime: Time.millis(0),
            endTime: Time.millis(1000),
            n: 2
          },
          {}
        );

      expect(result).toEqual([
        { drop_id: 'B', vote: 100, rank: 1 },
        { drop_id: 'A', vote: 100, rank: 2 }
      ]);
    });
  });
});
