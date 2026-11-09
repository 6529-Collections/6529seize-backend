import { assertRunId } from './backfill-storage';
import { parseCursor, ScanCursor } from './scan-cursor';

export const BACKFILL_USAGE = `Usage (dry run unless --execute):
  scan             --environment <prod|staging|local> [--execute] [--limit N | --sample N]
                   [--concurrency N] [--page-size N] [--resume-after <phase>:<id>]
                   [--run-id ID] [--no-video-probe] [--report PATH]
  restore          --environment <env> --run-id ID [--key PUBLIC_KEY] [--execute] [--report PATH]
  invalidate       --environment <env> --run-id ID [--execute] [--report PATH]
  purge-originals  --environment <env> --run-id ID --older-than 7d
                   [--delete-noncurrent-public-versions] [--execute] [--report PATH]`;

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 2000;
const ENVIRONMENTS = ['prod', 'staging', 'local'];
const COMMANDS = ['scan', 'restore', 'invalidate', 'purge-originals'] as const;

export type BackfillCommand = (typeof COMMANDS)[number];

interface CommonOptions {
  readonly environment: string;
  readonly execute: boolean;
  readonly runId: string | null;
  readonly reportPath: string | null;
}

export interface ScanCliOptions extends CommonOptions {
  readonly command: 'scan';
  readonly limit: number | null;
  readonly sample: number | null;
  readonly concurrency: number;
  readonly pageSize: number;
  readonly resumeAfter: ScanCursor | null;
  readonly probeVideos: boolean;
}

export interface RestoreCliOptions extends CommonOptions {
  readonly command: 'restore';
  readonly runId: string;
  readonly key: string | null;
}

export interface InvalidateCliOptions extends CommonOptions {
  readonly command: 'invalidate';
  readonly runId: string;
}

export interface PurgeCliOptions extends CommonOptions {
  readonly command: 'purge-originals';
  readonly runId: string;
  readonly olderThanMillis: number;
  readonly deleteNoncurrentPublicVersions: boolean;
}

export type BackfillCliOptions =
  | ScanCliOptions
  | RestoreCliOptions
  | InvalidateCliOptions
  | PurgeCliOptions;

const FLAGS = new Set([
  '--execute',
  '--dry-run',
  '--no-video-probe',
  '--delete-noncurrent-public-versions'
]);
const VALUED = new Set([
  '--environment',
  '--limit',
  '--sample',
  '--concurrency',
  '--page-size',
  '--resume-after',
  '--run-id',
  '--report',
  '--key',
  '--older-than'
]);

type ParsedArgs = { flags: Set<string>; values: Map<string, string> };

function splitArgs(args: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    if (FLAGS.has(name) && inline === undefined) {
      flags.add(name);
    } else if (VALUED.has(name)) {
      const value = inline ?? args[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} needs a value`);
      }
      values.set(name, value);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return { flags, values };
}

function positiveInt(
  values: Map<string, string>,
  name: string,
  max = Number.MAX_SAFE_INTEGER
): number | null {
  const raw = values.get(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/** `7d` or `168h`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([dh])$/.exec(value.trim());
  if (!match)
    throw new Error(`Invalid duration "${value}"; use e.g. 7d or 168h`);
  const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
  return hours * 60 * 60 * 1000;
}

function common(parsed: ParsedArgs): CommonOptions {
  const { flags, values } = parsed;
  if (flags.has('--execute') && flags.has('--dry-run')) {
    throw new Error('Pass either --dry-run or --execute, not both');
  }
  const environment = values.get('--environment');
  if (!environment || !ENVIRONMENTS.includes(environment)) {
    throw new Error(`--environment must be one of ${ENVIRONMENTS.join(', ')}`);
  }
  const runId = values.get('--run-id');
  return {
    environment,
    execute: flags.has('--execute'),
    runId: runId === undefined ? null : assertRunId(runId),
    reportPath: values.get('--report') ?? null
  };
}

function requireRunId(options: CommonOptions): string {
  if (!options.runId) throw new Error('--run-id is required');
  return options.runId;
}

function scanOptions(parsed: ParsedArgs, base: CommonOptions): ScanCliOptions {
  const { flags, values } = parsed;
  const limit = positiveInt(values, '--limit');
  const sample = positiveInt(values, '--sample');
  const resume = values.get('--resume-after');
  if (limit !== null && sample !== null) {
    throw new Error('--limit and --sample cannot be combined');
  }
  if (sample !== null && resume !== undefined) {
    throw new Error('--sample draws from all media and cannot resume');
  }
  return {
    ...base,
    command: 'scan',
    limit,
    sample,
    concurrency:
      positiveInt(values, '--concurrency', MAX_CONCURRENCY) ??
      DEFAULT_CONCURRENCY,
    pageSize:
      positiveInt(values, '--page-size', MAX_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE,
    resumeAfter: resume === undefined ? null : parseCursor(resume),
    probeVideos: !flags.has('--no-video-probe') && !base.execute
  };
}

function rejectScanOnly(values: Map<string, string>, command: string) {
  for (const name of [
    '--limit',
    '--sample',
    '--concurrency',
    '--page-size',
    '--resume-after'
  ]) {
    if (values.has(name))
      throw new Error(`${name} does not apply to ${command}`);
  }
}

export function parseBackfillArgs(args: string[]): BackfillCliOptions {
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command as BackfillCommand)) {
    throw new Error(`Unknown command "${command ?? ''}"\n${BACKFILL_USAGE}`);
  }
  const parsed = splitArgs(rest);
  const base = common(parsed);
  if (command === 'scan') return scanOptions(parsed, base);
  rejectScanOnly(parsed.values, command);
  const runId = requireRunId(base);
  if (command === 'restore') {
    return { ...base, command, runId, key: parsed.values.get('--key') ?? null };
  }
  if (command === 'invalidate') return { ...base, command, runId };
  const olderThan = parsed.values.get('--older-than');
  if (!olderThan)
    throw new Error('--older-than is required, e.g. --older-than 7d');
  return {
    ...base,
    command: 'purge-originals',
    runId,
    olderThanMillis: parseDuration(olderThan),
    deleteNoncurrentPublicVersions: parsed.flags.has(
      '--delete-noncurrent-public-versions'
    )
  };
}
