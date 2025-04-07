import { mock } from 'ts-jest-mocker';
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
});
