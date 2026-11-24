import { WavesExportUsageError } from './waves-export.errors';
import { WAVES_EXPORT_STAGES, WavesExportStage } from './waves-export.service';

export { WavesExportUsageError };

export const WAVES_EXPORT_HELP = `Usage: 6529 run waves:export -- --out DIR --revision HEX
         (--freeze-at TIME | --rehearsal) [--stages LIST]
         [--waves LIST | --waves-file FILE] [--page-size N]
         [--concurrency N] [--both-metric] [--resume]
         [--allow-failed-waves] [--records-wave-id ID]
         [--replica-lag-checked-by WHO --replica-lag-check-note HOW]

Writes 6529.io's waves, the groups they use, decisions, entries, votes,
vote logs, results, wave REP, polls and every wave's drops into DIR/raw,
in the layout of the waves snapshot tooling's fetch stage (validator
repository, tools/legacy-snapshot). Its normalize and build stages then make
the Waves v1 file and the drop archives from it. Read-only.

Only waves that move to the chain are written. A wave stays on 6529.io, and
the export leaves it out with its decisions, entries, votes, wave REP, polls
and drops, when it is members-only, a direct message, the signed records
wave, or names a hidden or private group (src/waves-scope). Hidden and
private groups stay too. export.json counts what was left out, by reason.
The records wave is named by --records-wave-id or SIGNED_RECORDS_WAVE_ID;
without either, the export refuses.

It reads through DB_HOST, not DB_HOST_READ: point DB_HOST at the cluster's
reader endpoint, with DB_USER and DB_PASS for it. (With DB_IAM_AUTH=true and
all four DB_IAM_HOST, DB_IAM_USER, DB_IAM_HOST_READ and DB_IAM_USER_READ set,
it reads through DB_IAM_HOST instead.) It refuses a server that isn't
read-only. Run it five minutes or more after the waves freeze: it
refuses to start earlier, unless --rehearsal, because a write admitted just
before the freeze can still commit after it, once a lock wait ends. It also
refuses until every reader has caught up past that five-minute mark (its lag
plus the age of its row in information_schema.replica_host_status, plus
1.5 s), and names when to try again. A rehearsal reads and reports the same,
but never refuses on it. Each run's reading is kept in DIR/raw/export_runs.json
and export.json. Use a new, empty DIR for each freeze: it refuses a DIR whose
earlier runs were for another freeze, a rehearsal's included.

Options:
  --out DIR           where to write (DIR/raw; required)
  --revision HEX      the exporter's 40-hex git commit, such as
                      $(git rev-parse HEAD) (or EXPORTER_REVISION; required)
  --freeze-at TIME    the waves freeze T_w, as ISO 8601 UTC (such as
                      2026-11-26T00:00:00Z) or 13-digit Unix milliseconds
                      (or WAVES_FREEZE_AT)
  --rehearsal         a dry run at any time (freeze_ms null, no time check;
                      the replica lag is reported, never refused on)
  --stages LIST       comma separated, in order: ${WAVES_EXPORT_STAGES.join(',')}
                      (default all; a later stage reads what earlier ones wrote)
  --waves LIST        only these wave ids, comma separated (a rehearsal)
  --waves-file FILE   only the wave ids in FILE (JSON list or one a line)
  --page-size N       drops read at a time (default 500)
  --concurrency N     waves or decisions read at once (default 4)
  --records-wave-id ID
                      the signed records wave, which stays on 6529.io (or
                      SIGNED_RECORDS_WAVE_ID; both given must agree)
  --both-metric       count TDH plus xTDH as a clause the chain evaluates
                      (the snapshot tooling's --both-metric), so such groups
                      are not written as their members
  --resume            keep each wave's drops file an earlier run into this
                      DIR finished, and nothing else. After a stopped run,
                      rerun from the stage it stopped in, into the same DIR:
                      --stages <that stage and the later ones> --resume
  --allow-failed-waves
                      exit 0 even when some waves could not be read (they
                      are left out and listed in export.json); without it
                      the export exits 3
  --replica-lag-checked-by WHO
  --replica-lag-check-note HOW
                      for a person only, never a script, and only when the
                      export says it can't tell (an unknown lag or read-only
                      state, or a reader's row that stopped updating) and
                      says so again on a second try: who checked the largest
                      lag over all readers another way, and what they read,
                      its value and when. Both together, once that much lag
                      has passed since five minutes after the freeze. Never
                      over a lag the export can read; export.json records
                      both with what the export read
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
  /**
   * --replica-lag-checked-by and --replica-lag-check-note: the person who
   * checked the replica lag instead of the export, and how; null otherwise.
   */
  readonly replicaLagCheckedBy: ReplicaLagCheckedBy | null;
  /**
   * --records-wave-id: the signed records wave, which stays on 6529.io; null
   * to take SIGNED_RECORDS_WAVE_ID when the run starts.
   */
  readonly recordsWaveId: string | null;
}

/** Who checked the replica lag instead of the export, and how. */
export interface ReplicaLagCheckedBy {
  readonly person: string;
  readonly note: string;
}

export type WavesExportCliCommand =
  | WavesExportCommand
  | { readonly command: 'help' };

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
  let lagCheckedBy: string | null = null;
  let recordsWaveId: string | null = null;
  let lagCheckNote: string | null = null;
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
      case '--records-wave-id':
        recordsWaveId = value().trim();
        if (!recordsWaveId) {
          throw new WavesExportUsageError('--records-wave-id needs a wave id');
        }
        break;
      case '--replica-lag-checked-by':
        lagCheckedBy = value().trim();
        break;
      case '--replica-lag-check-note':
        lagCheckNote = value().trim();
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
  const lagCheckedByGiven = lagCheckedBy !== null || lagCheckNote !== null;
  if (rehearsal && lagCheckedByGiven) {
    throw new WavesExportUsageError(
      '--replica-lag-checked-by and --replica-lag-check-note are for a run after the freeze: a rehearsal only reports the lag'
    );
  }
  if (lagCheckedByGiven && (!lagCheckedBy || !lagCheckNote)) {
    throw new WavesExportUsageError(
      '--replica-lag-checked-by (who checked the lag) and --replica-lag-check-note (how) go together, neither empty'
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
    allowFailedWaves,
    replicaLagCheckedBy:
      lagCheckedBy && lagCheckNote
        ? { person: lagCheckedBy, note: lagCheckNote }
        : null,
    recordsWaveId
  };
}
