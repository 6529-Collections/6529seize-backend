import type { RequestContext } from '@/request.context';
import { isDeepStrictEqual } from 'node:util';
import { getDeployServiceConfigs } from '@/api/deploy/deploy.config';
import { releaseBusGitHubApp } from '@/releaseBus/release-bus.github-app';
import {
  getReleaseBusV2Mode,
  getReleaseBusV2BetaAllowlist,
  RELEASE_BUS_V2_LOCK_TTL_MS,
  RELEASE_BUS_V2_MAX_CANDIDATES,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaAllowsLane,
  releaseBusV2BetaAllowsLaneInMode,
  releaseBusV2BetaAllowsRegistration,
  type ReleaseBusV2BetaEntry,
  releaseBusV2AllowsLane
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusV2Repository,
  type ReleaseBusV2DependencyRecord,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2ControlScope,
  ReleaseBusV2DeployPlan,
  ReleaseBusV2Lane,
  ReleaseBusV2RegisterInput,
  ReleaseBusV2Repository,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

const TERMINAL_TRAIN_STATUSES = new Set([
  'STAGING_VALIDATED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);

export function normalizeDeployPlan(
  repository: ReleaseBusV2Repository,
  plan: ReleaseBusV2DeployPlan | null
): ReleaseBusV2DeployPlan | null {
  if (repository === 'frontend') {
    if (plan)
      throw new Error(
        'Frontend candidates cannot declare backend deploy units'
      );
    return null;
  }
  if (!plan || plan.units.length === 0)
    throw new Error('Backend candidates require at least one deploy unit');
  const serviceConfigs = getDeployServiceConfigs();
  const allowed = new Set(serviceConfigs.map((service) => service.name));
  const units = Array.from(new Set(plan.units));
  if (units.some((unit) => !allowed.has(unit)))
    throw new Error('Backend deploy plan contains an unknown service');
  const selected = new Set(units);
  const declaredEdges = plan.edges.map(([from, to]) => {
    if (from === to || !selected.has(from) || !selected.has(to))
      throw new Error(
        'Backend deploy edges must reference distinct selected units'
      );
    return [from, to] as const;
  });
  const edgeKeys = new Set<string>();
  const edges = serviceConfigs
    .flatMap((service) =>
      service.default_dependencies
        .filter(
          (dependency) => selected.has(service.name) && selected.has(dependency)
        )
        .map((dependency) => [dependency, service.name] as const)
    )
    .concat(declaredEdges)
    .filter(([from, to]) => {
      const key = `${from}\u0000${to}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    })
    .sort(([leftFrom, leftTo], [rightFrom, rightTo]) =>
      `${leftFrom}\u0000${leftTo}`.localeCompare(`${rightFrom}\u0000${rightTo}`)
    );
  topologicalOrder(units, edges);
  return plan.publish_release_notes === false
    ? { units, edges, publish_release_notes: false }
    : { units, edges };
}

export function topologicalOrder(
  nodes: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>
): string[] {
  const unique = Array.from(new Set(nodes)).sort((left, right) =>
    left.localeCompare(right)
  );
  const incoming = new Map(unique.map((node) => [node, 0]));
  const outgoing = new Map(unique.map((node) => [node, new Set<string>()]));
  for (const [from, to] of edges) {
    if (!incoming.has(from) || !incoming.has(to))
      throw new Error('Dependency edge references an unknown node');
    if (outgoing.get(from)?.has(to)) continue;
    outgoing.get(from)?.add(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const ready = unique.filter((node) => incoming.get(node) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) break;
    result.push(node);
    for (const next of Array.from(outgoing.get(node) ?? []).sort(
      (left, right) => left.localeCompare(right)
    )) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  if (result.length !== unique.length)
    throw new Error('Dependency graph contains a cycle');
  return result;
}

function parseStoredJson<T>(value: T | string | null): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function laneScope(lane: ReleaseBusV2Lane): 'STAGING' | 'PRODUCTION' {
  return lane === 'PRODUCTION' ? 'PRODUCTION' : 'STAGING';
}

function readyStatus(lane: ReleaseBusV2Lane): ReleaseBusV2CandidateStatus {
  return lane === 'PRODUCTION' ? 'READY_FOR_PRODUCTION' : 'READY_FOR_STAGING';
}

function claimedStatus(lane: ReleaseBusV2Lane): ReleaseBusV2CandidateStatus {
  return lane === 'PRODUCTION' ? 'PRODUCTION_IN_TRAIN' : 'STAGING_IN_TRAIN';
}

function sameQualificationIdentity(
  stored: ReleaseBusV2CandidateRecord['pr_evidence_json'],
  current: {
    readonly base_sha: string;
    readonly merge_sha: string;
    readonly artifact_run_id: string | null;
    readonly artifact_name: string | null;
    readonly artifact_digest: string | null;
  }
): boolean {
  const evidence = parseStoredJson(stored);
  if (!evidence) return false;
  return (
    evidence.base_sha === current.base_sha &&
    evidence.merge_sha === current.merge_sha &&
    (evidence.artifact_run_id === null ||
      (evidence.artifact_run_id === current.artifact_run_id &&
        evidence.artifact_name === current.artifact_name &&
        evidence.artifact_digest === current.artifact_digest))
  );
}

function candidateRegistrationStatus(candidate: ReleaseBusV2CandidateRecord): {
  readonly state: 'failure' | 'pending' | 'success';
  readonly description: string;
} {
  if (candidate.status === 'PRODUCTION_DEPLOYED')
    return {
      state: 'success',
      description: 'Exact v2 production deployment completed'
    };
  if (candidate.status === 'STAGING_VALIDATED')
    return {
      state: 'success',
      description: 'Exact v2 staging manifest validated; production is explicit'
    };
  if (['FAILED', 'NEEDS_REBASE'].includes(candidate.status))
    return {
      state: 'failure',
      description:
        candidate.status === 'NEEDS_REBASE'
          ? 'Exact v2 composition requires rebase'
          : 'Release Bus v2 candidate failed; see Deploy UI'
    };
  if (['SUPERSEDED', 'CANCELLED'].includes(candidate.status))
    return {
      state: 'success',
      description: `v2 readiness ${candidate.status.toLowerCase()}`
    };
  return {
    state: 'pending',
    description:
      candidate.status === 'READY_FOR_STAGING'
        ? 'Ready for v2 staging'
        : `Release Bus v2: ${candidate.status.replace(/_/g, ' ').toLowerCase()}`
  };
}

export class ReleaseBusV2Service {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository
  ) {}

  public async register(
    input: ReleaseBusV2RegisterInput,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const mode = getReleaseBusV2Mode();
    const betaAllowlist = mode === 'OFF' ? getReleaseBusV2BetaAllowlist() : [];
    const isBetaRegistration =
      mode === 'OFF' &&
      releaseBusV2BetaAllowsRegistration(betaAllowlist, input, actor);
    if (!releaseBusV2AllowsLane(mode, 'STAGING') && !isBetaRegistration)
      throw new Error('Release Bus v2 staging readiness is disabled');
    if (mode !== 'OFF' && input.candidate_id)
      throw new Error('Explicit candidate ids are reserved for the OFF beta');
    if (
      isBetaRegistration &&
      input.dependencies.some(
        ({ candidate_id }) =>
          !betaAllowlist.some(
            (entry) => entry.candidate_id === candidate_id.toLowerCase()
          )
      )
    )
      throw new Error('Beta dependencies must be explicitly allowlisted');
    await this.assertScopeRunning('STAGING');
    if (!/^[A-Za-z0-9._/-]{1,255}$/.test(input.branch_name))
      throw new Error('Invalid branch name');
    const expectedHeadSha = input.expected_head_sha.toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(expectedHeadSha))
      throw new Error('expected_head_sha must be a 40-character Git SHA');
    if (!Number.isSafeInteger(input.pr_number) || input.pr_number < 1)
      throw new Error('pr_number must be a positive integer');
    const deployPlan = normalizeDeployPlan(input.repository, input.deploy_plan);
    const resolvedHead = await releaseBusGitHubApp.resolveRef(
      input.repository,
      input.branch_name
    );
    if (resolvedHead !== expectedHeadSha)
      throw new Error(
        `Branch moved from ${expectedHeadSha} to ${resolvedHead}`
      );
    const qualification = await releaseBusGitHubApp.getPullRequestQualification(
      input.repository,
      input.pr_number,
      expectedHeadSha
    );
    const evidence = {
      base_sha: qualification.baseSha,
      merge_sha: qualification.mergeSha,
      checks_run_id: qualification.checksRunId,
      checks_completed_at: qualification.checksCompletedAt,
      artifact_run_id: qualification.artifactRunId,
      artifact_name: qualification.artifactName,
      artifact_digest: qualification.artifactDigest
    };
    const registration =
      await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { connection };
          const superseded = isBetaRegistration
            ? []
            : await this.repository.supersedeOtherPrHeads(
                input.repository,
                input.pr_number,
                expectedHeadSha,
                ctx
              );
          const betaCandidateId = isBetaRegistration
            ? input.candidate_id?.toLowerCase()
            : undefined;
          const existingBetaCandidate = betaCandidateId
            ? await this.repository.findCandidateById(betaCandidateId, ctx)
            : null;
          if (
            existingBetaCandidate &&
            (existingBetaCandidate.repository !== input.repository ||
              existingBetaCandidate.pr_number !== input.pr_number ||
              existingBetaCandidate.branch_name !== input.branch_name ||
              existingBetaCandidate.head_sha !== expectedHeadSha)
          )
            throw new Error(
              'The beta candidate id is immutable and cannot be reused for a different identity or head SHA'
            );
          let candidate =
            existingBetaCandidate ??
            (await this.repository.findCandidateByIdentity(
              input.repository,
              input.pr_number,
              expectedHeadSha,
              ctx
            ));
          let created = false;
          if (!candidate) {
            candidate = await this.repository.createCandidate(
              {
                candidateId: betaCandidateId,
                repository: input.repository,
                prNumber: input.pr_number,
                branchName: input.branch_name,
                headSha: expectedHeadSha,
                requestedBy: actor,
                deployPlan,
                prEvidence: evidence
              },
              ctx
            );
            created = true;
          } else {
            if (
              isBetaRegistration &&
              candidate.id !== input.candidate_id?.toLowerCase()
            )
              throw new Error(
                'The exact beta identity already has a different candidate id'
              );
            const existingDependencies = await this.repository.listDependencies(
              [candidate.id],
              ctx
            );
            const requestedDependencies = input.dependencies
              .map(
                (dependency) =>
                  `${dependency.candidate_id}:${dependency.environment}`
              )
              .sort((left, right) => left.localeCompare(right));
            const storedDependencies = existingDependencies
              .map(
                (dependency) =>
                  `${dependency.prerequisite_candidate_id}:${dependency.environment}`
              )
              .sort((left, right) => left.localeCompare(right));
            if (
              candidate.branch_name !== input.branch_name ||
              !isDeepStrictEqual(
                parseStoredJson(candidate.deploy_plan_json),
                deployPlan
              ) ||
              !sameQualificationIdentity(
                candidate.pr_evidence_json,
                evidence
              ) ||
              !isDeepStrictEqual(storedDependencies, requestedDependencies)
            )
              throw new Error(
                'The exact candidate identity was reused with different immutable registration data'
              );
          }
          for (const dependency of input.dependencies) {
            const prerequisite = await this.repository.findCandidateById(
              dependency.candidate_id,
              ctx
            );
            if (!prerequisite)
              throw new Error(
                `Dependency ${dependency.candidate_id} does not exist`
              );
            if (prerequisite.id === candidate.id)
              throw new Error('A candidate cannot depend on itself');
            if (
              candidate.repository === 'backend' &&
              prerequisite.repository === 'frontend'
            )
              throw new Error(
                'Backend candidates cannot depend on frontend-first deployment'
              );
            await this.repository.addDependency(
              candidate.id,
              prerequisite.id,
              dependency.environment,
              ctx
            );
          }
          await this.assertAcyclic(ctx);
          if (created)
            await this.repository.appendEvent(
              {
                candidateId: candidate.id,
                eventType: 'CANDIDATE_READY_FOR_STAGING',
                actor,
                payload: {
                  repository: candidate.repository,
                  pr_number: candidate.pr_number,
                  head_sha: candidate.head_sha,
                  operator_beta: isBetaRegistration,
                  beta_test_id: isBetaRegistration
                    ? // Config validation requires one shared test_id.
                      betaAllowlist[0]?.test_id
                    : null
                }
              },
              ctx
            );
          return { candidate, superseded };
        }
      );
    await Promise.all(
      registration.superseded.map((superseded) =>
        releaseBusGitHubApp.ensureCommitStatus(
          superseded.repository,
          superseded.head_sha,
          'success',
          'Superseded by a newer exact PR head',
          'Release Bus v2'
        )
      )
    );
    const published = candidateRegistrationStatus(registration.candidate);
    await releaseBusGitHubApp.ensureCommitStatus(
      registration.candidate.repository,
      registration.candidate.head_sha,
      published.state,
      published.description,
      'Release Bus v2'
    );
    return registration.candidate;
  }

  public async markReadyForProduction(
    candidateId: string,
    expectedHeadSha: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const mode = getReleaseBusV2Mode();
    const snapshot = await this.repository.findCandidateById(candidateId, {});
    if (!snapshot) throw new Error('Candidate not found');
    const betaAllowlist =
      mode === 'OFF' || mode === 'STAGING'
        ? getReleaseBusV2BetaAllowlist()
        : [];
    const isBetaPromotion =
      releaseBusV2BetaAllowsLaneInMode(mode, betaAllowlist, 'PRODUCTION') &&
      releaseBusV2BetaAllowsCandidate(betaAllowlist, snapshot, 'PRODUCTION') &&
      snapshot.requested_by.toLowerCase() === actor.toLowerCase();
    if (!releaseBusV2AllowsLane(mode, 'PRODUCTION') && !isBetaPromotion)
      throw new Error('Release Bus v2 production readiness is disabled');
    await this.assertScopeRunning('PRODUCTION');
    if (snapshot.row_version !== expectedRowVersion)
      throw new Error(
        'Candidate changed; refresh before marking production ready'
      );
    if (snapshot.status !== 'STAGING_VALIDATED')
      throw new Error('The exact candidate SHA is not staging validated');
    if (snapshot.head_sha !== expectedHeadSha.toLowerCase())
      throw new Error('Requested production SHA does not match the candidate');
    const currentHead = await releaseBusGitHubApp.resolveRef(
      snapshot.repository,
      snapshot.branch_name
    );
    if (currentHead !== snapshot.head_sha)
      throw new Error('Candidate branch moved after staging validation');
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Candidate not found');
        if (candidate.row_version !== expectedRowVersion)
          throw new Error(
            'Candidate changed; refresh before marking production ready'
          );
        if (
          candidate.status !== 'STAGING_VALIDATED' ||
          !candidate.staging_validated_manifest_id
        )
          throw new Error('The exact candidate SHA is not staging validated');
        if (candidate.head_sha !== expectedHeadSha.toLowerCase())
          throw new Error(
            'Requested production SHA does not match the candidate'
          );
        if (candidate.head_sha !== currentHead)
          throw new Error('Candidate changed after branch verification');
        const now = Date.now();
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: 'READY_FOR_PRODUCTION',
              productionRequestedAt: now,
              productionRequestedBy: actor
            },
            ctx
          ))
        )
          throw new Error('Candidate changed concurrently');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: 'CANDIDATE_READY_FOR_PRODUCTION',
            actor,
            payload: {
              head_sha: candidate.head_sha,
              staging_manifest_id: candidate.staging_validated_manifest_id
            }
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after production readiness');
        return updated;
      }
    );
  }

  public async revokeProductionReadiness(
    candidateId: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Candidate not found');
        if (candidate.row_version !== expectedRowVersion)
          throw new Error(
            'Candidate changed; refresh before revoking readiness'
          );
        if (candidate.status !== 'READY_FOR_PRODUCTION')
          throw new Error(
            'Production readiness can be revoked only before claim'
          );
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            { status: 'STAGING_VALIDATED' },
            ctx
          ))
        )
          throw new Error('Candidate changed concurrently');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: 'CANDIDATE_PRODUCTION_READINESS_REVOKED',
            actor
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after readiness revocation');
        return updated;
      }
    );
  }

  public async cancel(
    candidateId: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const cancelled = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Candidate not found');
        if (candidate.row_version !== expectedRowVersion)
          throw new Error('Candidate changed; refresh before cancelling');
        if (
          ![
            'READY_FOR_STAGING',
            'WAITING_FOR_DEPENDENCY',
            'READY_FOR_PRODUCTION',
            'NEEDS_REBASE'
          ].includes(candidate.status)
        )
          throw new Error('Candidate can no longer be cancelled safely');
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            { status: 'CANCELLED' },
            ctx
          ))
        )
          throw new Error('Candidate changed concurrently');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: 'CANDIDATE_CANCELLED',
            actor
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after cancellation');
        return updated;
      }
    );
    await releaseBusGitHubApp.ensureCommitStatus(
      cancelled.repository,
      cancelled.head_sha,
      'success',
      'v2 readiness cancelled',
      'Release Bus v2'
    );
    return cancelled;
  }

  public async invalidateBranch(
    repository: ReleaseBusV2Repository,
    branchName: string,
    currentHeadSha: string,
    actor: string
  ): Promise<void> {
    const superseded = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const changed = await this.repository.supersedeMovedBranchHeads(
          repository,
          branchName,
          currentHeadSha,
          ctx
        );
        for (const candidate of changed)
          await this.repository.appendEvent(
            {
              candidateId: candidate.id,
              eventType: 'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE',
              actor,
              payload: {
                previous_head_sha: candidate.head_sha,
                current_head_sha: currentHeadSha
              }
            },
            ctx
          );
        return changed;
      }
    );
    await Promise.all(
      superseded.map((candidate) =>
        releaseBusGitHubApp.ensureCommitStatus(
          candidate.repository,
          candidate.head_sha,
          'success',
          'Superseded because the exact branch head moved',
          'Release Bus v2'
        )
      )
    );
  }

  public async claimLane(
    lane: ReleaseBusV2Lane,
    frontendBaseSha: string,
    backendBaseSha: string,
    owner: string
  ): Promise<ReleaseBusV2TrainRecord | null> {
    const mode = getReleaseBusV2Mode();
    const scope = laneScope(lane);
    const betaAllowlist =
      mode === 'OFF' || (mode === 'STAGING' && lane === 'PRODUCTION')
        ? getReleaseBusV2BetaAllowlist()
        : [];
    const betaLaneEnabled = releaseBusV2BetaAllowsLaneInMode(
      mode,
      betaAllowlist,
      lane
    );
    if (!releaseBusV2AllowsLane(mode, scope) && !betaLaneEnabled) return null;
    await this.assertScopeRunning(scope);
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const scheduler = await this.repository.acquireLock(
          'scheduler',
          null,
          owner,
          RELEASE_BUS_V2_LOCK_TTL_MS,
          ctx
        );
        if (!scheduler?.lease_token) return null;
        try {
          await this.refreshDependencyHolds(lane, ctx, betaAllowlist);
          const active = (await this.repository.listTrains(100, ctx)).find(
            (train) =>
              train.lane === lane && !TERMINAL_TRAIN_STATUSES.has(train.status)
          );
          if (active) {
            if (!betaLaneEnabled) return active;
            return (await this.isBetaTrainAllowed(active, betaAllowlist, ctx))
              ? active
              : null;
          }
          const candidates = (
            await this.repository.listCandidates(
              [readyStatus(lane)],
              RELEASE_BUS_V2_MAX_CANDIDATES,
              ctx
            )
          ).filter(
            (candidate) =>
              !betaLaneEnabled ||
              releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
          );
          if (candidates.length === 0) return null;
          const dependencies = await this.repository.listDependencies(
            candidates.map((candidate) => candidate.id),
            ctx
          );
          const eligible = await this.selectDependencyClosedCandidates(
            candidates,
            dependencies,
            lane,
            ctx,
            betaAllowlist
          );
          if (eligible.length === 0) return null;
          const order = topologicalOrder(
            eligible.map((candidate) => candidate.id),
            dependencies
              .filter((dependency) =>
                eligible.some(
                  (candidate) => candidate.id === dependency.candidate_id
                )
              )
              .filter((dependency) =>
                eligible.some(
                  (candidate) =>
                    candidate.id === dependency.prerequisite_candidate_id
                )
              )
              .map(
                (dependency) =>
                  [
                    dependency.prerequisite_candidate_id,
                    dependency.candidate_id
                  ] as const
              )
          );
          const train = await this.repository.createTrain(
            { lane, frontendBaseSha, backendBaseSha, candidateIds: order },
            ctx
          );
          const byId = new Map(
            eligible.map((candidate) => [candidate.id, candidate])
          );
          for (const candidateId of order) {
            const candidate = byId.get(candidateId);
            if (!candidate) continue;
            if (
              !(await this.repository.updateCandidate(
                candidate.id,
                candidate.row_version,
                { status: claimedStatus(lane), currentTrainId: train.id },
                ctx
              ))
            )
              throw new Error(`Candidate ${candidate.id} changed during claim`);
          }
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'TRAIN_CLAIMED',
              payload: {
                lane,
                candidate_ids: order,
                operator_beta: betaLaneEnabled,
                // Config validation requires one shared test_id.
                beta_test_id: betaLaneEnabled ? betaAllowlist[0]?.test_id : null
              }
            },
            ctx
          );
          return train;
        } finally {
          await this.repository.releaseLock(
            'scheduler',
            scheduler.lease_token,
            ctx
          );
        }
      }
    );
  }

  public async setPaused(
    scope: ReleaseBusV2ControlScope,
    paused: boolean,
    reason: string,
    actor: string
  ): Promise<void> {
    await this.repository.setControl(scope, paused, reason, actor, {});
    await this.repository.appendEvent(
      {
        eventType: paused ? 'BUS_PAUSED' : 'BUS_RESUMED',
        actor,
        payload: { scope, reason }
      },
      {}
    );
  }

  public async isBetaTrainAllowed(
    train: ReleaseBusV2TrainRecord,
    allowlist: readonly ReleaseBusV2BetaEntry[] = getReleaseBusV2BetaAllowlist(),
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const memberships = await this.repository.listTrainCandidates(
      train.id,
      ctx
    );
    if (memberships.length === 0) return false;
    const candidates = await Promise.all(
      memberships.map(({ candidate_id }) =>
        this.repository.findCandidateById(candidate_id, ctx)
      )
    );
    return candidates.every(
      (candidate) =>
        candidate !== null &&
        releaseBusV2BetaAllowsCandidate(allowlist, candidate, train.lane)
    );
  }

  private async assertScopeRunning(
    scope: 'STAGING' | 'PRODUCTION'
  ): Promise<void> {
    const controls = await this.repository.listControls({});
    const paused =
      controls.find(
        (control) => control.scope === 'ALL' && Boolean(control.paused)
      ) ??
      controls.find(
        (control) => control.scope === scope && Boolean(control.paused)
      );
    if (paused)
      throw new Error(
        `${paused.scope} is paused: ${paused.reason ?? 'No reason recorded'}`
      );
  }

  private async assertAcyclic(ctx: RequestContext): Promise<void> {
    const candidates = await this.repository.listCandidates(
      [
        'READY_FOR_STAGING',
        'WAITING_FOR_DEPENDENCY',
        'STAGING_IN_TRAIN',
        'STAGING_BUILDING',
        'STAGING_DEPLOYING',
        'STAGING_DEPLOYED',
        'STAGING_VALIDATING',
        'STAGING_VALIDATED',
        'READY_FOR_PRODUCTION',
        'PRODUCTION_IN_TRAIN',
        'PRODUCTION_BUILDING_OR_QUALIFYING',
        'PRODUCTION_DEPLOYING',
        'PRODUCTION_DEPLOYED'
      ],
      500,
      ctx
    );
    const ids = candidates.map((candidate) => candidate.id);
    const dependencies = await this.repository.listDependencies(ids, ctx);
    topologicalOrder(
      ids,
      dependencies.map(
        (dependency) =>
          [
            dependency.prerequisite_candidate_id,
            dependency.candidate_id
          ] as const
      )
    );
  }

  private async selectDependencyClosedCandidates(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    dependencies: readonly ReleaseBusV2DependencyRecord[],
    lane: ReleaseBusV2Lane,
    ctx: RequestContext,
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = []
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    );
    const eligible = new Set(candidates.map((candidate) => candidate.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const dependency of dependencies) {
        if (!eligible.has(dependency.candidate_id)) continue;
        if (lane === 'STAGING' && dependency.environment === 'PRODUCTION')
          continue;
        if (lane === 'PRODUCTION' && dependency.environment === 'STAGING')
          continue;
        if (
          betaAllowlist.length > 0 &&
          !betaAllowlist.some(
            (entry) =>
              entry.candidate_id === dependency.prerequisite_candidate_id &&
              releaseBusV2BetaAllowsLane([entry], lane)
          )
        ) {
          eligible.delete(dependency.candidate_id);
          changed = true;
          continue;
        }
        const prerequisiteInBatch = eligible.has(
          dependency.prerequisite_candidate_id
        );
        const prerequisite = await this.repository.findCandidateById(
          dependency.prerequisite_candidate_id,
          ctx
        );
        const alreadySatisfied =
          lane === 'PRODUCTION'
            ? prerequisite?.status === 'PRODUCTION_DEPLOYED'
            : [
                'STAGING_VALIDATED',
                'READY_FOR_PRODUCTION',
                'PRODUCTION_IN_TRAIN',
                'PRODUCTION_DEPLOYED'
              ].includes(prerequisite?.status ?? '');
        if (!prerequisiteInBatch && !alreadySatisfied) {
          eligible.delete(dependency.candidate_id);
          changed = true;
        }
      }
    }
    for (const candidate of candidates) {
      if (eligible.has(candidate.id)) continue;
      await this.repository.updateCandidate(
        candidate.id,
        candidate.row_version,
        {
          status: 'WAITING_FOR_DEPENDENCY',
          holdReason: `Waiting for ${lane.toLowerCase()} dependency`
        },
        ctx
      );
    }
    return Array.from(eligible)
      .map((id) => byId.get(id))
      .filter((candidate): candidate is ReleaseBusV2CandidateRecord =>
        Boolean(candidate)
      );
  }

  private async refreshDependencyHolds(
    lane: ReleaseBusV2Lane,
    ctx: RequestContext,
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = []
  ): Promise<void> {
    const waiting = await this.repository.listCandidates(
      ['WAITING_FOR_DEPENDENCY'],
      RELEASE_BUS_V2_MAX_CANDIDATES,
      ctx
    );
    const laneWaiting = waiting
      .filter(
        (candidate) =>
          betaAllowlist.length === 0 ||
          releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
      )
      .filter((candidate) =>
        lane === 'PRODUCTION'
          ? candidate.production_requested_at !== null
          : candidate.production_requested_at === null
      );
    if (laneWaiting.length === 0) return;
    const dependencies = await this.repository.listDependencies(
      laneWaiting.map((candidate) => candidate.id),
      ctx
    );
    for (const candidate of laneWaiting) {
      const required = dependencies.filter((dependency) => {
        if (dependency.candidate_id !== candidate.id) return false;
        if (lane === 'STAGING') return dependency.environment !== 'PRODUCTION';
        return dependency.environment !== 'STAGING';
      });
      let satisfied = true;
      for (const dependency of required) {
        if (
          betaAllowlist.length > 0 &&
          !betaAllowlist.some(
            (entry) =>
              entry.candidate_id === dependency.prerequisite_candidate_id &&
              releaseBusV2BetaAllowsLane([entry], lane)
          )
        ) {
          satisfied = false;
          break;
        }
        const prerequisite = await this.repository.findCandidateById(
          dependency.prerequisite_candidate_id,
          ctx
        );
        const dependencySatisfied =
          lane === 'PRODUCTION'
            ? prerequisite?.status === 'PRODUCTION_DEPLOYED'
            : [
                'STAGING_VALIDATED',
                'READY_FOR_PRODUCTION',
                'PRODUCTION_IN_TRAIN',
                'PRODUCTION_DEPLOYED'
              ].includes(prerequisite?.status ?? '');
        if (!dependencySatisfied) {
          satisfied = false;
          break;
        }
      }
      if (!satisfied) continue;
      await this.repository.updateCandidate(
        candidate.id,
        candidate.row_version,
        {
          status:
            lane === 'PRODUCTION'
              ? 'READY_FOR_PRODUCTION'
              : 'READY_FOR_STAGING',
          holdReason: null
        },
        ctx
      );
    }
  }
}

export function storedDeployPlan(
  candidate: ReleaseBusV2CandidateRecord
): ReleaseBusV2DeployPlan | null {
  return parseStoredJson(candidate.deploy_plan_json);
}

export const releaseBusV2Service = new ReleaseBusV2Service();
