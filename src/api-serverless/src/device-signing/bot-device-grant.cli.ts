import { createInterface } from 'node:readline';
import { Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  findAppDeviceGrantProblem,
  recoversToAppGrantWallet,
  serializeAppDeviceGrantMessage
} from './app-device-grant';
import {
  BOT_DEVICE_KEYS_SETTING,
  BOT_GRANT_ORIGIN,
  BotDeviceKeyEntry,
  botDeviceGrantTypedData,
  buildBotDeviceGrant,
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyOf,
  newEd25519Seed
} from './bot-device-grant';
import {
  DeviceGrantScope,
  formatGrantExpiryDateUtc,
  parseDeviceScopesParam
} from './device-grant-message';

const WALLET_KEY_ENV = 'BOT_WALLET_PRIVATE_KEY';
const FLAGS = ['--profile-id', '--wallet', '--scopes', '--origin'];

const USAGE = `6529 run waves:bot-device-grant -- --profile-id <bot profile id> [--wallet <0x address>] [--scopes post,edit,delete,react] [--origin ${BOT_GRANT_ORIGIN}]

Makes a new device key for one of 6529.io's bots and has the bot's wallet sign
its device grant (drops only, 180 days), offline. The wallet must be one of the
bot profile's wallets and have its own key (not a contract wallet).

With ${WALLET_KEY_ENV} set, that key signs here. Without it, the typed data is
printed for any wallet (eth_signTypedData_v4) and the signature is read from
standard input.

Prints the bot's ${BOT_DEVICE_KEYS_SETTING} entry on standard output: add it to
that JSON object in the lambdas secret. It holds the device key. Nothing is
written anywhere else. Run it again before the grant expires.
`;

export interface BotDeviceGrantCliIo {
  readonly env: Record<string, string | undefined>;
  /** Standard output: the entry only. */
  readonly out: (text: string) => void;
  /** Standard error: everything else. */
  readonly info: (text: string) => void;
  readonly readLine: () => Promise<string>;
  readonly now: () => Date;
  readonly newSeed: () => string;
}

interface CliOptions {
  readonly profileId: string;
  readonly wallet: string | null;
  readonly scopes: readonly DeviceGrantScope[];
  readonly origin: string;
}

function parseArgs(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !FLAGS.includes(flag) ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(flag)
    ) {
      throw new Error('Invalid arguments; use --help');
    }
    values.set(flag, value);
  }
  const profileId = values.get('--profile-id')?.trim();
  if (!profileId) {
    throw new Error('--profile-id is required; use --help');
  }
  const scopes = parseDeviceScopesParam(values.get('--scopes'));
  if (!scopes) {
    throw new Error(
      '--scopes is a comma separated list of post, edit, delete, react and vote that includes post'
    );
  }
  return {
    profileId,
    wallet: values.get('--wallet')?.toLowerCase() ?? null,
    scopes,
    origin: values.get('--origin') ?? BOT_GRANT_ORIGIN
  };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: BotDeviceGrantCliIo = defaultIo()
): Promise<void> {
  if (args.includes('--help')) {
    io.info(USAGE);
    return;
  }
  const options = parseArgs(args);
  const walletKey = io.env[WALLET_KEY_ENV];
  const signer = walletKey ? new Wallet(walletKey) : null;
  const wallet = options.wallet ?? signer?.address.toLowerCase() ?? '';
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    throw new Error(`Give --wallet <0x address>, or set ${WALLET_KEY_ENV}`);
  }
  if (signer && signer.address.toLowerCase() !== wallet) {
    throw new Error(`${WALLET_KEY_ENV} is not the key of --wallet`);
  }
  const issuedAt = io.now();
  const seed = io.newSeed();
  const grant = buildBotDeviceGrant({
    wallet,
    deviceKey: ed25519PublicKeyOf(ed25519PrivateKeyFromSeed(seed)),
    issuedAt,
    scopes: options.scopes,
    origin: options.origin
  });
  const problem = findAppDeviceGrantProblem(
    grant,
    Math.floor(issuedAt.getTime() / 1000)
  );
  if (problem) {
    throw new Error(`The grant is not valid: ${problem}`);
  }
  const message = buildAppDeviceGrantMessage(grant);
  let signature: string;
  if (signer) {
    signature = await signer.signTypedData(
      APP_DEVICE_GRANT_DOMAIN_V2,
      APP_DEVICE_GRANT_TYPES_V2,
      message
    );
  } else {
    io.info(
      `Sign this typed data with ${wallet} (eth_signTypedData_v4), then paste the signature and press Enter:\n${JSON.stringify(
        botDeviceGrantTypedData(message),
        null,
        2
      )}\n`
    );
    signature = (await io.readLine()).trim();
  }
  signature = signature.toLowerCase();
  if (!recoversToAppGrantWallet(message, signature)) {
    throw new Error(
      `The signature is not ${wallet}'s own; a bot grant needs a wallet with its own key`
    );
  }
  const entry: BotDeviceKeyEntry = {
    device_seed: seed,
    grant_message: serializeAppDeviceGrantMessage(message),
    grant_signature: signature
  };
  io.info(
    [
      `Bot profile ${options.profileId}`,
      `Wallet ${wallet}`,
      `Device key ${grant.device_key}`,
      `Grant ${computeAppDeviceGrantId(message)} (${grant.scopes.join(', ')})`,
      `Expires ${formatGrantExpiryDateUtc(grant.expires_at)}`,
      `Add the line below to ${BOT_DEVICE_KEYS_SETTING}:`,
      ''
    ].join('\n')
  );
  io.out(`${JSON.stringify({ [options.profileId]: entry })}\n`);
}

function defaultIo(): BotDeviceGrantCliIo {
  return {
    env: process.env,
    out: (text) => process.stdout.write(text),
    info: (text) => process.stderr.write(text),
    readLine: () =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin });
        lines.once('line', (line) => {
          lines.close();
          resolve(line);
        });
        lines.once('close', () => resolve(''));
      }),
    now: () => new Date(),
    newSeed: newEd25519Seed
  };
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'The device grant was not made'}\n`
    );
    process.exitCode = 1;
  });
}
