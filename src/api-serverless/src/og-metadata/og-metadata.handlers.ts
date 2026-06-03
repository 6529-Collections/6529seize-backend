import { ApiOgMetadata } from '@/api/generated/models/ApiOgMetadata';
import {
  GetOgMetadataDropRequest,
  GetOgMetadataProfileRequest,
  GetOgMetadataWaveRequest
} from '@/api/generated/routes/operations';
import { ogMetadataService } from '@/api/og-metadata/og-metadata.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetOgMetadataProfilePathParams = {
  identity: string;
};

const GetOgMetadataProfilePathParamsSchema: Joi.ObjectSchema<GetOgMetadataProfilePathParams> =
  Joi.object({
    identity: Joi.string().trim().required()
  });

type GetOgMetadataWavePathParams = {
  id: string;
};

const GetOgMetadataWavePathParamsSchema: Joi.ObjectSchema<GetOgMetadataWavePathParams> =
  Joi.object({
    id: Joi.string().trim().required()
  });

type GetOgMetadataDropPathParams = {
  drop: string;
};

const GetOgMetadataDropPathParamsSchema: Joi.ObjectSchema<GetOgMetadataDropPathParams> =
  Joi.object({
    drop: Joi.string().trim().required()
  });

export async function handleGetOgMetadataProfile(
  req: GetOgMetadataProfileRequest
): Promise<ApiOgMetadata> {
  const timer = Timer.getFromRequest(req);
  const { identity } = getValidatedByJoiOrThrow(
    req.params,
    GetOgMetadataProfilePathParamsSchema
  );
  return ogMetadataService.getProfileMetadata(identity, { timer });
}

export async function handleGetOgMetadataWave(
  req: GetOgMetadataWaveRequest
): Promise<ApiOgMetadata> {
  const timer = Timer.getFromRequest(req);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetOgMetadataWavePathParamsSchema
  );
  return ogMetadataService.getWaveMetadata(id, { timer });
}

export async function handleGetOgMetadataDrop(
  req: GetOgMetadataDropRequest
): Promise<ApiOgMetadata> {
  const timer = Timer.getFromRequest(req);
  const { drop } = getValidatedByJoiOrThrow(
    req.params,
    GetOgMetadataDropPathParamsSchema
  );
  return ogMetadataService.getDropMetadata(drop, { timer });
}
