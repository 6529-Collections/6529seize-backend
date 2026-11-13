import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { CollectedStatsDb } from './api.collected-stats.db';
import { CollectedStatsService } from './api.collected-stats.service';

jest.mock('@/api/identities/identity.fetcher', () => ({ identityFetcher: {} }));
jest.mock('./api.collected-stats.db', () => ({ collectedStatsDb: {} }));

describe('four-wallet collected statistics', () => {
  it('includes wallet D when querying holdings and completing a season set', async () => {
    const wallets = ['a', 'b', 'c', 'd'].map(
      (letter) => `0x${letter.repeat(40)}`
    );
    const key = wallets.join('-');
    const identityFetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn().mockResolvedValue({
        id: 'four-wallet-profile',
        consolidation_key: key,
        // Duplicate primary and mixed-case D must not omit or double-count D.
        primary_wallet: wallets[3],
        wallets: wallets.map((wallet) => ({ wallet: wallet.toUpperCase() }))
      } as ApiIdentity)
    };
    const db = {
      getConsolidatedCollectionSummary: jest.fn().mockResolvedValue(null),
      getWalletCollectionSummary: jest.fn(),
      getSeasonDefinitions: jest
        .fn()
        .mockResolvedValue([
          { season_id: 1, season: 'Season 1', total_cards_in_season: 4 }
        ]),
      getHeldBalancesBySeasonAndToken: jest
        .fn()
        .mockImplementation(async (queriedWallets: string[]) =>
          wallets.flatMap((wallet, index) =>
            queriedWallets.includes(wallet)
              ? [{ season_id: 1, token_id: index + 1, balance: index + 1 }]
              : []
          )
        )
    };
    const service = new CollectedStatsService(
      identityFetcher as unknown as IdentityFetcher,
      db as unknown as CollectedStatsDb
    );
    const ctx = {};

    const result = await service.getStats('four-wallet-collector', ctx);

    expect(db.getHeldBalancesBySeasonAndToken).toHaveBeenCalledWith(
      wallets,
      ctx
    );
    expect(db.getConsolidatedCollectionSummary).toHaveBeenCalledWith(key, ctx);
    expect(db.getWalletCollectionSummary).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      memes_balance: 10,
      unique_memes: 4,
      seasons: [
        {
          season: 'Season 1',
          total_cards_in_season: 4,
          sets_held: 1,
          partial_set_unique_cards_held: 3,
          total_cards_held: 10
        }
      ]
    });
  });
});
