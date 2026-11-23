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
      /^(ER_UNKNOWN_TABLE 1109|ER_UNKNOWN_SYSTEM_VARIABLE 1193): /
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
