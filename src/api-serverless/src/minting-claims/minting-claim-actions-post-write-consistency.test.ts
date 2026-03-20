import type { ApiMintingClaimActionUpdateRequest } from '@/api/generated/models/ApiMintingClaimActionUpdateRequest';
import type { MintingClaimActionRow } from '@/api/minting-claims/minting-claim-actions.db';
import { upsertMintingClaimActionAndGetResponse } from '@/api/minting-claims/minting-claim-actions.api.service';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { MEMES_MINTING_CLAIM_ACTION_TYPES } from '@/minting-claims/minting-claim-actions';

jest.mock('@/api/minting-claims/minting-claim-actions.db', () => ({
  mintingClaimActionsDb: {
    executeNativeQueriesInTransaction: jest.fn(),
    findByContractAndClaimId: jest.fn(),
    upsertAction: jest.fn()
  }
}));

function actionRow(
  action: string,
  overrides: Partial<MintingClaimActionRow> = {}
): MintingClaimActionRow {
  return {
    id: 'row-1',
    contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
    claim_id: 123,
    action,
    completed: true,
    created_by_wallet: '0x1111111111111111111111111111111111111111',
    updated_by_wallet: '0x2222222222222222222222222222222222222222',
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  };
}

describe('upsertMintingClaimActionAndGetResponse', () => {
  const findByContractAndClaimIdMock = jest.mocked(
    mintingClaimActionsDb.findByContractAndClaimId
  );
  const upsertActionMock = jest.mocked(mintingClaimActionsDb.upsertAction);
  const executeNativeQueriesInTransactionMock = jest.mocked(
    mintingClaimActionsDb.executeNativeQueriesInTransaction
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses one transaction connection for the POST write and readback', async () => {
    const contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
    const claimId = 123;
    const action = MEMES_MINTING_CLAIM_ACTION_TYPES[0];
    const connection = { connection: {} };
    const body: ApiMintingClaimActionUpdateRequest = {
      action,
      completed: true
    };

    executeNativeQueriesInTransactionMock.mockImplementation(async (callback) =>
      callback(connection as any)
    );
    upsertActionMock.mockResolvedValue(undefined);
    findByContractAndClaimIdMock.mockResolvedValue([
      actionRow(action, { completed: true })
    ]);

    const response = await upsertMintingClaimActionAndGetResponse(
      contract,
      claimId,
      body,
      '0x1111111111111111111111111111111111111111',
      {}
    );

    expect(executeNativeQueriesInTransactionMock).toHaveBeenCalledTimes(1);
    expect(upsertActionMock).toHaveBeenCalledWith(
      {
        contract: contract.toLowerCase(),
        claim_id: claimId,
        action,
        completed: true,
        wallet: '0x1111111111111111111111111111111111111111'
      },
      { connection }
    );
    expect(findByContractAndClaimIdMock).toHaveBeenCalledWith(
      contract.toLowerCase(),
      claimId,
      { connection }
    );
    expect(
      response.actions.find((item) => item.action === action)?.completed
    ).toBe(true);
  });

  it('reuses an existing context connection without opening another transaction', async () => {
    const contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
    const claimId = 123;
    const action = MEMES_MINTING_CLAIM_ACTION_TYPES[0];
    const txCtx = { connection: { connection: {} } } as any;
    const body: ApiMintingClaimActionUpdateRequest = {
      action,
      completed: true
    };

    upsertActionMock.mockResolvedValue(undefined);
    findByContractAndClaimIdMock.mockResolvedValue([
      actionRow(action, { completed: true })
    ]);

    await upsertMintingClaimActionAndGetResponse(
      contract,
      claimId,
      body,
      '0x1111111111111111111111111111111111111111',
      txCtx
    );

    expect(executeNativeQueriesInTransactionMock).not.toHaveBeenCalled();
    expect(upsertActionMock).toHaveBeenCalledWith(
      {
        contract: contract.toLowerCase(),
        claim_id: claimId,
        action,
        completed: true,
        wallet: '0x1111111111111111111111111111111111111111'
      },
      txCtx
    );
    expect(findByContractAndClaimIdMock).toHaveBeenCalledWith(
      contract.toLowerCase(),
      claimId,
      txCtx
    );
  });
});
