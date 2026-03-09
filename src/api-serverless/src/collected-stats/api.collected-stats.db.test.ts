import {
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  OWNERS_BALANCES_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import { CollectedStatsDb } from '@/api/collected-stats/api.collected-stats.db';
import { SqlExecutor } from '@/sql-executor';

class TestSqlExecutor extends SqlExecutor {
  execute = jest.fn();

  executeNativeQueriesInTransaction = jest.fn();
}

describe('CollectedStatsDb', () => {
  let sqlExecutor: TestSqlExecutor;
  let db: CollectedStatsDb;

  beforeEach(() => {
    sqlExecutor = new TestSqlExecutor();
    db = new CollectedStatsDb(() => sqlExecutor);
  });

  it('pins consolidated summary boost to the latest TDH block', async () => {
    sqlExecutor.execute.mockResolvedValue([]);

    await db.getConsolidatedCollectionSummary('0xabc-0xdef', {});

    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        `FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE} o`
      ),
      { consolidationKey: '0xabc-0xdef' },
      { wrappedConnection: undefined }
    );
    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        `LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} t`
      ),
      { consolidationKey: '0xabc-0xdef' },
      { wrappedConnection: undefined }
    );
    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        `AND t.block = (SELECT MAX(block_number) FROM ${TDH_BLOCKS_TABLE})`
      ),
      { consolidationKey: '0xabc-0xdef' },
      { wrappedConnection: undefined }
    );
  });

  it('pins wallet summary boost to the latest TDH block', async () => {
    sqlExecutor.execute.mockResolvedValue([]);

    await db.getWalletCollectionSummary('0xabc', {});

    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(`FROM ${OWNERS_BALANCES_TABLE} o`),
      { wallet: '0xabc' },
      { wrappedConnection: undefined }
    );
    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(`LEFT JOIN ${WALLETS_TDH_TABLE} t`),
      { wallet: '0xabc' },
      { wrappedConnection: undefined }
    );
    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        `AND t.block = (SELECT MAX(block_number) FROM ${TDH_BLOCKS_TABLE})`
      ),
      { wallet: '0xabc' },
      { wrappedConnection: undefined }
    );
  });
});
