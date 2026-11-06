import { fetchWalletTdhData } from './api.distributions.db';
import { CONSOLIDATED_WALLETS_TDH_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { aTdhConsolidation } from '@/tests/fixtures/tdh_consolidation.fixture';

describe('wallet TDH consolidation overlap', () => {
  beforeEach(async () => {
    await sqlExecutor.execute(`DELETE FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}`);
  });
  it('matches an individual member of a multi-wallet JSON consolidation', async () => {
    const consolidations = [
      aTdhConsolidation(['0xaaa', '0xbbb'], {
        boosted_tdh: 100,
        memes_balance: 4,
        gradients_balance: 1,
        unique_memes: 3
      }),
      aTdhConsolidation(['0xccc'], { boosted_tdh: 200 })
    ];
    const rows = consolidations.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          Array.isArray(value) ? JSON.stringify(value) : value
        ])
      )
    );
    await sqlExecutor.bulkInsert(
      CONSOLIDATED_WALLETS_TDH_TABLE,
      rows,
      Object.keys(rows[0])
    );
    const values = await fetchWalletTdhData(['0xBBB']);
    expect(values.get('0xbbb')).toEqual({
      wallet_tdh: 100,
      wallet_balance: 5,
      wallet_unique_balance: 4
    });
    expect(values.has('0xccc')).toBe(false);
  });
});
