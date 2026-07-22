import {
  buildPromotedBaseEvidence,
  buildFrontendGateContract,
  evaluateBaseCanaryEvidence,
  FRONTEND_BASE_IDENTITY_WORKFLOW,
  FRONTEND_GATE_BASE_FILES,
  FRONTEND_GATE_TOOLING_FILES,
  FRONTEND_GATE_WORKFLOW,
  FRONTEND_PREFLIGHT_WORKFLOW,
  type BaseCanaryEvidenceRecord,
  type FrontendGateContract
} from '@/releaseBus/release-bus.base-canary-evidence';

const BASE_SHA = 'a'.repeat(40);
const WORKFLOW_SHA = 'b'.repeat(40);
const ARTIFACT_DIGEST = 'c'.repeat(64);
const BUILD_PROFILE_DIGEST = 'e'.repeat(64);
const DEPLOYMENT_DIGEST = 'd'.repeat(64);

function contents(suffix = ''): Record<string, string> {
  return Object.fromEntries(
    FRONTEND_GATE_BASE_FILES.map((file) => [
      file,
      file === 'package.json'
        ? JSON.stringify({ packageManager: `pnpm@10.14.0${suffix}` })
        : `${file}:${suffix}`
    ])
  );
}

function workflowContents(suffix = ''): Record<string, string> {
  return Object.fromEntries(
    [
      FRONTEND_GATE_WORKFLOW,
      FRONTEND_PREFLIGHT_WORKFLOW,
      FRONTEND_BASE_IDENTITY_WORKFLOW,
      ...FRONTEND_GATE_TOOLING_FILES
    ].map((file) => [file, `${file}:${suffix}`])
  );
}

function contract(
  overrides: Partial<Parameters<typeof buildFrontendGateContract>[0]> = {}
): FrontendGateContract {
  return buildFrontendGateContract({
    baseSha: BASE_SHA,
    workflowSha: WORKFLOW_SHA,
    workflowFileContents: workflowContents(),
    baseFileContents: contents(),
    gateMode: 'sharded',
    shardCount: 4,
    buildProfileDigest: BUILD_PROFILE_DIGEST,
    ...overrides
  });
}

function summary(value: FrontendGateContract): Record<string, unknown> {
  return {
    kind: 'base_canary_summary',
    status: 'SUCCEEDED',
    base_sha: value.base_sha,
    environment: value.environment,
    gate_fingerprint: value.gate_fingerprint,
    behavior_digest: value.behavior_digest,
    build_profile_digest: value.build_profile_digest,
    workflow_sha: value.workflow_sha,
    workflow_digest: value.workflow_digest,
    node_version: value.node_version,
    package_manager: value.package_manager,
    gate_mode: value.gate_mode,
    shard_count: value.shard_count,
    summary_artifact_name: 'release-bus-base-canary-summary-123',
    summary_artifact_digest: ARTIFACT_DIGEST,
    phase_durations_ms: {
      lint: 1,
      typecheck: 1,
      unit_tests: 1,
      build: 1,
      total: 1
    },
    totals: {
      files: 4,
      test_suites: 4,
      tests: 4,
      failed_test_suites: 0,
      failed_tests: 0,
      skipped_tests: 0,
      skipped_test_suites: 0
    },
    fresh_or_reused: 'fresh',
    shards: Array.from({ length: value.shard_count }, (_, index) => ({
      index: index + 1,
      count: value.shard_count,
      coordinate: `${index + 1}/${value.shard_count}`,
      status: 'SUCCEEDED',
      failed_test_suites: 0,
      failed_tests: 0
    })),
    missing_files: [],
    duplicate_files: [],
    unexpected_files: []
  };
}

function stages(): Array<Record<string, string>> {
  return ['lint', 'typecheck', 'unit_tests', 'build'].map((name) => ({
    name,
    status: 'SUCCEEDED'
  }));
}

function preflightSummary(
  value: FrontendGateContract
): Record<string, unknown> {
  return {
    ...summary(value),
    kind: 'frontend_preflight_base_evidence_summary',
    proof_origin: 'fresh_preflight',
    build_coverage: {
      authoritative_profile: 'SUCCEEDED',
      compilation_count: 1,
      deployed_artifact_bound: true
    },
    immutable_artifact: {
      artifact_name: 'release-bus-frontend-train-r2-staging',
      run_id: '101',
      source_sha: value.base_sha,
      environment: 'staging',
      package_digest: DEPLOYMENT_DIGEST,
      upload_digest: 'f'.repeat(64),
      build_profile_digest: value.build_profile_digest
    },
    build_environments: ['staging']
  };
}

function operationProof(
  type: 'preflight-frontend' | 'deploy-frontend-staging' | 'e2e-staging',
  sha: string,
  runId: string,
  artifactDigest: string | null
) {
  return {
    operation_key: `operation:${type}:${runId}`,
    operation_type: type,
    status: 'SUCCEEDED',
    expected_sha: sha,
    environment: type === 'preflight-frontend' ? 'orchestration' : 'staging',
    run_id: runId,
    run_url: `https://github.com/6529-Collections/6529seize-frontend/actions/runs/${runId}`,
    artifact_digest: artifactDigest
  } as const;
}

function promotionInput(value: FrontendGateContract) {
  return {
    sourceTrainId: 'train-source',
    sourceTrainRevision: 2,
    finalSha: value.base_sha,
    stagingRefSha: value.base_sha,
    contract: value,
    summary: preflightSummary(value),
    stages: stages(),
    preflight: operationProof(
      'preflight-frontend',
      value.base_sha,
      '101',
      ARTIFACT_DIGEST
    ),
    deployment: operationProof(
      'deploy-frontend-staging',
      value.base_sha,
      '102',
      DEPLOYMENT_DIGEST
    ),
    e2e: operationProof('e2e-staging', value.base_sha, '103', null),
    now: 2_000,
    maxAgeMs: 24 * 60 * 60 * 1000
  } as const;
}

function promotedRow(value: FrontendGateContract): BaseCanaryEvidenceRecord {
  const promoted = buildPromotedBaseEvidence(promotionInput(value));
  if (!promoted.promoted) throw new Error(promoted.reason);
  return {
    id: 'promoted-evidence',
    train_id: 'train-source',
    revision: 2,
    status: 'SUCCEEDED',
    evidence_type: 'BASE_EVIDENCE_PROMOTED',
    source_sha: value.base_sha,
    artifact_digest: promoted.artifactDigest,
    evidence_uri: promoted.evidenceUri,
    metadata_json: promoted.metadata,
    created_at: 2_000
  };
}

function row(
  value: FrontendGateContract,
  overrides: Partial<BaseCanaryEvidenceRecord> = {}
): BaseCanaryEvidenceRecord {
  return {
    id: 'evidence-1',
    train_id: 'train-source',
    revision: 2,
    status: 'SUCCEEDED',
    evidence_type: 'BASE_CANARY_COMPLETED',
    source_sha: value.base_sha,
    artifact_digest: ARTIFACT_DIGEST,
    evidence_uri:
      'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
    metadata_json: {
      source_kind: 'fresh_base_canary',
      anchored_full_proof: true,
      contract: value,
      summary: summary(value),
      gate_stages: stages(),
      source_run_id: '123',
      created_at: 1_000,
      expires_at: 87_401_000
    },
    created_at: 1_000,
    ...overrides
  };
}

describe('frontend base-canary evidence contract', () => {
  it('matches the workflow-side contract vector exactly', () => {
    expect(
      buildFrontendGateContract({
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        baseFileContents: {
          'bin/6529': 'runner',
          'jest.config.js': 'config',
          'jest.setup.js': 'setup',
          'package.json': JSON.stringify({ packageManager: 'pnpm@10.14.0' }),
          'pnpm-lock.yaml': 'lockfile'
        },
        workflowFileContents: {
          [FRONTEND_GATE_WORKFLOW]: 'workflow',
          '.github/workflows/release-bus-preflight.yml': 'preflight workflow',
          [FRONTEND_BASE_IDENTITY_WORKFLOW]: 'identity workflow',
          'scripts/release-bus-authorize-operation.sh': 'authorize',
          'scripts/release-bus-build-profile.cjs': 'build profile',
          'scripts/release-bus-frontend-gate.sh': 'gate',
          'scripts/release-bus-gate-evidence.cjs': 'evidence',
          'scripts/release-bus-install-dependencies.cjs': 'installer',
          'scripts/release-bus-preflight-evidence.cjs': 'preflight evidence',
          'scripts/release-bus-report-progress.mjs': 'reporter'
        },
        gateMode: 'sharded',
        shardCount: 4,
        buildProfileDigest: BUILD_PROFILE_DIGEST
      })
    ).toMatchObject({
      gate_fingerprint:
        '9dc75f4bd421a5f77fcb8272eb1c7e8faec2c847d8018810b55e3f4ddd0abfd8',
      workflow_digest:
        'da7f739f627198465eeab537a6f7a435dc4a0c332f9e4a8462293eb3f4ab7ee0'
    });
  });

  it('fingerprints every relevant policy input deterministically', () => {
    const baseline = contract();
    expect(contract()).toEqual(baseline);
    expect(
      contract({ workflowFileContents: workflowContents('-changed') })
        .gate_fingerprint
    ).not.toBe(baseline.gate_fingerprint);
    expect(
      contract({ baseFileContents: contents('-changed') }).gate_fingerprint
    ).not.toBe(baseline.gate_fingerprint);
    expect(
      contract({ gateMode: 'legacy', shardCount: 1 }).gate_fingerprint
    ).not.toBe(baseline.gate_fingerprint);
  });

  it('reuses only intact successful evidence for the exact contract', () => {
    const value = contract();
    expect(
      evaluateBaseCanaryEvidence({
        rows: [row(value)],
        contract: value,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toMatchObject({
      decision: 'HIT',
      reason: 'reusable_success',
      evidence: { id: 'evidence-1' }
    });
  });

  it('promotes exact fresh preflight, immutable deploy, and E2E proof for next-train reuse', () => {
    const value = contract();
    const first = buildPromotedBaseEvidence(promotionInput(value));
    const retry = buildPromotedBaseEvidence(promotionInput(value));

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      promoted: true,
      metadata: {
        source_kind: 'staging_train_full_gate_preflight_deploy_e2e',
        anchored_full_proof: true,
        proof: {
          anchor: 'fresh_preflight_deploy_e2e',
          final_sha: value.base_sha,
          staging_ref_sha: value.base_sha
        }
      }
    });
    expect(
      evaluateBaseCanaryEvidence({
        rows: [promotedRow(value)],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toMatchObject({
      decision: 'HIT',
      reason: 'reusable_success',
      evidence: { evidence_type: 'BASE_EVIDENCE_PROMOTED' }
    });
  });

  it.each([
    [
      'staging ref moved manually',
      { stagingRefSha: 'f'.repeat(40) },
      'staging_ref_sha_mismatch'
    ],
    [
      'failed deployment',
      {
        deployment: {
          ...operationProof(
            'deploy-frontend-staging',
            BASE_SHA,
            '102',
            'd'.repeat(64)
          ),
          status: 'FAILED'
        }
      },
      'invalid_deployment_proof'
    ],
    [
      'failed E2E',
      {
        e2e: {
          ...operationProof('e2e-staging', BASE_SHA, '103', null),
          status: 'FAILED'
        }
      },
      'invalid_e2e_proof'
    ]
  ])('does not promote after %s', (_label, overrides, reason) => {
    const value = contract();
    expect(
      buildPromotedBaseEvidence({
        ...promotionInput(value),
        ...overrides
      })
    ).toEqual({ promoted: false, reason });
  });

  it('does not launder reused-only evidence into a new promotion', () => {
    const value = contract();
    expect(
      buildPromotedBaseEvidence({
        ...promotionInput(value),
        summary: {
          ...preflightSummary(value),
          fresh_or_reused: 'reused',
          proof_origin: 'reused_evidence'
        }
      })
    ).toEqual({ promoted: false, reason: 'reused_source_not_allowed' });
  });

  it.each([
    ['sha_mismatch', 'base_sha', 'f'.repeat(40)],
    ['fingerprint_mismatch', 'gate_fingerprint', 'f'.repeat(64)],
    ['behavior_digest_mismatch', 'behavior_digest', 'e'.repeat(64)],
    ['build_profile_digest_mismatch', 'build_profile_digest', 'c'.repeat(64)],
    ['workflow_digest_mismatch', 'workflow_digest', 'b'.repeat(64)],
    ['node_version_mismatch', 'node_version', '24'],
    ['package_manager_mismatch', 'package_manager', 'pnpm@11.0.0'],
    ['gate_mode_mismatch', 'gate_mode', 'shadow'],
    ['shard_count_mismatch', 'shard_count', 2]
  ])('fails closed on %s', (reason, field, changed) => {
    const value = contract();
    const evidence = promotedRow(value);
    const stored = evidence.metadata_json as Record<string, unknown>;
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          {
            ...evidence,
            metadata_json: {
              ...stored,
              contract: {
                ...(stored.contract as Record<string, unknown>),
                [field]: changed
              }
            }
          }
        ],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'MISS', reason });
  });

  it('fails closed on component digest drift', () => {
    const value = contract();
    const evidence = promotedRow(value);
    const stored = evidence.metadata_json as Record<string, unknown>;
    const storedContract = stored.contract as Record<string, unknown>;
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          {
            ...evidence,
            metadata_json: {
              ...stored,
              contract: {
                ...storedContract,
                component_digests: {
                  ...(storedContract.component_digests as Record<
                    string,
                    string
                  >),
                  'package.json': 'f'.repeat(64)
                }
              }
            }
          }
        ],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'MISS', reason: 'component_digests_mismatch' });
  });

  it('treats missing, failed, and untrusted promoted evidence as non-reusable', () => {
    const value = contract();
    const promoted = promotedRow(value);
    expect(
      evaluateBaseCanaryEvidence({
        rows: [],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'MISS', reason: 'no_exact_sha_evidence' });
    expect(
      evaluateBaseCanaryEvidence({
        rows: [{ ...promoted, status: 'FAILED' }],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason: 'newer_failure' });
    expect(
      evaluateBaseCanaryEvidence({
        rows: [{ ...promoted, evidence_uri: 'https://example.com/run/101' }],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason: 'run_provenance_mismatch' });
  });

  it('lets a newer promotion rejection invalidate older exact evidence', () => {
    const value = contract();
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          promotedRow(value),
          {
            id: 'promotion-rejected',
            train_id: 'newer-train',
            revision: 1,
            status: 'FAILED',
            evidence_type: 'BASE_EVIDENCE_PROMOTION_REJECTED',
            source_sha: value.base_sha,
            artifact_digest: null,
            evidence_uri: null,
            metadata_json: {
              source_kind: 'staging_train_promotion_rejection',
              reason: 'invalid_e2e_proof',
              created_at: 2_500
            },
            created_at: 2_500
          }
        ],
        contract: value,
        now: 3_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason: 'newer_failure' });
  });

  it('lets the newest relevant failure override an older success', () => {
    const value = contract();
    const oldSuccess = row(value, { id: 'old-success', created_at: 2_000 });
    const newerFailure = row(value, {
      id: 'new-failure',
      status: 'FAILED',
      created_at: 1_500,
      metadata_json: {
        contract: value,
        summary: summary(value),
        source_run_id: '123',
        created_at: 1_500,
        expires_at: 87_401_500
      }
    });
    expect(
      evaluateBaseCanaryEvidence({
        // The older success was inserted later, so repository insertion order
        // is intentionally the reverse of workflow terminal order.
        rows: [oldSuccess, newerFailure],
        contract: value,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason: 'newer_failure' });
  });

  it.each<
    [
      string,
      {
        now?: number;
        overrides?: Partial<BaseCanaryEvidenceRecord>;
      }
    ]
  >([
    ['expired', { now: 100_000_000 }],
    ['malformed_metadata', { overrides: { metadata_json: '{not-json' } }],
    [
      'artifact_digest_mismatch',
      { overrides: { artifact_digest: 'd'.repeat(64) } }
    ]
  ])('rejects %s evidence', (reason, options) => {
    const value = contract();
    expect(
      evaluateBaseCanaryEvidence({
        rows: [row(value, options.overrides)],
        contract: value,
        now: options.now ?? 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason });
  });

  it('does not cross fingerprint or environment boundaries', () => {
    const expected = contract();
    const other = contract({ gateMode: 'legacy', shardCount: 1 });
    expect(
      evaluateBaseCanaryEvidence({
        rows: [row(other)],
        contract: expected,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'MISS', reason: 'fingerprint_mismatch' });
  });

  it.each([
    [
      'invalid_creation_time',
      { created_at: 10 * 60 * 1000, expires_at: 100_000_000 }
    ],
    ['invalid_expiry_time', { expires_at: 999 }],
    ['run_provenance_mismatch', { source_run_id: '456' }]
  ])('rejects %s provenance', (reason, metadataOverrides) => {
    const value = contract();
    const evidence = row(value);
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          {
            ...evidence,
            metadata_json: {
              ...(evidence.metadata_json as Record<string, unknown>),
              ...metadataOverrides
            }
          }
        ],
        contract: value,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({ decision: 'INVALIDATED', reason });
  });

  it('rejects a successful record with malformed shard provenance', () => {
    const value = contract();
    const evidence = row(value);
    const stored = evidence.metadata_json as Record<string, unknown>;
    const storedSummary = stored.summary as Record<string, unknown>;
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          {
            ...evidence,
            metadata_json: {
              ...stored,
              summary: {
                ...storedSummary,
                shards: [
                  {
                    index: 1,
                    count: 4,
                    coordinate: { unexpected: true },
                    status: 'SUCCEEDED',
                    failed_test_suites: 0,
                    failed_tests: 0
                  }
                ]
              }
            }
          }
        ],
        contract: value,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({
      decision: 'INVALIDATED',
      reason: 'invalid_shard_summary'
    });
  });

  it('rejects a successful record with skipped tests', () => {
    const value = contract();
    const evidence = row(value);
    const stored = evidence.metadata_json as Record<string, unknown>;
    const storedSummary = stored.summary as Record<string, unknown>;
    expect(
      evaluateBaseCanaryEvidence({
        rows: [
          {
            ...evidence,
            metadata_json: {
              ...stored,
              summary: {
                ...storedSummary,
                totals: {
                  ...(storedSummary.totals as Record<string, unknown>),
                  skipped_tests: 1
                }
              }
            }
          }
        ],
        contract: value,
        now: 2_000,
        maxAgeMs: 24 * 60 * 60 * 1000
      })
    ).toEqual({
      decision: 'INVALIDATED',
      reason: 'skipped_test_counts'
    });
  });

  it.each(['files', 'test_suites', 'tests'])(
    'rejects a zero %s total',
    (field) => {
      const value = contract();
      const evidence = row(value);
      const stored = evidence.metadata_json as Record<string, unknown>;
      const storedSummary = stored.summary as Record<string, unknown>;
      expect(
        evaluateBaseCanaryEvidence({
          rows: [
            {
              ...evidence,
              metadata_json: {
                ...stored,
                summary: {
                  ...storedSummary,
                  totals: {
                    ...(storedSummary.totals as Record<string, unknown>),
                    [field]: 0
                  }
                }
              }
            }
          ],
          contract: value,
          now: 2_000,
          maxAgeMs: 24 * 60 * 60 * 1000
        })
      ).toEqual({
        decision: 'INVALIDATED',
        reason: 'failed_test_counts'
      });
    }
  );
});
