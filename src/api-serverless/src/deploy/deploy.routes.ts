import { Request } from 'express';
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
import { DeployDispatchBodySchema } from '@/api/deploy/deploy.validation';
import { setNoStoreHeaders } from '@/api/response-headers';
import { getValidatedByJoiOrThrow } from '@/api/validation';

function getGitHubTokenOrThrow(req: Request): string {
  const authorizationHeader = req.get('authorization');
  if (
    authorizationHeader &&
    authorizationHeader.toLowerCase().startsWith('bearer ')
  ) {
    const token = authorizationHeader.slice('bearer '.length).trim();
    if (token) {
      return token;
    }
  }

  const token = req.get('x-github-token')?.trim();
  if (token) {
    return token;
  }

  throw new CustomApiCompliantException(
    401,
    'GitHub token is required for this route'
  );
}

const deployRoutes = asyncRouter();

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
  const page =
    typeof req.query.page === 'string'
      ? Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 1000))
      : 1;
  const pageSize =
    typeof req.query.page_size === 'string'
      ? Math.max(1, Math.min(Number.parseInt(req.query.page_size, 10) || 8, 20))
      : 8;

  setNoStoreHeaders(res);
  return res.json({
    runs_page: await gitHubDeployService.listRecentRuns({
      token,
      page,
      pageSize
    })
  });
});

deployRoutes.get('/ui/refs', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const query =
    typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';

  setNoStoreHeaders(res);
  return res.json({
    refs: await gitHubDeployService.listRefs(token, query, 20)
  });
});

deployRoutes.post('/ui/dispatch', async (req, res) => {
  const token = getGitHubTokenOrThrow(req);
  const body = getValidatedByJoiOrThrow(req.body, DeployDispatchBodySchema);
  const invalidService = body.services.find(
    (service: string) =>
      !canDeployServiceToEnvironment(service, body.environment)
  );

  if (invalidService) {
    throw new CustomApiCompliantException(
      400,
      `${invalidService} cannot be deployed to ${body.environment}`
    );
  }

  const results: Array<{ service: string; ok: boolean; message: string }> = [];

  for (const service of body.services) {
    try {
      await gitHubDeployService.dispatchDeploy({
        token,
        ref: body.ref,
        service,
        environment: body.environment
      });
      results.push({
        service,
        ok: true,
        message: `Dispatched ${service} to ${body.environment} from ${body.ref}`
      });
    } catch (err) {
      results.push({
        service,
        ok: false,
        message:
          err instanceof Error ? err.message : 'Unknown GitHub deploy error'
      });
    }
  }

  setNoStoreHeaders(res);
  return res.json({
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

export default deployRoutes;
