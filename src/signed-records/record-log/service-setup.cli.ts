import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as Joi from 'joi';
import {
  createServiceKeys,
  grantServiceDevice,
  listServiceGrants,
  parseKeysFile,
  revokeServiceGrants,
  ServiceKeysFile,
  SetupDeps,
  SETUP_ENVIRONMENTS
} from './service-setup';

const USAGE = `signed-records:service-setup new-keys --env staging|production --out <file>
signed-records:service-setup grant --keys <file> [--handle <handle>] [--new-device-seed]
signed-records:service-setup list --keys <file>
signed-records:service-setup revoke --keys <file> (--grant <grant id> | --all-for-device)
signed-records:service-setup print-secrets --keys <file>

new-keys writes a new service wallet, device seed and provider key for one
environment to <file> (never replacing a file) and prints the public values.
grant signs in to that environment's API as the service wallet, makes its
profile with --handle when it has none, registers a 180-day grant for the
device key and adds the grant id to <file>. Run grant again before the
expiry to renew. --new-device-seed revokes every active grant for the old
device key, then replaces the seed. list shows the service wallet's grants.
revoke revokes one grant, or every active grant for the file's device key.
print-secrets prints the two config secrets exactly as the config takes
them, to copy into it; no other command prints a secret. The keys file
must not be inside a git checkout.
`;

const FLAGS: readonly string[] = ['--new-device-seed', '--all-for-device'];

type Options = Record<string, string | boolean>;

function parseArgs(args: readonly string[]): Options {
  const parsed: Options = {};
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    if (FLAGS.indexOf(name) >= 0) {
      parsed[name.slice(2)] = true;
      continue;
    }
    const value = args[index + 1];
    if (
      !name.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error('Invalid arguments; use --help');
    }
    parsed[name.slice(2)] = value;
    index++;
  }
  return parsed;
}

function validated<T>(schema: Joi.ObjectSchema<T>, value: unknown): T {
  const result = schema.validate(value);
  if (result.error) throw new Error(result.error.message);
  return result.value;
}

/** Whether a path is inside a git work tree, where a key file must never be. */
export function isInGitWorkTree(path: string): boolean {
  let dir = dirname(resolve(path));
  for (;;) {
    if (fs.existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function assertOutsideGit(path: string): void {
  if (isInGitWorkTree(path)) {
    throw new Error(
      'The keys file must not be inside a git checkout: use a path on the USB stick'
    );
  }
}

function readKeysFile(path: string): ServiceKeysFile {
  assertOutsideGit(path);
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
  return parseKeysFile(text);
}

const contentOf = (keys: ServiceKeysFile) =>
  `${JSON.stringify(keys, null, 2)}\n`;

/** Makes a rename durable where the system allows syncing a folder. */
function syncFolderOf(path: string): void {
  try {
    const fd = fs.openSync(dirname(resolve(path)), 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not every system can sync a folder; the file itself is synced.
  }
}

function writeAndSync(fd: number, keys: ServiceKeysFile): void {
  fs.writeSync(fd, contentOf(keys));
  fs.fsyncSync(fd);
}

/** Creates the file; the exclusive flag refuses an existing one, with no race. */
function createKeysFile(path: string, keys: ServiceKeysFile): void {
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? `${path} already exists`
        : `Cannot create ${path}`
    );
  }
  try {
    writeAndSync(fd, keys);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(path);
    throw error;
  }
  fs.closeSync(fd);
  syncFolderOf(path);
}

/**
 * A replacement for the keys file, opened before any network call so an
 * unwritable folder fails first. commit writes, syncs and renames it over
 * the file in one step; discard removes it.
 */
function openReplacement(path: string) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
  } catch {
    throw new Error(`Cannot write next to ${path}`);
  }
  const close = () => {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
  };
  const remove = () => {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already gone.
    }
  };
  // Ctrl-C or a kill while the network step runs leaves no temporary file.
  const onSignal = (signal: NodeJS.Signals) => {
    close();
    remove();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const release = () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  return {
    commit(keys: ServiceKeysFile): void {
      if (fd === null) throw new Error('The replacement is closed');
      writeAndSync(fd, keys);
      close();
      fs.renameSync(temporary, path);
      release();
      syncFolderOf(path);
    },
    discard(): void {
      release();
      close();
      remove();
    }
  };
}

/** Runs a network step whose result rewrites the keys file. */
async function updateKeysFile<T extends { keys: ServiceKeysFile }>(
  path: string,
  step: () => Promise<T>,
  afterNetwork: string
): Promise<T> {
  const replacement = openReplacement(path);
  let result: T;
  try {
    result = await step();
  } catch (error) {
    replacement.discard();
    throw error;
  }
  try {
    replacement.commit(result.keys);
  } catch {
    replacement.discard();
    throw new Error(
      `${afterNetwork}, but ${path} could not be updated. Run the command again.`
    );
  }
  return result;
}

function printPublic(keys: ServiceKeysFile): void {
  process.stdout.write(
    `${JSON.stringify({ environment: keys.environment, ...keys.public }, null, 2)}\n`
  );
}

function depsNow(): SetupDeps {
  return {
    fetchFn: (url, init) => fetch(url, init),
    nowMs: Date.now(),
    warn: (text) => process.stderr.write(`${text}\n`)
  };
}

function newKeys(options: Options): void {
  const { env, out } = validated(
    Joi.object<{ env: (typeof SETUP_ENVIRONMENTS)[number]; out: string }>({
      env: Joi.string()
        .valid(...SETUP_ENVIRONMENTS)
        .required(),
      out: Joi.string().required()
    }),
    options
  );
  assertOutsideGit(out);
  const keys = createServiceKeys(env);
  createKeysFile(out, keys);
  printPublic(keys);
}

async function grant(options: Options): Promise<void> {
  const parsed = validated(
    Joi.object<{
      keys: string;
      handle?: string;
      'new-device-seed'?: boolean;
    }>({
      keys: Joi.string().required(),
      handle: Joi.string().optional(),
      'new-device-seed': Joi.boolean().optional()
    }),
    options
  );
  const current = readKeysFile(parsed.keys);
  const { keys } = await updateKeysFile(
    parsed.keys,
    async () => ({
      keys: await grantServiceDevice(
        {
          keys: current,
          handle: parsed.handle ?? null,
          newDeviceSeed: parsed['new-device-seed'] === true
        },
        depsNow()
      )
    }),
    'The grant is registered'
  );
  printPublic(keys);
}

async function list(options: Options): Promise<void> {
  const { keys: path } = validated(
    Joi.object<{ keys: string }>({ keys: Joi.string().required() }),
    options
  );
  const keys = readKeysFile(path);
  const deps = depsNow();
  const grants = await listServiceGrants(keys, deps);
  const when = (ms: number) => new Date(ms).toISOString();
  for (const grant of grants) {
    const state =
      grant.revoked_at !== null
        ? `revoked ${when(grant.revoked_at)}`
        : grant.expires_at <= deps.nowMs
          ? 'expired'
          : 'active';
    const key =
      grant.device_key === keys.public.device_key
        ? "this file's device key"
        : 'another device key';
    process.stdout.write(
      `${grant.id}  ${key}  expires ${when(grant.expires_at)}  ${state}\n`
    );
  }
  if (grants.length === 0) process.stdout.write('No grants\n');
}

async function revoke(options: Options): Promise<void> {
  const parsed = validated(
    Joi.object<{ keys: string; grant?: string; 'all-for-device'?: boolean }>({
      keys: Joi.string().required(),
      grant: Joi.string()
        .pattern(/^0x[0-9a-f]{64}$/)
        .optional(),
      'all-for-device': Joi.boolean().optional()
    }).xor('grant', 'all-for-device'),
    options
  );
  const current = readKeysFile(parsed.keys);
  const { revoked } = await updateKeysFile(
    parsed.keys,
    () =>
      revokeServiceGrants(
        {
          keys: current,
          grantId: parsed.grant ?? null,
          allForDevice: parsed['all-for-device'] === true
        },
        depsNow()
      ),
    'The grants are revoked'
  );
  process.stdout.write(
    revoked.length === 0
      ? 'No active grant to revoke\n'
      : revoked.map((id) => `Revoked ${id}\n`).join('')
  );
}

/** The two config secrets as the config takes them (no JSON escaping). */
function printSecrets(options: Options): void {
  const { keys: path } = validated(
    Joi.object<{ keys: string }>({ keys: Joi.string().required() }),
    options
  );
  const { secret } = readKeysFile(path);
  process.stdout.write(
    [
      'SIGNED_RECORDS_SERVICE_DEVICE_SEED',
      secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED,
      '',
      'SIGNED_RECORDS_PROVIDER_KEYS',
      secret.SIGNED_RECORDS_PROVIDER_KEYS,
      ''
    ].join('\n')
  );
}

const COMMANDS: Record<string, (options: Options) => Promise<void> | void> = {
  'new-keys': newKeys,
  grant,
  list,
  revoke,
  'print-secrets': printSecrets
};

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === undefined || args.indexOf('--help') >= 0) {
    process.stdout.write(USAGE);
    return;
  }
  const run = Object.prototype.hasOwnProperty.call(COMMANDS, command)
    ? COMMANDS[command]
    : null;
  if (!run) throw new Error('Unknown command; use --help');
  await run(parseArgs(args));
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Setup failed'}\n`
    );
    process.exitCode = 1;
  });
