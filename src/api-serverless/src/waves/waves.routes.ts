import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import { CreateNewWaveScope } from '../generated/models/CreateNewWaveScope';
import { CreateNewWaveVisibilityConfig } from '../generated/models/CreateNewWaveVisibilityConfig';
import { CreateNewWaveVotingConfig } from '../generated/models/CreateNewWaveVotingConfig';
import { WaveCreditType } from '../generated/models/WaveCreditType';
import { WaveCreditScope } from '../generated/models/WaveCreditScope';
import { IntRange } from '../generated/models/IntRange';
import { CreateNewWaveParticipationConfig } from '../generated/models/CreateNewWaveParticipationConfig';
import { WaveRequiredMetadata } from '../generated/models/WaveRequiredMetadata';
import { WaveConfig } from '../generated/models/WaveConfig';
import { WaveType } from '../generated/models/WaveType';
import { parseIntOrNull, resolveEnum } from '../../../helpers';
import { WaveOutcome } from '../generated/models/WaveOutcome';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { userGroupsService } from '../community-members/user-groups.service';
import { NewWaveDropSchema } from '../drops/drop.validator';
import { WaveParticipationRequirement } from '../generated/models/WaveParticipationRequirement';
import { WaveOutcomeType } from '../generated/models/WaveOutcomeType';
import { WaveOutcomeSubType } from '../generated/models/WaveOutcomeSubType';
import { WaveOutcomeCredit } from '../generated/models/WaveOutcomeCredit';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { WaveSubscriptionActions } from '../generated/models/WaveSubscriptionActions';
import { WaveSubscriptionTargetAction } from '../generated/models/WaveSubscriptionTargetAction';
import { profilesService } from '../../../profiles/profiles.service';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { UpdateWaveRequest } from '../generated/models/UpdateWaveRequest';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { dropsService } from '../drops/drops.api.service';
import { WaveDropsFeed } from '../generated/models/WaveDropsFeed';
import { DropSearchStrategy } from '../generated/models/DropSearchStrategy';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateNewWave, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = { authenticationContext, timer };
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.CREATE_WAVE
      ]
    ) {
      throw new ForbiddenException(`Proxy is not allowed to create waves`);
    }
    const request = getValidatedByJoiOrThrow(req.body, WaveSchema);
    const wave = await waveApiService.createWave(request, requestContext);
    res.send(wave);
  }
);

router.post(
  '/:id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, UpdateWaveRequest, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = { authenticationContext, timer };
    const request = getValidatedByJoiOrThrow(req.body, UpdateWaveSchema);
    const wave = await waveApiService.updateWave(
      req.params.id,
      request,
      requestContext
    );
    await giveReadReplicaTimeToCatchUp();
    res.send(wave);
  }
);

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, SearchWavesParams, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const params = await validateWavesSearchParams(req);
    const waves = await waveApiService.searchWaves(params, {
      authenticationContext,
      timer
    });
    res.send(waves);
  }
);

router.get(
  '/:id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const profileId = authenticationContext.getActingAsId();
    const group_ids_user_is_eligible_for =
      !profileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.READ_WAVE
        ])
        ? []
        : await userGroupsService.getGroupsUserIsEligibleFor(profileId);
    const wave = await waveApiService.findWaveByIdOrThrow(
      id,
      group_ids_user_is_eligible_for,
      { authenticationContext, timer }
    );
    const groupId = wave.visibility.scope.group?.id;
    if (groupId) {
      if (!group_ids_user_is_eligible_for.includes(groupId)) {
        const adminGroupId = wave.wave.admin_group.group?.id;
        if (
          !adminGroupId ||
          !group_ids_user_is_eligible_for.includes(adminGroupId)
        ) {
          throw new ForbiddenException(`User is not eligible for this wave`);
        }
      }
    }

    res.send(wave);
  }
);

router.delete(
  '/:id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<void>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await waveApiService.deleteWave(id, { authenticationContext, timer });
    res.send();
  }
);

router.post(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, WaveSubscriptionActions, any, any>,
    res: Response<ApiResponse<WaveSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read waves or subscribe to them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      WaveSubscriptionActionsSchema
    );
    const activeActions = await waveApiService.addWaveSubscriptionActions({
      waveId: req.params.id,
      subscriber: authenticatedProfileId,
      actions: request.actions
    });
    res.send({
      actions: activeActions
    });
  }
);

router.delete(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, WaveSubscriptionActions, any, any>,
    res: Response<ApiResponse<WaveSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read waves or unsubscribe for them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      WaveSubscriptionActionsSchema
    );
    const activeActions = await waveApiService.removeWaveSubscriptionActions({
      waveId: req.params.id,
      subscriber: authenticatedProfileId,
      actions: request.actions
    });
    res.send({
      actions: activeActions
    });
  }
);

router.get(
  '/:id/drops',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      {
        drop_id?: string;
        limit?: string;
        serial_no_less_than?: string;
        serial_no_limit?: string;
        search_strategy?: string;
      },
      any
    >,
    res: Response<ApiResponse<WaveDropsFeed>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const dropId = req.query.drop_id ?? null;
    const amount = parseIntOrNull(req.query.limit) ?? 20;
    const serialNoLessThan = parseIntOrNull(req.query.serial_no_less_than);
    const serialNoLimit =
      serialNoLessThan ?? parseIntOrNull(req.query.serial_no_limit);
    const searchStrategy =
      serialNoLessThan === null
        ? resolveEnum(DropSearchStrategy, req.query.search_strategy) ??
          DropSearchStrategy.Older
        : DropSearchStrategy.Older;
    const result = await dropsService.findWaveDropsFeed(
      {
        wave_id: id,
        drop_id: dropId,
        amount: amount >= 50 || amount < 1 ? 50 : amount,
        serial_no_limit: serialNoLimit,
        search_strategy: searchStrategy
      },
      { authenticationContext, timer }
    );
    res.send(result);
  }
);

const IntRangeSchema = Joi.object<IntRange>({
  min: Joi.number().integer().required().allow(null),
  max: Joi.number().integer().required().allow(null)
})
  .custom((value, helpers) => {
    const min = parseIntOrNull(value?.min);
    const max = parseIntOrNull(value?.max);
    if (min !== null && max !== null && min > max) {
      return helpers.error('min.max.flip');
    }
    return { min, max };
  })
  .messages({
    'min.max.flip': `There's a range in request where max is less than min. This is not allowed.`
  });

const WaveScopeSchema = Joi.object<CreateNewWaveScope>({
  group_id: Joi.string().required().allow(null)
});

const WaveVisibilitySchema = Joi.object<CreateNewWaveVisibilityConfig>({
  scope: WaveScopeSchema.required()
});

const WaveVotingSchema = Joi.object<CreateNewWaveVotingConfig>({
  scope: WaveScopeSchema.required(),
  credit_type: Joi.string()
    .allow(...Object.values(WaveCreditType))
    .required(),
  credit_scope: Joi.string()
    .allow(...Object.values(WaveCreditScope))
    .required(),
  credit_category: Joi.when('credit_type', {
    is: Joi.string().valid(WaveCreditType.Rep),
    then: Joi.string().required().allow(null).max(100),
    otherwise: Joi.valid(null)
  }),
  creditor_id: Joi.when('credit_type', {
    is: Joi.string().valid(WaveCreditType.Rep),
    then: Joi.string().required().allow(null),
    otherwise: Joi.valid(null)
  }),
  signature_required: Joi.boolean().required(),
  period: IntRangeSchema.required().allow(null)
});

const WaveRequiredMetadataSchema = Joi.object<WaveRequiredMetadata>({
  name: Joi.string().required().max(250).min(1),
  type: Joi.string()
    .required()
    .allow(...Object.values(WaveParticipationRequirement))
});

const WaveParticipationSchema = Joi.object<CreateNewWaveParticipationConfig>({
  scope: WaveScopeSchema.required(),
  no_of_applications_allowed_per_participant: Joi.number()
    .integer()
    .required()
    .allow(null),
  required_metadata: Joi.array()
    .required()
    .min(0)
    .items(WaveRequiredMetadataSchema),
  required_media: Joi.array().items(
    Joi.string().valid(...Object.values(WaveParticipationRequirement))
  ),
  signature_required: Joi.boolean().required(),
  period: IntRangeSchema.required().allow(null)
});

const WaveConfigSchema = Joi.object<WaveConfig>({
  type: Joi.string()
    .required()
    .allow(...Object.values(WaveType)),
  winning_thresholds: Joi.when('type', {
    is: Joi.string().valid(WaveType.Approve),
    then: IntRangeSchema.required().or('min', 'max'),
    otherwise: Joi.valid(null)
  }),
  max_winners: Joi.when('type', {
    is: Joi.string().valid(WaveType.Rank),
    then: Joi.number().integer().required().allow(null).min(1),
    otherwise: Joi.valid(null)
  }),
  time_lock_ms: Joi.number().integer().required().allow(null).min(1),
  period: IntRangeSchema.required().allow(null),
  admin_group: WaveScopeSchema.required()
});

const WaveOutcomeSchema = Joi.object<WaveOutcome>({
  type: Joi.string()
    .required()
    .valid(...Object.values(WaveOutcomeType)),
  subtype: Joi.when('type', {
    is: WaveOutcomeType.Automatic,
    then: Joi.string()
      .required()
      .valid(...Object.values(WaveOutcomeSubType)),
    otherwise: Joi.optional().valid(null)
  }),
  description: Joi.string().required().max(250).min(1),
  credit: Joi.when('subtype', {
    is: WaveOutcomeSubType.CreditDistribution,
    then: Joi.string()
      .required()
      .valid(...Object.values(WaveOutcomeCredit)),
    otherwise: Joi.optional().valid(null)
  }),
  rep_category: Joi.when('credit', {
    is: WaveOutcomeCredit.Rep,
    then: Joi.string()
      .required()
      .min(3)
      .max(100)
      .regex(REP_CATEGORY_PATTERN)
      .messages({
        'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
      }),
    otherwise: Joi.optional().valid(null)
  }),
  amount: Joi.when('subtype', {
    is: WaveOutcomeSubType.CreditDistribution,
    then: Joi.number().integer().required().min(1),
    otherwise: Joi.optional().valid(null)
  }),
  distribution: Joi.when('subtype', {
    is: WaveOutcomeSubType.CreditDistribution,
    then: Joi.array()
      .optional()
      .items(Joi.number().integer().required().min(0)),
    otherwise: Joi.optional().valid(null)
  })
});

const waveSchemaBaseValidations = {
  name: Joi.string().required().max(250).min(1),
  picture: Joi.string()
    .optional()
    .allow(null)
    .regex(/^https:\/\/d3lqz0a4bldqgf.cloudfront.net\//),
  voting: WaveVotingSchema.required(),
  visibility: WaveVisibilitySchema.required(),
  participation: WaveParticipationSchema.required(),
  wave: WaveConfigSchema.required(),
  outcomes: Joi.array().required().min(0).items(WaveOutcomeSchema)
};

const WaveSchema = Joi.object<CreateNewWave>({
  ...waveSchemaBaseValidations,
  description_drop: NewWaveDropSchema.required()
});

const UpdateWaveSchema = Joi.object<UpdateWaveRequest>({
  ...waveSchemaBaseValidations
});

const WaveSubscriptionActionsSchema = Joi.object<WaveSubscriptionActions>({
  actions: Joi.array()
    .items(Joi.string().valid(...Object.values(WaveSubscriptionTargetAction)))
    .required()
});

export async function validateWavesSearchParams(
  req: Request<any, any, any, SearchWavesParams, any>
): Promise<SearchWavesParams> {
  const validatedRequest = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<SearchWavesParams>({
      name: Joi.string().optional(),
      author: Joi.string().optional(),
      limit: Joi.number().integer().min(1).max(50).default(20),
      serial_no_less_than: Joi.number().integer().min(1).optional(),
      group_id: Joi.string().optional().min(1)
    })
  );
  if (validatedRequest.author) {
    const authorIdentity = await profilesService.resolveIdentityOrThrowNotFound(
      validatedRequest.author
    );
    if (!authorIdentity.profile_id) {
      throw new NotFoundException('Author not found');
    }
    return {
      ...validatedRequest,
      author: authorIdentity.profile_id
    };
  }
  return validatedRequest;
}

export default router;
