import {
  buildFrontendGateContract,
  evaluateBaseCanaryEvidence,
  FRONTEND_GATE_BASE_FILES,
  FRONTEND_GATE_TOOLING_FILES,
  FRONTEND_GATE_WORKFLOW,
  type BaseCanaryEvidenceRecord,
  type FrontendGateContract
} from '@/releaseBus/release-bus.base-canary-evidence';

const BASE_SHA = 'a'.repeat(40);
const WORKFLOW_SHA = 'b'.repeat(40);
const ARTIFACT_DIGEST = 'c'.repeat(64);

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
    [FRONTEND_GATE_WORKFLOW, ...FRONTEND_GATE_TOOLING_FILES].map((file) => [
      file,
      `${file}:${suffix}`
    ])
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
    ...overrides
  });
}

function summary(value: FrontendGateContract): Record<string, unknown> {
  return {
    base_sha: value.base_sha,
    environment: value.environment,
    gate_fingerprint: value.gate_fingerprint,
    workflow_sha: value.workflow_sha,
    workflow_digest: value.workflow_digest,
    node_version: value.node_version,
    package_manager: value.package_manager,
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
      skipped_tests: 0
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
    duplicate_files: []
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
    source_sha: value.base_sha,
    artifact_digest: ARTIFACT_DIGEST,
    evidence_uri:
      'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
    metadata_json: {
      contract: value,
      summary: summary(value),
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
          'scripts/release-bus-frontend-gate.sh': 'gate',
          'scripts/release-bus-gate-evidence.cjs': 'evidence',
          'scripts/release-bus-report-progress.mjs': 'reporter'
        },
        gateMode: 'sharded',
        shardCount: 4
      })
    ).toMatchObject({
      gate_fingerprint:
        '78870a761c2c085d2ca6a9386a3c6e77ccda5348667526972718a5832c530b49',
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
