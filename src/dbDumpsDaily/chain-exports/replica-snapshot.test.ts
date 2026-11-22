import {
  openReadOnlySnapshot,
  ReadOnlySnapshotExecutor,
  ReplicaGuardError,
  replicaTarget
} from './replica-snapshot';

const ENV = {
  DB_HOST: 'primary-host',
  DB_HOST_READ: 'replica-host',
  DB_PORT: '3306',
  DB_USER_READ: 'reader',
  DB_PASS_READ: 'secret',
  DB_NAME: 'app'
};

describe('replicaTarget', () => {
  it('takes the read replica settings', () => {
    expect(replicaTarget(ENV)).toEqual({
      host: 'replica-host',
      port: 3306,
      user: 'reader',
      password: 'secret',
      database: 'app'
    });
  });

  it.each([
    [{ DB_HOST_READ: undefined }],
    [{ DB_HOST_READ: '  ' }],
    [{ DB_HOST_READ: 'primary-host' }],
    [{ DB_HOST_READ: 'Primary-Host ' }],
    [{ DB_HOST: undefined }],
    [{ DB_HOST: ' ' }],
    [{ DB_USER_READ: undefined }],
    [{ DB_PASS_READ: undefined }],
    [{ DB_PORT: 'x' }],
    [{ DB_NAME: undefined }]
  ])('refuses %j', (over) => {
    expect(() => replicaTarget({ ...ENV, ...over })).toThrow(ReplicaGuardError);
  });
});

function fakePool(answers: Record<string, unknown[]> = {}) {
  const statements: string[] = [];
  const connection: any = {
    query: jest.fn((sql: string, callback: any) => {
      statements.push(sql);
      const key = Object.keys(answers).find((it) => sql.includes(it));
      callback(null, key ? answers[key] : []);
    }),
    release: jest.fn()
  };
  const pool: any = {
    getConnection: (callback: any) => callback(null, connection),
    end: jest.fn((callback: any) => callback())
  };
  return { pool, connection, statements };
}

describe('openReadOnlySnapshot', () => {
  const target = replicaTarget(ENV);

  it('starts a UTC, read-only transaction with a consistent snapshot and checks it', async () => {
    const { pool, connection, statements } = fakePool({
      transaction_read_only: [{ tro: 1, ro: 1 }],
      innodb_read_only: [{ iro: 0 }],
      'UNIX_TIMESTAMP(NOW(6))': [{ ms: '1795478405123' }]
    });
    const createPool = jest.fn(() => pool);
    const snapshot = await openReadOnlySnapshot(target, createPool);
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'replica-host', connectionLimit: 1 })
    );
    expect(statements.slice(0, 4)).toEqual([
      "SET SESSION time_zone = '+00:00'",
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'SET SESSION TRANSACTION READ ONLY',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'
    ]);
    expect(snapshot.evidence).toEqual({
      host: 'replica-host',
      transactionReadOnly: true,
      serverReadOnly: true,
      innodbReadOnly: false,
      snapshotAt: '2026-11-24T00:00:05.123Z'
    });
    await snapshot.close();
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(connection.release).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalled();
  });

  it('takes an Aurora reader (innodb_read_only) as read-only', async () => {
    const { pool } = fakePool({
      transaction_read_only: [{ tro: 1, ro: 0 }],
      innodb_read_only: [{ iro: 1 }],
      'UNIX_TIMESTAMP(NOW(6))': [{ ms: 1795478405000 }]
    });
    const snapshot = await openReadOnlySnapshot(target, () => pool);
    expect(snapshot.evidence.innodbReadOnly).toBe(true);
  });

  it('refuses a server that is not read-only: a reader endpoint routed to the writer', async () => {
    const { pool, connection } = fakePool({
      transaction_read_only: [{ tro: 1, ro: 0 }],
      innodb_read_only: [{ iro: 0 }],
      'UNIX_TIMESTAMP(NOW(6))': [{ ms: 1795478405000 }]
    });
    await expect(openReadOnlySnapshot(target, () => pool)).rejects.toThrow(
      /not a read-only server/
    );
    expect(connection.release).toHaveBeenCalled();
  });

  it('keeps the refusal when the rollback also fails', async () => {
    const { pool, connection } = fakePool({
      transaction_read_only: [{ tro: 0, ro: 1 }]
    });
    const query = connection.query;
    connection.query = jest.fn((sql: string, callback: any) =>
      sql === 'ROLLBACK'
        ? callback(new Error('connection lost'))
        : query(sql, callback)
    );
    await expect(openReadOnlySnapshot(target, () => pool)).rejects.toThrow(
      /did not start READ ONLY/
    );
    expect(connection.release).toHaveBeenCalled();
  });

  it('refuses and closes when the transaction is not read-only', async () => {
    const { pool, connection } = fakePool({
      transaction_read_only: [{ tro: 0, ro: 0 }]
    });
    await expect(openReadOnlySnapshot(target, () => pool)).rejects.toThrow(
      ReplicaGuardError
    );
    expect(connection.release).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalled();
  });
});

describe('ReadOnlySnapshotExecutor', () => {
  it.each([
    'insert into t values (1)',
    'update t set a = 1',
    'delete from t',
    'set autocommit = 1',
    'commit'
  ])('refuses %s', async (sql) => {
    const executor = new ReadOnlySnapshotExecutor({} as never);
    await expect(executor.execute(sql)).rejects.toThrow(/only SELECT/);
  });

  it('refuses to open a write transaction', async () => {
    const executor = new ReadOnlySnapshotExecutor({} as never);
    await expect(
      executor.executeNativeQueriesInTransaction(async () => 1)
    ).rejects.toThrow(/write transaction/);
  });
});
