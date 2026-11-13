import 'reflect-metadata';
import {
  ConnectionWrapper,
  SqlExecutor,
  type SqlExecutionBudget,
  type SqlTransactionOptions
} from '@/sql-executor';
import { performance } from 'node:perf_hooks';
import {
  MarketDepthCursorConflictError,
  MarketDepthDb
} from './market-depth.db';
import { AppendMarketDepthEventsInput } from './market-depth.types';

const input: AppendMarketDepthEventsInput = {
  source: 'opensea_stream',
  contract: '0x1111111111111111111111111111111111111111',
  collection_slug: 'thememes6529',
  expected_cursor: null,
  expected_watermark: null,
  next_cursor: null,
  provider_watermark: null,
  provider_at: null,
  observed_at: new Date('2026-09-10T00:00:00Z'),
  events: []
};

function setup({
  missingSession = false,
  cursorConflict = false,
  restoreError = null
}: {
  missingSession?: boolean;
  cursorConflict?: boolean;
  restoreError?: Error | null;
} = {}) {
  const execute = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT @@SESSION')) {
      return missingSession ? [] : [{ lock_wait_timeout: 50 }];
    }
    if (sql.startsWith('SELECT provider_cursor')) {
      return [
        {
          provider_cursor: cursorConflict ? 'other' : null,
          provider_watermark: null
        }
      ];
    }
    if (sql.includes('=:lockWaitTimeout') && restoreError) throw restoreError;
    return [];
  });
  const transaction = jest.fn(
    async (
      callback: (connection: ConnectionWrapper<unknown>) => Promise<void>,
      _options?: SqlTransactionOptions
    ) => callback({ connection: {} })
  );
  const executor = {
    execute,
    bulkInsert: jest.fn().mockResolvedValue(undefined),
    executeNativeQueriesInTransaction: transaction
  } as unknown as SqlExecutor;
  return { execute, transaction, db: new MarketDepthDb(() => executor) };
}

describe('market-depth event session cleanup', () => {
  it('delegates all session ownership to the supplied SQL execution budget', async () => {
    const { db, execute, transaction } = setup({ missingSession: true });
    const executionBudget: SqlExecutionBudget = {
      deadlineMonotonicMillis: performance.now() + 5000,
      maxStatementMillis: 4000,
      finalizationReserveMillis: 1000,
      lockWaitSeconds: 3
    };
    await db.appendEvents(input, executionBudget);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      executionBudget
    });
    expect(
      execute.mock.calls.some(([sql]) =>
        /^(SELECT @@SESSION|SET SESSION)/.test(sql)
      )
    ).toBe(false);
  });

  it('restores the original timeout after successful writes', async () => {
    const { db, execute } = setup();
    await db.appendEvents(input);
    expect(execute).toHaveBeenLastCalledWith(
      'SET SESSION innodb_lock_wait_timeout=:lockWaitTimeout',
      { lockWaitTimeout: 50 },
      expect.anything()
    );
  });

  it('preserves cursor conflicts when cleanup also fails', async () => {
    const { db } = setup({
      cursorConflict: true,
      restoreError: new Error('connection lost')
    });
    await expect(db.appendEvents(input)).rejects.toBeInstanceOf(
      MarketDepthCursorConflictError
    );
  });

  it('rejects a cleanup failure after otherwise successful writes', async () => {
    const restoreError = new Error('connection lost');
    const { db } = setup({ restoreError });
    await expect(db.appendEvents(input)).rejects.toBe(restoreError);
  });

  it('stops before changing a session whose original timeout is unavailable', async () => {
    const { db, execute } = setup({ missingSession: true });
    await expect(db.appendEvents(input)).rejects.toThrow(
      'Could not read market-depth session lock timeout'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
