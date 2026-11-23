import * as mysql from 'mysql';
import {
  attachDbAuthTokenSource,
  createDbAuthTokenSource,
  installMysqlIamAuthSupport,
  isDbConnectionTargetComplete,
  resolveDbConnectionTargets,
  sslOptionsFor
} from './db-iam-auth';

const MysqlAuth = require('mysql/lib/protocol/Auth');
const ClientAuthenticationPacket = require('mysql/lib/protocol/packets/ClientAuthenticationPacket');
const ConnectionConfig = require('mysql/lib/ConnectionConfig');
const PacketWriter = require('mysql/lib/protocol/PacketWriter');
const ClientConstants = require('mysql/lib/protocol/constants/client');

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

describe('installMysqlIamAuthSupport', () => {
  beforeAll(() => {
    installMysqlIamAuthSupport();
    installMysqlIamAuthSupport();
  });

  it('answers a clear-password request with the token', () => {
    expect(
      MysqlAuth.auth('mysql_clear_password', Buffer.alloc(0), {
        password: 'tok'
      })
    ).toEqual(Buffer.from('tok\0'));
  });

  it('keeps native password authentication unchanged', () => {
    const scramble = Buffer.alloc(20, 7);
    expect(
      MysqlAuth.auth('mysql_native_password', scramble, { password: 'pw' })
    ).toEqual(MysqlAuth.token('pw', scramble));
    expect(MysqlAuth.auth('unknown_plugin', scramble, {})).toBeUndefined();
  });

  it('advertises plugin authentication', () => {
    const config = new ConnectionConfig({ host: 'h' });
    expect(config.clientFlags & ClientConstants.CLIENT_PLUGIN_AUTH).not.toBe(0);
  });

  it('names the client plugin at the end of the handshake response', () => {
    const write = (clientFlags: number) => {
      const writer = new PacketWriter();
      new ClientAuthenticationPacket({
        clientFlags,
        maxPacketSize: 0,
        charsetNumber: 33,
        user: 'u',
        scrambleBuff: Buffer.alloc(0),
        database: 'db',
        protocol41: true
      }).write(writer);
      return writer.toBuffer({ incrementPacketNumber: () => 0 } as any);
    };
    const withPlugin = write(ClientConstants.CLIENT_PLUGIN_AUTH);
    const withoutPlugin = write(0);
    expect(withPlugin.subarray(-22).toString()).toBe('mysql_native_password\0');
    expect(withoutPlugin.toString()).not.toContain('mysql_native_password');
  });
});

describe('attachDbAuthTokenSource', () => {
  it('gives new connections the newest token after refreshing it', async () => {
    const pool = mysql.createPool({ host: 'h', user: 'u' });
    const order: string[] = [];
    let token = '';
    const tokens = {
      current: () => token,
      ensureFresh: jest.fn(async () => {
        order.push('refresh');
        token = 'fresh-token';
        return token;
      })
    };
    const originalGetConnection = jest
      .spyOn(pool, 'getConnection')
      .mockImplementation(((callback: any) => {
        order.push('getConnection');
        callback(null, 'connection');
      }) as any);
    attachDbAuthTokenSource(pool, tokens);

    const connection = await new Promise((resolve, reject) =>
      pool.getConnection((err, conn) => (err ? reject(err) : resolve(conn)))
    );
    expect(connection).toBe('connection');
    expect(order).toEqual(['refresh', 'getConnection']);
    expect((pool as any).config.connectionConfig.password).toBe('fresh-token');
    expect((pool as any).config.newConnectionConfig().password).toBe(
      'fresh-token'
    );
    originalGetConnection.mockRestore();
    pool.end(() => undefined);
  });

  it('reports a signing failure to the caller', async () => {
    const pool = mysql.createPool({ host: 'h', user: 'u' });
    attachDbAuthTokenSource(pool, {
      current: () => '',
      ensureFresh: async () => {
        throw new Error('no credentials');
      }
    });
    await expect(
      new Promise((resolve, reject) =>
        pool.getConnection((err, conn) => (err ? reject(err) : resolve(conn)))
      )
    ).rejects.toThrow('no credentials');
    pool.end(() => undefined);
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

  it('refuses to patch a driver whose internals changed', () => {
    expect(() =>
      installMysqlIamAuthSupport({
        auth: { auth: () => undefined },
        clientAuthenticationPacket: { prototype: { write: () => undefined } },
        connectionConfig: { getDefaultFlags: () => ['+PROTOCOL_41'] },
        clientPluginAuthFlag: 524288
      })
    ).toThrow('mysql@2.18');
  });

  it('reports token signing failures to the error callback', async () => {
    const pool = mysql.createPool({ host: 'h', user: 'u' });
    const onTokenError = jest.fn();
    attachDbAuthTokenSource(
      pool,
      {
        current: () => '',
        ensureFresh: async () => {
          throw new Error('expired credentials');
        }
      },
      onTokenError
    );
    await expect(
      new Promise((resolve, reject) =>
        pool.getConnection((err, conn) => (err ? reject(err) : resolve(conn)))
      )
    ).rejects.toThrow('expired credentials');
    expect(onTokenError).toHaveBeenCalledTimes(1);
    pool.end(() => undefined);
  });
});
