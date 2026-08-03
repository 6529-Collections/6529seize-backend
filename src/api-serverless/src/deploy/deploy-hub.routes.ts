import { asyncRouter } from '@/api/async.router';
import type { ApiDeployHubSession } from '@/api/generated/models/ApiDeployHubSession';
import { requireDeployHubOperator } from '@/api/deploy/deploy-hub.auth';
import { setNoStoreHeaders } from '@/api/response-headers';

const deployHubRoutes = asyncRouter();

deployHubRoutes.get('/session', async (req, res) => {
  const { login } = await requireDeployHubOperator(req);
  const response: ApiDeployHubSession = { login };

  setNoStoreHeaders(res);
  return res.json(response);
});

export default deployHubRoutes;
