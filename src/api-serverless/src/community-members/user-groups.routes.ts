import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { NewUserGroupEntity, userGroupsService } from './user-groups.service';
import { ChangeGroupVisibility } from '../generated/models/ChangeGroupVisibility';
import { GroupFull } from '../generated/models/GroupFull';
import { CreateGroup } from '../generated/models/CreateGroup';
import { GroupDescription } from '../generated/models/GroupDescription';
import { GroupCicFilter } from '../generated/models/GroupCicFilter';
import { GroupFilterDirection } from '../generated/models/GroupFilterDirection';
import { GroupRepFilter } from '../generated/models/GroupRepFilter';
import { GroupLevelFilter } from '../generated/models/GroupLevelFilter';
import { GroupTdhFilter } from '../generated/models/GroupTdhFilter';
import { distinct, resolveEnum } from '../../../helpers';
import { FilterDirection } from '../../../entities/ICommunityGroup';

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
    res: Response<ApiResponse<GroupFull[]>>
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
    req: Request<{ group_id: string }, any, any, any, any>,
    res: Response<ApiResponse<GroupFull>>
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
    req: Request<any, any, CreateGroup, any, any>,
    res: Response<ApiResponse<GroupFull>>
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
    const relatedIdentities = distinct(
      [
        apiUserGroup.group.rep.user_identity,
        apiUserGroup.group.cic.user_identity
      ].filter((it) => !!it) as string[]
    );
    const relatedIdentitiesMapped = await Promise.all(
      relatedIdentities.map(async (identity) => {
        const profile =
          await profilesService.getProfileAndConsolidationsByIdentity(identity);
        if (!profile?.profile?.external_id) {
          throw new NotFoundException(
            `Profile with identity ${identity} does not exist.`
          );
        }
        return {
          given_identity: identity,
          profile_id: profile.profile.external_id
        };
      })
    );
    const userGroup: NewUserGroupEntity = {
      name: apiUserGroup.name,
      cic_min: apiUserGroup.group.cic.min,
      cic_max: apiUserGroup.group.cic.max,
      cic_user:
        relatedIdentitiesMapped.find((it) => {
          return it.given_identity === apiUserGroup.group.cic.user_identity;
        })?.profile_id ?? null,
      cic_direction: apiUserGroup.group.cic.direction
        ? resolveEnum(FilterDirection, apiUserGroup.group.cic.direction) ?? null
        : null,
      rep_min: apiUserGroup.group.rep.min,
      rep_max: apiUserGroup.group.rep.max,
      rep_user:
        relatedIdentitiesMapped.find((it) => {
          return it.given_identity === apiUserGroup.group.rep.user_identity;
        })?.profile_id ?? null,
      rep_direction: apiUserGroup.group.rep.direction
        ? resolveEnum(FilterDirection, apiUserGroup.group.rep.direction) ?? null
        : null,
      rep_category: apiUserGroup.group.rep.category,
      tdh_min: apiUserGroup.group.tdh.min,
      tdh_max: apiUserGroup.group.tdh.max,
      level_min: apiUserGroup.group.level.min,
      level_max: apiUserGroup.group.level.max,
      visible: false
    };
    const response = await userGroupsService.save(userGroup, savingProfileId);
    res.send(response);
  }
);

router.post(
  '/:group_id/visible',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ChangeGroupVisibility, any, any>,
    res: Response<ApiResponse<GroupFull>>
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

const GroupFilterDirectionSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(GroupFilterDirection))
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

const GroupTdhFilterSchema: Joi.ObjectSchema<GroupTdhFilter> =
  Joi.object<GroupTdhFilter>({
    min: NullablePositiveIntegerSchema,
    max: NullablePositiveIntegerSchema
  });

const GroupLevelFilterSchema: Joi.ObjectSchema<GroupLevelFilter> =
  Joi.object<GroupLevelFilter>({
    min: NullableIntegerSchema.min(-100).max(100),
    max: NullableIntegerSchema.min(-100).max(100)
  });

const GroupRepFilterSchema: Joi.ObjectSchema<GroupRepFilter> =
  Joi.object<GroupRepFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema,
    category: NullableStringSchema
  });

const GroupCicFilterSchema: Joi.ObjectSchema<GroupCicFilter> =
  Joi.object<GroupCicFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema
  });

const GroupDescriptionSchema: Joi.ObjectSchema<GroupDescription> =
  Joi.object<GroupDescription>({
    tdh: GroupTdhFilterSchema,
    rep: GroupRepFilterSchema,
    cic: GroupCicFilterSchema,
    level: GroupLevelFilterSchema
  });

const NewUserGroupSchema = Joi.object<CreateGroup>({
  name: Joi.string()
    .max(100)
    .regex(/^[a-zA-Z0-9?!,.'() ]{1,100}$/)
    .messages({
      'string.pattern.base': `Invalid name. Name can't be longer than 100 characters. It can only alphanumeric characters and spaces`
    }),
  group: GroupDescriptionSchema
});

const ChangeUserGroupVisibilitySchema: Joi.ObjectSchema<
  ChangeGroupVisibility & { group_id: string; profile_id: string }
> = Joi.object<
  ChangeGroupVisibility & { group_id: string; profile_id: string }
>({
  visible: Joi.boolean().required(),
  group_id: Joi.string().required(),
  profile_id: Joi.string().required(),
  old_version_id: Joi.string().allow(null).default(null)
});

export default router;
