const mockResolveRef = jest.fn();
const mockResolveRefIfExists = jest.fn();
const mockQualification = jest.fn();
const mockEnsureCommitStatus = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    resolveRefIfExists: (...args: unknown[]) => mockResolveRefIfExists(...args),
    getPullRequestQualification: (...args: unknown[]) =>
      mockQualification(...args),
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args)
  }
}));

import {
  irreversibleProductionOperationReason,
  ReleaseBusV2Service
} from '@/releaseBusV2/release-bus-v2.service';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

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
      acquireLock: jest.fn(async () => ({ lease_token: 'scheduler-lease' })),
      releaseLock: jest.fn(async () => true),
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

function currentStagingRepairRepository(options?: {
  readonly duplicateManifestIdentity?: boolean;
  readonly activeTrain?: boolean;
  readonly initialStatus?: 'FAILED' | 'SUPERSEDED';
  readonly historicalValidationPointers?: boolean;
}) {
  let current: ReleaseBusV2CandidateRecord = {
    ...candidate(options?.initialStatus ?? 'SUPERSEDED'),
    staging_validated_train_id: options?.historicalValidationPointers
      ? 'historical-staging-train'
      : 'current-staging-train',
    staging_validated_manifest_id: options?.historicalValidationPointers
      ? 'historical-staging-manifest'
      : 'current-staging-manifest',
    staging_live_state: 'NOT_LIVE',
    staging_live_manifest_id: null,
    staging_admitted_at: 10,
    staging_live_updated_at: 11,
    superseded_at: 12
  };
  const manifestIdentity = {
    candidate_id: current.id,
    repository: current.repository,
    pr_number: current.pr_number,
    head_sha: current.head_sha
  };
  const appendEvent = jest.fn(
    async (_event: { readonly eventType: string }, _ctx?: unknown) => undefined
  );
  const updateCandidate = jest.fn(
    async (
      _id: string,
      rowVersion: number,
      fields: Record<string, unknown>
    ) => {
      if (rowVersion !== current.row_version) return false;
      current = {
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
        staging_live_state:
          (fields.stagingLiveState as 'LIVE' | 'NOT_LIVE' | undefined) ??
          current.staging_live_state,
        staging_live_manifest_id:
          fields.stagingLiveManifestId === undefined
            ? current.staging_live_manifest_id
            : (fields.stagingLiveManifestId as string | null),
        staging_admitted_at:
          fields.stagingAdmittedAt === undefined
            ? current.staging_admitted_at
            : (fields.stagingAdmittedAt as number | null),
        staging_live_updated_at:
          fields.stagingLiveUpdatedAt === undefined
            ? current.staging_live_updated_at
            : (fields.stagingLiveUpdatedAt as number | null),
        hold_reason:
          fields.holdReason === undefined
            ? current.hold_reason
            : (fields.holdReason as string | null),
        superseded_at:
          fields.supersededAt === undefined
            ? current.superseded_at
            : (fields.supersededAt as number | null),
        row_version: current.row_version + 1
      };
      return true;
    }
  );
  const train = {
    id: 'current-staging-train',
    lane: 'STAGING',
    status: options?.activeTrain ? 'PREFLIGHTING' : 'STAGING_VALIDATED',
    manifest_id: 'current-staging-manifest'
  };
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(
      async (callback: (connection: unknown) => Promise<unknown>) =>
        callback({})
    ),
    acquireLock: jest.fn(async (name: string) => ({
      lease_token: `${name}-lease`
    })),
    releaseLock: jest.fn(async (_name: string, _leaseToken: string) => true),
    listActiveTrains: jest.fn(async () =>
      options?.activeTrain ? [train] : []
    ),
    listLocks: jest.fn(async () => [
      {
        name: 'scheduler',
        lease_token: null,
        expires_at: null
      },
      {
        name: 'staging-environment',
        lease_token: null,
        expires_at: null
      },
      {
        name: 'production-environment',
        lease_token: null,
        expires_at: null
      }
    ]),
    getStagingState: jest.fn(async () => ({
      id: 'current',
      status: 'LIVE',
      current_manifest_id: 'current-staging-manifest',
      last_validated_manifest_id: 'current-staging-manifest',
      frontend_sha: '1'.repeat(40),
      backend_sha: '2'.repeat(40),
      frontend_staging_ref_sha: '3'.repeat(40),
      backend_staging_ref_sha: '4'.repeat(40),
      clean_main: false,
      last_transition_train_id: 'current-staging-train',
      updated_at: 20,
      row_version: 5
    })),
    findManifest: jest.fn(async () => ({
      id: 'current-staging-manifest',
      train_id: 'current-staging-train',
      lane: 'STAGING',
      status: 'STAGING_VALIDATED',
      identity_sha256: '5'.repeat(64),
      frontend_sha: '1'.repeat(40),
      backend_sha: '2'.repeat(40),
      frontend_artifact_digest: '6'.repeat(64),
      backend_artifact_digest: '7'.repeat(64),
      e2e_run_id: '12345',
      manifest_json: {
        candidates: options?.duplicateManifestIdentity
          ? [manifestIdentity, manifestIdentity]
          : [manifestIdentity]
      },
      deployed_at: 19,
      validated_at: 20,
      created_at: 18,
      updated_at: 20
    })),
    findTrain: jest.fn(async () => train),
    listOperations: jest.fn(async () => [
      {
        id: 'current-staging-e2e',
        operation_type: 'E2E_STAGING',
        status: 'SUCCEEDED',
        external_id: '12345'
      }
    ]),
    listTrainCandidates: jest.fn(async () => [
      {
        candidate_id: current.id,
        disposition: 'INCLUDED'
      }
    ]),
    findCandidateByIdentity: jest.fn(
      async (_repository?: string, _prNumber?: number, _headSha?: string) =>
        current
    ),
    findCandidateById: jest.fn(async (_id?: string) => current),
    updateCandidate,
    appendEvent
  };
  return {
    current: () => current,
    repository,
    updateCandidate,
    appendEvent
  };
}

function productionIntent(
  item: ReleaseBusV2CandidateRecord,
  status:
    | 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION'
    | 'WAITING_FOR_PRODUCTION_REPLAN',
  selectionId: string,
  requestedAt: number
): ReleaseBusV2CandidateRecord {
  return {
    ...item,
    status,
    production_requested_at: requestedAt,
    production_requested_by: `operator-${selectionId}`,
    production_selection_id: selectionId,
    current_train_id: null,
    row_version: item.row_version + 1
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
    listCandidateEvents: jest.fn(
      async (..._args: unknown[]): Promise<unknown[]> => []
    ),
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
            fields.productionRequestedAt === undefined
              ? item.production_requested_at
              : fields.productionRequestedAt,
          production_requested_by:
            fields.productionRequestedBy === undefined
              ? item.production_requested_by
              : fields.productionRequestedBy,
          production_selection_id:
            fields.productionSelectionId === undefined
              ? item.production_selection_id
              : fields.productionSelectionId,
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

function groupedStagingRetryRepository() {
  const sourceTrainId = 'grouped-staging-failure';
  const failedOperationId = 'grouped-backend-preflight';
  const plan = { units: ['api'], edges: [] };
  const candidates = new Map<string, ReleaseBusV2CandidateRecord>();
  const events: Array<{
    id: string;
    train_id: string | null;
    candidate_id: string | null;
    event_type: string;
    github_actor: string | null;
    payload_json: unknown;
    created_at: number;
  }> = [];
  const identity = (
    id: string,
    prNumber: number,
    headCharacter: string
  ): ReleaseBusV2CandidateRecord => ({
    ...candidate('FAILED'),
    id,
    repository: 'backend',
    pr_number: prNumber,
    branch_name: `feature/${id}`,
    head_sha: headCharacter.repeat(40),
    deploy_plan_json: plan,
    pr_evidence_json: {
      base_sha: '1'.repeat(40),
      merge_sha: headCharacter.repeat(40),
      checks_run_id: `checks-${id}`,
      checks_completed_at: 10,
      artifact_run_id: null,
      artifact_name: null,
      artifact_digest: null,
      workflow_path: '.github/workflows/on-pull-request.yml',
      base_workflow_blob_sha: '4'.repeat(40),
      merge_workflow_blob_sha: '5'.repeat(40),
      base_gate_policy_digest: '6'.repeat(64),
      merge_gate_policy_digest: '7'.repeat(64),
      trust_mode: 'legacy-exact-workflow-v0',
      contributor_github_logins: ['developer']
    },
    staging_live_state: 'NOT_LIVE',
    current_train_id: null,
    hold_reason:
      "Combined backend preflight failed for this train's NEW candidate group",
    row_version: 2
  });
  const initial = [
    identity('candidate-a', 2001, 'a'),
    identity('candidate-b', 2002, 'b'),
    identity('candidate-c', 2003, 'c')
  ];
  for (const item of initial) {
    candidates.set(item.id, item);
    events.push({
      id: `grouped-failure-${item.id}`,
      train_id: sourceTrainId,
      candidate_id: item.id,
      event_type: 'STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED',
      github_actor: 'release-bus-v2',
      payload_json: {
        repository: item.repository,
        pr_number: item.pr_number,
        head_sha: item.head_sha,
        failed_candidate_row_version: item.row_version,
        failed_group_candidate_ids: initial.map(({ id }) => id),
        failed_operation_ids: [failedOperationId]
      },
      created_at: 20
    });
  }
  const memberships = initial.map((item, index) => ({
    id: `membership-${item.id}`,
    train_id: sourceTrainId,
    candidate_id: item.id,
    sequence: index + 1,
    disposition: 'REPOSITORY_PREFLIGHT_FAILED',
    candidate_role: 'NEW',
    created_at: 1
  }));
  const appendEvent = jest.fn(
    async (event: {
      trainId?: string;
      candidateId?: string;
      eventType: string;
      actor?: string;
      payload: unknown;
    }) => {
      events.push({
        id: `event-${events.length + 1}`,
        train_id: event.trainId ?? null,
        candidate_id: event.candidateId ?? null,
        event_type: event.eventType,
        github_actor: event.actor ?? null,
        payload_json: event.payload,
        created_at: 30 + events.length
      });
    }
  );
  const repository = {
    listControls: jest.fn(async () => []),
    executeNativeQueriesInTransaction: jest.fn(async (callback) =>
      callback({})
    ),
    supersedeOtherPrHeads: jest.fn(
      async (repositoryName: string, prNumber: number, headSha: string) => {
        const superseded: ReleaseBusV2CandidateRecord[] = [];
        for (const [id, item] of Array.from(candidates.entries())) {
          if (
            item.repository !== repositoryName ||
            item.pr_number !== prNumber ||
            item.head_sha === headSha ||
            item.status === 'SUPERSEDED'
          )
            continue;
          superseded.push(item);
          candidates.set(id, {
            ...item,
            status: 'SUPERSEDED',
            superseded_at: Date.now(),
            row_version: item.row_version + 1
          });
        }
        return superseded;
      }
    ),
    findCandidateByIdentity: jest.fn(
      async (repositoryName: string, prNumber: number, headSha: string) =>
        Array.from(candidates.values()).find(
          (item) =>
            item.repository === repositoryName &&
            item.pr_number === prNumber &&
            item.head_sha === headSha
        ) ?? null
    ),
    findCandidateById: jest.fn(
      async (id: string) => candidates.get(id) ?? null
    ),
    createCandidate: jest.fn(
      async (input: {
        repository: 'frontend' | 'backend';
        prNumber: number;
        branchName: string;
        headSha: string;
        requestedBy: string;
        deployPlan: ReleaseBusV2CandidateRecord['deploy_plan_json'];
        prEvidence: ReleaseBusV2CandidateRecord['pr_evidence_json'];
      }) => {
        const created: ReleaseBusV2CandidateRecord = {
          ...candidate('READY_FOR_STAGING'),
          id: `created-${input.prNumber}`,
          repository: input.repository,
          pr_number: input.prNumber,
          branch_name: input.branchName,
          head_sha: input.headSha,
          requested_by: input.requestedBy,
          deploy_plan_json: input.deployPlan,
          pr_evidence_json: input.prEvidence,
          staging_live_state: 'NOT_LIVE',
          row_version: 1
        };
        candidates.set(created.id, created);
        return created;
      }
    ),
    listDependencies: jest.fn(async () => []),
    addDependency: jest.fn(async () => undefined),
    listCandidates: jest.fn(async (statuses: readonly string[]) =>
      Array.from(candidates.values()).filter(({ status }) =>
        statuses.includes(status)
      )
    ),
    listCandidateEvents: jest.fn(
      async (candidateId: string, eventType: string) =>
        events
          .filter(
            (event) =>
              event.candidate_id === candidateId &&
              event.event_type === eventType
          )
          .reverse()
    ),
    findTrain: jest.fn(async (id: string) =>
      id === sourceTrainId
        ? {
            id,
            lane: 'STAGING',
            status: 'FAILED',
            failure_class: 'CANDIDATE',
            completed_at: 21
          }
        : null
    ),
    listTrainCandidates: jest.fn(async (id: string) =>
      id === sourceTrainId ? memberships : []
    ),
    listOperations: jest.fn(async (id: string) =>
      id === sourceTrainId
        ? [
            {
              id: failedOperationId,
              train_id: sourceTrainId,
              operation_type: 'PREPARE_ARTIFACT_BACKEND',
              repository: 'backend',
              status: 'FAILED',
              failure_class: 'CANDIDATE'
            }
          ]
        : []
    ),
    updateCandidate: jest.fn(
      async (
        id: string,
        rowVersion: number,
        fields: {
          status?: ReleaseBusV2CandidateRecord['status'];
          currentTrainId?: string | null;
          holdReason?: string | null;
        }
      ) => {
        const item = candidates.get(id);
        if (!item || item.row_version !== rowVersion) return false;
        candidates.set(id, {
          ...item,
          status: fields.status ?? item.status,
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
  return {
    candidates,
    events,
    initial,
    repository,
    sourceTrainId
  };
}

describe('Release Bus v2 explicit grouped staging preflight retry', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
  });

  it('requeues only explicitly registered unchanged A and B, preserves C failure, and supersedes C only when C2 is registered', async () => {
    const state = groupedStagingRetryRepository();
    const service = new ReleaseBusV2Service(state.repository as never);
    const qualify = (item: ReleaseBusV2CandidateRecord) => ({
      baseSha: '1'.repeat(40),
      mergeSha: item.head_sha,
      checksRunId: `checks-${item.id}`,
      checksCompletedAt: 10,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null,
      workflowPath: '.github/workflows/on-pull-request.yml',
      baseWorkflowBlobSha: '4'.repeat(40),
      mergeWorkflowBlobSha: '5'.repeat(40),
      baseGatePolicyDigest: '6'.repeat(64),
      mergeGatePolicyDigest: '7'.repeat(64),
      trustMode: 'legacy-exact-workflow-v0',
      contributorGithubLogins: ['developer']
    });
    mockResolveRef.mockImplementation(
      async (_repository: string, branch: string) =>
        Array.from(state.candidates.values()).find(
          ({ branch_name }) => branch_name === branch
        )?.head_sha ?? 'd'.repeat(40)
    );
    mockQualification.mockImplementation(
      async (_repository: string, prNumber: number, headSha: string) => {
        const item = Array.from(state.candidates.values()).find(
          (candidate) =>
            candidate.pr_number === prNumber && candidate.head_sha === headSha
        );
        return item
          ? qualify(item)
          : {
              baseSha: '1'.repeat(40),
              mergeSha: headSha,
              checksRunId: 'checks-c2',
              checksCompletedAt: 30,
              artifactRunId: null,
              artifactName: null,
              artifactDigest: null,
              workflowPath: '.github/workflows/on-pull-request.yml',
              baseWorkflowBlobSha: '4'.repeat(40),
              mergeWorkflowBlobSha: '5'.repeat(40),
              baseGatePolicyDigest: '6'.repeat(64),
              mergeGatePolicyDigest: '7'.repeat(64),
              trustMode: 'legacy-exact-workflow-v0',
              contributorGithubLogins: ['developer']
            };
      }
    );
    const register = (item: ReleaseBusV2CandidateRecord) =>
      service.register(
        {
          repository: item.repository,
          pr_number: item.pr_number,
          branch_name: item.branch_name,
          expected_head_sha: item.head_sha,
          deploy_plan: item.deploy_plan_json as {
            units: string[];
            edges: readonly (readonly [string, string])[];
          },
          dependencies: []
        },
        'developer'
      );

    expect(
      state.initial.map(({ id }) => state.candidates.get(id)?.status)
    ).toEqual(['FAILED', 'FAILED', 'FAILED']);
    await expect(register(state.initial[0])).resolves.toMatchObject({
      id: state.initial[0].id,
      status: 'READY_FOR_STAGING',
      row_version: 3
    });
    await expect(register(state.initial[1])).resolves.toMatchObject({
      id: state.initial[1].id,
      status: 'READY_FOR_STAGING',
      row_version: 3
    });
    expect(state.candidates.get(state.initial[2].id)?.status).toBe('FAILED');
    expect(
      state.events.filter(
        ({ event_type }) =>
          event_type === 'STAGING_REPOSITORY_PREFLIGHT_GROUP_EXPLICIT_RETRY'
      )
    ).toEqual([
      expect.objectContaining({
        candidate_id: state.initial[0].id,
        train_id: state.sourceTrainId,
        payload_json: expect.objectContaining({
          retry_id: expect.any(String),
          retry_attempt: 1,
          source_failure_event_id: `grouped-failure-${state.initial[0].id}`
        })
      }),
      expect.objectContaining({
        candidate_id: state.initial[1].id,
        train_id: state.sourceTrainId,
        payload_json: expect.objectContaining({
          retry_id: expect.any(String),
          retry_attempt: 1,
          source_failure_event_id: `grouped-failure-${state.initial[1].id}`
        })
      })
    ]);

    const c2 = {
      ...state.initial[2],
      id: 'candidate-c2',
      head_sha: 'd'.repeat(40)
    };
    mockResolveRef.mockImplementation(async (_repository: string, branch) =>
      branch === c2.branch_name ? c2.head_sha : '0'.repeat(40)
    );
    await expect(register(c2)).resolves.toMatchObject({
      id: `created-${c2.pr_number}`,
      head_sha: c2.head_sha,
      status: 'READY_FOR_STAGING'
    });
    expect(state.candidates.get(state.initial[2].id)).toMatchObject({
      status: 'SUPERSEDED',
      superseded_at: expect.any(Number)
    });
  });

  it('rejects ambiguous grouped failures, active ownership, and changed evidence', async () => {
    const state = groupedStagingRetryRepository();
    const target = state.initial[0];
    const service = new ReleaseBusV2Service(state.repository as never);
    mockResolveRef.mockResolvedValue(target.head_sha);
    mockQualification.mockResolvedValue({
      baseSha: '1'.repeat(40),
      mergeSha: target.head_sha,
      checksRunId: `checks-${target.id}`,
      checksCompletedAt: 10,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null,
      workflowPath: '.github/workflows/on-pull-request.yml',
      baseWorkflowBlobSha: '4'.repeat(40),
      mergeWorkflowBlobSha: '5'.repeat(40),
      baseGatePolicyDigest: '6'.repeat(64),
      mergeGatePolicyDigest: '7'.repeat(64),
      trustMode: 'legacy-exact-workflow-v0',
      contributorGithubLogins: ['developer']
    });
    const input = {
      repository: target.repository,
      pr_number: target.pr_number,
      branch_name: target.branch_name,
      expected_head_sha: target.head_sha,
      deploy_plan: target.deploy_plan_json as {
        units: string[];
        edges: readonly (readonly [string, string])[];
      },
      dependencies: []
    };

    const active = state.candidates.get(target.id)!;
    state.candidates.set(target.id, {
      ...active,
      current_train_id: state.sourceTrainId
    });
    await expect(service.register(input, 'developer')).rejects.toThrow(
      'not an unowned grouped'
    );
    state.candidates.set(target.id, active);
    state.events.push({
      ...state.events.find(({ candidate_id }) => candidate_id === target.id)!,
      id: 'ambiguous-duplicate-failure'
    });
    await expect(service.register(input, 'developer')).rejects.toThrow(
      'no unambiguous latest'
    );
    state.events.pop();
    mockQualification.mockResolvedValue({
      baseSha: '2'.repeat(40),
      mergeSha: target.head_sha,
      checksRunId: `checks-${target.id}`,
      checksCompletedAt: 10,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null,
      workflowPath: '.github/workflows/on-pull-request.yml',
      baseWorkflowBlobSha: '4'.repeat(40),
      mergeWorkflowBlobSha: '5'.repeat(40),
      baseGatePolicyDigest: '6'.repeat(64),
      mergeGatePolicyDigest: '7'.repeat(64),
      trustMode: 'legacy-exact-workflow-v0',
      contributorGithubLogins: ['developer']
    });
    await expect(service.register(input, 'developer')).rejects.toThrow(
      'different immutable registration data'
    );
    expect(state.candidates.get(target.id)?.status).toBe('FAILED');
    state.candidates.set(target.id, {
      ...state.candidates.get(target.id)!,
      status: 'SUPERSEDED',
      superseded_at: 40
    });
    mockQualification.mockResolvedValue({
      baseSha: '1'.repeat(40),
      mergeSha: target.head_sha,
      checksRunId: `checks-${target.id}`,
      checksCompletedAt: 10,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null,
      workflowPath: '.github/workflows/on-pull-request.yml',
      baseWorkflowBlobSha: '4'.repeat(40),
      mergeWorkflowBlobSha: '5'.repeat(40),
      baseGatePolicyDigest: '6'.repeat(64),
      mergeGatePolicyDigest: '7'.repeat(64),
      trustMode: 'legacy-exact-workflow-v0',
      contributorGithubLogins: ['developer']
    });
    await expect(service.register(input, 'developer')).rejects.toThrow(
      'superseded exact candidate head'
    );
  });
});

function productionOperation(
  operationType: string,
  status: ReleaseBusV2OperationRecord['status'],
  externalId: string | null,
  environment = 'prod'
): ReleaseBusV2OperationRecord {
  return {
    id: `operation-${operationType}`,
    idempotency_key: `operation-key-${operationType}`,
    train_id: 'production-replan-source',
    operation_type: operationType,
    repository: 'backend',
    service: operationType.startsWith('DEPLOY_') ? 'api' : null,
    environment,
    expected_sha: 'a'.repeat(40),
    artifact_digest: null,
    external_id: externalId,
    status,
    attempt: 1,
    max_attempts: 3,
    next_retry_at: null,
    failure_class: null,
    failure_message: null,
    request_json: null,
    result_json: null,
    started_at: status === 'PENDING' ? null : 1,
    completed_at: status === 'SUCCEEDED' ? 2 : null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

function safeReplanRepository(operation: ReleaseBusV2OperationRecord | null) {
  let train: ReleaseBusV2TrainRecord = {
    id: 'production-replan-source',
    lane: 'PRODUCTION',
    status: operation?.operation_type.startsWith('DEPLOY_')
      ? 'PRODUCTION_DEPLOYING'
      : 'MERGING_PRODUCTION',
    frontend_base_sha: '1'.repeat(40),
    backend_base_sha: '2'.repeat(40),
    frontend_composed_sha: '3'.repeat(40),
    backend_composed_sha: '4'.repeat(40),
    frontend_artifact_digest: null,
    backend_artifact_digest: '5'.repeat(64),
    manifest_id: null,
    parent_train_id: null,
    qualification_identity_sha256: null,
    qualification_train_id: null,
    qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1',
    qualification_evidence_json: null,
    failure_class: null,
    failure_message: null,
    recovery_message: null,
    phase_started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
  let intent: ReleaseBusV2CandidateRecord = {
    ...productionIntent(
      validatedCandidate('candidate-replan-source', 'backend', 'a', 301),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-replan-source',
      1
    ),
    status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
    current_train_id: train.id
  };
  const operations = operation ? [operation] : [];
  const appendEvent = jest.fn(async () => undefined);
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(
      async (callback: (connection: unknown) => Promise<unknown>) =>
        callback({})
    ),
    acquireLock: jest.fn(async () => ({ lease_token: 'scheduler-lease' })),
    releaseLock: jest.fn(async () => true),
    findTrain: jest.fn(async () => train),
    listOperations: jest.fn(async () => operations),
    updateOperation: jest.fn(async () => true),
    listTrainCandidates: jest.fn(async () => [
      {
        candidate_id: intent.id,
        disposition: 'INCLUDED',
        sequence: 1
      }
    ]),
    findCandidateById: jest.fn(async () => intent),
    updateCandidate: jest.fn(
      async (
        _id: string,
        rowVersion: number,
        fields: {
          status: ReleaseBusV2CandidateRecord['status'];
          currentTrainId?: string | null;
          holdReason?: string | null;
        }
      ) => {
        if (rowVersion !== intent.row_version) return false;
        intent = {
          ...intent,
          status: fields.status,
          current_train_id:
            fields.currentTrainId === undefined
              ? intent.current_train_id
              : fields.currentTrainId,
          hold_reason:
            fields.holdReason === undefined
              ? intent.hold_reason
              : fields.holdReason,
          row_version: intent.row_version + 1
        };
        return true;
      }
    ),
    updateTrain: jest.fn(
      async (
        _id: string,
        rowVersion: number,
        fields: {
          status: ReleaseBusV2TrainRecord['status'];
          failureClass?: ReleaseBusV2TrainRecord['failure_class'];
          failureMessage?: string | null;
          recoveryMessage?: string | null;
          completedAt?: number | null;
        }
      ) => {
        if (rowVersion !== train.row_version) return false;
        train = {
          ...train,
          status: fields.status,
          failure_class: fields.failureClass ?? train.failure_class,
          failure_message:
            fields.failureMessage === undefined
              ? train.failure_message
              : fields.failureMessage,
          recovery_message:
            fields.recoveryMessage === undefined
              ? train.recovery_message
              : fields.recoveryMessage,
          completed_at:
            fields.completedAt === undefined
              ? train.completed_at
              : fields.completedAt,
          row_version: train.row_version + 1
        };
        return true;
      }
    ),
    appendEvent,
    listLocks: jest.fn(async () => [])
  };
  return {
    repository,
    train: () => train,
    intent: () => intent,
    appendEvent
  };
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

  it('coalesces a later compatible explicit selection into a new pre-mutation replacement across repositories', async () => {
    const original = productionIntent(
      validatedCandidate('candidate-original', 'backend', 'a', 201),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-original',
      10
    );
    const later = productionIntent(
      validatedCandidate('candidate-later', 'frontend', 'b', 202),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-later',
      20
    );
    const state = selectionRepository([original, later]);
    state.repository.listCandidateEvents.mockImplementation(
      async (candidateId: unknown) =>
        candidateId === original.id
          ? ([
              {
                train_id: 'source-train-newest',
                event_type: 'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN'
              },
              {
                train_id: 'source-train-older',
                event_type: 'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN'
              }
            ] as never)
          : []
    );
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) => {
        if (ref === 'main')
          return repository === 'frontend' ? '8'.repeat(40) : '9'.repeat(40);
        return [original, later].find((item) => item.branch_name === ref)
          ?.head_sha;
      }
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) =>
        [original, later].find((item) => item.branch_name === ref)?.head_sha ??
        null
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    const claimed = await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );

    expect(claimed?.id).toBe('claimed-selection-train');
    expect(state.createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: expect.arrayContaining([original.id, later.id]),
        qualificationPolicy: 'CANDIDATE_STAGING_EVIDENCE_V1',
        qualificationEvidence: expect.arrayContaining([
          expect.objectContaining({ candidate_id: original.id }),
          expect.objectContaining({ candidate_id: later.id })
        ])
      }),
      expect.anything()
    );
    const replacementSelectionId = state.candidates.get(
      original.id
    )?.production_selection_id;
    expect(replacementSelectionId).toEqual(expect.any(String));
    expect(replacementSelectionId).not.toBe('selection-original');
    expect(replacementSelectionId).not.toBe('selection-later');
    expect(state.candidates.get(later.id)?.production_selection_id).toBe(
      replacementSelectionId
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_REPLAN_REPLACEMENT_CLAIMED',
        payload: expect.objectContaining({
          replacement_production_selection_id: replacementSelectionId,
          source_production_selection_ids: [
            'selection-later',
            'selection-original'
          ],
          source_train_ids: ['source-train-newest'],
          included_intents: expect.arrayContaining([
            expect.objectContaining({
              candidate_id: original.id,
              source_production_selection_id: 'selection-original',
              source_train_id: 'source-train-newest'
            }),
            expect.objectContaining({
              candidate_id: later.id,
              source_production_selection_id: 'selection-later',
              source_train_id: null
            })
          ]),
          omitted_intents: []
        })
      }),
      expect.anything()
    );
  });

  it('rolls a transient production-base lookup failure back for a clean next-tick retry', async () => {
    const intent = productionIntent(
      validatedCandidate('candidate-infrastructure-retry', 'backend', 'b', 213),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-infrastructure-retry',
      10
    );
    const state = selectionRepository([intent]);
    const infrastructureError = new Error('GitHub request timed out');
    infrastructureError.name = 'ReleaseBusGitHubInfrastructureError';
    mockResolveRef.mockRejectedValue(infrastructureError);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.claimLane(
        'PRODUCTION',
        '8'.repeat(40),
        '9'.repeat(40),
        'scheduler-timeout'
      )
    ).rejects.toBe(infrastructureError);
    expect(state.createTrain).not.toHaveBeenCalled();
    expect(state.candidates.get(intent.id)).toEqual(intent);

    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '8'.repeat(40)
            : '9'.repeat(40)
          : intent.head_sha
    );
    mockResolveRefIfExists.mockResolvedValue(intent.head_sha);

    await expect(
      service.claimLane(
        'PRODUCTION',
        '8'.repeat(40),
        '9'.repeat(40),
        'scheduler-retry'
      )
    ).resolves.toEqual(
      expect.objectContaining({ id: 'claimed-selection-train' })
    );
  });

  it('fails the complete replacement closed when either current production base moved', async () => {
    const original = productionIntent(
      validatedCandidate('candidate-stale-base-original', 'backend', '6', 209),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-stale-base-original',
      10
    );
    const later = productionIntent(
      validatedCandidate('candidate-stale-base-later', 'frontend', '7', 210),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-stale-base-later',
      20
    );
    const state = selectionRepository([original, later]);
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '7'.repeat(40)
            : '9'.repeat(40)
          : [original, later].find((item) => item.branch_name === ref)?.head_sha
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    const claimed = await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );

    expect(claimed).toBeNull();
    expect(state.createTrain).not.toHaveBeenCalled();
    for (const candidate of [original, later])
      expect(state.candidates.get(candidate.id)).toEqual(
        expect.objectContaining({
          status: 'WAITING_FOR_PRODUCTION_REPLAN',
          production_selection_id: candidate.production_selection_id,
          hold_reason: expect.stringContaining(
            'Production base fence changed for frontend'
          )
        })
      );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_REPLAN_REPLACEMENT_NOT_CLAIMED',
        payload: expect.objectContaining({
          source_production_selection_ids: [
            'selection-stale-base-later',
            'selection-stale-base-original'
          ],
          source_train_ids: [],
          omitted_intents: expect.arrayContaining([
            expect.objectContaining({
              candidate_id: original.id,
              source_production_selection_id: original.production_selection_id,
              reason: expect.stringContaining(
                'Production base fence changed for frontend'
              )
            }),
            expect.objectContaining({
              candidate_id: later.id,
              source_production_selection_id: later.production_selection_id,
              reason: expect.stringContaining(
                'Production base fence changed for frontend'
              )
            })
          ])
        })
      }),
      expect.anything()
    );
  });

  it('fails a truncated replan-intent scan closed and audits pre-filter counts', async () => {
    const held = productionIntent(
      validatedCandidate('candidate-scan-cap-held', 'backend', 'c', 216),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-scan-cap-held',
      1
    );
    const ready = Array.from({ length: 500 }, (_, index) =>
      productionIntent(
        validatedCandidate(
          `candidate-scan-cap-ready-${index}`,
          index % 2 === 0 ? 'backend' : 'frontend',
          index % 2 === 0 ? 'd' : 'e',
          10_000 + index
        ),
        'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        `selection-scan-cap-${index}`,
        2 + index
      )
    );
    const state = selectionRepository([held, ...ready]);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.claimLane(
        'PRODUCTION',
        '8'.repeat(40),
        '9'.repeat(40),
        'scheduler-scan-cap'
      )
    ).resolves.toBeNull();

    expect(state.createTrain).not.toHaveBeenCalled();
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_REPLAN_INTENT_SCAN_FAILED_CLOSED',
        payload: expect.objectContaining({
          ready_count: 500,
          held_count: 1,
          eligible_ready_count: 500,
          eligible_held_count: 1
        })
      }),
      expect.anything()
    );
    expect(state.candidates.get(held.id)).toEqual(held);
  });

  it('keeps replacement intent explicit and dependency-closed when a prerequisite becomes ineligible', async () => {
    const seed = productionIntent(
      validatedCandidate('candidate-seed', 'backend', 'c', 203),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-seed',
      10
    );
    const prerequisite = productionIntent(
      validatedCandidate('candidate-prerequisite', 'backend', 'd', 204),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-dependent-set',
      20
    );
    const dependent = productionIntent(
      validatedCandidate('candidate-dependent', 'frontend', 'e', 205),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-dependent-set',
      20
    );
    const state = selectionRepository(
      [seed, prerequisite, dependent],
      [
        {
          candidate_id: dependent.id,
          prerequisite_candidate_id: prerequisite.id,
          environment: 'PRODUCTION'
        }
      ]
    );
    state.candidates.set(prerequisite.id, {
      ...prerequisite,
      staging_validated_manifest_id: null
    });
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '8'.repeat(40)
            : '9'.repeat(40)
          : [seed, prerequisite, dependent].find(
              (item) => item.branch_name === ref
            )?.head_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) =>
        [seed, prerequisite, dependent].find((item) => item.branch_name === ref)
          ?.head_sha ?? null
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );

    expect(state.createTrain).toHaveBeenCalledWith(
      expect.objectContaining({ candidateIds: [seed.id] }),
      expect.anything()
    );
    expect(state.candidates.get(prerequisite.id)).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        production_selection_id: 'selection-dependent-set',
        hold_reason: expect.stringContaining(
          'no current staging validation evidence'
        )
      })
    );
    expect(state.candidates.get(dependent.id)).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        production_selection_id: 'selection-dependent-set',
        hold_reason: expect.stringContaining(
          `dependency ${prerequisite.id} is neither eligible`
        )
      })
    );
    expect(state.candidates.get(dependent.id)?.hold_reason).toContain(
      `prerequisite omission: Candidate ${prerequisite.id} has no current staging validation evidence`
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_REPLAN_REPLACEMENT_CLAIMED',
        payload: expect.objectContaining({
          source_production_selection_ids: ['selection-seed'],
          omitted_intents: expect.arrayContaining([
            expect.objectContaining({
              candidate_id: prerequisite.id,
              source_production_selection_id: 'selection-dependent-set',
              reason: expect.stringContaining(
                'no current staging validation evidence'
              )
            }),
            expect.objectContaining({
              candidate_id: dependent.id,
              source_production_selection_id: 'selection-dependent-set',
              reason: expect.stringContaining(
                `dependency ${prerequisite.id} is neither eligible`
              )
            })
          ])
        })
      }),
      expect.anything()
    );
  });

  it('excludes a concurrently revoked or moved intent without losing its audit reason', async () => {
    const seed = productionIntent(
      validatedCandidate('candidate-replan-seed', 'backend', 'f', 206),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-seed',
      10
    );
    const revokedSnapshot = productionIntent(
      validatedCandidate('candidate-revoked', 'frontend', '1', 207),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-revoked',
      20
    );
    const moved = productionIntent(
      validatedCandidate('candidate-moved', 'backend', '2', 208),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-moved',
      30
    );
    const state = selectionRepository([seed, revokedSnapshot, moved]);
    const originalListCandidates =
      state.repository.listCandidates.getMockImplementation()!;
    let revokedDuringReadyScan = false;
    state.repository.listCandidates.mockImplementation(
      async (statuses: readonly string[]) => {
        const result = await originalListCandidates(statuses);
        if (
          !revokedDuringReadyScan &&
          statuses.includes('READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION')
        ) {
          revokedDuringReadyScan = true;
          state.candidates.set(revokedSnapshot.id, {
            ...revokedSnapshot,
            status: 'STAGING_VALIDATED',
            production_requested_at: null,
            production_requested_by: null,
            production_selection_id: null,
            row_version: revokedSnapshot.row_version + 1
          });
        }
        return result;
      }
    );
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '8'.repeat(40)
            : '9'.repeat(40)
          : [seed, revokedSnapshot, moved].find(
              (item) => item.branch_name === ref
            )?.head_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) => {
        if (ref === moved.branch_name) return '3'.repeat(40);
        return [seed, revokedSnapshot].find((item) => item.branch_name === ref)
          ?.head_sha;
      }
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );

    expect(state.createTrain).toHaveBeenCalledWith(
      expect.objectContaining({ candidateIds: [seed.id] }),
      expect.anything()
    );
    expect(state.candidates.get(revokedSnapshot.id)).toEqual(
      expect.objectContaining({
        status: 'STAGING_VALIDATED',
        production_requested_at: null,
        production_selection_id: null
      })
    );
    expect(state.candidates.get(moved.id)).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        production_selection_id: 'selection-moved',
        hold_reason: expect.stringContaining('branch head changed')
      })
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: revokedSnapshot.id,
        eventType: 'PRODUCTION_REPLAN_INTENT_OMITTED',
        payload: expect.objectContaining({
          reason:
            'Candidate status STAGING_VALIDATED no longer carries claimable production intent'
        })
      }),
      expect.anything()
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: moved.id,
        eventType: 'PRODUCTION_REPLAN_INTENT_OMITTED',
        payload: expect.objectContaining({
          reason: expect.stringContaining('branch head changed')
        })
      }),
      expect.anything()
    );
  });

  it('re-locks an omitted intent before preserving it after a concurrent row-version change', async () => {
    const seed = productionIntent(
      validatedCandidate('candidate-row-race-seed', 'backend', '4', 211),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-row-race-seed',
      10
    );
    const raced = productionIntent(
      validatedCandidate('candidate-row-race-omitted', 'frontend', '5', 212),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-row-race-omitted',
      20
    );
    const state = selectionRepository([seed, raced]);
    state.candidates.set(raced.id, {
      ...raced,
      staging_validated_manifest_id: null
    });
    const originalFindCandidateById =
      state.repository.findCandidateById.getMockImplementation()!;
    let qualificationReadComplete = false;
    let rowVersionBumped = false;
    state.repository.findCandidateById.mockImplementation(
      async (id: string) => {
        const current = await originalFindCandidateById(id);
        if (
          id === raced.id &&
          qualificationReadComplete &&
          !rowVersionBumped &&
          current
        ) {
          rowVersionBumped = true;
          const bumped = {
            ...current,
            row_version: current.row_version + 1
          };
          state.candidates.set(id, bumped);
          return bumped;
        }
        return current;
      }
    );
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '8'.repeat(40)
            : '9'.repeat(40)
          : [seed, raced].find((item) => item.branch_name === ref)?.head_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) => {
        const selected = [seed, raced].find((item) => item.branch_name === ref);
        if (selected?.id === raced.id) qualificationReadComplete = true;
        return selected?.head_sha ?? null;
      }
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.claimLane(
        'PRODUCTION',
        '8'.repeat(40),
        '9'.repeat(40),
        'scheduler'
      )
    ).resolves.toEqual(
      expect.objectContaining({ id: 'claimed-selection-train' })
    );

    expect(rowVersionBumped).toBe(true);
    expect(state.candidates.get(raced.id)).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        production_selection_id: 'selection-row-race-omitted',
        hold_reason: expect.stringContaining(
          'no current staging validation evidence'
        ),
        row_version: raced.row_version + 2
      })
    );
  });

  it('audits the current locked ownership reason when an omitted intent changes after qualification', async () => {
    const seed = productionIntent(
      validatedCandidate('candidate-owned-race-seed', 'backend', '6', 214),
      'WAITING_FOR_PRODUCTION_REPLAN',
      'selection-owned-race-seed',
      10
    );
    const raced = productionIntent(
      validatedCandidate('candidate-owned-race-omitted', 'frontend', '7', 215),
      'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      'selection-owned-race-omitted',
      20
    );
    const state = selectionRepository([seed, raced]);
    state.candidates.set(raced.id, {
      ...raced,
      staging_validated_manifest_id: null
    });
    const originalFindCandidateById =
      state.repository.findCandidateById.getMockImplementation()!;
    let qualificationReadComplete = false;
    let ownershipInjected = false;
    state.repository.findCandidateById.mockImplementation(
      async (id: string) => {
        const current = await originalFindCandidateById(id);
        if (
          id === raced.id &&
          qualificationReadComplete &&
          !ownershipInjected &&
          current
        ) {
          ownershipInjected = true;
          const owned = {
            ...current,
            status: 'PRODUCTION_IN_TRAIN' as const,
            current_train_id: 'concurrent-production-train',
            row_version: current.row_version + 1
          };
          state.candidates.set(id, owned);
          return owned;
        }
        return current;
      }
    );
    mockResolveRef.mockImplementation(
      async (repository: string, ref: string) =>
        ref === 'main'
          ? repository === 'frontend'
            ? '8'.repeat(40)
            : '9'.repeat(40)
          : [seed, raced].find((item) => item.branch_name === ref)?.head_sha
    );
    mockResolveRefIfExists.mockImplementation(
      async (_repository: string, ref: string) => {
        const selected = [seed, raced].find((item) => item.branch_name === ref);
        if (selected?.id === raced.id) qualificationReadComplete = true;
        return selected?.head_sha ?? null;
      }
    );
    const service = new ReleaseBusV2Service(state.repository as never);

    await service.claimLane(
      'PRODUCTION',
      '8'.repeat(40),
      '9'.repeat(40),
      'scheduler'
    );

    expect(ownershipInjected).toBe(true);
    expect(state.candidates.get(raced.id)).toEqual(
      expect.objectContaining({
        status: 'PRODUCTION_IN_TRAIN',
        current_train_id: 'concurrent-production-train'
      })
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: raced.id,
        eventType: 'PRODUCTION_REPLAN_INTENT_OMITTED',
        payload: expect.objectContaining({
          reason: 'Candidate is owned by train concurrent-production-train',
          qualification_reason: expect.stringContaining(
            'no current staging validation evidence'
          )
        })
      }),
      expect.anything()
    );
  });

  it('preserves exact source selection provenance when a train is safely replanned before mutation', async () => {
    const state = safeReplanRepository(null);
    const service = new ReleaseBusV2Service(state.repository as never);

    const result = await service.preserveProductionIntentsForSafeReplan({
      trainId: 'production-replan-source',
      reason: 'frontend main moved',
      actor: 'reconciler'
    });

    expect(result).toEqual({
      status: 'REPLANNED',
      trainId: 'production-replan-source',
      candidateIds: ['candidate-replan-source'],
      sourceSelectionIds: ['selection-replan-source']
    });
    expect(state.train()).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        completed_at: expect.any(Number)
      })
    );
    expect(state.intent()).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        current_train_id: null,
        production_selection_id: 'selection-replan-source'
      })
    );
    expect(state.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRODUCTION_TRAIN_INTENTS_PRESERVED_FOR_SAFE_REPLAN',
        payload: expect.objectContaining({
          source_production_selection_ids: ['selection-replan-source'],
          candidate_ids: ['candidate-replan-source']
        })
      }),
      expect.anything()
    );
  });

  it('holds the safe-replan scheduler lease through transaction commit with the same external fence semantics as selection', async () => {
    const state = safeReplanRepository(null);
    const order: string[] = [];
    state.repository.acquireLock.mockImplementation(async () => {
      order.push('scheduler-acquired');
      return { lease_token: 'scheduler-lease' } as never;
    });
    state.repository.executeNativeQueriesInTransaction.mockImplementation(
      async (callback: (connection: unknown) => Promise<unknown>) => {
        order.push('transaction-started');
        const result = await callback({});
        order.push('transaction-committed');
        return result;
      }
    );
    state.repository.releaseLock.mockImplementation(async () => {
      order.push('scheduler-released');
      return true;
    });

    await new ReleaseBusV2Service(
      state.repository as never
    ).preserveProductionIntentsForSafeReplan({
      trainId: 'production-replan-source',
      reason: 'frontend main moved',
      actor: 'reconciler'
    });

    expect(order).toEqual([
      'scheduler-acquired',
      'transaction-started',
      'transaction-committed',
      'scheduler-released'
    ]);
    expect(state.repository.acquireLock).toHaveBeenCalledWith(
      'scheduler',
      null,
      'production-replan:production-replan-source',
      expect.any(Number),
      {}
    );
    expect(state.repository.releaseLock).toHaveBeenCalledWith(
      'scheduler',
      'scheduler-lease',
      {}
    );
  });

  it('defers the service-level replan while dispatched composition may still be running', async () => {
    const state = safeReplanRepository(
      productionOperation(
        'COMPOSE_BACKEND',
        'RUNNING',
        'compose-run',
        'orchestration'
      )
    );
    state.repository.listLocks.mockResolvedValue([
      {
        name: 'production-environment',
        owner_train_id: 'production-replan-source',
        lease_token: 'production-lease'
      }
    ] as never);
    const beforeTrain = state.train();
    const beforeIntent = state.intent();
    const service = new ReleaseBusV2Service(state.repository as never);

    const result = await service.preserveProductionIntentsForSafeReplan({
      trainId: 'production-replan-source',
      reason: 'frontend main moved',
      actor: 'reconciler'
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'NOOP',
        reason: expect.stringContaining(
          'operation operation-COMPOSE_BACKEND (COMPOSE_BACKEND)'
        )
      })
    );
    expect(state.train()).toEqual(beforeTrain);
    expect(state.intent()).toEqual(beforeIntent);
    expect(state.repository.updateOperation).not.toHaveBeenCalled();
    expect(state.appendEvent).not.toHaveBeenCalled();
    expect(state.repository.releaseLock).not.toHaveBeenCalledWith(
      'production-environment',
      'production-lease',
      expect.anything()
    );
  });

  it.each([
    [
      productionOperation('ADVANCE_MAIN_BACKEND', 'SUCCEEDED', 'a'.repeat(40)),
      'ADVANCE_MAIN_BACKEND succeeded'
    ],
    [
      productionOperation(
        'DEPLOY_BACKEND_PROD_api',
        'DISPATCHED',
        'deploy-run'
      ),
      'DEPLOY_BACKEND_PROD_api was dispatched'
    ],
    [
      productionOperation(
        'DEPLOY_BACKEND_PROD_api',
        'RETRY_WAIT',
        'deploy-run'
      ),
      'DEPLOY_BACKEND_PROD_api was dispatched'
    ],
    [
      productionOperation('E2E_PROD', 'PENDING', null),
      'production E2E was created'
    ]
  ])(
    'recognizes irreversible production work and never makes it replan-eligible',
    (operation, expectedReason) => {
      expect(irreversibleProductionOperationReason(operation)).toBe(
        expectedReason
      );
    }
  );

  it.each([
    [
      productionOperation('ADVANCE_MAIN_BACKEND', 'SUCCEEDED', 'a'.repeat(40)),
      'ADVANCE_MAIN_BACKEND succeeded',
      true
    ],
    [
      productionOperation(
        'DEPLOY_BACKEND_PROD_api',
        'DISPATCHED',
        'deploy-run'
      ),
      'the train entered PRODUCTION_DEPLOYING',
      false
    ],
    [
      productionOperation(
        'DEPLOY_BACKEND_PROD_api',
        'RETRY_WAIT',
        'deploy-run'
      ),
      'the train entered PRODUCTION_DEPLOYING',
      false
    ],
    [
      productionOperation('E2E_PROD', 'PENDING', null),
      'production E2E was created',
      true
    ]
  ])(
    'freezes the original exact train after irreversible work instead of broadening it',
    async (operation, expectedReason, releasesTerminalLock) => {
      const state = safeReplanRepository(operation);
      state.repository.listLocks.mockResolvedValue([
        {
          name: 'production-environment',
          owner_train_id: 'production-replan-source',
          lease_token: 'production-lease'
        }
      ] as never);
      const before = state.intent();
      const service = new ReleaseBusV2Service(state.repository as never);

      const result = await service.preserveProductionIntentsForSafeReplan({
        trainId: 'production-replan-source',
        reason: 'frontend main moved',
        actor: 'reconciler'
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: 'FROZEN',
          reason: expect.stringContaining(expectedReason)
        })
      );
      expect(state.train()).toEqual(
        expect.objectContaining({
          status: 'PAUSED',
          recovery_message: expect.stringContaining(
            "Resume or recover only this train's immutable membership"
          )
        })
      );
      expect(state.intent()).toEqual(before);
      expect(state.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'PRODUCTION_REPLAN_REJECTED_AFTER_IRREVERSIBLE_MUTATION',
          payload: expect.objectContaining({
            production_environment_lock: releasesTerminalLock
              ? 'RELEASED_OR_ALREADY_FREE_AFTER_TERMINAL_WORK'
              : 'RETAINED_WHILE_DISPATCHED_WORK_DRAINS'
          })
        }),
        expect.anything()
      );
      if (releasesTerminalLock)
        expect(state.repository.releaseLock).toHaveBeenCalledWith(
          'production-environment',
          'production-lease',
          expect.anything()
        );
      else
        expect(state.repository.releaseLock).not.toHaveBeenCalledWith(
          'production-environment',
          'production-lease',
          expect.anything()
        );
    }
  );

  it('fails a concurrent explicit selection closed while the scheduler transaction owns the race', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    state.repository.acquireLock.mockImplementation(async () => null as never);
    mockResolveRef.mockResolvedValue('a'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow(
      'Production selection raced another scheduler transaction'
    );
    expect(state.current().production_requested_at).toBeNull();
    expect(state.repository.updateCandidate).not.toHaveBeenCalled();
  });

  it('holds the scheduler lease until the authoritative selection transaction commits', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    const order: string[] = [];
    state.repository.acquireLock.mockImplementation(async () => {
      order.push('scheduler-acquired');
      return { lease_token: 'scheduler-lease' } as never;
    });
    state.repository.executeNativeQueriesInTransaction.mockImplementation(
      async (callback: (connection: unknown) => Promise<unknown>) => {
        order.push('transaction-started');
        const result = await callback({});
        order.push('transaction-committed');
        return result;
      }
    );
    state.repository.releaseLock.mockImplementation(async () => {
      order.push('scheduler-released');
      return true;
    });
    mockResolveRef.mockResolvedValue('a'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);

    await service.markReadyForProduction(
      'candidate-id',
      'a'.repeat(40),
      3,
      'owner'
    );

    expect(order).toEqual([
      'scheduler-acquired',
      'transaction-started',
      'transaction-committed',
      'scheduler-released'
    ]);
    expect(state.repository.acquireLock).toHaveBeenCalledWith(
      'scheduler',
      null,
      expect.stringMatching(/^production-selection:/),
      expect.any(Number),
      {}
    );
    expect(state.repository.releaseLock).toHaveBeenCalledWith(
      'scheduler',
      'scheduler-lease',
      {}
    );
  });

  it('releases the scheduler lease only after an authoritative selection rollback', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    const order: string[] = [];
    state.repository.acquireLock.mockImplementation(async () => {
      order.push('scheduler-acquired');
      return { lease_token: 'scheduler-lease' } as never;
    });
    state.repository.executeNativeQueriesInTransaction.mockImplementation(
      async (callback: (connection: unknown) => Promise<unknown>) => {
        order.push('transaction-started');
        try {
          return await callback({});
        } catch (error) {
          order.push('transaction-rolled-back');
          throw error;
        }
      }
    );
    state.repository.updateCandidate.mockImplementation(async () => false);
    state.repository.releaseLock.mockImplementation(async () => {
      order.push('scheduler-released');
      return true;
    });
    mockResolveRef.mockResolvedValue('a'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('Candidate changed concurrently');

    expect(order).toEqual([
      'scheduler-acquired',
      'transaction-started',
      'transaction-rolled-back',
      'scheduler-released'
    ]);
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

describe('Release Bus v2 authoritative current staging repair', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const identity = {
    repository: 'frontend' as const,
    pr_number: 42,
    head_sha: 'a'.repeat(40)
  };

  beforeEach(() => {
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    mockEnsureCommitStatus.mockReset();
    mockEnsureCommitStatus.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    mockEnsureCommitStatus.mockReset();
    mockEnsureCommitStatus.mockResolvedValue(undefined);
  });

  it('derives exact current-manifest status once and is idempotent', async () => {
    const state = currentStagingRepairRepository();
    const service = new ReleaseBusV2Service(state.repository as never);

    const first = await service.repairCurrentStagingManifestCandidates(
      [identity],
      'operator'
    );
    const second = await service.repairCurrentStagingManifestCandidates(
      [identity],
      'operator'
    );

    expect(first).toMatchObject({
      manifest_id: 'current-staging-manifest',
      train_id: 'current-staging-train',
      dry_run: false,
      discovered: false,
      candidates: [
        {
          candidate_id: 'candidate-id',
          repository: 'frontend',
          pr_number: 42,
          head_sha: 'a'.repeat(40),
          previous_status: 'SUPERSEDED',
          derived_status: 'STAGING_VALIDATED',
          derived_staging_live_state: 'LIVE',
          would_change: true,
          changed: true
        }
      ]
    });
    expect(second.candidates[0]?.changed).toBe(false);
    expect(state.updateCandidate).toHaveBeenCalledTimes(1);
    expect(first.github_status_updates).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      newly_derived: 1,
      reasserted: 0,
      failed_candidates: []
    });
    expect(second.github_status_updates).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      newly_derived: 0,
      reasserted: 1,
      failed_candidates: []
    });
    expect(
      state.appendEvent.mock.calls.filter(
        ([event]) =>
          event.eventType ===
          'CURRENT_STAGING_MANIFEST_CANDIDATE_STATUS_DERIVED'
      )
    ).toHaveLength(1);
  });

  it('discovers a FAILED exact current-manifest mismatch in a mutation-free dry-run', async () => {
    const state = currentStagingRepairRepository({
      initialStatus: 'FAILED',
      historicalValidationPointers: true
    });
    const service = new ReleaseBusV2Service(state.repository as never);

    const result = await service.repairCurrentStagingManifestCandidates(
      null,
      'operator',
      true
    );

    expect(result).toMatchObject({
      manifest_id: 'current-staging-manifest',
      train_id: 'current-staging-train',
      dry_run: true,
      discovered: true,
      candidates: [
        {
          candidate_id: 'candidate-id',
          repository: 'frontend',
          pr_number: 42,
          head_sha: 'a'.repeat(40),
          previous_status: 'FAILED',
          would_change: true,
          changed: false
        }
      ]
    });
    expect(state.updateCandidate).not.toHaveBeenCalled();
    expect(state.appendEvent).not.toHaveBeenCalled();
    expect(state.repository.acquireLock).not.toHaveBeenCalled();
    expect(state.repository.releaseLock).not.toHaveBeenCalled();

    await service.repairCurrentStagingManifestCandidates(
      result.candidates.map(({ repository, pr_number, head_sha }) => ({
        repository,
        pr_number,
        head_sha
      })),
      'operator'
    );
    expect(state.current()).toMatchObject({
      status: 'STAGING_VALIDATED',
      staging_validated_train_id: 'current-staging-train',
      staging_validated_manifest_id: 'current-staging-manifest',
      staging_live_state: 'LIVE',
      staging_live_manifest_id: 'current-staging-manifest'
    });
  });

  it('never discovers or restores a correctly superseded older head that is absent from the current manifest', async () => {
    const state = currentStagingRepairRepository({ initialStatus: 'FAILED' });
    const service = new ReleaseBusV2Service(state.repository as never);
    const oldHead = 'b'.repeat(40);
    const oldCandidate = {
      ...state.current(),
      id: 'historical-superseded-candidate',
      head_sha: oldHead,
      status: 'SUPERSEDED' as const,
      staging_live_state: 'NOT_LIVE' as const,
      staging_live_manifest_id: null,
      superseded_at: 30
    };
    const currentFindByIdentity =
      state.repository.findCandidateByIdentity.getMockImplementation()!;
    const currentFindById =
      state.repository.findCandidateById.getMockImplementation()!;
    state.repository.findCandidateByIdentity.mockImplementation(
      async (repository?: string, prNumber?: number, headSha?: string) =>
        headSha === oldHead
          ? oldCandidate
          : currentFindByIdentity(repository, prNumber, headSha)
    );
    state.repository.findCandidateById.mockImplementation(
      async (id?: string) =>
        id === oldCandidate.id ? oldCandidate : currentFindById(id)
    );

    const dryRun = await service.repairCurrentStagingManifestCandidates(
      null,
      'operator',
      true
    );
    await service.repairCurrentStagingManifestCandidates(
      dryRun.candidates.map(({ repository, pr_number, head_sha }) => ({
        repository,
        pr_number,
        head_sha
      })),
      'operator'
    );

    expect(dryRun.candidates).toEqual([
      expect.objectContaining({
        candidate_id: 'candidate-id',
        head_sha: identity.head_sha
      })
    ]);
    expect(state.repository.findCandidateByIdentity).not.toHaveBeenCalledWith(
      oldCandidate.repository,
      oldCandidate.pr_number,
      oldHead,
      expect.anything()
    );
    expect(state.updateCandidate).not.toHaveBeenCalledWith(
      oldCandidate.id,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(oldCandidate).toMatchObject({
      status: 'SUPERSEDED',
      staging_live_state: 'NOT_LIVE',
      superseded_at: 30
    });
  });

  it('rejects ambiguous manifest membership without mutating a candidate', async () => {
    const state = currentStagingRepairRepository({
      duplicateManifestIdentity: true
    });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.repairCurrentStagingManifestCandidates([identity], 'operator')
    ).rejects.toThrow('candidate identities are ambiguous');

    expect(state.updateCandidate).not.toHaveBeenCalled();
    expect(state.current().status).toBe('SUPERSEDED');
  });

  it('rejects repair while any release train remains active', async () => {
    const state = currentStagingRepairRepository({ activeTrain: true });
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.repairCurrentStagingManifestCandidates([identity], 'operator')
    ).rejects.toThrow('requires every release train to be terminal');

    expect(state.updateCandidate).not.toHaveBeenCalled();
  });

  it('acquires and releases all execution fences in a fixed order', async () => {
    const state = currentStagingRepairRepository();
    const service = new ReleaseBusV2Service(state.repository as never);

    await service.repairCurrentStagingManifestCandidates(
      [identity],
      'operator'
    );

    expect(
      state.repository.acquireLock.mock.calls.map(([name]) => name)
    ).toEqual(['scheduler', 'staging-environment', 'production-environment']);
    expect(
      state.repository.releaseLock.mock.calls.map(([name]) => name)
    ).toEqual(['production-environment', 'staging-environment', 'scheduler']);
  });

  it('allows OFF-mode discovery but rejects OFF-mode execution', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const state = currentStagingRepairRepository();
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.repairCurrentStagingManifestCandidates(null, 'operator', true)
    ).resolves.toMatchObject({
      dry_run: true,
      github_status_updates: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        newly_derived: 0,
        reasserted: 0
      }
    });
    await expect(
      service.repairCurrentStagingManifestCandidates([identity], 'operator')
    ).rejects.toMatchObject({
      name: 'ReleaseBusV2CurrentStagingRepairError',
      code: 'DISABLED'
    });
    expect(state.updateCandidate).not.toHaveBeenCalled();
  });

  it('reports exact GitHub status publication failures after durable repair', async () => {
    const state = currentStagingRepairRepository();
    const service = new ReleaseBusV2Service(state.repository as never);
    mockEnsureCommitStatus.mockRejectedValue(new Error('GitHub unavailable'));

    const result = await service.repairCurrentStagingManifestCandidates(
      [identity],
      'operator'
    );

    expect(state.current()).toMatchObject({
      status: 'STAGING_VALIDATED',
      staging_live_state: 'LIVE'
    });
    expect(result.github_status_updates).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      newly_derived: 1,
      reasserted: 0,
      failed_candidates: [
        {
          candidate_id: 'candidate-id',
          repository: 'frontend',
          pr_number: 42,
          head_sha: 'a'.repeat(40)
        }
      ]
    });
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
      workflowPath: '.github/workflows/on-pull-request.yml',
      baseWorkflowBlobSha: 'e'.repeat(40),
      mergeWorkflowBlobSha: 'f'.repeat(40),
      baseGatePolicyDigest: '8'.repeat(64),
      mergeGatePolicyDigest: '9'.repeat(64),
      trustMode: 'evidence-manifest-v1',
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
          workflow_path: '.github/workflows/on-pull-request.yml',
          base_workflow_blob_sha: 'e'.repeat(40),
          merge_workflow_blob_sha: 'f'.repeat(40),
          base_gate_policy_digest: '8'.repeat(64),
          merge_gate_policy_digest: '9'.repeat(64),
          trust_mode: 'evidence-manifest-v1',
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
