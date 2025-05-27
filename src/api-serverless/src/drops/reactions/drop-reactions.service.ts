import { dropsDb, DropsDb } from '../../../../drops/drops.db';
import { ForbiddenException, NotFoundException } from '../../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../../api-helpers';
import { RequestContext } from '../../../../request.context';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../../ws/ws-listeners-notifier';
import { DropsApiService, dropsService } from '../drops.api.service';
import { reactionsService, ReactionsService } from './reactions.service';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiResponse } from '../../api-response';
import { getAuthenticationContext } from '../../auth/auth';
import { userGroupsService } from '../../community-members/user-groups.service';
import { ApiDrop } from '../../generated/models/ApiDrop';
import { getValidatedByJoiOrThrow } from '../../validation';
import { ProfileProxyActionType } from '../../../../entities/IProfileProxyAction';
import { Timer } from '../../../../time';
import {
  ApiAddReactionToDropRequest,
  ApiAddReactionToDropRequestSchema
} from '../drop.validator';
import { NewDropReaction } from './reactions.db';

export class DropReactionsService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly reactionsService: ReactionsService,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropsService: DropsApiService
  ) {}

  public reactionHandler =
    (isDeleting: boolean): RequestHandler =>
    async (
      req: Request<any, any, ApiAddReactionToDropRequest, any, any>,
      res: Response<ApiResponse<ApiDrop>>,
      next: NextFunction
    ) => {
      try {
        const { reaction } = getValidatedByJoiOrThrow(
          req.body,
          ApiAddReactionToDropRequestSchema
        );

        const timer = Timer.getFromRequest(req);
        const authenticationContext = await getAuthenticationContext(
          req,
          timer
        );
        const profileId = authenticationContext.getActingAsId();
        if (!profileId) {
          throw new ForbiddenException(
            `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
          );
        }
        if (
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ProfileProxyActionType.RATE_WAVE_DROP
          ]
        ) {
          throw new ForbiddenException(
            `Proxy doesn't have permission to ${
              isDeleting ? 'remove' : 'add'
            } reactions`
          );
        }

        const groupIdsUserIsEligibleFor =
          await userGroupsService.getGroupsUserIsEligibleFor(profileId, timer);

        await this.updateReaction(
          {
            profileId,
            groupIdsUserIsEligibleFor,
            dropId: req.params.drop_id,
            reaction,
            isDeleting
          },
          { timer, authenticationContext }
        );

        const drop = await this.dropsService.findDropByIdOrThrow(
          { dropId: req.params.drop_id },
          { authenticationContext, timer }
        );
        return res.send(drop);
      } catch (error) {
        return next(error);
      }
    };

  async updateReaction(
    param: {
      profileId: string;
      dropId: string;
      groupIdsUserIsEligibleFor: string[];
      reaction: string;
      isDeleting: boolean;
    },
    ctx: RequestContext
  ) {
    const drop = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
          param.dropId,
          param.groupIdsUserIsEligibleFor,
          connection
        );
        const ctxWithConnection = { ...ctx, connection };
        if (!dropEntity) {
          throw new NotFoundException(`Drop ${param.dropId} not found`);
        }
        const newReaction: NewDropReaction = {
          profileId: param.profileId,
          dropId: param.dropId,
          waveId: dropEntity.wave_id,
          reaction: param.reaction,
          isDeleting: param.isDeleting
        };
        await this.reactionsService.react(newReaction, ctxWithConnection);
        return await this.dropsService.findDropByIdOrThrow(
          {
            dropId: param.dropId,
            skipEligibilityCheck: true
          },
          ctxWithConnection
        );
      }
    );
    await this.wsListenersNotifier.notifyAboutDropRatingUpdate(drop, ctx);
    await giveReadReplicaTimeToCatchUp();
  }
}

export const dropReactionsService = new DropReactionsService(
  dropsDb,
  reactionsService,
  wsListenersNotifier,
  dropsService
);
