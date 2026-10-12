import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { ApiMemeCollaborationInvitationStatusEnum } from '@/api/generated/models/ApiMemeCollaborationInvitation';
import { enums } from '@/enums';
import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { dropsService } from '@/api/drops/drops.api.service';
import { ApiMemeCollaborationState } from '@/api/generated/models/ApiMemeCollaborationState';
import {
  GetMemeCollaborationStateRequest,
  RespondToMemeCollaborationRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { Timer } from '@/time';
import { ForbiddenException } from '@/exceptions';

export async function getMemeCollaborationState(
  req: GetMemeCollaborationStateRequest
): Promise<ApiMemeCollaborationState> {
  const auth = await getAuthenticationContext(req);
  const ctx = { authenticationContext: auth, timer: Timer.getFromRequest(req) };
  const drop = await dropsService.findDropByIdOrThrow(
    { dropId: req.params.drop_id },
    ctx
  );
  if (drop.moderation?.can_view === false)
    throw new ForbiddenException(
      'This artwork is not available for collaboration review'
    );
  const state = await memeCollaborationsService.state(
    req.params.drop_id,
    auth.getActingAsId(),
    ctx
  );
  return {
    ...state,
    invitations: state.invitations.map((item) => ({
      ...item,
      status: enums.resolveOrThrow(
        ApiMemeCollaborationInvitationStatusEnum,
        item.status
      )
    }))
  };
}

export async function respondToMemeCollaboration(
  req: RespondToMemeCollaborationRequest
): Promise<ApiMemeCollaborationState> {
  const auth = await getAuthenticationContext(req);
  const ctx = { authenticationContext: auth, timer: Timer.getFromRequest(req) };
  const visibleDrop = await dropsService.findDropByIdOrThrow(
    { dropId: req.params.drop_id },
    ctx
  );
  if (visibleDrop.moderation?.can_view === false)
    throw new ForbiddenException(
      'This artwork is not available for collaboration review'
    );
  const body = getValidatedByJoiOrThrow(
    req.body,
    Joi.object({
      action: Joi.string().valid('ACCEPT', 'DECLINE', 'CANCEL').required(),
      artwork_hash: Joi.string().length(64).required(),
      terms_version: Joi.string().length(64).required()
    })
  );
  const notificationIds = await memeCollaborationsService.respond(
    req.params.drop_id,
    req.params.invitation_id,
    body,
    auth,
    ctx
  );
  if (notificationIds.length) {
    const drop = await dropsService.findDropByIdOrThrow(
      { dropId: req.params.drop_id },
      ctx
    );
    await wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, {
      reason: 'collaboration_accepted'
    });
  }
  await sendIdentityPushNotifications(notificationIds);
  const state = await memeCollaborationsService.state(
    req.params.drop_id,
    auth.getActingAsId(),
    ctx
  );
  return {
    ...state,
    invitations: state.invitations.map((item) => ({
      ...item,
      status: enums.resolveOrThrow(
        ApiMemeCollaborationInvitationStatusEnum,
        item.status
      )
    }))
  };
}
