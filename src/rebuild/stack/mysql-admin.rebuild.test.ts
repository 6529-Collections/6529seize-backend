import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireHomeLock } from '@/rebuild/stack/home-lock';
import { LocalMysqld, startLocalMysqld } from '@/rebuild/stack/local-mysqld';
import { stepGrantStatements } from '@/rebuild/guard/db-grants';
import { MysqlAdmin } from '@/rebuild/stack/mysql-admin';

// MysqlAdmin against the private mysqld: copying a table keeps the values of
// columns with a default expression and leaves generated columns to the
// server. Runs with scripts/rebuild-jest.config.cjs.

const HOME =
  process.env.REBUILD_SELF_CHECK_HOME ??
  path.resolve(__dirname, '..', '..', '..', '.rebuild', 'self-check');
const PORT = Number(process.env.REBUILD_SELF_CHECK_PORT ?? 3407);
const FROM = 'rebuild_admin_check_from';
const TO = 'rebuild_admin_check_to';

describe('MysqlAdmin on the private mysqld', () => {
  let release: () => void;
  let server: LocalMysqld;
  let admin: MysqlAdmin;

  beforeAll(
    async () => {
      release = acquireHomeLock(HOME);
      server = await startLocalMysqld({
        home: HOME,
        port: PORT,
        log: () => undefined
      });
      admin = await MysqlAdmin.connect(server.target);
      await admin.recreateDatabase(FROM);
      await admin.recreateDatabase(TO);
      await admin.query(
        `CREATE TABLE ${FROM}.rows_with_defaults (
         id INT NOT NULL PRIMARY KEY,
         amount INT NOT NULL,
         created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
           ON UPDATE CURRENT_TIMESTAMP(3),
         doubled_virtual INT AS (amount * 2) VIRTUAL,
         doubled_stored INT AS (amount * 2) STORED
       )`
      );
      await admin.query(
        `INSERT INTO ${FROM}.rows_with_defaults (id, amount, created_at, updated_at)
       VALUES (1, 21, '2026-01-01 00:00:00.000', '2026-01-02 00:00:00.000')`
      );
    },
    5 * 60 * 1000
  );

  afterAll(
    async () => {
      try {
        // The last test stops the server; this covers a failure before it.
        await server?.stop();
      } finally {
        release?.();
      }
    },
    5 * 60 * 1000
  );

  it('lists default-timestamp columns as insertable and generated ones not', async () => {
    expect(await admin.insertableColumns(FROM, 'rows_with_defaults')).toEqual([
      'id',
      'amount',
      'created_at',
      'updated_at'
    ]);
  });

  it('copies a table with its timestamps, and the server fills generated columns', async () => {
    await admin.copyTables(FROM, TO, ['rows_with_defaults']);
    const rows = await admin.query(
      `SELECT id, amount, created_at, updated_at, doubled_virtual, doubled_stored
         FROM ${TO}.rows_with_defaults`
    );
    expect(rows).toEqual([
      {
        id: 1,
        amount: 21,
        created_at: '2026-01-01 00:00:00.000',
        updated_at: '2026-01-02 00:00:00.000',
        doubled_virtual: 42,
        doubled_stored: 42
      }
    ]);
  });

  it('lets a step lock the rows it reads, and change only what it writes', async () => {
    const user = 'rb_lock_check';
    const password = 'lock-check-password';
    for (const statement of stepGrantStatements({
      user,
      password,
      database: FROM,
      writes: [],
      reads: ['rows_with_defaults']
    })) {
      await admin.query(statement);
    }
    const step = await MysqlAdmin.connect({ ...server.target, user, password });
    try {
      // A locking read, as production writers do on rows they only read.
      await expect(
        step.query(
          `SELECT id FROM ${FROM}.rows_with_defaults WHERE id = 1 FOR UPDATE`
        )
      ).resolves.toEqual([{ id: 1 }]);
      await expect(
        step.query(`UPDATE ${FROM}.rows_with_defaults SET amount = 1`)
      ).rejects.toThrow(/UPDATE command denied/);
    } finally {
      await step.close();
      await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    }
  });

  it('takes a checkpoint table newest row as MySQL orders it, and finds nullable columns', async () => {
    await admin.query(
      `CREATE TABLE ${FROM}.checkpoints (
         id INT NOT NULL PRIMARY KEY,
         block DECIMAL(10, 1) NULL,
         run INT NOT NULL
       )`
    );
    // As text '9.5' sorts after '10.0'; as a number it doesn't. A NULL is
    // never the newest.
    await admin.query(
      `INSERT INTO ${FROM}.checkpoints (id, block, run)
       VALUES (1, 9.5, 1), (2, 10.0, 2), (3, NULL, 3)`
    );
    const newest = await admin.orderedRows(
      FROM,
      'checkpoints',
      ['id'],
      'block'
    );
    expect(newest.map((row) => row.id)).toEqual([2]);
    expect(await admin.columnNullable(FROM, 'checkpoints', 'block')).toBe(true);
    expect(await admin.columnNullable(FROM, 'checkpoints', 'run')).toBe(false);
    expect(await admin.columnNullable(FROM, 'checkpoints', 'nope')).toBeNull();
  });

  it('compares partition tuples under each column own collation', async () => {
    await admin.query(
      `CREATE TABLE ${FROM}.heads (
         family VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
         n INT
       )`
    );
    // utf8mb4_0900_ai_ci: case and accents fold, and 'ss' equals U+00DF;
    // NO PAD, so a trailing space differs. INT compares as numbers.
    expect(
      await admin.overlappingTuples(
        FROM,
        'heads',
        ['family'],
        [['\u00e9'], ['\u00df'], ['a '], ['X']],
        [['E'], ['ss'], ['a'], ['y']]
      )
    ).toEqual([
      [0, 0],
      [1, 1]
    ]);
    expect(
      await admin.overlappingTuples(
        FROM,
        'heads',
        ['family', 'n'],
        [['a', '1']],
        [['A', '01']]
      )
    ).toEqual([[0, 0]]);
  });

  it("evaluates a plan's condition with the database as default, and leaves the admin connection without one", async () => {
    await admin.query(
      `CREATE TABLE ${FROM}.planned (id INT NOT NULL PRIMARY KEY, kind VARCHAR(10), at DATETIME(3))`
    );
    await admin.query(
      `CREATE TABLE ${FROM}.kept (id INT NOT NULL PRIMARY KEY)`
    );
    await admin.query(
      `INSERT INTO ${FROM}.planned VALUES (1, 'a', '2026-01-01 00:00:00.000'), (2, 'b', NULL), (3, 'a', NULL)`
    );
    await admin.query(`INSERT INTO ${FROM}.kept VALUES (1)`);
    const noDefault = async () =>
      (await admin.query<{ db: string | null }>('SELECT DATABASE() AS db'))[0]
        .db;
    expect(await noDefault()).toBeNull();
    // A subquery names another table without its database.
    const rows = await admin.rowsWhere(
      FROM,
      'planned',
      'id NOT IN (SELECT id FROM kept)'
    );
    expect(rows).toEqual([
      { id: 2, kind: 'b', at: null },
      { id: 3, kind: 'a', at: null }
    ]);
    // Values read as the admin connection reads them (dates as strings).
    expect(
      await admin.rowsWhere(FROM, 'planned', 'id IN (SELECT id FROM kept)')
    ).toEqual([{ id: 1, kind: 'a', at: '2026-01-01 00:00:00.000' }]);
    expect(
      await admin.rowsWhereInPartition(
        FROM,
        'planned',
        'id NOT IN (SELECT id FROM kept)',
        ['kind'],
        [['a']]
      )
    ).toBe(1);
    expect(await noDefault()).toBeNull();
    // A condition MySQL refuses leaves no default behind either.
    await expect(
      admin.rowsWhere(FROM, 'planned', 'id IN (SELECT id FROM no_such_table)')
    ).rejects.toThrow(/no_such_table/);
    expect(await noDefault()).toBeNull();
    await expect(
      admin.rowsWhereInPartition(FROM, 'planned', 'nope = 1', ['kind'], [['a']])
    ).rejects.toThrow(/nope/);
    expect(await noDefault()).toBeNull();
    // A database the server doesn't have: the open fails, and leaves no
    // connection behind.
    const connections = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Daemon'"
          )
        )[0].n
      );
    const open = await connections();
    await expect(
      admin.rowsWhere('rebuild_no_such_db', 'planned', '1 = 1')
    ).rejects.toThrow(/rebuild_no_such_db/);
    expect(await connections()).toBe(open);
    expect(await noDefault()).toBeNull();
  });

  it("reads a plan's rows as the admin connection reads them, in the same session settings", async () => {
    await admin.query(
      `CREATE TABLE ${FROM}.typed (
         id BIGINT NOT NULL PRIMARY KEY,
         amount DECIMAL(30, 10) NOT NULL,
         big BIGINT UNSIGNED NOT NULL,
         at TIMESTAMP(3) NULL
       )`
    );
    await admin.query(
      `INSERT INTO ${FROM}.typed VALUES
         (9007199254740993, 12345678901234567890.0123456789, 18446744073709551615, '2026-01-01 00:00:00.123'),
         (2, 0.5, 0, NULL)`
    );
    const ordered = await admin.orderedRows(FROM, 'typed', ['id']);
    expect(await admin.rowsWhere(FROM, 'typed', '1 = 1')).toEqual(
      expect.arrayContaining(ordered)
    );
    expect(ordered).toHaveLength(2);
    // The plan's connection has the admin session's time zone and SQL mode.
    const [session] = await admin.query<{ tz: string; mode: string }>(
      'SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode'
    );
    const same = await admin.rowsWhere(
      FROM,
      'typed',
      `@@session.time_zone = '${session.tz}' AND @@session.sql_mode = '${session.mode}'`
    );
    expect(same).toHaveLength(2);
  });

  it('leaves no pid file once the server stops', async () => {
    const pidFile = path.join(HOME, 'mysql', 'harness-mysqld.pid');
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(String(server.pid));
    await admin.query(`DROP DATABASE IF EXISTS ${FROM}`);
    await admin.query(`DROP DATABASE IF EXISTS ${TO}`);
    await admin.close();
    await server.stop();
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
