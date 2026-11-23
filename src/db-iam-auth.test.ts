import * as mysql from 'mysql2';
import {
  createDbAuthTokenSource,
  dbAuthPlugins,
  isDbConnectionTargetComplete,
  resolveDbConnectionTargets,
  sslOptionsFor
} from './db-iam-auth';
import { FakeMysqlServer } from '@/tests/fake-mysql-server';

const PASSWORD_ENV = {
  DB_HOST: 'writer.example',
  DB_USER: 'app',
  DB_PASS: 'secret',
  DB_HOST_READ: 'reader.example',
  DB_USER_READ: 'app_read',
  DB_PASS_READ: 'secret_read'
};

const IAM_ENV = {
  ...PASSWORD_ENV,
  DB_IAM_AUTH: 'true',
  DB_IAM_HOST: 'iam-proxy.example',
  DB_IAM_USER: 'seize_app_rw',
  DB_IAM_HOST_READ: 'iam-proxy-ro.example',
  DB_IAM_USER_READ: 'seize_app_ro'
};

describe('resolveDbConnectionTargets', () => {
  it('uses the password settings when IAM is not requested', () => {
    expect(resolveDbConnectionTargets(PASSWORD_ENV)).toEqual({
      write: {
        host: 'writer.example',
        user: 'app',
        password: 'secret',
        iam: false
      },
      read: {
        host: 'reader.example',
        user: 'app_read',
        password: 'secret_read',
        iam: false
      }
    });
  });

  it('uses the IAM settings when requested and complete', () => {
    expect(resolveDbConnectionTargets(IAM_ENV)).toEqual({
      write: { host: 'iam-proxy.example', user: 'seize_app_rw', iam: true },
      read: { host: 'iam-proxy-ro.example', user: 'seize_app_ro', iam: true }
    });
  });

  it.each([
    'DB_IAM_HOST',
    'DB_IAM_USER',
    'DB_IAM_HOST_READ',
    'DB_IAM_USER_READ'
  ])('falls back to passwords when %s is missing', (key) => {
    const env: Record<string, string> = { ...IAM_ENV };
    delete env[key];
    const targets = resolveDbConnectionTargets(env);
    expect(targets.write.iam).toBe(false);
    expect(targets.read.iam).toBe(false);
    expect(targets.write.password).toBe('secret');
  });

  it.each(['false', '', 'yes'])(
    'ignores the IAM settings when DB_IAM_AUTH=%j',
    (value) => {
      const targets = resolveDbConnectionTargets({
        ...IAM_ENV,
        DB_IAM_AUTH: value
      });
      expect(targets.write.host).toBe('writer.example');
      expect(targets.write.iam).toBe(false);
    }
  );
});

describe('isDbConnectionTargetComplete', () => {
  it('needs a password only in password mode', () => {
    expect(
      isDbConnectionTargetComplete({ host: 'h', user: 'u', iam: true })
    ).toBe(true);
    expect(
      isDbConnectionTargetComplete({ host: 'h', user: 'u', iam: false })
    ).toBe(false);
    expect(
      isDbConnectionTargetComplete({
        host: 'h',
        user: 'u',
        password: 'p',
        iam: false
      })
    ).toBe(true);
    expect(
      isDbConnectionTargetComplete({ host: '', user: 'u', iam: true })
    ).toBe(false);
  });
});

describe('sslOptionsFor', () => {
  it('always verifies TLS for IAM targets', () => {
    expect(sslOptionsFor({ host: 'h', user: 'u', iam: true }, {})).toEqual({
      ssl: { rejectUnauthorized: true }
    });
  });

  it('keeps password targets on the DB_SSL setting', () => {
    expect(
      sslOptionsFor({ host: 'h', user: 'u', password: 'p', iam: false }, {})
    ).toEqual({});
    expect(
      sslOptionsFor(
        { host: 'h', user: 'u', password: 'p', iam: false },
        { DB_SSL: 'true' }
      )
    ).toEqual({ ssl: { rejectUnauthorized: true } });
  });
});

describe('createDbAuthTokenSource', () => {
  it('signs once, reuses the token, and refreshes it after 10 minutes', async () => {
    let clock = 0;
    let issued = 0;
    const sign = jest.fn(async () => `token-${++issued}`);
    const tokens = createDbAuthTokenSource(
      { host: 'h', port: 3306, user: 'u' },
      { sign, now: () => clock }
    );
    expect(tokens.current()).toBe('');
    const [first, second] = await Promise.all([
      tokens.ensureFresh(),
      tokens.ensureFresh()
    ]);
    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(sign).toHaveBeenCalledTimes(1);
    clock = 9 * 60 * 1000;
    await expect(tokens.ensureFresh()).resolves.toBe('token-1');
    clock = 10 * 60 * 1000;
    await expect(tokens.ensureFresh()).resolves.toBe('token-2');
    expect(tokens.current()).toBe('token-2');
  });

  it('retries signing after a failure', async () => {
    const sign = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('no credentials'))
      .mockResolvedValueOnce('token');
    const tokens = createDbAuthTokenSource(
      { host: 'h', port: 3306, user: 'u' },
      { sign }
    );
    await expect(tokens.ensureFresh()).rejects.toThrow('no credentials');
    await expect(tokens.ensureFresh()).resolves.toBe('token');
  });
});

describe('dbAuthPlugins', () => {
  const plugin = (
    plugins: ReturnType<typeof dbAuthPlugins>,
    name: string
  ): ((data: Buffer) => unknown) =>
    plugins[name]({
      connection: {} as mysql.Connection,
      command: 'ClientHandshake'
    }) as (data: Buffer) => unknown;

  it('answers a clear-password request with a fresh token', async () => {
    const tokens = {
      current: () => 'stale',
      ensureFresh: jest.fn(async () => 'tok')
    };
    const answer = plugin(dbAuthPlugins(tokens), 'mysql_clear_password');
    await expect(answer(Buffer.alloc(0))).resolves.toEqual(
      Buffer.from('tok\0')
    );
    expect(tokens.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('reports a signing failure and fails the login', async () => {
    const onTokenError = jest.fn();
    const answer = plugin(
      dbAuthPlugins(
        {
          current: () => '',
          ensureFresh: async () => {
            throw new Error('expired credentials');
          }
        },
        onTokenError
      ),
      'mysql_clear_password'
    );
    await expect(answer(Buffer.alloc(0))).rejects.toThrow(
      'expired credentials'
    );
    expect(onTokenError).toHaveBeenCalledTimes(1);
  });

  it.each(['mysql_clear_password', 'sha256_password', 'caching_sha2_password'])(
    'refuses %s in password mode, as the mysql driver did',
    (name) => {
      expect(() => plugin(dbAuthPlugins(null), name)(Buffer.alloc(0))).toThrow(
        'not allowed'
      );
    }
  );

  it.each(['sha256_password', 'caching_sha2_password'])(
    'refuses %s in IAM mode',
    (name) => {
      const tokens = { current: () => 't', ensureFresh: async () => 't' };
      expect(() =>
        plugin(dbAuthPlugins(tokens), name)(Buffer.alloc(0))
      ).toThrow('not allowed');
    }
  );
});

describe('token login with mysql2', () => {
  let server: FakeMysqlServer | undefined;
  let pool: mysql.Pool | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      pool ? pool.end(() => resolve()) : resolve()
    );
    await server?.stop();
    pool = undefined;
    server = undefined;
  });

  const connect = (target: mysql.Pool) =>
    new Promise<mysql.PoolConnection>((resolve, reject) =>
      target.getConnection((error, connection) =>
        error ? reject(error) : resolve(connection)
      )
    );

  it('logs each new connection in with a token no older than 10 minutes', async () => {
    server = new FakeMysqlServer({ clearPassword: true });
    const port = await server.start();
    let clock = 0;
    let issued = 0;
    const tokens = createDbAuthTokenSource(
      { host: '127.0.0.1', port, user: 'seize_app_rw' },
      { sign: async () => `token-${++issued}`, now: () => clock }
    );
    pool = mysql.createPool({
      host: '127.0.0.1',
      port,
      user: 'seize_app_rw',
      database: 'OM6529',
      authPlugins: dbAuthPlugins(tokens)
    });
    const first = await connect(pool);
    const second = await connect(pool);
    clock = 10 * 60 * 1000;
    const third = await connect(pool);
    [first, second, third].forEach((connection) => connection.release());

    expect(server.logins).toEqual([
      expect.objectContaining({
        user: 'seize_app_rw',
        database: 'OM6529',
        clientPlugin: 'mysql_native_password',
        clearPassword: 'token-1'
      }),
      expect.objectContaining({ clearPassword: 'token-1' }),
      expect.objectContaining({ clearPassword: 'token-2' })
    ]);
  });

  it('keeps native password login in password mode', async () => {
    server = new FakeMysqlServer({ password: 'secret' });
    const port = await server.start();
    pool = mysql.createPool({
      host: '127.0.0.1',
      port,
      user: 'app',
      password: 'secret',
      authPlugins: dbAuthPlugins(null)
    });
    (await connect(pool)).release();
    expect(server.logins).toEqual([
      expect.objectContaining({ user: 'app', clearPassword: null })
    ]);
  });

  it('never sends the password in clear text in password mode', async () => {
    server = new FakeMysqlServer({ clearPassword: true });
    const port = await server.start();
    pool = mysql.createPool({
      host: '127.0.0.1',
      port,
      user: 'app',
      password: 'secret',
      authPlugins: dbAuthPlugins(null)
    });
    await expect(connect(pool)).rejects.toThrow('not allowed');
    expect(server.logins).toEqual([]);
  });
});

describe('review follow-ups', () => {
  it('refuses to sign without a region instead of guessing one', async () => {
    const saved = {
      AWS_REGION: process.env.AWS_REGION,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION
    };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const tokens = createDbAuthTokenSource({
        host: 'h',
        port: 3306,
        user: 'u'
      });
      await expect(tokens.ensureFresh()).rejects.toThrow('AWS_REGION');
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
