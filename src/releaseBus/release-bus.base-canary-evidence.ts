import { createHash } from 'node:crypto';

export const FRONTEND_GATE_BASE_FILES = [
  'bin/6529',
  'jest.config.js',
  'jest.setup.js',
  'package.json',
  'pnpm-lock.yaml'
] as const;

export const LEGACY_FRONTEND_GATE_TOOLING_FILES = [
  'scripts/release-bus-authorize-operation.sh',
  'scripts/release-bus-frontend-gate.sh',
  'scripts/release-bus-gate-evidence.cjs',
  'scripts/release-bus-install-dependencies.cjs',
  'scripts/release-bus-report-progress.mjs'
] as const;

export const FRONTEND_GATE_TOOLING_FILES = [
  'scripts/release-bus-authorize-operation.sh',
  'scripts/release-bus-build-profile.cjs',
  'scripts/release-bus-frontend-gate.sh',
  'scripts/release-bus-gate-evidence.cjs',
  'scripts/release-bus-install-dependencies.cjs',
  'scripts/release-bus-preflight-evidence.cjs',
  'scripts/release-bus-report-progress.mjs'
] as const;

export const FRONTEND_GATE_WORKFLOW =
  '.github/workflows/release-bus-base-canary.yml';
export const FRONTEND_PREFLIGHT_WORKFLOW =
  '.github/workflows/release-bus-preflight.yml';
export const FRONTEND_BASE_IDENTITY_WORKFLOW =
  '.github/workflows/release-bus-base-evidence-identity.yml';
export const BASE_EVIDENCE_CONTRACT_MARKER =
  'BASE_EVIDENCE_CONTRACT_VERSION = 2';

export type FrontendGateMode = 'legacy' | 'shadow' | 'sharded';

export type FrontendGateContract = {
  readonly schema_version: 2;
  readonly kind: 'frontend_base_evidence_contract';
  readonly repository: 'frontend';
  readonly environment: 'orchestration';
  readonly base_sha: string;
  readonly behavior_digest: string;
  readonly build_profile_digest: string;
  readonly gate_fingerprint: string;
  readonly workflow_sha: string;
  readonly workflow_digest: string;
  readonly node_version: '22';
  readonly package_manager: string;
  readonly gate_mode: FrontendGateMode;
  readonly shard_count: 1 | 2 | 4;
  readonly component_digests: Readonly<Record<string, string>>;
};

export type LegacyFrontendGateContract = Omit<
  FrontendGateContract,
  'schema_version' | 'kind' | 'behavior_digest' | 'build_profile_digest'
> & {
  readonly schema_version: 1;
};

export type AnyFrontendGateContract =
  | FrontendGateContract
  | LegacyFrontendGateContract;

export type BaseCanaryEvidenceRecord = {
  readonly id: string;
  readonly train_id: string;
  readonly revision: number;
  readonly status: string;
  readonly evidence_type: string;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
  readonly buildProfileDigest: string;
}): FrontendGateContract {
  assertSha(input.baseSha, 'frontend base SHA');
  assertSha(input.workflowSha, 'frontend workflow SHA');
  if (!/^[a-f0-9]{64}$/.test(input.buildProfileDigest))
    throw new Error('Frontend build-profile digest is invalid');
  const missingBaseFile = FRONTEND_GATE_BASE_FILES.find(
    (file) => typeof input.baseFileContents[file] !== 'string'
  );
  if (missingBaseFile)
    throw new Error(`Missing frontend gate contract file ${missingBaseFile}`);
  const workflowFiles = [
    FRONTEND_GATE_WORKFLOW,
    FRONTEND_PREFLIGHT_WORKFLOW,
    FRONTEND_BASE_IDENTITY_WORKFLOW,
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
  const behaviorDigest = sha256(
    JSON.stringify({
      schema_version: 2,
      kind: 'frontend_base_evidence_contract',
      repository: 'frontend',
      environment: 'orchestration',
      node_version: '22',
      package_manager: packageManager,
      gate_mode: input.gateMode,
      shard_count: input.shardCount,
      build_profile_digest: input.buildProfileDigest,
      component_digests: componentDigests
    })
  );
  const fingerprint = sha256(
    JSON.stringify({
      schema_version: 2,
      kind: 'frontend_base_evidence_contract',
      repository: 'frontend',
      environment: 'orchestration',
      base_sha: input.baseSha,
      workflow_sha: input.workflowSha,
      workflow_digest: workflowDigest,
      node_version: '22',
      package_manager: packageManager,
      gate_mode: input.gateMode,
      shard_count: input.shardCount,
      build_profile_digest: input.buildProfileDigest,
      component_digests: componentDigests
    })
  );
  return {
    schema_version: 2,
    kind: 'frontend_base_evidence_contract',
    repository: 'frontend',
    environment: 'orchestration',
    base_sha: input.baseSha,
    behavior_digest: behaviorDigest,
    build_profile_digest: input.buildProfileDigest,
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

export function buildLegacyFrontendGateContract(input: {
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly workflowFileContents: Readonly<Record<string, string>>;
  readonly baseFileContents: Readonly<Record<string, string>>;
  readonly gateMode: FrontendGateMode;
  readonly shardCount: 1 | 2 | 4;
}): LegacyFrontendGateContract {
  assertSha(input.baseSha, 'frontend base SHA');
  assertSha(input.workflowSha, 'frontend workflow SHA');
  const packageJson = parseObject(input.baseFileContents['package.json']);
  const packageManager = packageJson?.packageManager;
  if (typeof packageManager !== 'string' || packageManager.length === 0)
    throw new Error('Frontend packageManager contract is invalid');
  const workflowFiles = [
    FRONTEND_GATE_WORKFLOW,
    ...LEGACY_FRONTEND_GATE_TOOLING_FILES
  ] as const;
  for (const file of [...FRONTEND_GATE_BASE_FILES, ...workflowFiles]) {
    const source = FRONTEND_GATE_BASE_FILES.includes(
      file as (typeof FRONTEND_GATE_BASE_FILES)[number]
    )
      ? input.baseFileContents
      : input.workflowFileContents;
    if (typeof source[file] !== 'string')
      throw new Error(`Missing frontend gate contract file ${file}`);
  }
  const componentDigests = Object.fromEntries([
    ...FRONTEND_GATE_BASE_FILES.map(
      (file) => [file, sha256(input.baseFileContents[file])] as const
    ),
    ...workflowFiles.map(
      (file) => [file, sha256(input.workflowFileContents[file])] as const
    )
  ]);
  const workflowDigest = componentDigests[FRONTEND_GATE_WORKFLOW];
  const gateFingerprint = sha256(
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
    gate_fingerprint: gateFingerprint,
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
  expected: AnyFrontendGateContract
): string | null {
  const checks: ReadonlyArray<readonly [string, string]> = [
    ['schema_version', 'schema_version_mismatch'],
    ['repository', 'repository_mismatch'],
    ['base_sha', 'sha_mismatch'],
    ['environment', 'environment_mismatch'],
    ['gate_fingerprint', 'fingerprint_mismatch'],
    ['workflow_sha', 'workflow_sha_mismatch'],
    ['workflow_digest', 'workflow_digest_mismatch'],
    ['node_version', 'node_version_mismatch'],
    ['package_manager', 'package_manager_mismatch'],
    ['build_profile_digest', 'build_profile_digest_mismatch'],
    ['gate_mode', 'gate_mode_mismatch'],
    ['shard_count', 'shard_count_mismatch']
  ];
  for (const [key, reason] of checks)
    if (stored[key] !== (expected as unknown as Record<string, unknown>)[key])
      return reason;
  if (
    stableJson(stored.component_digests) !==
    stableJson(expected.component_digests)
  )
    return 'component_digests_mismatch';
  if (expected.schema_version === 2) {
    if (stored.kind !== expected.kind) return 'kind_mismatch';
    if (stored.behavior_digest !== expected.behavior_digest)
      return 'behavior_digest_mismatch';
  }
  return null;
}

function validateSummary(
  summary: Record<string, unknown>,
  contract: AnyFrontendGateContract,
  expectedSummaryDigest: string | null
): string | null {
  const checks: ReadonlyArray<readonly [string, string]> = [
    ['base_sha', 'sha_mismatch'],
    ['environment', 'environment_mismatch'],
    ['gate_fingerprint', 'fingerprint_mismatch'],
    ['workflow_sha', 'workflow_sha_mismatch'],
    ['workflow_digest', 'workflow_digest_mismatch'],
    ['node_version', 'node_version_mismatch'],
    ['package_manager', 'package_manager_mismatch'],
    ['build_profile_digest', 'build_profile_digest_mismatch'],
    ['gate_mode', 'gate_mode_mismatch'],
    ['shard_count', 'shard_count_mismatch']
  ];
  for (const [key, reason] of checks)
    if (summary[key] !== (contract as unknown as Record<string, unknown>)[key])
      return `summary_${reason}`;
  if (summary.fresh_or_reused !== 'fresh') return 'reused_source_not_allowed';
  if (summary.status !== undefined && summary.status !== 'SUCCEEDED')
    return 'summary_not_succeeded';
  if (
    contract.schema_version === 2 &&
    summary.behavior_digest !== contract.behavior_digest
  )
    return 'summary_behavior_digest_mismatch';
  const artifactDigest = digest(summary.summary_artifact_digest);
  if (!artifactDigest || artifactDigest !== expectedSummaryDigest)
    return 'artifact_digest_mismatch';
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
  if (totals.skipped_test_suites !== 0) return 'skipped_test_suite_counts';
  if (
    !Array.isArray(summary.missing_files) ||
    summary.missing_files.length > 0 ||
    !Array.isArray(summary.duplicate_files) ||
    summary.duplicate_files.length > 0 ||
    !Array.isArray(summary.unexpected_files) ||
    summary.unexpected_files.length > 0
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

const REQUIRED_GATE_STAGES = [
  'lint',
  'typecheck',
  'unit_tests',
  'build'
] as const;

export type BaseEvidenceOperationProof = {
  readonly operation_key: string;
  readonly operation_type: string;
  readonly status: string;
  readonly expected_sha: string;
  readonly environment: 'orchestration' | 'staging';
  readonly run_id: string;
  readonly run_url: string;
  readonly artifact_digest: string | null;
};

function validGateStages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== REQUIRED_GATE_STAGES.length)
    return false;
  return REQUIRED_GATE_STAGES.every(
    (name) =>
      value.filter((stage) => {
        const record = parseObject(stage);
        return record?.name === name && record.status === 'SUCCEEDED';
      }).length === 1
  );
}

function validOperationProof(
  value: unknown,
  expected: {
    readonly type: string;
    readonly sha: string;
    readonly environment: 'orchestration' | 'staging';
    readonly artifactRequired: boolean;
  }
): value is BaseEvidenceOperationProof & Record<string, unknown> {
  const operation = parseObject(value);
  if (
    !operation ||
    operation.operation_type !== expected.type ||
    operation.status !== 'SUCCEEDED' ||
    operation.expected_sha !== expected.sha ||
    operation.environment !== expected.environment ||
    typeof operation.operation_key !== 'string' ||
    operation.operation_key.length === 0 ||
    typeof operation.run_id !== 'string' ||
    !trustedRunUrl(operation.run_url) ||
    trustedRunId(operation.run_url) !== operation.run_id
  )
    return false;
  const artifactDigest = digest(operation.artifact_digest);
  return expected.artifactRequired ? artifactDigest !== null : true;
}

function validPromotedBuildCoverage(summary: Record<string, unknown>): boolean {
  if (
    summary.kind !== 'frontend_preflight_base_evidence_summary' ||
    summary.proof_origin !== 'fresh_preflight'
  )
    return false;
  const buildCoverage = parseObject(summary.build_coverage);
  const immutableArtifact = parseObject(summary.immutable_artifact);
  if (!immutableArtifact) return false;
  return (
    buildCoverage?.authoritative_profile === 'SUCCEEDED' &&
    buildCoverage.compilation_count === 1 &&
    buildCoverage.deployed_artifact_bound === true &&
    immutableArtifact.source_sha === summary.base_sha &&
    immutableArtifact.environment === 'staging' &&
    immutableArtifact.build_profile_digest === summary.build_profile_digest &&
    digest(immutableArtifact.package_digest) !== null &&
    digest(immutableArtifact.upload_digest) !== null &&
    typeof immutableArtifact.artifact_name === 'string' &&
    typeof immutableArtifact.run_id === 'string' &&
    Array.isArray(summary.build_environments) &&
    summary.build_environments.includes('staging')
  );
}

export type PromotedBaseEvidenceBuildResult =
  | {
      readonly promoted: true;
      readonly artifactDigest: string;
      readonly evidenceUri: string;
      readonly metadata: Record<string, unknown>;
    }
  | { readonly promoted: false; readonly reason: string };

export function buildPromotedBaseEvidence(input: {
  readonly sourceTrainId: string;
  readonly sourceTrainRevision: number;
  readonly finalSha: string;
  readonly stagingRefSha: string;
  readonly contract: AnyFrontendGateContract;
  readonly summary: Record<string, unknown>;
  readonly stages: unknown;
  readonly preflight: BaseEvidenceOperationProof;
  readonly deployment: BaseEvidenceOperationProof;
  readonly e2e: BaseEvidenceOperationProof;
  readonly now: number;
  readonly maxAgeMs: number;
}): PromotedBaseEvidenceBuildResult {
  if (
    input.contract.schema_version !== 2 ||
    input.contract.gate_mode !== 'sharded'
  )
    return { promoted: false, reason: 'unsupported_gate_contract' };
  if (
    input.finalSha !== input.contract.base_sha ||
    input.stagingRefSha !== input.finalSha
  )
    return { promoted: false, reason: 'staging_ref_sha_mismatch' };
  const summaryDigest = digest(input.summary.summary_artifact_digest);
  if (!summaryDigest)
    return { promoted: false, reason: 'artifact_digest_mismatch' };
  const summaryError = validateSummary(
    input.summary,
    input.contract,
    summaryDigest
  );
  if (summaryError) return { promoted: false, reason: summaryError };
  if (!validGateStages(input.stages))
    return { promoted: false, reason: 'incomplete_gate_stages' };
  if (!validPromotedBuildCoverage(input.summary))
    return { promoted: false, reason: 'incomplete_build_coverage' };
  if (
    !validOperationProof(input.preflight, {
      type: 'preflight-frontend',
      sha: input.finalSha,
      environment: 'orchestration',
      artifactRequired: true
    }) ||
    digest(input.preflight.artifact_digest) !== summaryDigest
  )
    return { promoted: false, reason: 'invalid_preflight_proof' };
  if (
    !validOperationProof(input.deployment, {
      type: 'deploy-frontend-staging',
      sha: input.finalSha,
      environment: 'staging',
      artifactRequired: true
    })
  )
    return { promoted: false, reason: 'invalid_deployment_proof' };
  const immutableArtifact = parseObject(input.summary.immutable_artifact);
  if (
    !immutableArtifact ||
    digest(immutableArtifact.package_digest) !==
      digest(input.deployment.artifact_digest) ||
    immutableArtifact.run_id !== input.preflight.run_id
  )
    return { promoted: false, reason: 'deployed_artifact_digest_mismatch' };
  if (
    !validOperationProof(input.e2e, {
      type: 'e2e-staging',
      sha: input.finalSha,
      environment: 'staging',
      artifactRequired: false
    })
  )
    return { promoted: false, reason: 'invalid_e2e_proof' };
  if (
    !Number.isSafeInteger(input.now) ||
    input.now <= 0 ||
    !Number.isSafeInteger(input.maxAgeMs) ||
    input.maxAgeMs <= 0
  )
    return { promoted: false, reason: 'invalid_evidence_time' };
  const proof = {
    schema_version: 1,
    anchor: 'fresh_preflight_deploy_e2e',
    final_sha: input.finalSha,
    staging_ref_sha: input.stagingRefSha,
    source_train_id: input.sourceTrainId,
    source_train_revision: input.sourceTrainRevision,
    preflight: { ...input.preflight, stages: input.stages },
    deployment: input.deployment,
    e2e: input.e2e
  };
  const createdAt = input.now;
  const expiresAt = input.now + input.maxAgeMs;
  const proofDigest = sha256(
    stableJson({
      contract: input.contract,
      summary: input.summary,
      proof,
      created_at: createdAt,
      expires_at: expiresAt
    })
  );
  return {
    promoted: true,
    artifactDigest: proofDigest,
    evidenceUri: input.preflight.run_url,
    metadata: {
      schema_version: 2,
      source_kind: 'staging_train_full_gate_preflight_deploy_e2e',
      anchored_full_proof: true,
      contract: input.contract,
      summary: input.summary,
      proof,
      proof_digest: proofDigest,
      source_run_id: input.preflight.run_id,
      source_train_id: input.sourceTrainId,
      created_at: createdAt,
      expires_at: expiresAt
    }
  };
}

function validatePromotedEvidence(
  row: BaseCanaryEvidenceRecord,
  metadata: Record<string, unknown>,
  contract: AnyFrontendGateContract
): { readonly summaryDigest: string; readonly stages: unknown } | string {
  if (
    contract.schema_version !== 2 ||
    metadata.source_kind !== 'staging_train_full_gate_preflight_deploy_e2e' ||
    metadata.anchored_full_proof !== true
  )
    return 'untrusted_promotion_source';
  const proof = parseObject(metadata.proof);
  const summary = parseObject(metadata.summary);
  if (!proof || !summary) return 'malformed_promotion_proof';
  if (
    proof.anchor !== 'fresh_preflight_deploy_e2e' ||
    proof.final_sha !== contract.base_sha ||
    proof.staging_ref_sha !== contract.base_sha ||
    proof.source_train_id !== row.train_id ||
    proof.source_train_revision !== row.revision
  )
    return 'promotion_provenance_mismatch';
  const preflight = parseObject(proof.preflight);
  if (
    !validOperationProof(preflight, {
      type: 'preflight-frontend',
      sha: contract.base_sha,
      environment: 'orchestration',
      artifactRequired: true
    }) ||
    !validOperationProof(proof.deployment, {
      type: 'deploy-frontend-staging',
      sha: contract.base_sha,
      environment: 'staging',
      artifactRequired: true
    }) ||
    !validOperationProof(proof.e2e, {
      type: 'e2e-staging',
      sha: contract.base_sha,
      environment: 'staging',
      artifactRequired: false
    })
  )
    return 'invalid_promoted_operation_proof';
  if (!validGateStages(preflight.stages)) return 'incomplete_gate_stages';
  if (!validPromotedBuildCoverage(summary)) return 'incomplete_build_coverage';
  const summaryDigest = digest(summary.summary_artifact_digest);
  if (
    !summaryDigest ||
    digest(preflight.artifact_digest) !== summaryDigest ||
    digest(metadata.proof_digest) !== digest(row.artifact_digest) ||
    sha256(
      stableJson({
        contract,
        summary,
        proof,
        created_at: metadata.created_at,
        expires_at: metadata.expires_at
      })
    ) !== digest(row.artifact_digest)
  )
    return 'promotion_digest_mismatch';
  return { summaryDigest, stages: preflight.stages };
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
  contract: AnyFrontendGateContract
): ClassifiedEvidenceRow {
  const metadata = parseObject(row.metadata_json);
  if (!metadata) return { kind: 'INVALID', reason: 'malformed_metadata' };
  if (row.evidence_type === 'BASE_EVIDENCE_PROMOTION_REJECTED') {
    return {
      kind: 'RELEVANT',
      row,
      metadata,
      createdAt: Number(metadata.created_at ?? row.created_at)
    };
  }
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
  readonly contract: AnyFrontendGateContract;
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
  if (row.source_sha !== input.contract.base_sha)
    return { decision: 'INVALIDATED', reason: 'source_sha_mismatch' };
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
  let summaryDigest: string | null;
  let stages: unknown;
  if (row.evidence_type === 'BASE_CANARY_COMPLETED') {
    if (
      metadata.source_kind !== 'fresh_base_canary' ||
      metadata.anchored_full_proof !== true ||
      summary.kind !== 'base_canary_summary'
    )
      return { decision: 'INVALIDATED', reason: 'untrusted_canary_source' };
    summaryDigest = digest(row.artifact_digest);
    stages = metadata.gate_stages;
  } else if (row.evidence_type === 'BASE_EVIDENCE_PROMOTED') {
    const promoted = validatePromotedEvidence(row, metadata, input.contract);
    if (typeof promoted === 'string')
      return { decision: 'INVALIDATED', reason: promoted };
    summaryDigest = promoted.summaryDigest;
    stages = promoted.stages;
  } else {
    return { decision: 'INVALIDATED', reason: 'unsupported_evidence_type' };
  }
  if (!validGateStages(stages))
    return { decision: 'INVALIDATED', reason: 'incomplete_gate_stages' };
  const invalidSummary = validateSummary(
    summary,
    input.contract,
    summaryDigest
  );
  if (invalidSummary)
    return { decision: 'INVALIDATED', reason: invalidSummary };
  return {
    decision: 'HIT',
    reason: 'reusable_success',
    evidence: row,
    metadata
  };
}
