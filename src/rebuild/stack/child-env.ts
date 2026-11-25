import * as fs from 'node:fs';
import * as path from 'node:path';

/** The only parent variables a child process inherits. */
const INHERITED = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'TERM',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'CI'
  ].map((name) => name.toUpperCase())
);

/** The node environment of every child; `.env.<this>` must not exist. */
const CHILD_NODE_ENV = 'local';

/**
 * Reasons the run must not start: a local env file the app would load (it
 * may hold real keys), or a Lambda marker that makes the app read secrets
 * from AWS.
 */
export function preflightProblems(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): string[] {
  const problems: string[] = [];
  const envFile = path.join(repoRoot, `.env.${CHILD_NODE_ENV}`);
  if (fs.existsSync(envFile)) {
    problems.push(
      `${envFile} exists; the app would load it into the run. Move it away first.`
    );
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    problems.push(
      'AWS_LAMBDA_FUNCTION_NAME is set; the app would load secrets from AWS.'
    );
  }
  return problems;
}

/** Copies only the inherited variables, whatever their case on this OS. */
export function inheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && INHERITED.has(name.toUpperCase())) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Variables an area's flags may never set: the run's database account, its
 * source URLs and guard settings, Ethereum and Alchemy endpoints, AWS, and
 * the settings that keep the app off AWS and Redis.
 */
const PROTECTED_FLAG =
  /^(?:REBUILD_|DB_|ALCHEMY_|AWS_)|^(?:ETHEREUM_RPC_URL|NODE_OPTIONS|NODE_ENV|JWT_SECRET|FORCE_AVOID_REDIS|FEATURE_DB_MIGRATE_DISABLED|TS_NODE_TRANSPILE_ONLY|CONSOLIDATION_FOUR_WALLET_ACTIVATION_AT)$/i;

/** The names in `flags` that an area's manifest may not set. */
export function protectedFlagNames(
  flags: Readonly<Record<string, string>>
): string[] {
  return Object.keys(flags).filter((name) => PROTECTED_FLAG.test(name));
}

export interface DbAccount {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/**
 * The environment of a process the run starts: the inherited basics, the
 * database account, settings that keep the app off AWS, Redis and every
 * credential, and `extra` (area flags, source URLs). `extra` may not change
 * any of the run's own settings or set an AWS variable.
 */
export function childEnv(args: {
  parent: NodeJS.ProcessEnv;
  home: string;
  db: DbAccount;
  jwtSecret: string;
  extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const noAws = path.join(args.home, 'no-aws-config');
  const own: Record<string, string> = {
    NODE_ENV: CHILD_NODE_ENV,
    DB_HOST: args.db.host,
    DB_PORT: String(args.db.port),
    DB_USER: args.db.user,
    DB_PASS: args.db.password,
    DB_NAME: args.db.database,
    DB_HOST_READ: args.db.host,
    DB_USER_READ: args.db.user,
    DB_PASS_READ: args.db.password,
    FORCE_AVOID_REDIS: 'true',
    FEATURE_DB_MIGRATE_DISABLED: 'true',
    JWT_SECRET: args.jwtSecret,
    // Required by the consolidation code; the same fixed date the tests use.
    CONSOLIDATION_FOUR_WALLET_ACTIVATION_AT: '2026-10-15T00:00:00Z',
    // No AWS credential can be found: no metadata service, no shared files.
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SHARED_CREDENTIALS_FILE: noAws,
    AWS_CONFIG_FILE: noAws,
    TS_NODE_TRANSPILE_ONLY: 'true'
  };
  const extra = args.extra ?? {};
  const refused = Object.keys(extra).filter(
    (name) => name in own || /^AWS_/i.test(name) || name === 'NODE_OPTIONS'
  );
  if (refused.length) {
    throw new Error(
      `A flag may not set the run's own variables: ${refused.join(', ')}`
    );
  }
  return { ...inheritedEnv(args.parent), ...extra, ...own };
}
