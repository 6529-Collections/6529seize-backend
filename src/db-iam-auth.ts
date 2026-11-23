import { Signer } from '@aws-sdk/rds-signer';
import type { ConnectionOptions } from 'mysql2';
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
 * The proxy asks the client to switch to mysql_clear_password and send the
 * token; mysql2 answers through the auth plugin below, which signs a token
 * when a new connection logs in. The token is sent in clear text, so IAM mode
 * always uses verified TLS.
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

type AuthPlugins = NonNullable<ConnectionOptions['authPlugins']>;

function refused(plugin: string): AuthPlugins[string] {
  return () => () => {
    throw new Error(`MySQL ${plugin} authentication is not allowed`);
  };
}

/**
 * The authentication plugins a pool or data source may answer with.
 *
 * mysqljs only ever answered mysql_native_password. mysql2 would also send
 * the password in clear text (mysql_clear_password) or encrypted with a key
 * the server supplies (sha256_password, caching_sha2_password) whenever a
 * server asked, so those stay refused. With a token source (IAM mode) the
 * proxy's mysql_clear_password request is answered with a token at most 10
 * minutes old, refreshed when a new connection logs in.
 */
export function dbAuthPlugins(
  tokens: DbAuthTokenSource | null,
  onTokenError?: (error: unknown) => void
): AuthPlugins {
  return {
    mysql_clear_password: tokens
      ? () => async () => {
          try {
            const token = await tokens.ensureFresh();
            return Buffer.from(`${token}\0`, 'utf8');
          } catch (error) {
            onTokenError?.(error);
            throw error;
          }
        }
      : refused('mysql_clear_password'),
    sha256_password: refused('sha256_password'),
    caching_sha2_password: refused('caching_sha2_password')
  };
}
