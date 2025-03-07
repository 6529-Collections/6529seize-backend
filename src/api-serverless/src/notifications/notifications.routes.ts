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
import { SEIZE_SETTINGS } from '../api-constants';

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
    if (id.toLowerCase().startsWith('wave:')) {
      const waveId = id.split(':')[1];
      if (!waveId) {
        throw new BadRequestException(`Wave ID is malformed`);
      }
      await notificationsApiService.markWaveNotificationsAsRead(
        waveId,
        authenticationContext.getActingAsId()!
      );
    } else if (parseIntOrNull(id) !== null) {
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

router.get(
  '/subscribe-to-all-drops/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed_to_all_drops: boolean }>>
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
      subscribed_to_all_drops: waveSubscription
    });
  }
);

router.post(
  '/subscribe-to-all-drops/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed_to_all_drops: boolean }>>
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
    const waveMembersCount = await notificationsApiService.countWaveSubscribers(
      waveId
    );
    if (waveMembersCount === 0) {
      throw new BadRequestException(`Wave has no subscribers`);
    }
    if (
      waveMembersCount >=
      SEIZE_SETTINGS.all_drops_notifications_subscribers_limit
    ) {
      throw new BadRequestException(
        `Wave has too many subscribers (${waveMembersCount}). Max is ${SEIZE_SETTINGS.all_drops_notifications_subscribers_limit}.`
      );
    }
    await notificationsApiService.subscribeToAllWaveDrops(
      authenticationContext.getActingAsId()!,
      waveId
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({
      subscribed_to_all_drops: true
    });
  }
);

router.delete(
  '/subscribe-to-all-drops/:wave_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ wave_id: string }, any, any, any, any>,
    res: Response<ApiResponse<{ subscribed_to_all_drops: boolean }>>
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
      subscribed_to_all_drops: false
    });
  }
);

export default router;
