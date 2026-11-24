import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AreaManifest,
  RelayCheckResult,
  RelayItem
} from '@/rebuild/manifest.types';
import { checkSignedEvent } from '@/rebuild/sources/relay-event-check';
import { runChild } from '@/rebuild/stack/child-process';

/** One area's check as the run passes it to the checking child. */
export interface RelayCheckSpec {
  readonly area: string;
  readonly waves: readonly string[];
  readonly module: string;
  readonly exportName: string;
  readonly flags: Readonly<Record<string, string>>;
}

/** One area's check, loaded, with the waves it covers. */
export interface LoadedRelayCheck {
  readonly area: string;
  readonly waves: readonly string[];
  check(item: RelayItem): RelayCheckResult;
}

/** What the checks found in one recording. */
export interface RelayVerification {
  readonly events: number;
  /** Events that passed the signed-event check and their area's. */
  readonly verified: number;
  /** Events no area's check covers, counted by wave. */
  readonly unchecked: Readonly<Record<string, number>>;
  /** Events a check refused: tampered, or not what the backend accepts. */
  readonly failed: readonly { id: string; wave: string; reason: string }[];
}

/** Where the run passes the child its job: a JSON file. */
export const RELAY_CHECK_JOB_ENV = 'REBUILD_RELAY_CHECK_JOB';

export interface RelayCheckJob {
  readonly repoRoot: string;
  readonly specs: readonly RelayCheckSpec[];
  readonly dirs: readonly string[];
  /** Where the child writes one RelayVerification per directory. */
  readonly out: string;
}

/** Checks the recordings in `dirs`, one result each, in order. */
export type RecordingVerifier = (
  dirs: readonly string[]
) => Promise<RelayVerification[]>;

const moduleHere = (repoRoot: string, module: string) =>
  ['.ts', '.js'].some((ext) =>
    fs.existsSync(`${path.join(repoRoot, module)}${ext}`)
  );

/**
 * The relay checks the manifests declare, for the checking child. A
 * planned check whose module isn't in the tree is skipped and named; any
 * other missing module is an error.
 */
export function relayCheckSpecs(
  manifests: readonly AreaManifest[],
  repoRoot: string
): { specs: RelayCheckSpec[]; skipped: string[] } {
  const specs: RelayCheckSpec[] = [];
  const skipped: string[] = [];
  for (const manifest of manifests) {
    for (const check of manifest.relayChecks ?? []) {
      const name = `${manifest.area}: ${check.run.module}#${check.run.exportName}`;
      if (!moduleHere(repoRoot, check.run.module)) {
        if (check.origin === 'planned') {
          skipped.push(name);
          continue;
        }
        throw new Error(`The relay check ${name} is not in this tree`);
      }
      specs.push({
        area: manifest.area,
        waves: check.waves,
        module: check.run.module,
        exportName: check.run.exportName,
        flags: manifest.flags
      });
    }
  }
  return { specs, skipped };
}

/** Loads the checks' modules; only the checking child does this. */
export function loadRelayChecks(
  specs: readonly RelayCheckSpec[],
  repoRoot: string
): LoadedRelayCheck[] {
  return specs.map((spec) => {
    const fn = (
      require(path.join(repoRoot, spec.module)) as Record<string, unknown>
    )[spec.exportName];
    if (typeof fn !== 'function') {
      throw new Error(
        `The relay check ${spec.area}: ${spec.module}#${spec.exportName} is not a function`
      );
    }
    return {
      area: spec.area,
      waves: spec.waves,
      check: (item: RelayItem) =>
        (
          fn as (
            i: RelayItem,
            f: Readonly<Record<string, string>>
          ) => RelayCheckResult
        )(item, spec.flags)
    };
  });
}

/** The check whose wave prefix is the longest match for `wave`. */
export function checkFor(
  checks: readonly LoadedRelayCheck[],
  wave: string
): LoadedRelayCheck | null {
  let best: LoadedRelayCheck | null = null;
  let bestLength = -1;
  for (const check of checks) {
    for (const prefix of check.waves) {
      if (wave.startsWith(prefix) && prefix.length > bestLength) {
        best = check;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Runs each event through the signed-event check (id recomputed, the
 * device key's signature verified) and then its area's check.
 */
export function verifyRelayItems(
  items: readonly RelayItem[],
  checks: readonly LoadedRelayCheck[]
): RelayVerification {
  let verified = 0;
  const unchecked: Record<string, number> = {};
  const failed: { id: string; wave: string; reason: string }[] = [];
  for (const item of items) {
    const fail = (reason: string) =>
      failed.push({ id: item.event.id, wave: item.event.wave, reason });
    const signed = checkSignedEvent(item.event);
    if (!signed.ok) {
      fail(`signed event: ${signed.reason}`);
      continue;
    }
    const check = checkFor(checks, item.event.wave);
    if (!check) {
      unchecked[item.event.wave] = (unchecked[item.event.wave] ?? 0) + 1;
      continue;
    }
    let result: RelayCheckResult;
    try {
      result = check.check(item);
    } catch (error) {
      result = { ok: false, reason: `the check threw: ${String(error)}` };
    }
    if (result.ok) verified += 1;
    else fail(`${check.area}: ${result.reason}`);
  }
  return { events: items.length, verified, unchecked, failed };
}

/** A recording's events, as `events.jsonl` holds them. */
export function recordedItems(dir: string): RelayItem[] {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const stored = JSON.parse(line) as RelayItem;
      return { event: stored.event, grant: stored.grant ?? {} };
    });
}

/** Checks recordings in this process: for tests, with checks they made. */
export function inProcessVerifier(
  checks: readonly LoadedRelayCheck[]
): RecordingVerifier {
  return (dirs) =>
    Promise.resolve(
      dirs.map((dir) => verifyRelayItems(recordedItems(dir), checks))
    );
}

/**
 * Checks recordings in a child under the source guard: the areas' check
 * modules load there, not in the run's own process. `env` is the child's
 * environment with the guard's settings (its violations file, and no
 * allowed endpoint: the checks need no network).
 */
export function guardedVerifier(options: {
  readonly repoRoot: string;
  readonly specs: readonly RelayCheckSpec[];
  /** Where the job and its answer are written. */
  readonly workDir: string;
  readonly logFile: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): RecordingVerifier {
  return async (dirs) => {
    fs.mkdirSync(options.workDir, { recursive: true });
    const jobFile = path.join(options.workDir, 'relay-checks.job.json');
    const out = path.join(options.workDir, 'relay-checks.json');
    fs.rmSync(out, { force: true });
    const job: RelayCheckJob = {
      repoRoot: options.repoRoot,
      specs: options.specs,
      dirs,
      out
    };
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const result = await runChild({
      label: 'relay-checks',
      repoRoot: options.repoRoot,
      entry: path.join('src', 'rebuild', 'sources', 'relay-check.child.ts'),
      env: { ...options.env, [RELAY_CHECK_JOB_ENV]: jobFile },
      logFile: options.logFile,
      timeoutMs: options.timeoutMs
    });
    if (result.exitCode !== 0 || !fs.existsSync(out)) {
      throw new Error(
        `The relay checks did not finish; see ${options.logFile}`
      );
    }
    return JSON.parse(fs.readFileSync(out, 'utf8')) as RelayVerification[];
  };
}
