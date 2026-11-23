import * as mysql from 'mysql';
import {
  openReadOnlySnapshot,
  readReplicaLag,
  REPLICA_LAG_SQL
} from './replica-snapshot';

/**
 * The replica lag query on the test MySQL, which is not Aurora: there it
 * must fail because the table or the variable doesn't exist, never because
 * the statement doesn't parse. A parse error would read as "not Aurora" on
 * Aurora too, and the lag check would never run.
 */
describe('the replica lag query on MySQL', () => {
  let connection: mysql.Connection;

  function run(sql: string): Promise<any[]> {
    return new Promise((resolve, reject) =>
      connection.query(sql, (error, rows) =>
        error ? reject(error) : resolve(rows as any[])
      )
    );
  }

  beforeAll(async () => {
    connection = mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASS
    });
    await new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve()))
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => connection.end(() => resolve()));
  });

  it('parses, and a server that is not Aurora answers unknown table or variable', async () => {
    const reading = await readReplicaLag(connection);
    expect(reading.lagMs).toBeNull();
    expect(reading.error).toMatch(
      /^(ER_UNKNOWN_TABLE 1109|ER_UNKNOWN_SYSTEM_VARIABLE 1193)$/
    );
    // The same statement, run directly: the server's own error number.
    const error = await run(REPLICA_LAG_SQL).then(
      () => null,
      (e: mysql.MysqlError) => e
    );
    expect([1109, 1193]).toContain(error?.errno);
  });

  it('runs the snapshot statements, then refuses this server: it is writable', async () => {
    await expect(
      openReadOnlySnapshot({
        host: process.env.DB_HOST!,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER!,
        password: process.env.DB_PASS!,
        database: process.env.DB_NAME!
      })
    ).rejects.toThrow(/is not a read-only server/);
  });

  it('reads the server clock in milliseconds', async () => {
    const [row] = await run(
      'SELECT ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS ms'
    );
    expect(Math.abs(Number(row.ms) - Date.now())).toBeLessThan(60_000);
  });

  /**
   * The statement as written, with a derived table standing in for Aurora's
   * replica_host_status and a server id for @@aurora_server_id, so MySQL
   * runs its WHERE, ORDER BY and the age expression for real.
   */
  function standIn(rows: string): string {
    return REPLICA_LAG_SQL.replace(
      'information_schema.replica_host_status',
      `(${rows}) AS replica_host_status`
    ).replace('@@aurora_server_id', '7');
  }

  it("reads the reader's newest row: its lag and its age against UTC", async () => {
    const reading = await readReplicaLag(
      connection,
      standIn(
        `SELECT 7 AS SERVER_ID, 999 AS REPLICA_LAG_IN_MILLISECONDS, UTC_TIMESTAMP(6) - INTERVAL 1 HOUR AS LAST_UPDATE_TIMESTAMP
         UNION ALL SELECT 7, 18.5, UTC_TIMESTAMP(6) - INTERVAL 2 SECOND
         UNION ALL SELECT 8, 5, UTC_TIMESTAMP(6)`
      )
    );
    expect(reading.error).toBeNull();
    expect(reading.lagMs).toBe(18.5);
    expect(reading.ageMs).toBeGreaterThanOrEqual(2_000);
    expect(reading.ageMs).toBeLessThan(30_000);
  });

  it('reads a row without a timestamp, or dated ahead of UTC, as an unknown lag', async () => {
    await expect(
      readReplicaLag(
        connection,
        standIn(
          'SELECT 7 AS SERVER_ID, 20 AS REPLICA_LAG_IN_MILLISECONDS, CAST(NULL AS DATETIME(6)) AS LAST_UPDATE_TIMESTAMP'
        )
      )
    ).resolves.toEqual({
      lagMs: 20,
      ageMs: null,
      error: "LAST_UPDATE_TIMESTAMP is null: the row's age is unknown",
      unknown: 'unreadable'
    });
    const ahead = await readReplicaLag(
      connection,
      standIn(
        'SELECT 7 AS SERVER_ID, 20 AS REPLICA_LAG_IN_MILLISECONDS, UTC_TIMESTAMP(6) + INTERVAL 2 HOUR AS LAST_UPDATE_TIMESTAMP'
      )
    );
    expect(ahead.lagMs).toBe(20);
    expect(ahead.ageMs).toBeNull();
    expect(ahead.error).toMatch(/ms ahead of UTC_TIMESTAMP: not UTC/);
    expect(ahead).toMatchObject({ unknown: 'dated_ahead' });
  });

  it('would not parse with the alias lag: LAG is a reserved word', async () => {
    const error = await run('SELECT 1 AS lag').then(
      () => null,
      (e: mysql.MysqlError) => e
    );
    expect(error?.errno).toBe(1064);
    const [row] = await run('SELECT 1 AS lag_ms');
    expect(Number(row.lag_ms)).toBe(1);
  });
});
