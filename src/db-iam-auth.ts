import { Signer } from '@aws-sdk/rds-signer';
import type { Pool, PoolConnection } from 'mysql';
import { getMysqlSslOptions, MysqlSslOptions } from './db-ssl';

/*
 * Optional IAM token login for the MySQL pools.
 *
 * With DB_IAM_AUTH=true and the DB_IAM_* settings present, the app connects
 * to an RDS Proxy that only accepts IAM tokens, as the Lambda's own IAM role:
 * no database password exists anywhere. Without them, the existing
 * DB_HOST/DB_USER/DB_PASS settings are used exactly as before, so services
 * built before this change keep working while the shared secret carries both.
 *
 * The `mysql` driver only speaks mysql_native_password. Token login needs
 * three small protocol additions, installed once per process and only in IAM
 * mode: advertise plugin authentication, name the client plugin in the
 * handshake response, and answer a server switch to mysql_clear_password.
 * The token is sent in clear text, so IAM mode always uses verified TLS.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/** A fresh token for each new connection; RDS tokens are valid 15 minutes. */
const TOKEN_REFRESH_AFTER_MS = 10 * 60 * 1000;

export interface DbConnectionTarget {
  readonly host: string;
  readonly user: string;
  /** Static password; absent in IAM mode. */
  readonly password?: string;
  readonly iam: boolean;
}

export interface DbConnectionTargets {
  readonly write: DbConnectionTarget;
  readonly read: DbConnectionTarget;
}

export function isDbIamAuthRequested(env: Environment = process.env): boolean {
  return env.DB_IAM_AUTH?.trim().toLowerCase() === 'true';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Picks the write and read targets. IAM mode needs DB_IAM_AUTH=true plus
 * DB_IAM_HOST, DB_IAM_USER, DB_IAM_HOST_READ and DB_IAM_USER_READ; if any is
 * missing the password settings are used, so a half-written secret never
 * strands a service.
 */
export function resolveDbConnectionTargets(
  env: Environment = process.env
): DbConnectionTargets {
  const iamHost = nonEmpty(env.DB_IAM_HOST);
  const iamUser = nonEmpty(env.DB_IAM_USER);
  const iamHostRead = nonEmpty(env.DB_IAM_HOST_READ);
  const iamUserRead = nonEmpty(env.DB_IAM_USER_READ);
  if (
    isDbIamAuthRequested(env) &&
    iamHost &&
    iamUser &&
    iamHostRead &&
    iamUserRead
  ) {
    return {
      write: { host: iamHost, user: iamUser, iam: true },
      read: { host: iamHostRead, user: iamUserRead, iam: true }
    };
  }
  return {
    write: {
      host: env.DB_HOST ?? '',
      user: env.DB_USER ?? '',
      password: env.DB_PASS,
      iam: false
    },
    read: {
      host: env.DB_HOST_READ ?? '',
      user: env.DB_USER_READ ?? '',
      password: env.DB_PASS_READ,
      iam: false
    }
  };
}

/** True when the target has everything it needs to connect. */
export function isDbConnectionTargetComplete(
  target: DbConnectionTarget
): boolean {
  return !!target.host && !!target.user && (target.iam || !!target.password);
}

/** Token login is clear text on the wire, so IAM mode always verifies TLS. */
export function sslOptionsFor(
  target: DbConnectionTarget,
  env: Environment = process.env
): { ssl?: MysqlSslOptions } {
  const configured = getMysqlSslOptions(env);
  if (configured) {
    return { ssl: configured };
  }
  return target.iam ? { ssl: { rejectUnauthorized: true } } : {};
}

export interface DbAuthTokenSource {
  /** The newest token, or '' before the first one is issued. */
  current(): string;
  /** Resolves once the current token is fresh enough for a new connection. */
  ensureFresh(): Promise<string>;
}

type TokenSigner = () => Promise<string>;

export function createDbAuthTokenSource(
  target: { host: string; port: number; user: string },
  options: {
    readonly region?: string;
    readonly sign?: TokenSigner;
    readonly now?: () => number;
  } = {}
): DbAuthTokenSource {
  const now = options.now ?? Date.now;
  const region =
    options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const sign =
    options.sign ??
    (() =>
      region
        ? new Signer({
            hostname: target.host,
            port: target.port,
            username: target.user,
            region
          }).getAuthToken()
        : // A token signed for the wrong region fails with a confusing
          // access-denied; say what is missing instead.
          Promise.reject(
            new Error('DB IAM auth needs AWS_REGION to sign login tokens')
          ));
  let token = '';
  let issuedAt = 0;
  let pending: Promise<string> | null = null;
  return {
    current: () => token,
    ensureFresh: () => {
      if (token && now() - issuedAt < TOKEN_REFRESH_AFTER_MS) {
        return Promise.resolve(token);
      }
      pending ??= sign()
        .then((issued) => {
          token = issued;
          issuedAt = now();
          return issued;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    }
  };
}

const PROTOCOL_PATCHED = Symbol.for('6529.mysql.iamAuthProtocol');

interface MysqlProtocolModules {
  readonly auth: {
    auth: (name: string, data: Buffer, options?: { password?: string }) => any;
  };
  readonly clientAuthenticationPacket: {
    prototype: {
      write: (writer: any) => void;
    };
  };
  readonly connectionConfig: {
    getDefaultFlags: (options?: unknown) => string[];
  };
  readonly clientPluginAuthFlag: number;
}

function loadMysqlProtocolModules(): MysqlProtocolModules {
  return {
    auth: require('mysql/lib/protocol/Auth'),
    clientAuthenticationPacket: require('mysql/lib/protocol/packets/ClientAuthenticationPacket'),
    connectionConfig: require('mysql/lib/ConnectionConfig'),
    clientPluginAuthFlag: require('mysql/lib/protocol/constants/client')
      .CLIENT_PLUGIN_AUTH
  };
}

/**
 * Teaches the `mysql` driver the token login handshake. Idempotent; only
 * called in IAM mode, so password-mode processes keep the stock driver.
 *
 * The patch is process-wide. That is safe because IAM mode is all or nothing
 * per process (resolveDbConnectionTargets switches write and read together),
 * so no password-mode pool shares the patched driver with a token. It relies
 * on mysql@2.18 internals and refuses to run if their shape has changed.
 */
export function installMysqlIamAuthSupport(
  modules: MysqlProtocolModules = loadMysqlProtocolModules()
): void {
  const holder = modules.auth as unknown as Record<symbol, boolean>;
  if (holder[PROTOCOL_PATCHED]) {
    return;
  }
  if (
    typeof modules.auth?.auth !== 'function' ||
    typeof modules.clientAuthenticationPacket?.prototype?.write !==
      'function' ||
    typeof modules.connectionConfig?.getDefaultFlags !== 'function' ||
    typeof modules.clientPluginAuthFlag !== 'number' ||
    !modules.connectionConfig.getDefaultFlags().includes('-PLUGIN_AUTH')
  ) {
    throw new Error(
      'mysql driver internals are not the ones the IAM login patch was written for (mysql@2.18); review src/db-iam-auth.ts before enabling DB_IAM_AUTH'
    );
  }
  const originalAuth = modules.auth.auth;
  modules.auth.auth = function (name, data, options) {
    if (name === 'mysql_clear_password') {
      return Buffer.from(`${options?.password ?? ''}\0`, 'utf8');
    }
    return originalAuth.call(this, name, data, options);
  };

  const packetPrototype = modules.clientAuthenticationPacket.prototype;
  const originalWrite = packetPrototype.write;
  const pluginAuthFlag = modules.clientPluginAuthFlag;
  packetPrototype.write = function (this: any, writer: any) {
    originalWrite.call(this, writer);
    if (this.protocol41 && (this.clientFlags & pluginAuthFlag) !== 0) {
      writer.writeNullTerminatedString('mysql_native_password');
    }
  };

  const originalDefaultFlags = modules.connectionConfig.getDefaultFlags;
  modules.connectionConfig.getDefaultFlags = function (options?: unknown) {
    return originalDefaultFlags
      .call(this, options)
      .map((flag) => (flag === '-PLUGIN_AUTH' ? '+PLUGIN_AUTH' : flag));
  };
  holder[PROTOCOL_PATCHED] = true;
}

type GetConnection = (
  callback: (err: any, connection: PoolConnection) => void
) => void;

/**
 * Makes every new pool connection log in with a fresh token: the pool's
 * connection settings read the newest token, and taking a connection first
 * refreshes it when it is about to expire.
 *
 * In mysql@2.18 a pool opens a physical connection only inside
 * Pool#getConnection; pool.query, the queue drain after a release and
 * TypeORM's driver all call `this.getConnection`, so they reach this wrapper.
 * Connections are never reconnected in place: a broken one is dropped and the
 * next acquisition opens a new one with a fresh token.
 */
export function attachDbAuthTokenSource(
  pool: Pool,
  tokens: DbAuthTokenSource,
  onTokenError?: (error: unknown) => void
): void {
  const connectionConfig = (pool as any).config?.connectionConfig;
  if (!connectionConfig) {
    throw new Error('Unexpected mysql pool shape: no connection config');
  }
  Object.defineProperty(connectionConfig, 'password', {
    configurable: true,
    enumerable: true,
    get: () => tokens.current()
  });
  const originalGetConnection: GetConnection = (pool as any).getConnection.bind(
    pool
  );
  (pool as any).getConnection = (
    callback: (err: any, connection: PoolConnection) => void
  ) => {
    tokens.ensureFresh().then(
      () => originalGetConnection(callback),
      (err) => {
        onTokenError?.(err);
        callback(err, undefined as unknown as PoolConnection);
      }
    );
  };
}
