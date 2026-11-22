import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { MEMES_CONTRACT } from '@/constants';
import { AirdropTransfer } from '../engine/redemption';
import { ChainInputs } from './chain-inputs';
import { runParity } from './compare';
import { LegacySubscriptionsApi } from './legacy-api';
import { collectLegacyOutputs, LegacyOutputs } from './legacy-outputs';
import { InputMode, ParityRun, summaryLine } from './parity-report';
import { PublicApiClient } from './public-api-client';
import { candidateKeys, collectSnapshot, ParitySnapshot } from './snapshot';

/**
 * The subscriptions side-by-side check from public data (Plan B).
 *
 *   keys      list candidate keys from recent published lists
 *   snapshot  read each key's state before the build
 *   legacy    read what the legacy build, phases and redemptions produced
 *   compare   run the engine and diff it with the legacy outputs
 *
 * Makes only unauthenticated GETs, at most 2 a second (redirect hops
 * included): the public API, and the published list files on the file
 * gateway the API links to. Outputs name wallets, so they are written
 * outside the repository.
 *
 * `compare --mode gate` (the default) computes from inputs read before the
 * build; `--mode pinned` copies balances and run 1's airdrop addresses from
 * the legacy build lines and checks neither.
 */

const USAGE = `usage:
  keys     --api <base> [--recent-lists 12] [--keys-file <txt>] --out <json>
  snapshot --api <base> --card <id> --cutoff <iso> --keys <json> [--logs-days 30] --out <json>
  legacy   --api <base> --card <id> --build-date <yyyy-mm-dd> --build-at <iso> --snapshot <json> --out <json>
  compare  --snapshot <json> --legacy <json> --build-at <iso> [--run run1|run2] [--mode gate|pinned] [--chain <json>] [--transfers <json>] --out <json>
  --file-hosts <host,host> overrides the list-file hosts`;

type Args = Record<string, string | true>;

export function parseArgs(argv: readonly string[]): {
  command: string;
  args: Args;
} {
  const [command, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return { command: command ?? '', args };
}

function required(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`--${name} is required\n${USAGE}`);
  }
  return value;
}

function optional(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function timeArg(args: Args, name: string): number {
  const ms = Date.parse(required(args, name));
  if (!Number.isFinite(ms)) {
    throw new Error(`--${name} is not a time`);
  }
  return ms;
}

function intArg(args: Args, name: string, fallback?: number): number {
  const raw = optional(args, name);
  if (raw === undefined && fallback !== undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The nearest directory above `start` that holds a .git entry. */
function repositoryRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Refuses an output path inside the repository (outputs name wallets). */
export function assertOutsideRepository(
  path: string,
  start: string = __dirname
): void {
  const root = repositoryRoot(start);
  if (!root) {
    return;
  }
  const rel = relative(root, resolve(path));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Refusing to write inside the repository: ${path}`);
  }
}

function writeJson(path: string, value: unknown) {
  assertOutsideRepository(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function api(args: Args): LegacySubscriptionsApi {
  const fileHosts = optional(args, 'file-hosts');
  return new LegacySubscriptionsApi(
    new PublicApiClient({
      baseUrl: required(args, 'api'),
      fileHosts: fileHosts ? fileHosts.split(',') : undefined
    })
  );
}

function progress(label: string) {
  return (done: number, total: number) => {
    if (done % 25 === 0 || done === total) {
      process.stderr.write(`${label}: ${done}/${total}\n`);
    }
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function keysCommand(args: Args) {
  const extra = optional(args, 'keys-file');
  const keys = await candidateKeys(api(args), {
    contract: MEMES_CONTRACT,
    recentLists: intArg(args, 'recent-lists', 12),
    extraKeys: extra ? readFileSync(extra, 'utf8').split(/\s+/) : []
  });
  writeJson(required(args, 'out'), keys);
  process.stdout.write(`${keys.length} keys\n`);
}

async function snapshotCommand(args: Args) {
  const cutoffMs = timeArg(args, 'cutoff');
  const keys = readJson<string[]>(required(args, 'keys'));
  const snapshot = await collectSnapshot(api(args), {
    contract: MEMES_CONTRACT,
    tokenId: intArg(args, 'card'),
    cutoffMs,
    keys,
    logsSinceMs: cutoffMs - intArg(args, 'logs-days', 30) * DAY_MS,
    onProgress: progress('snapshot')
  });
  writeJson(required(args, 'out'), snapshot);
  process.stdout.write(`${snapshot.subscribers.length} keys read\n`);
}

async function legacyCommand(args: Args) {
  const snapshot = readJson<ParitySnapshot>(required(args, 'snapshot'));
  const legacy = await collectLegacyOutputs(api(args), {
    contract: MEMES_CONTRACT,
    tokenId: intArg(args, 'card'),
    buildDate: required(args, 'build-date'),
    buildAtMs: timeArg(args, 'build-at'),
    keys: snapshot.subscribers.map((s) => s.key),
    logsSinceMs: snapshot.collectedFromMs,
    onProgress: progress('legacy')
  });
  writeJson(required(args, 'out'), legacy);
  process.stdout.write(
    `list rows ${legacy.csv?.rows.length ?? 0}, redeemed ${legacy.redeemed.length}, airdrop mints ${legacy.airdropTransfers.length}\n`
  );
}

function compareCommand(args: Args) {
  const run = (optional(args, 'run') ?? 'run1') as ParityRun;
  if (run !== 'run1' && run !== 'run2') {
    throw new Error('--run is run1 or run2');
  }
  const mode = (optional(args, 'mode') ?? 'gate') as InputMode;
  if (mode !== 'gate' && mode !== 'pinned') {
    throw new Error('--mode is gate or pinned');
  }
  const chainPath = optional(args, 'chain');
  const transfersPath = optional(args, 'transfers');
  const reports = runParity({
    snapshot: readJson<ParitySnapshot>(required(args, 'snapshot')),
    legacy: readJson<LegacyOutputs>(required(args, 'legacy')),
    run,
    mode,
    buildAtMs: timeArg(args, 'build-at'),
    chain: chainPath ? readJson<ChainInputs>(chainPath) : undefined,
    transfers: transfersPath
      ? readJson<AirdropTransfer[]>(transfersPath)
      : undefined
  });
  writeJson(required(args, 'out'), reports);
  for (const report of reports) {
    process.stdout.write(`${summaryLine(report)}\n`);
  }
  return reports.every((r) => r.verdict === 'MATCH');
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, args } = parseArgs(argv);
  switch (command) {
    case 'keys':
      await keysCommand(args);
      return 0;
    case 'snapshot':
      await snapshotCommand(args);
      return 0;
    case 'legacy':
      await legacyCommand(args);
      return 0;
    case 'compare':
      return compareCommand(args) ? 0 : 2;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    });
}
