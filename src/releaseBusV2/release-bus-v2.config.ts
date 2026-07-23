import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2Lane,
  ReleaseBusV2Mode,
  ReleaseBusV2RegisterInput,
  ReleaseBusV2Repository
} from '@/releaseBusV2/release-bus-v2.types';

const MODES = new Set<ReleaseBusV2Mode>(['OFF', 'STAGING', 'PRODUCTION']);
const BETA_LANES = new Set<ReleaseBusV2BetaLane>(['STAGING', 'PRODUCTION']);
const BETA_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BETA_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const BETA_OPERATOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BETA_ENTRY_KEYS = [
  'branch_name',
  'candidate_id',
  'lanes',
  'operator',
  'repository',
  'test_id'
] as const;
const BETA_ENTRY_KEYS_WITH_INFRASTRUCTURE_INJECTION = [
  'branch_name',
  'candidate_id',
  'inject_infrastructure_failure_operation',
  'lanes',
  'operator',
  'repository',
  'test_id'
] as const;

function compareInvariant(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type ReleaseBusV2BetaLane = 'STAGING' | 'PRODUCTION';

export type ReleaseBusV2BetaInfrastructureFailureOperation =
  | 'PREPARE_ARTIFACT_BACKEND'
  | 'PREPARE_ARTIFACT_FRONTEND';

export type ReleaseBusV2BetaEntry = {
  readonly test_id: string;
  readonly candidate_id: string;
  readonly repository: ReleaseBusV2Repository;
  readonly branch_name: string;
  readonly operator: string;
  readonly lanes: readonly ReleaseBusV2BetaLane[];
  readonly inject_infrastructure_failure_operation?: ReleaseBusV2BetaInfrastructureFailureOperation;
};

export class ReleaseBusV2BetaConfigurationError extends Error {
  public constructor() {
    super('Release Bus v2 beta allowlist is invalid');
    this.name = 'ReleaseBusV2BetaConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function parseBetaEntry(value: unknown): ReleaseBusV2BetaEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort(compareInvariant);
  const hasInfrastructureInjection =
    JSON.stringify(keys) ===
    JSON.stringify(BETA_ENTRY_KEYS_WITH_INFRASTRUCTURE_INJECTION);
  if (
    (JSON.stringify(keys) !== JSON.stringify(BETA_ENTRY_KEYS) &&
      !hasInfrastructureInjection) ||
    typeof entry.test_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(entry.test_id) ||
    typeof entry.candidate_id !== 'string' ||
    !BETA_UUID_PATTERN.test(entry.candidate_id) ||
    !['frontend', 'backend'].includes(String(entry.repository)) ||
    typeof entry.branch_name !== 'string' ||
    !BETA_BRANCH_PATTERN.test(entry.branch_name) ||
    typeof entry.operator !== 'string' ||
    !BETA_OPERATOR_PATTERN.test(entry.operator) ||
    !Array.isArray(entry.lanes) ||
    entry.lanes.length === 0 ||
    entry.lanes.some(
      (lane) =>
        typeof lane !== 'string' ||
        !BETA_LANES.has(lane as ReleaseBusV2BetaLane)
    )
  ) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  const lanes = Array.from(new Set(entry.lanes as ReleaseBusV2BetaLane[])).sort(
    compareInvariant
  );
  if (lanes.length !== entry.lanes.length) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  const expectedInfrastructureOperation =
    entry.repository === 'backend'
      ? 'PREPARE_ARTIFACT_BACKEND'
      : 'PREPARE_ARTIFACT_FRONTEND';
  if (
    hasInfrastructureInjection &&
    (entry.inject_infrastructure_failure_operation !==
      expectedInfrastructureOperation ||
      !lanes.includes('STAGING'))
  ) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  return {
    test_id: entry.test_id,
    candidate_id: entry.candidate_id.toLowerCase(),
    repository: entry.repository as ReleaseBusV2Repository,
    branch_name: entry.branch_name,
    operator: entry.operator.toLowerCase(),
    lanes,
    ...(hasInfrastructureInjection
      ? {
          inject_infrastructure_failure_operation:
            entry.inject_infrastructure_failure_operation as ReleaseBusV2BetaInfrastructureFailureOperation
        }
      : {})
  };
}

/**
 * The global mode remains OFF during beta. A non-empty, valid allowlist is the
 * only mechanism that permits the reserved worker to touch an exact synthetic
 * candidate. Invalid configuration fails closed.
 */
export function getReleaseBusV2BetaAllowlist(): readonly ReleaseBusV2BetaEntry[] {
  const configured = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST?.trim();
  if (!configured) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  const entries = parsed.map(parseBetaEntry);
  if (
    new Set(entries.map(({ candidate_id }) => candidate_id)).size !==
    entries.length
  ) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  if (new Set(entries.map(({ test_id }) => test_id)).size !== 1) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  if (new Set(entries.map(({ operator }) => operator)).size !== 1) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  if (
    new Set(
      entries.map(
        ({ repository, branch_name }) => `${repository}:${branch_name}`
      )
    ).size !== entries.length
  ) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  if (
    entries.filter(
      ({ inject_infrastructure_failure_operation }) =>
        inject_infrastructure_failure_operation !== undefined
    ).length > 1
  ) {
    throw new ReleaseBusV2BetaConfigurationError();
  }
  return entries;
}

export function releaseBusV2BetaInfrastructureFailureInjection(
  allowlist: readonly ReleaseBusV2BetaEntry[],
  candidates: readonly ReleaseBusV2CandidateRecord[],
  lane: ReleaseBusV2Lane,
  operationType: string
): { readonly candidateId: string; readonly testId: string } | null {
  const entry = allowlist.find(
    ({ inject_infrastructure_failure_operation }) =>
      inject_infrastructure_failure_operation === operationType
  );
  if (
    lane !== 'STAGING' ||
    !entry ||
    !candidates.some(({ id }) => id.toLowerCase() === entry.candidate_id) ||
    candidates.some(
      (candidate) =>
        !releaseBusV2BetaAllowsCandidate(allowlist, candidate, lane)
    )
  ) {
    return null;
  }
  return { candidateId: entry.candidate_id, testId: entry.test_id };
}

export function releaseBusV2BetaAllowsLane(
  allowlist: readonly ReleaseBusV2BetaEntry[],
  lane: ReleaseBusV2Lane | ReleaseBusV2BetaLane
): boolean {
  const requiredLane = lane === 'STAGING' ? 'STAGING' : 'PRODUCTION';
  return allowlist.some((entry) => entry.lanes.includes(requiredLane));
}

/**
 * OFF permits exact operator beta entries in either lane. Once staging is
 * generally enabled, only the production lane may remain operator-only beta;
 * the allowlist must never narrow or enroll ordinary staging candidates.
 */
export function releaseBusV2BetaAllowsLaneInMode(
  mode: ReleaseBusV2Mode,
  allowlist: readonly ReleaseBusV2BetaEntry[],
  lane: ReleaseBusV2Lane | ReleaseBusV2BetaLane
): boolean {
  if (mode === 'OFF') return releaseBusV2BetaAllowsLane(allowlist, lane);
  return (
    mode === 'STAGING' &&
    lane === 'PRODUCTION' &&
    releaseBusV2BetaAllowsLane(allowlist, lane)
  );
}

export function releaseBusV2BetaAllowsRegistration(
  allowlist: readonly ReleaseBusV2BetaEntry[],
  input: ReleaseBusV2RegisterInput,
  actor: string
): boolean {
  if (!input.candidate_id) return false;
  return allowlist.some(
    (entry) =>
      entry.candidate_id === input.candidate_id?.toLowerCase() &&
      entry.repository === input.repository &&
      entry.branch_name === input.branch_name &&
      entry.operator === actor.toLowerCase() &&
      entry.lanes.includes('STAGING')
  );
}

export function releaseBusV2BetaAllowsCandidate(
  allowlist: readonly ReleaseBusV2BetaEntry[],
  candidate: ReleaseBusV2CandidateRecord,
  lane: ReleaseBusV2Lane | ReleaseBusV2BetaLane
): boolean {
  const requiredLane = lane === 'STAGING' ? 'STAGING' : 'PRODUCTION';
  return allowlist.some(
    (entry) =>
      entry.candidate_id === candidate.id.toLowerCase() &&
      entry.repository === candidate.repository &&
      entry.branch_name === candidate.branch_name &&
      entry.operator === candidate.requested_by.toLowerCase() &&
      entry.lanes.includes(requiredLane)
  );
}

export function getReleaseBusV2Mode(): ReleaseBusV2Mode {
  const configured = (process.env.RELEASE_BUS_V2_MODE ?? 'OFF').toUpperCase();
  return MODES.has(configured as ReleaseBusV2Mode)
    ? (configured as ReleaseBusV2Mode)
    : 'OFF';
}

export function releaseBusV2AllowsLane(
  mode: ReleaseBusV2Mode,
  lane: 'STAGING' | 'PRODUCTION'
): boolean {
  return mode === 'PRODUCTION' || (mode === 'STAGING' && lane === 'STAGING');
}

export const RELEASE_BUS_V2_LOCK_TTL_MS = 5 * 60 * 1000;
export const RELEASE_BUS_V2_MAX_CANDIDATES = 50;
