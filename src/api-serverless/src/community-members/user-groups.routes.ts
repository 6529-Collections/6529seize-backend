import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { userGroupsService } from './user-groups.service';
import { toNewUserGroupInput } from './new-user-group-input';
import { ApiChangeGroupVisibility } from '../generated/models/ApiChangeGroupVisibility';
import { ApiGroupFull } from '../generated/models/ApiGroupFull';
import { ApiCreateGroup } from '../generated/models/ApiCreateGroup';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { identityFetcher } from '../identities/identity.fetcher';
import { waveApiService } from '../waves/wave.api.service';
import { GroupDescriptionSchema } from './group-description.schema';
import { rejectProxySession } from '@/api/proxy-session-guard';

const router = asyncRouter();

export interface SearchUserGroupsQuery {
  group_name: string | null;
  author_identity: string | null;
  created_at_less_than: number | null;
  include_profile_groups: boolean;
}

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, SearchUserGroupsQuery, any>,
    res: Response<ApiResponse<ApiGroupFull[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const query = getValidatedByJoiOrThrow<SearchUserGroupsQuery>(
      req.query,
      SearchUserGroupsQuerySchema
    );
    const groupName = query.group_name;
    const createdAtLessThan = query.created_at_less_than;
    let authorId: string | null = null;
    if (query.author_identity) {
      authorId = await identityFetcher.getProfileIdByIdentityKey(
        { identityKey: query.author_identity },
        {}
      );
      if (!authorId) {
        res.send([]);
        return;
      }
    }
    const response = await userGroupsService.searchByNameOrAuthor(
      groupName,
      authorId,
      createdAtLessThan,
      true,
      { authenticationContext, timer }
    );
    res.send(response);
  }
);

router.get(
  '/:group_id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ group_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiGroupFull>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const response = await userGroupsService.getByIdOrThrow(
      req.params.group_id,
      { authenticationContext, timer }
    );
    res.send(response);
  }
);

router.get(
  '/:group_id/identity_groups/:identity_group_id',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { group_id: string; identity_group_id: string },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<string[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = {
      timer,
      authenticationContext
    };
    const group = await userGroupsService.getByIdOrThrow(
      req.params.group_id,
      ctx
    );
    const identityGroupId = group.group.identity_group_id;
    const exclusionGroupId = group.group.excluded_identity_group_id;
    const givenIdentityGroupId = req.params.identity_group_id;
    if (![identityGroupId, exclusionGroupId].includes(givenIdentityGroupId)) {
      throw new NotFoundException(
        `Group does not have identity group with id ${givenIdentityGroupId}`
      );
    } else {
      const addresses =
        await userGroupsService.findUserGroupsIdentityGroupIdentities(
          givenIdentityGroupId
        );
      res.send(addresses);
    }
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateGroup, any, any>,
    res: Response<ApiResponse<ApiGroupFull>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const savingProfileId = authenticationContext.authenticatedProfileId;
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    rejectProxySession(authenticationContext, `Proxies cannot create groups`);
    const apiUserGroup = getValidatedByJoiOrThrow(req.body, NewUserGroupSchema);
    const userGroup = await toNewUserGroupInput(apiUserGroup);
    const response = await userGroupsService.save(userGroup, savingProfileId, {
      authenticationContext,
      timer
    });
    res.send(response);
  }
);

router.post(
  '/:group_id/visible',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiChangeGroupVisibility, any, any>,
    res: Response<ApiResponse<ApiGroupFull>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = {
      timer,
      authenticationContext
    };
    const savingProfileId = authenticationContext.getActingAsId();
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    rejectProxySession(
      authenticationContext,
      `Proxies cannot change group visibility`
    );
    const request = getValidatedByJoiOrThrow(
      {
        visible: req.body.visible,
        group_id: req.params.group_id,
        old_version_id: req.body.old_version_id,
        profile_id: savingProfileId
      },
      ChangeUserGroupVisibilitySchema
    );
    const response = await userGroupsService.changeVisibility(
      { ...request, idempotencyKey: req.get('Idempotency-Key') },
      requestContext,
      async (replacement, ctx) =>
        await waveApiService.assertGroupReplacementPreservesWaveViewAccess(
          replacement,
          ctx
        )
    );
    res.send(response);
  }
);

const SearchNullableStringSchema: Joi.StringSchema = Joi.string()
  .empty('')
  .optional()
  .allow(null)
  .default(null);

const SearchNullableIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .empty('')
  .optional()
  .allow(null)
  .default(null);

export const SearchUserGroupsQuerySchema: Joi.ObjectSchema<SearchUserGroupsQuery> =
  Joi.object<SearchUserGroupsQuery>({
    group_name: SearchNullableStringSchema,
    author_identity: SearchNullableStringSchema,
    created_at_less_than: SearchNullableIntegerSchema,
    include_profile_groups: Joi.boolean().empty('').optional().default(false)
  });

const NewUserGroupSchema = Joi.object<ApiCreateGroup>({
  name: Joi.string()
    .max(100)
    .regex(/^[\x20-\x7E]{1,100}$/)
    .messages({
      'string.pattern.base': `Invalid name! Name must be 1-100 characters long and can only include standard letters, numbers, symbols, and spaces.`
    }),
  group: GroupDescriptionSchema,
  is_private: Joi.boolean().optional().default(false)
});

const ChangeUserGroupVisibilitySchema: Joi.ObjectSchema<
  ApiChangeGroupVisibility & { group_id: string; profile_id: string }
> = Joi.object<
  ApiChangeGroupVisibility & { group_id: string; profile_id: string }
>({
  visible: Joi.boolean().required(),
  group_id: Joi.string().required(),
  profile_id: Joi.string().required(),
  old_version_id: Joi.string().allow(null).default(null)
});

export default router;
