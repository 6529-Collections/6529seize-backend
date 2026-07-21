import { topologicallySort } from '@/releaseBus/release-bus.dag';
import deployConfig from '@/config/deploy-services.json';
import { buildReleaseOperationKey } from '@/releaseBus/release-bus.idempotency';
import {
  getReleaseBusMode,
  RELEASE_BUS_LANE_TTL_MS
} from '@/releaseBus/release-bus.config';
import { releaseBusGitHubApp } from '@/releaseBus/release-bus.github-app';
import {
  releaseBusRepository,
  type ReleaseOperationRecord
} from '@/releaseBus/release-bus.repository';
import type {
  ReleaseCandidateRecord,
  ReleaseDeployPlan,
  ReleaseRepository,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';
import { publishReleaseBusMetrics } from '@/releaseBus/release-bus.metrics';

export type WorkerDecision = 'WAIT' | 'CONTINUE' | 'COMPLETE' | 'FAILED';
export type WorkerResult = {
  readonly decision: WorkerDecision;
  readonly train_id: string;
  readonly status: string;
  readonly message?: string;
};

class TerminalReleaseTrainError extends Error {}

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

async function loadTrain(trainId: string) {
  const train = await releaseBusRepository.findTrain(trainId, {});
  if (!train) throw new Error(`Release train ${trainId} not found`);
  const items = await releaseBusRepository.listTrainItems(trainId, {});
  // Promise.all preserves the train-item sequence. Filtering that array by
  // repository later therefore produces the exact candidate_shas order sent
  // to each compose workflow.
  const candidates = (
    await Promise.all(
      items.map((item) =>
        releaseBusRepository.findCandidateById(item.candidate_id, {})
      )
    )
  ).filter(
    (candidate): candidate is ReleaseCandidateRecord => candidate !== null
  );
  return { train, candidates };
}

function repositories(
  candidates: readonly ReleaseCandidateRecord[]
): ReleaseRepository[] {
  return (['backend', 'frontend'] as const).filter((repository) =>
    candidates.some((candidate) => candidate.repository === repository)
  );
}

function trainBranch(train: ReleaseTrainRecord): string {
  return `release-bus/${train.target_lane.toLowerCase()}-train-${train.id}-r${train.revision}`;
}

function workflowResult(
  operation: ReleaseOperationRecord
): 'PASS' | 'WAIT' | 'FAIL' {
  if (operation.status === 'SUCCEEDED') return 'PASS';
  if (['FAILED', 'CANCELLED'].includes(operation.status)) return 'FAIL';
  return 'WAIT';
}

function githubActionsRunUrl(operation: ReleaseOperationRecord): string | null {
  const result = metadata(operation.result_metadata_json);
  const url = result.url;
  if (
    typeof url === 'string' &&
    /^https:\/\/github\.com\/6529-Collections\/6529seize-(?:frontend|backend)\/actions\/runs\/[0-9]+$/.test(
      url
    )
  )
    return url;
  return null;
}

export function operationFailureReason(
  reason: string,
  operation: ReleaseOperationRecord
): string {
  const evidenceUrl = githubActionsRunUrl(operation);
  return evidenceUrl ? `${reason} Evidence: ${evidenceUrl}` : reason;
}

async function dispatchWorkflow(params: {
  readonly train: ReleaseTrainRecord;
  readonly repository: ReleaseRepository;
  readonly operationType: string;
  readonly workflow: string;
  readonly ref: string;
  readonly expectedSha: string;
  readonly environment?: 'orchestration' | 'staging' | 'prod' | null;
  readonly service?: string | null;
  readonly inputs: Record<string, string>;
}): Promise<ReleaseOperationRecord> {
  const operationKey = buildReleaseOperationKey({
    trainId: params.train.id,
    revision: params.train.revision,
    operation: params.operationType,
    repository: params.repository,
    environment: params.environment ?? undefined,
    service: params.service ?? undefined,
    expectedSha: params.expectedSha
  });
  let operation = await releaseBusRepository.getOrCreateOperation(
    {
      operation_key: operationKey,
      train_id: params.train.id,
      revision: params.train.revision,
      operation_type: params.operationType,
      repository: params.repository,
      environment: params.environment ?? null,
      service: params.service ?? null,
      expected_sha: params.expectedSha,
      artifact_digest: null,
      attempt: 1,
      status: 'PENDING',
      external_id: null,
      request_metadata_json: {
        workflow: params.workflow,
        ref: params.ref,
        inputs: params.inputs
      },
      result_metadata_json: null,
      started_at: null,
      completed_at: null
    },
    {}
  );
  if (operation.status === 'PENDING') {
    const existingRun = await releaseBusGitHubApp.findWorkflowRun(
      params.repository,
      params.workflow,
      operationKey
    );
    if (existingRun) {
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'DISPATCHED', externalId: String(existingRun.id) },
        {}
      );
    } else {
      try {
        await releaseBusGitHubApp.dispatchWorkflow(
          params.repository,
          params.workflow,
          params.ref,
          {
            ...params.inputs,
            operation_key: operationKey,
            release_train_id: params.train.id,
            release_train_revision: String(params.train.revision),
            expected_sha: params.expectedSha
          }
        );
        await releaseBusRepository.updateOperation(
          operationKey,
          { status: 'DISPATCHED' },
          {}
        );
      } catch (error) {
        await releaseBusRepository.updateOperation(
          operationKey,
          {
            status: 'AMBIGUOUS',
            resultMetadata: {
              message:
                error instanceof Error ? error.message : 'dispatch failed'
            }
          },
          {}
        );
      }
    }
    operation = (await releaseBusRepository.findOperation(
      operationKey,
      {}
    )) as ReleaseOperationRecord;
  }
  return operation;
}

async function reconcile(
  operation: ReleaseOperationRecord
): Promise<ReleaseOperationRecord> {
  if (!['DISPATCHED', 'RUNNING', 'AMBIGUOUS'].includes(operation.status))
    return operation;
  const request = metadata(operation.request_metadata_json);
  const repository = operation.repository as ReleaseRepository;
  const run = await releaseBusGitHubApp.findWorkflowRun(
    repository,
    String(request.workflow),
    operation.operation_key,
    operation.external_id
  );
  if (!run) return operation;
  if (run.status !== 'completed') {
    await releaseBusRepository.updateOperation(
      operation.operation_key,
      {
        status: 'RUNNING',
        externalId: String(run.id),
        resultMetadata: { url: run.html_url }
      },
      {}
    );
  } else if (run.conclusion === 'success') {
    await releaseBusRepository.updateOperation(
      operation.operation_key,
      {
        status: 'SUCCEEDED',
        externalId: String(run.id),
        resultMetadata: { url: run.html_url, head_sha: run.head_sha },
        completedAt: Date.now()
      },
      {}
    );
  } else {
    await releaseBusRepository.updateOperation(
      operation.operation_key,
      {
        status: 'FAILED',
        externalId: String(run.id),
        resultMetadata: { url: run.html_url, conclusion: run.conclusion },
        completedAt: Date.now()
      },
      {}
    );
  }
  return (await releaseBusRepository.findOperation(
    operation.operation_key,
    {}
  )) as ReleaseOperationRecord;
}

async function phaseOperations(
  trainId: string,
  prefix: string
): Promise<ReleaseOperationRecord[]> {
  return (await releaseBusRepository.listTrainOperations(trainId, {})).filter(
    (operation) => operation.operation_type.startsWith(prefix)
  );
}

async function pollPhase(
  train: ReleaseTrainRecord,
  prefix: string
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  const operations = await phaseOperations(train.id, prefix);
  if (operations.length === 0) return 'WAIT';
  const reconciled = await Promise.all(operations.map(reconcile));
  if (reconciled.some((operation) => workflowResult(operation) === 'FAIL'))
    return 'FAIL';
  return reconciled.every((operation) => workflowResult(operation) === 'PASS')
    ? 'PASS'
    : 'WAIT';
}

async function beginComposition(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  const branch = trainBranch(train);
  for (const repository of repositories(candidates)) {
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha)
      throw new TerminalReleaseTrainError(`Missing ${repository} base SHA`);
    const shas = candidates
      .filter((candidate) => candidate.repository === repository)
      .map((candidate) => candidate.head_sha);
    await dispatchWorkflow({
      train,
      repository,
      operationType: `compose-${repository}`,
      workflow: 'release-bus-compose.yml',
      ref: 'main',
      expectedSha: baseSha,
      environment: 'orchestration',
      inputs: {
        target_lane: train.target_lane,
        base_sha: baseSha,
        candidate_shas: JSON.stringify(shas),
        release_branch: branch
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'COMPOSING',
      frontendReleaseBranch: candidates.some(
        (candidate) => candidate.repository === 'frontend'
      )
        ? branch
        : null,
      backendReleaseBranch: candidates.some(
        (candidate) => candidate.repository === 'backend'
      )
        ? branch
        : null
    },
    {}
  );
}

async function advanceFrontendBaseCanary(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  if (!candidates.some((candidate) => candidate.repository === 'frontend'))
    return 'PASS';
  const baseSha = train.frontend_base_sha;
  if (!baseSha)
    throw new TerminalReleaseTrainError('Missing frontend base SHA');
  const existingOperations = await phaseOperations(
    train.id,
    'base-canary-frontend'
  );
  if (existingOperations.length > 1)
    throw new TerminalReleaseTrainError(
      `Release train ${train.id} has multiple frontend base canary operations`
    );
  const existing = existingOperations[0];
  if (existing) {
    const operation = await reconcile(existing);
    const result = workflowResult(operation);
    if (result !== 'FAIL') return result;
    await failAndPauseTrain(
      train,
      candidates,
      operationFailureReason(
        'The fresh frontend base failed its exact Release Bus canary; candidates were not blamed.',
        operation
      ),
      'REQUEUE'
    );
    return 'FAIL';
  }
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: 'base-canary-frontend',
    workflow: 'release-bus-base-canary.yml',
    ref: 'main',
    expectedSha: baseSha,
    environment: 'orchestration',
    inputs: { base_sha: baseSha }
  });
  return 'WAIT';
}

async function beginPreflight(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  for (const repository of repositories(candidates)) {
    const branch = trainBranch(train);
    const sha = await releaseBusGitHubApp.resolveRef(repository, branch);
    const units = repository === 'backend' ? backendUnits(candidates) : [];
    await dispatchWorkflow({
      train,
      repository,
      operationType: `preflight-${repository}`,
      workflow: 'release-bus-preflight.yml',
      ref: 'main',
      expectedSha: sha,
      environment: 'orchestration',
      inputs: {
        target_lane: train.target_lane,
        release_branch: branch,
        deploy_units: JSON.stringify(units)
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'PREFLIGHTING' },
    {}
  );
}

function parsePlan(
  candidate: ReleaseCandidateRecord
): ReleaseDeployPlan | null {
  const value = candidate.deploy_plan_json;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ReleaseDeployPlan;
    } catch {
      return null;
    }
  }
  return value;
}

function backendUnits(
  candidates: readonly ReleaseCandidateRecord[],
  environment?: 'staging' | 'prod'
): string[] {
  const plans = candidates
    .filter((candidate) => candidate.repository === 'backend')
    .map(parsePlan)
    .filter((plan): plan is ReleaseDeployPlan => Boolean(plan));
  const requestedUnits = Array.from(
    new Set(plans.flatMap((plan) => plan.units))
  );
  const units = environment
    ? requestedUnits.filter((unit) => {
        const service = deployConfig.services.find(
          (candidate) => candidate.name === unit
        );
        return service?.allowed_environments.includes(environment) ?? false;
      })
    : requestedUnits;
  const requested = new Set(units);
  const candidateEdges = plans
    .flatMap((plan) => plan.edges)
    .filter(([before, after]) => requested.has(before) && requested.has(after));
  const registryEdges = deployConfig.services.flatMap((service) =>
    service.default_dependencies
      .filter(
        (dependency) => requested.has(dependency) && requested.has(service.name)
      )
      .map((dependency) => [dependency, service.name] as [string, string])
  );
  return topologicallySort(units, [...registryEdges, ...candidateEdges]).order;
}

async function ensureLane(
  name: string,
  train: ReleaseTrainRecord
): Promise<boolean> {
  if (
    await releaseBusRepository.heartbeatLane(
      name,
      train.id,
      RELEASE_BUS_LANE_TTL_MS,
      {}
    )
  )
    return true;
  return Boolean(
    await releaseBusRepository.executeNativeQueriesInTransaction((connection) =>
      releaseBusRepository.acquireLane(
        name,
        train.id,
        `step-functions:${train.id}`,
        RELEASE_BUS_LANE_TTL_MS,
        { connection }
      )
    )
  );
}

async function externalDeploymentLaneBusy(
  environment: 'staging' | 'prod'
): Promise<boolean> {
  const states = await Promise.all(
    (['frontend', 'backend'] as const).map((repository) =>
      releaseBusGitHubApp.hasActiveDeploymentRun(repository, environment)
    )
  );
  return states.some(Boolean);
}

async function advanceBackendDeploy(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  environment: 'staging' | 'prod'
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  const units = backendUnits(candidates, environment);
  if (environment === 'prod' && units.length > 0 && !train.backend_pr_number) {
    throw new TerminalReleaseTrainError(
      `Missing backend release PR for production train ${train.id}`
    );
  }
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    const type = `deploy-backend-${environment}-${unit}`;
    const existing = (await phaseOperations(train.id, type))[0];
    if (existing) {
      const result = workflowResult(await reconcile(existing));
      if (result !== 'PASS') return result;
      continue;
    }
    const ref = environment === 'staging' ? trainBranch(train) : 'main';
    const sha = await releaseBusGitHubApp.resolveRef('backend', ref);
    await dispatchWorkflow({
      train,
      repository: 'backend',
      operationType: type,
      workflow: 'deploy.yml',
      ref: 'main',
      expectedSha: sha,
      environment,
      service: unit,
      inputs: {
        environment,
        service: unit,
        artifact_run_id: await preflightRunId(train.id, 'backend'),
        ...(environment === 'prod'
          ? {
              release_pull_request: String(train.backend_pr_number),
              release_note_publish: String(unitIndex === units.length - 1)
            }
          : {})
      }
    });
    return 'WAIT';
  }
  return 'PASS';
}

async function advanceFrontendDeploy(
  train: ReleaseTrainRecord,
  environment: 'staging' | 'prod'
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  if (!train.frontend_release_branch) return 'PASS';
  const type = `deploy-frontend-${environment}`;
  const existing = (await phaseOperations(train.id, type))[0];
  if (existing) return workflowResult(await reconcile(existing));
  const ref = environment === 'staging' ? trainBranch(train) : 'main';
  const sha = await releaseBusGitHubApp.resolveRef('frontend', ref);
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: type,
    workflow:
      environment === 'staging'
        ? 'release-bus-deploy-staging.yml'
        : 'release-bus-deploy-production.yml',
    ref: 'main',
    expectedSha: sha,
    environment,
    inputs: {
      source_ref: ref,
      artifact_run_id: await preflightRunId(train.id, 'frontend')
    }
  });
  return 'WAIT';
}

async function preflightRunId(
  trainId: string,
  repository: ReleaseRepository
): Promise<string> {
  const operation = (
    await releaseBusRepository.listTrainOperations(trainId, {})
  ).find(
    (candidate) =>
      candidate.operation_type === `preflight-${repository}` &&
      candidate.status === 'SUCCEEDED'
  );
  if (!operation?.external_id) {
    throw new TerminalReleaseTrainError(
      `Missing ${repository} preflight run for train ${trainId}`
    );
  }
  return operation.external_id;
}

async function beginFailureIsolation(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string
): Promise<void> {
  const dependencies = await releaseBusRepository.listDependencies(
    candidates.map((candidate) => candidate.id),
    {}
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const dependenciesByCandidate = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (!candidateIds.has(dependency.depends_on_candidate_id)) continue;
    const existing = dependenciesByCandidate.get(dependency.candidate_id) ?? [];
    existing.push(dependency.depends_on_candidate_id);
    dependenciesByCandidate.set(dependency.candidate_id, existing);
  }
  const dependencyClosure = (candidateId: string): Set<string> => {
    const closure = new Set<string>();
    const visit = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      for (const dependency of dependenciesByCandidate.get(id) ?? [])
        visit(dependency);
    };
    visit(candidateId);
    return closure;
  };

  for (const repository of repositories(candidates)) {
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) continue;
    const repositoryCandidates = candidates.filter(
      (candidate) => candidate.repository === repository
    );
    for (const variant of ['baseline', 'combined-retry'] as const) {
      const subset = variant === 'baseline' ? [] : repositoryCandidates;
      await dispatchWorkflow({
        train,
        repository,
        operationType: `isolate-${variant}-${repository}`,
        workflow: 'release-bus-isolate-candidate.yml',
        ref: 'main',
        expectedSha: baseSha,
        environment: 'orchestration',
        inputs: {
          base_sha: baseSha,
          candidate_id: `${variant}-${repository}`,
          candidate_shas: JSON.stringify(
            subset.map((candidate) => candidate.head_sha)
          ),
          deploy_units: JSON.stringify(
            backendUnits(variant === 'baseline' ? candidates : subset)
          ),
          failure_reason: reason.slice(0, 500)
        }
      });
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const closure = dependencyClosure(candidate.id);
    const subset = candidates.filter((item) => closure.has(item.id));
    const baseSha =
      candidate.repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) continue;
    await dispatchWorkflow({
      train,
      repository: candidate.repository,
      operationType: `isolate-candidate-${`000${index + 1}`.slice(-3)}-${candidate.id}`,
      workflow: 'release-bus-isolate-candidate.yml',
      ref: 'main',
      expectedSha: candidate.head_sha,
      environment: 'orchestration',
      inputs: {
        base_sha: baseSha,
        candidate_id: candidate.id,
        candidate_shas: JSON.stringify(
          subset
            .filter((item) => item.repository === candidate.repository)
            .map((item) => item.head_sha)
        ),
        deploy_units: JSON.stringify(backendUnits(subset)),
        failure_reason: reason.slice(0, 500)
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'ISOLATING_FAILURE', failureReason: reason },
    {}
  );
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_FAILURE_ISOLATION_STARTED',
      payload: { reason, candidate_ids: candidates.map((item) => item.id) }
    },
    {}
  );
}

async function releaseTrainLanes(train: ReleaseTrainRecord): Promise<void> {
  for (const laneName of [
    'global-production',
    'global-staging',
    'global-orchestration'
  ]) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token)
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
  }
}

async function publishCandidateStatus(
  train: ReleaseTrainRecord,
  candidate: ReleaseCandidateRecord,
  state: 'error' | 'failure' | 'pending' | 'success',
  description: string
): Promise<void> {
  try {
    await releaseBusGitHubApp.ensureCommitStatus(
      candidate.repository,
      candidate.head_sha,
      state,
      description
    );
  } catch (error) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        candidateId: candidate.id,
        eventType: 'CANDIDATE_COMMIT_STATUS_FAILED',
        payload: {
          state,
          message: error instanceof Error ? error.message : 'status failed'
        }
      },
      {}
    );
  }
}

export async function finishIncompleteComposition(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<ReleaseCandidateRecord | null> {
  const branch = trainBranch(train);
  let offender: ReleaseCandidateRecord | null = null;
  // Compose stops at the first conflict in the same train-item order used
  // here. Later missing candidates were not attempted: requeueing them cannot
  // repeat this conflict because the first offender is quarantined.
  for (const candidate of candidates) {
    if (
      !(await releaseBusGitHubApp.refContainsCommit(
        candidate.repository,
        branch,
        candidate.head_sha
      ))
    ) {
      offender = candidate;
      break;
    }
  }
  if (!offender) return null;

  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      !current ||
      !['STAGING_CLAIMED', 'PRODUCTION_CLAIMED'].includes(current.status)
    )
      continue;
    const isOffender = candidate.id === offender.id;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: isOffender ? 'QUARANTINED' : readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: isOffender ? 'MERGE_CONFLICT_REQUIRES_DEVELOPER' : null
      },
      {}
    );
  }

  await publishCandidateStatus(
    train,
    offender,
    'failure',
    `Merge conflict requires developer action (${train.id})`
  );
  if (offender.pr_number) {
    try {
      await releaseBusGitHubApp.commentOnPullRequest(
        offender.repository,
        offender.pr_number,
        [
          `Release Bus quarantined immutable candidate \`${offender.head_sha}\` after it conflicted with the fresh target and earlier candidates in train \`${train.id}\`.`,
          '',
          'Codex conflict resolution was unavailable or did not produce a complete composition. Other candidates were returned to the queue.',
          '',
          'Rebase or resolve the conflict, push the fix (which creates a new SHA), and mark that new SHA ready again.'
        ].join('\n')
      );
    } catch (error) {
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          candidateId: offender.id,
          eventType: 'CANDIDATE_COMPOSITION_COMMENT_FAILED',
          payload: {
            message: error instanceof Error ? error.message : 'comment failed'
          }
        },
        {}
      );
      await publishReleaseBusMetrics([
        {
          MetricName: 'CandidateNotificationFailure',
          Value: 1,
          Dimensions: [
            { Name: 'Lane', Value: train.target_lane },
            { Name: 'Channel', Value: 'PullRequestComment' }
          ]
        }
      ]);
    }
  }

  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'CANCELLED',
      failureReason: `Candidate ${offender.id} was not present in the composed release branch`,
      completedAt: Date.now()
    },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      candidateId: offender.id,
      eventType: 'CANDIDATE_QUARANTINED_BY_COMPOSITION',
      payload: {
        repository: offender.repository,
        head_sha: offender.head_sha,
        release_branch: branch
      }
    },
    {}
  );
  return offender;
}

async function failAndPauseTrain(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string,
  candidateDisposition: 'QUARANTINE' | 'REQUEUE' = 'QUARANTINE'
): Promise<void> {
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      !current ||
      ['QUARANTINED', 'CANCELLED', 'SUPERSEDED'].includes(current.status)
    )
      continue;
    if (
      ![
        'STAGING_CLAIMED',
        'STAGING_VALIDATING',
        'PRODUCTION_CLAIMED',
        'PRODUCTION_VALIDATING'
      ].includes(current.status)
    )
      continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status:
          candidateDisposition === 'QUARANTINE'
            ? 'QUARANTINED'
            : readyStatusForTrain(train),
        currentTrainId: null,
        holdReason:
          candidateDisposition === 'QUARANTINE'
            ? reason.slice(0, 500)
            : 'TRAIN_PAUSED_UNATTRIBUTED_FAILURE'
      },
      {}
    );
    await publishCandidateStatus(
      train,
      candidate,
      candidateDisposition === 'QUARANTINE' ? 'failure' : 'error',
      candidateDisposition === 'QUARANTINE'
        ? `Quarantined by release train ${train.id}`
        : `Release lane paused; candidate preserved (${train.id})`
    );
  }
  await releaseBusRepository.setControl(
    train.target_lane,
    true,
    reason.slice(0, 1000),
    'release-bus-worker',
    {}
  );
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'FAILED', failureReason: reason, completedAt: Date.now() },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_FAILED_AND_LANE_PAUSED',
      payload: { reason, candidate_disposition: candidateDisposition }
    },
    {}
  );
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainFailure',
      Value: 1,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    },
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    }
  ]);
}

async function finishFailureIsolation(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<'WAIT' | 'FAILED' | 'RETRY'> {
  const operations = (await phaseOperations(train.id, 'isolate-')).sort(
    (a, b) => a.operation_type.localeCompare(b.operation_type)
  );
  const repositoryCount = repositories(candidates).length;
  if (operations.length !== candidates.length + repositoryCount * 2)
    return 'WAIT';
  const reconciled: ReleaseOperationRecord[] = [];
  for (const operation of operations)
    reconciled.push(await reconcile(operation));
  if (reconciled.some((operation) => workflowResult(operation) === 'WAIT'))
    return 'WAIT';
  const baselineFailure = reconciled.find(
    (operation) =>
      operation.operation_type.startsWith('isolate-baseline-') &&
      workflowResult(operation) === 'FAIL'
  );
  if (baselineFailure) {
    await failAndPauseTrain(
      train,
      candidates,
      operationFailureReason(
        `The fresh ${baselineFailure.repository} base failed the isolation gate; candidates were not blamed.`,
        baselineFailure
      ),
      'REQUEUE'
    );
    return 'FAILED';
  }
  const candidateOperations = reconciled.filter((operation) =>
    operation.operation_type.startsWith('isolate-candidate-')
  );
  const firstFailedIndex = candidateOperations.findIndex(
    (operation) => workflowResult(operation) === 'FAIL'
  );
  if (firstFailedIndex < 0) {
    const combinedFailure = reconciled.find(
      (operation) =>
        operation.operation_type.startsWith('isolate-combined-retry-') &&
        workflowResult(operation) === 'FAIL'
    );
    if (combinedFailure) {
      await failAndPauseTrain(
        train,
        candidates,
        'Each dependency-closed candidate subset passed, but the combined train failed again. No single candidate can be safely ejected.',
        'REQUEUE'
      );
      return 'FAILED';
    }
    for (const candidate of candidates) {
      const current = await releaseBusRepository.findCandidateById(
        candidate.id,
        {}
      );
      if (!current) continue;
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        {
          status: readyStatusForTrain(train),
          currentTrainId: null,
          holdReason: 'RETRY_AFTER_TRANSIENT_GATE_FAILURE'
        },
        {}
      );
    }
    await releaseBusRepository.updateTrain(
      train.id,
      {
        status: 'CANCELLED',
        failureReason:
          'The combined gate passed on its bounded retry; candidates were returned for a fresh train.',
        completedAt: Date.now()
      },
      {}
    );
    await releaseTrainLanes(train);
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'TRAIN_REQUEUED_AFTER_TRANSIENT_FAILURE',
        payload: { candidate_ids: candidates.map((candidate) => candidate.id) }
      },
      {}
    );
    return 'RETRY';
  }
  const offender = candidates[firstFailedIndex];
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    const isOffender = candidate.id === offender.id;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: isOffender ? 'QUARANTINED' : readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: isOffender ? 'FAILED_DEPENDENCY_CLOSED_ISOLATION' : null
      },
      {}
    );
  }
  const operation = candidateOperations[firstFailedIndex];
  const result = metadata(operation.result_metadata_json);
  await publishCandidateStatus(
    train,
    offender,
    'failure',
    `Failed dependency-closed isolation (${train.id})`
  );
  if (offender.pr_number) {
    try {
      await releaseBusGitHubApp.commentOnPullRequest(
        offender.repository,
        offender.pr_number,
        [
          `Release Bus quarantined this immutable candidate \`${offender.head_sha}\`.`,
          '',
          `It was the first failing dependency-closed subset while isolating train \`${train.id}\`. Other candidates were returned to the queue.`,
          result.url ? `Diagnostic run: ${String(result.url)}` : '',
          '',
          'Push a fix (which creates a new SHA) and mark that new SHA ready again.'
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (error) {
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          candidateId: offender.id,
          eventType: 'CANDIDATE_QUARANTINE_COMMENT_FAILED',
          payload: {
            message: error instanceof Error ? error.message : 'comment failed'
          }
        },
        {}
      );
    }
  }
  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'FAILED',
      failureReason: `Candidate ${offender.id} failed deterministic dependency-closed isolation`,
      completedAt: Date.now()
    },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      candidateId: offender.id,
      eventType: 'CANDIDATE_QUARANTINED_BY_ISOLATION',
      payload: {
        operation_key: operation.operation_key,
        diagnostic_url: result.url ?? null
      }
    },
    {}
  );
  return 'FAILED';
}

function readyStatusForTrain(
  train: ReleaseTrainRecord
): 'READY_FOR_STAGING' | 'READY_FOR_PRODUCTION' {
  return train.target_lane === 'STAGING'
    ? 'READY_FOR_STAGING'
    : 'READY_FOR_PRODUCTION';
}

async function isTrainLanePaused(train: ReleaseTrainRecord): Promise<boolean> {
  const controls = await releaseBusRepository.listControls({});
  return controls.some(
    (control) =>
      Boolean(control.paused) &&
      (control.scope === 'ALL' || control.scope === train.target_lane)
  );
}

async function heartbeatOwnedTrainLanes(
  train: ReleaseTrainRecord
): Promise<void> {
  for (const laneName of [
    'global-orchestration',
    'global-staging',
    'global-production'
  ]) {
    await releaseBusRepository.heartbeatLane(
      laneName,
      train.id,
      RELEASE_BUS_LANE_TTL_MS,
      {}
    );
  }
}

async function advanceE2e(
  train: ReleaseTrainRecord,
  environment: 'staging' | 'prod'
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  const type = `e2e-${environment}`;
  const existing = (await phaseOperations(train.id, type))[0];
  if (existing) return workflowResult(await reconcile(existing));
  const ref = e2eSourceRef(
    train.frontend_release_branch,
    environment,
    trainBranch(train)
  );
  const sha = await releaseBusGitHubApp.resolveRef('frontend', ref);
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: type,
    workflow:
      environment === 'staging' ? 'staging-e2e.yml' : 'production-e2e.yml',
    ref: 'main',
    expectedSha: sha,
    environment,
    inputs:
      environment === 'staging'
        ? { pack: 'all', source_ref: ref }
        : { source_ref: ref }
  });
  return 'WAIT';
}

export function e2eSourceRef(
  frontendReleaseBranch: string | null,
  environment: 'staging' | 'prod',
  trainBranchRef: string
): string {
  if (environment === 'prod') return 'main';
  return frontendReleaseBranch ? trainBranchRef : '1a-staging';
}

async function recordSuccessfulOperationEvidence(
  train: ReleaseTrainRecord,
  prefixes: readonly string[]
): Promise<void> {
  const operations = await releaseBusRepository.listTrainOperations(
    train.id,
    {}
  );
  for (const operation of operations) {
    if (
      operation.status !== 'SUCCEEDED' ||
      !prefixes.some((prefix) => operation.operation_type.startsWith(prefix))
    )
      continue;
    const result = metadata(operation.result_metadata_json);
    await releaseBusRepository.addEvidence(
      {
        idempotencyKey: `operation:${operation.operation_key}`,
        trainId: train.id,
        revision: train.revision,
        evidenceType: 'OPERATION_SUCCEEDED',
        status: 'SUCCEEDED',
        sourceSha: operation.expected_sha,
        artifactDigest: operation.artifact_digest,
        evidenceUri: result.url ? String(result.url) : null,
        metadata: {
          operation_key: operation.operation_key,
          operation_type: operation.operation_type,
          repository: operation.repository,
          environment: operation.environment,
          service: operation.service
        }
      },
      {}
    );
  }
}

async function validateStaging(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  await recordSuccessfulOperationEvidence(train, [
    'preflight-',
    'deploy-backend-staging-',
    'deploy-frontend-staging',
    'e2e-staging'
  ]);
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    const validating =
      train.target_lane === 'STAGING' ? 'STAGING_VALIDATING' : current.status;
    if (current.status === 'STAGING_CLAIMED') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        { status: validating },
        {}
      );
    }
    const latest = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      train.target_lane === 'STAGING' &&
      latest?.status === 'STAGING_VALIDATING'
    ) {
      await releaseBusRepository.updateCandidateLifecycle(
        latest.id,
        latest.row_version,
        { status: 'STAGING_VALIDATED', currentTrainId: null },
        {}
      );
    }
    const validated = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      train.target_lane === 'STAGING' &&
      validated?.status === 'STAGING_VALIDATED'
    ) {
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'CANDIDATE_STAGING_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
      await publishCandidateStatus(
        train,
        candidate,
        'success',
        `Staging validated by release train ${train.id}`
      );
    } else if (train.target_lane === 'PRODUCTION') {
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'PRODUCTION_TRAIN_STAGING_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
    }
  }
}

async function notifyReleasedSourcePullRequest(
  train: ReleaseTrainRecord,
  candidate: ReleaseCandidateRecord
): Promise<void> {
  if (!candidate.pr_number) return;
  if (
    await releaseBusRepository.hasCandidateEvidence(
      candidate.id,
      'SOURCE_PR_RELEASE_NOTIFIED',
      {}
    )
  )
    return;
  try {
    const currentHead = await releaseBusGitHubApp.resolveRef(
      candidate.repository,
      candidate.branch_name
    );
    const unchanged = currentHead === candidate.head_sha;
    await releaseBusGitHubApp.commentOnPullRequest(
      candidate.repository,
      candidate.pr_number,
      unchanged
        ? `Release Bus deployed immutable SHA \`${candidate.head_sha}\` in production as train \`${train.id}\`. This source PR is now closed as released.`
        : `Release Bus deployed recorded SHA \`${candidate.head_sha}\` in production as train \`${train.id}\`. The branch has since moved to \`${currentHead}\`, so this PR remains open.`
    );
    if (unchanged)
      await releaseBusGitHubApp.closePullRequest(
        candidate.repository,
        candidate.pr_number
      );
    await releaseBusRepository.addEvidence(
      {
        trainId: train.id,
        revision: train.revision,
        candidateId: candidate.id,
        evidenceType: 'SOURCE_PR_RELEASE_NOTIFIED',
        status: 'SUCCEEDED',
        sourceSha: candidate.head_sha,
        metadata: { pull_number: candidate.pr_number, closed: unchanged }
      },
      {}
    );
  } catch (error) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        candidateId: candidate.id,
        eventType: 'SOURCE_PR_RELEASE_NOTIFICATION_FAILED',
        payload: {
          message:
            error instanceof Error ? error.message : 'notification failed'
        }
      },
      {}
    );
  }
}

function releasePullRequestBody(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  repository: ReleaseRepository
): string {
  const included = candidates
    .filter((candidate) => candidate.repository === repository)
    .map(
      (candidate) =>
        `- \`${candidate.branch_name}\` at \`${candidate.head_sha}\`${candidate.pr_number ? ` (source PR #${candidate.pr_number})` : ''}`
    )
    .join('\n');
  return [
    `Release train: \`${train.id}\``,
    `Revision: \`${train.revision}\``,
    `Target lane: \`${train.target_lane}\``,
    '',
    'Included immutable candidates:',
    included,
    '',
    'This PR is owned by the Release Bus. Its configured checks and exact-train staging evidence must pass before the GitHub App merges it.'
  ].join('\n');
}

async function createReleasePullRequests(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  const updates: {
    frontendPrNumber?: number | null;
    backendPrNumber?: number | null;
  } = {};
  for (const repository of repositories(candidates)) {
    const pull = await releaseBusGitHubApp.createReleasePullRequest(
      repository,
      trainBranch(train),
      `Release train ${train.id} revision ${train.revision}`,
      releasePullRequestBody(train, candidates, repository)
    );
    if (repository === 'frontend') updates.frontendPrNumber = pull.number;
    else updates.backendPrNumber = pull.number;
    await releaseBusRepository.addEvidence(
      {
        trainId: train.id,
        revision: train.revision,
        evidenceType: `RELEASE_PR_${repository.toUpperCase()}`,
        status: 'SUCCEEDED',
        evidenceUri: pull.html_url,
        metadata: { pull_number: pull.number }
      },
      {}
    );
  }
  await releaseBusRepository.updateTrain(train.id, updates, {});
}

async function mergeReleasePullRequest(
  train: ReleaseTrainRecord,
  repository: ReleaseRepository
): Promise<'PASS' | 'WAIT' | 'STALE' | 'FAIL'> {
  const pullNumber =
    repository === 'frontend'
      ? train.frontend_pr_number
      : train.backend_pr_number;
  const releaseBranch =
    repository === 'frontend'
      ? train.frontend_release_branch
      : train.backend_release_branch;
  if (!pullNumber || !releaseBranch) return 'PASS';
  const expectedHead = await releaseBusGitHubApp.resolveRef(
    repository,
    releaseBranch
  );
  const expectedBase =
    repository === 'frontend'
      ? train.frontend_base_sha
      : train.backend_base_sha;
  if (!expectedBase) return 'FAIL';
  const operationKey = buildReleaseOperationKey({
    trainId: train.id,
    revision: train.revision,
    operation: `merge-${repository}`,
    repository,
    expectedSha: expectedHead
  });
  const operation = await releaseBusRepository.getOrCreateOperation(
    {
      operation_key: operationKey,
      train_id: train.id,
      revision: train.revision,
      operation_type: `merge-${repository}`,
      repository,
      environment: 'prod',
      service: null,
      expected_sha: expectedHead,
      artifact_digest: null,
      attempt: 1,
      status: 'PENDING',
      external_id: String(pullNumber),
      request_metadata_json: { pull_number: pullNumber },
      result_metadata_json: null,
      started_at: null,
      completed_at: null
    },
    {}
  );
  if (operation.status === 'SUCCEEDED') return 'PASS';
  if (operation.status === 'FAILED') return 'FAIL';
  if (operation.status === 'AMBIGUOUS') {
    const merged = await releaseBusGitHubApp.refContainsCommit(
      repository,
      'main',
      expectedHead
    );
    if (!merged) {
      const currentMain = await releaseBusGitHubApp.resolveRef(
        repository,
        'main'
      );
      if (currentMain !== expectedBase) return 'STALE';
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'PENDING' },
        {}
      );
    } else {
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'SUCCEEDED', completedAt: Date.now() },
        {}
      );
      return 'PASS';
    }
  }
  try {
    await releaseBusGitHubApp.updateRef(
      repository,
      'main',
      expectedBase,
      expectedHead
    );
    await releaseBusRepository.updateOperation(
      operationKey,
      {
        status: 'SUCCEEDED',
        resultMetadata: {
          merge_sha: expectedHead,
          strategy: 'strict-fast-forward',
          pull_number: pullNumber
        },
        completedAt: Date.now()
      },
      {}
    );
    return 'PASS';
  } catch (error) {
    await releaseBusRepository.updateOperation(
      operationKey,
      {
        status: 'AMBIGUOUS',
        resultMetadata: {
          message: error instanceof Error ? error.message : 'merge failed'
        }
      },
      {}
    );
    return 'WAIT';
  }
}

async function requeueMovedTarget(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string
): Promise<void> {
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    if (!['STAGING_CLAIMED', 'PRODUCTION_CLAIMED'].includes(current.status))
      continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: 'TARGET_MOVED_REQUEUE'
      },
      {}
    );
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'CANCELLED', failureReason: reason, completedAt: Date.now() },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_REQUEUED_AFTER_TARGET_MOVED',
      payload: { reason }
    },
    {}
  );
}

async function advanceStagingSync(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  for (const repository of repositories(candidates)) {
    const type = `sync-staging-${repository}`;
    const existing = (await phaseOperations(train.id, type))[0];
    if (existing) {
      const result = workflowResult(await reconcile(existing));
      if (result !== 'PASS') return result;
      continue;
    }
    const mainSha = await releaseBusGitHubApp.resolveRef(repository, 'main');
    await dispatchWorkflow({
      train,
      repository,
      operationType: type,
      workflow: 'release-bus-sync-staging.yml',
      ref: 'main',
      expectedSha: mainSha,
      environment: 'staging',
      inputs: { main_sha: mainSha }
    });
    return 'WAIT';
  }
  return 'PASS';
}

async function finalizeProduction(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  await recordSuccessfulOperationEvidence(train, [
    'merge-',
    'deploy-backend-prod-',
    'deploy-frontend-prod',
    'e2e-prod',
    'sync-staging-'
  ]);
  for (const candidate of candidates) {
    let current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    if (current.status === 'PRODUCTION_CLAIMED') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        { status: 'PRODUCTION_VALIDATING' },
        {}
      );
      current = await releaseBusRepository.findCandidateById(candidate.id, {});
    }
    if (current?.status === 'PRODUCTION_VALIDATING') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        {
          status: 'PRODUCTION_VALIDATED',
          currentTrainId: null,
          releasedAt: Date.now()
        },
        {}
      );
    }
    current = await releaseBusRepository.findCandidateById(candidate.id, {});
    if (current?.status === 'PRODUCTION_VALIDATED')
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'CANDIDATE_PRODUCTION_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
    if (current?.status === 'PRODUCTION_VALIDATED')
      await publishCandidateStatus(
        train,
        candidate,
        'success',
        `Production deployed by release train ${train.id}`
      );
    await notifyReleasedSourcePullRequest(train, candidate);
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  for (const laneName of [
    'global-production',
    'global-staging',
    'global-orchestration'
  ]) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token) {
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
    }
  }
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'PRODUCTION_TRAIN_COMPLETED',
      payload: { candidate_ids: candidates.map((candidate) => candidate.id) }
    },
    {}
  );
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: 'PRODUCTION' }]
    }
  ]);
}

async function finishStaging(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  let updatedRepositories = 0;
  for (const repository of repositories(candidates)) {
    const base =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!base) continue;
    try {
      await releaseBusGitHubApp.updateRef(
        repository,
        '1a-staging',
        base,
        await releaseBusGitHubApp.resolveRef(repository, trainBranch(train))
      );
      updatedRepositories += 1;
    } catch (error) {
      if (updatedRepositories > 0)
        throw new TerminalReleaseTrainError(
          `PARTIAL_STAGING_REF_UPDATE: ${error instanceof Error ? error.message : 'target moved'}`
        );
      throw error;
    }
  }
  await validateStaging(train, candidates);
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  for (const laneName of ['global-staging', 'global-orchestration']) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token)
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
  }
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: 'STAGING' }]
    }
  ]);
}

async function shadowComplete(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status:
          train.target_lane === 'STAGING'
            ? 'READY_FOR_STAGING'
            : 'READY_FOR_PRODUCTION',
        currentTrainId: null
      },
      {}
    );
    await releaseBusRepository.addEvidence(
      {
        idempotencyKey: `shadow:${train.target_lane}:${candidate.id}:v${candidate.metadata_version}`,
        trainId: train.id,
        revision: train.revision,
        candidateId: candidate.id,
        evidenceType: `CANDIDATE_SHADOW_EVALUATED_${train.target_lane}`,
        status: 'SUCCEEDED',
        sourceSha: candidate.head_sha,
        metadata: { metadata_version: candidate.metadata_version }
      },
      {}
    );
  }
  await releaseBusRepository.addEvidence(
    {
      trainId: train.id,
      revision: train.revision,
      evidenceType: 'SHADOW_DECISION',
      status: 'SUCCEEDED',
      metadata: { candidate_ids: candidates.map((candidate) => candidate.id) }
    },
    {}
  );
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  const lane = await releaseBusRepository.getLane('global-orchestration', {});
  if (lane?.train_id === train.id && lane.lease_token)
    await releaseBusRepository.releaseLane(
      'global-orchestration',
      lane.lease_token,
      {}
    );
}

export async function advanceReleaseTrain(
  trainId: string
): Promise<WorkerResult> {
  const { train, candidates } = await loadTrain(trainId);
  try {
    if (['COMPLETED', 'ROLLED_BACK', 'CANCELLED'].includes(train.status))
      return { decision: 'COMPLETE', train_id: train.id, status: train.status };
    if (train.status === 'FAILED')
      return {
        decision: 'FAILED',
        train_id: train.id,
        status: train.status,
        message: train.failure_reason ?? undefined
      };
    const mode = getReleaseBusMode();
    if (mode === 'OFF')
      return { decision: 'WAIT', train_id: train.id, status: train.status };
    if (mode === 'SHADOW' && train.status === 'FROZEN') {
      await shadowComplete(train, candidates);
      return { decision: 'COMPLETE', train_id: train.id, status: 'COMPLETED' };
    }
    if (
      mode === 'SHADOW' ||
      (train.target_lane === 'PRODUCTION' && mode !== 'PRODUCTION')
    )
      return { decision: 'WAIT', train_id: train.id, status: train.status };
    if (!(await ensureLane('global-orchestration', train)))
      return { decision: 'WAIT', train_id: train.id, status: train.status };
    if (await isTrainLanePaused(train)) {
      await heartbeatOwnedTrainLanes(train);
      return { decision: 'WAIT', train_id: train.id, status: train.status };
    }
    if (train.status === 'FROZEN') {
      const baseCanary = await advanceFrontendBaseCanary(train, candidates);
      if (baseCanary === 'FAIL')
        return {
          decision: 'FAILED',
          train_id: train.id,
          status: 'FAILED',
          message:
            'Frontend base canary failed; candidates were returned to the queue'
        };
      if (baseCanary === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await beginComposition(train, candidates);
      return { decision: 'WAIT', train_id: train.id, status: 'COMPOSING' };
    }
    if (train.status === 'COMPOSING') {
      const result = await pollPhase(train, 'compose-');
      if (result === 'FAIL') {
        await beginFailureIsolation(
          train,
          candidates,
          'Release branch composition failed after bounded conflict resolution'
        );
        return {
          decision: 'WAIT',
          train_id: train.id,
          status: 'ISOLATING_FAILURE'
        };
      }
      if (result === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      // A successful compose workflow may intentionally publish only its
      // conflict-free prefix when Codex is disabled. Never dispatch preflight
      // until every frozen candidate SHA is proven reachable from its branch.
      const offender = await finishIncompleteComposition(train, candidates);
      if (offender)
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED',
          message: `Candidate ${offender.id} requires merge-conflict resolution; other candidates were returned to the queue`
        };
      await beginPreflight(train, candidates);
      return { decision: 'WAIT', train_id: train.id, status: 'PREFLIGHTING' };
    }
    if (train.status === 'PREFLIGHTING') {
      const result = await pollPhase(train, 'preflight-');
      if (result === 'FAIL') {
        await beginFailureIsolation(
          train,
          candidates,
          'Release preflight failed'
        );
        return {
          decision: 'WAIT',
          train_id: train.id,
          status: 'ISOLATING_FAILURE'
        };
      }
      if (result === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      if (
        (await externalDeploymentLaneBusy('staging')) ||
        !(await ensureLane('global-staging', train))
      )
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await releaseBusRepository.updateTrain(
        train.id,
        { status: 'STAGING' },
        {}
      );
      return { decision: 'CONTINUE', train_id: train.id, status: 'STAGING' };
    }
    if (train.status === 'ISOLATING_FAILURE') {
      const result = await finishFailureIsolation(train, candidates);
      if (result === 'RETRY')
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED',
          message: 'Transient gate failure; candidates returned to the queue'
        };
      return {
        decision: result === 'WAIT' ? 'WAIT' : 'FAILED',
        train_id: train.id,
        status: result === 'WAIT' ? train.status : 'FAILED',
        message: train.failure_reason ?? undefined
      };
    }
    if (train.status === 'STAGING') {
      if (!(await ensureLane('global-staging', train)))
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const backend = await advanceBackendDeploy(train, candidates, 'staging');
      if (backend === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Backend staging deployment failed'
        );
      if (backend === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const frontend = await advanceFrontendDeploy(train, 'staging');
      if (frontend === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Frontend staging deployment failed'
        );
      if (frontend === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const e2e = await advanceE2e(train, 'staging');
      if (e2e === 'FAIL')
        throw new TerminalReleaseTrainError('Staging E2E failed');
      if (e2e === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await releaseBusRepository.updateTrain(
        train.id,
        { status: 'VALIDATING_STAGING' },
        {}
      );
      return {
        decision: 'CONTINUE',
        train_id: train.id,
        status: 'VALIDATING_STAGING'
      };
    }
    if (train.status === 'VALIDATING_STAGING') {
      if (!(await ensureLane('global-staging', train)))
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      if (train.target_lane === 'STAGING') {
        try {
          await finishStaging(train, candidates);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Staging target moved';
          if (message.startsWith('PARTIAL_STAGING_REF_UPDATE')) throw error;
          if (!message.includes('moved from expected')) throw error;
          await requeueMovedTarget(train, candidates, message);
          return {
            decision: 'COMPLETE',
            train_id: train.id,
            status: 'CANCELLED',
            message
          };
        }
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'COMPLETED'
        };
      }
      await validateStaging(train, candidates);
      await createReleasePullRequests(train, candidates);
      if (
        (await externalDeploymentLaneBusy('prod')) ||
        !(await ensureLane('global-production', train))
      )
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await releaseBusRepository.updateTrain(
        train.id,
        { status: 'MERGING_PRODUCTION' },
        {}
      );
      return {
        decision: 'CONTINUE',
        train_id: train.id,
        status: 'MERGING_PRODUCTION'
      };
    }
    if (train.status === 'MERGING_PRODUCTION') {
      if (!(await ensureLane('global-production', train)))
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const latest = (await releaseBusRepository.findTrain(
        train.id,
        {}
      )) as ReleaseTrainRecord;
      const backendMerge = await mergeReleasePullRequest(latest, 'backend');
      if (backendMerge === 'STALE') {
        await requeueMovedTarget(
          train,
          candidates,
          'Backend main moved before the release train could fast-forward it'
        );
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED'
        };
      }
      if (backendMerge === 'FAIL') {
        throw new TerminalReleaseTrainError(
          'Backend production release PR merge failed'
        );
      }
      if (backendMerge === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await releaseBusRepository.updateTrain(
        train.id,
        { status: 'DEPLOYING_PRODUCTION' },
        {}
      );
      return {
        decision: 'CONTINUE',
        train_id: train.id,
        status: 'DEPLOYING_PRODUCTION'
      };
    }
    if (train.status === 'DEPLOYING_PRODUCTION') {
      if (!(await ensureLane('global-production', train)))
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const backend = await advanceBackendDeploy(train, candidates, 'prod');
      if (backend === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Backend production deployment failed'
        );
      if (backend === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const latest = (await releaseBusRepository.findTrain(
        train.id,
        {}
      )) as ReleaseTrainRecord;
      const frontendMerge = await mergeReleasePullRequest(latest, 'frontend');
      if (frontendMerge === 'STALE') {
        if (!latest.backend_release_branch) {
          await requeueMovedTarget(
            train,
            candidates,
            'Frontend main moved before the release train could fast-forward it'
          );
          return {
            decision: 'COMPLETE',
            train_id: train.id,
            status: 'CANCELLED'
          };
        }
        throw new TerminalReleaseTrainError(
          'Frontend main moved after backend production deployment; operator intervention is required'
        );
      }
      if (frontendMerge === 'FAIL') {
        throw new TerminalReleaseTrainError(
          'Frontend production release PR merge failed'
        );
      }
      if (frontendMerge === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const frontend = await advanceFrontendDeploy(latest, 'prod');
      if (frontend === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Frontend production deployment failed'
        );
      if (frontend === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const e2e = await advanceE2e(latest, 'prod');
      if (e2e === 'FAIL')
        throw new TerminalReleaseTrainError('Production E2E failed');
      if (e2e === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await releaseBusRepository.updateTrain(
        train.id,
        { status: 'VALIDATING_PRODUCTION' },
        {}
      );
      return {
        decision: 'CONTINUE',
        train_id: train.id,
        status: 'VALIDATING_PRODUCTION'
      };
    }
    if (train.status === 'VALIDATING_PRODUCTION') {
      if (!(await ensureLane('global-production', train)))
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      const sync = await advanceStagingSync(train, candidates);
      if (sync === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Failed to sync main back into staging'
        );
      if (sync === 'WAIT')
        return { decision: 'WAIT', train_id: train.id, status: train.status };
      await finalizeProduction(train, candidates);
      return { decision: 'COMPLETE', train_id: train.id, status: 'COMPLETED' };
    }
    throw new TerminalReleaseTrainError(
      `Unsupported release train status ${train.status}`
    );
  } catch (error) {
    if (!(error instanceof TerminalReleaseTrainError)) throw error;
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown release-bus worker failure';
    await failAndPauseTrain(train, candidates, message);
    return {
      decision: 'FAILED',
      train_id: train.id,
      status: 'FAILED',
      message
    };
  }
}
