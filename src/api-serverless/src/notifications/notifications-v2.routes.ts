import { Request, Response } from 'express';
import * as Joi from 'joi';
import { AuthenticationContext } from '@/auth-context';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { ApiNotificationsResponseV2 } from '@/api/generated/models/ApiNotificationsResponseV2';
import { notificationsApiService } from '@/api/notifications/notifications.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';

const router = asyncRouter();

interface GetNotificationsV2Request {
  id_less_than: number | null;
  limit: number;
  cause: string | null;
  cause_exclude: string | null;
  unread_only: boolean;
}

const causesValidator = (value: unknown, helpers: Joi.CustomHelpers) => {
  if (typeof value !== 'string') return null;
  const values = value.split(',').map((v) => v.trim());
  const validCauses = Object.values(IdentityNotificationCause);
  for (const val of values) {
    if (!validCauses.includes(val as IdentityNotificationCause)) {
      return helpers.error('any.invalid');
    }
  }
  return values.join(',');
};

function assertCanAccessNotifications(
  authenticationContext: AuthenticationContext
) {
  if (!authenticationContext.getActingAsId()) {
    throw new ForbiddenException(
      `You need to create a profile before you can access notifications`
    );
  }
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(`Proxies cannot access notifications`);
  }
}

const GetNotificationsV2RequestSchema = Joi.object<GetNotificationsV2Request>({
  id_less_than: Joi.number().optional().integer().default(null),
  limit: Joi.number().optional().integer().default(10).min(1).max(100),
  cause: Joi.string()
    .optional()
    .custom(
      causesValidator,
      'Comma-separated IdentityNotificationCause validation'
    )
    .default(null),
  cause_exclude: Joi.string()
    .optional()
    .custom(
      causesValidator,
      'Comma-separated IdentityNotificationCause validation'
    )
    .default(null),
  unread_only: Joi.boolean().optional().default(false)
});

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, GetNotificationsV2Request, any>,
    res: Response<ApiResponse<ApiNotificationsResponseV2>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    assertCanAccessNotifications(authenticationContext);
    const request = getValidatedByJoiOrThrow(
      req.query,
      GetNotificationsV2RequestSchema
    );
    const notifications = await notificationsApiService.getNotificationsV2(
      request,
      authenticationContext,
      { timer, authenticationContext }
    );
    res.send(notifications);
  }
);

export default router;
