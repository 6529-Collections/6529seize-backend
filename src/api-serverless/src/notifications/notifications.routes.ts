import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { ApiNotificationsResponse } from '../generated/models/ApiNotificationsResponse';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { notificationsApiService } from './notifications.api.service';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { IdentityNotificationCause } from '../../../entities/IIdentityNotification';
import { Timer } from '../../../time';
import { numbers } from '../../../numbers';

const router = asyncRouter();

const causesValidator = (value: unknown, helpers: Joi.CustomHelpers) => {
  if (typeof value !== 'string') return null;
  const values = value.split(',').map((v) => v.trim());
  const validCauses = Object.values(IdentityNotificationCause);
  for (const val of values) {
    if (!validCauses.includes(val as IdentityNotificationCause)) {
      return helpers.error('any.invalid');
    }
  }
  return value;
};

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
        cause: string | null;
        cause_exclude: string | null;
        unread_only: boolean;
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
        cause: string | null;
        cause_exclude: string | null;
        unread_only: boolean;
      }>({
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
  ['/read', '/all/read'],
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot access notifications`);
    }
    await notificationsApiService.markAllNotificationsAsRead(
      authenticationContext.getActingAsId()!,
      { timer }
    );
    res.send({});
  }
);

router.post(
  '/:id/read',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
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
    if (numbers.parseIntOrNull(id) !== null) {
      await notificationsApiService.markNotificationAsRead({
        id: parseInt(id),
        identity_id: authenticationContext.getActingAsId()!
      });
    } else {
      throw new BadRequestException(
        `Invalid notification id: ${id}. Supply a correct one or 'all' to mark all as read.`
      );
    }
    res.send({});
  }
);

router.post(
  '/:id/unread',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
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
    if (numbers.parseIntOrNull(id) !== null) {
      await notificationsApiService.markNotificationAsUnread({
        id: parseInt(id),
        identity_id: authenticationContext.getActingAsId()!
      });
    } else {
      throw new BadRequestException(`Invalid notification id: ${id}.`);
    }
    res.send({});
  }
);

router.post(
  '/wave/:wave_id/read',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot access notifications`);
    }
    const waveId = req.params.wave_id;
    await notificationsApiService.markWaveNotificationsAsRead(
      waveId,
      authenticationContext.getActingAsId()!,
      { timer }
    );
    res.send({});
  }
);

router.get(
  '/wave-subscription/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed: boolean }>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    const waveId = req.params.wave_id;
    if (!waveId) {
      throw new BadRequestException(`Wave ID is required`);
    }
    const waveSubscription = await notificationsApiService.getWaveSubscription(
      authenticationContext.getActingAsId()!,
      waveId
    );
    res.send({
      subscribed: waveSubscription
    });
  }
);

router.post(
  '/wave-subscription/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed: boolean }>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    const waveId = req.params.wave_id;
    if (!waveId) {
      throw new BadRequestException(`Wave ID is required`);
    }
    await notificationsApiService.subscribeToAllWaveDrops(
      authenticationContext.getActingAsId()!,
      waveId
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({
      subscribed: true
    });
  }
);

router.delete(
  '/wave-subscription/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed: boolean }>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `You need to create a profile before you can access notifications`
      );
    }
    const waveId = req.params.wave_id;
    if (!waveId) {
      throw new BadRequestException(`Wave ID is required`);
    }
    await notificationsApiService.unsubscribeFromAllWaveDrops(
      authenticationContext.getActingAsId()!,
      waveId
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({
      subscribed: false
    });
  }
);

export default router;
