import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticatedWalletOrNull,
  getWalletOrThrow,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import type { ApiMintingClaimActionsResponse } from '@/api/generated/models/ApiMintingClaimActionsResponse';
import type { ApiMintingClaimActionTypesResponse } from '@/api/generated/models/ApiMintingClaimActionTypesResponse';
import type { ApiMintingClaimActionUpdateRequest } from '@/api/generated/models/ApiMintingClaimActionUpdateRequest';
import {
  assertSupportedMintingClaimAction,
  getMintingClaimActionTypesResponse,
  getMintingClaimActionsResponse,
  getSupportedMintingClaimActionTypesOrThrow,
  upsertMintingClaimActionAndGetResponse
} from '@/api/minting-claims/minting-claim-actions.api.service';
import { fetchMintingClaimByClaimId } from '@/api/minting-claims/api.minting-claims.db';
import {
  ContractClaimParamsSchema,
  ContractOnlyParamsSchema,
  type ContractClaimParams,
  type ContractOnlyParams
} from '@/api/minting-claims/minting-claims.validation';
import { assertMintingClaimActionAccess } from '@/api/minting-claims/minting-claim-actions.authorization';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { numbers } from '@/numbers';
import { Timer } from '@/time';
import { Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();

const MintingClaimActionUpdateRequestSchema: Joi.ObjectSchema<ApiMintingClaimActionUpdateRequest> =
  Joi.object({
    action: Joi.string().trim().required(),
    completed: Joi.boolean().required()
  });

function parseClaimIdOrThrow(claimIdRaw: string): number {
  const claimId = numbers.parseIntOrNull(claimIdRaw);
  if (claimId === null || claimId < 0) {
    throw new BadRequestException('claim_id must be a non-negative integer');
  }
  return claimId;
}

async function assertMintingClaimExists(
  contract: string,
  claimId: number
): Promise<void> {
  const claim = await fetchMintingClaimByClaimId(contract, claimId);
  if (!claim) {
    throw new CustomApiCompliantException(404, 'Claim not found');
  }
}

router.get(
  '/:contract/types',
  needsAuthenticatedUser(),
  async function (
    req: Request<ContractOnlyParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMintingClaimActionTypesResponse>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractOnlyParamsSchema
    );
    await assertMintingClaimActionAccess(
      getAuthenticatedWalletOrNull(req),
      params.contract
    );

    return res.json(getMintingClaimActionTypesResponse(params.contract));
  }
);

router.post(
  '/:contract/:claim_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<
      ContractClaimParams,
      any,
      ApiMintingClaimActionUpdateRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiMintingClaimActionsResponse>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
    );
    await assertMintingClaimActionAccess(
      getAuthenticatedWalletOrNull(req),
      params.contract
    );
    getSupportedMintingClaimActionTypesOrThrow(params.contract);

    const claimId = parseClaimIdOrThrow(params.claim_id);
    await assertMintingClaimExists(params.contract, claimId);

    const body: ApiMintingClaimActionUpdateRequest = getValidatedByJoiOrThrow(
      req.body,
      MintingClaimActionUpdateRequestSchema
    );
    assertSupportedMintingClaimAction(params.contract, body.action);

    const response = await upsertMintingClaimActionAndGetResponse(
      params.contract,
      claimId,
      body,
      getWalletOrThrow(req),
      { timer: Timer.getFromRequest(req) }
    );

    return res.json(response);
  }
);

router.get(
  '/:contract/:claim_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<ContractClaimParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMintingClaimActionsResponse>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
    );
    await assertMintingClaimActionAccess(
      getAuthenticatedWalletOrNull(req),
      params.contract
    );
    getSupportedMintingClaimActionTypesOrThrow(params.contract);

    const claimId = parseClaimIdOrThrow(params.claim_id);
    await assertMintingClaimExists(params.contract, claimId);

    const response = await getMintingClaimActionsResponse(
      params.contract,
      claimId,
      { timer: Timer.getFromRequest(req) }
    );

    return res.json(response);
  }
);

export default router;
