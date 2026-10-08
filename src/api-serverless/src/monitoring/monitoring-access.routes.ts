import { Request } from 'express';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { isDevTeamMember } from '@/groups/dev-team-access';
import { Logger } from '@/logging';
import { Timer } from '@/time';

async function authorizeMonitoring(req: Request): Promise<void> {
  const timer = Timer.getFromRequest(req);
  let allowed: boolean;
  try {
    const authenticationContext = await getAuthenticationContext(req, timer);
    allowed = await isDevTeamMember(authenticationContext.getActingAsId(), {
      timer,
      authenticationContext
    });
  } catch {
    Logger.get('MonitoringAccess').error(
      'Unable to verify Dev Team membership'
    );
    throw new CustomApiCompliantException(
      503,
      'Monitoring access is temporarily unavailable',
      'MONITORING_ACCESS_UNAVAILABLE'
    );
  }
  if (!allowed) {
    throw new ForbiddenException('6529 Dev Team membership is required');
  }
}

// Mount before every monitoring handler, including generated OpenAPI routes.
const router = asyncRouter();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.use(needsAuthenticatedUser());
router.use((req, _res, next) => {
  void authorizeMonitoring(req).then(() => next(), next);
});

export default router;
