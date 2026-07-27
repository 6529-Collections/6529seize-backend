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
import { releaseBusGitHubApp } from '@/releaseBusV2/release-bus-v2.github-app';
import {
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  RELEASE_BUS_OPERATOR_TEAM,
  releaseBusV2BetaAllowsCandidate
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusV2Operations,
  type ReleaseBusV2Progress
} from '@/releaseBusV2/release-bus-v2.operations';
import { releaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { releaseBusV2Reconciler } from '@/releaseBusV2/release-bus-v2.reconciler';
import { releaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import {
  RELEASE_BUS_V2_CANDIDATE_STATUSES,
  type ReleaseBusV2Repository,
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

function targetForRepository(repository: ReleaseBusV2Repository) {
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
  const target = targetForRepository(repository as ReleaseBusV2Repository);
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
  if (['STAGING', 'PRODUCTION'].includes(getReleaseBusV2Mode())) {
    throw new CustomApiCompliantException(
      409,
      'Manual deployment is unavailable while Release Bus v2 is enabled; an operator must switch v2 OFF before using the serialized fallback'
    );
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

deployRoutes.post(
  '/release-bus-v2/maintenance/recover-stalled-qualifications',
  async (req, res) => {
    const token = getGitHubTokenOrThrow(req);
    const actor = await requireOperator(token);
    try {
      const result =
        await releaseBusV2Reconciler.recoverUnsatisfiableProductionQualifications(
          actor
        );
      setNoStoreHeaders(res);
      return res.json({
        ...result,
        mode: getReleaseBusV2Mode(),
        recovered_by: actor
      });
    } catch (error) {
      throw new CustomApiCompliantException(
        409,
        error instanceof Error
          ? error.message
          : 'Stalled production qualification recovery failed'
      );
    }
  }
);

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
  // The versioned schema accepts only exact v2 operation keys.
  const authorization = getValidatedByJoiOrThrow<{
    train_id: string;
    operation_key: string;
    workflow_run_id: string;
    artifact_run_id: string | null;
    repository: ReleaseBusV2Repository;
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
