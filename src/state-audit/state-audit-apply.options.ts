import { StateAuditUsageError } from './state-audit.options';

/** Manifests older than this (by `generated_at`) are rejected as stale. */
export const DEFAULT_MAX_MANIFEST_AGE_HOURS = 168;
export const MAX_MANIFEST_AGE_HOURS_LIMIT = 24 * 365;

export interface StateAuditApplyRequest {
  manifestPath: string;
  /** Lowercase 64-hex SHA-256 the operator reviewed. */
  planDigest: string;
  /** Lowercase UUID v4 chosen by the operator for this job. */
  jobId: string;
  live: boolean;
  maxManifestAgeHours: number;
}

export type StateAuditApplyCommand =
  | { command: 'apply-help' }
  | { command: 'apply'; request: StateAuditApplyRequest };

const VALUE_FLAGS = [
  '--manifest',
  '--plan-digest',
  '--job-id',
  '--max-age-hours'
] as const;
const BOOLEAN_FLAGS = ['--live'] as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export const STATE_AUDIT_APPLY_HELP = `Usage: 6529 run state-audit -- apply --manifest <file> --plan-digest <sha256> --job-id <uuidv4> [--live] [--max-age-hours N]

Applies a reviewed state-audit manifest to the transfer ledger (transactions
table) and enqueues owners/activity reconciliation for every affected wallet
in the same database transaction as each correction.

Options:
  --manifest <file>        Manifest written by the read-only audit.
  --plan-digest <sha256>   The manifest's plan_digest as reviewed. It is
                           recomputed from the file and must match.
  --job-id <uuidv4>        Idempotency key. Rerunning with the same id resumes
                           a pending job; an applied job is a no-op.
  --live                   Write. Without it the command only validates and
                           prints the plan. Requires STATE_AUDIT_APPLY_ENABLED=true.
  --max-age-hours N        Reject manifests whose generated_at is older than N
                           hours (default ${DEFAULT_MAX_MANIFEST_AGE_HOURS}).

Exit codes: 0 planned, applied or already applied; 4 rejected (nothing
written); 1 a repair unit failed (job left pending or failed; see output);
2 usage error.

--help prints this text without connecting to the database or the RPC.
`;

function usageError(message: string): never {
  throw new StateAuditUsageError(message);
}

function parseApplyFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flags.has(flag)) {
      usageError(`${flag} must not be repeated.`);
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(flag)) {
      flags.set(flag, true);
      index += 1;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      usageError(
        `Unknown option ${flag}. Use apply --help for supported options.`
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError(`${flag} requires a value.`);
    }
    flags.set(flag, value);
    index += 2;
  }
  return flags;
}

function requiredString(
  flags: Map<string, string | true>,
  name: string
): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.length) {
    return usageError(`${name} is required.`);
  }
  return value;
}

function parseMaxAge(flags: Map<string, string | true>): number {
  const value = flags.get('--max-age-hours');
  if (value === undefined) {
    return DEFAULT_MAX_MANIFEST_AGE_HOURS;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return usageError('--max-age-hours requires a whole decimal number.');
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_MANIFEST_AGE_HOURS_LIMIT) {
    return usageError(
      `--max-age-hours must be between 1 and ${MAX_MANIFEST_AGE_HOURS_LIMIT}.`
    );
  }
  return parsed;
}

export function parseStateAuditApplyCommand(
  args: string[]
): StateAuditApplyCommand {
  if (
    args.length === 0 ||
    args.some((arg) => ['--help', '-h', 'help'].includes(arg))
  ) {
    return { command: 'apply-help' };
  }
  const flags = parseApplyFlags(args);
  const manifestPath = requiredString(flags, '--manifest');
  const planDigest = requiredString(flags, '--plan-digest');
  if (!SHA256_HEX.test(planDigest)) {
    usageError('--plan-digest must be a 64-character hex SHA-256.');
  }
  const jobId = requiredString(flags, '--job-id');
  if (!UUID_V4.test(jobId)) {
    usageError('--job-id must be a UUID v4.');
  }
  return {
    command: 'apply',
    request: {
      manifestPath,
      planDigest: planDigest.toLowerCase(),
      jobId: jobId.toLowerCase(),
      live: flags.get('--live') === true,
      maxManifestAgeHours: parseMaxAge(flags)
    }
  };
}
