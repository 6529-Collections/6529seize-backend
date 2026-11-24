import { WAVES_EXPORT_STAGES, WavesExportStage } from './waves-export.service';

export const WAVES_EXPORT_HELP = `Usage: 6529 run waves:export -- --out DIR --revision HEX
         (--freeze-at TIME | --rehearsal) [--stages LIST]
         [--waves LIST | --waves-file FILE] [--page-size N]
         [--concurrency N] [--both-metric] [--resume]
         [--allow-failed-waves]

Writes 6529.io's waves, the groups they use, decisions, entries, votes,
vote logs, results, wave REP, polls and every wave's drops into DIR/raw,
in the layout of the waves snapshot tooling's fetch stage (validator
repository, tools/legacy-snapshot). Its normalize and build stages then make
the Waves v1 file and the drop archives from it. Members-only waves are
included; direct messages are not. Read-only. Run it against a read replica
after the waves freeze: it refuses to run until five minutes after the
freeze time it is given, unless --rehearsal. A request admitted just before
the freeze can commit after it, after a lock wait. Start it only once the
read replica has also caught up past that time.

Options:
  --out DIR           where to write (DIR/raw; required)
  --revision HEX      the exporter's 40-hex git commit, such as
                      $(git rev-parse HEAD) (or EXPORTER_REVISION; required)
  --freeze-at TIME    the waves freeze T_w (2026-11-25T00:00:00Z), as ISO
                      8601 UTC or 13-digit Unix milliseconds (or
                      WAVES_FREEZE_AT)
  --rehearsal         an export before the freeze (freeze_ms null, no check)
  --stages LIST       comma separated, in order: ${WAVES_EXPORT_STAGES.join(',')}
                      (default all; a later stage reads what earlier ones wrote)
  --waves LIST        only these wave ids, comma separated (a rehearsal)
  --waves-file FILE   only the wave ids in FILE (JSON list or one a line)
  --page-size N       drops read at a time (default 500)
  --concurrency N     waves or decisions read at once (default 4)
  --both-metric       count TDH plus xTDH as a clause the chain evaluates
                      (the snapshot tooling's --both-metric), so such groups
                      are not written as their members
  --resume            keep each wave's drops an earlier run of this export
                      finished (with --stages drops after a stopped run)
  --allow-failed-waves
                      exit 0 even when some waves could not be read (they
                      are left out and listed in export.json); without it
                      the export exits 3
  --help              this text
`;

export interface WavesExportCommand {
  readonly command: 'export';
  readonly out: string;
  readonly revision: string;
  /** null with --rehearsal. */
  readonly freezeMs: number | null;
  readonly rehearsal: boolean;
  readonly stages: WavesExportStage[];
  readonly waveIds: string[] | null;
  readonly wavesFile: string | null;
  readonly pageSize: number;
  readonly concurrency: number;
  readonly bothMetric: boolean;
  readonly resume: boolean;
  readonly allowFailedWaves: boolean;
}

export type WavesExportCliCommand =
  | WavesExportCommand
  | { readonly command: 'help' };

export class WavesExportUsageError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WavesExportUsageError';
  }
}

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/** ISO 8601 UTC, or Unix milliseconds (13 digits: seconds are refused). */
export function parseFreezeTime(raw: string): number {
  const value = raw.trim();
  if (/^\d{13}$/.test(value)) {
    return Number(value);
  }
  const millis = ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) {
    throw new WavesExportUsageError(
      `The freeze time must be ISO 8601 UTC or 13-digit Unix milliseconds, got "${raw}"`
    );
  }
  return millis;
}

export function parseStages(raw: string): WavesExportStage[] {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) {
    throw new WavesExportUsageError('--stages names no stage');
  }
  for (const name of names) {
    if (!(WAVES_EXPORT_STAGES as readonly string[]).includes(name)) {
      throw new WavesExportUsageError(
        `Unknown stage "${name}"; stages are ${WAVES_EXPORT_STAGES.join(', ')}`
      );
    }
  }
  // In the export's own order, whatever order they were given in.
  return WAVES_EXPORT_STAGES.filter((stage) => names.includes(stage));
}

export function parseWaveIds(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  let ids: unknown;
  try {
    ids = JSON.parse(trimmed);
  } catch {
    ids = trimmed.split(/[\s,]+/);
  }
  if (!Array.isArray(ids)) {
    throw new WavesExportUsageError(
      'The waves file must be a JSON list or ids separated by spaces or commas'
    );
  }
  return Array.from(
    new Set(
      ids
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
}

function positiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new WavesExportUsageError(`${name} must be a positive integer`);
  }
  return value;
}

export function parseWavesExportCommand(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): WavesExportCliCommand {
  let out: string | null = null;
  let revision: string | null = env.EXPORTER_REVISION?.trim() || null;
  let freezeAt: string | null = env.WAVES_FREEZE_AT?.trim() || null;
  let rehearsal = false;
  let stages: WavesExportStage[] = [...WAVES_EXPORT_STAGES];
  let waveIds: string[] | null = null;
  let wavesFile: string | null = null;
  let pageSize = 500;
  let concurrency = 4;
  let bothMetric = false;
  let resume = false;
  let allowFailedWaves = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new WavesExportUsageError(`${arg} needs a value`);
      }
      return next;
    };
    switch (arg) {
      case '--help':
      case '-h':
        return { command: 'help' };
      case '--out':
        out = value();
        break;
      case '--revision':
        revision = value();
        break;
      case '--freeze-at':
        freezeAt = value();
        break;
      case '--rehearsal':
        rehearsal = true;
        break;
      case '--stages':
        stages = parseStages(value());
        break;
      case '--waves':
        waveIds = parseWaveIds(value());
        break;
      case '--waves-file':
        wavesFile = value();
        break;
      case '--page-size':
        pageSize = positiveInt(arg, value());
        break;
      case '--concurrency':
        concurrency = positiveInt(arg, value());
        break;
      case '--both-metric':
        bothMetric = true;
        break;
      case '--resume':
        resume = true;
        break;
      case '--allow-failed-waves':
        allowFailedWaves = true;
        break;
      default:
        throw new WavesExportUsageError(`Unknown argument "${arg}"`);
    }
  }
  if (!out) {
    throw new WavesExportUsageError('--out is required');
  }
  if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new WavesExportUsageError(
      '--revision (or EXPORTER_REVISION) must be the 40-hex git commit of the exporter'
    );
  }
  if (waveIds && wavesFile) {
    throw new WavesExportUsageError('Give --waves or --waves-file, not both');
  }
  if (rehearsal && freezeAt && args.includes('--freeze-at')) {
    throw new WavesExportUsageError(
      'Give --freeze-at or --rehearsal, not both'
    );
  }
  if (!rehearsal && !freezeAt) {
    throw new WavesExportUsageError(
      '--freeze-at (or WAVES_FREEZE_AT) is required, or --rehearsal'
    );
  }
  return {
    command: 'export',
    out,
    revision: revision.toLowerCase(),
    freezeMs: rehearsal ? null : parseFreezeTime(freezeAt!),
    rehearsal,
    stages,
    waveIds,
    wavesFile,
    pageSize,
    concurrency,
    bothMetric,
    resume,
    allowFailedWaves
  };
}
