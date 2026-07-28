const mockResolveRef = jest.fn();
const mockQualification = jest.fn();
const mockEnsureCommitStatus = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    getPullRequestQualification: (...args: unknown[]) =>
      mockQualification(...args),
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args)
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
      contributorGithubLogins: ['developer']
    });
    await expect(service.register(input, 'developer')).rejects.toThrow(
      'superseded exact candidate head'
    );
  });
});

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
        failed: 0
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
