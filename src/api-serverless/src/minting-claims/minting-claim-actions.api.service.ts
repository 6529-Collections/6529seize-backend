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
  isSupportedMintingClaimActionType
} from '@/minting-claims/minting-claim-actions';
import type { RequestContext } from '@/request.context';
import { BadRequestException } from '@/exceptions';

function canonicalizeMintingClaimActionsContract(contract: string): string {
  return contract.toLowerCase();
}

function toApiMintingClaimAction(
  action: string,
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
  claimId: number,
  rows: MintingClaimActionRow[]
): ApiMintingClaimActionsResponse {
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  const supportedActions =
    getSupportedMintingClaimActionTypes(normalizedContract);
  const rowsByAction = new Map(rows.map((row) => [row.action, row]));

  return {
    contract: normalizedContract,
    claim_id: claimId,
    actions: supportedActions.map((action) =>
      toApiMintingClaimAction(action, rowsByAction.get(action))
    )
  };
}

export function getSupportedMintingClaimActionTypesOrThrow(
  contract: string
): readonly string[] {
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  const supportedActions =
    getSupportedMintingClaimActionTypes(normalizedContract);
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
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  const supportedActions =
    getSupportedMintingClaimActionTypesOrThrow(normalizedContract);
  if (!isSupportedMintingClaimActionType(normalizedContract, action)) {
    throw new BadRequestException(
      `Unsupported action "${action}" for ${getMintingClaimActionsContractLabel(normalizedContract)}. Supported actions: ${supportedActions.join(', ')}`
    );
  }
}

export function getMintingClaimActionTypesResponse(
  contract: string
): ApiMintingClaimActionTypesResponse {
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  return {
    contract: normalizedContract,
    action_types: [
      ...getSupportedMintingClaimActionTypesOrThrow(normalizedContract)
    ]
  };
}

export async function getMintingClaimActionsResponse(
  contract: string,
  claimId: number,
  ctx: RequestContext
): Promise<ApiMintingClaimActionsResponse> {
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  getSupportedMintingClaimActionTypesOrThrow(normalizedContract);
  const rows = await mintingClaimActionsDb.findByContractAndClaimId(
    normalizedContract,
    claimId,
    ctx
  );
  return buildMintingClaimActionsResponse(normalizedContract, claimId, rows);
}

export async function upsertMintingClaimActionAndGetResponse(
  contract: string,
  claimId: number,
  body: ApiMintingClaimActionUpdateRequest,
  wallet: string,
  ctx: RequestContext
): Promise<ApiMintingClaimActionsResponse> {
  const normalizedContract = canonicalizeMintingClaimActionsContract(contract);
  assertSupportedMintingClaimAction(normalizedContract, body.action);
  const performUpsertAndReadback = async (
    txCtx: RequestContext
  ): Promise<ApiMintingClaimActionsResponse> => {
    await mintingClaimActionsDb.upsertAction(
      {
        contract: normalizedContract,
        claim_id: claimId,
        action: body.action,
        completed: body.completed,
        wallet
      },
      txCtx
    );

    return getMintingClaimActionsResponse(normalizedContract, claimId, txCtx);
  };

  if (ctx.connection) {
    return performUpsertAndReadback(ctx);
  }

  return mintingClaimActionsDb.executeNativeQueriesInTransaction(
    async (connection) => {
      const txCtx: RequestContext = { ...ctx, connection };
      return performUpsertAndReadback(txCtx);
    }
  );
}
