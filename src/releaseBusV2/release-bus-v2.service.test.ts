const mockResolveRef = jest.fn();
const mockQualification = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    getPullRequestQualification: (...args: unknown[]) =>
      mockQualification(...args),
    ensureCommitStatus: jest.fn()
  }
}));

import { ReleaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import type { ReleaseBusV2CandidateRecord } from '@/releaseBusV2/release-bus-v2.types';

function candidate(
  status: ReleaseBusV2CandidateRecord['status']
): ReleaseBusV2CandidateRecord {
  return {
    id: 'candidate-id',
    repository: 'frontend',
    pr_number: 42,
    branch_name: 'feature/exact',
    head_sha: 'a'.repeat(40),
    requested_by: 'developer',
    status,
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id:
      status === 'STAGING_VALIDATED' ? 'staging-train-id' : null,
    staging_validated_manifest_id:
      status === 'STAGING_VALIDATED' ? 'manifest-id' : null,
    production_requested_at: null,
    production_requested_by: null,
    production_selection_id: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 3
  };
}

function repositoryFor(initial: ReleaseBusV2CandidateRecord) {
  let current = initial;
  return {
    current: () => current,
    repository: {
      listControls: jest.fn(async () => []),
      findCandidateById: jest.fn(async () => current),
      findTrain: jest.fn(async () => ({
        id: 'staging-train-id',
        lane: 'STAGING',
        status: 'STAGING_VALIDATED',
        manifest_id: 'manifest-id'
      })),
      findManifest: jest.fn(async () => ({
        id: 'manifest-id',
        train_id: 'staging-train-id',
        status: 'STAGING_VALIDATED',
        identity_sha256: 'e'.repeat(64),
        frontend_artifact_digest: 'f'.repeat(64),
        backend_artifact_digest: null,
        e2e_run_id: '123',
        manifest_json: {
          candidates: [
            {
              candidate_id: current.id,
              repository: current.repository,
              pr_number: current.pr_number,
              head_sha: current.head_sha
            }
          ]
        }
      })),
      listTrainCandidates: jest.fn(async () => [
        {
          candidate_id: current.id,
          disposition: 'INCLUDED'
        }
      ]),
      listOperations: jest.fn(async () => [
        {
          id: 'staging-e2e-operation',
          operation_type: 'E2E_STAGING',
          status: 'SUCCEEDED',
          external_id: '123'
        }
      ]),
      listDependencies: jest.fn(async () => []),
      listProductionManifestsForCandidate: jest.fn(async () => []),
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      updateCandidate: jest.fn(
        async (
          _id: string,
          rowVersion: number,
          fields: {
            status?: ReleaseBusV2CandidateRecord['status'];
            productionRequestedAt?: number | null;
            productionRequestedBy?: string | null;
            productionSelectionId?: string | null;
          }
        ) => {
          if (rowVersion !== current.row_version) return false;
          current = {
            ...current,
            status: fields.status ?? current.status,
            production_requested_at:
              'productionRequestedAt' in fields
                ? (fields.productionRequestedAt ?? null)
                : current.production_requested_at,
            production_requested_by:
              'productionRequestedBy' in fields
                ? (fields.productionRequestedBy ?? null)
                : current.production_requested_by,
            production_selection_id:
              'productionSelectionId' in fields
                ? (fields.productionSelectionId ?? null)
                : current.production_selection_id,
            row_version: current.row_version + 1
          };
          return true;
        }
      ),
      appendEvent: jest.fn(async () => undefined)
    }
  };
}

function validatedCandidate(
  id: string,
  repository: 'frontend' | 'backend',
  headCharacter: string,
  prNumber: number
): ReleaseBusV2CandidateRecord {
  return {
    ...candidate('STAGING_VALIDATED'),
    id,
    repository,
    pr_number: prNumber,
    branch_name: `feature/${id}`,
    head_sha: headCharacter.repeat(40),
    staging_validated_train_id: `staging-train-${id}`,
    staging_validated_manifest_id: `staging-manifest-${id}`,
    row_version: 1
  };
}

function selectionRepository(
  initial: readonly ReleaseBusV2CandidateRecord[],
  dependencies: readonly {
    readonly candidate_id: string;
    readonly prerequisite_candidate_id: string;
    readonly environment: 'STAGING' | 'PRODUCTION' | 'BOTH';
  }[] = [],
  productionManifests: ReadonlyMap<string, readonly unknown[]> = new Map(),
  productionE2eRuns: ReadonlyMap<string, string> = new Map()
) {
  const candidates = new Map(initial.map((item) => [item.id, item]));
  const appendEvent = jest.fn(async () => undefined);
  const createTrain = jest.fn(
    async (input: {
      lane: string;
      qualificationPolicy?: string;
      qualificationEvidence?: readonly unknown[];
    }) => ({
      id: 'claimed-selection-train',
      lane: input.lane,
      status: 'CLAIMED',
      qualification_policy: input.qualificationPolicy ?? null,
      qualification_evidence_json: input.qualificationEvidence ?? null
    })
  );
  const repository = {
    listControls: jest.fn(async () => []),
    listTrains: jest.fn(async () => []),
    listCandidates: jest.fn(async (statuses: readonly string[]) =>
      Array.from(candidates.values()).filter(({ status }) =>
        statuses.includes(status)
      )
    ),
    acquireLock: jest.fn(async () => ({ lease_token: 'scheduler-lease' })),
    releaseLock: jest.fn(async () => true),
    findCandidateById: jest.fn(
      async (id: string) => candidates.get(id) ?? null
    ),
    findLatestProductionTrainForCandidate: jest.fn(async () => null),
    findTrain: jest.fn(async (id: string) => {
      const item = Array.from(candidates.values()).find(
        ({ staging_validated_train_id }) => staging_validated_train_id === id
      );
      return item
        ? {
            id,
            lane: 'STAGING',
            status: 'STAGING_VALIDATED',
            manifest_id: item.staging_validated_manifest_id
          }
        : null;
    }),
    findManifest: jest.fn(async (id: string) => {
      const item = Array.from(candidates.values()).find(
        ({ staging_validated_manifest_id }) =>
          staging_validated_manifest_id === id
      );
      return item
        ? {
            id,
            train_id: item.staging_validated_train_id,
            status: 'STAGING_VALIDATED',
            identity_sha256: `${item.pr_number}`.padStart(64, '0'),
            frontend_artifact_digest:
              item.repository === 'frontend' ? 'e'.repeat(64) : null,
            backend_artifact_digest:
              item.repository === 'backend' ? 'f'.repeat(64) : null,
            e2e_run_id: `e2e-${item.id}`,
            manifest_json: {
              candidates: [
                {
                  candidate_id: item.id,
                  repository: item.repository,
                  pr_number: item.pr_number,
                  head_sha: item.head_sha
                }
              ]
            }
          }
        : null;
    }),
    listTrainCandidates: jest.fn(async (trainId: string) => {
      const item = Array.from(candidates.values()).find(
        ({ staging_validated_train_id }) =>
          staging_validated_train_id === trainId
      );
      return item ? [{ candidate_id: item.id, disposition: 'INCLUDED' }] : [];
    }),
    listOperations: jest.fn(async (trainId: string) => {
      const item = Array.from(candidates.values()).find(
        ({ staging_validated_train_id }) =>
          staging_validated_train_id === trainId
      );
      if (item)
        return [
          {
            id: `e2e-operation-${item.id}`,
            operation_type: 'E2E_STAGING',
            status: 'SUCCEEDED',
            external_id: `e2e-${item.id}`
          }
        ];
      const productionRun = productionE2eRuns.get(trainId);
      return productionRun
        ? [
            {
              id: `production-e2e-operation-${trainId}`,
              operation_type: 'E2E_PROD',
              status: 'SUCCEEDED',
              external_id: productionRun
            }
          ]
        : [];
    }),
    listDependencies: jest.fn(async (candidateIds: readonly string[]) =>
      dependencies.filter(({ candidate_id }) =>
        candidateIds.includes(candidate_id)
      )
    ),
    listProductionManifestsForCandidate: jest.fn(async (id: string) =>
      Array.from(productionManifests.get(id) ?? [])
    ),
    listEvents: jest.fn(async (): Promise<unknown[]> => []),
    createTrain,
    executeNativeQueriesInTransaction: jest.fn(
      async (callback: (connection: unknown) => Promise<unknown>) =>
        callback({})
    ),
    updateCandidate: jest.fn(
      async (
        id: string,
        rowVersion: number,
        fields: {
          status?: ReleaseBusV2CandidateRecord['status'];
          productionRequestedAt?: number | null;
          productionRequestedBy?: string | null;
          productionSelectionId?: string | null;
          currentTrainId?: string | null;
          holdReason?: string | null;
        }
      ) => {
        const item = candidates.get(id);
        if (!item || item.row_version !== rowVersion) return false;
        candidates.set(id, {
          ...item,
          status: fields.status ?? item.status,
          production_requested_at:
            fields.productionRequestedAt ?? item.production_requested_at,
          production_requested_by:
            fields.productionRequestedBy ?? item.production_requested_by,
          production_selection_id:
            fields.productionSelectionId ?? item.production_selection_id,
          current_train_id:
            fields.currentTrainId === undefined
              ? item.current_train_id
              : fields.currentTrainId,
          hold_reason:
            fields.holdReason === undefined
              ? item.hold_reason
              : fields.holdReason,
          row_version: item.row_version + 1
        });
        return true;
      }
    ),
    appendEvent
  };
  return { candidates, repository, appendEvent, createTrain };
}

function retryQualificationEvidence(candidate: ReleaseBusV2CandidateRecord) {
  return {
    candidate_id: candidate.id,
    repository: candidate.repository,
    pr_number: candidate.pr_number,
    head_sha: candidate.head_sha,
    staging_train_id: candidate.staging_validated_train_id,
    staging_manifest_id: candidate.staging_validated_manifest_id,
    staging_manifest_identity_sha256: 'e'.repeat(64),
    staging_e2e_operation_id: `e2e-operation-${candidate.id}`,
    staging_e2e_run_id: `e2e-${candidate.id}`
  };
}

function configureRetrySource(
  state: ReturnType<typeof selectionRepository>,
  candidate: ReleaseBusV2CandidateRecord,
  options: {
    readonly trainId: string;
    readonly operations: readonly {
      readonly id: string;
      readonly operation_type: string;
      readonly status: string;
      readonly external_id: string;
    }[];
    readonly evidence?: readonly unknown[];
  }
) {
  const train = {
    id: options.trainId,
    lane: 'PRODUCTION',
    status: 'FAILED',
    failure_class: 'CANDIDATE',
    completed_at: 20,
    qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
    qualification_evidence_json: options.evidence ?? [
      retryQualificationEvidence(candidate)
    ]
  };
  const originalListOperations =
    state.repository.listOperations.getMockImplementation()!;
  state.repository.findLatestProductionTrainForCandidate.mockResolvedValue(
    train as never
  );
  state.repository.listOperations.mockImplementation(async (trainId: string) =>
    trainId === train.id
      ? (options.operations as never)
      : originalListOperations(trainId)
  );
  return train;
}

describe('Release Bus v2 explicit production opt-in', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
  });

  it('does not accept a candidate merely because it is staging-ready', async () => {
    const state = repositoryFor(candidate('READY_FOR_STAGING'));
    const service = new ReleaseBusV2Service(state.repository as never);
    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('not staging validated');
    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(state.current().production_requested_at).toBeNull();
  });

  it('requires an unchanged exact branch SHA before recording explicit readiness', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    mockResolveRef.mockResolvedValue('b'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);
    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('moved after staging validation');
    expect(state.current().status).toBe('STAGING_VALIDATED');
  });

  it('rechecks the exact branch SHA while the selected candidate row is locked', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    mockResolveRef
      .mockResolvedValueOnce('a'.repeat(40))
      .mockResolvedValueOnce('b'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('changed after branch verification');
    expect(state.current().status).toBe('STAGING_VALIDATED');
    expect(state.repository.updateCandidate).not.toHaveBeenCalled();
  });

  it('records rollout-safe candidate-evidence readiness only after the explicit exact-SHA action', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    mockResolveRef.mockResolvedValue('a'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);
    const result = await service.markReadyForProduction(
      'candidate-id',
      'a'.repeat(40),
      3,
      'owner'
    );
    expect(result.status).toBe('READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION');
    expect(result.production_requested_by).toBe('owner');
    expect(result.production_requested_at).not.toBeNull();
    expect(state.repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CANDIDATE_READY_FOR_PRODUCTION',
        actor: 'owner'
      }),
      expect.anything()
    );
  });

  it('permits an explicit exact-evidence retry after a pre-main candidate preflight failure', async () => {
    const failed = {
      ...validatedCandidate('candidate-retry', 'backend', '4', 112),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'failed-selection'
    };
    const failedTrain = {
      id: 'failed-pre-main-production-train',
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CANDIDATE',
      completed_at: 20,
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
      qualification_evidence_json: [retryQualificationEvidence(failed)]
    };
    const state = selectionRepository([failed]);
    const originalListOperations =
      state.repository.listOperations.getMockImplementation()!;
    state.repository.findLatestProductionTrainForCandidate.mockResolvedValue(
      failedTrain as never
    );
    state.repository.listOperations.mockImplementation(
      async (trainId: string) =>
        trainId === failedTrain.id
          ? [
              {
                id: 'failed-preflight',
                operation_type: 'PREPARE_ARTIFACT_BACKEND',
                status: 'FAILED',
                external_id: '100'
              }
            ]
          : originalListOperations(trainId)
    );
    mockResolveRef.mockResolvedValue(failed.head_sha);
    const service = new ReleaseBusV2Service(state.repository as never);

    const selected = await service.markSelectionReadyForProduction(
      [
        {
          candidateId: failed.id,
          expectedHeadSha: failed.head_sha,
          expectedRowVersion: failed.row_version
        }
      ],
      'operator'
    );

    expect(selected).toEqual([
      expect.objectContaining({
        id: failed.id,
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        staging_validated_train_id: failed.staging_validated_train_id,
        staging_validated_manifest_id: failed.staging_validated_manifest_id
      })
    ]);
    expect(selected[0]?.production_selection_id).not.toBe(
      failed.production_selection_id
    );
    expect(
      state.repository.findLatestProductionTrainForCandidate
    ).toHaveBeenLastCalledWith(
      failed.id,
      expect.objectContaining({ connection: expect.anything() }),
      true
    );
    expect(state.repository.listOperations).toHaveBeenCalledWith(
      failedTrain.id,
      expect.objectContaining({ connection: expect.anything() }),
      true
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_SELECTION_READY',
        payload: expect.objectContaining({
          retry_sources: [
            {
              candidate_id: failed.id,
              failed_train_id: failedTrain.id
            }
          ]
        })
      }),
      expect.anything()
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: failed.id,
        eventType: 'CANDIDATE_PRE_MAIN_PRODUCTION_RETRY_READY',
        payload: expect.objectContaining({
          failed_train_id: failedTrain.id,
          head_sha: failed.head_sha
        })
      }),
      expect.anything()
    );
  });

  it('rejects retry after any production main-ref mutation operation was created', async () => {
    const failed = {
      ...validatedCandidate('candidate-post-main', 'backend', '5', 113),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'post-main-selection'
    };
    const failedTrain = {
      id: 'failed-post-main-production-train',
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CANDIDATE',
      completed_at: 20,
      qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
      qualification_evidence_json: [retryQualificationEvidence(failed)]
    };
    const state = selectionRepository([failed]);
    state.repository.findLatestProductionTrainForCandidate.mockResolvedValue(
      failedTrain as never
    );
    state.repository.listOperations.mockResolvedValue([
      {
        id: 'failed-preflight',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        status: 'FAILED',
        external_id: '100'
      },
      {
        id: 'main-advanced',
        operation_type: 'ADVANCE_MAIN_BACKEND',
        status: 'SUCCEEDED',
        external_id: failed.head_sha
      }
    ]);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: failed.id,
            expectedHeadSha: failed.head_sha,
            expectedRowVersion: failed.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(
      'Failed candidate is not eligible for an exact pre-main production retry'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('rejects a failed candidate that still belongs to an active train', async () => {
    const failed = {
      ...validatedCandidate('candidate-active-failure', 'backend', '6', 114),
      status: 'FAILED' as const,
      current_train_id: 'active-train',
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'active-selection'
    };
    const state = selectionRepository([failed]);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: failed.id,
            expectedHeadSha: failed.head_sha,
            expectedRowVersion: failed.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow('not staging validated');
    expect(
      state.repository.findLatestProductionTrainForCandidate
    ).not.toHaveBeenCalled();
  });

  it('rejects a failed train without a failed immutable preflight', async () => {
    const failed = {
      ...validatedCandidate('candidate-no-preflight', 'backend', '7', 115),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'no-preflight-selection'
    };
    const state = selectionRepository([failed]);
    configureRetrySource(state, failed, {
      trainId: 'failed-without-preflight',
      operations: [
        {
          id: 'compose-only',
          operation_type: 'COMPOSE_BACKEND',
          status: 'SUCCEEDED',
          external_id: '200'
        }
      ]
    });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: failed.id,
            expectedHeadSha: failed.head_sha,
            expectedRowVersion: failed.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(
      'Failed candidate is not eligible for an exact pre-main production retry'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('rejects a retry source whose qualified head does not match the candidate', async () => {
    const failed = {
      ...validatedCandidate('candidate-mismatched-retry', 'backend', '8', 116),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'mismatched-selection'
    };
    const state = selectionRepository([failed]);
    configureRetrySource(state, failed, {
      trainId: 'failed-with-mismatched-head',
      evidence: [
        {
          ...retryQualificationEvidence(failed),
          head_sha: '9'.repeat(40)
        }
      ],
      operations: [
        {
          id: 'failed-preflight',
          operation_type: 'PREPARE_ARTIFACT_BACKEND',
          status: 'FAILED',
          external_id: '201'
        }
      ]
    });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: failed.id,
            expectedHeadSha: failed.head_sha,
            expectedRowVersion: failed.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(
      'Failed candidate retry source does not match its exact staging evidence'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('rejects a failed train with no durable pre-main operations', async () => {
    const failed = {
      ...validatedCandidate('candidate-empty-operations', 'backend', '9', 119),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'current-selection'
    };
    const state = selectionRepository([failed]);
    configureRetrySource(state, failed, {
      trainId: 'failed-without-operations',
      operations: []
    });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: failed.id,
            expectedHeadSha: failed.head_sha,
            expectedRowVersion: failed.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(
      'Failed candidate is not eligible for an exact pre-main production retry'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('atomically mixes a normal validated candidate with one exact pre-main retry', async () => {
    const normal = validatedCandidate(
      'candidate-normal-selection',
      'frontend',
      'a',
      117
    );
    const failed = {
      ...validatedCandidate('candidate-retry-selection', 'backend', 'b', 118),
      status: 'FAILED' as const,
      production_requested_at: 10,
      production_requested_by: 'operator',
      production_selection_id: 'mixed-failed-selection'
    };
    const state = selectionRepository([normal, failed]);
    const failedTrain = configureRetrySource(state, failed, {
      trainId: 'failed-mixed-selection-train',
      operations: [
        {
          id: 'failed-preflight',
          operation_type: 'PREPARE_ARTIFACT_BACKEND',
          status: 'FAILED',
          external_id: '202'
        }
      ]
    });
    mockResolveRef.mockImplementation(
      async (_repository: string, branch: string) =>
        [normal, failed].find((item) => item.branch_name === branch)?.head_sha
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    const selected = await service.markSelectionReadyForProduction(
      [normal, failed].map((item) => ({
        candidateId: item.id,
        expectedHeadSha: item.head_sha,
        expectedRowVersion: item.row_version
      })),
      'operator'
    );

    expect(
      selected
        .map(({ id }) => id)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(
      [normal.id, failed.id].sort((left, right) => left.localeCompare(right))
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_SELECTION_READY',
        payload: expect.objectContaining({
          retry_sources: [
            {
              candidate_id: failed.id,
              failed_train_id: failedTrain.id
            }
          ]
        })
      }),
      expect.anything()
    );
  });

  it('atomically selects A+C from independently validated A+B+C and preserves B', async () => {
    const a = validatedCandidate('candidate-a', 'frontend', 'a', 101);
    const b = validatedCandidate('candidate-b', 'backend', 'b', 102);
    const c = validatedCandidate('candidate-c', 'backend', 'c', 103);
    const state = selectionRepository(
      [a, b, c],
      [
        {
          candidate_id: c.id,
          prerequisite_candidate_id: a.id,
          environment: 'BOTH'
        }
      ]
    );
    mockResolveRef.mockImplementation(
      async (_repository: string, branch: string) =>
        [a, b, c].find((item) => item.branch_name === branch)?.head_sha
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    const selected = await service.markSelectionReadyForProduction(
      [a, c].map((item) => ({
        candidateId: item.id,
        expectedHeadSha: item.head_sha,
        expectedRowVersion: item.row_version
      })),
      'operator'
    );

    expect(selected.map(({ id }) => id).sort()).toEqual([a.id, c.id]);
    expect(
      new Set(
        selected.map(({ production_selection_id }) => production_selection_id)
      ).size
    ).toBe(1);
    expect(state.candidates.get(b.id)).toEqual(b);
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_SELECTION_READY',
        payload: expect.objectContaining({
          qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
          candidate_ids: [a.id, c.id],
          candidate_evidence: expect.arrayContaining([
            expect.objectContaining({
              candidate_id: a.id,
              staging_train_id: a.staging_validated_train_id,
              staging_manifest_id: a.staging_validated_manifest_id
            }),
            expect.objectContaining({
              candidate_id: c.id,
              staging_train_id: c.staging_validated_train_id,
              staging_manifest_id: c.staging_validated_manifest_id
            })
          ])
        })
      }),
      expect.anything()
    );

    const claimed = await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );
    expect(claimed).toEqual(
      expect.objectContaining({
        id: 'claimed-selection-train',
        qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
      })
    );
    expect(state.createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [a.id, c.id],
        qualificationPolicy: 'CANDIDATE_STAGING_EVIDENCE_V1',
        qualificationEvidence: expect.arrayContaining([
          expect.objectContaining({ candidate_id: a.id }),
          expect.objectContaining({ candidate_id: c.id })
        ])
      }),
      expect.anything()
    );
    expect(state.repository.listCandidates).toHaveBeenCalledWith(
      expect.arrayContaining(['READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION']),
      expect.any(Number),
      expect.anything()
    );
    expect(state.candidates.get(b.id)).toEqual(b);
  });

  it('rejects an omitted production dependency without exact deployed identity', async () => {
    const prerequisite = validatedCandidate(
      'candidate-prerequisite',
      'backend',
      'd',
      104
    );
    const dependent = validatedCandidate(
      'candidate-dependent',
      'frontend',
      'e',
      105
    );
    const dependency = {
      candidate_id: dependent.id,
      prerequisite_candidate_id: prerequisite.id,
      environment: 'PRODUCTION' as const
    };
    const state = selectionRepository([prerequisite, dependent], [dependency]);
    mockResolveRef.mockResolvedValue(dependent.head_sha);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: dependent.id,
            expectedHeadSha: dependent.head_sha,
            expectedRowVersion: dependent.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(`omits undeployed dependency ${prerequisite.id}`);
    expect(state.candidates.get(dependent.id)?.status).toBe(
      'STAGING_VALIDATED'
    );
  });

  it('accepts an omitted dependency only with its exact terminal production manifest and E2E', async () => {
    const prerequisite = {
      ...validatedCandidate('candidate-deployed', 'backend', 'f', 106),
      status: 'PRODUCTION_DEPLOYED' as const
    };
    const dependent = validatedCandidate(
      'candidate-next',
      'frontend',
      '1',
      107
    );
    const productionManifest = {
      train_id: 'production-train-deployed',
      manifest_json: {
        candidates: [
          {
            candidate_id: prerequisite.id,
            repository: prerequisite.repository,
            pr_number: prerequisite.pr_number,
            head_sha: prerequisite.head_sha
          }
        ],
        operations: [{ type: 'E2E_PROD', workflow_run_id: '987' }]
      }
    };
    const state = selectionRepository(
      [prerequisite, dependent],
      [
        {
          candidate_id: dependent.id,
          prerequisite_candidate_id: prerequisite.id,
          environment: 'BOTH'
        }
      ],
      new Map([[prerequisite.id, [productionManifest]]]),
      new Map([['production-train-deployed', '987']])
    );
    mockResolveRef.mockResolvedValue(dependent.head_sha);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: dependent.id,
            expectedHeadSha: dependent.head_sha,
            expectedRowVersion: dependent.row_version
          }
        ],
        'operator'
      )
    ).resolves.toEqual([
      expect.objectContaining({
        id: dependent.id,
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION'
      })
    ]);
    expect(state.repository.findCandidateById).toHaveBeenCalledWith(
      prerequisite.id,
      expect.objectContaining({ connection: expect.anything() }),
      true
    );
  });

  it('rejects a deployed dependency whose manifest lacks a matching successful E2E operation', async () => {
    const prerequisite = {
      ...validatedCandidate('candidate-unverified-deploy', 'backend', '6', 109),
      status: 'PRODUCTION_DEPLOYED' as const
    };
    const dependent = validatedCandidate(
      'candidate-after-unverified',
      'frontend',
      '7',
      110
    );
    const state = selectionRepository(
      [prerequisite, dependent],
      [
        {
          candidate_id: dependent.id,
          prerequisite_candidate_id: prerequisite.id,
          environment: 'PRODUCTION'
        }
      ],
      new Map([
        [
          prerequisite.id,
          [
            {
              train_id: 'production-train-without-e2e',
              manifest_json: {
                candidates: [
                  {
                    candidate_id: prerequisite.id,
                    repository: prerequisite.repository,
                    pr_number: prerequisite.pr_number,
                    head_sha: prerequisite.head_sha
                  }
                ],
                operations: [{ type: 'E2E_PROD', workflow_run_id: '988' }]
              }
            }
          ]
        ]
      ])
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: dependent.id,
            expectedHeadSha: dependent.head_sha,
            expectedRowVersion: dependent.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow(`omits undeployed dependency ${prerequisite.id}`);
  });

  it('fails closed when successful staging E2E evidence is missing', async () => {
    const exact = validatedCandidate(
      'candidate-missing-e2e',
      'frontend',
      '2',
      108
    );
    const state = selectionRepository([exact]);
    state.repository.listOperations.mockResolvedValue([]);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: exact.id,
            expectedHeadSha: exact.head_sha,
            expectedRowVersion: exact.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow('missing exact E2E or artifact identity');
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('fails closed when staging evidence maps one manifest run to multiple operations', async () => {
    const exact = validatedCandidate(
      'candidate-ambiguous-e2e',
      'frontend',
      '3',
      111
    );
    const state = selectionRepository([exact]);
    state.repository.listOperations.mockResolvedValue([
      {
        id: 'first-e2e-operation',
        operation_type: 'E2E_STAGING',
        status: 'SUCCEEDED',
        external_id: `e2e-${exact.id}`
      },
      {
        id: 'duplicate-e2e-operation',
        operation_type: 'E2E_STAGING',
        status: 'SUCCEEDED',
        external_id: `e2e-${exact.id}`
      }
    ]);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markSelectionReadyForProduction(
        [
          {
            candidateId: exact.id,
            expectedHeadSha: exact.head_sha,
            expectedRowVersion: exact.row_version
          }
        ],
        'operator'
      )
    ).rejects.toThrow('missing exact E2E or artifact identity');
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('accepts one legacy manifest identity only when exact train membership disambiguates it', async () => {
    const exact = candidate('STAGING_VALIDATED');
    const state = repositoryFor(exact);
    state.repository.findManifest.mockResolvedValue({
      id: 'manifest-id',
      train_id: 'staging-train-id',
      status: 'STAGING_VALIDATED',
      identity_sha256: 'e'.repeat(64),
      frontend_artifact_digest: 'f'.repeat(64),
      backend_artifact_digest: null,
      e2e_run_id: '123',
      manifest_json: {
        candidates: [
          {
            repository: exact.repository,
            pr_number: exact.pr_number,
            head_sha: exact.head_sha
          }
        ]
      }
    } as never);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.resolveCandidateStagingEvidence([exact], {})
    ).resolves.toEqual([
      expect.objectContaining({
        candidate_id: exact.id,
        staging_manifest_id: 'manifest-id',
        staging_e2e_operation_id: 'staging-e2e-operation'
      })
    ]);
  });

  it('does not treat a missing candidate id as a wildcard in a mixed manifest', async () => {
    const exact = candidate('STAGING_VALIDATED');
    const state = repositoryFor(exact);
    state.repository.findManifest.mockResolvedValue({
      id: 'manifest-id',
      train_id: 'staging-train-id',
      status: 'STAGING_VALIDATED',
      identity_sha256: 'e'.repeat(64),
      frontend_artifact_digest: 'f'.repeat(64),
      backend_artifact_digest: null,
      e2e_run_id: '123',
      manifest_json: {
        candidates: [
          {
            candidate_id: 'another-candidate',
            repository: 'backend',
            pr_number: 9,
            head_sha: '9'.repeat(40)
          },
          {
            repository: exact.repository,
            pr_number: exact.pr_number,
            head_sha: exact.head_sha
          }
        ]
      }
    } as never);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.resolveCandidateStagingEvidence([exact], {})
    ).rejects.toThrow('missing exact E2E or artifact identity');
  });
});

describe('Release Bus v2 STAGING-mode production beta opt-in', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  const betaId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: betaId,
        repository: 'frontend',
        branch_name: 'feature/exact',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  it('allows only the exact validated allowlisted operator candidate', async () => {
    const exact = {
      ...candidate('STAGING_VALIDATED'),
      id: betaId,
      requested_by: 'beta-operator'
    };
    const state = repositoryFor(exact);
    mockResolveRef.mockResolvedValue(exact.head_sha);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction(
        betaId,
        exact.head_sha,
        exact.row_version,
        'beta-operator'
      )
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION'
      })
    );
  });

  it('does not broaden production readiness to another actor', async () => {
    const exact = {
      ...candidate('STAGING_VALIDATED'),
      id: betaId,
      requested_by: 'beta-operator'
    };
    const state = repositoryFor(exact);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction(
        betaId,
        exact.head_sha,
        exact.row_version,
        'another-actor'
      )
    ).rejects.toThrow('production readiness is disabled');
    expect(mockResolveRef).not.toHaveBeenCalled();
  });
});

describe('Release Bus v2 globally-OFF operator beta registration', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  const betaId = '11111111-1111-4111-8111-111111111111';
  const headSha = 'b'.repeat(40);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: betaId,
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockResolvedValue(headSha);
    mockQualification.mockResolvedValue({
      baseSha: 'c'.repeat(40),
      mergeSha: 'd'.repeat(40),
      checksRunId: '100',
      checksCompletedAt: 1,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null,
      contributorGithubLogins: ['GelatoGenesis', 'ragnep']
    });
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  function input() {
    return {
      candidate_id: betaId,
      repository: 'backend' as const,
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      expected_head_sha: headSha,
      deploy_plan: { units: ['api'], edges: [] },
      dependencies: []
    };
  }

  function betaRepository() {
    const createCandidate = jest.fn(async (value) => ({
      ...candidate('READY_FOR_STAGING'),
      id: value.candidateId,
      repository: value.repository,
      pr_number: value.prNumber,
      branch_name: value.branchName,
      head_sha: value.headSha,
      requested_by: value.requestedBy,
      deploy_plan_json: value.deployPlan,
      pr_evidence_json: value.prEvidence
    }));
    return {
      createCandidate,
      listControls: jest.fn(async () => []),
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback({})
      ),
      supersedeOtherPrHeads: jest.fn(async () => []),
      findCandidateById: jest.fn(async () => null),
      findCandidateByIdentity: jest.fn(async () => null),
      listDependencies: jest.fn(async () => []),
      addDependency: jest.fn(async () => undefined),
      listCandidates: jest.fn(async () => []),
      appendEvent: jest.fn(async () => undefined)
    };
  }

  it('creates only the exact configured synthetic candidate id', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).resolves.toEqual(
      expect.objectContaining({
        id: betaId,
        branch_name: 'agent/rb2-beta-backend-one',
        requested_by: 'BETA-OPERATOR'
      })
    );
    expect(repository.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: betaId,
        prEvidence: expect.objectContaining({
          contributor_github_logins: ['GelatoGenesis', 'ragnep']
        })
      }),
      expect.anything()
    );
    expect(repository.supersedeOtherPrHeads).not.toHaveBeenCalled();
  });

  it('rejects an unlisted actor without resolving or mutating the candidate', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'ordinary-agent')).rejects.toThrow(
      'staging readiness is disabled'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects a branch that moves while contributor evidence is collected', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);
    mockResolveRef
      .mockResolvedValueOnce(headSha)
      .mockResolvedValueOnce('f'.repeat(40));

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      `Branch moved from ${headSha} to ${'f'.repeat(40)}`
    );
    expect(mockQualification).toHaveBeenCalledTimes(1);
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('reports a branch deleted while contributor evidence is collected', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);
    mockResolveRef
      .mockResolvedValueOnce(headSha)
      .mockRejectedValueOnce(
        new Error(
          'Failed to resolve backend ref agent/rb2-beta-backend-one: 404 Not Found'
        )
      );

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      'Failed to resolve backend ref agent/rb2-beta-backend-one: 404 Not Found'
    );
    expect(mockQualification).toHaveBeenCalledTimes(1);
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects reusing the one-shot beta id after the branch head moves', async () => {
    const repository = betaRepository();
    repository.findCandidateById.mockResolvedValue({
      ...candidate('READY_FOR_STAGING'),
      id: betaId,
      repository: 'backend',
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      head_sha: 'a'.repeat(40),
      requested_by: 'BETA-OPERATOR'
    } as never);
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      'beta candidate id is immutable'
    );
    expect(repository.findCandidateByIdentity).not.toHaveBeenCalled();
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects a beta id when the exact identity already belongs to another candidate', async () => {
    const repository = betaRepository();
    repository.findCandidateByIdentity.mockResolvedValue({
      ...candidate('READY_FOR_STAGING'),
      id: '22222222-2222-4222-8222-222222222222',
      repository: 'backend',
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      head_sha: headSha,
      requested_by: 'ordinary-registration'
    } as never);
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      'exact beta identity already has a different candidate id'
    );
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });
});

describe('Release Bus v2 globally-OFF beta claim isolation', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  const betaId = '11111111-1111-4111-8111-111111111111';
  const unrelatedId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'isolated-active-train-1',
        candidate_id: betaId,
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  function claimRepository(options: { betaTrainActive: boolean }) {
    const betaCandidate = {
      ...candidate(
        options.betaTrainActive ? 'STAGING_BUILDING' : 'READY_FOR_STAGING'
      ),
      id: betaId,
      repository: 'backend' as const,
      branch_name: 'agent/rb2-beta-backend-one',
      requested_by: 'beta-operator',
      current_train_id: options.betaTrainActive ? 'beta-train' : null
    };
    const unrelatedCandidate = {
      ...candidate('STAGING_BUILDING'),
      id: unrelatedId,
      repository: 'frontend' as const,
      branch_name: 'developer/ordinary-work',
      requested_by: 'ordinary-developer',
      current_train_id: 'unrelated-train'
    };
    const unrelatedTrain = {
      id: 'unrelated-train',
      lane: 'STAGING',
      status: 'PREFLIGHTING'
    };
    const betaTrain = {
      id: 'beta-train',
      lane: 'STAGING',
      status: 'PREFLIGHTING'
    };
    const createdTrain = {
      id: 'new-beta-train',
      lane: 'STAGING',
      status: 'COMPOSING'
    };
    const trains = options.betaTrainActive
      ? [unrelatedTrain, betaTrain]
      : [unrelatedTrain];
    const createTrain = jest.fn(async () => createdTrain);
    const repository = {
      listControls: jest.fn(async () => []),
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback({})
      ),
      acquireLock: jest.fn(async () => ({ lease_token: 'scheduler-token' })),
      releaseLock: jest.fn(async () => true),
      listTrains: jest.fn(async () => trains),
      listCandidates: jest.fn(async (statuses: readonly string[]) =>
        [betaCandidate].filter((item) => statuses.includes(item.status))
      ),
      listTrainCandidates: jest.fn(async (trainId: string) => [
        {
          candidate_id:
            trainId === 'beta-train' ? betaId : unrelatedCandidate.id
        }
      ]),
      findCandidateById: jest.fn(async (id: string) =>
        id === betaId ? betaCandidate : unrelatedCandidate
      ),
      listDependencies: jest.fn(async () => []),
      createTrain,
      updateCandidate: jest.fn(async () => true),
      appendEvent: jest.fn(async () => undefined)
    };
    return { repository, createTrain, createdTrain, betaTrain };
  }

  it('ignores a non-allowlisted active train when claiming an isolated beta', async () => {
    const state = claimRepository({ betaTrainActive: false });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.claimLane('STAGING', 'a'.repeat(40), 'b'.repeat(40), 'beta-claim')
    ).resolves.toEqual(state.createdTrain);
    expect(state.createTrain).toHaveBeenCalledWith(
      expect.objectContaining({ candidateIds: [betaId] }),
      expect.anything()
    );
  });

  it('reuses an existing allowlisted beta train instead of creating another', async () => {
    const state = claimRepository({ betaTrainActive: true });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.claimLane('STAGING', 'a'.repeat(40), 'b'.repeat(40), 'beta-claim')
    ).resolves.toEqual(state.betaTrain);
    expect(state.createTrain).not.toHaveBeenCalled();
  });
});
