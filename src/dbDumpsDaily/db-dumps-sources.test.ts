import { sqlExecutor } from '@/sql-executor';
import { readChainTables, readTransactions } from './db-dumps-sources';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn()
  }
}));

const NOW = Date.UTC(2026, 10, 25, 3, 0, 0);
const CONNECTION = { connection: { id: 'snapshot' } };
const execute = jest.mocked(sqlExecutor.execute);
const inTransaction = jest.mocked(
  sqlExecutor.executeNativeQueriesInTransaction
);

/** Answers the reads; `mirror` undefined means the mirror's table is missing. */
function answer(mirror?: Record<string, unknown> | null) {
  execute.mockImplementation(async (sql: string) => {
    if (sql.includes('identity_chain_mirror_state')) {
      if (mirror === undefined) {
        throw Object.assign(new Error('no table'), {
          code: 'ER_NO_SUCH_TABLE'
        });
      }
      return mirror ? [mirror] : [];
    }
    if (sql.includes('MAX(block) AS block FROM transactions'))
      return [{ block: '23800000' }];
    if (sql.includes('MAX(block) AS block FROM nftdelegation_blocks'))
      return [{ block: 23700000 }];
    if (sql === 'SELECT * FROM delegations') return [{ id: 'd' }];
    if (sql === 'SELECT * FROM consolidations') return [{ id: 'c' }];
    if (sql === 'SELECT * FROM transactions') return [{ id: 't' }];
    throw new Error(`unexpected ${sql}`);
  });
}

describe('dump reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    inTransaction.mockImplementation(async (work: any) => work(CONNECTION));
    answer(null);
  });

  afterEach(() => {
    // Every read went through the one snapshot transaction.
    for (const [, , options] of execute.mock.calls) {
      expect(options).toEqual({ wrappedConnection: CONNECTION });
    }
    for (const [, options] of inTransaction.mock.calls) {
      expect(options).toEqual({ isolationLevel: 'REPEATABLE READ' });
    }
  });

  it('reads delegations and consolidations from NFTDelegation before the mirror exists', async () => {
    for (const mirror of [undefined, null]) {
      answer(mirror);
      expect(await readChainTables(NOW)).toEqual([
        {
          table: 'delegations',
          rows: [{ id: 'd' }],
          source: { kind: 'nftdelegation', last_block: 23700000 }
        },
        {
          table: 'consolidations',
          rows: [{ id: 'c' }],
          source: { kind: 'nftdelegation', last_block: 23700000 }
        }
      ]);
    }
  });

  it('reads them with the mirror state of the same snapshot once it has passed and keeps moving', async () => {
    answer({ next_height: '4521', sync_phase: null, updated_at: NOW - 60_000 });
    const source = {
      kind: 'identity_chain_mirror',
      next_height: 4521,
      updated_at: NOW - 60_000
    };
    expect(await readChainTables(NOW)).toEqual([
      { table: 'delegations', rows: [{ id: 'd' }], source },
      { table: 'consolidations', rows: [{ id: 'c' }], source }
    ]);
    expect(inTransaction).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('identity_chain_mirror_state');
  });

  it.each([
    [
      'before its first pass',
      { next_height: null, sync_phase: null, updated_at: NOW },
      'has not finished a full pass'
    ],
    [
      'part way through a full pass',
      { next_height: 4521, sync_phase: 'IDENTITIES', updated_at: NOW },
      'has not finished a full pass'
    ],
    [
      'after it stopped moving',
      { next_height: 4521, sync_phase: null, updated_at: NOW - 31 * 60_000 },
      'has not moved for 30 minutes'
    ]
  ])(
    'skips both, reading neither, while the mirror is %s',
    async (_, mirror, reason) => {
      answer(mirror);
      expect(await readChainTables(NOW)).toEqual([
        { table: 'delegations', skip: expect.stringContaining(reason) },
        { table: 'consolidations', skip: expect.stringContaining(reason) }
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  );

  it('reads the transactions with their highest block in one snapshot', async () => {
    answer(null);
    expect(await readTransactions()).toEqual({
      table: 'transactions',
      rows: [{ id: 't' }],
      source: { kind: 'ethereum', max_block: 23800000 }
    });
  });
});
