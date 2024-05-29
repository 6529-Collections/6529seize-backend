import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import {
  FilterDirection,
  FilterMinMax,
  FilterMinMaxDirectionAndUser,
  FilterRep,
  UserGroup
} from './user-group.types';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { ForbiddenException } from '../../../exceptions';
import {
  ChangeUserGroupVisibility,
  NewUserGroup,
  userGroupsService
} from './user-groups.service';
import { ApiUserGroup } from './api-user-group';

type NewApiUserGroup = Omit<ApiUserGroup, 'id' | 'created_at' | 'created_by'>;

const router = asyncRouter();

router.get(
  '/',
  async (
    req: Request<
      any,
      any,
      { group_name: string; author_identity: string },
      any,
      any
    >,
    res: Response<ApiResponse<ApiUserGroup[]>>
  ) => {
    const groupName = req.query.group_name ?? null;
    let authorId: string | null = null;
    if (req.query.author_identity) {
      authorId = await profilesService
        .getProfileAndConsolidationsByIdentity(req.query.author_identity)
        .then((result) => result?.profile?.external_id ?? null);
      if (!authorId) {
        res.send([]);
        return;
      }
    }
    const response = await userGroupsService.searchByNameOrAuthor(
      groupName,
      authorId
    );
    res.send(response);
  }
);

router.get(
  '/:group_id',
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<ApiUserGroup>>
  ) => {
    const response = await userGroupsService.getByIdOrThrow(
      req.params.group_id
    );
    res.send(response);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, NewApiUserGroup, any, any>,
    res: Response<ApiResponse<ApiUserGroup>>
  ) => {
    const apiUserGroup = getValidatedByJoiOrThrow(req.body, NewUserGroupSchema);
    const savingProfileId = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      .then((pc) =>
        pc?.profile?.external_id
          ? {
              id: pc.profile.external_id,
              handle: pc.profile.handle
            }
          : null
      );
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    const userGroup: NewUserGroup = {
      name: apiUserGroup.name,
      cic_min: apiUserGroup.group.cic.min,
      cic_max: apiUserGroup.group.cic.max,
      cic_user: apiUserGroup.group.cic.user,
      cic_direction: apiUserGroup.group.cic.direction,
      rep_min: apiUserGroup.group.rep.min,
      rep_max: apiUserGroup.group.rep.max,
      rep_user: apiUserGroup.group.rep.user,
      rep_direction: apiUserGroup.group.rep.direction,
      rep_category: apiUserGroup.group.rep.category,
      tdh_min: apiUserGroup.group.tdh.min,
      tdh_max: apiUserGroup.group.tdh.max,
      level_min: apiUserGroup.group.level.min,
      level_max: apiUserGroup.group.level.max,
      visible: apiUserGroup.visible
    };
    const response = await userGroupsService.save(userGroup, savingProfileId);
    res.send(response);
  }
);

router.post(
  '/:group_id/visible',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      { visible: true; old_version_id: string | null },
      any,
      any
    >,
    res: Response<ApiResponse<ApiUserGroup>>
  ) => {
    const savingProfileId = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      .then((pc) => pc?.profile?.external_id ?? null);
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
    const response = await userGroupsService.changeVisibility(request);
    res.send(response);
  }
);

const DirectionSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(FilterDirection))
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

const TdhSchema: Joi.ObjectSchema<FilterMinMax> = Joi.object({
  min: NullablePositiveIntegerSchema,
  max: NullablePositiveIntegerSchema
});

const LevelSchema: Joi.ObjectSchema<FilterMinMax> = Joi.object({
  min: NullableIntegerSchema.min(-100).max(100),
  max: NullableIntegerSchema.min(-100).max(100)
});

const RepSchema: Joi.ObjectSchema<FilterRep> = Joi.object({
  min: NullableIntegerSchema,
  max: NullableIntegerSchema,
  direction: DirectionSchema,
  user: NullableStringSchema,
  category: NullableStringSchema
});

const CicSchema: Joi.ObjectSchema<FilterMinMaxDirectionAndUser> = Joi.object({
  min: NullableIntegerSchema,
  max: NullableIntegerSchema,
  direction: DirectionSchema,
  user: NullableStringSchema
});

const UserGroupSchema: Joi.ObjectSchema<UserGroup> = Joi.object({
  tdh: TdhSchema,
  rep: RepSchema,
  cic: CicSchema,
  level: LevelSchema
});

const NewUserGroupSchema = Joi.object<NewApiUserGroup>({
  name: Joi.string()
    .max(100)
    .regex(/^[a-zA-Z0-9?!,.'() ]{1,100}$/)
    .messages({
      'string.pattern.base': `Invalid name. Name can't be longer than 100 characters. It can only alphanumeric characters and spaces`
    }),
  group: UserGroupSchema
});

const ChangeUserGroupVisibilitySchema: Joi.ObjectSchema<ChangeUserGroupVisibility> =
  Joi.object<ChangeUserGroupVisibility>({
    visible: Joi.boolean().required(),
    group_id: Joi.string().required(),
    profile_id: Joi.string().required(),
    old_version_id: Joi.string().allow(null).default(null)
  });

export default router;
