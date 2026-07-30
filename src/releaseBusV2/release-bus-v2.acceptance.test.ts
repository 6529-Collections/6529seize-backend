const mockReconcileWorkflow = jest.fn();
const mockEnsureCommitStatus = jest.fn();
const mockResolveRef = jest.fn();
const mockResolveRefIfExists = jest.fn();
const mockCreateRef = jest.fn();
const mockRefContainsCommit = jest.fn();
const mockUpdateRef = jest.fn();
const mockHasActiveStagingRun = jest.fn();
const mockHasStagingRunSince = jest.fn();
const mockHasActiveProductionRun = jest.fn();
const mockFindWorkflowRun = jest.fn();
const mockImmutableRefs = new Map<string, string>();

jest.mock('@/releaseBusV2/release-bus-v2.operations', () => ({
  releaseBusV2Operations: {
    reconcileWorkflow: (...args: unknown[]) => mockReconcileWorkflow(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args),
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    resolveRefIfExists: (...args: unknown[]) => mockResolveRefIfExists(...args),
    createRef: (...args: unknown[]) => mockCreateRef(...args),
    refContainsCommit: (...args: unknown[]) => mockRefContainsCommit(...args),
    updateRef: (...args: unknown[]) => mockUpdateRef(...args),
    hasActiveStagingMutationOrE2ERun: (...args: unknown[]) =>
      mockHasActiveStagingRun(...args),
    hasStagingMutationOrE2ERunSince: (...args: unknown[]) =>
      mockHasStagingRunSince(...args),
    hasActiveProductionMutationOrE2ERun: (...args: unknown[]) =>
      mockHasActiveProductionRun(...args),
    findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args)
  }
}));

import {
  backendGraph,
  candidateEvidenceSelection,
  preparedArtifactDeployBinding,
  ReleaseBusV2Reconciler
} from '@/releaseBusV2/release-bus-v2.reconciler';
import { irreversibleProductionOperationReason } from '@/releaseBusV2/release-bus-v2.service';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ReleaseBusV2ControlRecord,
  ReleaseBusV2DependencyRecord,
  ReleaseBusV2LockRecord,
  ReleaseBusV2ManifestRecord,
  ReleaseBusV2TrainCandidateRecord
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2StagingStateRecord,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

const FRONTEND_SHA = 'a'.repeat(40);
const BACKEND_SHA = 'b'.repeat(40);
const FRONTEND_DIGEST = 'c'.repeat(64);
const BACKEND_DIGEST = 'd'.repeat(64);

function train(
  id: string,
  overrides: Partial<ReleaseBusV2TrainRecord> = {}
): ReleaseBusV2TrainRecord {
  return {
    id,
    lane: 'STAGING',
    status: 'PREPARED',
    frontend_base_sha: '1'.repeat(40),
    backend_base_sha: '2'.repeat(40),
    frontend_composed_sha: FRONTEND_SHA,
    backend_composed_sha: BACKEND_SHA,
    frontend_artifact_digest: FRONTEND_DIGEST,
    backend_artifact_digest: BACKEND_DIGEST,
    manifest_id: null,
    parent_train_id: null,
    qualification_identity_sha256: null,
    qualification_train_id: null,
    qualification_policy: null,
    qualification_evidence_json: null,
    failure_class: null,
    failure_message: null,
    recovery_message: null,
    phase_started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1,
    ...overrides
  };
}

function candidate(
  id: string,
  repository: 'frontend' | 'backend',
  plan: ReleaseBusV2CandidateRecord['deploy_plan_json']
): ReleaseBusV2CandidateRecord {
  const mergeSha = repository === 'frontend' ? '5'.repeat(40) : '6'.repeat(40);
  return {
    id,
    repository,
    pr_number: repository === 'frontend' ? 20 : 21,
    branch_name: `feature/${id}`,
    head_sha: repository === 'frontend' ? '3'.repeat(40) : '4'.repeat(40),
    requested_by: 'acceptance',
    status: 'STAGING_BUILDING',
    deploy_plan_json: plan,
    pr_evidence_json: {
      base_sha: repository === 'frontend' ? '1'.repeat(40) : '2'.repeat(40),
      merge_sha: mergeSha,
      checks_run_id: '101',
      checks_completed_at: 123,
      artifact_run_id: '202',
      artifact_name: `release-bus-v2-pr-${mergeSha}`,
      artifact_digest: '9'.repeat(64),
      workflow_path:
        repository === 'frontend'
          ? '.github/workflows/app-pr-ci.yml'
          : '.github/workflows/on-pull-request.yml',
      base_workflow_blob_sha: 'a'.repeat(40),
      merge_workflow_blob_sha: 'b'.repeat(40),
      base_gate_policy_digest: 'c'.repeat(64),
      merge_gate_policy_digest: 'd'.repeat(64),
      trust_mode: 'evidence-manifest-v1'
    },
    current_train_id: 'train-1',
    staging_validated_train_id: null,
    staging_validated_manifest_id: null,
    production_requested_at: null,
    production_requested_by: null,
    production_selection_id: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

function withEvidence(
  value: ReleaseBusV2CandidateRecord,
  trustMode: 'evidence-manifest-v1' | 'legacy-exact-workflow-v0',
  artifact = trustMode === 'evidence-manifest-v1'
): ReleaseBusV2CandidateRecord {
  const mergeSha = '8'.repeat(40);
  return {
    ...value,
    pr_evidence_json: {
      base_sha: '7'.repeat(40),
      merge_sha: mergeSha,
      checks_run_id: '101',
      checks_completed_at: 123,
      artifact_run_id: artifact ? '202' : null,
      artifact_name: artifact ? `release-bus-v2-pr-${mergeSha}` : null,
      artifact_digest: artifact ? '9'.repeat(64) : null,
      workflow_path:
        value.repository === 'backend'
          ? '.github/workflows/on-pull-request.yml'
          : '.github/workflows/app-pr-ci.yml',
      base_workflow_blob_sha: 'a'.repeat(40),
      merge_workflow_blob_sha: 'b'.repeat(40),
      base_gate_policy_digest: 'c'.repeat(64),
      merge_gate_policy_digest: 'd'.repeat(64),
      trust_mode: trustMode
    }
  };
}

describe('whole-repository candidate evidence modes', () => {
  it('uses strict-single only for the exact fast candidate', () => {
    const exact = withEvidence(
      candidate('strict', 'backend', null),
      'evidence-manifest-v1'
    );
    expect(candidateEvidenceSelection([exact], exact.id)).toMatchObject({
      mode: 'strict-single',
      aggregateDigest: null,
      singular: expect.objectContaining({ artifact_run_id: '202' })
    });
  });

  it('uses a deterministic strict aggregate for multi-candidate composition', () => {
    const first = withEvidence(
      candidate('first', 'backend', null),
      'evidence-manifest-v1'
    );
    const second = withEvidence(
      { ...candidate('second', 'backend', null), pr_number: 22 },
      'evidence-manifest-v1'
    );
    const forward = candidateEvidenceSelection([first, second], null);
    const reversed = candidateEvidenceSelection([second, first], null);
    const changed = candidateEvidenceSelection(
      [
        first,
        {
          ...second,
          pr_evidence_json: {
            ...second.pr_evidence_json!,
            checks_run_id: '303'
          }
        }
      ],
      null
    );
    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      mode: 'strict-aggregate',
      aggregateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      singular: null
    });
    expect(changed.aggregateDigest).not.toBe(forward.aggregateDigest);
  });

  it('keeps an exact legacy bridge whole-train and rejects mixed or unaudited evidence', () => {
    const legacy = withEvidence(
      candidate('legacy', 'backend', null),
      'legacy-exact-workflow-v0',
      false
    );
    expect(candidateEvidenceSelection([legacy], legacy.id)).toEqual({
      mode: 'legacy-whole-train',
      aggregateDigest: null,
      singular: null
    });
    const strict = withEvidence(
      candidate('strict', 'backend', null),
      'evidence-manifest-v1'
    );
    expect(() => candidateEvidenceSelection([legacy, strict], null)).toThrow(
      'cannot be mixed'
    );
    expect(() =>
      candidateEvidenceSelection(
        [
          {
            ...candidate('historical', 'backend', null),
            pr_evidence_json: null
          }
        ],
        null
      )
    ).toThrow('no complete exact PR CI policy evidence');
    expect(() =>
      candidateEvidenceSelection(
        [
          {
            ...strict,
            pr_evidence_json: {
              ...strict.pr_evidence_json!,
              trust_mode: 'future-unreviewed-mode' as never
            }
          }
        ],
        null
      )
    ).toThrow('no complete exact PR CI policy evidence');
  });
});

describe('environment-specific backend preparation graph', () => {
  const environmentCandidate = candidate('environment-graph', 'backend', {
    units: ['api', 'releaseBus', 'dropMediaIngestStorage'],
    edges: [
      ['dropMediaIngestStorage', 'api'],
      ['api', 'releaseBus']
    ]
  });

  it('packages only staging deploy units for a staging preparation', () => {
    expect(backendGraph([environmentCandidate], 'staging')).toMatchObject({
      units: ['api', 'dropMediaIngestStorage']
    });
  });

  it('packages only production deploy units for a production preparation', () => {
    expect(backendGraph([environmentCandidate], 'prod')).toMatchObject({
      units: ['api', 'releaseBus']
    });
  });
});

describe('immutable prepared artifact deploy binding', () => {
  const prepared = (
    inputs: Record<string, string>,
    summary: Record<string, unknown>,
    repository: 'frontend' | 'backend' = 'backend'
  ): ReleaseBusV2OperationRecord => {
    const operationRecord = operation(
      'artifact-binding-train',
      `PREPARE_ARTIFACT_${repository.toUpperCase()}`,
      repository,
      '12345'
    );
    return {
      ...operationRecord,
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {
          release_train_id: 'artifact-binding-train',
          release_train_revision: '1',
          operation_key: 'replaced-by-reconciler',
          source_ref: `release-bus-v2/artifact-binding-train/${repository}`,
          expected_sha: operationRecord.expected_sha!,
          deploy_units: repository === 'backend' ? '["api"]' : '[]',
          ...inputs
        }
      },
      result_json: { summary }
    };
  };

  it.each([
    ['staging', 'staging'],
    ['production', 'prod']
  ] as const)(
    'accepts exact old-frontend %s dual-profile preparation only as legacy portable bytes',
    (artifactEnvironment, deploymentEnvironment) => {
      expect(
        preparedArtifactDeployBinding(
          prepared(
            { artifact_environment: artifactEnvironment },
            {
              artifact_digest: FRONTEND_DIGEST,
              fresh_or_reused: 'fresh-dual-profile'
            },
            'frontend'
          ),
          deploymentEnvironment
        )
      ).toEqual({
        artifact_environment: '',
        artifact_contract_version: 'legacy-v2'
      });
    }
  );

  it.each([
    [
      'frontend environment mismatch',
      { artifact_environment: 'staging' },
      'fresh-dual-profile',
      'prod'
    ],
    [
      'frontend historical label mismatch',
      { artifact_environment: 'production' },
      'fresh',
      'prod'
    ],
    [
      'frontend deploy-unit shape mismatch',
      {
        artifact_environment: 'production',
        deploy_units: '["web"]'
      },
      'fresh-dual-profile',
      'prod'
    ]
  ] as const)(
    'rejects old %s',
    (_label, inputs, freshOrReused, deploymentEnvironment) => {
      expect(() =>
        preparedArtifactDeployBinding(
          prepared(
            inputs,
            {
              artifact_digest: FRONTEND_DIGEST,
              fresh_or_reused: freshOrReused
            },
            'frontend'
          ),
          deploymentEnvironment
        )
      ).toThrow(/legacy artifact preparation/i);
    }
  );

  it.each([
    ['dual environment', { environment: 'production' }],
    ['freshness label', { fresh_or_reused: 'fresh-dual-profile' }],
    ['evidence reuse flag', { source_evidence_reused: true }]
  ])(
    'rejects new legacy frontend summary drift in %s',
    (_label, summaryOverride) => {
      const exact = newLegacyFrontendPreparedArtifactOperation(
        'artifact-binding-train',
        '12345',
        'staging'
      );
      const result = exact.result_json as {
        summary: Record<string, unknown>;
      };
      expect(() =>
        preparedArtifactDeployBinding(
          {
            ...exact,
            result_json: {
              summary: { ...result.summary, ...summaryOverride }
            }
          },
          'staging'
        )
      ).toThrow(/legacy artifact preparation/i);
    }
  );

  it('accepts only the exact new legacy backend request and graph-bound package summary', () => {
    expect(
      preparedArtifactDeployBinding(
        newLegacyBackendPreparedArtifactOperation(
          'artifact-binding-train',
          '12345'
        ),
        'staging'
      )
    ).toEqual({
      artifact_environment: '',
      artifact_contract_version: 'legacy-v2'
    });
  });

  it.each(['backend', 'frontend'] as const)(
    'accepts an old %s request completed by the new structured workflow',
    (repository) => {
      const exact =
        repository === 'backend'
          ? newLegacyBackendPreparedArtifactOperation(
              'artifact-binding-train',
              '12345'
            )
          : newLegacyFrontendPreparedArtifactOperation(
              'artifact-binding-train',
              '12345',
              'staging'
            );
      const request = exact.request_json as {
        workflow: string;
        ref: string;
        inputs: Record<string, string>;
      };
      const oldInputs = { ...request.inputs };
      for (const key of [
        'aggregate_candidate_evidence_digest',
        'artifact_contract_version',
        'candidate_evidence_mode',
        'deploy_layers',
        'reuse_artifact_digest',
        'reuse_artifact_name',
        'reuse_artifact_run_id'
      ])
        delete oldInputs[key];
      if (repository === 'backend') delete oldInputs.artifact_environment;
      expect(
        preparedArtifactDeployBinding(
          {
            ...exact,
            request_json: {
              workflow: request.workflow,
              ref: request.ref,
              inputs: oldInputs
            }
          },
          'staging'
        )
      ).toEqual({
        artifact_environment: '',
        artifact_contract_version: 'legacy-v2'
      });
    }
  );

  it.each([
    ['candidate evidence mode', { candidate_evidence_mode: 'strict-single' }],
    ['selected units', { deploy_units: '["releaseBus"]' }],
    ['DAG layers', { deploy_layers: '[["api"],["releaseBus"]]' }],
    ['reuse evidence', { reuse_artifact_run_id: '12345' }]
  ])('rejects new legacy backend request drift in %s', (_label, override) => {
    const exact = newLegacyBackendPreparedArtifactOperation(
      'artifact-binding-train',
      '12345'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      workflow_control_sha: string;
      inputs: Record<string, string>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            ...request,
            inputs: { ...request.inputs, ...override }
          }
        },
        'staging'
      )
    ).toThrow(/legacy artifact preparation/i);
  });

  it.each([
    ['selected units', { units: ['releaseBus'] }],
    ['DAG layers', { layers: [['releaseBus']] }],
    ['package keys', { package_digests: { releaseBus: 'd'.repeat(64) } }],
    ['package digest', { package_digests: { api: 'not-a-digest' } }]
  ])('rejects new legacy backend summary drift in %s', (_label, override) => {
    const exact = newLegacyBackendPreparedArtifactOperation(
      'artifact-binding-train',
      '12345'
    );
    const result = exact.result_json as {
      summary: Record<string, unknown>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          result_json: {
            summary: { ...result.summary, ...override }
          }
        },
        'staging'
      )
    ).toThrow(/legacy artifact preparation/i);
  });

  it.each([
    ['frontend deploy units', { deploy_units: '["web"]' }],
    ['frontend evidence mode', { candidate_evidence_mode: 'strict-single' }],
    [
      'frontend aggregate evidence',
      { aggregate_candidate_evidence_digest: 'a' }
    ]
  ])('rejects new legacy %s request drift', (_label, override) => {
    const exact = newLegacyFrontendPreparedArtifactOperation(
      'artifact-binding-train',
      '12345',
      'staging'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      workflow_control_sha: string;
      inputs: Record<string, string>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            ...request,
            inputs: { ...request.inputs, ...override }
          }
        },
        'staging'
      )
    ).toThrow(/legacy artifact preparation/i);
  });

  it('rejects a new legacy producer without an exact workflow control SHA', () => {
    const exact = newLegacyFrontendPreparedArtifactOperation(
      'artifact-binding-train',
      '12345',
      'staging'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      inputs: Record<string, string>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            workflow: request.workflow,
            ref: request.ref,
            inputs: request.inputs
          }
        },
        'staging'
      )
    ).toThrow(/legacy artifact preparation/i);
  });

  it('accepts the exact old-producer terminal payload only as legacy portable bytes', () => {
    expect(
      preparedArtifactDeployBinding(
        prepared(
          {},
          {
            artifact_digest: BACKEND_DIGEST,
            fresh_or_reused: 'fresh'
          }
        ),
        'prod'
      )
    ).toEqual({
      artifact_environment: '',
      artifact_contract_version: 'legacy-v2'
    });
  });

  it.each([
    [
      'a new explicit legacy request with the unstructured old summary',
      {
        artifact_contract_version: 'legacy-v2',
        artifact_environment: ''
      },
      {
        artifact_digest: BACKEND_DIGEST,
        fresh_or_reused: 'fresh'
      }
    ],
    [
      'schema drift',
      {
        artifact_contract_version: 'legacy-v2',
        artifact_environment: ''
      },
      {
        schema_version: 3,
        environment: 'portable',
        artifact_digest: BACKEND_DIGEST
      }
    ],
    [
      'environment drift',
      {
        artifact_contract_version: 'legacy-v2',
        artifact_environment: ''
      },
      {
        schema_version: 2,
        environment: 'production',
        artifact_digest: BACKEND_DIGEST
      }
    ]
  ])('rejects %s', (_label, inputs, summary) => {
    expect(() =>
      preparedArtifactDeployBinding(prepared(inputs, summary), 'prod')
    ).toThrow(/legacy artifact preparation/i);
  });

  it('derives v3 only from the exact immutable environment-bound preparation', () => {
    expect(
      preparedArtifactDeployBinding(
        preparedArtifactOperation(
          'artifact-binding-train',
          'backend',
          '12345',
          'environment-bound-v3',
          'production'
        ),
        'prod'
      )
    ).toEqual({
      artifact_environment: 'production',
      artifact_contract_version: 'environment-bound-v3'
    });
  });

  it('binds a v3 strict-single request to its exact immutable PR evidence', () => {
    const exact = preparedArtifactOperation(
      'artifact-binding-train',
      'backend',
      '12345',
      'environment-bound-v3',
      'production'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      workflow_control_sha: string;
      inputs: Record<string, string>;
    };
    const result = exact.result_json as {
      summary: Record<string, unknown>;
    };
    const evidence = {
      mode: 'strict-single',
      artifact_run_id: '54321',
      artifact_name: `release-bus-v2-pr-${BACKEND_SHA}`,
      artifact_digest: 'e'.repeat(64),
      aggregate_candidate_evidence_digest: null
    };
    expect(
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            ...request,
            inputs: {
              ...request.inputs,
              candidate_evidence_mode: 'strict-single',
              aggregate_candidate_evidence_digest: '',
              reuse_artifact_run_id: '54321',
              reuse_artifact_name: evidence.artifact_name,
              reuse_artifact_digest: evidence.artifact_digest
            }
          },
          result_json: {
            summary: { ...result.summary, ci_evidence: evidence }
          }
        },
        'prod'
      )
    ).toEqual({
      artifact_environment: 'production',
      artifact_contract_version: 'environment-bound-v3'
    });
  });

  it.each([
    [
      'candidate evidence mode',
      { candidate_evidence_mode: 'legacy-whole-train' }
    ],
    ['aggregate evidence digest', { aggregate_candidate_evidence_digest: '' }],
    ['selected backend units', { deploy_units: '["releaseBus"]' }],
    ['backend DAG layers', { deploy_layers: '[["releaseBus"]]' }]
  ])('rejects v3 backend request drift in %s', (_label, override) => {
    const exact = preparedArtifactOperation(
      'artifact-binding-train',
      'backend',
      '12345',
      'environment-bound-v3',
      'production'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      workflow_control_sha: string;
      inputs: Record<string, string>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            ...request,
            inputs: { ...request.inputs, ...override }
          }
        },
        'prod'
      )
    ).toThrow(/environment-bound preparation/i);
  });

  it.each([
    ['selected backend units', { units: ['releaseBus'] }],
    ['backend DAG layers', { layers: [['releaseBus']] }],
    [
      'backend package keys',
      { package_digests: { releaseBus: 'd'.repeat(64) } }
    ],
    ['backend CI evidence', { ci_evidence: null }]
  ])('rejects v3 backend summary drift in %s', (_label, override) => {
    const exact = preparedArtifactOperation(
      'artifact-binding-train',
      'backend',
      '12345',
      'environment-bound-v3',
      'production'
    );
    const result = exact.result_json as {
      summary: Record<string, unknown>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          result_json: {
            summary: { ...result.summary, ...override }
          }
        },
        'prod'
      )
    ).toThrow(/environment-bound preparation/i);
  });

  it.each([
    ['frontend deploy units', { deploy_units: '["web"]' }],
    ['frontend evidence mode', { candidate_evidence_mode: 'strict-single' }]
  ])('rejects v3 %s request drift', (_label, override) => {
    const exact = preparedArtifactOperation(
      'artifact-binding-train',
      'frontend',
      '12345',
      'environment-bound-v3',
      'staging'
    );
    const request = exact.request_json as {
      workflow: string;
      ref: string;
      workflow_control_sha: string;
      inputs: Record<string, string>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          request_json: {
            ...request,
            inputs: { ...request.inputs, ...override }
          }
        },
        'staging'
      )
    ).toThrow(/environment-bound preparation/i);
  });

  it.each([
    ['frontend package digest', { package_digest: 'not-a-digest' }],
    ['frontend CI evidence', { ci_evidence: null }],
    ['frontend freshness', { fresh_or_reused: 'fresh' }]
  ])('rejects v3 %s summary drift', (_label, override) => {
    const exact = preparedArtifactOperation(
      'artifact-binding-train',
      'frontend',
      '12345',
      'environment-bound-v3',
      'staging'
    );
    const result = exact.result_json as {
      summary: Record<string, unknown>;
    };
    expect(() =>
      preparedArtifactDeployBinding(
        {
          ...exact,
          result_json: {
            summary: { ...result.summary, ...override }
          }
        },
        'staging'
      )
    ).toThrow(/environment-bound preparation/i);
  });
});

function operation(
  trainId: string,
  type: string,
  repository: 'frontend' | 'backend',
  externalId: string,
  service: string | null = null
): ReleaseBusV2OperationRecord {
  return {
    id: `${trainId}-${type}-${service ?? repository}`,
    idempotency_key: `rb2:${trainId}:${type.toLowerCase()}`,
    train_id: trainId,
    operation_type: type,
    repository,
    service,
    environment: type.startsWith('E2E') ? 'staging' : 'orchestration',
    expected_sha: repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA,
    artifact_digest:
      repository === 'frontend' ? FRONTEND_DIGEST : BACKEND_DIGEST,
    external_id: externalId,
    status: 'SUCCEEDED',
    attempt: 1,
    max_attempts: 3,
    next_retry_at: null,
    failure_class: null,
    failure_message: null,
    request_json: null,
    result_json: null,
    started_at: 2,
    completed_at: 3,
    created_at: 2,
    updated_at: 3,
    row_version: 1
  };
}

type StagingRefWorkflowSpec = {
  readonly idempotencyKey: string;
  readonly trainId: string;
  readonly operationType: string;
  readonly repository: 'frontend' | 'backend';
  readonly workflow: string;
  readonly ref: string;
  readonly environment: string;
  readonly service: string | null;
  readonly expectedSha: string;
  readonly artifactDigest: string | null;
  readonly inputs: Readonly<Record<string, string>>;
  readonly maxAttempts: number;
};

function stagingRefWorkflowOperation(
  spec: StagingRefWorkflowSpec,
  runId: string,
  changed: boolean
): ReleaseBusV2OperationRecord {
  return {
    ...operation(
      spec.trainId,
      spec.operationType,
      spec.repository,
      runId,
      spec.service
    ),
    id: `${spec.trainId}-${spec.operationType}-${spec.repository}`,
    idempotency_key: spec.idempotencyKey,
    environment: 'staging',
    expected_sha: spec.expectedSha,
    artifact_digest: null,
    request_json: {
      workflow: spec.workflow,
      ref: spec.ref,
      workflow_control_sha: 'f'.repeat(40),
      inputs: spec.inputs
    },
    result_json: {
      phase: 'advance_staging_ref',
      status: 'SUCCEEDED',
      failure_class: null,
      failure_phase: null,
      retryable: false,
      summary: {
        ref: '1a-staging',
        phase: spec.inputs.phase,
        expected_old_sha: spec.inputs.expected_old_sha,
        release_sha: spec.expectedSha,
        observed_sha: spec.expectedSha,
        changed
      },
      stages: [],
      jest: null,
      backend_evidence: null
    }
  };
}

function preparedArtifactOperation(
  trainId: string,
  repository: 'frontend' | 'backend',
  runId: string,
  contract: 'legacy-v2' | 'environment-bound-v3' = 'environment-bound-v3',
  artifactEnvironment: '' | 'staging' | 'production' = 'staging'
): ReleaseBusV2OperationRecord {
  const prepared = operation(
    trainId,
    `PREPARE_ARTIFACT_${repository.toUpperCase()}`,
    repository,
    runId
  );
  const legacy = contract === 'legacy-v2';
  if (legacy)
    return repository === 'backend'
      ? newLegacyBackendPreparedArtifactOperation(trainId, runId)
      : newLegacyFrontendPreparedArtifactOperation(
          trainId,
          runId,
          artifactEnvironment === 'production' ? 'production' : 'staging'
        );
  const aggregateEvidenceDigest = 'a'.repeat(64);
  const inputs = {
    release_train_id: trainId,
    release_train_revision: '1',
    operation_key: 'replaced-by-reconciler',
    source_ref: `release-bus-v2/${artifactEnvironment}-train-${trainId}-${repository}`,
    expected_sha: prepared.expected_sha!,
    deploy_units: repository === 'backend' ? '["api"]' : '[]',
    ...(repository === 'backend' ? { deploy_layers: '[["api"]]' } : {}),
    candidate_evidence_mode: 'strict-aggregate',
    aggregate_candidate_evidence_digest: aggregateEvidenceDigest,
    reuse_artifact_run_id: '',
    reuse_artifact_name: '',
    reuse_artifact_digest: '',
    artifact_contract_version: contract,
    artifact_environment: artifactEnvironment
  };
  const ciEvidence = {
    mode: 'strict-aggregate',
    artifact_run_id: null,
    artifact_name: null,
    artifact_digest: null,
    aggregate_candidate_evidence_digest: aggregateEvidenceDigest
  };
  return {
    ...prepared,
    request_json: {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      workflow_control_sha: 'f'.repeat(40),
      inputs
    },
    result_json: {
      summary:
        repository === 'backend'
          ? {
              schema_version: 3,
              artifact_contract: 'environment-bound-v1',
              artifact_contract_version: 'environment-bound-v3',
              repository,
              source_sha: prepared.expected_sha,
              environment: artifactEnvironment,
              artifact_digest: prepared.artifact_digest,
              units: ['api'],
              layers: [['api']],
              source_evidence_reused: true,
              artifact_bytes_reused: false,
              ci_evidence: ciEvidence,
              package_digests: { api: 'd'.repeat(64) },
              fresh_or_reused: 'fresh'
            }
          : {
              schema_version: 3,
              artifact_contract: 'environment-bound-v1',
              artifact_contract_version: 'environment-bound-v3',
              repository,
              source_sha: prepared.expected_sha,
              environment: artifactEnvironment,
              artifact_digest: prepared.artifact_digest,
              package_digest: 'd'.repeat(64),
              source_evidence_reused: true,
              artifact_bytes_reused: false,
              ci_evidence: ciEvidence,
              fresh_or_reused: 'fresh-environment-bound'
            }
    }
  };
}

function oldFrontendPreparedArtifactOperation(
  trainId: string,
  runId: string,
  artifactEnvironment: 'staging' | 'production'
): ReleaseBusV2OperationRecord {
  const prepared = operation(
    trainId,
    'PREPARE_ARTIFACT_FRONTEND',
    'frontend',
    runId
  );
  return {
    ...prepared,
    request_json: {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      inputs: {
        release_train_id: trainId,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: `release-bus-v2/${artifactEnvironment}-train-${trainId}-frontend`,
        expected_sha: prepared.expected_sha!,
        deploy_units: '[]',
        artifact_environment: artifactEnvironment
      }
    },
    result_json: {
      summary: {
        artifact_digest: prepared.artifact_digest,
        fresh_or_reused: 'fresh-dual-profile'
      }
    }
  };
}

function newLegacyBackendPreparedArtifactOperation(
  trainId: string,
  runId: string
): ReleaseBusV2OperationRecord {
  const prepared = operation(
    trainId,
    'PREPARE_ARTIFACT_BACKEND',
    'backend',
    runId
  );
  return {
    ...prepared,
    request_json: {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      workflow_control_sha: 'f'.repeat(40),
      inputs: {
        release_train_id: trainId,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: `release-bus-v2/staging-train-${trainId}-backend`,
        expected_sha: prepared.expected_sha!,
        deploy_units: '["api"]',
        deploy_layers: '[["api"]]',
        candidate_evidence_mode: 'legacy-whole-train',
        aggregate_candidate_evidence_digest: '',
        reuse_artifact_run_id: '',
        reuse_artifact_name: '',
        reuse_artifact_digest: '',
        artifact_contract_version: 'legacy-v2',
        artifact_environment: ''
      }
    },
    result_json: {
      summary: {
        artifact_digest: prepared.artifact_digest,
        schema_version: 2,
        artifact_contract: 'legacy-v2',
        artifact_contract_version: 'legacy-v2',
        repository: 'backend',
        source_sha: prepared.expected_sha,
        environment: 'portable',
        units: ['api'],
        layers: [['api']],
        source_evidence_reused: true,
        artifact_bytes_reused: false,
        ci_evidence: {
          mode: 'legacy-whole-train',
          artifact_run_id: null,
          artifact_name: null,
          artifact_digest: null,
          aggregate_candidate_evidence_digest: null
        },
        package_digests: { api: 'd'.repeat(64) },
        fresh_or_reused: 'fresh'
      }
    }
  };
}

function newLegacyFrontendPreparedArtifactOperation(
  trainId: string,
  runId: string,
  artifactEnvironment: 'staging' | 'production'
): ReleaseBusV2OperationRecord {
  const prepared = operation(
    trainId,
    'PREPARE_ARTIFACT_FRONTEND',
    'frontend',
    runId
  );
  return {
    ...prepared,
    request_json: {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      workflow_control_sha: 'f'.repeat(40),
      inputs: {
        release_train_id: trainId,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: `release-bus-v2/${artifactEnvironment}-train-${trainId}-frontend`,
        expected_sha: prepared.expected_sha!,
        deploy_units: '[]',
        candidate_evidence_mode: 'legacy-whole-train',
        aggregate_candidate_evidence_digest: '',
        reuse_artifact_run_id: '',
        reuse_artifact_name: '',
        reuse_artifact_digest: '',
        artifact_contract_version: 'legacy-v2',
        artifact_environment: artifactEnvironment
      }
    },
    result_json: {
      summary: {
        artifact_digest: prepared.artifact_digest,
        package_digest: 'e'.repeat(64),
        schema_version: 2,
        artifact_contract: null,
        artifact_contract_version: 'legacy-v2',
        repository: 'frontend',
        source_sha: prepared.expected_sha,
        environment: 'dual',
        fresh_or_reused: 'fresh-legacy-dual-profile',
        source_evidence_reused: false,
        artifact_bytes_reused: false,
        ci_evidence: null
      }
    }
  };
}

class InMemoryAcceptanceRepository {
  public readonly trains = new Map<string, ReleaseBusV2TrainRecord>();
  public readonly candidates = new Map<string, ReleaseBusV2CandidateRecord>();
  public readonly memberships: ReleaseBusV2TrainCandidateRecord[] = [];
  public readonly dependencies: ReleaseBusV2DependencyRecord[] = [];
  public readonly operations: ReleaseBusV2OperationRecord[] = [];
  public readonly manifests = new Map<string, ReleaseBusV2ManifestRecord>();
  public readonly events: Array<{
    readonly trainId?: string | null;
    readonly candidateId?: string | null;
    readonly eventType: string;
    readonly actor?: string | null;
    readonly payload?: unknown;
    readonly createdAt: number;
  }> = [];
  public readonly controls = new Map<
    ReleaseBusV2ControlRecord['scope'],
    ReleaseBusV2ControlRecord
  >(
    (['ALL', 'STAGING', 'PRODUCTION'] as const).map((scope) => [
      scope,
      {
        scope,
        paused: false,
        reason: null,
        github_actor: null,
        updated_at: 1,
        row_version: 1
      }
    ])
  );
  private eventClock = Date.now();
  public stagingState: ReleaseBusV2StagingStateRecord = {
    id: 'current',
    status: 'LIVE',
    current_manifest_id: 'baseline-manifest',
    last_validated_manifest_id: 'baseline-manifest',
    frontend_sha: FRONTEND_SHA,
    backend_sha: BACKEND_SHA,
    frontend_staging_ref_sha: FRONTEND_SHA,
    backend_staging_ref_sha: BACKEND_SHA,
    clean_main: false,
    last_transition_train_id: 'prior-train',
    updated_at: 1,
    row_version: 1
  };
  public lock: ReleaseBusV2LockRecord = {
    name: 'staging-environment',
    owner_train_id: null,
    lease_owner: null,
    lease_token: null,
    heartbeat_at: null,
    expires_at: null,
    updated_at: 1,
    row_version: 1
  };

  public async listControls(): Promise<ReleaseBusV2ControlRecord[]> {
    return Array.from(this.controls.values());
  }

  public async setControl(
    scope: ReleaseBusV2ControlRecord['scope'],
    paused: boolean,
    reason: string | null,
    actor: string | null
  ): Promise<void> {
    const current = this.controls.get(scope);
    if (!current) throw new Error(`Missing ${scope} control`);
    this.controls.set(scope, {
      ...current,
      paused,
      reason,
      github_actor: actor,
      updated_at: current.updated_at + 1,
      row_version: current.row_version + 1
    });
  }

  public async executeNativeQueriesInTransaction<T>(
    callback: (connection: unknown) => Promise<T>
  ): Promise<T> {
    return callback({});
  }

  public async getStagingState(): Promise<ReleaseBusV2StagingStateRecord> {
    return this.stagingState;
  }

  public async updateStagingState(
    rowVersion: number,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    if (rowVersion !== this.stagingState.row_version) return false;
    this.stagingState = {
      ...this.stagingState,
      status:
        (fields.status as ReleaseBusV2StagingStateRecord['status']) ??
        this.stagingState.status,
      current_manifest_id:
        fields.currentManifestId === undefined
          ? this.stagingState.current_manifest_id
          : (fields.currentManifestId as string | null),
      last_validated_manifest_id:
        fields.lastValidatedManifestId === undefined
          ? this.stagingState.last_validated_manifest_id
          : (fields.lastValidatedManifestId as string | null),
      frontend_sha:
        fields.frontendSha === undefined
          ? this.stagingState.frontend_sha
          : (fields.frontendSha as string | null),
      backend_sha:
        fields.backendSha === undefined
          ? this.stagingState.backend_sha
          : (fields.backendSha as string | null),
      frontend_staging_ref_sha:
        fields.frontendStagingRefSha === undefined
          ? this.stagingState.frontend_staging_ref_sha
          : (fields.frontendStagingRefSha as string | null),
      backend_staging_ref_sha:
        fields.backendStagingRefSha === undefined
          ? this.stagingState.backend_staging_ref_sha
          : (fields.backendStagingRefSha as string | null),
      clean_main:
        fields.cleanMain === undefined
          ? this.stagingState.clean_main
          : Boolean(fields.cleanMain),
      last_transition_train_id:
        fields.lastTransitionTrainId === undefined
          ? this.stagingState.last_transition_train_id
          : (fields.lastTransitionTrainId as string | null),
      updated_at: Date.now(),
      row_version: rowVersion + 1
    };
    return true;
  }

  public async listTrains(): Promise<ReleaseBusV2TrainRecord[]> {
    return Array.from(this.trains.values());
  }

  public async listCandidates(
    statuses: readonly ReleaseBusV2CandidateRecord['status'][]
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const selected = new Set(statuses);
    return Array.from(this.candidates.values()).filter((item) =>
      selected.has(item.status)
    );
  }

  public async findTrain(id: string): Promise<ReleaseBusV2TrainRecord | null> {
    return this.trains.get(id) ?? null;
  }

  public async listTrainCandidates(
    trainId: string
  ): Promise<ReleaseBusV2TrainCandidateRecord[]> {
    return this.memberships.filter((item) => item.train_id === trainId);
  }

  public async findCandidateById(
    id: string
  ): Promise<ReleaseBusV2CandidateRecord | null> {
    return this.candidates.get(id) ?? null;
  }

  public async listDependencies(
    candidateIds: readonly string[]
  ): Promise<ReleaseBusV2DependencyRecord[]> {
    const selected = new Set(candidateIds);
    return this.dependencies.filter((item) => selected.has(item.candidate_id));
  }

  public async updateCandidate(
    id: string,
    rowVersion: number,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const current = this.candidates.get(id);
    if (!current || current.row_version !== rowVersion) return false;
    this.candidates.set(id, {
      ...current,
      status:
        (fields.status as ReleaseBusV2CandidateRecord['status']) ??
        current.status,
      current_train_id:
        fields.currentTrainId === undefined
          ? current.current_train_id
          : (fields.currentTrainId as string | null),
      staging_validated_train_id:
        fields.stagingValidatedTrainId === undefined
          ? current.staging_validated_train_id
          : (fields.stagingValidatedTrainId as string | null),
      staging_validated_manifest_id:
        fields.stagingValidatedManifestId === undefined
          ? current.staging_validated_manifest_id
          : (fields.stagingValidatedManifestId as string | null),
      hold_reason:
        fields.holdReason === undefined
          ? current.hold_reason
          : (fields.holdReason as string | null),
      row_version: current.row_version + 1,
      updated_at: Date.now()
    });
    return true;
  }

  public async updateTrainCandidateDisposition(
    trainId: string,
    candidateId: string,
    disposition: string
  ): Promise<void> {
    const index = this.memberships.findIndex(
      (item) => item.train_id === trainId && item.candidate_id === candidateId
    );
    const membership = this.memberships[index];
    if (membership) this.memberships[index] = { ...membership, disposition };
  }

  public async updateTrain(
    id: string,
    rowVersion: number,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const current = this.trains.get(id);
    if (!current || current.row_version !== rowVersion) return false;
    this.trains.set(id, {
      ...current,
      status:
        (fields.status as ReleaseBusV2TrainRecord['status']) ?? current.status,
      frontend_composed_sha:
        fields.frontendComposedSha === undefined
          ? current.frontend_composed_sha
          : (fields.frontendComposedSha as string | null),
      backend_composed_sha:
        fields.backendComposedSha === undefined
          ? current.backend_composed_sha
          : (fields.backendComposedSha as string | null),
      frontend_artifact_digest:
        fields.frontendArtifactDigest === undefined
          ? current.frontend_artifact_digest
          : (fields.frontendArtifactDigest as string | null),
      backend_artifact_digest:
        fields.backendArtifactDigest === undefined
          ? current.backend_artifact_digest
          : (fields.backendArtifactDigest as string | null),
      manifest_id:
        fields.manifestId === undefined
          ? current.manifest_id
          : (fields.manifestId as string | null),
      failure_class:
        fields.failureClass === undefined
          ? current.failure_class
          : (fields.failureClass as ReleaseBusV2TrainRecord['failure_class']),
      failure_message:
        fields.failureMessage === undefined
          ? current.failure_message
          : (fields.failureMessage as string | null),
      recovery_message:
        fields.recoveryMessage === undefined
          ? current.recovery_message
          : (fields.recoveryMessage as string | null),
      completed_at:
        fields.completedAt === undefined
          ? current.completed_at
          : (fields.completedAt as number | null),
      phase_started_at: Date.now(),
      updated_at: Date.now(),
      row_version: current.row_version + 1
    });
    return true;
  }

  public async appendEvent(
    input: Omit<(typeof this.events)[number], 'createdAt'>
  ): Promise<void> {
    this.eventClock += 1;
    this.events.push({ ...input, createdAt: this.eventClock });
  }

  public async listEvents(trainId: string): Promise<
    Array<{
      readonly id: string;
      readonly train_id: string | null;
      readonly candidate_id: string | null;
      readonly event_type: string;
      readonly github_actor: string | null;
      readonly payload_json: unknown;
      readonly created_at: number;
    }>
  > {
    return this.events
      .filter((event) => event.trainId === trainId)
      .map((event, index) => ({
        id: `event-${index}`,
        train_id: event.trainId ?? null,
        candidate_id: event.candidateId ?? null,
        event_type: event.eventType,
        github_actor: event.actor ?? null,
        payload_json: event.payload ?? null,
        created_at: event.createdAt
      }))
      .reverse();
  }

  public async acquireLock(
    _name: string,
    ownerTrainId: string,
    leaseOwner: string
  ): Promise<ReleaseBusV2LockRecord | null> {
    if (this.lock.lease_owner && this.lock.lease_owner !== leaseOwner)
      return null;
    this.lock = {
      ...this.lock,
      owner_train_id: ownerTrainId,
      lease_owner: leaseOwner,
      lease_token: `${ownerTrainId}-lease-${this.lock.row_version}`,
      heartbeat_at: Date.now(),
      expires_at: Date.now() + 300_000,
      updated_at: Date.now(),
      row_version: this.lock.row_version + 1
    };
    return this.lock;
  }

  public async releaseLock(_name: string, token: string): Promise<boolean> {
    if (this.lock.lease_token !== token) return false;
    this.lock = {
      ...this.lock,
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: Date.now(),
      row_version: this.lock.row_version + 1
    };
    return true;
  }

  public async listLocks(): Promise<ReleaseBusV2LockRecord[]> {
    return [this.lock];
  }

  public async listOperations(
    trainId: string
  ): Promise<ReleaseBusV2OperationRecord[]> {
    return this.operations.filter((item) => item.train_id === trainId);
  }

  public async findOperation(
    idempotencyKey: string
  ): Promise<ReleaseBusV2OperationRecord | null> {
    return (
      this.operations.find((item) => item.idempotency_key === idempotencyKey) ??
      null
    );
  }

  public async getOrCreateOperation(input: {
    readonly idempotencyKey: string;
    readonly trainId: string;
    readonly operationType: string;
    readonly repository: 'frontend' | 'backend';
    readonly service: string | null;
    readonly environment: string;
    readonly expectedSha: string | null;
    readonly artifactDigest: string | null;
    readonly request: unknown;
    readonly maxAttempts: number;
  }): Promise<ReleaseBusV2OperationRecord> {
    const existing = await this.findOperation(input.idempotencyKey);
    if (existing) return existing;
    const now = Date.now();
    const created: ReleaseBusV2OperationRecord = {
      id: `operation-${this.operations.length + 1}`,
      idempotency_key: input.idempotencyKey,
      train_id: input.trainId,
      operation_type: input.operationType,
      repository: input.repository,
      service: input.service,
      environment: input.environment,
      expected_sha: input.expectedSha,
      artifact_digest: input.artifactDigest,
      external_id: null,
      status: 'PENDING',
      attempt: 1,
      max_attempts: input.maxAttempts,
      next_retry_at: null,
      failure_class: null,
      failure_message: null,
      request_json: input.request,
      result_json: null,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      row_version: 1
    };
    this.operations.push(created);
    return created;
  }

  public async updateOperation(
    id: string,
    rowVersion: number,
    fields: Partial<{
      readonly status: ReleaseBusV2OperationRecord['status'];
      readonly externalId: string | null;
      readonly result: unknown;
      readonly failureClass: ReleaseBusV2OperationRecord['failure_class'];
      readonly failureMessage: string | null;
      readonly attempt: number;
      readonly completedAt: number | null;
    }>
  ): Promise<boolean> {
    const index = this.operations.findIndex((item) => item.id === id);
    const current = this.operations[index];
    if (!current || current.row_version !== rowVersion) return false;
    this.operations[index] = {
      ...current,
      status: fields.status ?? current.status,
      external_id:
        fields.externalId === undefined
          ? current.external_id
          : fields.externalId,
      result_json:
        fields.result === undefined ? current.result_json : fields.result,
      failure_class:
        fields.failureClass === undefined
          ? current.failure_class
          : fields.failureClass,
      failure_message:
        fields.failureMessage === undefined
          ? current.failure_message
          : fields.failureMessage,
      attempt: fields.attempt ?? current.attempt,
      completed_at:
        fields.completedAt === undefined
          ? current.completed_at
          : fields.completedAt,
      updated_at: Date.now(),
      row_version: current.row_version + 1
    };
    return true;
  }

  public async createManifest(
    input: Omit<ReleaseBusV2ManifestRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ReleaseBusV2ManifestRecord> {
    const existing = Array.from(this.manifests.values()).find(
      (item) => item.identity_sha256 === input.identity_sha256
    );
    if (existing) return existing;
    const created: ReleaseBusV2ManifestRecord = {
      ...input,
      id: `manifest-${this.manifests.size + 1}`,
      created_at: Date.now(),
      updated_at: Date.now()
    };
    this.manifests.set(created.id, created);
    return created;
  }

  public async findManifest(
    id: string
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.manifests.get(id) ?? null;
  }

  public async updateManifestStatus(
    id: string,
    status: ReleaseBusV2ManifestRecord['status'],
    e2eRunId: string | null
  ): Promise<void> {
    const current = this.manifests.get(id);
    if (!current) throw new Error('manifest missing');
    this.manifests.set(id, {
      ...current,
      status,
      e2e_run_id: e2eRunId,
      validated_at: status === 'STAGING_VALIDATED' ? Date.now() : null,
      updated_at: Date.now()
    });
  }
}

function harness(e2eStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED') {
  const repository = new InMemoryAcceptanceRepository();
  const backend = candidate('backend-candidate', 'backend', {
    units: ['dbMigrationsLoop', 'ethPriceLoop', 'api'],
    edges: [['dbMigrationsLoop', 'api']]
  });
  const frontend = candidate('frontend-candidate', 'frontend', null);
  repository.candidates.set(backend.id, backend);
  repository.candidates.set(frontend.id, frontend);
  repository.trains.set('train-1', train('train-1'));
  repository.memberships.push(
    {
      id: 'membership-backend',
      train_id: 'train-1',
      candidate_id: backend.id,
      sequence: 1,
      disposition: 'INCLUDED',
      created_at: 1
    },
    {
      id: 'membership-frontend',
      train_id: 'train-1',
      candidate_id: frontend.id,
      sequence: 2,
      disposition: 'INCLUDED',
      created_at: 1
    }
  );
  repository.dependencies.push({
    id: 'dependency',
    candidate_id: frontend.id,
    prerequisite_candidate_id: backend.id,
    environment: 'BOTH',
    created_at: 1
  });
  repository.operations.push(
    preparedArtifactOperation('train-1', 'frontend', '101'),
    preparedArtifactOperation('train-1', 'backend', '102')
  );
  const service = {
    claimLane: jest.fn(async () => null),
    preserveProductionIntentsForSafeReplan: jest.fn(
      async ({
        trainId,
        reason
      }: {
        readonly trainId: string;
        readonly reason: string;
      }) => {
        const currentTrain = repository.trains.get(trainId);
        if (!currentTrain)
          return { status: 'NOOP', trainId, reason: 'missing train' } as const;
        const irreversible = repository.operations.find(
          (item) =>
            item.train_id === trainId &&
            irreversibleProductionOperationReason(item) !== null
        );
        if (irreversible) {
          repository.trains.set(trainId, {
            ...currentTrain,
            status: 'PAUSED',
            recovery_message: 'Original exact membership remains frozen',
            row_version: currentTrain.row_version + 1
          });
          return {
            status: 'FROZEN',
            trainId,
            reason: `irreversible ${irreversible.operation_type}`
          } as const;
        }
        const candidateIds = repository.memberships
          .filter(
            (membership) =>
              membership.train_id === trainId &&
              membership.disposition === 'INCLUDED'
          )
          .map(({ candidate_id }) => candidate_id);
        for (const candidateId of candidateIds) {
          const current = repository.candidates.get(candidateId);
          if (!current) continue;
          repository.candidates.set(candidateId, {
            ...current,
            status: 'WAITING_FOR_PRODUCTION_REPLAN',
            current_train_id: null,
            hold_reason: reason,
            row_version: current.row_version + 1
          });
        }
        repository.trains.set(trainId, {
          ...currentTrain,
          status: 'CANCELLED',
          failure_class: 'INTERACTION',
          failure_message: reason,
          completed_at: Date.now(),
          row_version: currentTrain.row_version + 1
        });
        return {
          status: 'REPLANNED',
          trainId,
          candidateIds,
          sourceSelectionIds: []
        } as const;
      }
    ),
    repairTerminalCumulativeCarryForwardStatuses: jest.fn(async () => []),
    setPaused: jest.fn(
      async (
        scope: ReleaseBusV2ControlRecord['scope'],
        paused: boolean,
        reason: string,
        actor: string
      ) => {
        const prior = repository.controls.get(scope);
        if (!prior) throw new Error(`Missing ${scope} control`);
        repository.controls.set(scope, {
          ...prior,
          paused,
          reason,
          github_actor: actor,
          updated_at: prior.updated_at + 1,
          row_version: prior.row_version + 1
        });
      }
    ),
    invalidateBranch: jest.fn(async () => undefined),
    restoreProductionReadinessAfterBranchCleanup: jest.fn(
      async () => undefined
    ),
    resolveCandidateStagingEvidence: jest.fn(async () => []),
    yieldUnsatisfiableProductionQualification: jest.fn(
      async ({
        qualificationTrainId
      }: {
        readonly qualificationTrainId: string;
      }) => {
        const qualification = repository.trains.get(qualificationTrainId);
        const parent = qualification?.parent_train_id
          ? repository.trains.get(qualification.parent_train_id)
          : null;
        if (!qualification || !parent)
          throw new Error('qualification parent missing');
        if (
          qualification.status === 'CANCELLED' &&
          parent.status === 'CANCELLED'
        )
          return {
            yielded: false,
            parentTrainId: parent.id,
            qualificationTrainId: qualification.id,
            candidateIds: []
          };
        const candidateIds = repository.memberships
          .filter(
            (membership) =>
              membership.train_id === parent.id &&
              membership.disposition === 'INCLUDED'
          )
          .map(({ candidate_id }) => candidate_id);
        repository.trains.set(qualification.id, {
          ...qualification,
          status: 'CANCELLED',
          completed_at: Date.now(),
          row_version: qualification.row_version + 1
        });
        repository.trains.set(parent.id, {
          ...parent,
          status: 'CANCELLED',
          completed_at: Date.now(),
          row_version: parent.row_version + 1
        });
        repository.events.push({
          trainId: qualification.id,
          eventType: 'PRODUCTION_QUALIFICATION_YIELDED',
          actor: 'release-bus-v2',
          createdAt: Date.now()
        });
        for (const candidateId of candidateIds) {
          const current = repository.candidates.get(candidateId);
          if (!current) continue;
          repository.candidates.set(candidateId, {
            ...current,
            status: 'WAITING_FOR_PRODUCTION_REPLAN',
            current_train_id: null,
            hold_reason: 'Waiting for a safe combined production replan',
            row_version: current.row_version + 1
          });
        }
        return {
          yielded: true,
          parentTrainId: parent.id,
          qualificationTrainId: qualification.id,
          candidateIds
        };
      }
    ),
    isBetaTrainAllowed: jest.fn(async () => true)
  };
  return {
    repository,
    service,
    reconciler: new ReleaseBusV2Reconciler(
      repository as never,
      service as never
    ),
    e2eStatus
  };
}

function acceptanceLaneSnapshot(
  repository: InMemoryAcceptanceRepository,
  lane: 'STAGING' | 'PRODUCTION'
): unknown {
  const trainIds = new Set(
    Array.from(repository.trains.values())
      .filter((item) => item.lane === lane)
      .map(({ id }) => id)
  );
  return JSON.parse(
    JSON.stringify({
      control: repository.controls.get(lane),
      trains: Array.from(repository.trains.values())
        .filter(({ id }) => trainIds.has(id))
        .sort((left, right) => left.id.localeCompare(right.id)),
      memberships: repository.memberships
        .filter(({ train_id }) => trainIds.has(train_id))
        .sort((left, right) => left.id.localeCompare(right.id)),
      operations: repository.operations
        .filter(({ train_id }) => trainIds.has(train_id))
        .sort((left, right) => left.id.localeCompare(right.id)),
      manifests: Array.from(repository.manifests.values())
        .filter((manifest) => manifest.lane === lane)
        .sort((left, right) => left.id.localeCompare(right.id)),
      environment_lock:
        repository.lock.name ===
        (lane === 'STAGING' ? 'staging-environment' : 'production-environment')
          ? repository.lock
          : null
    })
  );
}

describe('Release Bus v2 offline acceptance harness', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousBetaAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;

  beforeEach(() => {
    jest.resetAllMocks();
    mockImmutableRefs.clear();
    mockCreateRef.mockImplementation(
      async (repository: string, ref: string, sha: string) => {
        const key = `${repository}:${ref}`;
        const existing = mockImmutableRefs.get(key);
        if (existing && existing !== sha)
          throw new Error('immutable release ref already points elsewhere');
        mockImmutableRefs.set(key, sha);
      }
    );
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    mockHasActiveStagingRun.mockResolvedValue(false);
    mockHasStagingRunSince.mockResolvedValue(false);
    mockHasActiveProductionRun.mockResolvedValue(false);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend', ref: string) => {
        if (ref.startsWith('feature/'))
          return repository === 'frontend' ? '3'.repeat(40) : '4'.repeat(40);
        return repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA;
      }
    );
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    mockRefContainsCommit.mockResolvedValue(false);
  });

  it('does not claim or advance any durable work while mode is OFF', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';

    await expect(state.reconciler.runOnce('acceptance-off')).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
  });

  it('supersedes a moved active staging head, drains only dispatched work, and replans on the next tick', async () => {
    const state = harness('SUCCEEDED');
    const active = train('train-1', {
      status: 'PREFLIGHTING',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest'
    });
    state.repository.trains.set(active.id, active);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role: 'NEW'
      }))
    );
    const frontend = state.repository.candidates.get('frontend-candidate')!;
    const backend = state.repository.candidates.get('backend-candidate')!;
    const newerHead = '9'.repeat(40);
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend', ref: string) => {
        if (ref === frontend.branch_name) return newerHead;
        if (ref === backend.branch_name) return backend.head_sha;
        return repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA;
      }
    );
    state.service.invalidateBranch.mockImplementation(
      async (...args: unknown[]) => {
        const branchName = String(args[1]);
        const stale = Array.from(state.repository.candidates.values()).find(
          ({ branch_name }) => branch_name === branchName
        );
        if (!stale) return;
        state.repository.candidates.set(stale.id, {
          ...stale,
          status: 'SUPERSEDED',
          superseded_at: Date.now(),
          row_version: stale.row_version + 1
        });
      }
    );
    const backendOperationIndex = state.repository.operations.findIndex(
      ({ operation_type }) => operation_type === 'PREPARE_ARTIFACT_BACKEND'
    );
    const frontendOperationIndex = state.repository.operations.findIndex(
      ({ operation_type }) => operation_type === 'PREPARE_ARTIFACT_FRONTEND'
    );
    const pending = {
      ...state.repository.operations[frontendOperationIndex]!,
      external_id: null,
      status: 'PENDING' as const,
      started_at: null,
      completed_at: null
    };
    state.repository.operations[frontendOperationIndex] = pending;
    const operationIdsBeforeDrain = state.repository.operations.map(
      ({ id }) => id
    );
    const running = {
      ...state.repository.operations[backendOperationIndex]!,
      status: 'RUNNING' as const,
      completed_at: null,
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {
          release_train_id: active.id,
          expected_sha: BACKEND_SHA
        }
      }
    };
    state.repository.operations[backendOperationIndex] = running;
    mockReconcileWorkflow.mockResolvedValue(running);
    mockFindWorkflowRun.mockResolvedValue({
      id: running.external_id,
      status: 'in_progress',
      conclusion: null
    });

    await state.reconciler.runOnce('active-head-moved-wait');

    expect(state.repository.candidates.get(frontend.id)).toMatchObject({
      status: 'SUPERSEDED',
      current_train_id: active.id
    });
    expect(state.repository.candidates.get(backend.id)?.status).toBe(
      'STAGING_BUILDING'
    );
    expect(state.repository.trains.get(active.id)).toMatchObject({
      status: 'PREFLIGHTING',
      recovery_message: expect.stringContaining(
        'no further operations will be dispatched'
      )
    });
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        mockReconcileWorkflow.mock.calls.map(([input]) =>
          String(input.idempotencyKey)
        )
      )
    ).toEqual(new Set([running.idempotency_key]));
    expect(
      mockReconcileWorkflow.mock.calls.some(([input]) =>
        String(input.operationType).startsWith('ISOLATE_')
      )
    ).toBe(false);
    expect(state.repository.operations[frontendOperationIndex]).toMatchObject({
      id: pending.id,
      external_id: null,
      status: 'PENDING'
    });
    expect(state.repository.operations.map(({ id }) => id)).toEqual(
      operationIdsBeforeDrain
    );

    state.repository.operations[backendOperationIndex] = {
      ...running,
      status: 'SUCCEEDED',
      completed_at: Date.now(),
      row_version: running.row_version + 1
    };
    mockFindWorkflowRun.mockResolvedValue({
      id: running.external_id,
      status: 'completed',
      conclusion: 'success'
    });

    await state.reconciler.runOnce('active-head-moved-replan');

    expect(state.repository.candidates.get(frontend.id)).toMatchObject({
      status: 'SUPERSEDED',
      current_train_id: null
    });
    expect(state.repository.candidates.get(backend.id)).toMatchObject({
      status: 'READY_FOR_STAGING',
      current_train_id: null
    });
    expect(state.repository.trains.get(active.id)).toMatchObject({
      status: 'CANCELLED',
      completed_at: expect.any(Number)
    });
    expect(state.repository.operations[frontendOperationIndex]).toMatchObject({
      id: pending.id,
      external_id: null,
      status: 'CANCELLED'
    });
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
  });

  it('releases a terminal train lock in OFF mode only after all operations are terminal', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: 4
      })
    );
    await state.repository.acquireLock(
      'staging-environment',
      'train-1',
      'train:train-1'
    );

    await expect(
      state.reconciler.runOnce('acceptance-terminal-lock')
    ).resolves.toEqual({ mode: 'OFF', claimed: [], advanced: [] });
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: 'train-1'
      })
    );
  });

  it('fails the first CLEAN_MAIN cumulative train locally, preserves intent, and holds its lease until dispatched work is terminal', async () => {
    const state = harness('SUCCEEDED');
    const active = train('train-1', {
      status: 'DEPLOYING',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: null,
      staging_transition_json: {
        new_candidate_ids: ['backend-candidate'],
        carried_candidate_ids: ['frontend-candidate'],
        removed_candidate_ids: []
      },
      failure_class: 'INFRASTRUCTURE',
      failure_message: 'staging API deploy failed'
    });
    state.repository.trains.set(active.id, active);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role:
          membership.candidate_id === 'backend-candidate'
            ? ('NEW' as const)
            : ('CARRY_FORWARD' as const)
      }))
    );
    state.repository.stagingState = {
      ...state.repository.stagingState,
      status: 'CLEAN_MAIN',
      current_manifest_id: null,
      last_validated_manifest_id: null,
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_staging_ref_sha: FRONTEND_SHA,
      backend_staging_ref_sha: BACKEND_SHA,
      clean_main: true,
      last_transition_train_id: null
    };
    const runningOperation: ReleaseBusV2OperationRecord = {
      ...operation(active.id, 'DEPLOY_BACKEND_API', 'backend', '501', 'api'),
      id: 'running-staging-api',
      idempotency_key: `rb2:${active.id}:deploy:backend:api`,
      environment: 'staging',
      status: 'RUNNING',
      completed_at: null,
      request_json: {
        workflow: 'deploy.yml',
        ref: active.backend_composed_sha,
        inputs: {
          release_train_id: active.id,
          expected_sha: active.backend_composed_sha
        }
      }
    };
    state.repository.operations.splice(
      0,
      state.repository.operations.length,
      runningOperation
    );
    await state.repository.acquireLock(
      'staging-environment',
      active.id,
      `train:${active.id}`
    );
    mockReconcileWorkflow.mockResolvedValue(runningOperation);
    const productionBefore = structuredClone(
      state.repository.controls.get('PRODUCTION')
    );
    const allBefore = structuredClone(state.repository.controls.get('ALL'));
    const carriedBefore = structuredClone(
      state.repository.candidates.get('frontend-candidate')
    );
    const privateReconciler = state.reconciler as unknown as {
      beginCumulativeStagingRollback(
        train: ReleaseBusV2TrainRecord,
        failureClass: 'INFRASTRUCTURE',
        message: string
      ): Promise<void>;
      releaseTerminalEnvironmentLocks(): Promise<void>;
    };

    await privateReconciler.beginCumulativeStagingRollback(
      active,
      'INFRASTRUCTURE',
      'staging API deploy failed'
    );

    expect(state.repository.trains.get(active.id)).toMatchObject({
      status: 'STAGING_ROLLBACK_FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: expect.any(Number)
    });
    expect(state.repository.stagingState).toMatchObject({
      status: 'ROLLBACK_FAILED',
      current_manifest_id: null,
      last_validated_manifest_id: null,
      frontend_staging_ref_sha: FRONTEND_SHA,
      backend_staging_ref_sha: BACKEND_SHA,
      clean_main: false,
      last_transition_train_id: active.id
    });
    expect(state.repository.candidates.get('backend-candidate')).toMatchObject({
      status: 'READY_FOR_STAGING',
      current_train_id: null
    });
    expect(state.repository.candidates.get('frontend-candidate')).toEqual(
      carriedBefore
    );
    expect(state.repository.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trainId: active.id,
          eventType: 'CUMULATIVE_STAGING_CLEAN_MAIN_RECOVERY_REQUIRED'
        }),
        expect.objectContaining({
          trainId: active.id,
          eventType: 'CUMULATIVE_STAGING_ROLLBACK_FAILED'
        })
      ])
    );
    expect(state.repository.controls.get('STAGING')).toMatchObject({
      paused: true,
      github_actor: 'release-bus-v2'
    });
    expect(state.repository.controls.get('PRODUCTION')).toEqual(
      productionBefore
    );
    expect(state.repository.controls.get('ALL')).toEqual(allBefore);
    expect(state.repository.lock.owner_train_id).toBe(active.id);

    state.repository.operations[0] = {
      ...runningOperation,
      status: 'SUCCEEDED',
      completed_at: Date.now(),
      row_version: runningOperation.row_version + 1
    };
    await privateReconciler.releaseTerminalEnvironmentLocks();

    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        trainId: active.id,
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED'
      })
    );
  });

  it('retries a manual staging-ref drift row-version race without changing either lane or ALL', async () => {
    const state = harness('SUCCEEDED');
    const active = train('train-1', {
      status: 'WAITING_FOR_ENVIRONMENT',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest'
    });
    state.repository.trains.set(active.id, active);
    const controlsBefore = structuredClone(
      Array.from(state.repository.controls.entries())
    );
    const candidatesBefore = structuredClone(
      Array.from(state.repository.candidates.entries())
    );
    const trainBefore = structuredClone(state.repository.trains.get(active.id));
    const stagingBefore = structuredClone(state.repository.stagingState);
    const eventsBefore = structuredClone(state.repository.events);
    jest
      .spyOn(state.repository, 'updateStagingState')
      .mockResolvedValueOnce(false);
    const privateReconciler = state.reconciler as unknown as {
      failStagingForRefDrift(
        train: ReleaseBusV2TrainRecord,
        message: string
      ): Promise<void>;
    };

    await expect(
      privateReconciler.failStagingForRefDrift(
        active,
        'staging ref changed concurrently'
      )
    ).resolves.toBeUndefined();

    expect(Array.from(state.repository.controls.entries())).toEqual(
      controlsBefore
    );
    expect(Array.from(state.repository.candidates.entries())).toEqual(
      candidatesBefore
    );
    expect(state.repository.trains.get(active.id)).toEqual(trainBefore);
    expect(state.repository.stagingState).toEqual(stagingBefore);
    expect(state.repository.events).toEqual(eventsBefore);
    expect(state.service.setPaused).not.toHaveBeenCalled();
  });

  it('reconciles a stranded terminal main operation before releasing its lock', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const failed = train('terminal-production', {
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: 4
    });
    state.repository.trains.set(failed.id, failed);
    state.repository.operations.push({
      ...operation(failed.id, 'ADVANCE_MAIN_BACKEND', 'backend', 'unused'),
      id: 'stranded-main-operation',
      idempotency_key: `rb2:${failed.id}:advance-main:backend`,
      expected_sha: failed.backend_composed_sha,
      external_id: null,
      status: 'PENDING',
      failure_class: null,
      failure_message: null,
      completed_at: null
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      failed.id,
      `train:${failed.id}`
    );
    mockResolveRef.mockResolvedValue(failed.backend_base_sha);

    await state.reconciler.runOnce('acceptance-terminal-ref-reconciliation');

    expect(
      state.repository.operations.find(
        (item) => item.id === 'stranded-main-operation'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: expect.any(Number)
      })
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'TERMINAL_INTERNAL_REF_OPERATION_RECONCILED',
          trainId: failed.id,
          payload: expect.objectContaining({
            repository: 'backend',
            operation_status: 'FAILED',
            observed_sha: failed.backend_base_sha
          })
        }),
        expect.objectContaining({
          eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
          trainId: failed.id
        })
      ])
    );
  });

  it('retains a terminal lock when a stranded main operation is still ambiguous', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const failed = train('ambiguous-production', {
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: 4
    });
    state.repository.trains.set(failed.id, failed);
    state.repository.operations.push({
      ...operation(failed.id, 'ADVANCE_MAIN_BACKEND', 'backend', 'unused'),
      id: 'ambiguous-main-operation',
      idempotency_key: `rb2:${failed.id}:advance-main:backend`,
      expected_sha: failed.backend_composed_sha,
      external_id: null,
      status: 'PENDING',
      completed_at: null
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      failed.id,
      `train:${failed.id}`
    );
    mockResolveRef.mockResolvedValue('9'.repeat(40));

    await state.reconciler.runOnce('acceptance-ambiguous-terminal-ref');

    expect(
      state.repository.operations.find(
        (item) => item.id === 'ambiguous-main-operation'
      )?.status
    ).toBe('PENDING');
    expect(state.repository.lock.owner_train_id).toBe(failed.id);
    expect(state.repository.events).not.toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: failed.id
      })
    );
  });

  it('pauses only beta automation when the OFF allowlist is malformed', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = 'not-json';

    await expect(
      state.reconciler.runOnce('acceptance-invalid-beta')
    ).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'ALL',
      true,
      expect.stringContaining('allowlist is invalid'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).not.toHaveBeenCalled();
  });

  it('pauses only production for an invalid STAGING-mode beta allowlist', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = 'not-json';
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-invalid-production-beta')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'PRODUCTION',
      true,
      expect.stringContaining('staging remains enabled'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-invalid-production-beta:staging',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('resumes only a beta-owned production pause after allowlist repair', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-repaired',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-repaired',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.controls.set('PRODUCTION', {
      scope: 'PRODUCTION',
      paused: true,
      reason: 'invalid beta config',
      github_actor: 'release-bus-v2-beta',
      updated_at: 2,
      row_version: 2
    });
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-repaired-production-beta')
    ).resolves.toEqual({ mode: 'STAGING', claimed: [], advanced: [] });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'PRODUCTION',
      false,
      expect.stringContaining('recovered'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).toHaveBeenCalledTimes(2);
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      2,
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-repaired-production-beta:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('keeps per-lane pause and resume controls independent on every scheduler tick', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await state.service.setPaused(
      'STAGING',
      true,
      'staging-only maintenance',
      'acceptance'
    );
    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('staging-paused');
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'staging-paused:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(false);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);

    await state.service.setPaused(
      'STAGING',
      false,
      'staging resumed',
      'acceptance'
    );
    await state.service.setPaused(
      'PRODUCTION',
      true,
      'production-only maintenance',
      'acceptance'
    );
    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('production-paused');
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'production-paused:staging',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
    expect(state.repository.controls.get('STAGING')?.paused).toBe(false);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);

    await state.service.setPaused(
      'PRODUCTION',
      false,
      'production resumed',
      'acceptance'
    );
    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('both-resumed');
    expect(
      (state.service.claimLane.mock.calls as unknown[][]).map(([lane]) => lane)
    ).toEqual(['STAGING', 'PRODUCTION']);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
  });

  it('claims ordinary staging and allowlisted production independently in STAGING mode', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-one',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-staging-production-beta')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      1,
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-staging-production-beta:staging',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      2,
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-staging-production-beta:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('continues unrelated reconciliation after a carry repair row-version race', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );
    state.service.repairTerminalCumulativeCarryForwardStatuses.mockRejectedValueOnce(
      new Error('Candidate changed concurrently')
    );

    await expect(
      state.reconciler.runOnce('acceptance-carry-repair-race')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-carry-repair-race:staging',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('repairs an allowlisted production candidate after its exact merged branch is deleted', async () => {
    const state = harness('SUCCEEDED');
    const candidateId = '11111111-1111-4111-8111-111111111111';
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-branch-cleanup',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-production-branch-cleanup',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );
    const merged = {
      ...candidate(candidateId, 'frontend', null),
      branch_name: 'agent/rb2-production-branch-cleanup',
      requested_by: 'beta-operator',
      status: 'SUPERSEDED' as const,
      current_train_id: null,
      staging_validated_manifest_id: 'manifest-1',
      production_requested_at: 2,
      production_requested_by: 'beta-operator',
      superseded_at: 3
    };
    state.repository.candidates.set(candidateId, merged);
    mockResolveRefIfExists.mockImplementation(async (_repository, branch) =>
      branch === merged.branch_name ? null : FRONTEND_SHA
    );
    mockRefContainsCommit.mockResolvedValue(true);

    await state.reconciler.runOnce('acceptance-branch-cleanup');

    expect(mockRefContainsCommit).toHaveBeenCalledWith(
      'frontend',
      'main',
      merged.head_sha
    );
    expect(
      state.service.restoreProductionReadinessAfterBranchCleanup
    ).toHaveBeenCalledWith(candidateId, 'release-bus-v2-reconciler');
    expect(state.service.invalidateBranch).not.toHaveBeenCalledWith(
      'frontend',
      merged.branch_name,
      'deleted',
      expect.any(String)
    );
  });

  it('still supersedes an explicit production candidate when its branch moves', async () => {
    const state = harness('SUCCEEDED');
    const candidateId = '11111111-1111-4111-8111-111111111111';
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-branch-move',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-production-branch-move',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );
    const ready = {
      ...candidate(candidateId, 'frontend', null),
      branch_name: 'agent/rb2-production-branch-move',
      requested_by: 'beta-operator',
      status: 'READY_FOR_PRODUCTION' as const,
      current_train_id: null,
      staging_validated_manifest_id: 'manifest-1',
      production_requested_at: 2,
      production_requested_by: 'beta-operator'
    };
    state.repository.candidates.set(candidateId, ready);
    const movedHead = '9'.repeat(40);
    mockResolveRefIfExists.mockImplementation(async (_repository, branch) =>
      branch === ready.branch_name ? movedHead : FRONTEND_SHA
    );

    await state.reconciler.runOnce('acceptance-branch-move');

    expect(mockRefContainsCommit).not.toHaveBeenCalled();
    expect(state.service.invalidateBranch).toHaveBeenCalledWith(
      'frontend',
      ready.branch_name,
      movedHead,
      'release-bus-v2-reconciler',
      undefined
    );
  });

  it('does not advance an unallowlisted production train in STAGING mode', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-one',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION', status: 'PREPARED' })
    );
    state.service.isBetaTrainAllowed.mockResolvedValue(false);

    await expect(
      state.reconciler.runOnce('acceptance-unlisted-production-train')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('enters the OFF beta lane but does not advance an unallowlisted active train', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    state.service.isBetaTrainAllowed.mockResolvedValue(false);

    await expect(state.reconciler.runOnce('acceptance-beta')).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-beta:staging',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
  });

  it('double-checks idle refs around the staging lock before a beta mutation', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    const updateTrain = state.repository.updateTrain.bind(state.repository);
    jest
      .spyOn(state.repository, 'updateTrain')
      .mockImplementation(async (id, rowVersion, fields) => {
        const updated = await updateTrain(id, rowVersion, fields);
        const trainAfterUpdate = state.repository.trains.get(id);
        if (updated && trainAfterUpdate) {
          state.repository.trains.set(id, {
            ...trainAfterUpdate,
            row_version: rowVersion
          });
        }
        return updated;
      });

    const result = await state.reconciler.runOnce('acceptance-beta-idle');
    expect({
      result,
      train: state.repository.trains.get('train-1'),
      events: state.repository.events,
      lock: state.repository.lock
    }).toMatchObject({
      result: { mode: 'OFF', claimed: [], advanced: ['train-1'] },
      train: { status: 'DEPLOYING' },
      lock: { owner_train_id: 'train-1' }
    });
    expect(mockHasActiveStagingRun).toHaveBeenCalledTimes(4);
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'BETA_STAGING_IDLE_HANDSHAKE',
        trainId: 'train-1',
        payload: expect.objectContaining({
          staging_lock: 'owned',
          workflow_fence_started_at: expect.any(Number),
          verified_at: expect.any(Number)
        })
      })
    );
  });

  it('binds an unchanged repository to the exact shared staging ref before deployment', async () => {
    const state = harness('SUCCEEDED');
    const backendStagingSha = 'e'.repeat(40);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'frontend-candidate'
      )!
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend', ref: string) => {
        expect(ref).toBe('1a-staging');
        return repository === 'frontend' ? 'f'.repeat(40) : backendStagingSha;
      }
    );

    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_base_sha: '1'.repeat(40),
        backend_base_sha: '2'.repeat(40),
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: backendStagingSha
      })
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_ENVIRONMENT_IDENTITY_BOUND',
        trainId: 'train-1',
        payload: expect.objectContaining({
          frontend_sha: FRONTEND_SHA,
          backend_sha: backendStagingSha,
          frontend_from_existing_staging: false,
          backend_from_existing_staging: true
        })
      })
    );
  });

  it('CAS-advances the exact paired staging release before any coupled deployment', async () => {
    const state = harness('SUCCEEDED');
    const frontendBase = 'e'.repeat(40);
    const backendBase = 'f'.repeat(40);
    const exactTrain = train('train-1', {
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: frontendBase,
        baseline_backend_sha: backendBase,
        observed_frontend_staging_sha: frontendBase,
        observed_backend_staging_sha: backendBase,
        new_candidate_ids: ['backend-candidate', 'frontend-candidate'],
        carried_candidate_ids: []
      }
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role: 'NEW'
      }))
    );
    const refs = new Map([
      ['frontend', frontendBase],
      ['backend', backendBase]
    ]);
    mockResolveRefIfExists.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockResolveRef.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    let runId = 900;
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      expect(spec.workflow).toBe('release-bus-v2-advance-staging-ref.yml');
      expect(refs.get(spec.repository)).toBe(spec.inputs.expected_old_sha);
      refs.set(spec.repository, spec.expectedSha);
      const completed = stagingRefWorkflowOperation(
        spec,
        String((runId += 1)),
        true
      );
      state.repository.operations.push(completed);
      return completed;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(
      mockReconcileWorkflow.mock.calls.map(
        ([spec]) => (spec as StagingRefWorkflowSpec).inputs
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expected_old_sha: backendBase,
          expected_sha: BACKEND_SHA,
          phase: 'release'
        }),
        expect.objectContaining({
          expected_old_sha: frontendBase,
          expected_sha: FRONTEND_SHA,
          phase: 'release'
        })
      ])
    );
    expect(refs).toEqual(
      new Map([
        ['frontend', FRONTEND_SHA],
        ['backend', BACKEND_SHA]
      ])
    );
    expect(state.repository.trains.get(exactTrain.id)?.status).toBe(
      'DEPLOYING'
    );
    expect(state.repository.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_RELEASE_BACKEND',
          expected_sha: BACKEND_SHA,
          status: 'SUCCEEDED'
        }),
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_RELEASE_FRONTEND',
          expected_sha: FRONTEND_SHA,
          status: 'SUCCEEDED'
        })
      ])
    );
  });

  it('retains the staging lease while an owned ref workflow is nonterminal', async () => {
    const state = harness('SUCCEEDED');
    const frontendBase = 'e'.repeat(40);
    const backendBase = 'f'.repeat(40);
    const exactTrain = train('train-1', {
      frontend_composed_sha: frontendBase,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: frontendBase,
        baseline_backend_sha: backendBase,
        observed_frontend_staging_sha: frontendBase,
        observed_backend_staging_sha: backendBase,
        new_candidate_ids: ['backend-candidate'],
        carried_candidate_ids: ['frontend-candidate']
      }
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role:
          membership.candidate_id === 'backend-candidate'
            ? ('NEW' as const)
            : ('CARRY_FORWARD' as const)
      }))
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend', ref: string) => {
        if (ref.startsWith('feature/'))
          return repository === 'frontend' ? '3'.repeat(40) : '4'.repeat(40);
        return repository === 'frontend' ? frontendBase : backendBase;
      }
    );
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      const running: ReleaseBusV2OperationRecord = {
        ...stagingRefWorkflowOperation(spec, '901', false),
        status: 'RUNNING',
        result_json: null,
        completed_at: null
      };
      state.repository.operations.push(running);
      return running;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get(exactTrain.id)?.status).toBe('PREPARED');
    expect(state.repository.lock).toMatchObject({
      owner_train_id: exactTrain.id,
      lease_owner: `train:${exactTrain.id}`,
      lease_token: expect.any(String)
    });
    expect(state.repository.operations).toContainEqual(
      expect.objectContaining({
        operation_type: 'ADVANCE_STAGING_RELEASE_BACKEND',
        status: 'RUNNING'
      })
    );
    expect(
      state.repository.operations.some(({ operation_type }) =>
        operation_type.startsWith('DEPLOY_')
      )
    ).toBe(false);
  });

  it.each(['malformed success evidence', 'terminal workflow failure'] as const)(
    'fails %s through the STAGING-only control-plane handler without a reconcile loop',
    async (scenario) => {
      const state = harness('SUCCEEDED');
      const frontendBase = 'e'.repeat(40);
      const backendBase = 'f'.repeat(40);
      const exactTrain = train('train-1', {
        frontend_composed_sha: frontendBase,
        staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
        staging_baseline_manifest_id: 'baseline-manifest',
        staging_transition_json: {
          actor: 'acceptance',
          requested_at: 1,
          baseline_state_version: 1,
          baseline_manifest_id: 'baseline-manifest',
          baseline_frontend_sha: frontendBase,
          baseline_backend_sha: backendBase,
          observed_frontend_staging_sha: frontendBase,
          observed_backend_staging_sha: backendBase,
          new_candidate_ids: ['backend-candidate'],
          carried_candidate_ids: ['frontend-candidate']
        }
      });
      state.repository.trains.set(exactTrain.id, exactTrain);
      state.repository.memberships.splice(
        0,
        state.repository.memberships.length,
        ...state.repository.memberships.map((membership) => ({
          ...membership,
          candidate_role:
            membership.candidate_id === 'backend-candidate'
              ? ('NEW' as const)
              : ('CARRY_FORWARD' as const)
        }))
      );
      const allBefore = structuredClone(state.repository.controls.get('ALL'));
      const productionBefore = structuredClone(
        state.repository.controls.get('PRODUCTION')
      );
      const carriedBefore = structuredClone(
        state.repository.candidates.get('frontend-candidate')
      );
      mockResolveRefIfExists.mockImplementation(
        async (repository: 'frontend' | 'backend', ref: string) => {
          if (ref.startsWith('feature/'))
            return repository === 'frontend' ? '3'.repeat(40) : '4'.repeat(40);
          return repository === 'frontend' ? frontendBase : backendBase;
        }
      );
      mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
        const spec = rawSpec as StagingRefWorkflowSpec;
        const completed = stagingRefWorkflowOperation(spec, '901', false);
        const operation: ReleaseBusV2OperationRecord =
          scenario === 'malformed success evidence'
            ? {
                ...completed,
                result_json: {
                  phase: 'advance_staging_ref',
                  status: 'SUCCEEDED',
                  summary: null
                }
              }
            : {
                ...completed,
                status: 'FAILED',
                failure_class: 'CONTROL_PLANE',
                failure_message: 'staging-ref callback failed closed',
                result_json: {
                  phase: 'advance_staging_ref',
                  status: 'FAILED',
                  failure_class: 'CONTROL_PLANE',
                  failure_phase: 'authorization',
                  retryable: false,
                  summary: null
                }
              };
        state.repository.operations.push(operation);
        return operation;
      });

      await expect(
        state.reconciler.runOnce(`acceptance-${scenario.replace(/ /g, '-')}`)
      ).resolves.toEqual({
        mode: 'STAGING',
        claimed: [],
        advanced: []
      });

      expect(state.repository.trains.get(exactTrain.id)).toMatchObject({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: expect.any(Number)
      });
      expect(
        state.repository.candidates.get('backend-candidate')
      ).toMatchObject({
        status: 'READY_FOR_STAGING',
        current_train_id: null
      });
      expect(state.repository.candidates.get('frontend-candidate')).toEqual(
        carriedBefore
      );
      expect(state.repository.controls.get('STAGING')).toMatchObject({
        paused: true,
        github_actor: 'release-bus-v2'
      });
      expect(state.repository.controls.get('ALL')).toEqual(allBefore);
      expect(state.repository.controls.get('PRODUCTION')).toEqual(
        productionBefore
      );
      expect(state.repository.lock.owner_train_id).toBeNull();
      expect(state.repository.events).not.toContainEqual(
        expect.objectContaining({ eventType: 'STAGING_REF_DRIFT_DETECTED' })
      );
      expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);

      await state.reconciler.runOnce(
        'acceptance-terminal-ref-protocol-failure'
      );
      expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    }
  );

  it('moves only the affected repository for a single-repo cumulative train', async () => {
    const state = harness('SUCCEEDED');
    const frontendBase = 'e'.repeat(40);
    const backendBase = 'f'.repeat(40);
    const exactTrain = train('train-1', {
      frontend_composed_sha: frontendBase,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: frontendBase,
        baseline_backend_sha: backendBase,
        observed_frontend_staging_sha: frontendBase,
        observed_backend_staging_sha: backendBase,
        new_candidate_ids: ['backend-candidate'],
        carried_candidate_ids: ['frontend-candidate']
      }
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role:
          membership.candidate_id === 'backend-candidate'
            ? 'NEW'
            : 'CARRY_FORWARD'
      }))
    );
    const refs = new Map([
      ['frontend', frontendBase],
      ['backend', backendBase]
    ]);
    mockResolveRefIfExists.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockResolveRef.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      expect(spec.repository).toBe('backend');
      expect(refs.get(spec.repository)).toBe(spec.inputs.expected_old_sha);
      refs.set(spec.repository, spec.expectedSha);
      const completed = stagingRefWorkflowOperation(spec, '901', true);
      state.repository.operations.push(completed);
      return completed;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    expect(() =>
      (
        state.reconciler as unknown as {
          bindStagingEnvironmentIdentity(
            input: typeof context,
            snapshot: {
              frontend_staging_sha: string;
              backend_staging_sha: string;
            }
          ): unknown;
        }
      ).bindStagingEnvironmentIdentity(context, {
        frontend_staging_sha: '9'.repeat(40),
        backend_staging_sha: backendBase
      })
    ).toThrow('frontend 1a-staging moved outside train');

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'ADVANCE_STAGING_RELEASE_BACKEND',
        expectedSha: BACKEND_SHA,
        inputs: expect.objectContaining({
          expected_old_sha: backendBase,
          expected_sha: BACKEND_SHA,
          phase: 'release'
        })
      })
    );
    expect(refs.get('frontend')).toBe(frontendBase);
  });

  it('fails a moved staging CAS closed before deployment dispatch', async () => {
    const state = harness('SUCCEEDED');
    const frontendBase = 'e'.repeat(40);
    const backendBase = 'f'.repeat(40);
    const backendDrift = '9'.repeat(40);
    const exactTrain = train('train-1', {
      frontend_composed_sha: frontendBase,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: frontendBase,
        baseline_backend_sha: backendBase,
        observed_frontend_staging_sha: frontendBase,
        observed_backend_staging_sha: backendBase,
        new_candidate_ids: ['backend-candidate'],
        carried_candidate_ids: ['frontend-candidate']
      }
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role:
          membership.candidate_id === 'backend-candidate'
            ? 'NEW'
            : 'CARRY_FORWARD'
      }))
    );
    const refs = new Map([
      ['frontend', frontendBase],
      ['backend', backendBase]
    ]);
    state.repository.stagingState = {
      ...state.repository.stagingState,
      frontend_sha: frontendBase,
      backend_sha: backendBase,
      frontend_staging_ref_sha: frontendBase,
      backend_staging_ref_sha: backendBase
    };
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) =>
        ref === '1a-staging'
          ? refs.get(repository)
          : repository === 'frontend'
            ? '3'.repeat(40)
            : '4'.repeat(40)
    );
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? exactTrain.frontend_base_sha
            : exactTrain.backend_base_sha
          : refs.get(repository)
    );
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      refs.set(spec.repository, backendDrift);
      const failed: ReleaseBusV2OperationRecord = {
        ...stagingRefWorkflowOperation(spec, '901', false),
        status: 'FAILED',
        failure_class: 'INTERACTION',
        failure_message: 'staging_ref_moved failed',
        completed_at: Date.now(),
        result_json: {
          phase: 'advance_staging_ref',
          status: 'FAILED',
          failure_class: 'INTERACTION',
          failure_phase: 'staging_ref_moved',
          retryable: false,
          summary: {
            ref: '1a-staging',
            phase: 'release',
            expected_old_sha: backendBase,
            release_sha: BACKEND_SHA,
            observed_sha: backendDrift,
            changed: false
          }
        }
      };
      state.repository.operations.push(failed);
      return failed;
    });
    await expect(
      state.reconciler.runOnce('acceptance-moved-staging-cas')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });

    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(state.repository.stagingState).toEqual(
      expect.objectContaining({
        status: 'ROLLBACK_FAILED',
        current_manifest_id: null,
        frontend_staging_ref_sha: frontendBase,
        backend_staging_ref_sha: backendDrift,
        last_transition_train_id: exactTrain.id
      })
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        trainId: exactTrain.id,
        eventType: 'STAGING_REF_DRIFT_DETECTED',
        payload: expect.objectContaining({
          deployment_started: false,
          recover_with: 'SERIALIZED_MANUAL_STAGING_RECOVERY'
        })
      })
    );
    expect(state.repository.controls.get('STAGING')).toEqual(
      expect.objectContaining({ paused: true })
    );
    expect(state.repository.trains.get(exactTrain.id)).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        failure_message: expect.stringContaining(
          `backend 1a-staging moved from ${backendBase} to ${backendDrift}`
        ),
        recovery_message: expect.stringContaining('serialized recovery')
      })
    );
    expect(state.repository.operations).toContainEqual(
      expect.objectContaining({
        operation_type: 'ADVANCE_STAGING_RELEASE_BACKEND',
        status: 'FAILED',
        failure_class: 'INTERACTION'
      })
    );
  });

  it('retries an unchanged staging ref after transient CAS transport failure', async () => {
    const state = harness('SUCCEEDED');
    const baseSha = 'f'.repeat(40);
    const targetSha = '8'.repeat(40);
    const exactTrain = train('transient-staging-cas', {
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    let currentSha = baseSha;
    mockReconcileWorkflow
      .mockImplementationOnce(async (rawSpec) => {
        const spec = rawSpec as StagingRefWorkflowSpec;
        return {
          ...stagingRefWorkflowOperation(spec, '901', false),
          status: 'RETRY_WAIT',
          external_id: '901',
          failure_class: 'INFRASTRUCTURE',
          failure_message: 'staging_ref_transport failed',
          next_retry_at: Date.now() + 1_000,
          completed_at: null
        };
      })
      .mockImplementationOnce(async (rawSpec) => {
        const spec = rawSpec as StagingRefWorkflowSpec;
        currentSha = targetSha;
        return stagingRefWorkflowOperation(spec, '902', true);
      });
    mockResolveRef.mockImplementation(async () => currentSha);
    const advance = () =>
      (
        state.reconciler as unknown as {
          advanceStagingRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string,
            baseSha: string,
            targetSha: string,
            phase: 'release'
          ): Promise<boolean>;
        }
      ).advanceStagingRef(
        exactTrain,
        'backend',
        baseSha,
        baseSha,
        targetSha,
        'release'
      );

    await expect(advance()).resolves.toBe(false);
    await expect(advance()).resolves.toBe(true);
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it('re-verifies an already-applied staging CAS before recording success', async () => {
    const state = harness('SUCCEEDED');
    const baseSha = 'f'.repeat(40);
    const targetSha = '8'.repeat(40);
    const movedSha = '9'.repeat(40);
    const exactTrain = train('moved-after-staging-cas', {
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    mockResolveRef.mockResolvedValue(movedSha);
    mockReconcileWorkflow.mockImplementation(async (rawSpec) =>
      stagingRefWorkflowOperation(
        rawSpec as StagingRefWorkflowSpec,
        '901',
        false
      )
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceStagingRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string,
            baseSha: string,
            targetSha: string,
            phase: 'release'
          ): Promise<boolean>;
        }
      ).advanceStagingRef(
        exactTrain,
        'backend',
        targetSha,
        baseSha,
        targetSha,
        'release'
      )
    ).rejects.toThrow(
      `backend 1a-staging moved after exact release CAS from ${targetSha} to ${movedSha}`
    );

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
  });

  it('self-drains a crash after staging CAS without repeating the ref mutation', async () => {
    const state = harness('SUCCEEDED');
    const frontendBase = 'e'.repeat(40);
    const backendBase = 'f'.repeat(40);
    const exactTrain = train('train-1', {
      frontend_composed_sha: frontendBase,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: frontendBase,
        baseline_backend_sha: backendBase,
        observed_frontend_staging_sha: frontendBase,
        observed_backend_staging_sha: backendBase,
        new_candidate_ids: ['backend-candidate'],
        carried_candidate_ids: ['frontend-candidate']
      }
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role:
          membership.candidate_id === 'backend-candidate'
            ? 'NEW'
            : 'CARRY_FORWARD'
      }))
    );
    const refs = new Map([
      ['frontend', frontendBase],
      // GitHub accepted the CAS before the worker crashed, but the durable
      // operation did not yet record success.
      ['backend', BACKEND_SHA]
    ]);
    mockResolveRefIfExists.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockResolveRef.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const completed = stagingRefWorkflowOperation(
        rawSpec as StagingRefWorkflowSpec,
        '901',
        false
      );
      state.repository.operations.push(completed);
      return completed;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(state.repository.operations).toContainEqual(
      expect.objectContaining({
        operation_type: 'ADVANCE_STAGING_RELEASE_BACKEND',
        status: 'SUCCEEDED',
        external_id: '901'
      })
    );
    expect(state.repository.trains.get(exactTrain.id)?.status).toBe(
      'DEPLOYING'
    );
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
  });

  it('rolls staging refs forward from the failed release to immutable restore commits', async () => {
    const state = harness('SUCCEEDED');
    const frontendRestoreRelease = '7'.repeat(40);
    const backendRestoreRelease = '8'.repeat(40);
    const exactTrain = train('train-1', {
      status: 'STAGING_ROLLING_BACK',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role: 'NEW'
      }))
    );
    const refs = new Map([
      ['frontend', FRONTEND_SHA],
      ['backend', BACKEND_SHA]
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    let runId = 910;
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      expect(refs.get(spec.repository)).toBe(spec.inputs.expected_old_sha);
      refs.set(spec.repository, spec.expectedSha);
      const completed = stagingRefWorkflowOperation(
        spec,
        String((runId += 1)),
        true
      );
      state.repository.operations.push(completed);
      return completed;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceCumulativeRollbackRefs(
          input: typeof context,
          frontendReleaseSha: string,
          backendReleaseSha: string
        ): Promise<boolean>;
      }
    ).advanceCumulativeRollbackRefs(
      context,
      frontendRestoreRelease,
      backendRestoreRelease
    );

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(
      mockReconcileWorkflow.mock.calls.map(
        ([spec]) => (spec as StagingRefWorkflowSpec).inputs
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expected_old_sha: BACKEND_SHA,
          expected_sha: backendRestoreRelease,
          phase: 'rollback'
        }),
        expect.objectContaining({
          expected_old_sha: FRONTEND_SHA,
          expected_sha: frontendRestoreRelease,
          phase: 'rollback'
        })
      ])
    );
    expect(state.repository.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_ROLLBACK_BACKEND',
          expected_sha: backendRestoreRelease,
          status: 'SUCCEEDED'
        }),
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_ROLLBACK_FRONTEND',
          expected_sha: frontendRestoreRelease,
          status: 'SUCCEEDED'
        })
      ])
    );
  });

  it('resumes rollback when one staging CAS applied before the worker crashed', async () => {
    const state = harness('SUCCEEDED');
    const frontendRestoreRelease = '7'.repeat(40);
    const backendRestoreRelease = '8'.repeat(40);
    const exactTrain = train('train-1', {
      status: 'STAGING_ROLLING_BACK',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role: 'NEW'
      }))
    );
    const refs = new Map([
      ['frontend', FRONTEND_SHA],
      ['backend', backendRestoreRelease]
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      refs.get(repository)
    );
    mockReconcileWorkflow.mockImplementation(async (rawSpec) => {
      const spec = rawSpec as StagingRefWorkflowSpec;
      const changed = refs.get(spec.repository) !== spec.expectedSha;
      if (changed) {
        expect(refs.get(spec.repository)).toBe(spec.inputs.expected_old_sha);
        refs.set(spec.repository, spec.expectedSha);
      }
      const completed = stagingRefWorkflowOperation(
        spec,
        spec.repository === 'backend' ? '911' : '912',
        changed
      );
      state.repository.operations.push(completed);
      return completed;
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceCumulativeRollbackRefs(
          input: typeof context,
          frontendReleaseSha: string,
          backendReleaseSha: string
        ): Promise<boolean>;
      }
    ).advanceCumulativeRollbackRefs(
      context,
      frontendRestoreRelease,
      backendRestoreRelease
    );

    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(state.repository.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_ROLLBACK_BACKEND',
          status: 'SUCCEEDED',
          external_id: '911',
          result_json: expect.objectContaining({
            summary: expect.objectContaining({ changed: false })
          })
        }),
        expect.objectContaining({
          operation_type: 'ADVANCE_STAGING_ROLLBACK_FRONTEND',
          status: 'SUCCEEDED',
          external_id: '912',
          result_json: expect.objectContaining({
            summary: expect.objectContaining({ changed: true })
          })
        })
      ])
    );
  });

  it('preserves candidate identity when rolling back a historical manifest without candidate_id fields', async () => {
    const state = harness('SUCCEEDED');
    const baselineManifestId = 'historical-baseline-manifest';
    const backendCandidate =
      state.repository.candidates.get('backend-candidate')!;
    const exactTrain = train('train-1', {
      status: 'STAGING_ROLLING_BACK',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: baselineManifestId
    });
    state.repository.manifests.set(baselineManifestId, {
      id: baselineManifestId,
      train_id: 'historical-train',
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_VALIDATED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: 'historical-e2e',
      manifest_json: {
        candidates: [
          {
            repository: backendCandidate.repository,
            pr_number: backendCandidate.pr_number,
            head_sha: backendCandidate.head_sha
          }
        ]
      },
      deployed_at: 1,
      validated_at: 2,
      created_at: 1,
      updated_at: 2
    });
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await expect(
      (
        state.reconciler as unknown as {
          cumulativeRollbackBaseline(
            input: typeof context
          ): Promise<{ candidateIds: readonly string[] }>;
        }
      ).cumulativeRollbackBaseline(context)
    ).resolves.toEqual(
      expect.objectContaining({ candidateIds: [backendCandidate.id] })
    );
  });

  it('transactionally yields exact production qualification when an unchanged repository differs in staging', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );

    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(state.repository.trains.get('production-parent')?.status).toBe(
      'CANCELLED'
    );
    expect(state.repository.candidates.get('frontend-candidate')).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        current_train_id: null
      })
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
    expect(
      state.service.yieldUnsatisfiableProductionQualification
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationTrainId: 'train-1',
        stagingIdentity: {
          frontendSha: FRONTEND_SHA,
          backendSha: 'e'.repeat(40)
        }
      })
    );
  });

  it('does not repeat a yielded qualification on overlapping reconciles', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await Promise.all([
      (
        state.reconciler as unknown as {
          advanceStagingOrQualification(input: typeof context): Promise<void>;
        }
      ).advanceStagingOrQualification(context),
      (
        state.reconciler as unknown as {
          advanceStagingOrQualification(input: typeof context): Promise<void>;
        }
      ).advanceStagingOrQualification(context)
    ]);

    expect(state.repository.trains.get('train-1')?.status).toBe('CANCELLED');
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
    expect(
      state.repository.events.filter(
        ({ eventType }) => eventType === 'PRODUCTION_QUALIFICATION_YIELDED'
      )
    ).toHaveLength(1);
  });

  it('recovers a stalled qualification in STAGING mode only while PRODUCTION is paused and staging is idle', async () => {
    const state = harness('SUCCEEDED');
    state.repository.controls.set('PRODUCTION', {
      ...state.repository.controls.get('PRODUCTION')!,
      paused: true
    });
    jest
      .spyOn(state.repository, 'listLocks')
      .mockResolvedValue(
        ['scheduler', 'staging-environment', 'production-environment'].map(
          (name) => ({ ...state.repository.lock, name })
        )
      );
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );
    state.repository.trains.set(
      'second-production-parent',
      train('second-production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'second-qualification'
      })
    );
    state.repository.trains.set(
      'second-qualification',
      train('second-qualification', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'second-production-parent'
      })
    );

    const result =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );

    expect(result).toEqual({
      recovered: [
        {
          parent_train_id: 'production-parent',
          qualification_train_id: 'train-1',
          candidate_ids: ['frontend-candidate']
        }
      ],
      staging_identity: {
        frontend_sha: FRONTEND_SHA,
        backend_sha: 'e'.repeat(40)
      },
      has_more: true
    });
    expect(state.repository.trains.get('train-1')?.status).toBe('CANCELLED');
    expect(state.repository.trains.get('production-parent')?.status).toBe(
      'CANCELLED'
    );
    expect(state.repository.trains.get('second-qualification')?.status).toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(state.repository.lock.lease_token).toBeNull();

    const second =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );
    expect(second).toEqual(
      expect.objectContaining({
        recovered: [
          expect.objectContaining({
            parent_train_id: 'second-production-parent',
            qualification_train_id: 'second-qualification'
          })
        ],
        has_more: true
      })
    );

    const drained =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );
    expect(drained).toEqual(
      expect.objectContaining({
        recovered: [],
        has_more: false
      })
    );
    expect(state.repository.lock.lease_token).toBeNull();
  });

  it('rejects STAGING-mode maintenance recovery while PRODUCTION is running', async () => {
    const state = harness('SUCCEEDED');

    await expect(
      state.reconciler.recoverUnsatisfiableProductionQualifications('operator')
    ).rejects.toThrow(
      'requires PRODUCTION to be paused while STAGING remains enabled'
    );
    expect(
      state.service.yieldUnsatisfiableProductionQualification
    ).not.toHaveBeenCalled();
  });

  it('allows a coupled qualification to replace both unrelated staging repositories', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? 'e'.repeat(40) : 'f'.repeat(40)
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_base_sha: '1'.repeat(40),
        backend_base_sha: '2'.repeat(40),
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
  });

  it('binds the immutable frontend workflow ref before starting exact production qualification', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'frontend-candidate'
      )!
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? 'e'.repeat(40) : BACKEND_SHA
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(mockCreateRef).toHaveBeenCalledWith(
      'frontend',
      'release-bus-v2/qualification-train-train-1-frontend',
      FRONTEND_SHA
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_ENVIRONMENT_IDENTITY_BOUND',
        trainId: 'train-1',
        payload: expect.objectContaining({
          frontend_sha: FRONTEND_SHA,
          backend_sha: BACKEND_SHA,
          backend_from_existing_staging: false
        })
      })
    );
  });

  it('fails before acquiring staging when the qualification workflow ref cannot be bound', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockCreateRef.mockRejectedValueOnce(
      new Error('immutable qualification ref conflict')
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceStagingOrQualification(input: typeof context): Promise<void>;
        }
      ).advanceStagingOrQualification(context)
    ).rejects.toThrow('immutable qualification ref conflict');

    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.lock.lease_token).toBeNull();
    expect(mockResolveRefIfExists).not.toHaveBeenCalled();
  });

  it('rebinds the same immutable qualification ref safely after an idle-handshake retry', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    mockHasActiveStagingRun
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')?.status).toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(state.repository.lock.owner_train_id).toBeNull();

    const retriedContext = {
      ...context,
      train: state.repository.trains.get('train-1')!
    };
    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(
          input: typeof retriedContext
        ): Promise<void>;
      }
    ).advanceStagingOrQualification(retriedContext);

    expect(mockCreateRef).toHaveBeenCalledTimes(2);
    expect(mockCreateRef).toHaveBeenNthCalledWith(
      1,
      'frontend',
      'release-bus-v2/qualification-train-train-1-frontend',
      FRONTEND_SHA
    );
    expect(mockCreateRef).toHaveBeenNthCalledWith(
      2,
      'frontend',
      'release-bus-v2/qualification-train-train-1-frontend',
      FRONTEND_SHA
    );
    expect(state.repository.trains.get('train-1')?.status).toBe('DEPLOYING');
    expect(state.repository.lock.owner_train_id).toBe('train-1');
  });

  it('releases the production beta lock when the post-lock idle snapshot fails', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION',
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    let resolveCalls = 0;
    mockResolveRef.mockImplementation(async (repository: string) => {
      resolveCalls += 1;
      if (resolveCalls > 2) throw new Error('GitHub ref lookup failed');
      return repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA;
    });

    await expect(
      (
        state.reconciler as unknown as {
          advanceProduction(input: typeof context): Promise<void>;
        }
      ).advanceProduction(context)
    ).rejects.toThrow('GitHub ref lookup failed');
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.lock.lease_token).toBeNull();
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousBetaAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousBetaAllowlist;
  });

  it('serializes only dependency edges, binds E2E to the exact manifest, and is duplicate-safe', async () => {
    const state = harness('SUCCEEDED');
    let activeBackend = 0;
    let maximumBackend = 0;
    const sequence: string[] = [];
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        service: string | null;
        inputs: Record<string, string>;
        artifactDigest: string | null;
      };
      if (typed.operationType.startsWith('DEPLOY_BACKEND')) {
        activeBackend += 1;
        maximumBackend = Math.max(maximumBackend, activeBackend);
        sequence.push(`start:${typed.service}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        sequence.push(`finish:${typed.service}`);
        activeBackend -= 1;
        const completed = operation(
          'train-1',
          typed.operationType,
          'backend',
          `backend-${typed.service}`,
          typed.service
        );
        state.repository.operations.push(completed);
        return completed;
      }
      if (typed.operationType === 'DEPLOY_FRONTEND_STAGING') {
        sequence.push('start:frontend');
        const completed = operation(
          'train-1',
          typed.operationType,
          'frontend',
          'frontend-deploy'
        );
        state.repository.operations.push(completed);
        return completed;
      }
      expect(typed.inputs.release_manifest_id).toBe('manifest-1');
      expect(typed.inputs.frontend_sha).toBe(FRONTEND_SHA);
      expect(typed.inputs.backend_sha).toBe(BACKEND_SHA);
      expect(typed.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
      const completed = operation(
        'train-1',
        'E2E_STAGING',
        'frontend',
        'e2e-run'
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-success');

    expect(state.repository.trains.get('train-1')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(state.repository.candidates.get('backend-candidate')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(state.repository.candidates.get('frontend-candidate')?.status).toBe(
      'STAGING_VALIDATED'
    );
    const manifest = Array.from(state.repository.manifests.values())[0];
    expect(manifest).toEqual(
      expect.objectContaining({
        status: 'STAGING_VALIDATED',
        frontend_sha: FRONTEND_SHA,
        backend_sha: BACKEND_SHA,
        frontend_artifact_digest: FRONTEND_DIGEST,
        backend_artifact_digest: BACKEND_DIGEST,
        e2e_run_id: 'e2e-run'
      })
    );
    expect(maximumBackend).toBe(2);
    expect(sequence.indexOf('start:api')).toBeGreaterThan(
      sequence.indexOf('finish:dbMigrationsLoop')
    );
    expect(sequence.indexOf('start:frontend')).toBeGreaterThan(
      sequence.indexOf('finish:api')
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_IDLE_HANDSHAKE',
        trainId: 'train-1'
      })
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_FINAL_FENCE_VERIFIED',
        trainId: 'train-1'
      })
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);

    const externalCalls = mockReconcileWorkflow.mock.calls.length;
    await state.reconciler.runOnce('acceptance-duplicate');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(externalCalls);
  });

  it('ignores every exact retried workflow attempt in the final staging fence', async () => {
    const state = harness('SUCCEEDED');
    mockFindWorkflowRun.mockResolvedValue({ id: 101 });
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        service: string | null;
      };
      const repository =
        typed.operationType.includes('FRONTEND') ||
        typed.operationType === 'E2E_STAGING'
          ? 'frontend'
          : 'backend';
      const completed = operation(
        'train-1',
        typed.operationType,
        repository,
        typed.operationType === 'E2E_STAGING'
          ? '202'
          : `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      const retried =
        typed.operationType === 'E2E_STAGING'
          ? {
              ...completed,
              idempotency_key: 'rb2:train-1:e2e:staging',
              attempt: 2,
              max_attempts: 2,
              request_json: { workflow: 'staging-e2e.yml' }
            }
          : completed;
      state.repository.operations.push(retried);
      return retried;
    });

    await state.reconciler.runOnce('acceptance-retried-final-fence');

    expect(state.repository.trains.get('train-1')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(mockFindWorkflowRun).toHaveBeenCalledWith(
      'frontend',
      'staging-e2e.yml',
      'rb2:train-1:e2e:staging:a1'
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);
    for (const [, , ignoredRunIds] of mockHasStagingRunSince.mock.calls) {
      expect(ignoredRunIds).toEqual(expect.arrayContaining(['101', '202']));
    }
  });

  it('fails closed when an unrelated staging workflow ran after the beta handshake', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'frontend-only-fence',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'frontend',
        branch_name: 'agent/rb2-beta-frontend-fence',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockHasStagingRunSince.mockResolvedValue(true);
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ||
          typed.operationType === 'E2E_STAGING'
          ? 'frontend'
          : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-beta-final-fence');

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        failure_message: expect.stringContaining('Shared staging')
      })
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status === 'READY_FOR_STAGING'
      )
    ).toBe(true);
    expect(Array.from(state.repository.manifests.values())[0]?.status).toBe(
      'FAILED'
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'STAGING',
      true,
      expect.stringContaining('control-plane failure'),
      'release-bus-v2'
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'BETA_STAGING_FINAL_FENCE_VIOLATED',
        trainId: 'train-1'
      })
    );
    const expectedRunIds = new Set(
      state.repository.operations
        .map(({ external_id }) => external_id)
        .filter(
          (runId): runId is string =>
            runId !== null && /^[1-9][0-9]{0,19}$/.test(runId)
        )
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);
    for (const [, , ignoredRunIds] of mockHasStagingRunSince.mock.calls) {
      expect(ignoredRunIds).toHaveLength(expectedRunIds.size);
      expect(new Set(ignoredRunIds as string[])).toEqual(expectedRunIds);
    }
  });

  it('keeps staging locked and prevents a second mutation while exact E2E is running', async () => {
    const state = harness('RUNNING');
    state.repository.trains.set(
      'train-2',
      train('train-2', { created_at: 2, updated_at: 2 })
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      if (typed.operationType === 'E2E_STAGING') {
        const running = {
          ...operation('train-1', 'E2E_STAGING', 'frontend', 'e2e-running'),
          status: 'RUNNING' as const,
          completed_at: null
        };
        state.repository.operations.push(running);
        return running;
      }
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ? 'frontend' : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-lock');

    expect(state.repository.trains.get('train-1')?.status).toBe('E2E_RUNNING');
    expect(state.repository.trains.get('train-2')?.status).toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(
      mockReconcileWorkflow.mock.calls.some(
        ([spec]) =>
          (spec as { trainId?: string }).trainId === 'train-2' &&
          (spec as { operationType?: string }).operationType?.startsWith(
            'DEPLOY'
          )
      )
    ).toBe(false);
  });

  it('never marks a failed E2E manifest staging validated or globally pauses', async () => {
    const state = harness('FAILED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const productionBefore = acceptanceLaneSnapshot(
      state.repository,
      'PRODUCTION'
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      if (typed.operationType === 'E2E_STAGING') {
        const failed = {
          ...operation('train-1', 'E2E_STAGING', 'frontend', 'e2e-failed'),
          status: 'FAILED' as const,
          failure_class: 'E2E' as const,
          failure_message: 'read-only pack failed'
        };
        state.repository.operations.push(failed);
        return failed;
      }
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ? 'frontend' : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-e2e-failure');

    expect(state.repository.trains.get('train-1')?.status).toBe('FAILED');
    expect(Array.from(state.repository.manifests.values())[0]?.status).toBe(
      'STAGING_DEPLOYED'
    );
    expect(state.service.setPaused).not.toHaveBeenCalled();
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status !== 'STAGING_VALIDATED'
      )
    ).toBe(true);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(false);
    expect(acceptanceLaneSnapshot(state.repository, 'PRODUCTION')).toEqual(
      productionBefore
    );

    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('acceptance-e2e-failure-next-tick');
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-e2e-failure-next-tick:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('requeues staging without globally pausing when artifact callback retries are exhausted', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const productionBefore = acceptanceLaneSnapshot(
      state.repository,
      'PRODUCTION'
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        status: 'PREFLIGHTING',
        frontend_artifact_digest: null
      })
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        service: string | null;
      };
      if (typed.operationType === 'PREPARE_ARTIFACT_FRONTEND') {
        return {
          ...operation(
            'train-1',
            'PREPARE_ARTIFACT_FRONTEND',
            'frontend',
            'callback-failed'
          ),
          status: 'FAILED' as const,
          attempt: 3,
          max_attempts: 3,
          failure_class: 'INFRASTRUCTURE' as const,
          failure_message:
            'GitHub workflow concluded failure without a structured terminal callback'
        };
      }
      throw new Error(`Unexpected operation ${typed.operationType}`);
    });

    await state.reconciler.runOnce('acceptance-preflight-callback-exhausted');

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'INFRASTRUCTURE',
        failure_message:
          'GitHub workflow concluded failure without a structured terminal callback'
      })
    );
    expect(
      Array.from(state.repository.candidates.values()).map(
        ({ status, current_train_id }) => ({ status, current_train_id })
      )
    ).toEqual([
      { status: 'READY_FOR_STAGING', current_train_id: null },
      { status: 'READY_FOR_STAGING', current_train_id: null }
    ]);
    expect(state.service.setPaused).not.toHaveBeenCalled();
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(false);
    expect(acceptanceLaneSnapshot(state.repository, 'PRODUCTION')).toEqual(
      productionBefore
    );

    state.service.claimLane.mockClear();
    await state.reconciler.runOnce(
      'acceptance-preflight-callback-exhausted-next-tick'
    );
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-preflight-callback-exhausted-next-tick:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('requeues a production plan when candidate-bearing main moves before qualification', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const stagingSentinel = train('staging-admitted-sentinel', {
      status: 'STAGING_VALIDATED',
      completed_at: 2
    });
    state.repository.trains.set(stagingSentinel.id, stagingSentinel);
    state.repository.memberships.push(
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        id: `staging-sentinel-${membership.id}`,
        train_id: stagingSentinel.id
      }))
    );
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(production.id, production);
    const stagingBefore = acceptanceLaneSnapshot(state.repository, 'STAGING');
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
        current_train_id: production.id
      });
    }
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await state.reconciler.runOnce('acceptance-production-main-moved');

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        failure_class: 'INTERACTION',
        failure_message: expect.stringContaining('frontend main moved')
      })
    );
    expect(
      Array.from(state.repository.candidates.values()).map(
        ({ status, current_train_id }) => ({ status, current_train_id })
      )
    ).toEqual([
      { status: 'WAITING_FOR_PRODUCTION_REPLAN', current_train_id: null },
      { status: 'WAITING_FOR_PRODUCTION_REPLAN', current_train_id: null }
    ]);
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(acceptanceLaneSnapshot(state.repository, 'STAGING')).toEqual(
      stagingBefore
    );
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
  });

  it.each([
    { lane: 'STAGING' as const, target: 'staging' as const },
    { lane: 'PRODUCTION' as const, target: 'production' as const }
  ])(
    'routes a $lane source-ref interaction callback through only the exact $target replan',
    async ({ lane, target }) => {
      const state = harness('SUCCEEDED');
      const current = train('train-1', {
        lane,
        status: 'PREFLIGHTING',
        frontend_artifact_digest: null,
        backend_artifact_digest: null
      });
      state.repository.trains.set(current.id, current);
      const movedProduction = jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(target === 'production');
      const supersededStaging = jest
        .fn()
        .mockResolvedValue(target === 'staging');
      const failedInteraction = {
        ...operation(
          current.id,
          'PREPARE_ARTIFACT_FRONTEND',
          'frontend',
          'source-ref-moved'
        ),
        status: 'FAILED' as const,
        failure_class: 'INTERACTION' as const,
        failure_message: 'source_ref_moved failed'
      };
      Object.assign(state.reconciler as object, {
        deferMovedProductionPlan: movedProduction,
        deferSupersededStagingPlan: supersededStaging,
        prepareRepository: jest.fn(
          async (_context: unknown, repository: 'frontend' | 'backend') =>
            repository === 'frontend'
              ? {
                  repository,
                  composedSha: FRONTEND_SHA,
                  artifactDigest: null,
                  pending: false,
                  failedOperation: failedInteraction
                }
              : {
                  repository,
                  composedSha: BACKEND_SHA,
                  artifactDigest: BACKEND_DIGEST,
                  pending: false,
                  failedOperation: null
                }
        )
      });
      const context = {
        train: current,
        memberships: state.repository.memberships,
        candidates: Array.from(state.repository.candidates.values()),
        dependencies: state.repository.dependencies
      };

      await (
        state.reconciler as unknown as {
          advancePreparation(input: typeof context): Promise<void>;
        }
      ).advancePreparation(context);

      if (target === 'production') {
        expect(movedProduction).toHaveBeenCalledTimes(2);
        expect(supersededStaging).not.toHaveBeenCalled();
      } else {
        expect(movedProduction).toHaveBeenCalledTimes(1);
        expect(supersededStaging).toHaveBeenCalledTimes(1);
      }
      expect(state.service.setPaused).not.toHaveBeenCalled();
      expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    }
  );

  it('replans a backend-only production train when its immutable frontend identity moved', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(production.id, production);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'backend-candidate'
      )!
    );
    state.repository.candidates.set('backend-candidate', {
      ...state.repository.candidates.get('backend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: production.id
    });
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await state.reconciler.runOnce(
      'acceptance-backend-only-unchanged-main-moved'
    );

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        failure_class: 'INTERACTION',
        failure_message: expect.stringContaining('frontend main moved')
      })
    );
    expect(state.repository.candidates.get('backend-candidate')).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        current_train_id: null
      })
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed when a production main ref does not resolve to a valid SHA', async () => {
    const state = harness('SUCCEEDED');
    const production = train('production-invalid-main', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((membership) => ({
        ...membership,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? null : production.backend_base_sha
    );

    await expect(
      (
        state.reconciler as unknown as {
          advancePreparation(input: typeof context): Promise<void>;
        }
      ).advancePreparation(context)
    ).rejects.toThrow(
      'Invalid SHA returned for frontend:main while fencing a production replan'
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('waits for dispatched composition before requeueing a moved production plan', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'COMPOSING',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(production.id, production);
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
        current_train_id: production.id
      });
    }
    const running = {
      ...operation(
        production.id,
        'COMPOSE_FRONTEND',
        'frontend',
        'running-compose'
      ),
      status: 'RUNNING' as const,
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'release-bus-v2/production-train-train-1-frontend',
        inputs: {
          release_train_id: production.id,
          expected_sha: FRONTEND_SHA
        }
      },
      completed_at: null
    };
    state.repository.operations.push(running);
    let completeDuringReconcile = false;
    mockReconcileWorkflow.mockImplementation(async () => {
      const runningIndex = state.repository.operations.findIndex(
        ({ id }) => id === running.id
      );
      if (completeDuringReconcile) {
        state.repository.operations[runningIndex] = {
          ...state.repository.operations[runningIndex],
          status: 'SUCCEEDED',
          completed_at: Date.now(),
          row_version: state.repository.operations[runningIndex].row_version + 1
        };
      }
      return state.repository.operations[runningIndex];
    });
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await state.reconciler.runOnce('acceptance-production-main-moved-running');
    await state.reconciler.runOnce(
      'acceptance-production-main-moved-running-again'
    );

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'COMPOSING',
        recovery_message: expect.stringContaining(
          'waiting for already-dispatched orchestration'
        )
      })
    );
    expect(
      state.repository.operations.find(({ id }) => id === running.id)?.status
    ).toBe('RUNNING');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(3);
    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: running.idempotency_key,
        operationType: running.operation_type
      })
    );
    expect(state.repository.operations).toHaveLength(3);

    completeDuringReconcile = true;
    mockFindWorkflowRun.mockResolvedValue({ status: 'in_progress' });
    await state.reconciler.runOnce(
      'acceptance-production-main-moved-terminal-callback'
    );

    expect(state.repository.trains.get(production.id)?.status).toBe(
      'COMPOSING'
    );
    expect(
      state.repository.operations.find(({ id }) => id === running.id)?.status
    ).toBe('SUCCEEDED');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(4);

    mockFindWorkflowRun.mockResolvedValue({ status: 'completed' });
    await state.reconciler.runOnce('acceptance-production-main-moved-terminal');

    expect(state.repository.trains.get(production.id)?.status).toBe(
      'CANCELLED'
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        ({ status, current_train_id }) =>
          status === 'WAITING_FOR_PRODUCTION_REPLAN' &&
          current_train_id === null
      )
    ).toBe(true);
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(4);
    expect(state.repository.operations).toHaveLength(3);
  });

  it('never mutates production when either exact main base moved', async () => {
    const state = harness('SUCCEEDED');
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceProductionRefs(input: typeof context): Promise<void>;
        }
      ).advanceProductionRefs(context)
    ).rejects.toThrow('main moved');
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it('terminalizes a rejected exact main update and safely releases its production lock', async () => {
    const state = harness('SUCCEEDED');
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    state.repository.memberships.forEach((membership, index) => {
      state.repository.memberships[index] = {
        ...membership,
        train_id: production.id
      };
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      production.id,
      `train:${production.id}`
    );
    mockResolveRef.mockResolvedValue(production.backend_base_sha);
    mockUpdateRef.mockRejectedValue(
      new Error('Repository rule violations found')
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).rejects.toThrow('Repository rule violations found');

    const mainOperation = state.repository.operations.find(
      (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
    );
    expect(mainOperation).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: expect.any(Number)
      })
    );

    await (
      state.reconciler as unknown as {
        failTrain(
          input: ReleaseBusV2TrainRecord,
          failureClass: 'CONTROL_PLANE',
          message: string
        ): Promise<void>;
      }
    ).failTrain(production, 'CONTROL_PLANE', 'ruleset rejected update');

    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: production.id,
        payload: expect.objectContaining({
          lock: 'production-environment',
          train_status: 'FAILED'
        })
      })
    );
  });

  it.each([
    {
      failureClass: 'DEPLOYMENT' as const,
      operationType: 'DEPLOY_FRONTEND_PRODUCTION',
      message: 'frontend deployment failed'
    },
    {
      failureClass: 'E2E' as const,
      operationType: 'E2E_PRODUCTION',
      message: 'read-only smoke failed'
    }
  ])(
    'pauses only production and blocks later claims after a post-main $failureClass failure',
    async ({ failureClass, operationType, message }) => {
      const state = harness('SUCCEEDED');
      process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
      state.repository.trains.set(
        'train-1',
        train('train-1', { status: 'CANCELLED', completed_at: 2 })
      );
      const production = train('post-main-production', {
        lane: 'PRODUCTION',
        status: 'PRODUCTION_DEPLOYING',
        qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
      });
      state.repository.trains.set(production.id, production);
      state.repository.memberships.forEach((membership, index) => {
        state.repository.memberships[index] = {
          ...membership,
          train_id: production.id
        };
      });
      state.repository.lock = {
        ...state.repository.lock,
        name: 'production-environment'
      };
      await state.repository.acquireLock(
        'production-environment',
        production.id,
        `train:${production.id}`
      );
      state.repository.operations.push({
        ...operation(
          production.id,
          operationType,
          'frontend',
          `failed-production-${failureClass.toLowerCase()}`
        ),
        environment: 'prod',
        status: 'FAILED',
        failure_class: failureClass,
        failure_message: message
      });
      const stagingBefore = acceptanceLaneSnapshot(state.repository, 'STAGING');

      const failPostMain = () =>
        (
          state.reconciler as unknown as {
            failTrain(
              input: ReleaseBusV2TrainRecord,
              failureClass: 'DEPLOYMENT' | 'E2E',
              message: string
            ): Promise<void>;
          }
        ).failTrain(production, failureClass, message);

      await failPostMain();
      // A callback retry after the terminal transition must not duplicate the
      // pause or its durable audit event.
      await failPostMain();

      expect(state.repository.controls.get('PRODUCTION')).toEqual(
        expect.objectContaining({
          paused: true,
          github_actor: 'release-bus-v2',
          reason: expect.stringContaining('post-main production failure')
        })
      );
      expect(state.repository.controls.get('ALL')?.paused).toBe(false);
      expect(state.repository.controls.get('STAGING')?.paused).toBe(false);
      expect(acceptanceLaneSnapshot(state.repository, 'STAGING')).toEqual(
        stagingBefore
      );
      expect(state.service.setPaused).toHaveBeenCalledTimes(1);
      expect(state.service.setPaused).toHaveBeenCalledWith(
        'PRODUCTION',
        true,
        expect.stringContaining(production.id),
        'release-bus-v2'
      );
      expect(
        state.repository.events.filter(
          ({ eventType }) => eventType === 'PRODUCTION_POST_MAIN_FAILURE_PAUSED'
        )
      ).toEqual([
        expect.objectContaining({
          trainId: production.id,
          payload: expect.objectContaining({
            failure_class: failureClass,
            frontend_main_sha: production.frontend_composed_sha,
            backend_main_sha: production.backend_composed_sha,
            production_control: 'PAUSED',
            selected_candidate_status: 'FAILED',
            recovery_contract:
              'PROVE_EXACT_MAIN_RUNTIME_PARITY_OR_EXPLICIT_ROLLBACK_BEFORE_RESUME'
          })
        })
      ]);
      expect(state.repository.trains.get(production.id)).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          recovery_message: expect.stringContaining(
            'reconcile the recorded main SHAs with production runtime'
          )
        })
      );
      expect(
        Array.from(state.repository.candidates.values()).every(
          ({ status, current_train_id }) =>
            status === 'FAILED' && current_train_id === null
        )
      ).toBe(true);
      expect(state.repository.lock.owner_train_id).toBeNull();

      state.service.claimLane.mockClear();
      await state.reconciler.runOnce('post-main-production-pause');
      expect(state.service.claimLane).toHaveBeenCalledTimes(1);
      expect(state.service.claimLane).toHaveBeenCalledWith(
        'STAGING',
        FRONTEND_SHA,
        BACKEND_SHA,
        'post-main-production-pause:staging',
        { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
      );
    }
  );

  it('accepts an exact main update that succeeded before its transport error', async () => {
    const state = harness('SUCCEEDED');
    const production = train('accepted-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    mockUpdateRef.mockRejectedValue(new Error('response connection reset'));
    mockResolveRef.mockResolvedValue(production.backend_composed_sha);

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).resolves.toBeUndefined();

    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        external_id: production.backend_composed_sha,
        completed_at: expect.any(Number)
      })
    );
  });

  it('bounds exact main infrastructure retries in the durable operation', async () => {
    const state = harness('SUCCEEDED');
    const production = train('retry-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    const infrastructureError = new Error('GitHub returned 503');
    infrastructureError.name = 'ReleaseBusGitHubInfrastructureError';
    mockUpdateRef.mockRejectedValue(infrastructureError);
    mockResolveRef.mockResolvedValue(production.backend_base_sha);
    const advance = () =>
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(
        production,
        'backend',
        production.backend_base_sha ?? ''
      );

    await expect(advance()).rejects.toThrow('GitHub returned 503');
    await expect(advance()).rejects.toThrow('GitHub returned 503');
    await expect(advance()).rejects.toThrow('GitHub returned 503');

    expect(mockUpdateRef).toHaveBeenCalledTimes(3);
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        attempt: 3,
        max_attempts: 3,
        failure_class: 'INFRASTRUCTURE',
        completed_at: expect.any(Number)
      })
    );
  });

  it('cancels a main operation when its post-failure ref is an unexpected third SHA', async () => {
    const state = harness('SUCCEEDED');
    const production = train('moved-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    mockUpdateRef.mockRejectedValue(new Error('update rejected'));
    mockResolveRef.mockResolvedValue('9'.repeat(40));

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).rejects.toThrow('main moved');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        failure_class: 'INTERACTION',
        completed_at: expect.any(Number)
      })
    );
  });

  it('pauses for exact reconciliation after a partial multi-repository main advance', async () => {
    const state = harness('SUCCEEDED');
    const production = train('partial-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'backend'
        ? production.backend_base_sha
        : production.frontend_base_sha
    );
    mockUpdateRef.mockImplementation(async (repository: string) => {
      if (repository === 'frontend')
        throw new Error('frontend update rejected');
    });
    let frontendReads = 0;
    mockResolveRef.mockImplementation(async (repository: string) => {
      if (repository === 'backend') return production.backend_base_sha;
      frontendReads += 1;
      return frontendReads > 1 ? '9'.repeat(40) : production.frontend_base_sha;
    });

    await expect(
      (
        state.reconciler as unknown as {
          advanceProductionRefs(input: typeof context): Promise<void>;
        }
      ).advanceProductionRefs(context)
    ).rejects.toThrow('Partial production main advance: backend');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )?.status
    ).toBe('SUCCEEDED');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_FRONTEND'
      )?.status
    ).toBe('CANCELLED');
  });

  it('pauses only staging and requeues candidates on a staging control-plane defect', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const productionBefore = acceptanceLaneSnapshot(
      state.repository,
      'PRODUCTION'
    );
    mockReconcileWorkflow.mockRejectedValue(
      new Error('structured callback protocol mismatch')
    );

    await state.reconciler.runOnce('acceptance-control-plane');

    expect(state.repository.trains.get('train-1')?.status).toBe('FAILED');
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'STAGING',
      true,
      expect.stringContaining('structured callback protocol mismatch'),
      'release-bus-v2'
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status === 'READY_FOR_STAGING'
      )
    ).toBe(true);
    expect(mockEnsureCommitStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'error',
      expect.stringContaining('control_plane failure'),
      'Release Bus v2'
    );
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(false);
    expect(acceptanceLaneSnapshot(state.repository, 'PRODUCTION')).toEqual(
      productionBefore
    );

    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('acceptance-control-plane-next-tick');
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-control-plane-next-tick:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('rejects historical candidate evidence without introducing a lane or ALL pause', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        status: 'PREFLIGHTING',
        frontend_artifact_digest: null,
        backend_artifact_digest: null
      })
    );
    state.repository.candidates.set('backend-candidate', {
      ...state.repository.candidates.get('backend-candidate')!,
      pr_evidence_json: null
    });
    state.repository.dependencies.length = 0;
    const productionBefore = acceptanceLaneSnapshot(
      state.repository,
      'PRODUCTION'
    );

    await state.reconciler.runOnce('historical-evidence');

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CANDIDATE',
        failure_message: expect.stringContaining('backend candidate group')
      })
    );
    expect(state.service.setPaused).not.toHaveBeenCalled();
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(state.repository.controls.get('STAGING')?.paused).toBe(false);
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(false);
    expect(state.repository.candidates.get('backend-candidate')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        current_train_id: null
      })
    );
    expect(state.repository.candidates.get('frontend-candidate')).toEqual(
      expect.objectContaining({
        status: 'READY_FOR_STAGING',
        current_train_id: null
      })
    );
    expect(acceptanceLaneSnapshot(state.repository, 'PRODUCTION')).toEqual(
      productionBefore
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED',
        payload: expect.objectContaining({
          failure_messages: [
            expect.stringContaining('no complete exact PR CI policy evidence')
          ]
        })
      })
    );

    state.service.claimLane.mockClear();
    await state.reconciler.runOnce('historical-evidence-next-tick');
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'historical-evidence-next-tick:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('fails one staging repository group without subset work and immediately requeues the independent repository', async () => {
    const state = harness('SUCCEEDED');
    const staging = train('train-1', {
      status: 'PREFLIGHTING',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: FRONTEND_SHA,
        baseline_backend_sha: BACKEND_SHA,
        observed_frontend_staging_sha: FRONTEND_SHA,
        observed_backend_staging_sha: BACKEND_SHA,
        new_candidate_ids: ['backend-candidate', 'frontend-candidate'],
        carried_candidate_ids: ['carried-frontend']
      },
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(staging.id, staging);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      ...state.repository.memberships.map((membership) => ({
        ...membership,
        candidate_role: 'NEW'
      }))
    );
    const carried = {
      ...candidate('carried-frontend', 'frontend', null),
      pr_number: 88,
      head_sha: '8'.repeat(40),
      status: 'STAGING_VALIDATED' as const,
      current_train_id: null,
      staging_validated_train_id: 'baseline-train',
      staging_validated_manifest_id: 'baseline-manifest',
      staging_live_state: 'LIVE' as const,
      staging_live_manifest_id: 'baseline-manifest'
    };
    state.repository.candidates.set(carried.id, carried);
    state.repository.memberships.push({
      id: 'membership-carried-frontend',
      train_id: staging.id,
      candidate_id: carried.id,
      sequence: 3,
      disposition: 'INCLUDED',
      candidate_role: 'CARRY_FORWARD',
      created_at: 1
    });
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        repository: 'frontend' | 'backend';
      };
      return {
        ...operation(
          staging.id,
          typed.operationType,
          typed.repository,
          typed.repository === 'frontend'
            ? 'failed-frontend-preflight'
            : 'successful-backend-preflight'
        ),
        status:
          typed.repository === 'frontend'
            ? ('FAILED' as const)
            : ('SUCCEEDED' as const),
        failure_class:
          typed.repository === 'frontend' ? ('CANDIDATE' as const) : null,
        failure_message:
          typed.repository === 'frontend'
            ? 'combined frontend checks failed'
            : null
      };
    });
    const context = {
      train: staging,
      memberships: state.repository.memberships,
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation(context);

    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(
      mockReconcileWorkflow.mock.calls.some(([input]) =>
        String((input as { operationType?: string }).operationType).startsWith(
          'ISOLATE_'
        )
      )
    ).toBe(false);
    expect(state.repository.candidates.get('frontend-candidate')).toMatchObject(
      {
        status: 'FAILED',
        current_train_id: null
      }
    );
    expect(state.repository.candidates.get('backend-candidate')).toMatchObject({
      status: 'READY_FOR_STAGING',
      current_train_id: null
    });
    expect(state.repository.candidates.get(carried.id)).toEqual(carried);
    expect(state.repository.trains.get(staging.id)).toMatchObject({
      status: 'FAILED',
      completed_at: expect.any(Number),
      recovery_message: expect.stringContaining('immediately eligible')
    });
  });

  it('fails A+B+C once as one same-repository staging group and never auto-retries it', async () => {
    const state = harness('SUCCEEDED');
    const staging = train('train-1', {
      status: 'PREFLIGHTING',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: FRONTEND_SHA,
        baseline_backend_sha: BACKEND_SHA,
        observed_frontend_staging_sha: FRONTEND_SHA,
        observed_backend_staging_sha: BACKEND_SHA,
        new_candidate_ids: ['backend-a', 'backend-b', 'backend-c'],
        carried_candidate_ids: []
      },
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(staging.id, staging);
    state.repository.candidates.clear();
    state.repository.memberships.length = 0;
    state.repository.dependencies.length = 0;
    const grouped = ['a', 'b', 'c'].map((id, index) => ({
      ...candidate(`backend-${id}`, 'backend', {
        units: ['api'],
        edges: []
      }),
      pr_number: 3001 + index,
      head_sha: String(index + 5).repeat(40),
      current_train_id: staging.id
    }));
    grouped.forEach((item, index) => {
      state.repository.candidates.set(item.id, item);
      state.repository.memberships.push({
        id: `membership-${item.id}`,
        train_id: staging.id,
        candidate_id: item.id,
        sequence: index + 1,
        disposition: 'INCLUDED',
        candidate_role: 'NEW',
        created_at: 1
      });
    });
    state.repository.operations.length = 0;
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        repository: 'frontend' | 'backend';
      };
      return {
        ...operation(
          staging.id,
          typed.operationType,
          typed.repository,
          'failed-grouped-backend-preflight'
        ),
        status: 'FAILED' as const,
        failure_class: 'CANDIDATE' as const,
        failure_message: 'combined backend checks failed'
      };
    });
    const context = {
      train: staging,
      memberships: state.repository.memberships,
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation(context);

    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(
      mockReconcileWorkflow.mock.calls.some(([input]) =>
        String((input as { operationType?: string }).operationType).startsWith(
          'ISOLATE_'
        )
      )
    ).toBe(false);
    expect(
      grouped.map(({ id }) => state.repository.candidates.get(id)?.status)
    ).toEqual(['FAILED', 'FAILED', 'FAILED']);
    expect(
      state.repository.events.filter(
        ({ eventType }) =>
          eventType === 'STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED'
      )
    ).toHaveLength(3);
    expect(state.repository.trains.get(staging.id)).toMatchObject({
      status: 'FAILED',
      completed_at: expect.any(Number)
    });

    await state.reconciler.runOnce('no-implicit-group-retry');

    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(
      grouped.map(({ id }) => state.repository.candidates.get(id)?.status)
    ).toEqual(['FAILED', 'FAILED', 'FAILED']);
  });

  it('retains deterministic isolation only for a production preflight diagnosis', async () => {
    const state = harness('SUCCEEDED');
    state.repository.candidates.clear();
    state.repository.memberships.length = 0;
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION',
        status: 'PREFLIGHTING',
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: null,
        frontend_artifact_digest: null,
        backend_artifact_digest: null
      })
    );
    const backendBase =
      state.repository.trains.get('train-1')?.backend_base_sha;
    if (!backendBase) throw new Error('test backend base is missing');
    const mergeShas = ['7', '8', '9', 'a'].map((digit) => digit.repeat(40));
    const candidates = ['a', 'b', 'c', 'd'].map((id, index) => ({
      ...candidate(id, 'backend', { units: ['api'], edges: [] }),
      pr_number: 100 + index,
      head_sha: String(index + 3).repeat(40),
      pr_evidence_json: {
        ...(candidate(id, 'backend', { units: ['api'], edges: [] })
          .pr_evidence_json as NonNullable<
          ReleaseBusV2CandidateRecord['pr_evidence_json']
        >),
        base_sha: backendBase,
        merge_sha: mergeShas[index],
        checks_run_id: String(200 + index),
        checks_completed_at: 1,
        artifact_name: `release-bus-v2-pr-${mergeShas[index]}`
      }
    }));
    candidates.forEach((item, index) => {
      state.repository.candidates.set(item.id, item);
      state.repository.memberships.push({
        id: `membership-${item.id}`,
        train_id: 'train-1',
        candidate_id: item.id,
        sequence: index + 1,
        disposition: 'INCLUDED',
        created_at: 1
      });
    });
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        idempotencyKey: string;
        operationType: string;
        expectedSha: string;
      };
      if (typed.operationType === 'ISOLATE_COMPOSE_BACKEND')
        return {
          ...operation(
            'train-1',
            typed.operationType,
            'backend',
            `compose-${typed.idempotencyKey}`
          ),
          expected_sha: typed.expectedSha,
          result_json: {
            summary: {
              composed_sha: 'e'.repeat(40),
              excluded_shas: []
            }
          }
        };
      const failedLeft = typed.idempotencyKey.includes(':backend:0:preflight');
      return {
        ...operation(
          'train-1',
          typed.operationType,
          'backend',
          `preflight-${typed.idempotencyKey}`
        ),
        status: failedLeft ? ('FAILED' as const) : ('SUCCEEDED' as const),
        failure_class: failedLeft ? ('CANDIDATE' as const) : null,
        failure_message: failedLeft ? 'composed tests failed' : null
      };
    });
    const context = {
      train: state.repository.trains.get('train-1') as ReleaseBusV2TrainRecord,
      memberships: state.repository.memberships,
      candidates,
      dependencies: []
    };

    await (
      state.reconciler as unknown as {
        reconcileCandidateIsolation(
          input: typeof context,
          repository: 'backend'
        ): Promise<void>;
      }
    ).reconcileCandidateIsolation(context, 'backend');

    expect(state.repository.trains.get('train-1')).toMatchObject({
      status: 'FAILED',
      failure_class: 'INTERACTION'
    });
    expect(state.repository.candidates.get('a')).toMatchObject({
      status: 'FAILED',
      hold_reason: expect.stringContaining('COMBINATION_FAILED')
    });
    expect(state.repository.candidates.get('b')?.status).toBe('FAILED');
    expect(state.repository.candidates.get('c')?.status).toBe(
      'READY_FOR_PRODUCTION'
    );
    expect(state.repository.candidates.get('d')?.status).toBe(
      'READY_FOR_PRODUCTION'
    );
    expect(
      state.repository.memberships.find((item) => item.candidate_id === 'a')
        ?.disposition
    ).toBe('COMBINATION_FAILED');
    expect(
      state.repository.memberships.find((item) => item.candidate_id === 'c')
        ?.disposition
    ).toBe('RETURNED_TO_QUEUE');
  });

  it('has no base-canary operation in the normal reconciler path', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/releaseBusV2/release-bus-v2.reconciler.ts'),
      'utf8'
    );
    expect(source).not.toContain('BASE_CANARY');
  });

  it.each([
    {
      trustMode: 'legacy-exact-workflow-v0' as const,
      contract: 'legacy-v2' as const,
      artifactEnvironment: '' as const
    },
    {
      trustMode: 'evidence-manifest-v1' as const,
      contract: 'environment-bound-v3' as const,
      artifactEnvironment: 'staging' as const
    }
  ])(
    'propagates $trustMode preparation compatibility into same-train deploy consumers',
    async ({ trustMode, contract, artifactEnvironment }) => {
      const state = harness('SUCCEEDED');
      const staging = train('train-1', { status: 'DEPLOYING' });
      state.repository.trains.set(staging.id, staging);
      const backend = withEvidence(
        {
          ...state.repository.candidates.get('backend-candidate')!,
          deploy_plan_json: { units: ['api'], edges: [] }
        },
        trustMode,
        trustMode === 'evidence-manifest-v1'
      );
      const frontend = withEvidence(
        state.repository.candidates.get('frontend-candidate')!,
        trustMode,
        trustMode === 'evidence-manifest-v1'
      );
      state.repository.candidates.set(backend.id, backend);
      state.repository.candidates.set(frontend.id, frontend);
      state.repository.operations.splice(
        0,
        state.repository.operations.length,
        contract === 'legacy-v2'
          ? oldFrontendPreparedArtifactOperation(staging.id, '101', 'staging')
          : preparedArtifactOperation(
              staging.id,
              'frontend',
              '101',
              contract,
              artifactEnvironment
            ),
        contract === 'legacy-v2'
          ? newLegacyBackendPreparedArtifactOperation(staging.id, '102')
          : preparedArtifactOperation(
              staging.id,
              'backend',
              '102',
              contract,
              artifactEnvironment
            )
      );
      mockReconcileWorkflow.mockImplementation(async (spec) => {
        const typed = spec as {
          operationType: string;
          repository: 'frontend' | 'backend';
          service: string | null;
        };
        return operation(
          staging.id,
          typed.operationType,
          typed.repository,
          `deploy-${typed.repository}`,
          typed.service
        );
      });
      const context = {
        train: staging,
        memberships: state.repository.memberships,
        candidates: [backend, frontend],
        dependencies: state.repository.dependencies
      };

      await (
        state.reconciler as unknown as {
          reconcileDeployments(
            input: typeof context,
            environment: 'staging',
            artifactSourceTrainId: string
          ): Promise<unknown>;
        }
      ).reconcileDeployments(context, 'staging', staging.id);

      const deploySpecs = mockReconcileWorkflow.mock.calls.map(
        ([spec]) =>
          spec as {
            operationType: string;
            inputs: Record<string, string>;
          }
      );
      expect(deploySpecs.map(({ operationType }) => operationType)).toEqual([
        'DEPLOY_BACKEND_STAGING_api',
        'DEPLOY_FRONTEND_STAGING'
      ]);
      for (const { operationType, inputs } of deploySpecs) {
        expect(inputs.artifact_contract_version).toBe(contract);
        expect(inputs.artifact_environment).toBe(
          contract === 'legacy-v2' &&
            operationType === 'DEPLOY_FRONTEND_STAGING'
            ? 'staging'
            : artifactEnvironment
        );
        expect(inputs.artifact_train_id).toBe(staging.id);
      }
    }
  );

  it('maps an immutable old frontend production preparation to the new legacy deploy input contract', async () => {
    const state = harness('SUCCEEDED');
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'PRODUCTION_DEPLOYING'
    });
    state.repository.trains.set(production.id, production);
    const frontend = state.repository.candidates.get('frontend-candidate')!;
    state.repository.operations.splice(
      0,
      state.repository.operations.length,
      oldFrontendPreparedArtifactOperation(production.id, '101', 'production')
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        repository: 'frontend';
        service: null;
      };
      return operation(
        production.id,
        typed.operationType,
        typed.repository,
        'production-frontend-deploy',
        typed.service
      );
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.filter(
        ({ candidate_id }) => candidate_id === frontend.id
      ),
      candidates: [frontend],
      dependencies: []
    };

    await (
      state.reconciler as unknown as {
        reconcileDeployments(
          input: typeof context,
          environment: 'prod',
          artifactSourceTrainId: string
        ): Promise<unknown>;
      }
    ).reconcileDeployments(context, 'prod', production.id);

    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'DEPLOY_FRONTEND_PROD',
        workflow: 'release-bus-deploy-production.yml',
        inputs: expect.objectContaining({
          artifact_contract_version: 'legacy-v2',
          artifact_environment: 'production',
          artifact_run_id: '101',
          artifact_train_id: production.id
        })
      })
    );
  });

  it.each([
    ['staging', 'STAGING', 'DEPLOY_FRONTEND_STAGING'],
    ['prod', 'PRODUCTION', 'DEPLOY_FRONTEND_PROD']
  ] as const)(
    'consumes a new legacy frontend %s preparation without losing target-environment binding',
    async (environment, lane, operationType) => {
      const state = harness('SUCCEEDED');
      const artifactEnvironment =
        environment === 'prod' ? 'production' : 'staging';
      const targetTrain = train('train-1', {
        lane,
        status: lane === 'PRODUCTION' ? 'PRODUCTION_DEPLOYING' : 'DEPLOYING'
      });
      state.repository.trains.set(targetTrain.id, targetTrain);
      const frontend = withEvidence(
        state.repository.candidates.get('frontend-candidate')!,
        'legacy-exact-workflow-v0',
        false
      );
      state.repository.candidates.set(frontend.id, frontend);
      state.repository.operations.splice(
        0,
        state.repository.operations.length,
        newLegacyFrontendPreparedArtifactOperation(
          targetTrain.id,
          '101',
          artifactEnvironment
        )
      );
      mockReconcileWorkflow.mockImplementation(async (spec) => {
        const typed = spec as {
          operationType: string;
          repository: 'frontend';
          service: null;
        };
        return operation(
          targetTrain.id,
          typed.operationType,
          typed.repository,
          `${environment}-new-legacy-frontend-deploy`,
          typed.service
        );
      });
      const context = {
        train: targetTrain,
        memberships: state.repository.memberships.filter(
          ({ candidate_id }) => candidate_id === frontend.id
        ),
        candidates: [frontend],
        dependencies: []
      };

      await (
        state.reconciler as unknown as {
          reconcileDeployments(
            input: typeof context,
            targetEnvironment: 'staging' | 'prod',
            artifactSourceTrainId: string
          ): Promise<unknown>;
        }
      ).reconcileDeployments(context, environment, targetTrain.id);

      expect(mockReconcileWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType,
          inputs: expect.objectContaining({
            artifact_contract_version: 'legacy-v2',
            artifact_environment: artifactEnvironment,
            artifact_run_id: '101',
            artifact_train_id: targetTrain.id
          })
        })
      );
    }
  );

  it('freshly composes and packages production instead of reusing staging bytes', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'validated-production-manifest';
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        staging_validated_manifest_id: manifestId,
        staging_validated_train_id: 'train-1'
      });
    }
    const deferred = withEvidence(
      {
        ...candidate('backend-deferred', 'backend', {
          units: ['releaseBus'],
          edges: []
        }),
        pr_number: 22,
        head_sha: '6'.repeat(40),
        staging_validated_manifest_id: manifestId,
        staging_validated_train_id: 'train-1'
      },
      'evidence-manifest-v1'
    );
    state.repository.candidates.set(deferred.id, deferred);
    state.repository.memberships.push({
      id: 'deferred-staging-membership',
      train_id: 'train-1',
      candidate_id: deferred.id,
      sequence: 3,
      disposition: 'INCLUDED',
      created_at: 1
    });
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: 'train-1',
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_VALIDATED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: 'validated-e2e',
      manifest_json: {
        candidates: Array.from(state.repository.candidates.values()).map(
          ({ id }) => ({ candidate_id: id })
        )
      },
      deployed_at: 2,
      validated_at: 3,
      created_at: 2,
      updated_at: 3
    });
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
    });
    const freshFrontendSha = '8'.repeat(40);
    const freshBackendSha = '9'.repeat(40);
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) => {
        if (ref === 'main')
          return repository === 'frontend'
            ? production.frontend_base_sha
            : production.backend_base_sha;
        return repository === 'frontend' ? freshFrontendSha : freshBackendSha;
      }
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const repository = spec.repository as 'frontend' | 'backend';
      const prepared = operation(
        production.id,
        String(spec.operationType),
        repository,
        `fresh-${repository}-run`
      );
      return {
        ...prepared,
        expected_sha:
          repository === 'frontend' ? freshFrontendSha : freshBackendSha,
        artifact_digest: String(spec.operationType).startsWith(
          'PREPARE_ARTIFACT_'
        )
          ? repository === 'frontend'
            ? 'e'.repeat(64)
            : 'f'.repeat(64)
          : null
      };
    });
    state.repository.trains.set(production.id, production);
    const context = {
      train: production,
      memberships: state.repository.memberships
        .filter(({ candidate_id }) => candidate_id !== deferred.id)
        .map((item) => ({
          ...item,
          train_id: production.id
        })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation(context);

    const composedTrain = state.repository.trains.get(production.id);
    if (!composedTrain) throw new Error('Missing freshly composed train');
    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation({ ...context, train: composedTrain });

    expect(state.repository.trains.get(production.id)).toMatchObject({
      status: 'PREPARED',
      frontend_composed_sha: freshFrontendSha,
      backend_composed_sha: freshBackendSha,
      frontend_artifact_digest: 'e'.repeat(64),
      backend_artifact_digest: 'f'.repeat(64),
      manifest_id: null
    });
    expect(
      Array.from(state.repository.candidates.values())
        .filter(({ id }) => id !== deferred.id)
        .map(({ status }) => status)
    ).toEqual([
      'PRODUCTION_BUILDING_OR_QUALIFYING',
      'PRODUCTION_BUILDING_OR_QUALIFYING'
    ]);
    expect(state.repository.candidates.get(deferred.id)?.status).toBe(
      'STAGING_BUILDING'
    );
    for (const repository of ['frontend', 'backend']) {
      expect(mockReconcileWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType: `PREPARE_ARTIFACT_${repository.toUpperCase()}`,
          expectedSha:
            repository === 'frontend' ? freshFrontendSha : freshBackendSha,
          inputs: expect.objectContaining({
            artifact_environment: 'production',
            artifact_contract_version: 'environment-bound-v3',
            reuse_artifact_run_id: '',
            reuse_artifact_name: '',
            reuse_artifact_digest: ''
          })
        })
      );
    }
    expect(state.repository.events).not.toContainEqual(
      expect.objectContaining({ eventType: 'EXACT_STAGING_MANIFEST_REUSED' })
    );
    expect(
      mockReconcileWorkflow.mock.calls
        .map(([spec]) => JSON.stringify(spec))
        .join('\n')
    ).not.toContain(deferred.head_sha);
  });

  it('freshly composes candidate-evidence production even for one artifact-qualified candidate', async () => {
    const state = harness('SUCCEEDED');
    const selectedMembership = state.repository.memberships.find(
      ({ candidate_id }) => candidate_id === 'frontend-candidate'
    );
    if (!selectedMembership) throw new Error('Missing frontend candidate');
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      { ...selectedMembership, train_id: 'fresh-production' }
    );
    const selected = state.repository.candidates.get('frontend-candidate');
    if (!selected) throw new Error('Missing selected candidate');
    state.repository.candidates.set(selected.id, {
      ...selected,
      pr_evidence_json: {
        ...(selected.pr_evidence_json as NonNullable<
          ReleaseBusV2CandidateRecord['pr_evidence_json']
        >),
        base_sha: '1'.repeat(40),
        merge_sha: selected.head_sha,
        checks_run_id: '100',
        checks_completed_at: 2,
        artifact_run_id: '100',
        artifact_name: `release-bus-v2-pr-${selected.head_sha}`,
        artifact_digest: '9'.repeat(64)
      }
    });
    const evidence = [
      {
        candidate_id: selected.id,
        repository: selected.repository,
        pr_number: selected.pr_number,
        head_sha: selected.head_sha,
        staging_train_id: 'old-staging-train',
        staging_manifest_id: 'old-staging-manifest',
        staging_manifest_identity_sha256: '7'.repeat(64),
        staging_e2e_operation_id: 'old-staging-e2e-operation',
        staging_e2e_run_id: 'old-staging-e2e-run'
      }
    ];
    const production = train('fresh-production', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
      qualification_evidence_json: evidence
    });
    state.repository.trains.set(production.id, production);
    const composedSha = '8'.repeat(40);
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) => {
        if (ref === 'main')
          return repository === 'frontend'
            ? production.frontend_base_sha
            : production.backend_base_sha;
        return repository === 'frontend' ? composedSha : BACKEND_SHA;
      }
    );
    mockReconcileWorkflow.mockResolvedValue(
      operation(
        production.id,
        'COMPOSE_FRONTEND',
        'frontend',
        'fresh-compose-run'
      )
    );
    const context = {
      train: production,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: []
    };

    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation(context);

    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'COMPOSE_FRONTEND',
        inputs: expect.objectContaining({
          base_sha: production.frontend_base_sha,
          candidate_shas: JSON.stringify([selected.head_sha])
        })
      })
    );
    expect(mockCreateRef).not.toHaveBeenCalled();
    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'PREFLIGHTING',
        frontend_composed_sha: composedSha,
        frontend_artifact_digest: null,
        manifest_id: null
      })
    );
  });

  it('fails closed instead of reviving any legacy staging artifact for production', async () => {
    const state = harness('SUCCEEDED');
    const production = train('legacy-production', {
      lane: 'PRODUCTION',
      status: 'WAITING_FOR_ENVIRONMENT',
      manifest_id: 'legacy-staging-manifest',
      qualification_train_id: 'legacy-qualification',
      qualification_policy: null
    });
    state.repository.trains.set(production.id, production);
    state.repository.trains.set(
      'legacy-qualification',
      train('legacy-qualification', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'STAGING_VALIDATED',
        parent_train_id: production.id,
        manifest_id: 'legacy-staging-manifest'
      })
    );
    state.repository.manifests.set('legacy-staging-manifest', {
      id: 'legacy-staging-manifest',
      train_id: 'legacy-qualification',
      lane: 'PRODUCTION_QUALIFICATION',
      identity_sha256: '7'.repeat(64),
      status: 'STAGING_VALIDATED',
      frontend_sha: production.frontend_composed_sha,
      backend_sha: production.backend_composed_sha,
      frontend_artifact_digest: '8'.repeat(64),
      backend_artifact_digest: '9'.repeat(64),
      e2e_run_id: 'legacy-staging-e2e-run',
      manifest_json: {
        artifact_source_train_id: 'legacy-staging-artifact-train'
      },
      deployed_at: 2,
      validated_at: 3,
      created_at: 1,
      updated_at: 3
    });
    state.repository.memberships.forEach((membership, index) => {
      state.repository.memberships[index] = {
        ...membership,
        train_id: production.id
      };
    });
    const stagingBefore = acceptanceLaneSnapshot(state.repository, 'STAGING');
    const context = {
      train: production,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    expect(
      await (
        state.reconciler as unknown as {
          artifactSourceTrainId(
            input: ReleaseBusV2TrainRecord
          ): Promise<string>;
        }
      ).artifactSourceTrainId(production)
    ).toBe(production.id);

    await (
      state.reconciler as unknown as {
        advanceProduction(input: typeof context): Promise<void>;
      }
    ).advanceProduction(context);

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        failure_message: expect.stringContaining(
          'Legacy staging-qualified artifacts cannot be reused'
        )
      })
    );
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(true);
    expect(state.repository.controls.get('STAGING')?.paused).toBe(false);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(acceptanceLaneSnapshot(state.repository, 'STAGING')).toEqual(
      stagingBefore
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        trainId: production.id,
        eventType: 'PRODUCTION_LEGACY_ARTIFACT_REUSE_REJECTED',
        payload: expect.objectContaining({
          artifact_reuse: 'REJECTED',
          production_ref_mutation: 'NOT_STARTED',
          production_deployment: 'BLOCKED',
          recovery_contract:
            'DRAIN_AND_READMIT_EXACT_CANDIDATES_WITH_CANDIDATE_STAGING_EVIDENCE_V1'
        })
      })
    );
    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
    expect(state.repository.trains.get('legacy-qualification')).toEqual(
      expect.objectContaining({
        status: 'STAGING_VALIDATED',
        manifest_id: 'legacy-staging-manifest'
      })
    );
  });

  it('halts an already-main legacy recovery without dispatching or double-pausing', async () => {
    const state = harness('SUCCEEDED');
    const production = train('legacy-post-main-production', {
      lane: 'PRODUCTION',
      status: 'PRODUCTION_DEPLOYING',
      qualification_policy: null
    });
    state.repository.trains.set(production.id, production);
    state.repository.memberships.forEach((membership, index) => {
      state.repository.memberships[index] = {
        ...membership,
        train_id: production.id
      };
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      production.id,
      `train:${production.id}`
    );
    const context = {
      train: production,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceProduction(input: typeof context): Promise<void>;
      }
    ).advanceProduction(context);

    expect(state.service.setPaused).toHaveBeenCalledTimes(1);
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'PRODUCTION',
      true,
      expect.stringContaining(
        'Legacy staging-qualified artifacts cannot be reused'
      ),
      'release-bus-v2'
    );
    expect(state.repository.controls.get('PRODUCTION')?.paused).toBe(true);
    expect(state.repository.controls.get('STAGING')?.paused).toBe(false);
    expect(state.repository.controls.get('ALL')?.paused).toBe(false);
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(
      Array.from(state.repository.candidates.values()).every(
        ({ status }) => status === 'FAILED'
      )
    ).toBe(true);
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        trainId: production.id,
        eventType: 'PRODUCTION_LEGACY_ARTIFACT_REUSE_REJECTED',
        payload: expect.objectContaining({
          artifact_reuse: 'REJECTED',
          production_ref_mutation: 'MAY_HAVE_STARTED_BEFORE_UPGRADE',
          production_deployment: 'BLOCKED',
          recovery_contract:
            'PROVE_EXACT_MAIN_RUNTIME_PARITY_OR_EXPLICIT_ROLLBACK_BEFORE_RESUME'
        })
      })
    );
    expect(mockUpdateRef).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
  });

  it('regresses #3464/#3461: candidate evidence reaches production without WAITING_FOR_PRODUCTION_REPLAN', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const selectedCandidates = Array.from(state.repository.candidates.values());
    const omitted = {
      ...candidate('omitted-candidate-b', 'frontend', null),
      status: 'READY_FOR_PRODUCTION' as const,
      current_train_id: null,
      staging_validated_train_id: 'omitted-staging-train',
      staging_validated_manifest_id: 'omitted-staging-manifest',
      production_requested_at: 9,
      production_requested_by: 'operator',
      production_selection_id: 'omitted-selection'
    };
    state.repository.candidates.set(omitted.id, omitted);
    const evidence = selectedCandidates.map((item, index) => ({
      candidate_id: item.id,
      repository: item.repository,
      pr_number: item.pr_number,
      head_sha: item.head_sha,
      staging_train_id: `source-staging-train-${index}`,
      staging_manifest_id: `source-staging-manifest-${index}`,
      staging_manifest_identity_sha256: `${index + 1}`.padStart(64, '0'),
      staging_e2e_operation_id: `source-staging-e2e-operation-${index}`,
      staging_e2e_run_id: `source-staging-e2e-run-${index}`
    }));
    (
      state.service.resolveCandidateStagingEvidence as jest.Mock<
        Promise<typeof evidence>
      >
    ).mockResolvedValue(evidence);
    const production = train('candidate-evidence-production', {
      lane: 'PRODUCTION',
      status: 'PREPARED',
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
      qualification_evidence_json: evidence
    });
    state.repository.trains.set(production.id, production);
    const memberships = state.repository.memberships.map((item) => ({
      ...item,
      train_id: production.id
    }));
    const context = {
      train: production,
      memberships,
      candidates: [...selectedCandidates, omitted],
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend'
        ? production.frontend_base_sha
        : production.backend_base_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, branch: string) =>
        selectedCandidates.find((item) => item.branch_name === branch)
          ?.head_sha ?? null
    );

    await (
      state.reconciler as unknown as {
        advanceProduction(input: typeof context): Promise<void>;
      }
    ).advanceProduction(context);

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'MERGING_PRODUCTION',
        qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
        qualification_train_id: null,
        manifest_id: expect.any(String)
      })
    );
    const qualificationManifest = Array.from(
      state.repository.manifests.values()
    ).find(({ train_id }) => train_id === production.id);
    expect(qualificationManifest).toEqual(
      expect.objectContaining({
        status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
        deployed_at: null,
        manifest_json: expect.objectContaining({
          qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
          candidate_staging_evidence: evidence,
          candidates: expect.arrayContaining([
            expect.objectContaining({
              candidate_id: 'backend-candidate'
            }),
            expect.objectContaining({
              candidate_id: 'frontend-candidate'
            })
          ])
        })
      })
    );
    expect(state.repository.trains.get(production.id)?.status).not.toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(
      Array.from(state.repository.trains.values()).some(
        ({ lane }) => lane === 'PRODUCTION_QUALIFICATION'
      )
    ).toBe(false);
    expect(state.repository.candidates.get(omitted.id)).toEqual(omitted);
    expect(state.repository.lock.owner_train_id).toBeNull();
  });

  it('finishes an isolated old-producer API to releaseBus-last self-upgrade before new-runtime E2E and finalization', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const productionId = 'producer-cutover-production';
    const selected = withEvidence(
      {
        ...state.repository.candidates.get('backend-candidate')!,
        status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
        current_train_id: productionId,
        deploy_plan_json: {
          units: ['api', 'releaseBus'],
          edges: [['api', 'releaseBus']]
        }
      },
      'evidence-manifest-v1'
    );
    state.repository.candidates.clear();
    state.repository.candidates.set(selected.id, selected);
    const membership = {
      ...state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'backend-candidate'
      )!,
      train_id: productionId
    };
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      membership
    );
    state.repository.dependencies.splice(
      0,
      state.repository.dependencies.length
    );
    const evidence = [
      {
        candidate_id: selected.id,
        repository: selected.repository,
        pr_number: selected.pr_number,
        head_sha: selected.head_sha,
        staging_train_id: 'cutover-staging-train',
        staging_manifest_id: 'cutover-staging-manifest',
        staging_manifest_identity_sha256: '7'.repeat(64),
        staging_e2e_operation_id: 'cutover-staging-e2e-operation',
        staging_e2e_run_id: 'cutover-staging-e2e-run'
      }
    ];
    (
      state.service.resolveCandidateStagingEvidence as jest.Mock<
        Promise<typeof evidence>
      >
    ).mockResolvedValue(evidence);
    const production = train(productionId, {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION',
      frontend_composed_sha: '1'.repeat(40),
      frontend_artifact_digest: null,
      manifest_id: 'cutover-qualified-manifest',
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
      qualification_evidence_json: evidence
    });
    state.repository.trains.set(production.id, production);
    state.repository.manifests.set('cutover-qualified-manifest', {
      id: 'cutover-qualified-manifest',
      train_id: production.id,
      lane: 'PRODUCTION',
      identity_sha256: 'e'.repeat(64),
      status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
      frontend_sha: production.frontend_composed_sha,
      backend_sha: production.backend_composed_sha,
      frontend_artifact_digest: null,
      backend_artifact_digest: production.backend_artifact_digest,
      e2e_run_id: null,
      manifest_json: {
        qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
        candidate_staging_evidence: evidence,
        candidates: [{ candidate_id: selected.id }]
      },
      deployed_at: null,
      validated_at: null,
      created_at: 1,
      updated_at: 1
    });
    state.repository.operations.splice(0, state.repository.operations.length, {
      ...operation(production.id, 'PREPARE_ARTIFACT_BACKEND', 'backend', '201'),
      idempotency_key: `rb2:${production.id}:prepare:backend`,
      expected_sha: production.backend_composed_sha,
      artifact_digest: production.backend_artifact_digest,
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {
          release_train_id: production.id,
          release_train_revision: '1',
          operation_key: 'replaced-by-reconciler',
          source_ref: selected.branch_name,
          expected_sha: production.backend_composed_sha!,
          deploy_units: '["api","releaseBus"]',
          reuse_artifact_run_id: '202',
          reuse_artifact_name: `release-bus-v2-pr-${selected.pr_evidence_json!.merge_sha}`,
          reuse_artifact_digest: '9'.repeat(64)
        },
        beta_infrastructure_failure_injection: null
      },
      result_json: {
        summary: {
          artifact_digest: production.backend_artifact_digest,
          fresh_or_reused: 'reused'
        }
      }
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    const sequence: string[] = [];
    let backendMain = production.backend_base_sha!;
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'backend' ? backendMain : production.frontend_base_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) =>
        ref === selected.branch_name ? selected.head_sha : null
    );
    mockUpdateRef.mockImplementation(
      async (
        repository: string,
        ref: string,
        expectedOldSha: string,
        nextSha: string
      ) => {
        expect([repository, ref, expectedOldSha, nextSha]).toEqual([
          'backend',
          'main',
          production.backend_base_sha,
          production.backend_composed_sha
        ]);
        sequence.push('main-cas');
        backendMain = nextSha;
      }
    );
    const firstContext = {
      train: production,
      memberships: [...state.repository.memberships],
      candidates: [selected],
      dependencies: []
    };

    await (
      state.reconciler as unknown as {
        advanceProduction(input: typeof firstContext): Promise<void>;
      }
    ).advanceProduction(firstContext);

    expect(state.repository.trains.get(production.id)?.status).toBe(
      'PRODUCTION_DEPLOYING'
    );
    let newRuntimeActive = false;
    const releaseNoteSignals: Array<{
      readonly service: string;
      readonly groups: string;
      readonly publish: string;
      readonly optOut: string;
    }> = [];
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        repository: 'frontend' | 'backend';
        service: string | null;
        inputs: Record<string, string>;
      };
      if (typed.operationType.startsWith('DEPLOY_BACKEND_PROD_')) {
        if (newRuntimeActive)
          throw new Error(
            'No deploy unit may remain after the releaseBus runtime cutover'
          );
        expect(typed.inputs.artifact_contract_version).toBe('legacy-v2');
        expect(typed.inputs.artifact_environment).toBe('');
        expect(typed.inputs.artifact_train_id).toBe(production.id);
        expect(typed.inputs.artifact_run_id).toBe('201');
        releaseNoteSignals.push({
          service: String(typed.service),
          groups: typed.inputs.release_note_groups,
          publish: typed.inputs.release_note_publish,
          optOut: typed.inputs.release_note_opt_out
        });
        sequence.push(String(typed.service));
        const completed = {
          ...operation(
            production.id,
            typed.operationType,
            'backend',
            `cutover-${typed.service}`,
            typed.service
          ),
          idempotency_key: `rb2:${production.id}:deploy:prod:backend:${typed.service}`,
          environment: 'prod',
          expected_sha: production.backend_composed_sha,
          artifact_digest: production.backend_artifact_digest,
          request_json: {
            workflow: 'deploy.yml',
            ref: 'main',
            inputs: {
              environment: 'prod',
              service: String(typed.service),
              operation_key: 'replaced-by-reconciler',
              expected_sha: production.backend_composed_sha!,
              artifact_run_id: '201',
              artifact_digest: production.backend_artifact_digest!
            },
            beta_infrastructure_failure_injection: null
          }
        };
        state.repository.operations.push(completed);
        if (typed.service === 'releaseBus') newRuntimeActive = true;
        return completed;
      }
      expect(typed.operationType).toBe('E2E_PROD');
      expect(newRuntimeActive).toBe(true);
      sequence.push('e2e');
      const completed = {
        ...operation(
          production.id,
          'E2E_PROD',
          'frontend',
          'cutover-production-e2e'
        ),
        environment: 'prod',
        expected_sha: production.frontend_composed_sha,
        artifact_digest: 'e'.repeat(64)
      };
      state.repository.operations.push(completed);
      return completed;
    });
    const deploying = state.repository.trains.get(production.id)!;
    const secondContext = {
      ...firstContext,
      train: deploying,
      candidates: [state.repository.candidates.get(selected.id)!]
    };

    await (
      state.reconciler as unknown as {
        advanceProduction(input: typeof secondContext): Promise<void>;
      }
    ).advanceProduction(secondContext);

    expect(sequence).toEqual(['main-cas', 'api', 'releaseBus', 'e2e']);
    expect(releaseNoteSignals).toEqual([
      {
        service: 'api',
        groups: JSON.stringify([
          {
            release_group_id: `pr-${selected.pr_number}`,
            release_group_services: ['api', 'releaseBus'],
            pull_request_number: selected.pr_number,
            publish_release_note: true
          }
        ]),
        publish: 'true',
        optOut: 'false'
      },
      {
        service: 'releaseBus',
        groups: JSON.stringify([
          {
            release_group_id: `pr-${selected.pr_number}`,
            release_group_services: ['api', 'releaseBus'],
            pull_request_number: selected.pr_number,
            publish_release_note: true
          }
        ]),
        publish: 'true',
        optOut: 'false'
      }
    ]);
    expect(
      new Set(
        releaseNoteSignals.flatMap(({ groups }) =>
          (JSON.parse(groups) as Array<{ release_group_id: string }>).map(
            ({ release_group_id }) => release_group_id
          )
        )
      )
    ).toEqual(new Set([`pr-${selected.pr_number}`]));
    expect(
      mockReconcileWorkflow.mock.calls.some(
        ([spec]) =>
          String((spec as { operationType: string }).operationType) ===
          'DEPLOY_FRONTEND_PROD'
      )
    ).toBe(false);
    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'PRODUCTION_DEPLOYED',
        completed_at: expect.any(Number),
        manifest_id: expect.any(String)
      })
    );
    expect(state.repository.candidates.get(selected.id)).toEqual(
      expect.objectContaining({
        status: 'PRODUCTION_DEPLOYED',
        current_train_id: null
      })
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    const workflowCountAfterFinalization =
      mockReconcileWorkflow.mock.calls.length;
    await state.reconciler.runOnce('producer-cutover-duplicate-finalize');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(
      workflowCountAfterFinalization
    );
    expect(
      Array.from(state.repository.manifests.values()).filter(
        ({ train_id, status }) =>
          train_id === production.id && status === 'PRODUCTION_DEPLOYED'
      )
    ).toHaveLength(1);
  });

  it('runs staging E2E from the immutable exact-composition release ref', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'exact-workflow-manifest';
    const exactTrain = train('train-1', {
      manifest_id: manifestId,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: exactTrain.id,
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_DEPLOYED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: null,
      manifest_json: {
        frontend_staging_ref_sha: FRONTEND_SHA,
        backend_staging_ref_sha: BACKEND_SHA
      },
      deployed_at: 2,
      validated_at: null,
      created_at: 2,
      updated_at: 2
    });
    const releaseRef = `release-bus-v2/staging-train-${exactTrain.id}-frontend`;
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) => {
        if (repository === 'frontend' && ref === releaseRef)
          return FRONTEND_SHA;
        if (ref === '1a-staging')
          return repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA;
        return null;
      }
    );
    mockReconcileWorkflow.mockResolvedValue(
      operation(exactTrain.id, 'E2E_STAGING', 'frontend', 'exact-e2e')
    );
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        reconcileE2E(
          input: typeof context,
          environment: 'staging'
        ): Promise<ReleaseBusV2OperationRecord>;
      }
    ).reconcileE2E(context, 'staging');

    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'E2E_STAGING',
        ref: releaseRef,
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: releaseRef,
          expected_sha: FRONTEND_SHA
        })
      })
    );
  });

  it('refuses cumulative E2E when a staging ref no longer matches the manifest', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'moved-staging-ref-manifest';
    const exactTrain = train('train-1', {
      manifest_id: manifestId,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1'
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: exactTrain.id,
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_DEPLOYED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: null,
      manifest_json: {
        frontend_staging_ref_sha: FRONTEND_SHA,
        backend_staging_ref_sha: BACKEND_SHA
      },
      deployed_at: 2,
      validated_at: null,
      created_at: 2,
      updated_at: 2
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) => {
        if (ref !== '1a-staging') return null;
        return repository === 'frontend' ? '9'.repeat(40) : BACKEND_SHA;
      }
    );
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await expect(
      (
        state.reconciler as unknown as {
          reconcileE2E(
            input: typeof context,
            environment: 'staging'
          ): Promise<ReleaseBusV2OperationRecord>;
        }
      ).reconcileE2E(context, 'staging')
    ).rejects.toThrow(
      'E2E refused a staging manifest whose 1a-staging refs no longer match'
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('binds a single-candidate fast path to its immutable release ref before preflight', async () => {
    const state = harness('SUCCEEDED');
    const exactTrain = train('single-fast-path', {
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    const frontendCandidate = {
      ...state.repository.candidates.get('frontend-candidate')!,
      current_train_id: exactTrain.id,
      pr_evidence_json: {
        ...(state.repository.candidates.get('frontend-candidate')!
          .pr_evidence_json as NonNullable<
          ReleaseBusV2CandidateRecord['pr_evidence_json']
        >),
        base_sha: exactTrain.frontend_base_sha!,
        merge_sha: FRONTEND_SHA,
        checks_run_id: '100',
        checks_completed_at: 1,
        artifact_run_id: '100',
        artifact_name: `release-bus-v2-pr-${FRONTEND_SHA}`,
        artifact_digest: FRONTEND_DIGEST
      }
    };
    const context = {
      train: exactTrain,
      memberships: [
        {
          ...state.repository.memberships.find(
            ({ candidate_id }) => candidate_id === 'frontend-candidate'
          )!,
          train_id: exactTrain.id
        }
      ],
      candidates: [frontendCandidate],
      dependencies: []
    };
    mockReconcileWorkflow.mockResolvedValueOnce(
      operation(
        exactTrain.id,
        'PREPARE_ARTIFACT_FRONTEND',
        'frontend',
        'fast-preflight'
      )
    );

    await (
      state.reconciler as unknown as {
        prepareRepository(
          input: typeof context,
          repository: 'frontend'
        ): Promise<unknown>;
      }
    ).prepareRepository(context, 'frontend');

    const releaseRef = `release-bus-v2/staging-train-${exactTrain.id}-frontend`;
    expect(mockCreateRef).toHaveBeenCalledWith(
      'frontend',
      releaseRef,
      FRONTEND_SHA
    );
    expect(mockCreateRef.mock.invocationCallOrder[0]).toBeLessThan(
      mockReconcileWorkflow.mock.invocationCallOrder[0]!
    );
    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: releaseRef,
          expected_sha: FRONTEND_SHA
        })
      })
    );
    const dispatched = mockReconcileWorkflow.mock.calls[0]?.[0] as {
      expectedSha: string;
      inputs: { source_ref: string };
    };
    expect(
      mockImmutableRefs.get(`frontend:${dispatched.inputs.source_ref}`)
    ).toBe(dispatched.expectedSha);
  });

  it.each([
    ['STAGING', 'staging'],
    ['PRODUCTION', 'production']
  ] as const)(
    'dispatches a new legacy frontend %s preparation with its required target environment',
    async (lane, artifactEnvironment) => {
      const state = harness('SUCCEEDED');
      const exactTrain = train(`legacy-frontend-${artifactEnvironment}`, {
        lane,
        frontend_composed_sha: null,
        backend_composed_sha: null,
        frontend_artifact_digest: null,
        backend_artifact_digest: null
      });
      const base = withEvidence(
        state.repository.candidates.get('frontend-candidate')!,
        'legacy-exact-workflow-v0',
        false
      );
      const frontendCandidate = {
        ...base,
        current_train_id: exactTrain.id,
        pr_evidence_json: {
          ...base.pr_evidence_json!,
          base_sha: exactTrain.frontend_base_sha!,
          merge_sha: FRONTEND_SHA
        }
      };
      const context = {
        train: exactTrain,
        memberships: [
          {
            ...state.repository.memberships.find(
              ({ candidate_id }) => candidate_id === 'frontend-candidate'
            )!,
            train_id: exactTrain.id
          }
        ],
        candidates: [frontendCandidate],
        dependencies: []
      };
      mockReconcileWorkflow.mockResolvedValueOnce(
        operation(exactTrain.id, 'PREPARE_ARTIFACT_FRONTEND', 'frontend', '101')
      );

      await (
        state.reconciler as unknown as {
          prepareRepository(
            input: typeof context,
            repository: 'frontend'
          ): Promise<unknown>;
        }
      ).prepareRepository(context, 'frontend');

      expect(mockReconcileWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType: 'PREPARE_ARTIFACT_FRONTEND',
          inputs: expect.objectContaining({
            artifact_contract_version: 'legacy-v2',
            artifact_environment: artifactEnvironment,
            candidate_evidence_mode: 'legacy-whole-train'
          })
        })
      );
    }
  );

  it('preflights cumulative single-candidate staging from the composed release ref', async () => {
    const state = harness('SUCCEEDED');
    const releaseParent = '5'.repeat(40);
    const exactTrain = train('single-cumulative-release', {
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: {
        actor: 'acceptance',
        requested_at: 1,
        baseline_state_version: 1,
        baseline_manifest_id: 'baseline-manifest',
        baseline_frontend_sha: releaseParent,
        baseline_backend_sha: '2'.repeat(40),
        observed_frontend_staging_sha: releaseParent,
        observed_backend_staging_sha: '2'.repeat(40),
        new_candidate_ids: ['frontend-candidate'],
        carried_candidate_ids: []
      }
    });
    const frontendCandidate = {
      ...state.repository.candidates.get('frontend-candidate')!,
      current_train_id: exactTrain.id,
      pr_evidence_json: {
        ...state.repository.candidates.get('frontend-candidate')!
          .pr_evidence_json!,
        base_sha: exactTrain.frontend_base_sha!,
        merge_sha: FRONTEND_SHA,
        checks_run_id: '100',
        checks_completed_at: 1,
        artifact_run_id: '100',
        artifact_name: `release-bus-v2-pr-${FRONTEND_SHA}`,
        artifact_digest: FRONTEND_DIGEST
      }
    };
    const releaseRef = `release-bus-v2/staging-train-${exactTrain.id}-frontend`;
    const context = {
      train: exactTrain,
      memberships: [
        {
          ...state.repository.memberships.find(
            ({ candidate_id }) => candidate_id === 'frontend-candidate'
          )!,
          train_id: exactTrain.id,
          candidate_role: 'NEW' as const
        }
      ],
      candidates: [frontendCandidate],
      dependencies: []
    };
    mockReconcileWorkflow
      .mockResolvedValueOnce(
        operation(
          exactTrain.id,
          'COMPOSE_FRONTEND',
          'frontend',
          'cumulative-compose'
        )
      )
      .mockResolvedValueOnce(
        operation(
          exactTrain.id,
          'PREPARE_ARTIFACT_FRONTEND',
          'frontend',
          'cumulative-preflight'
        )
      );
    mockResolveRef.mockResolvedValue(FRONTEND_SHA);

    await (
      state.reconciler as unknown as {
        prepareRepository(
          input: typeof context,
          repository: 'frontend'
        ): Promise<unknown>;
      }
    ).prepareRepository(context, 'frontend');

    expect(mockReconcileWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operationType: 'COMPOSE_FRONTEND',
        inputs: expect.objectContaining({
          release_parent_sha: releaseParent,
          release_branch: releaseRef
        })
      })
    );
    expect(mockReconcileWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: releaseRef,
          expected_sha: FRONTEND_SHA
        })
      })
    );
  });

  it('fails closed before preflight when a fast-path immutable ref conflicts', async () => {
    const state = harness('SUCCEEDED');
    const exactTrain = train('single-fast-path-conflict', {
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    const frontendCandidate = {
      ...state.repository.candidates.get('frontend-candidate')!,
      current_train_id: exactTrain.id,
      pr_evidence_json: {
        ...(state.repository.candidates.get('frontend-candidate')!
          .pr_evidence_json as NonNullable<
          ReleaseBusV2CandidateRecord['pr_evidence_json']
        >),
        base_sha: exactTrain.frontend_base_sha!,
        merge_sha: FRONTEND_SHA,
        checks_run_id: '100',
        checks_completed_at: 1,
        artifact_run_id: '100',
        artifact_name: `release-bus-v2-pr-${FRONTEND_SHA}`,
        artifact_digest: FRONTEND_DIGEST
      }
    };
    const context = {
      train: exactTrain,
      memberships: [
        {
          ...state.repository.memberships.find(
            ({ candidate_id }) => candidate_id === 'frontend-candidate'
          )!,
          train_id: exactTrain.id
        }
      ],
      candidates: [frontendCandidate],
      dependencies: []
    };
    mockCreateRef.mockRejectedValueOnce(
      new Error('immutable release ref already points elsewhere')
    );

    await expect(
      (
        state.reconciler as unknown as {
          prepareRepository(
            input: typeof context,
            repository: 'frontend'
          ): Promise<unknown>;
        }
      ).prepareRepository(context, 'frontend')
    ).rejects.toThrow('immutable release ref already points elsewhere');

    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('runs backend-only staging E2E from the exact shared staging ref when main moved', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'backend-only-workflow-manifest';
    const exactTrain = train('train-1', {
      manifest_id: manifestId,
      frontend_artifact_digest: null
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'backend-candidate'
      )!
    );
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: exactTrain.id,
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_DEPLOYED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: null,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: null,
      manifest_json: {},
      deployed_at: 2,
      validated_at: null,
      created_at: 2,
      updated_at: 2
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) => {
        if (repository !== 'frontend') return null;
        if (ref === '1a-staging') return FRONTEND_SHA;
        if (ref === 'main') return '9'.repeat(40);
        return null;
      }
    );
    mockReconcileWorkflow.mockResolvedValue(
      operation(exactTrain.id, 'E2E_STAGING', 'frontend', 'exact-e2e')
    );
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        reconcileE2E(
          input: typeof context,
          environment: 'staging'
        ): Promise<ReleaseBusV2OperationRecord>;
      }
    ).reconcileE2E(context, 'staging');

    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'E2E_STAGING',
        ref: '1a-staging',
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: '1a-staging',
          expected_sha: FRONTEND_SHA
        })
      })
    );
  });

  it('keeps repository-wide quality gates in PR CI and off the train path', () => {
    const workflow = readFileSync(
      path.join(
        process.cwd(),
        '.github/workflows/release-bus-v2-preflight.yml'
      ),
      'utf8'
    );
    expect(workflow).toContain('Build and package only selected deploy units');
    expect(workflow).not.toContain('matrix:');
    expect(workflow).not.toContain('jest --listTests');
    expect(workflow).not.toContain('eslint "src/**/*.ts"');
    const pullRequestWorkflow = readFileSync(
      path.join(process.cwd(), '.github/workflows/on-pull-request.yml'),
      'utf8'
    );
    expect(pullRequestWorkflow).toContain('npm run lint:check');
    expect(pullRequestWorkflow).toContain('npm run build');
    const pullRequestWorkflowBlob = execFileSync(
      'git',
      ['hash-object', '.github/workflows/on-pull-request.yml'],
      { cwd: process.cwd(), encoding: 'utf8' }
    ).trim();
    expect([
      '0cc8865dbb869b5156b46cc45e8581b259052916',
      'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40'
    ]).toContain(pullRequestWorkflowBlob);
    if (pullRequestWorkflowBlob === 'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40')
      expect(pullRequestWorkflow).toContain('exact-merge-tree-pr-ci-v1');
  });

  it('never routes a staging or qualification artifact source into production', () => {
    const source = readFileSync(
      path.join(__dirname, 'release-bus-v2.reconciler.ts'),
      'utf8'
    );
    expect(source).toContain(
      "if (train.lane === 'PRODUCTION') return train.id"
    );
    expect(source).not.toContain(
      'Exact staging validation and immutable artifacts are being reused'
    );
    expect(source).not.toContain(
      'findValidatedManifestByRelease(\n        train.frontend_composed_sha'
    );
  });
});
