import { Request } from 'express';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
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
  ReleaseCandidateReadyBodySchema,
  ReleaseBusV2CandidateActionBodySchema,
  ReleaseBusV2CandidateBodySchema,
  ReleaseBusV2CandidateCancelBodySchema,
  ReleaseBusV2CandidateListQuerySchema,
  ReleaseBusV2ControlBodySchema,
  ReleaseBusV2AuthorizationBodySchema,
  ReleaseBusV2ProgressBodySchema
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
import {
  getReleaseTrainOverview,
  projectReleaseCandidate
} from '@/releaseBus/release-bus-status.service';
import type {
  MarkReleaseReadyInput,
  ReleaseCandidateRecord,
  ReleaseCandidateStatus,
  ReleaseControlScope,
  ReleaseRepository
} from '@/releaseBus/release-bus.types';
import {
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  releaseBusV2BetaAllowsCandidate
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusV2Operations,
  type ReleaseBusV2Progress
} from '@/releaseBusV2/release-bus-v2.operations';
import { releaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { releaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import {
  RELEASE_BUS_V2_CANDIDATE_STATUSES,
  type ReleaseBusV2CandidateStatus,
  type ReleaseBusV2ControlScope,
  type ReleaseBusV2RegisterInput
} from '@/releaseBusV2/release-bus-v2.types';

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
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

function parseReleaseBusV2WorkflowRequest(
  value: unknown
): { workflow?: unknown } | null {
  try {
    return typeof value === 'string'
      ? (JSON.parse(value) as { workflow?: unknown })
      : (value as { workflow?: unknown } | null);
  } catch {
    return null;
  }
}

function targetForRepository(repository: ReleaseRepository) {
  return repository === 'frontend' ? 'frontend' : 'backend';
}

async function requireOperator(token: string): Promise<string> {
  const viewer = await gitHubDeployService.getViewer(token);
  await requireOperatorLogin(viewer.login);
  return viewer.login;
}

async function requireOperatorLogin(login: string): Promise<void> {
  const allowed = await releaseBusGitHubApp.isOrganizationOperator(
    login,
    RELEASE_BUS_OPERATOR_TEAM
  );
  if (!allowed)
    throw new CustomApiCompliantException(
      403,
      'Release-bus operator permission is required'
    );
}

async function requireAuthenticatedViewer(req: Request): Promise<string> {
  const token = getGitHubTokenOrThrow(req);
  return (await gitHubDeployService.getViewer(token)).login;
}

async function requireV2CandidateWriteAccess(
  req: Request,
  candidateId: string
): Promise<string> {
  const token = getGitHubTokenOrThrow(req);
  const viewer = await gitHubDeployService.getViewer(token);
  const candidate = await releaseBusV2Repository.findCandidateById(
    candidateId,
    {}
  );
  if (!candidate)
    throw new CustomApiCompliantException(
      404,
      'Release Bus v2 candidate not found'
    );
  if (getReleaseBusV2Mode() === 'OFF') {
    await requireOperatorLogin(viewer.login);
    let allowed = false;
    try {
      const betaAllowlist = getReleaseBusV2BetaAllowlist();
      allowed =
        candidate.requested_by.toLowerCase() === viewer.login.toLowerCase() &&
        (releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, 'STAGING') ||
          releaseBusV2BetaAllowsCandidate(
            betaAllowlist,
            candidate,
            'PRODUCTION'
          ));
    } catch {
      allowed = false;
    }
    if (!allowed)
      throw new CustomApiCompliantException(
        403,
        'This candidate is not enabled for the operator-only OFF beta'
      );
  }
  await gitHubDeployService.assertRepositoryWriteAccess(
    token,
    targetForRepository(candidate.repository)
  );
  return viewer.login;
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
  return res.json({
    candidates: candidates.map(projectReleaseCandidate),
    mode: getReleaseBusMode()
  });
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

deployRoutes.post('/release-bus-v2/candidates', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const actor =
    getReleaseBusV2Mode() === 'OFF'
      ? await requireOperator(token)
      : (await gitHubDeployService.getViewer(token)).login;
  const body = getValidatedByJoiOrThrow<ReleaseBusV2RegisterInput>(
    req.body,
    ReleaseBusV2CandidateBodySchema
  );
  await gitHubDeployService.assertRepositoryWriteAccess(
    token,
    targetForRepository(body.repository)
  );
  try {
    const candidate = await releaseBusV2Service.register(body, actor);
    setNoStoreHeaders(res);
    return res.status(202).json({ candidate, mode: getReleaseBusV2Mode() });
  } catch (error) {
    throw new CustomApiCompliantException(
      409,
      error instanceof Error
        ? error.message
        : 'Release Bus v2 registration failed'
    );
  }
});

deployRoutes.get('/release-bus-v2/candidates', async (req, res) => {
  await requireAuthenticatedViewer(req);
  const query = getValidatedByJoiOrThrow<{
    status?: ReleaseBusV2CandidateStatus;
    limit: number;
  }>(req.query, ReleaseBusV2CandidateListQuerySchema);
  const candidates = await releaseBusV2Repository.listCandidates(
    query.status ? [query.status] : RELEASE_BUS_V2_CANDIDATE_STATUSES,
    query.limit,
    {}
  );
  const dependencies = await releaseBusV2Repository.listDependencies(
    candidates.map(({ id }) => id),
    {}
  );
  setNoStoreHeaders(res);
  return res.json({
    candidates: candidates.map((candidate) => ({
      ...candidate,
      dependencies: dependencies.filter(
        (dependency) => dependency.candidate_id === candidate.id
      )
    })),
    mode: getReleaseBusV2Mode()
  });
});

deployRoutes.post(
  '/release-bus-v2/candidates/:id/mark-ready-for-production',
  async (req, res) => {
    const actor = await requireV2CandidateWriteAccess(req, req.params.id);
    const body = getValidatedByJoiOrThrow<{
      expected_head_sha: string;
      expected_row_version: number;
    }>(req.body, ReleaseBusV2CandidateActionBodySchema);
    try {
      const candidate = await releaseBusV2Service.markReadyForProduction(
        req.params.id,
        body.expected_head_sha,
        body.expected_row_version,
        actor
      );
      setNoStoreHeaders(res);
      return res.json({ candidate, mode: getReleaseBusV2Mode() });
    } catch (error) {
      throw new CustomApiCompliantException(
        409,
        error instanceof Error
          ? error.message
          : 'Release Bus v2 production readiness failed'
      );
    }
  }
);

deployRoutes.post(
  '/release-bus-v2/candidates/:id/revoke-production-readiness',
  async (req, res) => {
    const actor = await requireV2CandidateWriteAccess(req, req.params.id);
    const body = getValidatedByJoiOrThrow<{ expected_row_version: number }>(
      req.body,
      ReleaseBusV2CandidateCancelBodySchema
    );
    try {
      const candidate = await releaseBusV2Service.revokeProductionReadiness(
        req.params.id,
        body.expected_row_version,
        actor
      );
      setNoStoreHeaders(res);
      return res.json({ candidate });
    } catch (error) {
      throw new CustomApiCompliantException(
        409,
        error instanceof Error
          ? error.message
          : 'Release Bus v2 readiness revocation failed'
      );
    }
  }
);

deployRoutes.post('/release-bus-v2/candidates/:id/cancel', async (req, res) => {
  const actor = await requireV2CandidateWriteAccess(req, req.params.id);
  const body = getValidatedByJoiOrThrow<{ expected_row_version: number }>(
    req.body,
    ReleaseBusV2CandidateCancelBodySchema
  );
  try {
    const candidate = await releaseBusV2Service.cancel(
      req.params.id,
      body.expected_row_version,
      actor
    );
    setNoStoreHeaders(res);
    return res.json({ candidate });
  } catch (error) {
    throw new CustomApiCompliantException(
      409,
      error instanceof Error
        ? error.message
        : 'Release Bus v2 cancellation failed'
    );
  }
});

deployRoutes.get('/release-bus-v2/trains', async (req, res) => {
  await requireAuthenticatedViewer(req);
  setNoStoreHeaders(res);
  return res.json({
    trains: await releaseBusV2Repository.listTrains(100, {}),
    mode: getReleaseBusV2Mode()
  });
});

deployRoutes.get('/release-bus-v2/trains/:id', async (req, res) => {
  await requireAuthenticatedViewer(req);
  const train = await releaseBusV2Repository.findTrain(req.params.id, {});
  if (!train)
    throw new CustomApiCompliantException(
      404,
      'Release Bus v2 train not found'
    );
  const memberships = await releaseBusV2Repository.listTrainCandidates(
    train.id,
    {}
  );
  const candidates = await Promise.all(
    memberships.map((membership) =>
      releaseBusV2Repository.findCandidateById(membership.candidate_id, {})
    )
  );
  const operations = await releaseBusV2Repository.listOperations(train.id, {});
  const operationViews = await Promise.all(
    operations.map(async (operation) => {
      if (
        operation.status !== 'RUNNING' ||
        !operation.repository ||
        !operation.external_id ||
        !/^\d+$/.test(operation.external_id)
      )
        return operation;
      const request = parseReleaseBusV2WorkflowRequest(operation.request_json);
      if (typeof request?.workflow !== 'string') return operation;
      try {
        const workflow = await releaseBusGitHubApp.findWorkflowRun(
          operation.repository,
          request.workflow,
          `${operation.idempotency_key}:a${operation.attempt}`,
          operation.external_id
        );
        return workflow
          ? {
              ...operation,
              workflow_run: {
                id: workflow.id,
                status: workflow.status,
                conclusion: workflow.conclusion,
                html_url: workflow.html_url,
                jobs: workflow.jobs ?? []
              }
            }
          : operation;
      } catch (error) {
        return {
          ...operation,
          workflow_observation_error:
            error instanceof Error
              ? error.message
              : 'Live workflow state is temporarily unavailable'
        };
      }
    })
  );
  setNoStoreHeaders(res);
  return res.json({
    train,
    memberships,
    candidates: candidates.filter(Boolean),
    dependencies: await releaseBusV2Repository.listDependencies(
      candidates
        .filter((candidate): candidate is NonNullable<typeof candidate> =>
          Boolean(candidate)
        )
        .map(({ id }) => id),
      {}
    ),
    operations: operationViews,
    events: await releaseBusV2Repository.listEvents(train.id, 200, {})
  });
});

deployRoutes.get('/release-bus-v2/manifests', async (req, res) => {
  await requireAuthenticatedViewer(req);
  setNoStoreHeaders(res);
  return res.json({
    manifests: await releaseBusV2Repository.listManifests(100, {})
  });
});

deployRoutes.get('/release-bus-v2/controls', async (req, res) => {
  await requireAuthenticatedViewer(req);
  setNoStoreHeaders(res);
  return res.json({
    controls: await releaseBusV2Repository.listControls({}),
    locks: await releaseBusV2Repository.listLocks({}),
    mode: getReleaseBusV2Mode()
  });
});

async function updateBusV2Control(req: Request, paused: boolean) {
  const token = getGitHubTokenOrThrow(req);
  const actor = await requireOperator(token);
  const body = getValidatedByJoiOrThrow<{
    scope: ReleaseBusV2ControlScope;
    reason: string;
  }>(req.body, ReleaseBusV2ControlBodySchema);
  await releaseBusV2Service.setPaused(body.scope, paused, body.reason, actor);
  return {
    controls: await releaseBusV2Repository.listControls({}),
    mode: getReleaseBusV2Mode()
  };
}

deployRoutes.post('/release-bus-v2/pause', async (req, res) => {
  setNoStoreHeaders(res);
  return res.json(await updateBusV2Control(req, true));
});

deployRoutes.post('/release-bus-v2/resume', async (req, res) => {
  setNoStoreHeaders(res);
  return res.json(await updateBusV2Control(req, false));
});

deployRoutes.post('/release-bus-v2/reconcile', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const actor = await requireOperator(token);
  await releaseBusV2Repository.appendEvent(
    {
      eventType: 'MANUAL_RECONCILE_REQUESTED',
      actor,
      payload: { requested_at: Date.now() }
    },
    {}
  );
  const mode = getReleaseBusV2Mode();
  let betaEnabledForActor = false;
  if (mode === 'OFF') {
    try {
      betaEnabledForActor = getReleaseBusV2BetaAllowlist().some(
        (entry) => entry.operator === actor.toLowerCase()
      );
    } catch {
      throw new CustomApiCompliantException(
        409,
        'Release Bus v2 beta allowlist is invalid; automation remains OFF'
      );
    }
  }
  if (mode !== 'OFF' || betaEnabledForActor) {
    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: 'releaseBusV2Reconciler',
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({ requested_by: actor, requested_at: Date.now() })
          )
        })
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Release Bus v2 reconciler invocation failed';
      await releaseBusV2Repository.appendEvent(
        {
          eventType: 'MANUAL_RECONCILE_DISPATCH_FAILED',
          actor,
          payload: { failed_at: Date.now(), message }
        },
        {}
      );
      setNoStoreHeaders(res);
      return res.status(503).json({
        accepted: false,
        mode,
        requested_by: actor,
        execution: 'dispatch_failed',
        error: `Release Bus v2 reconciliation was not queued: ${message}`
      });
    }
  }
  setNoStoreHeaders(res);
  let execution = 'queued_on_reserved_worker';
  if (mode === 'OFF') {
    execution = betaEnabledForActor ? 'queued_operator_beta' : 'disabled';
  }
  return res.status(202).json({
    accepted: mode !== 'OFF' || betaEnabledForActor,
    mode,
    requested_by: actor,
    execution
  });
});

async function requireV2TrainAutomationAllowed(trainId: string) {
  if (getReleaseBusV2Mode() !== 'OFF') return;
  let allowed = false;
  try {
    const train = await releaseBusV2Repository.findTrain(trainId, {});
    allowed = Boolean(
      train && (await releaseBusV2Service.isBetaTrainAllowed(train))
    );
  } catch {
    allowed = false;
  }
  if (!allowed)
    throw new CustomApiCompliantException(
      403,
      'Release Bus v2 workflow is not allowlisted for the OFF beta'
    );
}

deployRoutes.post('/release-bus-v2/authorize', async (req, res) => {
  requireWorkflowCredential(req);
  // This endpoint deliberately uses the versioned schema; v1 authorization
  // does not accept or route rb2 operation keys.
  const authorization = getValidatedByJoiOrThrow<{
    train_id: string;
    operation_key: string;
    workflow_run_id: string;
    artifact_run_id: string | null;
    repository: ReleaseRepository;
    environment: 'orchestration' | 'staging' | 'prod';
    service: string | null;
    expected_sha: string;
    artifact_digest: string | null;
  }>(req.body, ReleaseBusV2AuthorizationBodySchema);
  await requireV2TrainAutomationAllowed(authorization.train_id);
  try {
    const result = await releaseBusV2Operations.authorize(authorization);
    setNoStoreHeaders(res);
    return res.json({
      ...result,
      train_id: authorization.train_id,
      operation_key: authorization.operation_key
    });
  } catch (error) {
    throw new CustomApiCompliantException(
      409,
      error instanceof Error
        ? error.message
        : 'Release Bus v2 authorization failed'
    );
  }
});

deployRoutes.post('/release-bus-v2/report-progress', async (req, res) => {
  requireWorkflowCredential(req);
  const body = getValidatedByJoiOrThrow<ReleaseBusV2Progress>(
    req.body,
    ReleaseBusV2ProgressBodySchema
  );
  await requireV2TrainAutomationAllowed(body.train_id);
  try {
    const result = await releaseBusV2Operations.reportProgress(body);
    setNoStoreHeaders(res);
    return res.json(result);
  } catch (error) {
    throw new CustomApiCompliantException(
      409,
      error instanceof Error
        ? error.message
        : 'Release Bus v2 progress report failed'
    );
  }
});

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
    failure_phase:
      | 'dependency_install'
      | 'gate'
      | 'release_branch_publication'
      | null;
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
      kind: 'base_canary_summary' | 'frontend_preflight_base_evidence_summary';
      base_sha: string;
      environment: 'orchestration' | 'staging' | 'prod';
      gate_fingerprint: string;
      behavior_digest: string | null;
      build_profile_digest: string | null;
      workflow_sha: string;
      workflow_digest: string;
      node_version: string;
      package_manager: string;
      gate_mode: 'legacy' | 'shadow' | 'sharded' | null;
      shard_count: number;
      summary_artifact_name: string;
      summary_artifact_digest: string;
      phase_durations_ms: Record<string, number>;
      totals: Record<string, number>;
      fresh_or_reused: 'fresh' | 'reused';
      shards: Array<Record<string, string | number>>;
      missing_files: string[];
      duplicate_files: string[];
      unexpected_files: string[];
      proof_origin: string | null;
      build_environments: string[];
      build_coverage: {
        authoritative_profile?: string;
        compilation_count?: number;
        deployed_artifact_bound?: boolean;
        base_canary_profile?: string;
        deploy_artifact_profile?: string;
      } | null;
      immutable_artifact: Record<string, unknown> | null;
    } | null;
    build_profile_digest: string | null;
    backend_evidence: Record<string, unknown> | null;
  }>(req.body, ReleaseBusProgressReportBodySchema);
  const reportContent = {
    phase: body.phase,
    status: body.status,
    failure_class: body.failure_class,
    failure_phase: body.failure_phase,
    retryable: body.retryable,
    stages: body.stages,
    jest: body.jest,
    summary: body.summary,
    build_profile_digest: body.build_profile_digest,
    backend_evidence: body.backend_evidence
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
      const isFrontendBaseIdentity =
        operation.operation_type === 'base-evidence-identity-frontend';
      const isBackendPreflight =
        operation.operation_type === 'preflight-backend';
      const isFrontendBaseEvidenceProducer =
        isFrontendBaseCanary ||
        operation.operation_type === 'preflight-frontend';
      const summaryKindMatchesOperation = body.summary
        ? (isFrontendBaseCanary &&
            body.summary.kind === 'base_canary_summary') ||
          (operation.operation_type === 'preflight-frontend' &&
            body.summary.kind === 'frontend_preflight_base_evidence_summary')
        : true;
      // Aggregate summaries are base-canary evidence. Other operations report
      // bounded stages/Jest data but must not claim reusable base evidence.
      if (isFrontendBaseCanary && body.phase === 'complete' && !body.summary) {
        throw new CustomApiCompliantException(
          422,
          'A terminal frontend base canary report requires its aggregate summary'
        );
      }
      if (
        (body.build_profile_digest && !isFrontendBaseIdentity) ||
        (isFrontendBaseIdentity &&
          body.phase === 'complete' &&
          body.status === 'SUCCEEDED' &&
          !body.build_profile_digest)
      ) {
        throw new CustomApiCompliantException(
          422,
          'Build-profile identity does not match this Release Bus operation'
        );
      }
      if (
        (body.backend_evidence &&
          (!isBackendPreflight ||
            body.status !== 'SUCCEEDED' ||
            operation.expected_sha?.toLowerCase() !==
              String(body.backend_evidence.source_sha).toLowerCase())) ||
        (isBackendPreflight &&
          body.phase === 'complete' &&
          body.status === 'SUCCEEDED' &&
          !body.backend_evidence)
      ) {
        throw new CustomApiCompliantException(
          422,
          'Backend exact-tree evidence does not match this preflight operation'
        );
      }
      if (
        body.summary &&
        (!isFrontendBaseEvidenceProducer ||
          !summaryKindMatchesOperation ||
          operation.expected_sha?.toLowerCase() !==
            body.summary.base_sha.toLowerCase() ||
          operation.environment?.toLowerCase() !==
            body.summary.environment.toLowerCase())
      ) {
        throw new CustomApiCompliantException(
          403,
          'Release progress aggregate does not match the authorized base canary operation or preflight base-evidence operation'
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
        const persistedSummary =
          existingGateReport.summary &&
          typeof existingGateReport.summary === 'object'
            ? (existingGateReport.summary as Record<string, unknown>)
            : null;
        const persistedTotals =
          persistedSummary?.totals &&
          typeof persistedSummary.totals === 'object'
            ? (persistedSummary.totals as Record<string, unknown>)
            : null;
        const normalizedPersistedSummary = persistedSummary
          ? {
              kind: persistedSummary.kind ?? 'base_canary_summary',
              ...persistedSummary,
              behavior_digest: persistedSummary.behavior_digest ?? null,
              build_profile_digest:
                persistedSummary.build_profile_digest ?? null,
              gate_mode: persistedSummary.gate_mode ?? null,
              totals: persistedTotals
                ? {
                    ...persistedTotals,
                    skipped_tests: persistedTotals.skipped_tests ?? 0,
                    skipped_test_suites:
                      persistedTotals.skipped_test_suites ?? 0
                  }
                : persistedTotals,
              unexpected_files: persistedSummary.unexpected_files ?? [],
              proof_origin: persistedSummary.proof_origin ?? null,
              build_environments: persistedSummary.build_environments ?? [],
              build_coverage: persistedSummary.build_coverage ?? null,
              immutable_artifact: persistedSummary.immutable_artifact ?? null
            }
          : null;
        const persistedContent = {
          phase: existingGateReport.phase,
          status: existingGateReport.status,
          failure_class: existingGateReport.failure_class ?? null,
          failure_phase: existingGateReport.failure_phase ?? null,
          retryable: existingGateReport.retryable === true,
          stages: existingGateReport.stages,
          jest: existingGateReport.jest,
          summary: normalizedPersistedSummary,
          build_profile_digest: existingGateReport.build_profile_digest ?? null,
          backend_evidence: existingGateReport.backend_evidence ?? null
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
      if (body.summary) {
        const summaryDigest = body.summary.summary_artifact_digest.replace(
          /^sha256:/,
          ''
        );
        const boundDigest = operation.artifact_digest?.replace(/^sha256:/, '');
        if (boundDigest && boundDigest !== summaryDigest) {
          throw new CustomApiCompliantException(
            409,
            'A different aggregate artifact digest already claimed this release operation'
          );
        }
        if (
          !boundDigest &&
          !(await releaseBusRepository.bindOperationAuthorization(
            body.operation_key,
            body.workflow_run_id,
            summaryDigest,
            context
          ))
        ) {
          throw new CustomApiCompliantException(
            409,
            'The aggregate artifact digest could not be bound to this release operation'
          );
        }
      }
      if (body.backend_evidence) {
        const artifactDigest = String(
          body.backend_evidence.artifact_digest
        ).replace(/^sha256:/, '');
        const boundDigest = operation.artifact_digest?.replace(/^sha256:/, '');
        if (boundDigest && boundDigest !== artifactDigest) {
          throw new CustomApiCompliantException(
            409,
            'A different backend preflight artifact digest already claimed this operation'
          );
        }
        if (
          !boundDigest &&
          !(await releaseBusRepository.bindOperationAuthorization(
            body.operation_key,
            body.workflow_run_id,
            artifactDigest,
            context
          ))
        ) {
          throw new CustomApiCompliantException(
            409,
            'The backend preflight artifact digest could not be bound to this operation'
          );
        }
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
            summary: body.summary,
            build_profile_digest: body.build_profile_digest,
            backend_evidence: body.backend_evidence
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
      await releaseBusV2Service.invalidateBranch(
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
