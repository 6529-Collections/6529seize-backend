import { readFileSync } from 'node:fs';

export interface MysqlSslOptions {
  readonly rejectUnauthorized: true;
  readonly ca?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * TLS settings shared by the TypeORM data source and the API connection
 * pools. TLS stays off unless DB_SSL is "true", so environments keep their
 * current behaviour until it is enabled explicitly.
 *
 * When enabled, the server certificate is always verified. Node's default
 * trust store covers ACM-issued endpoints such as RDS Proxy; set
 * DB_SSL_CA_FILE to a PEM bundle (for example the RDS global bundle) for
 * endpoints signed by the RDS certificate authorities.
 */
export function getMysqlSslOptions(
  env: Environment = process.env,
  readCaFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): MysqlSslOptions | undefined {
  if (env.DB_SSL?.trim().toLowerCase() !== 'true') {
    return undefined;
  }
  const caFile = env.DB_SSL_CA_FILE?.trim();
  if (!caFile) {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: true, ca: readCaFile(caFile) };
}

/** Spreads into connection options; adds nothing while TLS is off. */
export function mysqlSslConnectionOptions(env: Environment = process.env): {
  ssl?: MysqlSslOptions;
} {
  const ssl = getMysqlSslOptions(env);
  return ssl ? { ssl } : {};
}
