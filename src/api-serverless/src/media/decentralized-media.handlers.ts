import { ApiDecentralizedMediaProtocol } from '@/api/generated/models/ApiDecentralizedMediaProtocol';
import { ApiDecentralizedMediaResolution } from '@/api/generated/models/ApiDecentralizedMediaResolution';
import { ApiMediaResolveRequest } from '@/api/generated/models/ApiMediaResolveRequest';
import { ApiMediaResolveResponse } from '@/api/generated/models/ApiMediaResolveResponse';
import { ResolveDecentralizedMediaRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  DecentralizedMediaProtocol,
  DecentralizedMediaResolution,
  resolveDecentralizedMediaInputs
} from '@/decentralized-media/decentralized-media';
import * as Joi from 'joi';

const ResolveDecentralizedMediaBodySchema: Joi.ObjectSchema<ApiMediaResolveRequest> =
  Joi.object<ApiMediaResolveRequest>({
    inputs: Joi.array()
      .items(Joi.string().allow(''))
      .min(1)
      .max(100)
      .required(),
    include_external_fallbacks: Joi.boolean().optional().default(true)
  });

export async function handleResolveDecentralizedMedia(
  req: ResolveDecentralizedMediaRequest
): Promise<ApiMediaResolveResponse> {
  const body = getValidatedByJoiOrThrow(
    req.body,
    ResolveDecentralizedMediaBodySchema
  );

  return {
    items: resolveDecentralizedMediaInputs(body.inputs, {
      includeExternalFallbacks: body.include_external_fallbacks !== false
    }).map(toApiResolution)
  };
}

function toApiResolution(
  resolution: DecentralizedMediaResolution
): ApiDecentralizedMediaResolution {
  return {
    ...resolution,
    protocol: resolution.protocol
      ? toApiProtocol(resolution.protocol)
      : undefined
  };
}

function toApiProtocol(
  protocol: DecentralizedMediaProtocol
): ApiDecentralizedMediaProtocol {
  switch (protocol) {
    case 'ipfs':
      return ApiDecentralizedMediaProtocol.Ipfs;
    case 'ipns':
      return ApiDecentralizedMediaProtocol.Ipns;
    case 'arweave':
      return ApiDecentralizedMediaProtocol.Arweave;
    default: {
      const exhaustive: never = protocol;
      return exhaustive;
    }
  }
}
