import { ObjectSkipReason } from './chat-media-object-processor';

/**
 * Skip reasons a later run can change: the pixel check and the source limit
 * were raised, and containers are recognised from their bytes.
 */
export const DEFAULT_RETRY_SKIP_REASONS: readonly ObjectSkipReason[] = [
  ObjectSkipReason.VERIFICATION_FAILED,
  ObjectSkipReason.TOO_LARGE,
  ObjectSkipReason.UNPARSEABLE_CONTAINER
];

const SKIP_REASONS: readonly string[] = Object.values(ObjectSkipReason);

/** A comma-separated list of object skip reasons, for example `too_large`. */
export function parseSkipReasons(value: string): ObjectSkipReason[] {
  const reasons = value
    .split(',')
    .map((reason) => reason.trim())
    .filter(Boolean);
  if (!reasons.length) {
    throw new Error('--skip-reasons needs at least one reason');
  }
  for (const reason of reasons) {
    if (!SKIP_REASONS.includes(reason)) {
      throw new Error(
        `Unknown skip reason "${reason}"; use ${SKIP_REASONS.join(', ')}`
      );
    }
  }
  return reasons.filter(
    (reason, index) => reasons.indexOf(reason) === index
  ) as ObjectSkipReason[];
}

export interface SkippedKeys {
  readonly keys: ReadonlySet<string>;
  /** Keys listed per reason. */
  readonly listed: Readonly<Record<string, number>>;
  /** Keys a reason's list left out because it was full. */
  readonly truncated: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyList(entry: unknown, reason: string): string[] {
  const keys = isRecord(entry) ? entry.keys : undefined;
  if (
    !Array.isArray(keys) ||
    keys.some((key) => typeof key !== 'string' || !key)
  ) {
    throw new Error(`keys.skipped.${reason} in the report is not a key list`);
  }
  return keys as string[];
}

/**
 * Object keys an earlier scan report (its `keys.skipped` lists) skipped for
 * any of `reasons`. Only keys are taken from the report; every key is still
 * selected and classified from the database as in a full scan.
 */
export function skippedKeysFromReport(
  report: unknown,
  reasons: readonly string[]
): SkippedKeys {
  const skipped =
    isRecord(report) && isRecord(report.keys) ? report.keys.skipped : undefined;
  if (!isRecord(skipped)) {
    throw new Error('The report has no keys.skipped lists; pass a scan report');
  }
  const keys = new Set<string>();
  const listed: Record<string, number> = {};
  const truncated: Record<string, number> = {};
  for (const reason of reasons) {
    const entry = skipped[reason];
    if (entry === undefined) {
      listed[reason] = 0;
      continue;
    }
    const reasonKeys = keyList(entry, reason);
    reasonKeys.forEach((key) => keys.add(key));
    listed[reason] = reasonKeys.length;
    const left = isRecord(entry) ? entry.truncated : undefined;
    if (typeof left === 'number' && left > 0) truncated[reason] = left;
  }
  return { keys, listed, truncated };
}
