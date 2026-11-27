jest.mock('@/sql-executor', () => ({
  ...jest.requireActual('@/sql-executor'),
  sqlExecutor: { execute: jest.fn() }
}));

import type { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import {
  HELD_FLAG_LOCK_WAIT_SECONDS,
  withDropForgeClaimActions,
  writeDropForgeClaimAction
} from './mint-log-drop-forge';
import { mintLogRecorder } from './mint-log-recorder';

const CONTRACT = '0x0000000000000000000000000000000000000abc';
const SELECT_WAIT = 'SELECT @@SESSION.innodb_lock_wait_timeout AS seconds';
const SET_WAIT = 'SET SESSION innodb_lock_wait_timeout = :seconds';

function held(action: string, failed: jest.Mock) {
  return {
    contract: CONTRACT,
    claim: 1,
    action,
    write: jest.fn().mockResolvedValue(undefined),
    failed
  };
}

describe('held claim actions', () => {
  const ctx = { connection: { connection: {} } } as unknown as RequestContext;
  let statements: string[];

  /** Records each statement; the session's lock wait reads as `wait`. */
  function database(wait: number, failing?: (sql: string) => Error | null) {
    jest
      .mocked(sqlExecutor.execute)
      .mockImplementation(async (sql: string, params?: any) => {
        statements.push(sql === SET_WAIT ? `${sql} ${params.seconds}` : sql);
        const error = failing?.(sql);
        if (error) throw error;
        return sql === SELECT_WAIT ? [{ seconds: wait }] : [];
      });
  }

  beforeEach(() => {
    statements = [];
    jest.mocked(sqlExecutor.execute).mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('undoes a failed write alone and reports it when its savepoint holds', async () => {
    database(50);
    const error = new Error('the entry failed');
    jest
      .spyOn(mintLogRecorder, 'writeWithin')
      .mockRejectedValueOnce(error)
      .mockImplementation(async (_spec, _connection, write) => write());
    const failed = jest.fn().mockResolvedValue(undefined);
    const second = held('SECOND', jest.fn());

    await withDropForgeClaimActions(ctx, async () => {
      await writeDropForgeClaimAction(ctx, held('FIRST', failed));
      await writeDropForgeClaimAction(ctx, second);
    });

    expect(failed).toHaveBeenCalledWith(error);
    expect(second.write).toHaveBeenCalledTimes(1);
    expect(statements).toEqual([
      SELECT_WAIT,
      `${SET_WAIT} ${HELD_FLAG_LOCK_WAIT_SECONDS}`,
      'SAVEPOINT drop_forge_claim_action',
      'ROLLBACK TO SAVEPOINT drop_forge_claim_action',
      'SAVEPOINT drop_forge_claim_action',
      'RELEASE SAVEPOINT drop_forge_claim_action',
      `${SET_WAIT} 50`
    ]);
  });

  it('lets the write error go up when the transaction is gone with its savepoint, and still restores the lock wait', async () => {
    database(50, (sql) =>
      sql.startsWith('ROLLBACK TO SAVEPOINT')
        ? new Error('SAVEPOINT drop_forge_claim_action does not exist')
        : null
    );
    const deadlock = Object.assign(
      new Error('Deadlock found when trying to get lock'),
      { code: 'ER_LOCK_DEADLOCK' }
    );
    jest.spyOn(mintLogRecorder, 'writeWithin').mockRejectedValue(deadlock);
    const failed = jest.fn();
    const second = held('SECOND', jest.fn());

    await expect(
      withDropForgeClaimActions(ctx, async () => {
        await writeDropForgeClaimAction(ctx, held('FIRST', failed));
        await writeDropForgeClaimAction(ctx, second);
      })
    ).rejects.toBe(deadlock);

    // Nothing is reported or written after the transaction is gone: the
    // caller's whole transaction fails, and the launch record with it.
    expect(failed).not.toHaveBeenCalled();
    expect(second.write).not.toHaveBeenCalled();
    expect(statements).toEqual([
      SELECT_WAIT,
      `${SET_WAIT} ${HELD_FLAG_LOCK_WAIT_SECONDS}`,
      'SAVEPOINT drop_forge_claim_action',
      'ROLLBACK TO SAVEPOINT drop_forge_claim_action',
      `${SET_WAIT} 50`
    ]);
  });

  it('never raises a shorter lock wait, and touches none when no flag is held', async () => {
    database(3);
    jest
      .spyOn(mintLogRecorder, 'writeWithin')
      .mockImplementation(async (_spec, _connection, write) => write());

    await withDropForgeClaimActions(ctx, async () => undefined);
    expect(statements).toEqual([]);

    await withDropForgeClaimActions(ctx, async () => {
      await writeDropForgeClaimAction(ctx, held('FIRST', jest.fn()));
    });
    expect(statements).toEqual([
      SELECT_WAIT,
      `${SET_WAIT} 3`,
      'SAVEPOINT drop_forge_claim_action',
      'RELEASE SAVEPOINT drop_forge_claim_action',
      `${SET_WAIT} 3`
    ]);
  });
});
