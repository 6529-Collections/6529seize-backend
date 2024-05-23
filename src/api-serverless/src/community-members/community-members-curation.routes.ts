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
import {
  ChangeCommunityMembersCurationCriteriaVisibility,
  communityMemberCriteriaService,
  NewCommunityMembersCurationCriteria
} from './community-member-criteria.service';
import { ApiCommunityMembersCurationCriteria } from './api-community-members-curation-criteria';

type NewApiCommunityMembersCurationCriteria = Omit<
  ApiCommunityMembersCurationCriteria,
  'id' | 'created_at' | 'created_by'
>;

const router = asyncRouter();

router.get(
  '/',
  async (
    req: Request<
      any,
      any,
      { curation_criteria_name: string; curation_criteria_user: string },
      any,
      any
    >,
    res: Response<ApiResponse<ApiCommunityMembersCurationCriteria[]>>
  ) => {
    const curationCriteriaName = req.query.curation_criteria_name ?? null;
    let curationCriteriaUserId: string | null = null;
    if (req.query.curation_criteria_user) {
      curationCriteriaUserId = await profilesService
        .getProfileAndConsolidationsByIdentity(req.query.curation_criteria_user)
        .then((result) => result?.profile?.external_id ?? null);
      if (!curationCriteriaUserId) {
        res.send([]);
        return;
      }
    }
    const response = await communityMemberCriteriaService.searchCriteria(
      curationCriteriaName,
      curationCriteriaUserId
    );
    res.send(response);
  }
);

router.get(
  '/:criteria_id',
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<ApiCommunityMembersCurationCriteria>>
  ) => {
    const response =
      await communityMemberCriteriaService.getCriteriaByIdOrThrow(
        req.params.criteria_id
      );
    res.send(response);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, NewApiCommunityMembersCurationCriteria, any, any>,
    res: Response<ApiResponse<ApiCommunityMembersCurationCriteria>>
  ) => {
    const apiCriteria = getValidatedByJoiOrThrow(
      req.body,
      NewCommunityMembersCurationCriteriaSchema
    );
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
    const criteria: NewCommunityMembersCurationCriteria = {
      name: apiCriteria.name,
      cic_min: apiCriteria.criteria.cic.min,
      cic_max: apiCriteria.criteria.cic.max,
      cic_user: apiCriteria.criteria.cic.user,
      cic_direction: apiCriteria.criteria.cic.direction,
      rep_min: apiCriteria.criteria.rep.min,
      rep_max: apiCriteria.criteria.rep.max,
      rep_user: apiCriteria.criteria.rep.user,
      rep_direction: apiCriteria.criteria.rep.direction,
      rep_category: apiCriteria.criteria.rep.category,
      tdh_min: apiCriteria.criteria.tdh.min,
      tdh_max: apiCriteria.criteria.tdh.max,
      level_min: apiCriteria.criteria.level.min,
      level_max: apiCriteria.criteria.level.max,
      visible: apiCriteria.visible
    };
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
    res: Response<ApiResponse<ApiCommunityMembersCurationCriteria>>
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

const CriteriaSchema: Joi.ObjectSchema<CommunityMembersCurationCriteria> =
  Joi.object({
    tdh: TdhSchema,
    rep: RepSchema,
    cic: CicSchema,
    level: LevelSchema
  });

const NewCommunityMembersCurationCriteriaSchema =
  Joi.object<NewApiCommunityMembersCurationCriteria>({
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
