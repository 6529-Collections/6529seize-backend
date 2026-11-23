import type { PoolOptions } from 'mysql2';
import * as dbApi from './db-api';
import * as db from './db';
import { sqlExecutor } from './sql-executor';
import {
  FakeMysqlServer,
  FakeReply,
  FIELD_TYPE
} from '@/tests/fake-mysql-server';

/*
 * Both connection points (the API pools and the TypeORM data source) against
 * a scripted MySQL server: password logins, token logins and the values
 * callers get back.
 */

// The raw module object, so a spy also replaces what src/ modules call.
const mysql2Module: typeof import('mysql2') = require('mysql2');

const ENV_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_HOST_READ',
  'DB_USER_READ',
  'DB_PASS_READ',
  'DB_NAME',
  'DB_SSL',
  'DB_IAM_AUTH',
  'DB_IAM_HOST',
  'DB_IAM_USER',
  'DB_IAM_HOST_READ',
  'DB_IAM_USER_READ',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
];
const UPDATE_INFO = 'Rows matched: 3  Changed: 2  Warnings: 0';
// fieldCount, affectedRows, insertId, serverStatus, warningCount, message,
// protocol41, changedRows: the mysql driver's OkPacket after Object.values.
const UPDATE_RESULT = [0, 3, 0, 2, 0, UPDATE_INFO, true, 2];

function onQuery(sql: string): FakeReply {
  if (sql === 'SELECT version()') {
    // TypeORM's startup query.
    return {
      columns: [{ name: 'version()', type: FIELD_TYPE.VAR_STRING }],
      rows: [['8.0.36']]
    };
  }
  if (sql.startsWith('UPDATE')) {
    return { affectedRows: 3, info: UPDATE_INFO };
  }
  return {
    columns: [
      { name: 'flag', type: FIELD_TYPE.TINY },
      { name: 'doc', type: FIELD_TYPE.JSON },
      { name: 'amount', type: FIELD_TYPE.NEWDECIMAL },
      { name: 'at', type: FIELD_TYPE.DATETIME }
    ],
    rows: [['1', '{"a":1}', '1.50', '2024-01-02 03:04:05']]
  };
}

let saved: Record<string, string | undefined>;
let server: FakeMysqlServer | undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  jest.restoreAllMocks();
  await server?.stop();
  server = undefined;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function startServer(
  options: ConstructorParameters<typeof FakeMysqlServer>[0]
): Promise<void> {
  server = new FakeMysqlServer({ onQuery, ...options });
  const port = await server.start();
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(port),
    DB_USER: 'app',
    DB_PASS: 'secret',
    DB_HOST_READ: '127.0.0.1',
    DB_USER_READ: 'app_read',
    DB_PASS_READ: 'secret',
    DB_NAME: 'OM6529'
  });
}

function useIamSettings(): void {
  Object.assign(process.env, {
    DB_IAM_AUTH: 'true',
    DB_IAM_HOST: '127.0.0.1',
    DB_IAM_USER: 'seize_app_rw',
    DB_IAM_HOST_READ: '127.0.0.1',
    DB_IAM_USER_READ: 'seize_app_ro',
    // Signing is local; these credentials never leave the process.
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'test-secret'
  });
}

/** Records pool settings, then connects without TLS (the fake has none). */
function captureCreatePool(): PoolOptions[] {
  const created: PoolOptions[] = [];
  const createPool = mysql2Module.createPool.bind(mysql2Module);
  jest
    .spyOn(mysql2Module, 'createPool')
    .mockImplementation((options: string | PoolOptions) => {
      const settings = options as PoolOptions;
      created.push(settings);
      const { ssl: _ssl, ...withoutTls } = settings;
      return createPool(withoutTls);
    });
  return created;
}

const tokenFor = (user: string) =>
  expect.stringMatching(
    new RegExp(
      `^127\\.0\\.0\\.1:\\d+/\\?Action=connect&DBUser=${user}&.*X-Amz-Signature=`
    )
  );

describe('API pools (db-api)', () => {
  it('log in with the password and return what the mysql driver did', async () => {
    await startServer({ password: 'secret' });
    await dbApi.connect();
    try {
      await expect(
        sqlExecutor.execute('SELECT * FROM t WHERE id = :id', { id: "a'b" })
      ).resolves.toEqual([
        {
          flag: true,
          doc: '{"a":1}',
          amount: 1.5,
          at: new Date('2024-01-02 03:04:05').toISOString()
        }
      ]);
      const write = await sqlExecutor.execute('UPDATE t SET x = :x', { x: 1 });
      expect(write).toEqual(UPDATE_RESULT);
      expect(sqlExecutor.getAffectedRows(write)).toBe(3);
      expect(server!.queries).toEqual([
        "SELECT * FROM t WHERE id = 'a\\'b'",
        'UPDATE t SET x = 1'
      ]);
      expect(server!.logins).toEqual([
        expect.objectContaining({ user: 'app_read', clearPassword: null }),
        expect.objectContaining({ user: 'app', clearPassword: null })
      ]);
    } finally {
      await dbApi.disconnect();
    }
  });

  it('log IAM targets in with a token over verified TLS', async () => {
    await startServer({ clearPassword: true });
    useIamSettings();
    const created = captureCreatePool();
    await dbApi.connect();
    try {
      expect(created).toEqual([
        expect.objectContaining({
          user: 'seize_app_rw',
          password: undefined,
          ssl: { rejectUnauthorized: true }
        }),
        expect.objectContaining({
          user: 'seize_app_ro',
          password: undefined,
          ssl: { rejectUnauthorized: true }
        })
      ]);
      await sqlExecutor.execute('SELECT 1');
      await sqlExecutor.execute('UPDATE t SET x = 1');
      expect(server!.logins).toEqual([
        expect.objectContaining({
          user: 'seize_app_ro',
          clearPassword: tokenFor('seize_app_ro')
        }),
        expect.objectContaining({
          user: 'seize_app_rw',
          clearPassword: tokenFor('seize_app_rw')
        })
      ]);
    } finally {
      await dbApi.disconnect();
    }
  });
});

describe('TypeORM data source (db)', () => {
  it('logs in with the password and returns what the mysql driver did', async () => {
    await startServer({ password: 'secret' });
    await db.connect();
    try {
      await expect(
        sqlExecutor.execute('SELECT * FROM t WHERE id = :id', { id: 7 })
      ).resolves.toEqual([
        { flag: 1, doc: '{"a":1}', amount: '1.50', at: '2024-01-02 03:04:05' }
      ]);
      await expect(sqlExecutor.execute('UPDATE t SET x = 1')).resolves.toEqual(
        UPDATE_RESULT
      );
      expect(server!.logins[0]).toMatchObject({
        user: 'app',
        clearPassword: null
      });
    } finally {
      await db.disconnect();
    }
  });

  it('logs IAM targets in with a token over verified TLS', async () => {
    await startServer({ clearPassword: true });
    useIamSettings();
    const created = captureCreatePool();
    await db.connect();
    try {
      expect(created).toEqual([
        expect.objectContaining({
          user: 'seize_app_rw',
          password: undefined,
          ssl: { rejectUnauthorized: true },
          timezone: 'Z'
        })
      ]);
      await sqlExecutor.execute('SELECT 1');
      expect(server!.logins[0]).toMatchObject({
        user: 'seize_app_rw',
        clearPassword: tokenFor('seize_app_rw')
      });
    } finally {
      await db.disconnect();
    }
  });
});
