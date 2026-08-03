import type { Request } from 'express';
import { CustomApiCompliantException } from '@/exceptions';
import { gitHubDeployService } from '@/api/deploy/deploy.github.service';

const DEPLOY_ORGANIZATION = '6529-Collections';
const DEPLOY_OPERATOR_TEAM =
  process.env.RELEASE_BUS_OPERATOR_TEAM ?? 'release-bus-operators';

type DeployHubAuthContext = {
  readonly login: string;
  readonly token: string;
};

function getGitHubBearerTokenOrThrow(req: Request): string {
  const authorization = req.get('authorization')?.trim() ?? '';
  const [scheme, token, unexpected] = authorization.split(/\s+/);

  if (scheme?.toLowerCase() !== 'bearer' || !token || unexpected) {
    throw new CustomApiCompliantException(
      401,
      'GitHub token is required for this route'
    );
  }

  return token;
}

export async function requireDeployHubOperator(
  req: Request
): Promise<DeployHubAuthContext> {
  const token = getGitHubBearerTokenOrThrow(req);
  const viewer = await gitHubDeployService.getViewer(token);
  const operator = await gitHubDeployService.isOrganizationOperator(
    token,
    viewer.login,
    DEPLOY_ORGANIZATION,
    DEPLOY_OPERATOR_TEAM
  );

  if (!operator) {
    throw new CustomApiCompliantException(
      403,
      'Deployment operator permission is required'
    );
  }

  return { login: viewer.login, token };
}
