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
  ContractTokenParamsSchema,
  ContractOnlyParamsSchema,
  type ContractOnlyParams,
  type ContractTokenParams
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

function parseTokenIdOrThrow(tokenIdRaw: string): number {
  const tokenId = numbers.parseIntOrNull(tokenIdRaw);
  if (tokenId === null || tokenId < 0) {
    throw new BadRequestException('token_id must be a non-negative integer');
  }
  return tokenId;
}

async function assertMintingClaimExists(
  contract: string,
  tokenId: number
): Promise<void> {
  const claim = await fetchMintingClaimByClaimId(contract, tokenId);
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
  '/:contract/:token_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<
      ContractTokenParams,
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
      ContractTokenParamsSchema
    );
    getSupportedMintingClaimActionTypesOrThrow(params.contract);

    const tokenId = parseTokenIdOrThrow(params.token_id);
    await assertMintingClaimExists(params.contract, tokenId);

    const body: ApiMintingClaimActionUpdateRequest = getValidatedByJoiOrThrow(
      req.body,
      MintingClaimActionUpdateRequestSchema
    );
    assertSupportedMintingClaimAction(params.contract, body.action);

    const response = await upsertMintingClaimActionAndGetResponse(
      params.contract,
      tokenId,
      body,
      getWalletOrThrow(req),
      { timer: Timer.getFromRequest(req) }
    );

    return res.json(response);
  }
);

router.get(
  '/:contract/:token_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<ContractTokenParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMintingClaimActionsResponse>>
  ) {
    if (!isClaimsAdmin(req)) {
      throw new ForbiddenException(
        'Only claims admins can access minting claim actions'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractTokenParamsSchema
    );
    getSupportedMintingClaimActionTypesOrThrow(params.contract);

    const tokenId = parseTokenIdOrThrow(params.token_id);
    await assertMintingClaimExists(params.contract, tokenId);

    const response = await getMintingClaimActionsResponse(
      params.contract,
      tokenId,
      { timer: Timer.getFromRequest(req) }
    );

    return res.json(response);
  }
);

export default router;
