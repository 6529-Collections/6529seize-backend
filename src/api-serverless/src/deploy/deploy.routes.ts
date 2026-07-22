import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CustomApiCompliantException } from '@/exceptions';
import { asyncRouter } from '@/api/async.router';
import {
  canDeployServiceToEnvironment,
  getDeployServiceConfigs
} from '@/api/deploy/deploy.config';
import { gitHubDeployService } from '@/api/deploy/deploy.github.service';
import {
  renderDeployUI,
  renderDeployUiApp
} from '@/api/deploy/deploy-ui.renderer';
import {
  renderDeployBusUI,
  renderDeployBusUiApp
} from '@/api/deploy/deploy-bus-ui.renderer';
import {
  DeployDispatchBodySchema,
  DeployRefsQuery,
  DeployRefsQuerySchema,
  DeployRunsQuery,
  DeployRunsQuerySchema,
  ReleaseBusBreakGlassAuthorizationBodySchema,
  ReleaseBusControlBodySchema,
  ReleaseBusExperimentalResetBodySchema,
  ReleaseBusAuthorizationBodySchema,
  ReleaseBusProgressReportBodySchema,
  ReleaseCandidateListQuerySchema,
  ReleaseCandidateReadyBodySchema
} from '@/api/deploy/deploy.validation';
import { setNoStoreHeaders } from '@/api/response-headers';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { releaseBusRepository } from '@/releaseBus/release-bus.repository';
import { releaseBusGitHubApp } from '@/releaseBus/release-bus.github-app';
import {
  getReleaseBusMode,
  RELEASE_BUS_OPERATOR_TEAM
} from '@/releaseBus/release-bus.config';
import {
  ReleaseBusHistoryResetBlockedError,
  releaseBusService
} from '@/releaseBus/release-bus.service';
import { getReleaseTrainOverview } from '@/releaseBus/release-bus-status.service';
import type {
  MarkReleaseReadyInput,
  ReleaseCandidateRecord,
  ReleaseCandidateStatus,
  ReleaseControlScope,
  ReleaseRepository
} from '@/releaseBus/release-bus.types';

function getGitHubTokenOrThrow(req: Request): string {
  const authorizationHeader = req.get('authorization');
  if (authorizationHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authorizationHeader.slice('bearer '.length).trim();
    if (token) {
      return token;
    }
  }

  throw new CustomApiCompliantException(
    401,
    'GitHub token is required for this route'
  );
}

function requireWorkflowCredential(req: Request): void {
  const configuredToken = process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  const suppliedToken =
    req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const authenticated =
    configuredToken &&
    suppliedToken.length === configuredToken.length &&
    timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(configuredToken));
  if (!authenticated)
    throw new CustomApiCompliantException(
      401,
      'Invalid release-bus workflow credential'
    );
}

const deployRoutes = asyncRouter();

function targetForRepository(repository: ReleaseRepository) {
  return repository === 'frontend' ? 'frontend' : 'backend';
}

async function requireOperator(token: string): Promise<string> {
  const viewer = await gitHubDeployService.getViewer(token);
  const allowed = await releaseBusGitHubApp.isOrganizationOperator(
    viewer.login,
    RELEASE_BUS_OPERATOR_TEAM
  );
  if (!allowed)
    throw new CustomApiCompliantException(
      403,
      'Release-bus operator permission is required'
    );
  return viewer.login;
}

async function requireAuthenticatedViewer(req: Request): Promise<string> {
  const token = getGitHubTokenOrThrow(req);
  return (await gitHubDeployService.getViewer(token)).login;
}

deployRoutes.get('/ui', async (req, res) => {
  const html = renderDeployUI(getDeployServiceConfigs());

  setNoStoreHeaders(res);
  res.setHeader('Content-Type', 'text/html');

  return res.send(html);
});

deployRoutes.get('/ui/app.js', async (req, res) => {
  setNoStoreHeaders(res);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  return res.send(renderDeployUiApp());
});

deployRoutes.get('/ui/bus', async (_req, res) => {
  setNoStoreHeaders(res);
  res.setHeader('Content-Type', 'text/html');
  return res.send(renderDeployBusUI());
});

deployRoutes.get('/ui/bus/app.js', async (_req, res) => {
  setNoStoreHeaders(res);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  return res.send(renderDeployBusUiApp());
});

deployRoutes.get('/ui/branch-head', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const repository = String(req.query.repository ?? '');
  const branch = String(req.query.branch ?? '');
  if (
    !['frontend', 'backend'].includes(repository) ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(branch)
  ) {
    throw new CustomApiCompliantException(
      400,
      'Valid repository and branch are required'
    );
  }
  const target = targetForRepository(repository as ReleaseRepository);
  await gitHubDeployService.assertRepositoryWriteAccess(token, target);
  setNoStoreHeaders(res);
  return res.json({
    head_sha: await gitHubDeployService.resolveBranchHead(token, target, branch)
  });
});

deployRoutes.get('/ui/session', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const viewer = await gitHubDeployService.getViewer(token);
  const runsPage = await gitHubDeployService.listRecentRuns({
    token,
    page: 1,
    pageSize: 8
  });

  setNoStoreHeaders(res);
  return res.json({
    login: viewer.login,
    runs_page: runsPage
  });
});

deployRoutes.get('/ui/runs', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const query = getValidatedByJoiOrThrow<DeployRunsQuery>(
    req.query as unknown as DeployRunsQuery,
    DeployRunsQuerySchema
  );

  setNoStoreHeaders(res);
  return res.json({
    runs_page: await gitHubDeployService.listRecentRuns({
      token,
      target: query.target,
      page: query.page,
      pageSize: query.page_size
    })
  });
});

deployRoutes.get('/ui/refs', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const query = getValidatedByJoiOrThrow<DeployRefsQuery>(
    req.query as unknown as DeployRefsQuery,
    DeployRefsQuerySchema
  );

  setNoStoreHeaders(res);
  return res.json({
    refs: await gitHubDeployService.listRefs(token, query.target, query.q, 20)
  });
});

deployRoutes.post('/ui/dispatch', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const body = getValidatedByJoiOrThrow(req.body, DeployDispatchBodySchema);
  if (['STAGING', 'PRODUCTION'].includes(getReleaseBusMode())) {
    await requireOperator(token);
    if (body.break_glass_reason.length < 3) {
      throw new CustomApiCompliantException(
        400,
        'An audited break-glass reason is required while the Release Bus is enabled'
      );
    }
  }
  const services = body.target === 'backend' ? (body.services as string[]) : [];
  const invalidService = services.find(
    (service: string) =>
      !canDeployServiceToEnvironment(service, body.environment)
  );

  if (invalidService) {
    throw new CustomApiCompliantException(
      400,
      `${invalidService} cannot be deployed to ${body.environment}`
    );
  }

  const settledResults = await Promise.allSettled(
    body.target === 'frontend'
      ? [
          gitHubDeployService.dispatchDeploy({
            token,
            target: 'frontend',
            ref: body.ref,
            environment: body.environment,
            breakGlassReason: body.break_glass_reason
          })
        ]
      : services.map((service: string) =>
          gitHubDeployService.dispatchDeploy({
            token,
            target: 'backend',
            ref: body.ref,
            service,
            environment: body.environment,
            breakGlassReason: body.break_glass_reason
          })
        )
  );

  const results = settledResults.map((result, index) => {
    const service = body.target === 'frontend' ? 'frontend' : services[index];

    if (result.status === 'fulfilled') {
      return {
        service,
        ok: true,
        message: `Dispatched ${service} to ${body.environment} from ${body.ref}`
      };
    }

    const err = result.reason;
    return {
      service,
      ok: false,
      message:
        err instanceof Error ? err.message : 'Unknown GitHub deploy error'
    };
  });

  setNoStoreHeaders(res);
  return res.json({
    target: body.target,
    environment: body.environment,
    ref: body.ref,
    results,
    summary: {
      requested: results.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length
    }
  });
});

deployRoutes.post('/release-candidates/ready', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const body = getValidatedByJoiOrThrow<MarkReleaseReadyInput>(
    req.body,
    ReleaseCandidateReadyBodySchema
  );
  const mode = getReleaseBusMode();
  if (mode === 'OFF') {
    throw new CustomApiCompliantException(
      409,
      'Release Bus is OFF; readiness submissions are disabled'
    );
  }
  if (mode === 'STAGING' && body.target_lane === 'PRODUCTION') {
    throw new CustomApiCompliantException(
      409,
      'Release Bus production readiness is disabled in STAGING mode'
    );
  }
  const target = targetForRepository(body.repository);
  const viewer = await gitHubDeployService.getViewer(token);
  await gitHubDeployService.assertRepositoryWriteAccess(token, target);
  const currentHead = await gitHubDeployService.resolveBranchHead(
    token,
    target,
    body.branch
  );
  if (currentHead !== body.expected_head_sha.toLowerCase()) {
    throw new CustomApiCompliantException(
      409,
      `Branch changed during submission; current head is ${currentHead}`
    );
  }
  const pullRequest = await gitHubDeployService.findOpenPullRequest(
    token,
    target,
    body.branch
  );
  const resolvedDependencies = await Promise.all(
    body.dependencies.map(async (dependency) => {
      const dependencyTarget = targetForRepository(dependency.repository);
      await gitHubDeployService.assertRepositoryWriteAccess(
        token,
        dependencyTarget
      );
      const headSha = await gitHubDeployService.resolveBranchHead(
        token,
        dependencyTarget,
        dependency.branch
      );
      const dependencyPr = await gitHubDeployService.findOpenPullRequest(
        token,
        dependencyTarget,
        dependency.branch
      );
      return { ...dependency, headSha, prNumber: dependencyPr?.number ?? null };
    })
  );
  let candidate: ReleaseCandidateRecord;
  try {
    candidate = await releaseBusService.markReady({
      ...body,
      actor: viewer.login,
      prNumber: pullRequest?.number ?? null,
      resolvedDependencies
    });
  } catch (error) {
    throw new CustomApiCompliantException(
      error instanceof Error && error.message.includes('staging') ? 409 : 400,
      error instanceof Error ? error.message : 'Invalid release candidate'
    );
  }
  if (mode === 'STAGING' || mode === 'PRODUCTION') {
    await gitHubDeployService.createCommitStatus(
      token,
      target,
      candidate.head_sha,
      'pending',
      `${candidate.status.replace(/_/g, ' ').toLowerCase()} (${body.target_lane.toLowerCase()})`,
      `${req.protocol}://${req.get('host')}/deploy/ui/bus`
    );
  }
  setNoStoreHeaders(res);
  return res.status(202).json({ candidate, mode });
});

deployRoutes.post('/release-candidates/:id/cancel', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const viewer = await gitHubDeployService.getViewer(token);
  const candidate = await releaseBusRepository.findCandidateById(
    req.params.id,
    {}
  );
  if (!candidate)
    throw new CustomApiCompliantException(404, 'Release candidate not found');
  await gitHubDeployService.assertRepositoryWriteAccess(
    token,
    targetForRepository(candidate.repository)
  );
  let cancelled: ReleaseCandidateRecord;
  try {
    cancelled = await releaseBusService.cancel(candidate.id, viewer.login);
  } catch (error) {
    throw new CustomApiCompliantException(
      409,
      error instanceof Error ? error.message : 'Candidate cannot be cancelled'
    );
  }
  const target = targetForRepository(cancelled.repository);
  if (
    (await gitHubDeployService.getReleaseBusCommitStatusState(
      token,
      target,
      cancelled.head_sha
    )) === 'pending'
  ) {
    await gitHubDeployService.createCommitStatus(
      token,
      target,
      cancelled.head_sha,
      'success',
      'release readiness cancelled',
      `${req.protocol}://${req.get('host')}/deploy/ui/bus`
    );
  }
  setNoStoreHeaders(res);
  return res.json({ candidate: cancelled });
});

deployRoutes.get('/release-candidates', async (req, res) => {
  await requireAuthenticatedViewer(req);
  const query = getValidatedByJoiOrThrow<{
    status?: ReleaseCandidateStatus;
    limit: number;
  }>(
    req.query as unknown as {
      status?: ReleaseCandidateStatus;
      limit: number;
    },
    ReleaseCandidateListQuerySchema
  );
  const candidates = await releaseBusRepository.listCandidates(
    query.status ? [query.status] : null,
    query.limit,
    {}
  );
  setNoStoreHeaders(res);
  return res.json({ candidates, mode: getReleaseBusMode() });
});

deployRoutes.get('/release-trains', async (req, res) => {
  await requireAuthenticatedViewer(req);
  const trains = await releaseBusRepository.listTrains(50, {});
  const activeTrain = trains.find(
    (train) =>
      !['COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED'].includes(
        train.status
      )
  );
  setNoStoreHeaders(res);
  return res.json({
    trains,
    active_train: activeTrain
      ? await getReleaseTrainOverview(activeTrain)
      : null
  });
});

deployRoutes.get('/release-trains/:id', async (req, res) => {
  await requireAuthenticatedViewer(req);
  const train = await releaseBusRepository.findTrain(req.params.id, {});
  if (!train)
    throw new CustomApiCompliantException(404, 'Release train not found');
  const items = await releaseBusRepository.listTrainItems(train.id, {});
  setNoStoreHeaders(res);
  return res.json({
    train,
    items,
    overview: await getReleaseTrainOverview(train)
  });
});

deployRoutes.get('/release-bus/controls', async (req, res) => {
  await requireAuthenticatedViewer(req);
  setNoStoreHeaders(res);
  return res.json({
    controls: await releaseBusRepository.listControls({}),
    mode: getReleaseBusMode()
  });
});

async function updateBusControl(req: Request, paused: boolean) {
  const token = getGitHubTokenOrThrow(req);
  const actor = await requireOperator(token);
  const body = getValidatedByJoiOrThrow<{
    scope: ReleaseControlScope;
    reason: string;
  }>(req.body, ReleaseBusControlBodySchema);
  await releaseBusService.setPaused(body.scope, paused, body.reason, actor);
  return {
    controls: await releaseBusRepository.listControls({}),
    mode: getReleaseBusMode()
  };
}

deployRoutes.post('/release-bus/pause', async (req, res) => {
  setNoStoreHeaders(res);
  return res.json(await updateBusControl(req, true));
});

deployRoutes.post('/release-bus/resume', async (req, res) => {
  setNoStoreHeaders(res);
  return res.json(await updateBusControl(req, false));
});

deployRoutes.post(
  '/release-bus/reset-experimental-history',
  async (req, res) => {
    const token = getGitHubTokenOrThrow(req);
    const actor = await requireOperator(token);
    const body = getValidatedByJoiOrThrow<{
      reset_id: string;
      confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY';
      reason: string;
    }>(req.body, ReleaseBusExperimentalResetBodySchema);
    try {
      const result = await releaseBusService.resetExperimentalHistory(
        body.reason,
        actor,
        body.reset_id
      );
      let controls = null;
      try {
        controls = await releaseBusRepository.listControls({});
      } catch {
        // The reset transaction has already committed. Return its terminal
        // result so a transient read failure cannot invite a destructive retry.
      }
      setNoStoreHeaders(res);
      return res.json({
        reset: true,
        ...result,
        controls,
        controls_status: controls ? 'available' : 'unavailable',
        mode: getReleaseBusMode()
      });
    } catch (error) {
      if (!(error instanceof ReleaseBusHistoryResetBlockedError)) throw error;
      throw new CustomApiCompliantException(409, error.message);
    }
  }
);

deployRoutes.post('/release-bus/authorize', async (req, res) => {
  requireWorkflowCredential(req);
  const body = getValidatedByJoiOrThrow<{
    train_id: string;
    operation_key: string;
    workflow_run_id: string;
    artifact_run_id: string | null;
    repository: ReleaseRepository;
    environment: 'orchestration' | 'staging' | 'prod';
    service: string | null;
    expected_sha: string;
    artifact_digest: string | null;
  }>(req.body, ReleaseBusAuthorizationBodySchema);
  const operation = await releaseBusRepository.findOperation(
    body.operation_key,
    {}
  );
  let operationRequest: { inputs?: { artifact_run_id?: string } } | null = null;
  if (operation?.request_metadata_json) {
    try {
      operationRequest =
        typeof operation.request_metadata_json === 'string'
          ? (JSON.parse(operation.request_metadata_json) as {
              inputs?: { artifact_run_id?: string };
            })
          : (operation.request_metadata_json as {
              inputs?: { artifact_run_id?: string };
            });
    } catch {
      operationRequest = null;
    }
  }
  if (
    !operation ||
    operation.train_id !== body.train_id ||
    operation.repository !== body.repository ||
    operation.environment !== body.environment ||
    operation.service !== body.service ||
    operation.expected_sha !== body.expected_sha ||
    (operationRequest?.inputs?.artifact_run_id ?? null) !==
      body.artifact_run_id ||
    (operation.artifact_digest &&
      operation.artifact_digest !== body.artifact_digest)
  ) {
    throw new CustomApiCompliantException(
      403,
      'Release operation does not match the authorization request'
    );
  }
  if (!['PENDING', 'DISPATCHED', 'RUNNING'].includes(operation.status)) {
    throw new CustomApiCompliantException(
      409,
      `Release operation is ${operation.status}`
    );
  }
  const laneName =
    body.environment === 'prod'
      ? 'global-production'
      : body.environment === 'staging'
        ? 'global-staging'
        : 'global-orchestration';
  const lane = await releaseBusRepository.getLane(laneName, {});
  if (
    !lane ||
    lane.train_id !== body.train_id ||
    Number(lane.expires_at) <= Date.now()
  ) {
    throw new CustomApiCompliantException(
      409,
      `${laneName} is not owned by this train`
    );
  }
  if (
    !(await releaseBusRepository.bindOperationAuthorization(
      body.operation_key,
      body.workflow_run_id,
      body.artifact_digest,
      {}
    ))
  ) {
    throw new CustomApiCompliantException(
      409,
      'A different workflow run or artifact already claimed this release operation'
    );
  }
  setNoStoreHeaders(res);
  return res.json({
    authorized: true,
    train_id: body.train_id,
    operation_key: body.operation_key
  });
});

deployRoutes.post('/release-bus/report-progress', async (req, res) => {
  requireWorkflowCredential(req);
  const body = getValidatedByJoiOrThrow<{
    train_id: string;
    operation_key: string;
    workflow_run_id: string;
    phase: 'lint' | 'typecheck' | 'unit_tests' | 'build' | 'complete';
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    failure_class: 'SOURCE' | 'INFRASTRUCTURE_TRANSIENT' | 'UNKNOWN' | null;
    failure_phase: 'dependency_install' | 'gate' | null;
    retryable: boolean;
    stages: Array<{
      name: 'lint' | 'typecheck' | 'unit_tests' | 'build';
      status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
    }>;
    jest: {
      num_failed_test_suites: number;
      num_failed_tests: number;
      failing_suites: string[];
      failing_tests: Array<{ suite: string; test: string }>;
    } | null;
    summary: {
      base_sha: string;
      environment: 'orchestration' | 'staging' | 'prod';
      gate_fingerprint: string;
      workflow_sha: string;
      workflow_digest: string;
      node_version: string;
      package_manager: string;
      shard_count: number;
      summary_artifact_name: string;
      summary_artifact_digest: string;
      phase_durations_ms: Record<string, number>;
      totals: Record<string, number>;
      fresh_or_reused: 'fresh' | 'reused';
      shards: Array<Record<string, string | number>>;
      missing_files: string[];
      duplicate_files: string[];
    } | null;
  }>(req.body, ReleaseBusProgressReportBodySchema);
  const reportContent = {
    phase: body.phase,
    status: body.status,
    failure_class: body.failure_class,
    failure_phase: body.failure_phase,
    retryable: body.retryable,
    stages: body.stages,
    jest: body.jest,
    summary: body.summary
  };
  const result = await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const operation = await releaseBusRepository.findOperation(
        body.operation_key,
        context,
        true
      );
      if (
        operation?.train_id !== body.train_id ||
        operation?.external_id !== body.workflow_run_id
      ) {
        throw new CustomApiCompliantException(
          403,
          'Release progress report does not match the authorized operation'
        );
      }
      const isFrontendBaseCanary =
        operation.operation_type === 'base-canary-frontend';
      // Aggregate summaries are base-canary evidence. Other operations report
      // bounded stages/Jest data but must not claim reusable base evidence.
      if (isFrontendBaseCanary && body.phase === 'complete' && !body.summary) {
        throw new CustomApiCompliantException(
          422,
          'A terminal frontend base canary report requires its aggregate summary'
        );
      }
      if (
        body.summary &&
        (!isFrontendBaseCanary ||
          operation.expected_sha?.toLowerCase() !==
            body.summary.base_sha.toLowerCase() ||
          operation.environment?.toLowerCase() !==
            body.summary.environment.toLowerCase())
      ) {
        throw new CustomApiCompliantException(
          403,
          'Release progress aggregate does not match the authorized base canary operation'
        );
      }
      const existingResult = (() => {
        if (typeof operation.result_metadata_json !== 'string')
          return operation.result_metadata_json &&
            typeof operation.result_metadata_json === 'object'
            ? (operation.result_metadata_json as Record<string, unknown>)
            : {};
        try {
          return JSON.parse(operation.result_metadata_json) as Record<
            string,
            unknown
          >;
        } catch {
          return {};
        }
      })();
      const existingGateReport =
        existingResult.gate_report &&
        typeof existingResult.gate_report === 'object'
          ? (existingResult.gate_report as Record<string, unknown>)
          : null;
      if (existingGateReport?.phase === 'complete') {
        if (body.phase !== 'complete') {
          throw new CustomApiCompliantException(
            409,
            'A terminal progress report is already recorded for this operation'
          );
        }
        const persistedContent = {
          phase: existingGateReport.phase,
          status: existingGateReport.status,
          failure_class: existingGateReport.failure_class ?? null,
          failure_phase: existingGateReport.failure_phase ?? null,
          retryable: existingGateReport.retryable === true,
          stages: existingGateReport.stages,
          jest: existingGateReport.jest,
          summary: existingGateReport.summary ?? null
        };
        if (!isDeepStrictEqual(persistedContent, reportContent)) {
          throw new CustomApiCompliantException(
            409,
            'A different terminal progress report is already recorded for this operation'
          );
        }
        return {
          idempotent: true,
          reportedAt: existingGateReport.reported_at
        };
      }
      const reportedAt = Date.now();
      const gateReport = {
        ...reportContent,
        reported_at: reportedAt
      };
      await releaseBusRepository.updateOperation(
        body.operation_key,
        {
          status: operation.status,
          resultMetadata: {
            ...existingResult,
            gate_report: gateReport,
            last_progress_at: reportedAt
          }
        },
        context
      );
      await releaseBusRepository.appendEvent(
        {
          trainId: body.train_id,
          eventType: 'OPERATION_GATE_REPORT',
          payload: {
            operation_key: body.operation_key,
            phase: body.phase,
            status: body.status,
            failure_class: body.failure_class,
            failure_phase: body.failure_phase,
            retryable: body.retryable,
            failed_test_suites: body.jest?.num_failed_test_suites ?? 0,
            failed_tests: body.jest?.num_failed_tests ?? 0,
            summary: body.summary
          }
        },
        context
      );
      return { idempotent: false, reportedAt };
    }
  );
  setNoStoreHeaders(res);
  if (result.idempotent) {
    return res.json({
      accepted: true,
      idempotent: true,
      reported_at: result.reportedAt
    });
  }
  return res.json({ accepted: true, reported_at: result.reportedAt });
});

deployRoutes.post('/release-bus/authorize-break-glass', async (req, res) => {
  requireWorkflowCredential(req);
  const body = getValidatedByJoiOrThrow<{
    workflow_run_id: string;
    repository: ReleaseRepository;
    environment: 'staging' | 'prod';
    service: string | null;
    expected_sha: string;
    reason: string;
  }>(req.body, ReleaseBusBreakGlassAuthorizationBodySchema);
  const workflowRun = await releaseBusGitHubApp.getWorkflowRunIdentity(
    body.repository,
    body.workflow_run_id
  );
  if (workflowRun.headSha !== body.expected_sha) {
    throw new CustomApiCompliantException(
      403,
      'Break-glass workflow does not match the requested immutable SHA'
    );
  }
  if (!['push', 'workflow_dispatch'].includes(workflowRun.event)) {
    throw new CustomApiCompliantException(
      403,
      'Break glass is only available to push or manually dispatched deploy workflows'
    );
  }
  if (body.repository === 'backend') {
    if (
      !body.service ||
      !canDeployServiceToEnvironment(body.service, body.environment) ||
      workflowRun.name !== 'Deploy a service' ||
      workflowRun.displayTitle !==
        `Deploy ${body.service} to ${body.environment} [manual]`
    ) {
      throw new CustomApiCompliantException(
        403,
        'Break-glass workflow does not match the requested backend deployment'
      );
    }
  } else {
    const expectedWorkflowName =
      body.environment === 'prod'
        ? 'Web Deploy - PROD'
        : 'Web Deploy - STAGING';
    if (body.service !== null || workflowRun.name !== expectedWorkflowName) {
      throw new CustomApiCompliantException(
        403,
        'Break-glass workflow does not match the requested frontend deployment'
      );
    }
  }
  if (
    !(await releaseBusGitHubApp.isOrganizationOperator(
      workflowRun.actor,
      RELEASE_BUS_OPERATOR_TEAM
    ))
  ) {
    throw new CustomApiCompliantException(
      403,
      'Only a release-bus operator may use break glass'
    );
  }
  const scope = body.environment === 'prod' ? 'PRODUCTION' : 'STAGING';
  const activeTrain = await releaseBusService.pauseForBreakGlass(
    scope,
    `Break glass: ${body.reason}`,
    workflowRun.actor
  );
  if (activeTrain) {
    throw new CustomApiCompliantException(
      409,
      `Release train ${activeTrain.id} is still active; break glass was not authorized and the lane was not paused`
    );
  }
  await releaseBusRepository.appendEvent(
    {
      eventType: 'BREAK_GLASS_DEPLOYMENT_AUTHORIZED',
      githubActor: workflowRun.actor,
      payload: {
        workflow_run_id: body.workflow_run_id,
        repository: body.repository,
        environment: body.environment,
        service: body.service,
        expected_sha: body.expected_sha,
        reason: body.reason
      }
    },
    {}
  );
  setNoStoreHeaders(res);
  return res.json({
    authorized: true,
    scope,
    paused: true,
    workflow_run_id: body.workflow_run_id,
    repository: body.repository,
    environment: body.environment,
    service: body.service,
    expected_sha: body.expected_sha
  });
});

deployRoutes.post('/github/webhook', async (req, res) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.get('x-hub-signature-256');
  const secret = process.env.RELEASE_BUS_GITHUB_WEBHOOK_SECRET;
  if (!rawBody || !signature || !secret) {
    throw new CustomApiCompliantException(
      401,
      'GitHub webhook authentication is unavailable'
    );
  }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const valid =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid)
    throw new CustomApiCompliantException(
      401,
      'Invalid GitHub webhook signature'
    );
  const eventName = req.get('x-github-event');
  const payload = req.body as {
    ref?: string;
    after?: string;
    repository?: { name?: string };
    sender?: { login?: string };
  };
  if (
    eventName === 'push' &&
    payload.ref?.startsWith('refs/heads/') &&
    payload.after &&
    /^[a-f0-9]{40}$/i.test(payload.after)
  ) {
    const repository =
      payload.repository?.name === '6529seize-frontend'
        ? 'frontend'
        : payload.repository?.name === '6529seize-backend'
          ? 'backend'
          : null;
    if (repository) {
      await releaseBusService.invalidateBranch(
        repository,
        payload.ref.slice('refs/heads/'.length),
        payload.after.toLowerCase(),
        payload.sender?.login ?? 'github-webhook'
      );
    }
  }
  return res.status(202).json({ accepted: true });
});

export default deployRoutes;
