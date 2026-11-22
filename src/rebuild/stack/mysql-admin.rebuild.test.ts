import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireHomeLock } from '@/rebuild/stack/home-lock';
import { LocalMysqld, startLocalMysqld } from '@/rebuild/stack/local-mysqld';
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
