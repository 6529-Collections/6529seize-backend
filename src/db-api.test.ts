import { addRememe, fetchTransactions } from '@/db-api';
import { MEMES_CONTRACT } from '@/constants';
import { ApiTransaction } from '@/api/generated/models/ApiTransaction';
import { redisCompareAndSetJson, redisGet } from '@/redis';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/redis', () => ({
  redisCompareAndSetJson: jest.fn(),
  redisGet: jest.fn()
}));

const redisGetMock = jest.mocked(redisGet);
const redisCompareAndSetJsonMock = jest.mocked(redisCompareAndSetJson);

describe('addRememe', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists rememes when optional Alchemy metadata is missing', async () => {
    const executeSpy = jest.spyOn(sqlExecutor, 'execute').mockResolvedValue([]);

    await addRememe('0xsubmitter', {
      contract: {
        address: '0xcontract'
      },
      references: [1],
      nfts: [
        {
          tokenId: '1'
        }
      ]
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        contract: '0xcontract',
        token_id: '1',
        deployer: '',
        tokenUri: '',
        tokenType: '',
        image: '',
        animation: '',
        meme_references: '[1]',
        metadata: '{}',
        contract_opensea_data: '{}',
        media: '{}',
        added_by: '0xsubmitter'
      })
    );
  });
});

describe('fetchTransactions', () => {
  beforeEach(() => {
    redisGetMock.mockReset().mockResolvedValue(null);
    redisCompareAndSetJsonMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses index-compatible ordering and seeds the API count cache', async () => {
    const firstTransaction = { transaction: '0xtx1' } as ApiTransaction;
    const secondTransaction = { transaction: '0xtx2' } as ApiTransaction;
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(
        async (sql: string, params?: Record<string, unknown>) => {
          const normalizedSql = normalizeSql(sql);
          if (normalizedSql.includes('sum(count(1)) over () as count')) {
            return [{ count: 250, latest_block: 123, latest_block_count: 3 }];
          }
          if (normalizedSql.startsWith('select transactions.*')) {
            expect(params).toEqual(
              expect.objectContaining({
                transactionLimit: 2,
                transactionOffset: 0
              })
            );
            return [firstTransaction, secondTransaction];
          }
          throw new Error(`Unexpected SQL: ${normalizedSql}`);
        }
      );

    await expect(
      fetchTransactions(1, 1, undefined, MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({
      count: 250,
      page: 1,
      next: 'true',
      data: [firstTransaction]
    });

    const executedSql = executeSpy.mock.calls.map(([sql]) => normalizeSql(sql));
    const dataSql = executedSql.find((sql) =>
      sql.startsWith('select transactions.*')
    );
    expect(dataSql).toContain(
      'order by block desc, transaction desc, from_address desc, to_address desc, contract desc, token_id desc'
    );
    expect(dataSql).toContain(
      'limit :transactionlimit offset :transactionoffset'
    );
    expect(redisCompareAndSetJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('__SEIZE_TRANSACTION_COUNT_'),
      null,
      expect.objectContaining({
        version: 2,
        count: 250,
        latestBlock: 123,
        latestBlockCount: 3
      }),
      expect.anything()
    );
  });

  it('recounts the boundary block and uses compare-and-set for increments', async () => {
    const fullyRefreshedAt = Date.now();
    const cached = {
      version: 2,
      count: 250,
      latestBlock: 123,
      latestBlockCount: 3,
      fullyRefreshedAt
    };
    redisGetMock.mockResolvedValue(cached);
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(
        async (sql: string, params?: Record<string, unknown>) => {
          const normalizedSql = normalizeSql(sql);
          if (normalizedSql.includes('count(1) as block_count')) {
            expect(normalizedSql).toContain(
              'transactions.block >= :countfromblock'
            );
            expect(params).toEqual(
              expect.objectContaining({ countFromBlock: 123 })
            );
            return [
              { block: 123, block_count: 4 },
              { block: 130, block_count: 2 }
            ];
          }
          if (normalizedSql.startsWith('select transactions.*')) {
            return [];
          }
          throw new Error(`Unexpected SQL: ${normalizedSql}`);
        }
      );

    await expect(
      fetchTransactions(100, 2, undefined, MEMES_CONTRACT, undefined, 'sales')
    ).resolves.toEqual({
      count: 253,
      page: 2,
      next: null,
      data: []
    });

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(redisCompareAndSetJsonMock).toHaveBeenCalledWith(
      expect.any(String),
      cached,
      {
        version: 2,
        count: 253,
        latestBlock: 130,
        latestBlockCount: 2,
        fullyRefreshedAt
      },
      expect.anything()
    );
  });

  it('periodically rebases a cached count to include historical backfills', async () => {
    const cached = {
      version: 2,
      count: 250,
      latestBlock: 123,
      latestBlockCount: 3,
      fullyRefreshedAt: Date.now() - 7 * 60 * 60 * 1000
    };
    redisGetMock.mockResolvedValue(cached);
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('sum(count(1)) over () as count')) {
          expect(normalizedSql).not.toContain('block >= :countfromblock');
          return [{ count: 275, latest_block: 140, latest_block_count: 2 }];
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await expect(
      fetchTransactions(100, 1, undefined, MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({
      count: 275,
      page: 1,
      next: null,
      data: []
    });

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(redisCompareAndSetJsonMock).toHaveBeenCalledWith(
      expect.any(String),
      cached,
      expect.objectContaining({
        version: 2,
        count: 275,
        latestBlock: 140,
        latestBlockCount: 2,
        fullyRefreshedAt: expect.any(Number)
      }),
      expect.anything()
    );
  });

  it('falls back to an uncached exact count for wallet-specific requests', async () => {
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.startsWith('select wallet,display from ens')) {
          return [];
        }
        if (normalizedSql.includes('count(1) as count')) {
          return [{ count: 2, latest_block: 50 }];
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await expect(
      fetchTransactions(50, 1, '0xwallet', MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({
      count: 2,
      page: 1,
      next: null,
      data: []
    });

    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisCompareAndSetJsonMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });

  it('normalizes mixed-case filters before SQL and cache identity generation', async () => {
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('sum(count(1)) over () as count')) {
          expect(normalizedSql).toContain('where value > 0');
          return [{ count: 1, latest_block: 123, latest_block_count: 1 }];
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await fetchTransactions(
      100,
      1,
      undefined,
      MEMES_CONTRACT,
      undefined,
      'Sales'
    );

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(redisGetMock).toHaveBeenCalledWith(
      expect.stringContaining('__SEIZE_TRANSACTION_COUNT_')
    );
  });

  it('caps oversized pagination before binding limit and offset', async () => {
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(
        async (sql: string, params?: Record<string, unknown>) => {
          const normalizedSql = normalizeSql(sql);
          if (normalizedSql.includes('sum(count(1)) over () as count')) {
            return [];
          }
          if (normalizedSql.startsWith('select transactions.*')) {
            expect(params).toEqual(
              expect.objectContaining({
                transactionLimit: 101,
                transactionOffset: 999_900
              })
            );
            return [];
          }
          throw new Error(`Unexpected SQL: ${normalizedSql}`);
        }
      );

    await expect(
      fetchTransactions(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        undefined,
        MEMES_CONTRACT,
        undefined,
        null
      )
    ).resolves.toEqual({ count: 0, page: 10_000, next: null, data: [] });

    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps serving live rows when Redis read and write operations fail', async () => {
    redisGetMock.mockRejectedValue(new Error('Redis read failed'));
    redisCompareAndSetJsonMock.mockRejectedValue(
      new Error('Redis write failed')
    );
    jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('sum(count(1)) over () as count')) {
          return [{ count: 1, latest_block: 123, latest_block_count: 1 }];
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await expect(
      fetchTransactions(100, 1, undefined, MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({ count: 1, page: 1, next: null, data: [] });
  });

  it('uses a stale cached count if incremental reconciliation fails', async () => {
    redisGetMock.mockResolvedValue({
      version: 2,
      count: 250,
      latestBlock: 123,
      latestBlockCount: 3,
      fullyRefreshedAt: Date.now()
    });
    jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('count(1) as block_count')) {
          throw new Error('Database count failed');
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await expect(
      fetchTransactions(100, 1, undefined, MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({ count: 250, page: 1, next: null, data: [] });
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
