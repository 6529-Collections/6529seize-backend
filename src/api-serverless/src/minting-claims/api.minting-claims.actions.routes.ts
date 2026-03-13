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
import { getClaimsAdminWallets } from '@/api/seize-settings';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { numbers } from '@/numbers';
import { equalIgnoreCase } from '@/strings';
import { Timer } from '@/time';
import { Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();

const MintingClaimActionUpdateRequestSchema: Joi.ObjectSchema<ApiMintingClaimActionUpdateRequest> =
  Joi.object({
    action: Joi.string().trim().required(),
    completed: Joi.boolean().required()
  });

function isClaimsAdmin(req: Request): boolean {
  const wallet = getAuthenticatedWalletOrNull(req);
  return !!(
    wallet &&
    getClaimsAdminWallets().some((adminWallet) =>
      equalIgnoreCase(adminWallet, wallet)
    )
  );
}

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
    if (!isClaimsAdmin(req)) {
      throw new ForbiddenException(
        'Only claims admins can access minting claim action types'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractOnlyParamsSchema
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
    if (!isClaimsAdmin(req)) {
      throw new ForbiddenException(
        'Only claims admins can update minting claim actions'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
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
    if (!isClaimsAdmin(req)) {
      throw new ForbiddenException(
        'Only claims admins can access minting claim actions'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
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
