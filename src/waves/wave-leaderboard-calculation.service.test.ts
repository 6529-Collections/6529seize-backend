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
