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
import { NewUserGroupEntity, userGroupsService } from './user-groups.service';
import { ApiChangeGroupVisibility } from '../generated/models/ApiChangeGroupVisibility';
import { ApiGroupFull } from '../generated/models/ApiGroupFull';
import { ApiCreateGroup } from '../generated/models/ApiCreateGroup';
import { ApiGroupCicFilter } from '../generated/models/ApiGroupCicFilter';
import { ApiGroupFilterDirection } from '../generated/models/ApiGroupFilterDirection';
import { ApiGroupRepFilter } from '../generated/models/ApiGroupRepFilter';
import { ApiGroupLevelFilter } from '../generated/models/ApiGroupLevelFilter';
import { ApiGroupTdhFilter } from '../generated/models/ApiGroupTdhFilter';
import {
  FilterDirection,
  GroupTdhInclusionStrategy
} from '../../../entities/IUserGroup';
import {
  ApiGroupOwnsNft,
  ApiGroupOwnsNftNameEnum
} from '../generated/models/ApiGroupOwnsNft';
import { ApiCreateGroupDescription } from '../generated/models/ApiCreateGroupDescription';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { identityFetcher } from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { numbers } from '../../../numbers';
import { collections } from '../../../collections';
import { WALLET_REGEX } from '../../../constants';
import { ApiGroupTdhInclusionStrategy } from '../generated/models/ApiGroupTdhInclusionStrategy';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      {
        group_name: string;
        author_identity: string;
        created_at_less_than?: string;
      },
      any,
      any
    >,
    res: Response<ApiResponse<ApiGroupFull[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const groupName = req.query.group_name ?? null;
    const createdAtLessThan = numbers.parseIntOrNull(
      req.query.created_at_less_than
    );
    let authorId: string | null = null;
    if (req.query.author_identity) {
      authorId = await identityFetcher.getProfileIdByIdentityKey(
        { identityKey: req.query.author_identity },
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
    const apiUserGroup = getValidatedByJoiOrThrow(req.body, NewUserGroupSchema);
    const savingProfileId = authenticationContext.authenticatedProfileId;
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    const relatedIdentities = collections.distinct(
      [
        apiUserGroup.group.rep.user_identity,
        apiUserGroup.group.cic.user_identity
      ].filter((it) => !!it) as string[]
    );
    const relatedIdentitiesMapped = await Promise.all(
      relatedIdentities.map(async (identity) => {
        const profileId =
          await identityFetcher.getProfileIdByIdentityKeyOrThrow(
            { identityKey: identity },
            {}
          );
        return {
          given_identity: identity,
          profile_id: profileId
        };
      })
    );
    const ownsMemes = apiUserGroup.group.owns_nfts.find(
      (it) => it.name === ApiGroupOwnsNftNameEnum.Memes
    );
    const ownsGradient = apiUserGroup.group.owns_nfts.find(
      (it) => it.name === ApiGroupOwnsNftNameEnum.Gradients
    );
    const ownsLab = apiUserGroup.group.owns_nfts.find(
      (it) => it.name === ApiGroupOwnsNftNameEnum.Memelab
    );
    const ownsNextgen = apiUserGroup.group.owns_nfts.find(
      (it) => it.name === ApiGroupOwnsNftNameEnum.Nextgen
    );
    const isPrivate = apiUserGroup.is_private ?? false;
    const userGroup: Omit<
      NewUserGroupEntity,
      'profile_group_id' | 'excluded_profile_group_id'
    > & {
      addresses: string[];
      excluded_addresses: string[];
    } = {
      name: apiUserGroup.name,
      cic_min: apiUserGroup.group.cic.min,
      cic_max: apiUserGroup.group.cic.max,
      cic_user:
        relatedIdentitiesMapped.find((it) => {
          return it.given_identity === apiUserGroup.group.cic.user_identity;
        })?.profile_id ?? null,
      cic_direction: apiUserGroup.group.cic.direction
        ? (enums.resolve(FilterDirection, apiUserGroup.group.cic.direction) ??
          null)
        : null,
      rep_min: apiUserGroup.group.rep.min,
      rep_max: apiUserGroup.group.rep.max,
      rep_user:
        relatedIdentitiesMapped.find((it) => {
          return it.given_identity === apiUserGroup.group.rep.user_identity;
        })?.profile_id ?? null,
      rep_direction: apiUserGroup.group.rep.direction
        ? (enums.resolve(FilterDirection, apiUserGroup.group.rep.direction) ??
          null)
        : null,
      rep_category: apiUserGroup.group.rep.category,
      tdh_min: apiUserGroup.group.tdh.min,
      tdh_max: apiUserGroup.group.tdh.max,
      tdh_inclusion_strategy: enums.resolveOrThrow(
        GroupTdhInclusionStrategy,
        apiUserGroup.group.tdh.inclusion_strategy
      ),
      level_min: apiUserGroup.group.level.min,
      level_max: apiUserGroup.group.level.max,
      owns_meme: !!ownsMemes,
      owns_gradient: !!ownsGradient,
      owns_lab: !!ownsLab,
      owns_nextgen: !!ownsNextgen,
      owns_meme_tokens: ownsMemes?.tokens
        ? JSON.stringify(ownsMemes.tokens)
        : null,
      owns_gradient_tokens: ownsGradient?.tokens
        ? JSON.stringify(ownsGradient.tokens)
        : null,
      owns_lab_tokens: ownsLab?.tokens ? JSON.stringify(ownsLab.tokens) : null,
      owns_nextgen_tokens: ownsNextgen?.tokens
        ? JSON.stringify(ownsNextgen.tokens)
        : null,
      addresses: apiUserGroup.group.identity_addresses?.length
        ? apiUserGroup.group.identity_addresses
        : [],
      excluded_addresses: apiUserGroup.group.excluded_identity_addresses ?? [],
      visible: false,
      is_private: isPrivate,
      is_direct_message: false,
      is_beneficiary_of_grant_id:
        apiUserGroup.group.is_beneficiary_of_grant_id ?? null
    };
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
    const requestContext: RequestContext = { timer, authenticationContext };
    const savingProfileId = authenticationContext.getActingAsId();
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
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
      request,
      requestContext
    );
    res.send(response);
  }
);

const GroupFilterDirectionSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(ApiGroupFilterDirection))
  .optional()
  .allow(null)
  .default(null);

const NullablePositiveIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .min(0)
  .optional()
  .allow(null)
  .default(null);

const NullableIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .optional()
  .allow(null)
  .default(null);

const NullableStringSchema: Joi.StringSchema = Joi.string()
  .optional()
  .allow(null)
  .default(null);

const GroupTdhFilterSchema: Joi.ObjectSchema<ApiGroupTdhFilter> =
  Joi.object<ApiGroupTdhFilter>({
    min: NullablePositiveIntegerSchema,
    max: NullablePositiveIntegerSchema,
    inclusion_strategy: Joi.string()
      .allow(...Object.values(ApiGroupTdhInclusionStrategy))
      .default(ApiGroupTdhInclusionStrategy.Tdh)
  });

const GroupLevelFilterSchema: Joi.ObjectSchema<ApiGroupLevelFilter> =
  Joi.object<ApiGroupLevelFilter>({
    min: NullableIntegerSchema.min(-100).max(100),
    max: NullableIntegerSchema.min(-100).max(100)
  });

const GroupRepFilterSchema: Joi.ObjectSchema<ApiGroupRepFilter> =
  Joi.object<ApiGroupRepFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema,
    category: NullableStringSchema
  });

const GroupCicFilterSchema: Joi.ObjectSchema<ApiGroupCicFilter> =
  Joi.object<ApiGroupCicFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema
  });

const GroupOwnsNftSchema: Joi.ObjectSchema<ApiGroupOwnsNft> =
  Joi.object<ApiGroupOwnsNft>({
    name: Joi.string()
      .valid(...Object.values(ApiGroupOwnsNftNameEnum))
      .required(),
    tokens: Joi.array().required().items(Joi.string()).allow(null)
  });

const GroupDescriptionSchema: Joi.ObjectSchema<ApiCreateGroupDescription> =
  Joi.object<ApiCreateGroupDescription>({
    tdh: GroupTdhFilterSchema,
    rep: GroupRepFilterSchema,
    cic: GroupCicFilterSchema,
    level: GroupLevelFilterSchema,
    owns_nfts: Joi.array().required().items(GroupOwnsNftSchema),
    identity_addresses: Joi.array()
      .required()
      .items(Joi.string().regex(WALLET_REGEX).lowercase())
      .allow(null)
      .max(20000),
    excluded_identity_addresses: Joi.array()
      .optional()
      .items(Joi.string().regex(WALLET_REGEX).lowercase())
      .allow(null)
      .default([])
      .max(20000),
    is_beneficiary_of_grant_id: Joi.string().optional()
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
