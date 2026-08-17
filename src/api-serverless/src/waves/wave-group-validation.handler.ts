import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiWaveGroupValidationRequest } from '@/api/generated/models/ApiWaveGroupValidationRequest';
import { ApiWaveGroupValidationResponse } from '@/api/generated/models/ApiWaveGroupValidationResponse';
import { ValidateWaveGroupsRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { waveApiService } from './wave.api.service';

const NullableGroupIdSchema = Joi.string().allow(null);

const WaveGroupValidationRequestSchema =
  Joi.object<ApiWaveGroupValidationRequest>({
    visibility_group_id: NullableGroupIdSchema.required(),
    participation_group_id: NullableGroupIdSchema.optional(),
    voting_group_id: NullableGroupIdSchema.optional(),
    chat_group_id: NullableGroupIdSchema.optional(),
    admin_group_id: NullableGroupIdSchema.optional(),
    include_authenticated_user_as_admin: Joi.boolean().optional().default(false)
  }).required();

export async function handleValidateWaveGroups(
  req: ValidateWaveGroupsRequest
): Promise<ApiWaveGroupValidationResponse> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const body = getValidatedByJoiOrThrow(
    req.body,
    WaveGroupValidationRequestSchema
  );
  const authenticatedProfileId = authenticationContext.getActingAsId();
  if (body.include_authenticated_user_as_admin && !authenticatedProfileId) {
    throw new ForbiddenException(
      `Authentication with a profile is required to validate Admin access`
    );
  }
  const invalidRoles = await waveApiService.validateWaveGroupContainmentPreview(
    body,
    authenticatedProfileId,
    { authenticationContext, timer }
  );
  return {
    valid: invalidRoles.length === 0,
    invalid_roles: invalidRoles
  };
}
