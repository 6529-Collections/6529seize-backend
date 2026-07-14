import { Request, Response } from 'express';
import * as Joi from 'joi';
import { asyncRouter } from '@/api/async.router';
import { ApiResponse } from '@/api/api-response';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ForbiddenException } from '@/exceptions';
import { MAX_MEMBERS_PER_MENTION_ALIAS } from '@/mention-aliases/mention-aliases.constants';
import {
  MentionAliasInput,
  mentionAliasesService
} from '@/mention-aliases/mention-aliases.service';
import { MentionAlias } from '@/mention-aliases/mention-aliases.db';
import { ApiMentionAlias } from '@/api/generated/models/ApiMentionAlias';
import { ApiMentionAliasRequest } from '@/api/generated/models/ApiMentionAliasRequest';

const router = asyncRouter();

const MentionAliasInputSchema: Joi.ObjectSchema<ApiMentionAliasRequest> =
  Joi.object({
    alias: Joi.string()
      .trim()
      .pattern(/^@?[A-Za-z0-9_]{3,15}$/)
      .required(),
    member_profile_ids: Joi.array()
      .items(
        Joi.string()
          .max(100)
          .pattern(/^[A-Za-z0-9_-]+$/)
          .required()
      )
      .min(1)
      .max(MAX_MEMBERS_PER_MENTION_ALIAS)
      .required()
  });

const AliasIdSchema = Joi.string()
  .guid({ version: ['uuidv4'] })
  .required();

function toApiMentionAlias(alias: MentionAlias): ApiMentionAlias {
  return {
    id: alias.id,
    alias: alias.alias,
    members: alias.members
  };
}

function toServiceInput(input: ApiMentionAliasRequest): MentionAliasInput {
  return {
    alias: input.alias,
    member_profile_ids: Array.from(input.member_profile_ids)
  };
}

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
  async (req: Request, res: Response<ApiResponse<ApiMentionAlias[]>>) => {
    const ownerProfileId = await getOwnerProfileId(req);
    const aliases = await mentionAliasesService.list(ownerProfileId);
    res.status(200).send(aliases.map(toApiMentionAlias));
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiMentionAliasRequest>,
    res: Response<ApiResponse<ApiMentionAlias>>
  ) => {
    const ownerProfileId = await getOwnerProfileId(req);
    const input = getValidatedByJoiOrThrow(req.body, MentionAliasInputSchema);
    res
      .status(201)
      .send(
        toApiMentionAlias(
          await mentionAliasesService.create(
            ownerProfileId,
            toServiceInput(input)
          )
        )
      );
  }
);

router.put(
  '/:aliasId',
  needsAuthenticatedUser(),
  async (
    req: Request<{ aliasId: string }, any, ApiMentionAliasRequest>,
    res: Response<ApiResponse<ApiMentionAlias>>
  ) => {
    const ownerProfileId = await getOwnerProfileId(req);
    const input = getValidatedByJoiOrThrow(req.body, MentionAliasInputSchema);
    const aliasId = getValidatedByJoiOrThrow(req.params.aliasId, AliasIdSchema);
    res
      .status(200)
      .send(
        toApiMentionAlias(
          await mentionAliasesService.update(
            ownerProfileId,
            aliasId,
            toServiceInput(input)
          )
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
    const aliasId = getValidatedByJoiOrThrow(req.params.aliasId, AliasIdSchema);
    await mentionAliasesService.delete(ownerProfileId, aliasId);
    res.status(204).send();
  }
);

export default router;
