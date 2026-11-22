import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as Joi from 'joi';
import {
  createServiceKeys,
  grantServiceDevice,
  replaceDeviceSeed,
  revokeServiceGrant,
  ServiceKeysFile,
  SETUP_ENVIRONMENTS
} from './service-setup';

const USAGE = `signed-records:service-setup new-keys --env staging|production --out <file>
signed-records:service-setup grant --keys <file> --api <API address> [--handle <handle>] [--new-device-seed]
signed-records:service-setup revoke --keys <file> --api <API address> [--grant <grant id>]
signed-records:service-setup print-secrets --keys <file>

new-keys writes a new service wallet, device seed and provider key to <file>
(it never overwrites) and prints the public values. grant signs in as the
service wallet, makes its profile with --handle when it has none, registers a
180-day grant for the device key and adds the grant id to <file>. Run grant
again before the expiry to renew; add --new-device-seed to replace a device
seed that may have leaked. revoke revokes the file's grant (or --grant).
print-secrets prints the two config secrets exactly as the config takes
them, to copy into it; no other command prints a secret.
`;

const FLAGS: readonly string[] = ['--new-device-seed'];

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
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

function readKeysFile(path: string): ServiceKeysFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ServiceKeysFile;
}

/**
 * Writes the file whole or not at all, replacing any earlier version: it
 * holds the only copy of the secrets.
 */
function writeKeysFile(path: string, keys: ServiceKeysFile): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(keys, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx'
  });
  renameSync(temporary, path);
}

function printPublic(keys: ServiceKeysFile): void {
  process.stdout.write(
    `${JSON.stringify({ environment: keys.environment, ...keys.public }, null, 2)}\n`
  );
}

const fetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => fetch(url, init);

function newKeys(options: Record<string, string | boolean>): void {
  const { env, out } = validated(
    Joi.object<{ env: (typeof SETUP_ENVIRONMENTS)[number]; out: string }>({
      env: Joi.string()
        .valid(...SETUP_ENVIRONMENTS)
        .required(),
      out: Joi.string().required()
    }),
    options
  );
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const keys = createServiceKeys(env);
  writeKeysFile(out, keys);
  printPublic(keys);
}

async function grant(options: Record<string, string | boolean>): Promise<void> {
  const parsed = validated(
    Joi.object<{
      keys: string;
      api: string;
      handle?: string;
      'new-device-seed'?: boolean;
    }>({
      keys: Joi.string().required(),
      api: Joi.string().required(),
      handle: Joi.string().optional(),
      'new-device-seed': Joi.boolean().optional()
    }),
    options
  );
  const current = readKeysFile(parsed.keys);
  const granted = await grantServiceDevice({
    keys: parsed['new-device-seed'] ? replaceDeviceSeed(current) : current,
    api: parsed.api,
    handle: parsed.handle ?? null,
    fetchFn,
    nowMs: Date.now()
  });
  writeKeysFile(parsed.keys, granted);
  printPublic(granted);
}

async function revoke(
  options: Record<string, string | boolean>
): Promise<void> {
  const parsed = validated(
    Joi.object<{ keys: string; api: string; grant?: string }>({
      keys: Joi.string().required(),
      api: Joi.string().required(),
      grant: Joi.string()
        .pattern(/^0x[0-9a-f]{64}$/)
        .optional()
    }),
    options
  );
  const revoked = await revokeServiceGrant({
    keys: readKeysFile(parsed.keys),
    api: parsed.api,
    grantId: parsed.grant ?? null,
    fetchFn
  });
  process.stdout.write(`Revoked ${revoked}\n`);
}

/** The two config secrets as the config takes them (no JSON escaping). */
function printSecrets(options: Record<string, string | boolean>): void {
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

const COMMANDS: Record<
  string,
  (options: Record<string, string | boolean>) => Promise<void> | void
> = { 'new-keys': newKeys, grant, revoke, 'print-secrets': printSecrets };

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
