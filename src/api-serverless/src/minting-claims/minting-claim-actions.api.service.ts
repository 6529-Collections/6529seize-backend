import type { ApiMintingClaimAction } from '@/api/generated/models/ApiMintingClaimAction';
import type { ApiMintingClaimActionTypesResponse } from '@/api/generated/models/ApiMintingClaimActionTypesResponse';
import type { ApiMintingClaimActionsResponse } from '@/api/generated/models/ApiMintingClaimActionsResponse';
import type { ApiMintingClaimActionUpdateRequest } from '@/api/generated/models/ApiMintingClaimActionUpdateRequest';
import {
  mintingClaimActionsDb,
  type MintingClaimActionRow
} from '@/api/minting-claims/minting-claim-actions.db';
import {
  getMintingClaimActionsContractLabel,
  getSupportedMintingClaimActionTypes,
  isSupportedMintingClaimActionType,
  type MintingClaimActionType
} from '@/minting-claims/minting-claim-actions';
import type { RequestContext } from '@/request.context';
import { BadRequestException } from '@/exceptions';

function toApiMintingClaimAction(
  action: MintingClaimActionType,
  row?: MintingClaimActionRow
): ApiMintingClaimAction {
  return {
    action,
    completed: row ? !!row.completed : false,
    created_at: row?.created_at,
    updated_at: row?.updated_at,
    created_by_wallet: row?.created_by_wallet,
    updated_by_wallet: row?.updated_by_wallet
  };
}

export function buildMintingClaimActionsResponse(
  contract: string,
  tokenId: number,
  rows: MintingClaimActionRow[]
): ApiMintingClaimActionsResponse {
  const supportedActions = getSupportedMintingClaimActionTypes(contract);
  const rowsByAction = new Map(rows.map((row) => [row.action, row]));

  return {
    contract: contract.toLowerCase(),
    token_id: tokenId,
    actions: supportedActions.map((action) =>
      toApiMintingClaimAction(action, rowsByAction.get(action))
    )
  };
}

export function getSupportedMintingClaimActionTypesOrThrow(
  contract: string
): readonly string[] {
  const supportedActions = getSupportedMintingClaimActionTypes(contract);
  if (supportedActions.length === 0) {
    throw new BadRequestException(
      'Minting claim actions are not supported for this contract'
    );
  }
  return supportedActions;
}

export function assertSupportedMintingClaimAction(
  contract: string,
  action: string
): void {
  const supportedActions = getSupportedMintingClaimActionTypesOrThrow(contract);
  if (!isSupportedMintingClaimActionType(contract, action)) {
    throw new BadRequestException(
      `Unsupported action "${action}" for ${getMintingClaimActionsContractLabel(contract)}. Supported actions: ${supportedActions.join(', ')}`
    );
  }
}

export function getMintingClaimActionTypesResponse(
  contract: string
): ApiMintingClaimActionTypesResponse {
  return {
    contract: contract.toLowerCase(),
    action_types: [...getSupportedMintingClaimActionTypesOrThrow(contract)]
  };
}

export async function getMintingClaimActionsResponse(
  contract: string,
  tokenId: number,
  ctx: RequestContext
): Promise<ApiMintingClaimActionsResponse> {
  getSupportedMintingClaimActionTypesOrThrow(contract);
  const rows = await mintingClaimActionsDb.findByContractAndTokenId(
    contract,
    tokenId,
    ctx
  );
  return buildMintingClaimActionsResponse(contract, tokenId, rows);
}

export async function upsertMintingClaimActionAndGetResponse(
  contract: string,
  tokenId: number,
  body: ApiMintingClaimActionUpdateRequest,
  wallet: string,
  ctx: RequestContext
): Promise<ApiMintingClaimActionsResponse> {
  await mintingClaimActionsDb.upsertAction(
    {
      contract,
      token_id: tokenId,
      action: body.action as MintingClaimActionType,
      completed: body.completed,
      wallet
    },
    ctx
  );

  return getMintingClaimActionsResponse(contract, tokenId, ctx);
}
