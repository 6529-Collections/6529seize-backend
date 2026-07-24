import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  RELEASE_BUS_V2_CANDIDATES_TABLE,
  RELEASE_BUS_V2_CANDIDATE_DEPENDENCIES_TABLE,
  RELEASE_BUS_V2_CONTROLS_TABLE,
  RELEASE_BUS_V2_EVENTS_TABLE,
  RELEASE_BUS_V2_LOCKS_TABLE,
  RELEASE_BUS_V2_MANIFESTS_TABLE,
  RELEASE_BUS_V2_OPERATIONS_TABLE,
  RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE,
  RELEASE_BUS_V2_TRAINS_TABLE
} from '@/constants';
import type { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  type SqlExecutor
} from '@/sql-executor';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2ControlScope,
  ReleaseBusV2DependencyEnvironment,
  ReleaseBusV2FailureClass,
  ReleaseBusV2Lane,
  ReleaseBusV2ManifestStatus,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2OperationStatus,
  ReleaseBusV2PrEvidence,
  ReleaseBusV2Repository as ReleaseBusV2RepositoryName,
  ReleaseBusV2TrainRecord,
  ReleaseBusV2TrainStatus
} from '@/releaseBusV2/release-bus-v2.types';

function dbOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export type ReleaseBusV2DependencyRecord = {
  readonly id: string;
  readonly candidate_id: string;
  readonly prerequisite_candidate_id: string;
  readonly environment: ReleaseBusV2DependencyEnvironment;
  readonly created_at: number;
};

export type ReleaseBusV2TrainCandidateRecord = {
  readonly id: string;
  readonly train_id: string;
  readonly candidate_id: string;
  readonly sequence: number;
  readonly disposition: string;
  readonly created_at: number;
};

export type ReleaseBusV2LockRecord = {
  readonly name: string;
  readonly owner_train_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly heartbeat_at: number | null;
  readonly expires_at: number | null;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2ManifestRecord = {
  readonly id: string;
  readonly train_id: string;
  readonly lane: ReleaseBusV2Lane;
  readonly identity_sha256: string;
  readonly status: ReleaseBusV2ManifestStatus;
  readonly frontend_sha: string | null;
  readonly backend_sha: string | null;
  readonly frontend_artifact_digest: string | null;
  readonly backend_artifact_digest: string | null;
  readonly e2e_run_id: string | null;
  readonly manifest_json: unknown;
  readonly deployed_at: number | null;
  readonly validated_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ReleaseBusV2ControlRecord = {
  readonly scope: ReleaseBusV2ControlScope;
  readonly paused: boolean | number;
  readonly reason: string | null;
  readonly github_actor: string | null;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2EventRecord = {
  readonly id: string;
  readonly train_id: string | null;
  readonly candidate_id: string | null;
  readonly event_type: string;
  readonly github_actor: string | null;
  readonly payload_json: unknown;
  readonly created_at: number;
};

export class ReleaseBusV2Repository extends LazyDbAccessCompatibleService {
  public constructor(db: () => SqlExecutor = dbSupplier) {
    super(db);
  }

  public async findCandidateByIdentity(
    repository: ReleaseBusV2RepositoryName,
    prNumber: number,
    headSha: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2CandidateRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       where repository = :repository and pr_number = :prNumber and head_sha = :headSha`,
      { repository, prNumber, headSha },
      dbOptions(ctx)
    );
  }

  public async findCandidateById(
    id: string,
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ReleaseBusV2CandidateRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2CandidateRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATES_TABLE} where id = :id${forUpdate ? ' for update' : ''}`,
      { id },
      dbOptions(ctx)
    );
  }

  public async createCandidate(
    input: {
      readonly candidateId?: string;
      readonly repository: ReleaseBusV2RepositoryName;
      readonly prNumber: number;
      readonly branchName: string;
      readonly headSha: string;
      readonly requestedBy: string;
      readonly deployPlan: unknown;
      readonly prEvidence: ReleaseBusV2PrEvidence | null;
    },
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord> {
    const id = input.candidateId ?? randomUUID();
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       (id, repository, pr_number, branch_name, head_sha, requested_by, status,
        deploy_plan_json, pr_evidence_json, created_at, updated_at, row_version)
       values (:id, :repository, :prNumber, :branchName, :headSha, :requestedBy,
        'READY_FOR_STAGING', :deployPlan, :prEvidence, :now, :now, 1)`,
      {
        id,
        repository: input.repository,
        prNumber: input.prNumber,
        branchName: input.branchName,
        headSha: input.headSha,
        requestedBy: input.requestedBy,
        deployPlan: json(input.deployPlan),
        prEvidence: json(input.prEvidence),
        now
      },
      dbOptions(ctx)
    );
    const created = await this.findCandidateById(id, ctx);
    if (!created)
      throw new Error('Release Bus v2 candidate insert was not visible');
    return created;
  }

  public async supersedeOtherPrHeads(
    repository: ReleaseBusV2RepositoryName,
    prNumber: number,
    headSha: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const now = Date.now();
    const superseded = await this.db.execute<ReleaseBusV2CandidateRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       where repository = :repository and pr_number = :prNumber and head_sha <> :headSha
         and current_train_id is null
         and status not in ('PRODUCTION_DEPLOYED', 'SUPERSEDED', 'CANCELLED')`,
      { repository, prNumber, headSha },
      dbOptions(ctx)
    );
    await this.db.execute(
      `update ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       set status = 'SUPERSEDED', superseded_at = :now, updated_at = :now,
           row_version = row_version + 1
       where repository = :repository and pr_number = :prNumber and head_sha <> :headSha
         and current_train_id is null
         and status not in ('PRODUCTION_DEPLOYED', 'SUPERSEDED', 'CANCELLED')`,
      { repository, prNumber, headSha, now },
      dbOptions(ctx)
    );
    return superseded;
  }

  public async supersedeMovedBranchHeads(
    repository: ReleaseBusV2RepositoryName,
    branchName: string,
    currentHeadSha: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const superseded = await this.db.execute<ReleaseBusV2CandidateRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       where repository = :repository and branch_name = :branchName
         and head_sha <> :currentHeadSha
         and current_train_id is null
         and status not in ('PRODUCTION_DEPLOYED', 'SUPERSEDED', 'CANCELLED')`,
      { repository, branchName, currentHeadSha },
      dbOptions(ctx)
    );
    if (superseded.length === 0) return [];
    const now = Date.now();
    await this.db.execute(
      `update ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       set status = 'SUPERSEDED', superseded_at = :now, updated_at = :now,
           row_version = row_version + 1
       where repository = :repository and branch_name = :branchName
         and head_sha <> :currentHeadSha
         and current_train_id is null
         and status not in ('PRODUCTION_DEPLOYED', 'SUPERSEDED', 'CANCELLED')`,
      { repository, branchName, currentHeadSha, now },
      dbOptions(ctx)
    );
    return superseded;
  }

  public async addDependency(
    candidateId: string,
    prerequisiteCandidateId: string,
    environment: ReleaseBusV2DependencyEnvironment,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_CANDIDATE_DEPENDENCIES_TABLE}
       (id, candidate_id, prerequisite_candidate_id, environment, created_at)
       values (:id, :candidateId, :prerequisiteCandidateId, :environment, :now)
       on duplicate key update id = id`,
      {
        id: randomUUID(),
        candidateId,
        prerequisiteCandidateId,
        environment,
        now: Date.now()
      },
      dbOptions(ctx)
    );
  }

  public async listDependencies(
    candidateIds: readonly string[],
    ctx: RequestContext
  ): Promise<ReleaseBusV2DependencyRecord[]> {
    const ids = Array.from(new Set(candidateIds));
    if (ids.length === 0) return [];
    if (ids.length > 500)
      throw new Error('Release Bus v2 dependency query exceeds 500 candidates');
    return this.db.execute<ReleaseBusV2DependencyRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATE_DEPENDENCIES_TABLE}
       where candidate_id in (:ids)`,
      { ids },
      dbOptions(ctx)
    );
  }

  public async listCandidates(
    statuses: readonly ReleaseBusV2CandidateStatus[],
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    if (statuses.length === 0) return [];
    return this.db.execute<ReleaseBusV2CandidateRecord>(
      `select * from ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       where status in (:statuses)
       order by coalesce(production_requested_at, created_at) asc, id asc
       limit ${boundedLimit}`,
      { statuses: [...statuses] },
      dbOptions(ctx)
    );
  }

  public async updateCandidate(
    id: string,
    rowVersion: number,
    fields: {
      readonly status: ReleaseBusV2CandidateStatus;
      readonly currentTrainId?: string | null;
      readonly stagingValidatedTrainId?: string | null;
      readonly stagingValidatedManifestId?: string | null;
      readonly productionRequestedAt?: number | null;
      readonly productionRequestedBy?: string | null;
      readonly holdReason?: string | null;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_BUS_V2_CANDIDATES_TABLE}
       set status = :status,
           current_train_id = case when :setCurrentTrainId = 1 then :currentTrainId else current_train_id end,
           staging_validated_train_id = case when :setStagingValidatedTrainId = 1 then :stagingValidatedTrainId else staging_validated_train_id end,
           staging_validated_manifest_id = case when :setStagingValidatedManifestId = 1 then :stagingValidatedManifestId else staging_validated_manifest_id end,
           production_requested_at = case when :setProductionRequestedAt = 1 then :productionRequestedAt else production_requested_at end,
           production_requested_by = case when :setProductionRequestedBy = 1 then :productionRequestedBy else production_requested_by end,
           hold_reason = case when :setHoldReason = 1 then :holdReason else hold_reason end,
           updated_at = :now, row_version = row_version + 1
       where id = :id and row_version = :rowVersion`,
      {
        id,
        rowVersion,
        status: fields.status,
        setCurrentTrainId: fields.currentTrainId === undefined ? 0 : 1,
        currentTrainId: fields.currentTrainId ?? null,
        setStagingValidatedTrainId:
          fields.stagingValidatedTrainId === undefined ? 0 : 1,
        stagingValidatedTrainId: fields.stagingValidatedTrainId ?? null,
        setStagingValidatedManifestId:
          fields.stagingValidatedManifestId === undefined ? 0 : 1,
        stagingValidatedManifestId: fields.stagingValidatedManifestId ?? null,
        setProductionRequestedAt:
          fields.productionRequestedAt === undefined ? 0 : 1,
        productionRequestedAt: fields.productionRequestedAt ?? null,
        setProductionRequestedBy:
          fields.productionRequestedBy === undefined ? 0 : 1,
        productionRequestedBy: fields.productionRequestedBy ?? null,
        setHoldReason: fields.holdReason === undefined ? 0 : 1,
        holdReason: fields.holdReason ?? null,
        now: Date.now()
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async findTrain(
    id: string,
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ReleaseBusV2TrainRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2TrainRecord>(
      `select * from ${RELEASE_BUS_V2_TRAINS_TABLE} where id = :id${forUpdate ? ' for update' : ''}`,
      { id },
      dbOptions(ctx)
    );
  }

  public async listTrains(
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseBusV2TrainRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    return this.db.execute<ReleaseBusV2TrainRecord>(
      `select * from ${RELEASE_BUS_V2_TRAINS_TABLE} order by created_at desc limit ${boundedLimit}`,
      {},
      dbOptions(ctx)
    );
  }

  public async createTrain(
    input: {
      readonly lane: ReleaseBusV2Lane;
      readonly frontendBaseSha: string;
      readonly backendBaseSha: string;
      readonly candidateIds: readonly string[];
    },
    ctx: RequestContext
  ): Promise<ReleaseBusV2TrainRecord> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_TRAINS_TABLE}
       (id, lane, status, frontend_base_sha, backend_base_sha, phase_started_at,
        created_at, updated_at, row_version)
       values (:id, :lane, 'CLAIMED', :frontendBaseSha, :backendBaseSha, :now, :now, :now, 1)`,
      {
        id,
        lane: input.lane,
        frontendBaseSha: input.frontendBaseSha,
        backendBaseSha: input.backendBaseSha,
        now
      },
      dbOptions(ctx)
    );
    for (let index = 0; index < input.candidateIds.length; index += 1) {
      const candidateId = input.candidateIds[index];
      await this.db.execute(
        `insert into ${RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE}
         (id, train_id, candidate_id, sequence, disposition, created_at)
         values (:id, :trainId, :candidateId, :sequence, 'INCLUDED', :now)`,
        {
          id: randomUUID(),
          trainId: id,
          candidateId,
          sequence: index + 1,
          now
        },
        dbOptions(ctx)
      );
    }
    const train = await this.findTrain(id, ctx);
    if (!train) throw new Error('Release Bus v2 train insert was not visible');
    return train;
  }

  public async createQualificationTrain(
    input: {
      readonly parentTrainId: string;
      readonly frontendBaseSha: string;
      readonly backendBaseSha: string;
      readonly frontendComposedSha: string | null;
      readonly backendComposedSha: string | null;
      readonly frontendArtifactDigest: string | null;
      readonly backendArtifactDigest: string | null;
      readonly candidateIds: readonly string[];
    },
    ctx: RequestContext
  ): Promise<ReleaseBusV2TrainRecord> {
    const qualificationIdentitySha256 = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const existing = await this.findQualificationTrain(
      input.parentTrainId,
      ctx
    );
    if (
      existing &&
      existing.qualification_identity_sha256 !== qualificationIdentitySha256
    )
      throw new Error(
        `Release Bus v2 qualification parent ${input.parentTrainId} was reused with different immutable content`
      );
    const id = randomUUID();
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_TRAINS_TABLE}
       (id, lane, status, frontend_base_sha, backend_base_sha,
        frontend_composed_sha, backend_composed_sha, frontend_artifact_digest,
        backend_artifact_digest, parent_train_id, qualification_identity_sha256,
        phase_started_at, created_at, updated_at, row_version)
       values (:id, 'PRODUCTION_QUALIFICATION', 'PREPARED', :frontendBaseSha,
        :backendBaseSha, :frontendComposedSha, :backendComposedSha,
        :frontendArtifactDigest, :backendArtifactDigest, :parentTrainId,
        :qualificationIdentitySha256, :now, :now, :now, 1)
       on duplicate key update id = id`,
      { id, ...input, qualificationIdentitySha256, now },
      dbOptions(ctx)
    );
    const train = await this.findQualificationTrain(input.parentTrainId, ctx);
    if (!train)
      throw new Error(
        'Release Bus v2 qualification train insert was not visible'
      );
    if (train.qualification_identity_sha256 !== qualificationIdentitySha256)
      throw new Error(
        `Release Bus v2 qualification parent ${input.parentTrainId} was reused with different immutable content`
      );
    for (let index = 0; index < input.candidateIds.length; index += 1) {
      await this.db.execute(
        `insert into ${RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE}
         (id, train_id, candidate_id, sequence, disposition, created_at)
         values (:id, :trainId, :candidateId, :sequence, 'INCLUDED', :now)
         on duplicate key update id = id`,
        {
          id: randomUUID(),
          trainId: train.id,
          candidateId: input.candidateIds[index],
          sequence: index + 1,
          now
        },
        dbOptions(ctx)
      );
    }
    await this.assertQualificationTrain(train, input, ctx);
    return train;
  }

  private async findQualificationTrain(
    parentTrainId: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2TrainRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2TrainRecord>(
      `select * from ${RELEASE_BUS_V2_TRAINS_TABLE}
       where parent_train_id = :parentTrainId limit 1`,
      { parentTrainId },
      dbOptions(ctx)
    );
  }

  private async assertQualificationTrain(
    train: ReleaseBusV2TrainRecord,
    input: {
      readonly parentTrainId: string;
      readonly frontendBaseSha: string;
      readonly backendBaseSha: string;
      readonly frontendComposedSha: string | null;
      readonly backendComposedSha: string | null;
      readonly frontendArtifactDigest: string | null;
      readonly backendArtifactDigest: string | null;
      readonly candidateIds: readonly string[];
    },
    ctx: RequestContext
  ): Promise<void> {
    const immutableMatches =
      train.lane === 'PRODUCTION_QUALIFICATION' &&
      train.parent_train_id === input.parentTrainId &&
      train.frontend_base_sha === input.frontendBaseSha &&
      train.backend_base_sha === input.backendBaseSha &&
      train.frontend_composed_sha === input.frontendComposedSha &&
      train.backend_composed_sha === input.backendComposedSha &&
      train.frontend_artifact_digest === input.frontendArtifactDigest &&
      train.backend_artifact_digest === input.backendArtifactDigest;
    const candidateIds = (await this.listTrainCandidates(train.id, ctx))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ candidate_id }) => candidate_id);
    if (
      !immutableMatches ||
      !isDeepStrictEqual(candidateIds, Array.from(input.candidateIds))
    )
      throw new Error(
        `Release Bus v2 qualification parent ${input.parentTrainId} was reused with different immutable content`
      );
  }

  public async listTrainCandidates(
    trainId: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2TrainCandidateRecord[]> {
    return this.db.execute<ReleaseBusV2TrainCandidateRecord>(
      `select * from ${RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE}
       where train_id = :trainId order by sequence asc`,
      { trainId },
      dbOptions(ctx)
    );
  }

  public async updateTrainCandidateDisposition(
    trainId: string,
    candidateId: string,
    disposition: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE}
       set disposition = :disposition
       where train_id = :trainId and candidate_id = :candidateId`,
      { trainId, candidateId, disposition },
      dbOptions(ctx)
    );
  }

  public async updateTrain(
    id: string,
    rowVersion: number,
    fields: {
      readonly status: ReleaseBusV2TrainStatus;
      readonly frontendComposedSha?: string | null;
      readonly backendComposedSha?: string | null;
      readonly frontendArtifactDigest?: string | null;
      readonly backendArtifactDigest?: string | null;
      readonly manifestId?: string | null;
      readonly qualificationTrainId?: string | null;
      readonly failureClass?: ReleaseBusV2FailureClass | null;
      readonly failureMessage?: string | null;
      readonly recoveryMessage?: string | null;
      readonly completedAt?: number | null;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.execute(
      `update ${RELEASE_BUS_V2_TRAINS_TABLE}
       set status = :status,
           frontend_composed_sha = coalesce(:frontendComposedSha, frontend_composed_sha),
           backend_composed_sha = coalesce(:backendComposedSha, backend_composed_sha),
           frontend_artifact_digest = coalesce(:frontendArtifactDigest, frontend_artifact_digest),
           backend_artifact_digest = coalesce(:backendArtifactDigest, backend_artifact_digest),
           manifest_id = coalesce(:manifestId, manifest_id),
           qualification_train_id = coalesce(:qualificationTrainId, qualification_train_id),
           failure_class = :failureClass,
           failure_message = :failureMessage, recovery_message = :recoveryMessage,
           completed_at = :completedAt, phase_started_at = :now, updated_at = :now,
           row_version = row_version + 1
       where id = :id and row_version = :rowVersion`,
      {
        id,
        rowVersion,
        status: fields.status,
        frontendComposedSha: fields.frontendComposedSha ?? null,
        backendComposedSha: fields.backendComposedSha ?? null,
        frontendArtifactDigest: fields.frontendArtifactDigest ?? null,
        backendArtifactDigest: fields.backendArtifactDigest ?? null,
        manifestId: fields.manifestId ?? null,
        qualificationTrainId: fields.qualificationTrainId ?? null,
        failureClass: fields.failureClass ?? null,
        failureMessage: fields.failureMessage ?? null,
        recoveryMessage: fields.recoveryMessage ?? null,
        completedAt: fields.completedAt ?? null,
        now
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async getOrCreateOperation(
    input: {
      readonly idempotencyKey: string;
      readonly trainId: string;
      readonly operationType: string;
      readonly repository: ReleaseBusV2RepositoryName | null;
      readonly service: string | null;
      readonly environment: string | null;
      readonly expectedSha: string | null;
      readonly artifactDigest: string | null;
      readonly request: unknown;
      readonly maxAttempts?: number;
    },
    ctx: RequestContext
  ): Promise<ReleaseBusV2OperationRecord> {
    const existing = await this.findOperation(input.idempotencyKey, ctx);
    if (existing) {
      this.assertOperationIdentity(existing, input);
      return existing;
    }
    const id = randomUUID();
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_OPERATIONS_TABLE}
       (id, idempotency_key, train_id, operation_type, repository, service,
        environment, expected_sha, artifact_digest, status, attempt, max_attempts,
        request_json, created_at, updated_at, row_version)
       values (:id, :idempotencyKey, :trainId, :operationType, :repository, :service,
        :environment, :expectedSha, :artifactDigest, 'PENDING', 1, :maxAttempts,
        :request, :now, :now, 1)
       on duplicate key update id = id`,
      {
        id,
        idempotencyKey: input.idempotencyKey,
        trainId: input.trainId,
        operationType: input.operationType,
        repository: input.repository,
        service: input.service,
        environment: input.environment,
        expectedSha: input.expectedSha,
        artifactDigest: input.artifactDigest,
        maxAttempts: input.maxAttempts ?? 3,
        request: json(input.request),
        now
      },
      dbOptions(ctx)
    );
    const created = await this.findOperation(input.idempotencyKey, ctx);
    if (!created)
      throw new Error('Release Bus v2 operation insert was not visible');
    this.assertOperationIdentity(created, input);
    return created;
  }

  private assertOperationIdentity(
    operation: ReleaseBusV2OperationRecord,
    input: {
      readonly trainId: string;
      readonly operationType: string;
      readonly repository: ReleaseBusV2RepositoryName | null;
      readonly service: string | null;
      readonly environment: string | null;
      readonly expectedSha: string | null;
      readonly artifactDigest: string | null;
      readonly request: unknown;
      readonly maxAttempts?: number;
    }
  ): void {
    if (
      operation.train_id !== input.trainId ||
      operation.operation_type !== input.operationType ||
      operation.repository !== input.repository ||
      operation.service !== input.service ||
      operation.environment !== input.environment ||
      operation.expected_sha !== input.expectedSha ||
      (input.artifactDigest !== null &&
        operation.artifact_digest !== input.artifactDigest) ||
      operation.max_attempts !== (input.maxAttempts ?? 3) ||
      !isDeepStrictEqual(parsedJson(operation.request_json), input.request)
    )
      throw new Error(
        `Release Bus v2 idempotency key ${operation.idempotency_key} was reused with a different immutable operation identity`
      );
  }

  public async findOperation(
    idempotencyKey: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2OperationRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2OperationRecord>(
      `select * from ${RELEASE_BUS_V2_OPERATIONS_TABLE} where idempotency_key = :idempotencyKey`,
      { idempotencyKey },
      dbOptions(ctx)
    );
  }

  public async listOperations(
    trainId: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2OperationRecord[]> {
    return this.db.execute<ReleaseBusV2OperationRecord>(
      `select * from ${RELEASE_BUS_V2_OPERATIONS_TABLE}
       where train_id = :trainId order by created_at asc, id asc`,
      { trainId },
      dbOptions(ctx)
    );
  }

  public async updateOperation(
    id: string,
    rowVersion: number,
    fields: {
      readonly status: ReleaseBusV2OperationStatus;
      readonly externalId?: string | null;
      readonly artifactDigest?: string | null;
      readonly result?: unknown;
      readonly nextRetryAt?: number | null;
      readonly failureClass?: ReleaseBusV2FailureClass | null;
      readonly failureMessage?: string | null;
      readonly attempt?: number;
      readonly completedAt?: number | null;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.execute(
      `update ${RELEASE_BUS_V2_OPERATIONS_TABLE}
       set status = :status,
           external_id = case when :setExternalId = 1 then :externalId else external_id end,
           artifact_digest = case when :setArtifactDigest = 1 then :artifactDigest else artifact_digest end,
           result_json = case when :setResult = 1 then :result else result_json end,
           next_retry_at = :nextRetryAt,
           failure_class = :failureClass, failure_message = :failureMessage,
           attempt = coalesce(:attempt, attempt),
           started_at = coalesce(started_at, :now), completed_at = :completedAt,
           updated_at = :now, row_version = row_version + 1
       where id = :id and row_version = :rowVersion`,
      {
        id,
        rowVersion,
        status: fields.status,
        setExternalId: fields.externalId === undefined ? 0 : 1,
        externalId: fields.externalId ?? null,
        setArtifactDigest: fields.artifactDigest === undefined ? 0 : 1,
        artifactDigest: fields.artifactDigest ?? null,
        setResult: fields.result === undefined ? 0 : 1,
        result: json(fields.result),
        nextRetryAt: fields.nextRetryAt ?? null,
        failureClass: fields.failureClass ?? null,
        failureMessage: fields.failureMessage ?? null,
        attempt: fields.attempt ?? null,
        completedAt: fields.completedAt ?? null,
        now
      },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async acquireLock(
    name: string,
    ownerTrainId: string | null,
    leaseOwner: string,
    ttlMs: number,
    ctx: RequestContext
  ): Promise<ReleaseBusV2LockRecord | null> {
    const now = Date.now();
    const token = randomUUID();
    const result = await this.db.execute(
      `update ${RELEASE_BUS_V2_LOCKS_TABLE}
       set owner_train_id = :ownerTrainId, lease_owner = :leaseOwner, lease_token = :token,
           heartbeat_at = :now, expires_at = :expiresAt, updated_at = :now,
           row_version = row_version + 1
       where name = :name and (lease_token is null or expires_at < :now or lease_owner = :leaseOwner)`,
      { name, ownerTrainId, leaseOwner, token, now, expiresAt: now + ttlMs },
      dbOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1) return null;
    return this.db.oneOrNull<ReleaseBusV2LockRecord>(
      `select * from ${RELEASE_BUS_V2_LOCKS_TABLE} where name = :name`,
      { name },
      dbOptions(ctx)
    );
  }

  public async releaseLock(
    name: string,
    leaseToken: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${RELEASE_BUS_V2_LOCKS_TABLE}
       set owner_train_id = null, lease_owner = null, lease_token = null,
           heartbeat_at = null, expires_at = null, updated_at = :now,
           row_version = row_version + 1
       where name = :name and lease_token = :leaseToken`,
      { name, leaseToken, now: Date.now() },
      dbOptions(ctx)
    );
    return this.db.getAffectedRows(result) === 1;
  }

  public async listLocks(
    ctx: RequestContext
  ): Promise<ReleaseBusV2LockRecord[]> {
    return this.db.execute<ReleaseBusV2LockRecord>(
      `select * from ${RELEASE_BUS_V2_LOCKS_TABLE} order by name asc`,
      {},
      dbOptions(ctx)
    );
  }

  public async createManifest(
    input: Omit<ReleaseBusV2ManifestRecord, 'id' | 'created_at' | 'updated_at'>,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord> {
    const existing = await this.findManifestByIdentity(
      input.identity_sha256,
      ctx
    );
    if (existing) {
      this.assertManifestIdentity(existing, input);
      return existing;
    }
    const id = randomUUID();
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_MANIFESTS_TABLE}
       (id, train_id, lane, identity_sha256, status, frontend_sha, backend_sha,
        frontend_artifact_digest, backend_artifact_digest, e2e_run_id,
        manifest_json, deployed_at, validated_at, created_at, updated_at)
       values (:id, :trainId, :lane, :identitySha256, :status, :frontendSha, :backendSha,
        :frontendArtifactDigest, :backendArtifactDigest, :e2eRunId,
        :manifest, :deployedAt, :validatedAt, :now, :now)`,
      {
        id,
        trainId: input.train_id,
        lane: input.lane,
        identitySha256: input.identity_sha256,
        status: input.status,
        frontendSha: input.frontend_sha,
        backendSha: input.backend_sha,
        frontendArtifactDigest: input.frontend_artifact_digest,
        backendArtifactDigest: input.backend_artifact_digest,
        e2eRunId: input.e2e_run_id,
        manifest: JSON.stringify(input.manifest_json),
        deployedAt: input.deployed_at,
        validatedAt: input.validated_at,
        now
      },
      dbOptions(ctx)
    );
    const created = await this.findManifestByIdentity(
      input.identity_sha256,
      ctx
    );
    if (!created)
      throw new Error('Release Bus v2 manifest insert was not visible');
    this.assertManifestIdentity(created, input);
    return created;
  }

  private assertManifestIdentity(
    manifest: ReleaseBusV2ManifestRecord,
    input: Omit<ReleaseBusV2ManifestRecord, 'id' | 'created_at' | 'updated_at'>
  ): void {
    if (
      manifest.train_id !== input.train_id ||
      manifest.lane !== input.lane ||
      manifest.frontend_sha !== input.frontend_sha ||
      manifest.backend_sha !== input.backend_sha ||
      manifest.frontend_artifact_digest !== input.frontend_artifact_digest ||
      manifest.backend_artifact_digest !== input.backend_artifact_digest ||
      !isDeepStrictEqual(
        parsedJson(manifest.manifest_json),
        input.manifest_json
      )
    )
      throw new Error(
        `Release Bus v2 manifest identity ${manifest.identity_sha256} was reused with different immutable content`
      );
  }

  public async findManifestByIdentity(
    identitySha256: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2ManifestRecord>(
      `select * from ${RELEASE_BUS_V2_MANIFESTS_TABLE} where identity_sha256 = :identitySha256`,
      { identitySha256 },
      dbOptions(ctx)
    );
  }

  public async findManifest(
    id: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2ManifestRecord>(
      `select * from ${RELEASE_BUS_V2_MANIFESTS_TABLE} where id = :id`,
      { id },
      dbOptions(ctx)
    );
  }

  public async findValidatedManifestByRelease(
    frontendSha: string | null,
    backendSha: string | null,
    frontendArtifactDigest: string | null,
    backendArtifactDigest: string | null,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2ManifestRecord>(
      `select * from ${RELEASE_BUS_V2_MANIFESTS_TABLE}
       where frontend_sha <=> :frontendSha and backend_sha <=> :backendSha
         and frontend_artifact_digest <=> :frontendArtifactDigest
         and backend_artifact_digest <=> :backendArtifactDigest
         and status in ('STAGING_VALIDATED', 'PRODUCTION_DEPLOYED')
       order by validated_at desc, created_at desc limit 1`,
      {
        frontendSha,
        backendSha,
        frontendArtifactDigest,
        backendArtifactDigest
      },
      dbOptions(ctx)
    );
  }

  public async findValidatedManifestByShas(
    frontendSha: string | null,
    backendSha: string | null,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.db.oneOrNull<ReleaseBusV2ManifestRecord>(
      `select * from ${RELEASE_BUS_V2_MANIFESTS_TABLE}
       where frontend_sha <=> :frontendSha and backend_sha <=> :backendSha
         and status in ('STAGING_VALIDATED', 'PRODUCTION_DEPLOYED')
       order by validated_at desc, created_at desc limit 1`,
      { frontendSha, backendSha },
      dbOptions(ctx)
    );
  }

  public async listManifests(
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ManifestRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    return this.db.execute<ReleaseBusV2ManifestRecord>(
      `select * from ${RELEASE_BUS_V2_MANIFESTS_TABLE} order by created_at desc limit ${boundedLimit}`,
      {},
      dbOptions(ctx)
    );
  }

  public async updateManifestStatus(
    id: string,
    status: ReleaseBusV2ManifestStatus,
    e2eRunId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `update ${RELEASE_BUS_V2_MANIFESTS_TABLE}
       set status = :status, e2e_run_id = coalesce(:e2eRunId, e2e_run_id),
           validated_at = case when :status = 'STAGING_VALIDATED' then :now else validated_at end,
           updated_at = :now where id = :id`,
      { id, status, e2eRunId, now },
      dbOptions(ctx)
    );
  }

  public async listControls(
    ctx: RequestContext
  ): Promise<ReleaseBusV2ControlRecord[]> {
    return this.db.execute<ReleaseBusV2ControlRecord>(
      `select * from ${RELEASE_BUS_V2_CONTROLS_TABLE} order by scope asc`,
      {},
      dbOptions(ctx)
    );
  }

  public async setControl(
    scope: ReleaseBusV2ControlScope,
    paused: boolean,
    reason: string,
    actor: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${RELEASE_BUS_V2_CONTROLS_TABLE}
       set paused = :paused, reason = :reason, github_actor = :actor,
           updated_at = :now, row_version = row_version + 1 where scope = :scope`,
      { scope, paused, reason, actor, now: Date.now() },
      dbOptions(ctx)
    );
  }

  public async appendEvent(
    input: {
      readonly trainId?: string | null;
      readonly candidateId?: string | null;
      readonly eventType: string;
      readonly actor?: string | null;
      readonly payload?: unknown;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${RELEASE_BUS_V2_EVENTS_TABLE}
       (id, train_id, candidate_id, event_type, github_actor, payload_json, created_at)
       values (:id, :trainId, :candidateId, :eventType, :actor, :payload, :now)`,
      {
        id: randomUUID(),
        trainId: input.trainId ?? null,
        candidateId: input.candidateId ?? null,
        eventType: input.eventType,
        actor: input.actor ?? null,
        payload: json(input.payload),
        now: Date.now()
      },
      dbOptions(ctx)
    );
  }

  public async listEvents(
    trainId: string,
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseBusV2EventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return this.db.execute<ReleaseBusV2EventRecord>(
      `select * from ${RELEASE_BUS_V2_EVENTS_TABLE}
       where train_id = :trainId order by created_at desc limit ${boundedLimit}`,
      { trainId },
      dbOptions(ctx)
    );
  }
}

export const releaseBusV2Repository = new ReleaseBusV2Repository();
