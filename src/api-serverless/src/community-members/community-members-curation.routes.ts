import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import {
  CommunityMembersCurationCriteria,
  FilterDirection,
  FilterMinMax,
  FilterMinMaxDirectionAndUser,
  FilterRep
} from './community-search-criteria.types';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { ForbiddenException } from '../../../exceptions';
import { CommunityMembersCurationCriteriaEntity } from '../../../entities/ICommunityMembersCurationCriteriaEntity';
import {
  ChangeCommunityMembersCurationCriteriaVisibility,
  communityMemberCriteriaService,
  NewCommunityMembersCurationCriteria
} from './community-member-criteria.service';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, NewCommunityMembersCurationCriteria, any, any>,
    res: Response<ApiResponse<CommunityMembersCurationCriteriaEntity>>
  ) => {
    const criteria = getValidatedByJoiOrThrow(
      req.body,
      NewCommunityMembersCurationCriteriaSchema
    );
    const savingProfileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        getWalletOrThrow(req)
      )
      .then((pc) => pc?.profile?.external_id ?? null);
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    const response = await communityMemberCriteriaService.saveCurationCriteria(
      criteria,
      savingProfileId
    );
    res.send(response);
  }
);

router.post(
  '/:criteria_id/visible',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      { visible: true; old_version_id: string | null },
      any,
      any
    >,
    res: Response<ApiResponse<CommunityMembersCurationCriteriaEntity>>
  ) => {
    const savingProfileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        getWalletOrThrow(req)
      )
      .then((pc) => pc?.profile?.external_id ?? null);
    if (!savingProfileId) {
      throw new ForbiddenException(`Please create a profile first.`);
    }
    const request = getValidatedByJoiOrThrow(
      {
        visible: req.body.visible,
        criteria_id: req.params.criteria_id,
        old_version_id: req.body.old_version_id,
        profile_id: savingProfileId
      },
      ChangeCommunityMembersCurationCriteriaVisibilitySchema
    );
    const response =
      await communityMemberCriteriaService.changeCriteriaVisibility(request);
    res.send(response);
  }
);

const DirectionSchema: Joi.StringSchema = Joi.string()
  .valid(Object.values(FilterDirection))
  .optional()
  .allow(null)
  .default(null);

const NullablePositiveIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .min(0)
  .optional()
  .allow(null)
  .default(null);

const NullableStringSchema: Joi.StringSchema = Joi.string()
  .optional()
  .allow(null)
  .default(null);

const FilterMinMaxSchema: Joi.ObjectSchema<FilterMinMax> = Joi.object({
  min: NullablePositiveIntegerSchema,
  max: NullablePositiveIntegerSchema
});

const FilterRepSchema: Joi.ObjectSchema<FilterRep> = Joi.object({
  min: NullablePositiveIntegerSchema,
  max: NullablePositiveIntegerSchema,
  direction: DirectionSchema,
  user: NullableStringSchema,
  category: NullableStringSchema
});

const FilterCicSchema: Joi.ObjectSchema<FilterMinMaxDirectionAndUser> =
  Joi.object({
    min: NullablePositiveIntegerSchema,
    max: NullablePositiveIntegerSchema,
    direction: DirectionSchema,
    user: NullableStringSchema
  });

const CriteriaSchema: Joi.ObjectSchema<CommunityMembersCurationCriteria> =
  Joi.object({
    tdh: FilterMinMaxSchema,
    rep: FilterRepSchema,
    cic: FilterCicSchema,
    level: FilterMinMaxSchema
  });

const NewCommunityMembersCurationCriteriaSchema: Joi.ObjectSchema<NewCommunityMembersCurationCriteria> =
  Joi.object({
    name: Joi.string()
      .max(100)
      .regex(/^[a-zA-Z0-9?!,.'() ]{1,100}$/)
      .messages({
        'string.pattern.base': `Invalid name. Name can't be longer than 100 characters. It can only alphanumeric characters and spaces`
      }),
    criteria: CriteriaSchema
  });

const ChangeCommunityMembersCurationCriteriaVisibilitySchema: Joi.ObjectSchema<ChangeCommunityMembersCurationCriteriaVisibility> =
  Joi.object({
    visible: Joi.boolean().required(),
    criteria_id: Joi.string().required(),
    profile_id: Joi.string().required(),
    old_version_id: Joi.string().allow(null).default(null)
  });

export default router;
