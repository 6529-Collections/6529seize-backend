import { createHash } from 'node:crypto';

export const FRONTEND_GATE_BASE_FILES = [
  'bin/6529',
  'jest.config.js',
  'jest.setup.js',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/release-bus-frontend-gate.sh',
  'scripts/release-bus-gate-evidence.cjs'
] as const;

export const FRONTEND_GATE_WORKFLOW =
  '.github/workflows/release-bus-base-canary.yml';

export type FrontendGateMode = 'legacy' | 'shadow' | 'sharded';

export type FrontendGateContract = {
  readonly schema_version: 1;
  readonly repository: 'frontend';
  readonly environment: 'staging';
  readonly base_sha: string;
  readonly gate_fingerprint: string;
  readonly workflow_sha: string;
  readonly workflow_digest: string;
  readonly node_version: '22';
  readonly package_manager: string;
  readonly gate_mode: FrontendGateMode;
  readonly shard_count: 1 | 2 | 4;
  readonly component_digests: Readonly<Record<string, string>>;
};

export type BaseCanaryEvidenceRecord = {
  readonly id: string;
  readonly train_id: string;
  readonly revision: number;
  readonly status: string;
  readonly source_sha: string | null;
  readonly artifact_digest: string | null;
  readonly evidence_uri: string | null;
  readonly metadata_json: unknown;
  readonly created_at: number | string;
};

export type BaseCanaryEvidenceDecision =
  | {
      readonly decision: 'HIT';
      readonly reason: 'reusable_success';
      readonly evidence: BaseCanaryEvidenceRecord;
      readonly metadata: Record<string, unknown>;
    }
  | {
      readonly decision: 'MISS' | 'INVALIDATED';
      readonly reason: string;
    };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSha(value: string, name: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`Invalid ${name}`);
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return parseObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function digest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^sha256:/, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function trustedRunUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^https:\/\/github\.com\/6529-Collections\/6529seize-frontend\/actions\/runs\/[0-9]+$/.test(
      value
    )
  );
}

export function buildFrontendGateContract(input: {
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly workflowContent: string;
  readonly baseFileContents: Readonly<Record<string, string>>;
  readonly gateMode: FrontendGateMode;
  readonly shardCount: 1 | 2 | 4;
}): FrontendGateContract {
  assertSha(input.baseSha, 'frontend base SHA');
  assertSha(input.workflowSha, 'frontend workflow SHA');
  const missing = FRONTEND_GATE_BASE_FILES.filter(
    (file) => typeof input.baseFileContents[file] !== 'string'
  );
  if (missing.length > 0)
    throw new Error(`Missing frontend gate contract file ${missing[0]}`);
  const packageJson = parseObject(input.baseFileContents['package.json']);
  const packageManager = packageJson?.packageManager;
  if (
    typeof packageManager !== 'string' ||
    packageManager.length < 1 ||
    packageManager.length > 128
  )
    throw new Error('Frontend packageManager contract is invalid');
  const componentDigests = Object.fromEntries(
    FRONTEND_GATE_BASE_FILES.map((file) => [
      file,
      sha256(input.baseFileContents[file])
    ])
  );
  const workflowDigest = sha256(input.workflowContent);
  const fingerprint = sha256(
    JSON.stringify({
      schema_version: 1,
      repository: 'frontend',
      environment: 'staging',
      base_sha: input.baseSha,
      workflow_sha: input.workflowSha,
      workflow_digest: workflowDigest,
      node_version: '22',
      package_manager: packageManager,
      gate_mode: input.gateMode,
      shard_count: input.shardCount,
      component_digests: componentDigests
    })
  );
  return {
    schema_version: 1,
    repository: 'frontend',
    environment: 'staging',
    base_sha: input.baseSha,
    gate_fingerprint: fingerprint,
    workflow_sha: input.workflowSha,
    workflow_digest: workflowDigest,
    node_version: '22',
    package_manager: packageManager,
    gate_mode: input.gateMode,
    shard_count: input.shardCount,
    component_digests: componentDigests
  };
}

function contractMismatchReason(
  stored: Record<string, unknown>,
  expected: FrontendGateContract
): string | null {
  const checks: ReadonlyArray<readonly [keyof FrontendGateContract, string]> = [
    ['repository', 'repository_mismatch'],
    ['base_sha', 'sha_mismatch'],
    ['environment', 'environment_mismatch'],
    ['gate_fingerprint', 'fingerprint_mismatch'],
    ['workflow_sha', 'workflow_sha_mismatch'],
    ['workflow_digest', 'workflow_digest_mismatch'],
    ['node_version', 'node_version_mismatch'],
    ['package_manager', 'package_manager_mismatch'],
    ['gate_mode', 'gate_mode_mismatch'],
    ['shard_count', 'shard_count_mismatch']
  ];
  for (const [key, reason] of checks)
    if (stored[key] !== expected[key]) return reason;
  return null;
}

function validateSummary(
  summary: Record<string, unknown>,
  contract: FrontendGateContract,
  record: BaseCanaryEvidenceRecord
): string | null {
  const checks: ReadonlyArray<
    readonly [keyof FrontendGateContract, string]
  > = [
    ['base_sha', 'sha_mismatch'],
    ['environment', 'environment_mismatch'],
    ['gate_fingerprint', 'fingerprint_mismatch'],
    ['workflow_sha', 'workflow_sha_mismatch'],
    ['workflow_digest', 'workflow_digest_mismatch'],
    ['node_version', 'node_version_mismatch'],
    ['package_manager', 'package_manager_mismatch'],
    ['shard_count', 'shard_count_mismatch']
  ];
  for (const [key, reason] of checks)
    if (summary[key] !== contract[key]) return `summary_${reason}`;
  if (summary.fresh_or_reused !== 'fresh') return 'reused_source_not_allowed';
  const artifactDigest = digest(summary.summary_artifact_digest);
  if (!artifactDigest || artifactDigest !== digest(record.artifact_digest))
    return 'artifact_digest_mismatch';
  if (!trustedRunUrl(record.evidence_uri)) return 'invalid_evidence_uri';
  const totals = parseObject(summary.totals);
  if (
    !totals ||
    totals.failed_test_suites !== 0 ||
    totals.failed_tests !== 0
  )
    return 'failed_test_counts';
  if (
    !Array.isArray(summary.missing_files) ||
    summary.missing_files.length > 0 ||
    !Array.isArray(summary.duplicate_files) ||
    summary.duplicate_files.length > 0
  )
    return 'manifest_count_mismatch';
  if (
    !Array.isArray(summary.shards) ||
    summary.shards.length !== contract.shard_count ||
    summary.shards.some((value) => {
      const shard = parseObject(value);
      return !shard || shard.status !== 'SUCCEEDED';
    })
  )
    return 'invalid_shard_summary';
  return null;
}

export function evaluateBaseCanaryEvidence(input: {
  readonly rows: readonly BaseCanaryEvidenceRecord[];
  readonly contract: FrontendGateContract;
  readonly now: number;
  readonly maxAgeMs: number;
}): BaseCanaryEvidenceDecision {
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0)
    return { decision: 'INVALIDATED', reason: 'invalid_max_age' };
  let mismatchReason = 'no_exact_sha_evidence';
  for (const row of input.rows) {
    const metadata = parseObject(row.metadata_json);
    if (!metadata)
      return { decision: 'INVALIDATED', reason: 'malformed_metadata' };
    const storedContract = parseObject(metadata.contract);
    if (!storedContract)
      return { decision: 'INVALIDATED', reason: 'malformed_contract' };
    const mismatch = contractMismatchReason(storedContract, input.contract);
    if (mismatch) {
      mismatchReason = mismatch;
      continue;
    }
    if (row.status !== 'SUCCEEDED')
      return { decision: 'INVALIDATED', reason: 'newer_failure' };
    const createdAt = Number(metadata.created_at ?? row.created_at);
    const storedExpiry = Number(metadata.expires_at);
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0)
      return { decision: 'INVALIDATED', reason: 'invalid_creation_time' };
    const effectiveExpiry = Math.min(
      createdAt + input.maxAgeMs,
      Number.isSafeInteger(storedExpiry) && storedExpiry > 0
        ? storedExpiry
        : Number.POSITIVE_INFINITY
    );
    if (input.now > effectiveExpiry)
      return { decision: 'INVALIDATED', reason: 'expired' };
    const summary = parseObject(metadata.summary);
    if (!summary)
      return { decision: 'INVALIDATED', reason: 'malformed_summary' };
    const invalidSummary = validateSummary(summary, input.contract, row);
    if (invalidSummary)
      return { decision: 'INVALIDATED', reason: invalidSummary };
    return {
      decision: 'HIT',
      reason: 'reusable_success',
      evidence: row,
      metadata
    };
  }
  return { decision: 'MISS', reason: mismatchReason };
}
