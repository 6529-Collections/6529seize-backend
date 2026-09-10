const mockGetLatestCompletedSnapshot = jest.fn();
const mockGetSeasonDefinitions = jest.fn();

jest.mock('@/api/tdh/api.tdh-rules.db', () => ({
  tdhRulesDb: {
    getLatestCompletedSnapshot: mockGetLatestCompletedSnapshot,
    getSeasonDefinitions: mockGetSeasonDefinitions
  }
}));

import { GetTdhRulesRequest } from '@/api/generated/routes/operations';
import { NotFoundException } from '@/exceptions';
import { Timer } from '@/time';
import { handleGetTdhRules } from './get-tdh-rules.handler';

function request(): GetTdhRulesRequest {
  return {
    timer: new Timer('get-tdh-rules-test')
  } as unknown as GetTdhRulesRequest;
}

describe('handleGetTdhRules', () => {
  beforeEach(() => {
    mockGetLatestCompletedSnapshot.mockReset();
    mockGetSeasonDefinitions.mockReset();
    mockGetLatestCompletedSnapshot.mockResolvedValue({
      block_number: 123,
      block_timestamp: new Date('2026-09-08T23:59:59.000Z'),
      eligible_memes_count: '3'
    });
    mockGetSeasonDefinitions.mockResolvedValue([
      {
        id: 1,
        start_index: 1,
        end_index: 2,
        count: 2,
        name: 'Season 1',
        display: 'SZN1',
        boost: 0.05
      },
      {
        id: 2,
        start_index: 3,
        end_index: 4,
        count: 2,
        name: 'Season 2',
        display: 'SZN2',
        boost: 0.05
      },
      {
        id: 3,
        start_index: 5,
        end_index: 6,
        count: 2,
        name: 'Season 3',
        display: 'SZN3',
        boost: 0.05
      }
    ]);
  });

  it('returns rules tied to the latest completed snapshot', async () => {
    await expect(handleGetTdhRules(request())).resolves.toMatchObject({
      snapshot: {
        block_number: 123,
        block_timestamp: new Date('2026-09-08T23:59:59.000Z'),
        eligible_memes_count: 3
      },
      boost: {
        base_multiplier: 1,
        final_rounding_decimals: 2,
        season_schedule: {
          bonus_per_season: 0.05,
          last_boosted_season: 20,
          max_bonus: 1
        },
        season_sets: [
          {
            season: 1,
            start_index: 1,
            end_index: 2,
            count: 2,
            bonus: 0.05
          }
        ],
        full_collection: {
          first_set_bonus: 0.05,
          additional_set_initial_bonus: 0.05,
          additional_set_decay_ratio: 0.6529,
          additional_sets_limit_bonus: 0.144051
        },
        gradients: {
          bonus_per_token: 0.02,
          max_count: 5,
          max_bonus: 0.1
        }
      }
    });
  });

  it('fails closed when no completed snapshot exists', async () => {
    mockGetLatestCompletedSnapshot.mockResolvedValueOnce(null);

    await expect(handleGetTdhRules(request())).rejects.toThrow(
      NotFoundException
    );
  });
});
