import {
  errorCode,
  openReadOnlySnapshot,
  ReadOnlySnapshotExecutor,
  readReplicaLag,
  REPLICA_LAG_SQL,
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
      'UNIX_TIMESTAMP(NOW(6))': [{ ms: '1795478405123' }],
      replica_host_status: [{ lag_ms: 18.5, age_ms: '250.0000' }]
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
      endpoint: 'reader',
      transactionReadOnly: true,
      serverReadOnly: true,
      innodbReadOnly: false,
      snapshotAt: '2026-11-24T00:00:05.123Z',
      replicaLagMs: 18.5,
      replicaLagAgeMs: 250,
      replicaLagError: null,
      replicaLagUnknown: null,
      replicaLagAheadMs: null
    });
    // The hostname stays out of the evidence the manifest carries.
    expect(JSON.stringify(snapshot.evidence)).not.toContain('replica-host');
    expect(statements).toContain(REPLICA_LAG_SQL);
    // The reader's newest row, with its age against the UTC clock.
    expect(REPLICA_LAG_SQL).toBe(
      'SELECT REPLICA_LAG_IN_MILLISECONDS AS lag_ms, TIMESTAMPDIFF(MICROSECOND, LAST_UPDATE_TIMESTAMP, UTC_TIMESTAMP(6)) / 1000 AS age_ms FROM information_schema.replica_host_status WHERE SERVER_ID = @@aurora_server_id ORDER BY LAST_UPDATE_TIMESTAMP DESC LIMIT 1'
    );
    await snapshot.close();
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(connection.release).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalled();
  });

  it.each([
    [
      'no row for this server',
      undefined,
      'information_schema.replica_host_status has no row for this server'
    ],
    [
      'a null lag',
      [{ lag_ms: null, age_ms: 10 }],
      'REPLICA_LAG_IN_MILLISECONDS is null'
    ],
    [
      'a negative lag',
      [{ lag_ms: -1, age_ms: 10 }],
      'REPLICA_LAG_IN_MILLISECONDS is -1'
    ],
    // The lag is kept when the row has one: only its age is unknown.
    [
      'a row without a timestamp',
      [{ lag_ms: 20, age_ms: null }],
      "LAST_UPDATE_TIMESTAMP is null: the row's age is unknown",
      'unreadable',
      20
    ],
    [
      'a row dated in the future',
      [{ lag_ms: 20, age_ms: '-5000.0000' }],
      "LAST_UPDATE_TIMESTAMP is 5000 ms ahead of UTC_TIMESTAMP: not UTC, so the row's age is unknown",
      'dated_ahead',
      20
    ],
    // The server's code and number only: its message can name user and host.
    ['a table it cannot read', 'error', 'ER_UNKNOWN_TABLE 1109']
  ])(
    'records the lag as unknown with %s, and why',
    async (
      _name,
      answer,
      why,
      unknown = 'unreadable',
      lagMs: number | null = null
    ) => {
      const { pool, connection } = fakePool({
        transaction_read_only: [{ tro: 1, ro: 1 }],
        innodb_read_only: [{ iro: 0 }],
        'UNIX_TIMESTAMP(NOW(6))': [{ ms: 1795478405000 }],
        ...(Array.isArray(answer) ? { replica_host_status: answer } : {})
      });
      if (answer === 'error') {
        const query = connection.query;
        connection.query = jest.fn((sql: string, callback: any) =>
          sql.includes('replica_host_status')
            ? callback(
                Object.assign(new Error('ER_UNKNOWN_TABLE: Unknown table'), {
                  code: 'ER_UNKNOWN_TABLE',
                  errno: 1109,
                  sqlMessage:
                    "Unknown table 'REPLICA_HOST_STATUS' in information_schema"
                })
              )
            : query(sql, callback)
        );
      }
      const snapshot = await openReadOnlySnapshot(target, () => pool);
      expect(snapshot.evidence.replicaLagMs).toBe(lagMs);
      expect(snapshot.evidence.replicaLagAgeMs).toBeNull();
      expect(snapshot.evidence.replicaLagError).toBe(why);
      expect(snapshot.evidence.replicaLagUnknown).toBe(unknown);
      // How far ahead the row is dated, when it is: what Tuesday bounds.
      expect(snapshot.evidence.replicaLagAheadMs).toBe(
        unknown === 'dated_ahead' ? 5000 : null
      );
      expect(snapshot.evidence.snapshotAt).toBe('2026-11-24T00:00:05.000Z');
    }
  );

  it.each([
    [
      'a server refusal naming user and host',
      Object.assign(
        new Error(
          "ER_ACCESS_DENIED_ERROR: Access denied for user 'reader'@'192.0.2.10'"
        ),
        {
          code: 'ER_ACCESS_DENIED_ERROR',
          errno: 1045,
          sqlMessage: "Access denied for user 'reader'@'192.0.2.10'"
        }
      ),
      'ER_ACCESS_DENIED_ERROR 1045'
    ],
    [
      'a lookup naming the host',
      Object.assign(new Error('getaddrinfo ENOTFOUND reader.example.invalid'), {
        code: 'ENOTFOUND',
        errno: -3008,
        hostname: 'reader.example.invalid'
      }),
      'ENOTFOUND -3008'
    ],
    [
      'a code repeated as errno',
      Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:3306'), {
        code: 'ECONNREFUSED',
        errno: 'ECONNREFUSED'
      }),
      'ECONNREFUSED'
    ],
    ['an error with no code', new Error('reader.example.invalid'), 'Error'],
    [
      'a bare string naming the host',
      'lost reader.example.invalid',
      'unknown error'
    ]
  ])('keeps only the code and number of %s', async (_name, error, code) => {
    expect(errorCode(error)).toBe(code);
    const connection = {
      query: jest.fn((_sql: string, callback: any) => callback(error, null))
    };
    const reading = await readReplicaLag(connection as never);
    expect(reading).toEqual({
      lagMs: null,
      ageMs: null,
      error: code,
      unknown: 'unreadable',
      aheadMs: null
    });
    expect(JSON.stringify(reading)).not.toMatch(
      /reader\.example|192\.0\.2\.10|'reader'/
    );
  });

  it.each([
    ['an old row', { lag_ms: 20, age_ms: '360000.0000' }, 20, 360_000],
    ['clock jitter', { lag_ms: 20, age_ms: -300 }, 20, 0],
    ['a fresh row', { lag_ms: '7', age_ms: 0 }, 7, 0]
  ])(
    'reads the lag and the age of its row: %s',
    async (_name, row, lagMs, ageMs) => {
      const connection = {
        query: jest.fn((_sql: string, callback: any) => callback(null, [row]))
      };
      await expect(readReplicaLag(connection as never)).resolves.toEqual({
        lagMs,
        ageMs,
        error: null,
        unknown: null,
        aheadMs: null
      });
    }
  );

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
      /^DB_HOST_READ is not a read-only server/
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
