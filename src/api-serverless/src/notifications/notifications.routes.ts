import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { ApiNotificationsResponse } from '../generated/models/ApiNotificationsResponse';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { notificationsApiService } from './notifications.api.service';
import { parseIntOrNull } from '../../../helpers';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        id_less_than: number | null;
        limit: number;
      },
      any
    >,
    res: Response<ApiResponse<ApiNotificationsResponse>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot access notifications`);
    }
    const request = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<{
        id_less_than: number | null;
        limit: number;
      }>({
        id_less_than: Joi.number().optional().integer().default(null),
        limit: Joi.number().optional().integer().default(10).min(1).max(100)
      })
    );
    const notifications = await notificationsApiService.getNotifications(
      request,
      authenticationContext
    );
    res.send(notifications);
  }
);

router.post(
  '/:id/read',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<void>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot access notifications`);
    }
    const id = req.params.id;
    if (parseIntOrNull(id) !== null) {
      await notificationsApiService.markNotificationAsRead({
        id: parseInt(id),
        identity_id: authenticationContext.getActingAsId()!
      });
    } else if (id?.toLowerCase() === 'all') {
      await notificationsApiService.markAllNotificationsAsRead(
        authenticationContext.getActingAsId()!
      );
    } else {
      throw new BadRequestException(
        `Invalid notification id: ${id}. Supply a correct one or 'all' to mark all as read.`
      );
    }
    await giveReadReplicaTimeToCatchUp();
    res.send();
  }
);

export default router;
