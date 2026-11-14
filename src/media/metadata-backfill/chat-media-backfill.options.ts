import { assertRunId } from './backfill-storage';
import {
  BACKFILL_MAX_IMAGE_BYTES,
  ObjectSkipReason
} from './chat-media-object-processor';
import { BACKFILL_MAX_VIDEO_BYTES } from './chat-media-video-processor';
import { parseCursor, ScanCursor } from './scan-cursor';
import { DEFAULT_RETRY_SKIP_REASONS, parseSkipReasons } from './skipped-keys';

export const BACKFILL_USAGE = `Usage (dry run unless --execute):
  scan             --environment <prod|staging|local> [--execute] [--limit N | --sample N]
                   [--concurrency N] [--page-size N] [--resume-after <phase>:<id>]
                   [--run-id ID] [--no-video-probe] [--report PATH]
                   [--max-source-bytes N[KiB|MiB|GiB]] (default 256MiB)
                   [--keys-from-report PATH [--skip-reasons R1,R2]]
                   [--include-videos [--max-video-bytes N[KiB|MiB|GiB]]] (default 500MiB)
  restore          --environment <env> --run-id ID [--key PUBLIC_KEY] [--execute] [--report PATH]
  invalidate       --environment <env> --run-id ID [--execute] [--report PATH]
  purge-originals  --environment <env> --run-id ID --older-than 7d
                   [--delete-noncurrent-public-versions] [--execute] [--report PATH]`;

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 2000;
const MIN_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
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
  /** Larger objects are skipped as too_large. */
  readonly maxSourceBytes: number;
  /** A scan report whose skipped keys are the only ones processed. */
  readonly keysFromReport: string | null;
  /** Which of that report's skip reasons to take keys from. */
  readonly skipReasons: readonly ObjectSkipReason[] | null;
  /** Rewrite chat videos too (lossless MP4/QuickTime strip). */
  readonly includeVideos: boolean;
  /** Larger videos are skipped as too_large. */
  readonly maxVideoBytes: number;
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
  '--include-videos',
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
  '--older-than',
  '--max-source-bytes',
  '--keys-from-report',
  '--skip-reasons',
  '--max-video-bytes'
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

const BYTE_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3
};

/** Bytes, optionally in KiB, MiB or GiB: `268435456` or `256MiB`. */
export function parseByteSize(value: string): number {
  const match = /^(\d+)\s*([a-z]*)$/i.exec(value.trim());
  const unit = match ? BYTE_UNITS[match[2].toLowerCase()] : undefined;
  if (!match || unit === undefined) {
    throw new Error(`Invalid size "${value}"; use e.g. 268435456 or 256MiB`);
  }
  return Number(match[1]) * unit;
}

function byteLimit(
  values: Map<string, string>,
  name: string,
  fallback: number
): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const bytes = parseByteSize(raw);
  if (bytes < MIN_SOURCE_BYTES || bytes > MAX_SOURCE_BYTES) {
    throw new Error(`${name} must be between 1MiB and 1GiB`);
  }
  return bytes;
}

function videoOptions(
  parsed: ParsedArgs
): Pick<ScanCliOptions, 'includeVideos' | 'maxVideoBytes'> {
  const includeVideos = parsed.flags.has('--include-videos');
  if (!includeVideos && parsed.values.has('--max-video-bytes')) {
    throw new Error('--max-video-bytes needs --include-videos');
  }
  return {
    includeVideos,
    maxVideoBytes: byteLimit(
      parsed.values,
      '--max-video-bytes',
      BACKFILL_MAX_VIDEO_BYTES
    )
  };
}

function keyFilter(
  values: Map<string, string>,
  sample: number | null
): Pick<ScanCliOptions, 'keysFromReport' | 'skipReasons'> {
  const keysFromReport = values.get('--keys-from-report') ?? null;
  const reasons = values.get('--skip-reasons');
  if (keysFromReport === null) {
    if (reasons !== undefined) {
      throw new Error('--skip-reasons needs --keys-from-report');
    }
    return { keysFromReport, skipReasons: null };
  }
  if (sample !== null) {
    throw new Error('--sample draws from all media; drop --keys-from-report');
  }
  return {
    keysFromReport,
    skipReasons:
      reasons === undefined
        ? DEFAULT_RETRY_SKIP_REASONS
        : parseSkipReasons(reasons)
  };
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
    probeVideos: !flags.has('--no-video-probe') && !base.execute,
    maxSourceBytes: byteLimit(
      values,
      '--max-source-bytes',
      BACKFILL_MAX_IMAGE_BYTES
    ),
    ...keyFilter(values, sample),
    ...videoOptions(parsed)
  };
}

function rejectScanOnly(values: Map<string, string>, command: string) {
  for (const name of [
    '--limit',
    '--sample',
    '--concurrency',
    '--page-size',
    '--resume-after',
    '--max-source-bytes',
    '--keys-from-report',
    '--skip-reasons',
    '--max-video-bytes'
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
