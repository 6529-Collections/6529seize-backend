import { addRememe, fetchTransactions } from '@/db-api';
import { MEMES_CONTRACT } from '@/constants';
import { ApiTransaction } from '@/api/generated/models/ApiTransaction';
import { redisGet, redisSetJson } from '@/redis';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const redisGetMock = jest.mocked(redisGet);
const redisSetJsonMock = jest.mocked(redisSetJson);

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
    redisSetJsonMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses index-compatible ordering and seeds the API count cache', async () => {
    const transaction = { transaction: '0xtx' } as ApiTransaction;
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('count(1) as count')) {
          return [{ count: 250, latest_block: 123 }];
        }
        if (normalizedSql.startsWith('select transactions.*')) {
          return [transaction];
        }
        throw new Error(`Unexpected SQL: ${normalizedSql}`);
      });

    await expect(
      fetchTransactions(100, 1, undefined, MEMES_CONTRACT, undefined, null)
    ).resolves.toEqual({
      count: 250,
      page: 1,
      next: 'true',
      data: [transaction]
    });

    const executedSql = executeSpy.mock.calls.map(([sql]) => normalizeSql(sql));
    const dataSql = executedSql.find((sql) =>
      sql.startsWith('select transactions.*')
    );
    expect(dataSql).toContain(
      'order by block desc, transaction desc, from_address desc, to_address desc, contract desc, token_id desc'
    );
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('__SEIZE_TRANSACTION_COUNT_'),
      expect.objectContaining({
        version: 1,
        count: 250,
        latestBlock: 123
      }),
      expect.anything()
    );
  });

  it('increments a cached count using only newer matching blocks', async () => {
    const fullyRefreshedAt = Date.now();
    redisGetMock.mockResolvedValue({
      version: 1,
      count: 250,
      latestBlock: 123,
      fullyRefreshedAt
    });
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(
        async (sql: string, params?: Record<string, unknown>) => {
          const normalizedSql = normalizeSql(sql);
          if (normalizedSql.includes('count(1) as count')) {
            expect(normalizedSql).toContain(
              'transactions.block > :countafterblock'
            );
            expect(params).toEqual(
              expect.objectContaining({ countAfterBlock: 123 })
            );
            return [{ count: 4, latest_block: 130 }];
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
      count: 254,
      page: 2,
      next: 'true',
      data: []
    });

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      expect.any(String),
      {
        version: 1,
        count: 254,
        latestBlock: 130,
        fullyRefreshedAt
      },
      expect.anything()
    );
  });

  it('periodically rebases a cached count to include historical backfills', async () => {
    redisGetMock.mockResolvedValue({
      version: 1,
      count: 250,
      latestBlock: 123,
      fullyRefreshedAt: Date.now() - 7 * 60 * 60 * 1000
    });
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql: string) => {
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('count(1) as count')) {
          expect(normalizedSql).not.toContain('block > :countafterblock');
          return [{ count: 275, latest_block: 140 }];
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
      next: 'true',
      data: []
    });

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        version: 1,
        count: 275,
        latestBlock: 140,
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
    expect(redisSetJsonMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
