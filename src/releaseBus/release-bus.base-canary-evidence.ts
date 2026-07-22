import { createHash } from 'node:crypto';

export const FRONTEND_GATE_BASE_FILES = [
  'bin/6529',
  'jest.config.js',
  'jest.setup.js',
  'package.json',
  'pnpm-lock.yaml'
] as const;

export const FRONTEND_GATE_TOOLING_FILES = [
  'scripts/release-bus-frontend-gate.sh',
  'scripts/release-bus-gate-evidence.cjs',
  'scripts/release-bus-install-dependencies.cjs',
  'scripts/release-bus-report-progress.mjs'
] as const;

export const FRONTEND_GATE_WORKFLOW =
  '.github/workflows/release-bus-base-canary.yml';

export type FrontendGateMode = 'legacy' | 'shadow' | 'sharded';

export type FrontendGateContract = {
  readonly schema_version: 1;
  readonly repository: 'frontend';
  readonly environment: 'orchestration';
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
    /^https:\/\/github\.com\/6529-Collections\/6529seize-frontend\/actions\/runs\/\d+$/.test(
      value
    )
  );
}

function trustedRunId(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function isPositiveCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function buildFrontendGateContract(input: {
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly workflowFileContents: Readonly<Record<string, string>>;
  readonly baseFileContents: Readonly<Record<string, string>>;
  readonly gateMode: FrontendGateMode;
  readonly shardCount: 1 | 2 | 4;
}): FrontendGateContract {
  assertSha(input.baseSha, 'frontend base SHA');
  assertSha(input.workflowSha, 'frontend workflow SHA');
  const missingBaseFile = FRONTEND_GATE_BASE_FILES.find(
    (file) => typeof input.baseFileContents[file] !== 'string'
  );
  if (missingBaseFile)
    throw new Error(`Missing frontend gate contract file ${missingBaseFile}`);
  const workflowFiles = [
    FRONTEND_GATE_WORKFLOW,
    ...FRONTEND_GATE_TOOLING_FILES
  ] as const;
  const missingWorkflowFile = workflowFiles.find(
    (file) => typeof input.workflowFileContents[file] !== 'string'
  );
  if (missingWorkflowFile)
    throw new Error(
      `Missing frontend gate workflow file ${missingWorkflowFile}`
    );
  const packageJson = parseObject(input.baseFileContents['package.json']);
  const packageManager = packageJson?.packageManager;
  if (
    typeof packageManager !== 'string' ||
    packageManager.length < 1 ||
    packageManager.length > 128
  )
    throw new Error('Frontend packageManager contract is invalid');
  const componentDigests = Object.fromEntries([
    ...FRONTEND_GATE_BASE_FILES.map(
      (file) => [file, sha256(input.baseFileContents[file])] as const
    ),
    ...workflowFiles.map(
      (file) => [file, sha256(input.workflowFileContents[file])] as const
    )
  ]);
  const workflowDigest = componentDigests[FRONTEND_GATE_WORKFLOW];
  const fingerprint = sha256(
    JSON.stringify({
      schema_version: 1,
      repository: 'frontend',
      environment: 'orchestration',
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
    environment: 'orchestration',
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
  const checks: ReadonlyArray<readonly [keyof FrontendGateContract, string]> = [
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
  if (
    typeof record.source_sha !== 'string' ||
    record.source_sha !== contract.base_sha
  )
    return 'source_sha_mismatch';
  const totals = parseObject(summary.totals);
  if (
    !totals ||
    !isPositiveCount(totals.files) ||
    !isPositiveCount(totals.test_suites) ||
    !isPositiveCount(totals.tests) ||
    totals.failed_test_suites !== 0 ||
    totals.failed_tests !== 0
  )
    return 'failed_test_counts';
  if (totals.skipped_tests !== 0) return 'skipped_test_counts';
  if (
    !Array.isArray(summary.missing_files) ||
    summary.missing_files.length > 0 ||
    !Array.isArray(summary.duplicate_files) ||
    summary.duplicate_files.length > 0
  )
    return 'manifest_count_mismatch';
  if (!Array.isArray(summary.shards)) return 'invalid_shard_summary';
  const shardCoordinates = summary.shards.map((value) => {
    const shard = parseObject(value);
    if (
      shard?.status !== 'SUCCEEDED' ||
      shard.count !== contract.shard_count ||
      shard.failed_test_suites !== 0 ||
      shard.failed_tests !== 0 ||
      typeof shard.coordinate !== 'string'
    )
      return null;
    return `${shard.index}/${shard.count}` === shard.coordinate
      ? shard.coordinate
      : null;
  });
  const expectedCoordinates = Array.from(
    { length: contract.shard_count },
    (_, index) => `${index + 1}/${contract.shard_count}`
  );
  if (
    shardCoordinates.length !== expectedCoordinates.length ||
    JSON.stringify(
      [...shardCoordinates].sort((left, right) =>
        (left ?? '').localeCompare(right ?? '')
      )
    ) !== JSON.stringify(expectedCoordinates)
  )
    return 'invalid_shard_summary';
  return null;
}

type RelevantEvidence = {
  readonly row: BaseCanaryEvidenceRecord;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
};

type ClassifiedEvidenceRow =
  | { readonly kind: 'INVALID'; readonly reason: string }
  | { readonly kind: 'MISMATCH'; readonly reason: string }
  | ({ readonly kind: 'RELEVANT' } & RelevantEvidence);

function classifyEvidenceRow(
  row: BaseCanaryEvidenceRecord,
  contract: FrontendGateContract
): ClassifiedEvidenceRow {
  const metadata = parseObject(row.metadata_json);
  if (!metadata) return { kind: 'INVALID', reason: 'malformed_metadata' };
  const storedContract = parseObject(metadata.contract);
  if (!storedContract) return { kind: 'INVALID', reason: 'malformed_contract' };
  const mismatch = contractMismatchReason(storedContract, contract);
  if (mismatch) return { kind: 'MISMATCH', reason: mismatch };
  return {
    kind: 'RELEVANT',
    row,
    metadata,
    createdAt: Number(metadata.created_at ?? row.created_at)
  };
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
  const relevant: RelevantEvidence[] = [];
  for (const row of input.rows) {
    const classified = classifyEvidenceRow(row, input.contract);
    if (classified.kind === 'INVALID')
      return { decision: 'INVALIDATED', reason: classified.reason };
    if (classified.kind === 'MISMATCH') {
      mismatchReason = classified.reason;
      continue;
    }
    relevant.push(classified);
  }
  if (relevant.length === 0)
    return { decision: 'MISS', reason: mismatchReason };
  relevant.sort((left, right) => {
    const leftValid =
      Number.isSafeInteger(left.createdAt) && left.createdAt > 0;
    const rightValid =
      Number.isSafeInteger(right.createdAt) && right.createdAt > 0;
    if (!leftValid && rightValid) return -1;
    if (leftValid && !rightValid) return 1;
    return right.createdAt - left.createdAt;
  });
  const { row, metadata, createdAt } = relevant[0];
  if (row.status !== 'SUCCEEDED')
    return { decision: 'INVALIDATED', reason: 'newer_failure' };
  const storedExpiry = Number(metadata.expires_at);
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    createdAt > input.now + 5 * 60 * 1000
  )
    return { decision: 'INVALIDATED', reason: 'invalid_creation_time' };
  if (!Number.isSafeInteger(storedExpiry) || storedExpiry <= createdAt)
    return { decision: 'INVALIDATED', reason: 'invalid_expiry_time' };
  if (
    typeof metadata.source_run_id !== 'string' ||
    !trustedRunUrl(row.evidence_uri) ||
    trustedRunId(row.evidence_uri) !== metadata.source_run_id
  )
    return { decision: 'INVALIDATED', reason: 'run_provenance_mismatch' };
  const effectiveExpiry = Math.min(createdAt + input.maxAgeMs, storedExpiry);
  if (input.now > effectiveExpiry)
    return { decision: 'INVALIDATED', reason: 'expired' };
  const summary = parseObject(metadata.summary);
  if (!summary) return { decision: 'INVALIDATED', reason: 'malformed_summary' };
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
