import { randomUUID } from 'node:crypto';
import deployConfig from '@/config/deploy-services.json';
import type { RequestContext } from '@/request.context';
import {
  topologicallySort,
  transitiveDependants
} from '@/releaseBus/release-bus.dag';
import {
  RELEASE_BUS_LANE_TTL_MS,
  RELEASE_BUS_MAX_TRAIN_CANDIDATES
} from '@/releaseBus/release-bus.config';
import {
  assertCandidateTransition,
  claimedStatusForLane,
  readyStatusForLane,
  requiredDependencyStateForLane
} from '@/releaseBus/release-bus.state-machine';
import {
  releaseBusRepository,
  type ReleaseBusRepository
} from '@/releaseBus/release-bus.repository';
import type {
  MarkReleaseReadyInput,
  ReleaseCandidateRecord,
  ReleaseControlScope,
  ReleaseDeployPlan,
  ReleaseLane,
  ReleaseRepository,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';

export type ResolvedDependency = {
  readonly repository: ReleaseRepository;
  readonly branch: string;
  readonly headSha: string;
  readonly prNumber: number | null;
};

export type ReadyCandidateRequest = MarkReleaseReadyInput & {
  readonly actor: string;
  readonly prNumber: number | null;
  readonly resolvedDependencies: ResolvedDependency[];
};

export type FreezeTrainInput = {
  readonly lane: ReleaseLane;
  readonly owner: string;
  readonly frontendBaseSha: string | null;
  readonly backendBaseSha: string | null;
  readonly cutoffAt?: number;
  readonly excludedCandidateIds?: readonly string[];
  readonly allowShadowDependencyEvidence?: boolean;
};

function normalizeDeployPlan(
  plan: ReleaseDeployPlan | null
): ReleaseDeployPlan | null {
  if (!plan) return null;
  const units = Array.from(new Set(plan.units)).sort((a, b) =>
    a.localeCompare(b)
  );
  if (units.length === 0)
    throw new Error('Backend candidates require at least one deploy unit');
  if (units.some((unit) => !/^[A-Za-z0-9_-]+$/.test(unit))) {
    throw new Error('Deploy plan contains an invalid unit');
  }
  const knownUnits = new Set(
    deployConfig.services.map((service) => service.name)
  );
  const unknownUnit = units.find((unit) => !knownUnits.has(unit));
  if (unknownUnit)
    throw new Error(`Deploy plan contains unknown unit ${unknownUnit}`);
  topologicallySort(units, plan.edges);
  return { units, edges: plan.edges.map(([from, to]) => [from, to]) };
}

function storedDeployPlan(
  value: ReleaseCandidateRecord['deploy_plan_json']
): ReleaseDeployPlan | null {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as ReleaseDeployPlan;
  } catch {
    throw new Error('Stored backend deploy plan is invalid');
  }
}

function deployPlansEqual(
  left: ReleaseDeployPlan | null,
  right: ReleaseDeployPlan | null
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateSort(
  a: ReleaseCandidateRecord,
  b: ReleaseCandidateRecord,
  lane: ReleaseLane
): number {
  const aReady = Number(
    lane === 'STAGING' ? a.staging_ready_at : a.production_ready_at
  );
  const bReady = Number(
    lane === 'STAGING' ? b.staging_ready_at : b.production_ready_at
  );
  return aReady - bReady || a.id.localeCompare(b.id);
}

export class ReleaseBusService {
  public constructor(
    private readonly repository: ReleaseBusRepository = releaseBusRepository
  ) {}

  public async markReady(
    request: ReadyCandidateRequest
  ): Promise<ReleaseCandidateRecord> {
    const sha = request.expected_head_sha.toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw new Error('expected_head_sha must be a 40-character Git SHA');
    if (!/^[A-Za-z0-9._/-]{1,255}$/.test(request.branch))
      throw new Error('Invalid branch name');
    const deployPlan =
      request.repository === 'backend'
        ? normalizeDeployPlan(request.deploy_plan)
        : null;
    if (request.repository === 'backend' && !deployPlan) {
      throw new Error('Backend candidates require deploy_plan');
    }
    if (request.repository === 'frontend' && request.deploy_plan) {
      throw new Error(
        'Frontend candidates cannot declare backend deploy units'
      );
    }
    if (request.repository === 'backend' && request.force_fresh_base_canary) {
      throw new Error(
        'Only frontend candidates can force a fresh frontend base canary'
      );
    }
    if (
      request.repository === 'backend' &&
      request.resolvedDependencies.some(
        (dependency) => dependency.repository === 'frontend'
      )
    ) {
      throw new Error(
        'Backend candidates cannot depend on frontend-first deployment; redesign the change for backend-first compatibility'
      );
    }

    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        let candidate = await this.repository.findCandidateByIdentity(
          request.repository,
          request.branch,
          sha,
          ctx
        );

        if (!candidate) {
          candidate = {
            id: randomUUID(),
            repository: request.repository,
            branch_name: request.branch,
            head_sha: sha,
            pr_number: request.prNumber,
            status: 'DRAFT',
            staging_ready_by_github_login: null,
            staging_ready_at: null,
            production_ready_by_github_login: null,
            production_ready_at: null,
            deploy_plan_json: deployPlan,
            force_fresh_base_canary: request.force_fresh_base_canary,
            metadata_version: 1,
            current_train_id: null,
            hold_reason: null,
            invalidated_at: null,
            released_at: null,
            created_at: Date.now(),
            updated_at: Date.now(),
            row_version: 1
          };
          await this.repository.createCandidate(candidate, ctx);
        }

        const existingPlan = storedDeployPlan(candidate.deploy_plan_json);
        const metadataMutable = ['DRAFT', 'CANCELLED'].includes(
          candidate.status
        );
        if (
          request.repository === 'backend' &&
          existingPlan &&
          !deployPlansEqual(existingPlan, deployPlan) &&
          !metadataMutable
        ) {
          throw new Error(
            'The deploy plan for an immutable backend candidate cannot change; submit a new SHA'
          );
        }
        if (
          !metadataMutable &&
          request.prNumber !== null &&
          candidate.pr_number !== request.prNumber
        ) {
          throw new Error(
            'Pull request metadata for a ready candidate is immutable; cancel it before resubmitting'
          );
        }
        if (
          !metadataMutable &&
          Boolean(candidate.force_fresh_base_canary) !==
            request.force_fresh_base_canary
        ) {
          throw new Error(
            'The force-fresh base-canary choice is immutable; cancel the candidate before resubmitting'
          );
        }
        if (
          metadataMutable &&
          ((request.prNumber !== null &&
            candidate.pr_number !== request.prNumber) ||
            (request.repository === 'backend' &&
              !deployPlansEqual(existingPlan, deployPlan)) ||
            Boolean(candidate.force_fresh_base_canary) !==
              request.force_fresh_base_canary)
        ) {
          await this.repository.updateCandidateMetadata(
            candidate.id,
            candidate.row_version,
            {
              prNumber: request.prNumber,
              deployPlan,
              forceFreshBaseCanary: request.force_fresh_base_canary
            },
            ctx
          );
          const refreshed = await this.repository.findCandidateById(
            candidate.id,
            ctx
          );
          if (!refreshed)
            throw new Error(
              'Release candidate disappeared during metadata update'
            );
          candidate = refreshed;
        }

        const desiredStatus = readyStatusForLane(request.target_lane);
        if (request.target_lane === 'PRODUCTION') {
          const hasEvidence =
            candidate.status === 'STAGING_VALIDATED' ||
            (await this.repository.hasCandidateEvidence(
              candidate.id,
              'CANDIDATE_STAGING_VALIDATED',
              ctx
            ));
          if (!hasEvidence)
            throw new Error('The exact candidate SHA has not passed staging');
        }
        assertCandidateTransition(candidate.status, desiredStatus);

        const resolvedCandidateIds: string[] = [];
        for (const dependency of request.resolvedDependencies) {
          let row = await this.repository.findCandidateByIdentity(
            dependency.repository,
            dependency.branch,
            dependency.headSha.toLowerCase(),
            ctx
          );
          if (!row) {
            row = {
              id: randomUUID(),
              repository: dependency.repository,
              branch_name: dependency.branch,
              head_sha: dependency.headSha.toLowerCase(),
              pr_number: dependency.prNumber,
              status: 'DRAFT',
              staging_ready_by_github_login: null,
              staging_ready_at: null,
              production_ready_by_github_login: null,
              production_ready_at: null,
              deploy_plan_json: null,
              force_fresh_base_canary: false,
              metadata_version: 1,
              current_train_id: null,
              hold_reason: null,
              invalidated_at: null,
              released_at: null,
              created_at: Date.now(),
              updated_at: Date.now(),
              row_version: 1
            };
            await this.repository.createCandidate(row, ctx);
          }
          if (row.id === candidate.id)
            throw new Error('A candidate cannot depend on itself');
          resolvedCandidateIds.push(row.id);
        }

        const requiredState = requiredDependencyStateForLane(
          request.target_lane
        );
        if (metadataMutable) {
          await this.repository.replaceDependencies(
            candidate.id,
            resolvedCandidateIds.map((dependsOnCandidateId) => ({
              dependsOnCandidateId,
              requiredState
            })),
            ctx
          );
          if (candidate.status === 'CANCELLED') {
            await this.repository.bumpCandidateMetadataVersion(
              candidate.id,
              candidate.row_version,
              ctx
            );
            const refreshed = await this.repository.findCandidateById(
              candidate.id,
              ctx
            );
            if (!refreshed)
              throw new Error(
                'Release candidate disappeared during resubmission'
              );
            candidate = refreshed;
          }
        } else {
          const existingDependencies = await this.repository.listDependencies(
            [candidate.id],
            ctx
          );
          const existingIds = existingDependencies
            .map((dependency) => dependency.depends_on_candidate_id)
            .sort((left, right) => left.localeCompare(right));
          const requestedIds =
            request.target_lane === 'PRODUCTION' &&
            candidate.status === 'STAGING_VALIDATED' &&
            resolvedCandidateIds.length === 0
              ? existingIds
              : [...resolvedCandidateIds].sort((left, right) =>
                  left.localeCompare(right)
                );
          if (JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) {
            throw new Error(
              'Dependencies for a ready candidate are immutable; cancel it before resubmitting'
            );
          }
          const requiredStatesMatch = existingDependencies.every(
            (dependency) => dependency.required_state === requiredState
          );
          if (!requiredStatesMatch) {
            if (
              candidate.status !== 'STAGING_VALIDATED' ||
              request.target_lane !== 'PRODUCTION'
            ) {
              throw new Error(
                'Dependency validation state cannot change in the current candidate lifecycle'
              );
            }
            await this.repository.replaceDependencies(
              candidate.id,
              requestedIds.map((dependsOnCandidateId) => ({
                dependsOnCandidateId,
                requiredState
              })),
              ctx
            );
          }
        }
        await this.assertAcyclic(ctx);
        if (candidate.status === desiredStatus) {
          await this.repository.appendEvent(
            {
              candidateId: candidate.id,
              eventType: 'CANDIDATE_READINESS_METADATA_REFRESHED',
              githubActor: request.actor,
              payload: {
                repository: request.repository,
                branch: request.branch,
                head_sha: sha
              }
            },
            ctx
          );
          return candidate;
        }
        await this.repository.updateCandidateLifecycle(
          candidate.id,
          candidate.row_version,
          {
            status: desiredStatus,
            actor: request.actor,
            lane: request.target_lane
          },
          ctx
        );
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: `CANDIDATE_${desiredStatus}`,
            githubActor: request.actor,
            payload: {
              repository: request.repository,
              branch: request.branch,
              head_sha: sha
            }
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after readiness transition');
        return updated;
      }
    );
  }

  public async cancel(
    candidateId: string,
    actor: string
  ): Promise<ReleaseCandidateRecord> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Release candidate not found');
        if (candidate.status === 'PRODUCTION_VALIDATED') {
          throw new Error(
            'Production merging has begun; the candidate can no longer be cancelled'
          );
        }

        const train = candidate.current_train_id
          ? await this.repository.findTrain(candidate.current_train_id, ctx)
          : null;
        if (
          train &&
          [
            'MERGING_PRODUCTION',
            'DEPLOYING_PRODUCTION',
            'DEPLOYING_BACKEND_PRODUCTION',
            'MERGING_FRONTEND_PRODUCTION',
            'DEPLOYING_FRONTEND_PRODUCTION',
            'PRODUCTION_E2E_RUNNING',
            'VALIDATING_PRODUCTION',
            'SYNCING_STAGING'
          ].includes(train.status)
        ) {
          throw new Error(
            'Production merging has begun; the candidate can no longer be cancelled'
          );
        }
        assertCandidateTransition(candidate.status, 'CANCELLED');
        await this.repository.updateCandidateLifecycle(
          candidate.id,
          candidate.row_version,
          { status: 'CANCELLED', currentTrainId: null },
          ctx
        );
        if (train) {
          const items = await this.repository.listTrainItems(train.id, ctx);
          for (const item of items) {
            if (item.candidate_id === candidate.id) continue;
            const other = await this.repository.findCandidateById(
              item.candidate_id,
              ctx,
              true
            );
            if (
              !other ||
              !['STAGING_CLAIMED', 'PRODUCTION_CLAIMED'].includes(other.status)
            )
              continue;
            await this.repository.updateCandidateLifecycle(
              other.id,
              other.row_version,
              {
                status: readyStatusForLane(train.target_lane),
                currentTrainId: null,
                holdReason: 'TRAIN_REVISED_AFTER_CANCELLATION'
              },
              ctx
            );
          }
          if (
            !(await this.repository.cancelTrain(
              train.id,
              train.row_version,
              `Candidate ${candidate.id} was cancelled; remaining candidates were returned to the queue`,
              ctx
            ))
          ) {
            throw new Error(
              'The train changed concurrently; refresh before cancelling again'
            );
          }
          for (const laneName of [
            'global-orchestration',
            'global-staging',
            'global-production'
          ]) {
            const lane = await this.repository.getLane(laneName, ctx);
            if (lane?.train_id === train.id && lane.lease_token) {
              await this.repository.releaseLane(
                laneName,
                lane.lease_token,
                ctx
              );
            }
          }
          await this.repository.appendEvent(
            {
              trainId: train.id,
              candidateId,
              eventType: 'TRAIN_REVISED_AFTER_CANDIDATE_CANCELLATION',
              githubActor: actor
            },
            ctx
          );
        }
        await this.repository.appendEvent(
          { candidateId, eventType: 'CANDIDATE_CANCELLED', githubActor: actor },
          ctx
        );
        return (await this.repository.findCandidateById(
          candidateId,
          ctx
        )) as ReleaseCandidateRecord;
      }
    );
  }

  public async invalidateBranch(
    repository: ReleaseRepository,
    branch: string,
    newHeadSha: string,
    actor = 'github-webhook'
  ): Promise<ReleaseCandidateRecord[]> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const candidates = await this.repository.listBranchCandidates(
          repository,
          branch,
          ctx
        );
        const invalidated: ReleaseCandidateRecord[] = [];
        for (const candidate of candidates) {
          if (
            candidate.head_sha === newHeadSha ||
            ![
              'DRAFT',
              'READY_FOR_STAGING',
              'STAGING_VALIDATED',
              'READY_FOR_PRODUCTION',
              'BLOCKED'
            ].includes(candidate.status)
          )
            continue;
          assertCandidateTransition(candidate.status, 'SUPERSEDED');
          await this.repository.updateCandidateLifecycle(
            candidate.id,
            candidate.row_version,
            {
              status: 'SUPERSEDED',
              invalidatedAt: Date.now(),
              holdReason: `Branch moved to ${newHeadSha}`
            },
            ctx
          );
          await this.repository.appendEvent(
            {
              candidateId: candidate.id,
              eventType: 'CANDIDATE_SUPERSEDED',
              githubActor: actor,
              payload: { new_head_sha: newHeadSha }
            },
            ctx
          );
          invalidated.push(candidate);
        }
        return invalidated;
      }
    );
  }

  public async freezeNextTrain(
    input: FreezeTrainInput
  ): Promise<ReleaseTrainRecord | null> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const controls = await this.repository.listControls(ctx, true);
        if (
          controls.some(
            (control) =>
              Boolean(control.paused) &&
              (control.scope === 'ALL' || control.scope === input.lane)
          )
        ) {
          return null;
        }
        const trainId = randomUUID();
        const lane = await this.repository.acquireLane(
          'global-orchestration',
          trainId,
          input.owner,
          RELEASE_BUS_LANE_TTL_MS,
          ctx
        );
        if (!lane) return null;

        await this.refreshSatisfiedDependencyHolds(
          input.lane,
          Boolean(input.allowShadowDependencyEvidence),
          ctx
        );
        const readyStatus = readyStatusForLane(input.lane);
        const excludedCandidateIds = new Set(input.excludedCandidateIds ?? []);
        const candidates = (
          await this.repository.listCandidates([readyStatus], 500, ctx)
        ).filter(
          (candidate) =>
            !excludedCandidateIds.has(candidate.id) &&
            Number(
              input.lane === 'STAGING'
                ? candidate.staging_ready_at
                : candidate.production_ready_at
            ) <= (input.cutoffAt ?? Date.now())
        );
        if (candidates.length === 0) {
          await this.repository.releaseLane(
            'global-orchestration',
            lane.lease_token as string,
            ctx
          );
          return null;
        }

        const dependencies = await this.repository.listDependencies(
          candidates.map((candidate) => candidate.id),
          ctx
        );
        const readyIds = new Set(candidates.map((candidate) => candidate.id));
        const blockedRoots = new Set<string>();
        for (const dependency of dependencies) {
          if (readyIds.has(dependency.depends_on_candidate_id)) continue;
          const dependencyCandidate = await this.repository.findCandidateById(
            dependency.depends_on_candidate_id,
            ctx
          );
          const satisfied =
            dependencyCandidate &&
            (dependencyCandidate.status === dependency.required_state ||
              (await this.repository.hasCandidateEvidence(
                dependency.depends_on_candidate_id,
                `CANDIDATE_${dependency.required_state}`,
                ctx
              )) ||
              (Boolean(input.allowShadowDependencyEvidence) &&
                (await this.repository.hasCandidateEvidence(
                  dependency.depends_on_candidate_id,
                  `CANDIDATE_SHADOW_EVALUATED_${input.lane}`,
                  ctx
                ))));
          if (!satisfied) blockedRoots.add(dependency.candidate_id);
        }
        const internalEdges = dependencies
          .filter((dependency) =>
            readyIds.has(dependency.depends_on_candidate_id)
          )
          .map(
            (dependency) =>
              [
                dependency.depends_on_candidate_id,
                dependency.candidate_id
              ] as const
          );
        const graph = topologicallySort(
          candidates.map((candidate) => candidate.id),
          internalEdges,
          (a, b) => {
            const byId = new Map(
              candidates.map((candidate) => [candidate.id, candidate])
            );
            return candidateSort(
              byId.get(a) as ReleaseCandidateRecord,
              byId.get(b) as ReleaseCandidateRecord,
              input.lane
            );
          }
        );
        const held = transitiveDependants(
          Array.from(blockedRoots),
          graph.dependants
        );
        const eligibleIds = graph.order
          .filter((id) => !held.has(id))
          .slice(0, RELEASE_BUS_MAX_TRAIN_CANDIDATES);
        if (eligibleIds.length === 0) {
          await this.repository.releaseLane(
            'global-orchestration',
            lane.lease_token as string,
            ctx
          );
          return null;
        }
        const cutoff = input.cutoffAt ?? Date.now();
        const train: Omit<
          ReleaseTrainRecord,
          'created_at' | 'updated_at' | 'row_version'
        > = {
          id: trainId,
          revision: 1,
          target_lane: input.lane,
          status: 'FROZEN',
          cutoff_at: cutoff,
          frontend_base_sha: input.frontendBaseSha,
          backend_base_sha: input.backendBaseSha,
          frontend_release_branch: null,
          backend_release_branch: null,
          frontend_pr_number: null,
          backend_pr_number: null,
          state_machine_execution_arn: null,
          worker_version: null,
          failure_reason: null,
          started_at: Date.now(),
          completed_at: null
        };
        await this.repository.createTrain(train, eligibleIds, ctx);
        const byId = new Map(
          candidates.map((candidate) => [candidate.id, candidate])
        );
        for (const candidateId of eligibleIds) {
          const candidate = byId.get(candidateId) as ReleaseCandidateRecord;
          await this.repository.updateCandidateLifecycle(
            candidate.id,
            candidate.row_version,
            {
              status: claimedStatusForLane(input.lane),
              currentTrainId: trainId
            },
            ctx
          );
        }
        for (const candidateId of Array.from(held)) {
          const candidate = byId.get(candidateId);
          if (!candidate) continue;
          await this.repository.updateCandidateLifecycle(
            candidate.id,
            candidate.row_version,
            {
              status: 'BLOCKED',
              holdReason: `WAITING_FOR_DEPENDENCY:${input.lane}`
            },
            ctx
          );
        }
        await this.repository.appendEvent(
          {
            trainId,
            eventType: 'TRAIN_FROZEN',
            payload: {
              lane: input.lane,
              cutoff_at: cutoff,
              candidate_ids: eligibleIds
            }
          },
          ctx
        );
        return {
          ...train,
          created_at: Date.now(),
          updated_at: Date.now(),
          row_version: 1
        };
      }
    );
  }

  public async setPaused(
    scope: ReleaseControlScope,
    paused: boolean,
    reason: string,
    actor: string
  ): Promise<void> {
    await this.repository.setControl(scope, paused, reason, actor, {});
    await this.repository.appendEvent(
      {
        eventType: paused ? 'BUS_PAUSED' : 'BUS_RESUMED',
        githubActor: actor,
        payload: { scope, reason }
      },
      {}
    );
  }

  public async pauseForBreakGlass(
    scope: ReleaseControlScope,
    reason: string,
    actor: string
  ): Promise<ReleaseTrainRecord | null> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        // freezeNextTrain takes the same control-row locks before creating a
        // train, so this check-and-pause cannot race a new train into existence.
        await this.repository.listControls(ctx, true);
        const activeTrain = await this.repository.findActiveTrain(ctx);
        if (activeTrain) return activeTrain;
        await this.repository.setControl(scope, true, reason, actor, ctx);
        await this.repository.appendEvent(
          {
            eventType: 'BUS_PAUSED',
            githubActor: actor,
            payload: { scope, reason }
          },
          ctx
        );
        return null;
      }
    );
  }

  private async refreshSatisfiedDependencyHolds(
    lane: ReleaseLane,
    allowShadowDependencyEvidence: boolean,
    ctx: RequestContext
  ): Promise<void> {
    const blocked = (
      await this.repository.listCandidates(['BLOCKED'], 500, ctx)
    ).filter(
      (candidate) => candidate.hold_reason === `WAITING_FOR_DEPENDENCY:${lane}`
    );
    for (const candidate of blocked) {
      const dependencies = await this.repository.listDependencies(
        [candidate.id],
        ctx
      );
      let satisfied = true;
      for (const dependency of dependencies) {
        const target = await this.repository.findCandidateById(
          dependency.depends_on_candidate_id,
          ctx
        );
        if (
          target?.status !== dependency.required_state &&
          !(await this.repository.hasCandidateEvidence(
            dependency.depends_on_candidate_id,
            `CANDIDATE_${dependency.required_state}`,
            ctx
          )) &&
          !(
            allowShadowDependencyEvidence &&
            (await this.repository.hasCandidateEvidence(
              dependency.depends_on_candidate_id,
              `CANDIDATE_SHADOW_EVALUATED_${lane}`,
              ctx
            ))
          )
        ) {
          satisfied = false;
          break;
        }
      }
      if (!satisfied) continue;
      const ready = readyStatusForLane(lane);
      assertCandidateTransition(candidate.status, ready);
      await this.repository.updateCandidateLifecycle(
        candidate.id,
        candidate.row_version,
        { status: ready, holdReason: null },
        ctx
      );
      await this.repository.appendEvent(
        {
          candidateId: candidate.id,
          eventType: 'CANDIDATE_DEPENDENCY_HOLD_RELEASED',
          payload: { lane }
        },
        ctx
      );
    }
  }

  private async assertAcyclic(ctx: RequestContext): Promise<void> {
    const candidates = await this.repository.listCandidates(null, 500, ctx);
    const dependencies = await this.repository.listDependencies(
      candidates.map((candidate) => candidate.id),
      ctx
    );
    const nodeIds = new Set(candidates.map((candidate) => candidate.id));
    for (const dependency of dependencies) {
      nodeIds.add(dependency.depends_on_candidate_id);
    }
    topologicallySort(
      Array.from(nodeIds),
      dependencies.map((dependency) => [
        dependency.depends_on_candidate_id,
        dependency.candidate_id
      ])
    );
  }
}

export const releaseBusService = new ReleaseBusService();
