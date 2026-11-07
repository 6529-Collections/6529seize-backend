import type { PoolConnection } from 'mysql';
import { SqlTransactionOptions } from '@/sql-executor';
import { afterCommit } from './after-commit';
import { CustomTypeCaster, execNativeTransactionally } from './my-sql.helpers';

const castTinyInt = CustomTypeCaster as (
  field: {
    type: string;
    string: () => string | null;
    buffer?: () => Buffer | null;
  },
  next: () => unknown
) => unknown;

describe('CustomTypeCaster', () => {
  it('casts nullable tinyint values without reading the field twice', () => {
    const field = {
      type: 'TINY',
      string: jest.fn(() => null),
      buffer: jest.fn()
    };

    const result = castTinyInt(field, jest.fn());

    expect(result).toBeNull();
    expect(field.string).toHaveBeenCalledTimes(1);
    expect(field.buffer).not.toHaveBeenCalled();
  });

  it.each([
    ['0', false],
    ['1', true]
  ])('casts tinyint %s to %s', (value, expected) => {
    const field = {
      type: 'TINY',
      string: jest.fn(() => value)
    };

    expect(castTinyInt(field, jest.fn())).toBe(expected);
    expect(field.string).toHaveBeenCalledTimes(1);
  });
});

describe('explicit transaction isolation', () => {
  function connectionFixture(beginError?: Error) {
    const statements: string[] = [];
    const release = jest.fn();
    const connection = {
      query(sql: string, callback: (error: Error | null) => void) {
        statements.push(sql);
        callback(null);
      },
      beginTransaction(callback: (error?: Error) => void) {
        statements.push('BEGIN');
        setImmediate(() => callback(beginError));
      },
      commit(callback: (error?: Error) => void) {
        statements.push('COMMIT');
        callback();
      },
      rollback(callback: () => void) {
        statements.push('ROLLBACK');
        callback();
      },
      release
    } as unknown as PoolConnection;
    return { connection, statements, release };
  }

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)(
    'applies %s to the next transaction and awaits BEGIN before work',
    async (isolationLevel) => {
      const { connection, statements, release } = connectionFixture();
      const result = await execNativeTransactionally(
        async (bound) => {
          expect(bound.connection).toBe(connection);
          statements.push('WORK');
          return 'committed';
        },
        connection,
        { isolationLevel }
      );
      expect(result).toBe('committed');
      expect(statements).toEqual([
        `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`,
        'BEGIN',
        'WORK',
        'COMMIT'
      ]);
      expect(release).toHaveBeenCalledTimes(1);
    }
  );

  it('does not run READ COMMITTED work when BEGIN fails', async () => {
    const failure = new Error('begin failed');
    const { connection, statements, release } = connectionFixture(failure);
    const work = jest.fn();
    await expect(
      execNativeTransactionally(work, connection, {
        isolationLevel: 'READ COMMITTED'
      })
    ).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
    expect(statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'BEGIN',
      'ROLLBACK'
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported isolation before sending SQL or running work', async () => {
    const { connection, statements } = connectionFixture();
    const work = jest.fn();
    await expect(
      execNativeTransactionally(work, connection, {
        isolationLevel:
          'SERIALIZABLE' as SqlTransactionOptions['isolationLevel']
      })
    ).rejects.toThrow('Unsupported explicit transaction isolation');
    expect(work).not.toHaveBeenCalled();
    expect(statements).toEqual(['ROLLBACK']);
  });
});

describe('after-commit callbacks', () => {
  function legacyConnectionFixture(commitError?: Error) {
    const statements: string[] = [];
    const connection = {
      query(_sql: string, callback: (error: Error | null) => void) {
        statements.push('SET');
        callback(null);
      },
      beginTransaction(callback?: (error?: Error) => void) {
        statements.push('BEGIN');
        callback?.();
      },
      commit(callback: (error?: Error) => void) {
        statements.push('COMMIT');
        callback(commitError);
      },
      rollback(callback?: () => void) {
        statements.push('ROLLBACK');
        callback?.();
      },
      release: jest.fn(() => statements.push('RELEASE'))
    } as unknown as PoolConnection;
    return { connection, statements };
  }

  it.each([undefined, { isolationLevel: 'READ COMMITTED' as const }])(
    'runs callbacks registered in the transaction after COMMIT (options %p)',
    async (options) => {
      const { connection, statements } = legacyConnectionFixture();
      const result = await execNativeTransactionally(
        async (bound) => {
          await afterCommit(bound, () => statements.push('EFFECT'), 'k');
          await afterCommit(bound, () => statements.push('DUPLICATE'), 'k');
          statements.push('WORK');
          return 'done';
        },
        connection,
        options
      );
      expect(result).toBe('done');
      expect(statements.filter((s) => s !== 'SET')).toEqual(
        expect.arrayContaining(['BEGIN', 'WORK', 'COMMIT', 'RELEASE', 'EFFECT'])
      );
      expect(statements.indexOf('EFFECT')).toBeGreaterThan(
        statements.indexOf('COMMIT')
      );
      expect(statements).not.toContain('DUPLICATE');
    }
  );

  it('drops callbacks when the work fails or COMMIT fails', async () => {
    const effect = jest.fn();
    const failing = legacyConnectionFixture();
    await expect(
      execNativeTransactionally(async (bound) => {
        await afterCommit(bound, effect);
        throw new Error('work failed');
      }, failing.connection)
    ).rejects.toThrow('work failed');

    const commitFails = legacyConnectionFixture(new Error('commit failed'));
    await expect(
      execNativeTransactionally(async (bound) => {
        await afterCommit(bound, effect);
      }, commitFails.connection)
    ).rejects.toThrow('commit failed');

    expect(effect).not.toHaveBeenCalled();
    // A later statement on the same pooled connection is not in a tracked
    // transaction, so its callback runs at once.
    await afterCommit({ connection: failing.connection }, effect);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('never fails a committed transaction because a callback failed', async () => {
    const { connection } = legacyConnectionFixture();
    await expect(
      execNativeTransactionally(async (bound) => {
        await afterCommit(bound, () => {
          throw new Error('redis down');
        });
        return 'committed';
      }, connection)
    ).resolves.toBe('committed');
  });
});
