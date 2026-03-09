import { NotFoundException } from '@/exceptions';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { CollectedStatsDb } from '@/api/collected-stats/api.collected-stats.db';
import { CollectedStatsService } from '@/api/collected-stats/api.collected-stats.service';

describe('CollectedStatsService', () => {
  let identityFetcher: jest.Mocked<
    Pick<IdentityFetcher, 'getIdentityAndConsolidationsByIdentityKey'>
  >;
  let collectedStatsDb: jest.Mocked<
    Pick<
      CollectedStatsDb,
      | 'getSeasonDefinitions'
      | 'getHeldBalancesBySeasonAndToken'
      | 'getConsolidatedCollectionSummary'
      | 'getWalletCollectionSummary'
    >
  >;
  let service: CollectedStatsService;

  beforeEach(() => {
    identityFetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn()
    };
    collectedStatsDb = {
      getSeasonDefinitions: jest.fn(),
      getHeldBalancesBySeasonAndToken: jest.fn(),
      getConsolidatedCollectionSummary: jest.fn(),
      getWalletCollectionSummary: jest.fn()
    };
    service = new CollectedStatsService(
      identityFetcher as unknown as IdentityFetcher,
      collectedStatsDb as unknown as CollectedStatsDb
    );
  });

  it('aggregates total, full set, partial set, and empty season stats', async () => {
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue({
      wallets: [{ wallet: '0xABC' }, { wallet: '0xdef' }, { wallet: '0xabc' }],
      primary_wallet: '0xABC',
      consolidation_key: '0xabc-0xdef',
      id: 'profile-1'
    } as any);
    collectedStatsDb.getSeasonDefinitions.mockResolvedValue([
      {
        season_id: 1,
        season: 'SZN1',
        total_cards_in_season: 3
      },
      {
        season_id: 2,
        season: 'SZN2',
        total_cards_in_season: 2
      },
      {
        season_id: 3,
        season: 'SZN3',
        total_cards_in_season: 1
      }
    ]);
    collectedStatsDb.getHeldBalancesBySeasonAndToken.mockResolvedValue([
      { season_id: 1, token_id: 1, balance: 2 },
      { season_id: 1, token_id: 2, balance: 3 },
      { season_id: 1, token_id: 3, balance: 4 },
      { season_id: 2, token_id: 4, balance: 5 }
    ]);
    collectedStatsDb.getConsolidatedCollectionSummary.mockResolvedValue({
      boost: 1.76,
      nextgens_held: 62,
      gradients_held: 3
    });

    await expect(service.getStats('punk6529', {})).resolves.toEqual({
      boost: 1.76,
      nextgens_held: 62,
      gradients_held: 3,
      total_cards_held: 14,
      unique_cards_held: 4,
      seasons: [
        {
          season: 'SZN1',
          total_cards_in_season: 3,
          sets_held: 2,
          partial_set_unique_cards_held: 2,
          total_cards_held: 9
        },
        {
          season: 'SZN2',
          total_cards_in_season: 2,
          sets_held: 0,
          partial_set_unique_cards_held: 1,
          total_cards_held: 5
        },
        {
          season: 'SZN3',
          total_cards_in_season: 1,
          sets_held: 0,
          partial_set_unique_cards_held: 0,
          total_cards_held: 0
        }
      ]
    });

    expect(
      collectedStatsDb.getHeldBalancesBySeasonAndToken
    ).toHaveBeenCalledWith(
      ['0xabc', '0xdef'],
      {}
    );
    expect(
      collectedStatsDb.getConsolidatedCollectionSummary
    ).toHaveBeenCalledWith('0xabc-0xdef', {});
  });

  it('throws when the identity cannot be resolved', async () => {
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      null
    );

    await expect(service.getStats('unknown-user', {})).rejects.toThrow(
      new NotFoundException('Identity unknown-user not found')
    );
  });
});
