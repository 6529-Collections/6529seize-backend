import { randomUUID } from 'node:crypto';
import {
  RELEASE_BUS_CONTROLS_TABLE,
  RELEASE_CANDIDATE_DEPENDENCIES_TABLE,
  RELEASE_DEPLOYMENT_LANES_TABLE,
  RELEASE_READY_DEPLOYMENTS_TABLE,
  RELEASE_TRAIN_EVENTS_TABLE,
  RELEASE_TRAIN_EVIDENCE_TABLE,
  RELEASE_TRAIN_ITEMS_TABLE,
  RELEASE_TRAIN_OPERATIONS_TABLE,
  RELEASE_TRAINS_TABLE
} from '@/constants';
import type { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  type SqlExecutor
} from '@/sql-executor';
import type {
  ReleaseCandidateDependencyRecord,
  ReleaseCandidateRecord,
  ReleaseCandidateStatus,
  ReleaseControlScope,
  ReleaseDependencyRequiredState,
  ReleaseLane,
  ReleaseOperationStatus,
  ReleaseTrainRecord,
  ReleaseTrainStatus
} from '@/releaseBus/release-bus.types';

type CreateCandidate = Omit<
  ReleaseCandidateRecord,
  'created_at' | 'updated_at' | 'row_version'
>;

export type ReleaseLaneRecord = {
  readonly name: string;
  readonly train_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly heartbeat_at: number | null;
  readonly expires_at: number | null;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusControlRecord = {
  readonly scope: ReleaseControlScope;
  readonly paused: boolean | number;
  readonly reason: string | null;
  readonly github_actor: string | null;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseTrainItemRecord = {
  readonly id: string;
  readonly train_id: string;
  readonly revision: number;
  readonly candidate_id: string;
  readonly sequence: number;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ReleaseOperationRecord = {
  readonly id: string;
  readonly operation_key: string;
  readonly train_id: string;
  readonly revision: number;
  readonly operation_type: string;
  readonly repository: string | null;
  readonly environment: string | null;
  readonly service: string | null;
  readonly expected_sha: string | null;
  readonly artifact_digest: string | null;
  readonly attempt: number;
  readonly status: ReleaseOperationStatus;
  readonly external_id: string | null;
  readonly request_metadata_json: unknown;
  readonly result_metadata_json: unknown;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

type UpdateOperationFields = {
  readonly status: ReleaseOperationStatus;
  readonly externalId?: string | null;
  readonly resultMetadata?: unknown;
  readonly completedAt?: number | null;
};

export type ReleaseTrainEventRecord = {
  readonly id: string;
  readonly train_id: string | null;
  readonly candidate_id: string | null;
  readonly event_type: string;
  readonly github_actor: string | null;
  readonly payload_json: unknown;
  readonly created_at: number;
};

function dbOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

export class ReleaseBusRepository extends LazyDbAccessCompatibleService {
  public constructor(db: () => SqlExecutor = dbSupplier) {
    super(db);
  }

  public async findCandidateByIdentity(
    repository: string,
    branchName: string,
    headSha: string,
    ctx: RequestContext
  ): Promise<ReleaseCandidateRecord | null> {
    return this.db.oneOrNull<ReleaseCandidateRecord>(
      `select * from ${RELEASE_READY_DEPLOYMENTS_TABLE}
       where repository = :repository and branch_name = :branchName and head_sha = :headSha`,
      { repository, branchName, headSha },
      dbOptions(ctx)
    );
  }

  public async findCandidateById(
    id: string,
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ReleaseCandidateRecord | null> {
    return this.db.oneOrNull<ReleaseCandidateRecord>(
      `select * from ${RELEASE_READY_DEPLOYMENTS_TABLE} where id = :id${forUpdate ? ' for update' : ''}`,
      { id },
      dbOptions(ctx)
    );
  }

  public async createCandidate(
    candidate: CreateCandidate,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_READY_DEPLOYMENTS_TABLE}
       (id, repository, branch_name, head_sha, pr_number, status,
        staging_ready_by_github_login, staging_ready_at,
        production_ready_by_github_login, production_ready_at,
        deploy_plan_json, metadata_version, current_train_id, hold_reason,
        invalidated_at, released_at, created_at, updated_at, row_version)
       values (:id, :repository, :branchName, :headSha, :prNumber, :status,
        :stagingActor, :stagingReadyAt, :productionActor, :productionReadyAt,
        :deployPlan, :metadataVersion, :currentTrainId, :holdReason,
        :invalidatedAt, :releasedAt, :now, :now, 1)`,
      {
        id: candidate.id,
        repository: candidate.repository,
        branchName: candidate.branch_name,
        headSha: candidate.head_sha,
        prNumber: candidate.pr_number,
        status: candidate.status,
        stagingActor: candidate.staging_ready_by_github_login,
        stagingReadyAt: candidate.staging_ready_at,
        productionActor: candidate.production_ready_by_github_login,
        productionReadyAt: candidate.production_ready_at,
        deployPlan: candidate.deploy_plan_json
          ? JSON.stringify(candidate.deploy_plan_json)
          : null,
        metadataVersion: candidate.metadata_version,
        currentTrainId: candidate.current_train_id,
        holdReason: candidate.hold_reason,
        invalidatedAt: candidate.invalidated_at,
        releasedAt: candidate.released_at,
        now
      },
      dbOptions(ctx)
    );
  }

  public async updateCandidateMetadata(
    id: string,
    expectedVersion: number,
    fields: {
      readonly prNumber: number | null;
      readonly deployPlan: ReleaseCandidateRecord['deploy_plan_json'];
    },
    ctx: RequestContext
  ): Promise<void> {
    const result = await this.db.execute(
      `update ${RELEASE_READY_DEPLOYMENTS_TABLE}
       set pr_number = coalesce(:prNumber, pr_number),
           deploy_plan_json = coalesce(:deployPlan, deploy_plan_json),
           metadata_version = metadata_version + 1, updated_at = :now,
           row_version = row_version + 1
       where id = :id and row_version = :expectedVersion`,
      {
        id,
        expectedVersion,
        prNumber: fields.prNumber,
        deployPlan: fields.deployPlan
          ? JSON.stringify(fields.deployPlan)
          : null,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1)
      throw new Error(`Release candidate ${id} changed concurrently`);
  }

  public async bumpCandidateMetadataVersion(
    id: string,
    expectedVersion: number,
    ctx: RequestContext
  ): Promise<void> {
    const result = await this.db.execute(
      `update ${RELEASE_READY_DEPLOYMENTS_TABLE}
       set metadata_version = metadata_version + 1, updated_at = :now,
           row_version = row_version + 1
       where id = :id and row_version = :expectedVersion`,
      { id, expectedVersion, now: Date.now() },
      dbOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1)
      throw new Error(`Release candidate ${id} changed concurrently`);
  }

  public async updateCandidateLifecycle(
    id: string,
    expectedVersion: number,
    fields: {
      readonly status: ReleaseCandidateStatus;
      readonly actor?: string;
      readonly lane?: ReleaseLane;
      readonly currentTrainId?: string | null;
      readonly holdReason?: string | null;
      readonly invalidatedAt?: number | null;
      readonly releasedAt?: number | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    const laneColumns =
      fields.lane === 'STAGING'
        ? ', staging_ready_by_github_login = :actor, staging_ready_at = :now'
        : fields.lane === 'PRODUCTION'
          ? ', production_ready_by_github_login = :actor, production_ready_at = :now'
          : '';
    const result = await this.db.execute(
      `update ${RELEASE_READY_DEPLOYMENTS_TABLE}
       set status = :status, current_train_id = :currentTrainId,
           hold_reason = :holdReason, invalidated_at = :invalidatedAt,
           released_at = :releasedAt, updated_at = :now,
           row_version = row_version + 1${laneColumns}
       where id = :id and row_version = :expectedVersion`,
      {
        id,
        expectedVersion,
        status: fields.status,
        currentTrainId: fields.currentTrainId ?? null,
        holdReason: fields.holdReason ?? null,
        invalidatedAt: fields.invalidatedAt ?? null,
        releasedAt: fields.releasedAt ?? null,
        actor: fields.actor ?? null,
        now
      },
      dbOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1) {
      throw new Error(`Release candidate ${id} changed concurrently`);
    }
  }

  public async replaceDependencies(
    candidateId: string,
    dependencies: ReadonlyArray<{
      readonly dependsOnCandidateId: string;
      readonly requiredState: ReleaseDependencyRequiredState;
    }>,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `delete from ${RELEASE_CANDIDATE_DEPENDENCIES_TABLE} where candidate_id = :candidateId`,
      { candidateId },
      dbOptions(ctx)
    );
    const now = Date.now();
    for (const dependency of dependencies) {
      await this.db.execute(
        `insert into ${RELEASE_CANDIDATE_DEPENDENCIES_TABLE}
         (id, candidate_id, depends_on_candidate_id, required_state, created_at, updated_at)
         values (:id, :candidateId, :dependsOnCandidateId, :requiredState, :now, :now)`,
        {
          id: randomUUID(),
          candidateId,
          dependsOnCandidateId: dependency.dependsOnCandidateId,
          requiredState: dependency.requiredState,
          now
        },
        dbOptions(ctx)
      );
    }
  }

  public async listDependencies(
    candidateIds: readonly string[],
    ctx: RequestContext
  ): Promise<ReleaseCandidateDependencyRecord[]> {
    if (candidateIds.length === 0) return [];
    const placeholders = candidateIds
      .map((_, index) => `:id${index}`)
      .join(', ');
    const params = Object.fromEntries(
      candidateIds.map((id, index) => [`id${index}`, id])
    );
    return this.db.execute<ReleaseCandidateDependencyRecord>(
      `select * from ${RELEASE_CANDIDATE_DEPENDENCIES_TABLE}
       where candidate_id in (${placeholders})`,
      params,
      dbOptions(ctx)
    );
  }

  public async listCandidates(
    statuses: readonly ReleaseCandidateStatus[] | null,
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseCandidateRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    if (!statuses || statuses.length === 0) {
      return this.db.execute<ReleaseCandidateRecord>(
        `select * from ${RELEASE_READY_DEPLOYMENTS_TABLE}
         order by created_at desc, id desc limit ${boundedLimit}`,
        undefined,
        dbOptions(ctx)
      );
    }
    const placeholders = statuses
      .map((_, index) => `:status${index}`)
      .join(', ');
    const params = Object.fromEntries(
      statuses.map((status, index) => [`status${index}`, status])
    );
    return this.db.execute<ReleaseCandidateRecord>(
      `select * from ${RELEASE_READY_DEPLOYMENTS_TABLE}
       where status in (${placeholders}) order by created_at, id limit ${boundedLimit}`,
      params,
      dbOptions(ctx)
    );
  }

  public async listBranchCandidates(
    repository: string,
    branchName: string,
    ctx: RequestContext
  ): Promise<ReleaseCandidateRecord[]> {
    return this.db.execute<ReleaseCandidateRecord>(
      `select * from ${RELEASE_READY_DEPLOYMENTS_TABLE}
       where repository = :repository and branch_name = :branchName
       order by created_at desc`,
      { repository, branchName },
      dbOptions(ctx)
    );
  }

  public async hasCandidateEvidence(
    candidateId: string,
    evidenceType: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const row = await this.db.oneOrNull<{ count: number | string }>(
      `select count(*) as count from ${RELEASE_TRAIN_EVIDENCE_TABLE}
       where candidate_id = :candidateId and evidence_type = :evidenceType and status = 'SUCCEEDED'`,
      { candidateId, evidenceType },
      dbOptions(ctx)
    );
    return Number(row?.count ?? 0) > 0;
  }

  public async listCandidateIdsWithEvidence(
    candidateIds: readonly string[],
    evidenceType: string,
    ctx: RequestContext
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const placeholders = candidateIds
      .map((_, index) => `:candidateId${index}`)
      .join(', ');
    const params = Object.fromEntries(
      candidateIds.map((id, index) => [`candidateId${index}`, id])
    );
    const rows = await this.db.execute<{ candidate_id: string }>(
      `select distinct evidence.candidate_id
       from ${RELEASE_TRAIN_EVIDENCE_TABLE} evidence
       join ${RELEASE_READY_DEPLOYMENTS_TABLE} candidate
         on candidate.id = evidence.candidate_id
       where evidence.candidate_id in (${placeholders})
         and evidence.evidence_type = :evidenceType
         and evidence.status = 'SUCCEEDED'
         and cast(json_unquote(json_extract(evidence.metadata_json,
             '$.metadata_version')) as unsigned) = candidate.metadata_version`,
      { ...params, evidenceType },
      dbOptions(ctx)
    );
    return rows.map((row) => row.candidate_id);
  }

  public async createTrain(
    train: Omit<
      ReleaseTrainRecord,
      'created_at' | 'updated_at' | 'row_version'
    >,
    candidateIds: readonly string[],
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_TRAINS_TABLE}
       (id, revision, target_lane, status, cutoff_at, frontend_base_sha,
        backend_base_sha, frontend_release_branch, backend_release_branch,
        frontend_pr_number, backend_pr_number, state_machine_execution_arn,
        worker_version, failure_reason, started_at, completed_at,
        created_at, updated_at, row_version)
       values (:id, :revision, :targetLane, :status, :cutoffAt, :frontendBaseSha,
        :backendBaseSha, :frontendReleaseBranch, :backendReleaseBranch,
        :frontendPrNumber, :backendPrNumber, :executionArn, :workerVersion,
        :failureReason, :startedAt, :completedAt, :now, :now, 1)`,
      {
        id: train.id,
        revision: train.revision,
        targetLane: train.target_lane,
        status: train.status,
        cutoffAt: train.cutoff_at,
        frontendBaseSha: train.frontend_base_sha,
        backendBaseSha: train.backend_base_sha,
        frontendReleaseBranch: train.frontend_release_branch,
        backendReleaseBranch: train.backend_release_branch,
        frontendPrNumber: train.frontend_pr_number,
        backendPrNumber: train.backend_pr_number,
        executionArn: train.state_machine_execution_arn,
        workerVersion: train.worker_version,
        failureReason: train.failure_reason,
        startedAt: train.started_at,
        completedAt: train.completed_at,
        now
      },
      dbOptions(ctx)
    );
    for (let index = 0; index < candidateIds.length; index += 1) {
      const candidateId = candidateIds[index];
      await this.db.execute(
        `insert into ${RELEASE_TRAIN_ITEMS_TABLE}
         (id, train_id, revision, candidate_id, sequence, status, created_at, updated_at)
         values (:id, :trainId, :revision, :candidateId, :sequence, 'INCLUDED', :now, :now)`,
        {
          id: randomUUID(),
          trainId: train.id,
          revision: train.revision,
          candidateId,
          sequence: index + 1,
          now
        },
        dbOptions(ctx)
      );
    }
  }

  public async findTrain(
    id: string,
    ctx: RequestContext
  ): Promise<ReleaseTrainRecord | null> {
    return this.db.oneOrNull<ReleaseTrainRecord>(
      `select * from ${RELEASE_TRAINS_TABLE} where id = :id`,
      { id },
      dbOptions(ctx)
    );
  }

  public async listTrains(
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseTrainRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    return this.db.execute<ReleaseTrainRecord>(
      `select * from ${RELEASE_TRAINS_TABLE} order by created_at desc, id desc limit ${boundedLimit}`,
      undefined,
      dbOptions(ctx)
    );
  }

  public async listTrainItems(
    trainId: string,
    ctx: RequestContext
  ): Promise<ReleaseTrainItemRecord[]> {
    return this.db.execute<ReleaseTrainItemRecord>(
      `select * from ${RELEASE_TRAIN_ITEMS_TABLE} where train_id = :trainId order by sequence`,
      { trainId },
      dbOptions(ctx)
    );
  }

  public async listTrainEvents(
    trainId: string,
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseTrainEventRecord[]> {
    return this.db.execute<ReleaseTrainEventRecord>(
      `select * from ${RELEASE_TRAIN_EVENTS_TABLE}
       where train_id = :trainId
       order by created_at desc, id desc limit :limit`,
      { trainId, limit: Math.min(Math.max(limit, 1), 500) },
      dbOptions(ctx)
    );
  }

  public async updateTrain(
    id: string,
    fields: {
      readonly status?: string;
      readonly executionArn?: string | null;
      readonly workerVersion?: string | null;
      readonly frontendReleaseBranch?: string | null;
      readonly backendReleaseBranch?: string | null;
      readonly frontendPrNumber?: number | null;
      readonly backendPrNumber?: number | null;
      readonly failureReason?: string | null;
      readonly completedAt?: number | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    const current = await this.findTrain(id, ctx);
    if (!current) throw new Error(`Release train ${id} not found`);
    const result = await this.db.execute(
      `update ${RELEASE_TRAINS_TABLE} set
       status = :status, state_machine_execution_arn = :executionArn,
       worker_version = :workerVersion,
       frontend_release_branch = :frontendReleaseBranch,
       backend_release_branch = :backendReleaseBranch,
       frontend_pr_number = :frontendPrNumber,
       backend_pr_number = :backendPrNumber,
       failure_reason = :failureReason, completed_at = :completedAt,
       updated_at = :now, row_version = row_version + 1
       where id = :id and row_version = :rowVersion`,
      {
        id,
        rowVersion: current.row_version,
        status: fields.status ?? current.status,
        executionArn:
          fields.executionArn ?? current.state_machine_execution_arn,
        workerVersion: fields.workerVersion ?? current.worker_version,
        frontendReleaseBranch:
          fields.frontendReleaseBranch ?? current.frontend_release_branch,
        backendReleaseBranch:
          fields.backendReleaseBranch ?? current.backend_release_branch,
        frontendPrNumber: fields.frontendPrNumber ?? current.frontend_pr_number,
        backendPrNumber: fields.backendPrNumber ?? current.backend_pr_number,
        failureReason: fields.failureReason ?? current.failure_reason,
        completedAt: fields.completedAt ?? current.completed_at,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1)
      throw new Error(`Release train ${id} changed concurrently`);
  }

  public async advanceTrainPhase(
    id: string,
    expectedStatus: ReleaseTrainStatus,
    nextStatus: ReleaseTrainStatus,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_TRAINS_TABLE}
       set status = :nextStatus, updated_at = :now,
           row_version = row_version + 1
       where id = :id and status = :expectedStatus`,
      {
        id,
        expectedStatus,
        nextStatus,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async cancelTrain(
    id: string,
    expectedVersion: number,
    reason: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_TRAINS_TABLE}
       set status = 'CANCELLED', failure_reason = :reason,
           completed_at = :now, updated_at = :now,
           row_version = row_version + 1
       where id = :id and row_version = :expectedVersion
         and status not in ('MERGING_PRODUCTION', 'DEPLOYING_PRODUCTION',
                            'DEPLOYING_BACKEND_PRODUCTION',
                            'MERGING_FRONTEND_PRODUCTION',
                            'DEPLOYING_FRONTEND_PRODUCTION',
                            'PRODUCTION_E2E_RUNNING',
                            'VALIDATING_PRODUCTION', 'SYNCING_STAGING',
                            'COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED')`,
      { id, expectedVersion, reason, now: Date.now() },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async reserveStateMachineExecution(
    id: string,
    expectedVersion: number,
    executionArn: string,
    workerVersion: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_TRAINS_TABLE}
       set state_machine_execution_arn = :executionArn,
           worker_version = :workerVersion, updated_at = :now,
           row_version = row_version + 1
       where id = :id and row_version = :expectedVersion
         and status not in ('COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED')`,
      {
        id,
        expectedVersion,
        executionArn,
        workerVersion,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async updateOperation(
    operationKey: string,
    fields: UpdateOperationFields,
    ctx: RequestContext
  ): Promise<void> {
    await this.updateOperationVersioned(operationKey, null, fields, ctx);
  }

  public async updateOperationIfVersion(
    operationKey: string,
    expectedVersion: number,
    fields: UpdateOperationFields,
    ctx: RequestContext
  ): Promise<boolean> {
    return this.updateOperationVersioned(
      operationKey,
      expectedVersion,
      fields,
      ctx
    );
  }

  private async updateOperationVersioned(
    operationKey: string,
    expectedVersion: number | null,
    fields: UpdateOperationFields,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_TRAIN_OPERATIONS_TABLE}
       set status = :status, external_id = coalesce(:externalId, external_id),
           result_metadata_json = coalesce(:resultMetadata, result_metadata_json),
           started_at = coalesce(started_at, :now),
           completed_at = case when :setCompletedAt then :completedAt else completed_at end,
           updated_at = :now, row_version = row_version + 1
       where operation_key = :operationKey
         and (:expectedVersion is null or row_version = :expectedVersion)`,
      {
        operationKey,
        expectedVersion,
        status: fields.status,
        externalId: fields.externalId ?? null,
        resultMetadata: fields.resultMetadata
          ? JSON.stringify(fields.resultMetadata)
          : null,
        setCompletedAt: fields.completedAt !== undefined,
        completedAt: fields.completedAt ?? null,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async bindOperationAuthorization(
    operationKey: string,
    executionId: string,
    artifactDigest: string | null,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_TRAIN_OPERATIONS_TABLE}
       set external_id = coalesce(external_id, :executionId),
           artifact_digest = coalesce(artifact_digest, :artifactDigest),
           updated_at = :now,
           row_version = row_version + 1
       where operation_key = :operationKey
         and status in ('PENDING', 'DISPATCHED', 'RUNNING')
         and (external_id is null or external_id = :executionId)
         and (:artifactDigest is null or artifact_digest is null or artifact_digest = :artifactDigest)`,
      { operationKey, executionId, artifactDigest, now: Date.now() },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async addEvidence(
    evidence: {
      readonly idempotencyKey?: string;
      readonly trainId: string;
      readonly revision: number;
      readonly candidateId?: string | null;
      readonly evidenceType: string;
      readonly status: string;
      readonly sourceSha?: string | null;
      readonly artifactDigest?: string | null;
      readonly evidenceUri?: string | null;
      readonly metadata?: unknown;
    },
    ctx: RequestContext
  ): Promise<void> {
    const evidenceKey =
      evidence.idempotencyKey ??
      [
        evidence.trainId,
        evidence.revision,
        evidence.candidateId ?? '-',
        evidence.evidenceType,
        evidence.sourceSha ?? '-',
        evidence.artifactDigest ?? '-'
      ].join(':');
    await this.db.execute(
      `insert ignore into ${RELEASE_TRAIN_EVIDENCE_TABLE}
       (id, evidence_key, train_id, revision, candidate_id, evidence_type, status, source_sha,
        artifact_digest, evidence_uri, metadata_json, created_at)
       values (:id, :evidenceKey, :trainId, :revision, :candidateId, :evidenceType, :status,
        :sourceSha, :artifactDigest, :evidenceUri, :metadata, :now)`,
      {
        id: randomUUID(),
        evidenceKey,
        trainId: evidence.trainId,
        revision: evidence.revision,
        candidateId: evidence.candidateId ?? null,
        evidenceType: evidence.evidenceType,
        status: evidence.status,
        sourceSha: evidence.sourceSha ?? null,
        artifactDigest: evidence.artifactDigest ?? null,
        evidenceUri: evidence.evidenceUri ?? null,
        metadata: evidence.metadata ? JSON.stringify(evidence.metadata) : null,
        now: Date.now()
      },
      dbOptions(ctx)
    );
  }

  public async ensureControlRows(ctx: RequestContext): Promise<void> {
    const now = Date.now();
    for (const scope of ['ALL', 'STAGING', 'PRODUCTION'] as const) {
      await this.db.execute(
        `insert ignore into ${RELEASE_BUS_CONTROLS_TABLE}
         (scope, paused, reason, github_actor, updated_at, row_version)
         values (:scope, false, null, null, :now, 1)`,
        { scope, now },
        dbOptions(ctx)
      );
    }
  }

  public async listControls(
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ReleaseBusControlRecord[]> {
    await this.ensureControlRows(ctx);
    return this.db.execute<ReleaseBusControlRecord>(
      `select * from ${RELEASE_BUS_CONTROLS_TABLE} order by scope${forUpdate ? ' for update' : ''}`,
      undefined,
      dbOptions(ctx)
    );
  }

  public async findActiveTrain(
    ctx: RequestContext
  ): Promise<ReleaseTrainRecord | null> {
    return this.db.oneOrNull<ReleaseTrainRecord>(
      `select * from ${RELEASE_TRAINS_TABLE}
       where status not in ('COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED')
       order by created_at limit 1 for update`,
      undefined,
      dbOptions(ctx)
    );
  }

  public async setControl(
    scope: ReleaseControlScope,
    paused: boolean,
    reason: string,
    actor: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.ensureControlRows(ctx);
    await this.db.execute(
      `update ${RELEASE_BUS_CONTROLS_TABLE}
       set paused = :paused, reason = :reason, github_actor = :actor,
           updated_at = :now, row_version = row_version + 1
       where scope = :scope`,
      { scope, paused, reason, actor, now: Date.now() },
      dbOptions(ctx)
    );
  }

  public async acquireLane(
    name: string,
    trainId: string,
    owner: string,
    ttlMs: number,
    ctx: RequestContext
  ): Promise<ReleaseLaneRecord | null> {
    const now = Date.now();
    await this.db.execute(
      `insert ignore into ${RELEASE_DEPLOYMENT_LANES_TABLE}
       (name, train_id, lease_owner, lease_token, heartbeat_at, expires_at, updated_at, row_version)
       values (:name, null, null, null, null, null, :now, 1)`,
      { name, now },
      dbOptions(ctx)
    );
    const existing = await this.db.oneOrNull<ReleaseLaneRecord>(
      `select * from ${RELEASE_DEPLOYMENT_LANES_TABLE} where name = :name for update`,
      { name },
      dbOptions(ctx)
    );
    if (existing?.lease_token && Number(existing.expires_at) > now) return null;
    const token = randomUUID();
    await this.db.execute(
      `update ${RELEASE_DEPLOYMENT_LANES_TABLE}
       set train_id = :trainId, lease_owner = :owner, lease_token = :token,
           heartbeat_at = :now, expires_at = :expiresAt, updated_at = :now,
           row_version = row_version + 1 where name = :name`,
      { name, trainId, owner, token, now, expiresAt: now + ttlMs },
      dbOptions(ctx)
    );
    return this.db.oneOrNull<ReleaseLaneRecord>(
      `select * from ${RELEASE_DEPLOYMENT_LANES_TABLE} where name = :name`,
      { name },
      dbOptions(ctx)
    );
  }

  public async getLane(
    name: string,
    ctx: RequestContext
  ): Promise<ReleaseLaneRecord | null> {
    return this.db.oneOrNull<ReleaseLaneRecord>(
      `select * from ${RELEASE_DEPLOYMENT_LANES_TABLE} where name = :name`,
      { name },
      dbOptions(ctx)
    );
  }

  public async listLanes(ctx: RequestContext): Promise<ReleaseLaneRecord[]> {
    return this.db.execute<ReleaseLaneRecord>(
      `select * from ${RELEASE_DEPLOYMENT_LANES_TABLE} order by name`,
      undefined,
      dbOptions(ctx)
    );
  }

  public async releaseLane(
    name: string,
    token: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_DEPLOYMENT_LANES_TABLE}
       set train_id = null, lease_owner = null, lease_token = null,
           heartbeat_at = null, expires_at = null, updated_at = :now,
           row_version = row_version + 1
       where name = :name and lease_token = :token`,
      { name, token, now: Date.now() },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async heartbeatLane(
    name: string,
    trainId: string,
    ttlMs: number,
    ctx: RequestContext
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.execute(
      `update ${RELEASE_DEPLOYMENT_LANES_TABLE}
       set heartbeat_at = :now, expires_at = :expiresAt, updated_at = :now,
           row_version = row_version + 1
       where name = :name and train_id = :trainId and lease_token is not null`,
      { name, trainId, now, expiresAt: now + ttlMs },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async getOrCreateOperation(
    operation: Omit<
      ReleaseOperationRecord,
      'id' | 'created_at' | 'updated_at' | 'row_version'
    >,
    ctx: RequestContext
  ): Promise<ReleaseOperationRecord> {
    const now = Date.now();
    await this.db.execute(
      `insert ignore into ${RELEASE_TRAIN_OPERATIONS_TABLE}
       (id, operation_key, train_id, revision, operation_type, repository,
        environment, service, expected_sha, artifact_digest, attempt, status,
        external_id, request_metadata_json, result_metadata_json, started_at,
        completed_at, created_at, updated_at, row_version)
       values (:id, :operationKey, :trainId, :revision, :operationType,
        :repository, :environment, :service, :expectedSha, :artifactDigest,
        :attempt, :status, :externalId, :requestMetadata, :resultMetadata,
        :startedAt, :completedAt, :now, :now, 1)`,
      {
        id: randomUUID(),
        operationKey: operation.operation_key,
        trainId: operation.train_id,
        revision: operation.revision,
        operationType: operation.operation_type,
        repository: operation.repository,
        environment: operation.environment,
        service: operation.service,
        expectedSha: operation.expected_sha,
        artifactDigest: operation.artifact_digest,
        attempt: operation.attempt,
        status: operation.status,
        externalId: operation.external_id,
        requestMetadata: operation.request_metadata_json
          ? JSON.stringify(operation.request_metadata_json)
          : null,
        resultMetadata: operation.result_metadata_json
          ? JSON.stringify(operation.result_metadata_json)
          : null,
        startedAt: operation.started_at,
        completedAt: operation.completed_at,
        now
      },
      dbOptions(ctx)
    );
    const saved = await this.db.oneOrNull<ReleaseOperationRecord>(
      `select * from ${RELEASE_TRAIN_OPERATIONS_TABLE} where operation_key = :operationKey`,
      { operationKey: operation.operation_key },
      dbOptions(ctx)
    );
    if (!saved)
      throw new Error(`Failed to persist operation ${operation.operation_key}`);
    return saved;
  }

  public async listTrainOperations(
    trainId: string,
    ctx: RequestContext
  ): Promise<ReleaseOperationRecord[]> {
    return this.db.execute<ReleaseOperationRecord>(
      `select * from ${RELEASE_TRAIN_OPERATIONS_TABLE}
       where train_id = :trainId order by created_at, operation_key`,
      { trainId },
      dbOptions(ctx)
    );
  }

  public async findOperation(
    operationKey: string,
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ReleaseOperationRecord | null> {
    return this.db.oneOrNull<ReleaseOperationRecord>(
      `select * from ${RELEASE_TRAIN_OPERATIONS_TABLE} where operation_key = :operationKey${forUpdate ? ' for update' : ''}`,
      { operationKey },
      dbOptions(ctx)
    );
  }

  public async appendEvent(
    event: {
      readonly trainId?: string | null;
      readonly candidateId?: string | null;
      readonly eventType: string;
      readonly githubActor?: string | null;
      readonly payload?: unknown;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${RELEASE_TRAIN_EVENTS_TABLE}
       (id, train_id, candidate_id, event_type, github_actor, payload_json, created_at)
       values (:id, :trainId, :candidateId, :eventType, :githubActor, :payload, :now)`,
      {
        id: randomUUID(),
        trainId: event.trainId ?? null,
        candidateId: event.candidateId ?? null,
        eventType: event.eventType,
        githubActor: event.githubActor ?? null,
        payload: event.payload ? JSON.stringify(event.payload) : null,
        now: Date.now()
      },
      dbOptions(ctx)
    );
  }
}

export const releaseBusRepository = new ReleaseBusRepository();
