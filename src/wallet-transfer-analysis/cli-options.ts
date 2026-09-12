import {
  BLOCKS_PER_BUCKET,
  MAX_ANALYSIS_BLOCK,
  MAX_BATCHES,
  MAX_SOURCE_ROWS,
  REPORT_QUERY_BUDGET_MS
} from './types';

const DEFAULT_MAX_ROWS = 10_000;

type BlockRange = {
  fromBlock: number;
  toBlock: number;
  maxRows: number;
};

export type WalletTransferAnalysisCommand =
  | { command: 'help' }
  | { command: 'status' }
  | ({ command: 'explain' | 'rebuild' } & BlockRange)
  | { command: 'update'; maxBatches: number; maxRows: number }
  | { command: 'report'; days: 30 | 90 | 365 | null; limit: number };

export class WalletTransferAnalysisUsageError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  status: [],
  explain: ['--from-block', '--to-block', '--max-rows'],
  update: ['--max-batches', '--max-rows'],
  rebuild: ['--from-block', '--to-block', '--max-rows'],
  report: ['--days', '--limit']
};

export const WALLET_TRANSFER_ANALYSIS_HELP = `Usage: 6529 run wallet-transfer-analysis -- <command> [options]

Commands:
  status
    Read source bounds and summary progress.
  explain --from-block N --to-block M [--max-rows N]
    Plain EXPLAIN of one bounded source read; does not execute the SELECT.
  update [--max-batches N] [--max-rows N]
    Reconcile the latest processed bucket and process bounded new buckets.
  rebuild --from-block N --to-block M [--max-rows N]
    Replace summaries for the fixed 1,000-block buckets intersecting this range.
  report [--days 30|90|365|all] [--limit N]
    Print ranked undeclared transfer relationships as deterministic JSON.

Limits:
  --max-batches defaults to 5, maximum 50 new buckets, plus one reconciliation.
  --max-rows defaults to 10,000, maximum 100,000 per bucket.
  Rebuild accepts at most 50 intersecting buckets; explain accepts one bucket.
  Report defaults to 90 days and 100 results; maximum 1,000 results.
  Report aggregation has a ${REPORT_QUERY_BUDGET_MS} ms database execution budget.
  Block bounds are inclusive. Rebuild only covers already processed history.
  Rebuild includes whole intersecting buckets and does not advance progress.

Invoking without a command, or with help or --help, prints this text without connecting to the DB.
The caller selects NODE_ENV and configures access using existing environment setup.
No command creates tables, enables a schedule, calls an LLM, or publishes results.
`;

function usageError(message: string): never {
  throw new WalletTransferAnalysisUsageError(message);
}

function parseFlags(args: string[], allowed: readonly string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag)) {
      usageError(
        'Unknown option for this command. Use --help for supported options.'
      );
    }
    if (flags.has(flag)) {
      usageError('Options must not be repeated.');
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError('Each option requires a value.');
    }
    flags.set(flag, value);
  }
  return flags;
}

function integerOption(
  flags: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
  fallback?: number
): number {
  const value = flags.get(name);
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (value === undefined || !/^\d+$/.test(value)) {
    return usageError(`${name} requires a whole decimal number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return usageError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseRange(
  flags: Map<string, string>,
  maxBuckets: number
): BlockRange {
  const fromBlock = integerOption(flags, '--from-block', 0, MAX_ANALYSIS_BLOCK);
  const toBlock = integerOption(flags, '--to-block', 0, MAX_ANALYSIS_BLOCK);
  if (toBlock < fromBlock) {
    usageError('--to-block must be greater than or equal to --from-block.');
  }
  const buckets =
    Math.floor(toBlock / BLOCKS_PER_BUCKET) -
    Math.floor(fromBlock / BLOCKS_PER_BUCKET) +
    1;
  if (buckets > maxBuckets) {
    usageError(
      `This command accepts at most ${maxBuckets} intersecting buckets.`
    );
  }
  return { fromBlock, toBlock, maxRows: parseMaxRows(flags) };
}

function parseMaxRows(flags: Map<string, string>): number {
  return integerOption(
    flags,
    '--max-rows',
    1,
    MAX_SOURCE_ROWS,
    DEFAULT_MAX_ROWS
  );
}

function parseDays(flags: Map<string, string>): 30 | 90 | 365 | null {
  const days = flags.get('--days') ?? '90';
  if (days === 'all') {
    return null;
  }
  if (days === '30' || days === '90' || days === '365') {
    return Number(days) as 30 | 90 | 365;
  }
  return usageError('--days must be 30, 90, 365, or all.');
}

export function parseWalletTransferAnalysisCommand(
  args: string[]
): WalletTransferAnalysisCommand {
  const command = args[0];
  if (
    !command ||
    (args.length === 1 && ['help', '--help', '-h'].includes(command))
  ) {
    return { command: 'help' };
  }
  const allowed = COMMAND_FLAGS[command];
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    return usageError('An explicit supported command is required. Use --help.');
  }
  if (args.length === 2 && ['--help', '-h'].includes(args[1])) {
    return { command: 'help' };
  }
  const flags = parseFlags(args.slice(1), allowed);
  switch (command) {
    case 'status':
      return { command };
    case 'explain':
      return { command, ...parseRange(flags, 1) };
    case 'rebuild':
      return { command, ...parseRange(flags, MAX_BATCHES) };
    case 'update':
      return {
        command,
        maxBatches: integerOption(flags, '--max-batches', 1, MAX_BATCHES, 5),
        maxRows: parseMaxRows(flags)
      };
    case 'report':
      return {
        command,
        days: parseDays(flags),
        limit: integerOption(flags, '--limit', 1, 1_000, 100)
      };
    default:
      return usageError(
        'An explicit supported command is required. Use --help.'
      );
  }
}
