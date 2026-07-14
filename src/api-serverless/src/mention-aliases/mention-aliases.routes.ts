import { Request, Response } from 'express';
import * as Joi from 'joi';
import { asyncRouter } from '../async.router';
import { ApiResponse } from '../api-response';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { getValidatedByJoiOrThrow } from '../validation';
import { ForbiddenException } from '@/exceptions';
import {
  MAX_MEMBERS_PER_MENTION_ALIAS,
  MENTION_ALIAS_MAX_LENGTH,
  MENTION_ALIAS_MIN_LENGTH
} from '@/mention-aliases/mention-aliases.constants';
import {
  MentionAliasInput,
  mentionAliasesService
} from '@/mention-aliases/mention-aliases.service';
import { MentionAlias } from '@/mention-aliases/mention-aliases.db';

const router = asyncRouter();

const MentionAliasInputSchema: Joi.ObjectSchema<MentionAliasInput> = Joi.object(
  {
    alias: Joi.string()
      .trim()
      .min(MENTION_ALIAS_MIN_LENGTH)
      .max(MENTION_ALIAS_MAX_LENGTH + 1)
      .required(),
    member_profile_ids: Joi.array()
      .items(Joi.string().required())
      .min(1)
      .max(MAX_MEMBERS_PER_MENTION_ALIAS)
      .required()
  }
);

async function getOwnerProfileId(req: Request): Promise<string> {
  const context = await getAuthenticationContext(req);
  if (context.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(
      'Mention shortcuts are unavailable while acting as a proxy.'
    );
  }
  const ownerProfileId = context.getLoggedInUsersProfileId();
  if (!ownerProfileId) {
    throw new ForbiddenException('A profile is required.');
  }
  return ownerProfileId;
}

router.get(
  '/',
  needsAuthenticatedUser(),
  async (req: Request, res: Response<ApiResponse<MentionAlias[]>>) => {
    const ownerProfileId = await getOwnerProfileId(req);
    res.status(200).send(await mentionAliasesService.list(ownerProfileId));
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, MentionAliasInput>,
    res: Response<ApiResponse<MentionAlias>>
  ) => {
    const ownerProfileId = await getOwnerProfileId(req);
    const input = getValidatedByJoiOrThrow(req.body, MentionAliasInputSchema);
    res
      .status(201)
      .send(await mentionAliasesService.create(ownerProfileId, input));
  }
);

router.put(
  '/:aliasId',
  needsAuthenticatedUser(),
  async (
    req: Request<{ aliasId: string }, any, MentionAliasInput>,
    res: Response<ApiResponse<MentionAlias>>
  ) => {
    const ownerProfileId = await getOwnerProfileId(req);
    const input = getValidatedByJoiOrThrow(req.body, MentionAliasInputSchema);
    res
      .status(200)
      .send(
        await mentionAliasesService.update(
          ownerProfileId,
          req.params.aliasId,
          input
        )
      );
  }
);

router.delete(
  '/:aliasId',
  needsAuthenticatedUser(),
  async (
    req: Request<{ aliasId: string }>,
    res: Response<ApiResponse<void>>
  ) => {
    const ownerProfileId = await getOwnerProfileId(req);
    await mentionAliasesService.delete(ownerProfileId, req.params.aliasId);
    res.status(204).send();
  }
);

export default router;
