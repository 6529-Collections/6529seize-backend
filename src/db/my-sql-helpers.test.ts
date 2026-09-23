import type { PoolConnection } from 'mysql';
import { SqlTransactionOptions } from '@/sql-executor';
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
