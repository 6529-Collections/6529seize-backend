import type { MintingClaimActionRow } from '@/api/minting-claims/minting-claim-actions.db';
import {
  buildMintingClaimActionsResponse,
  getMintingClaimActionTypesResponse
} from '@/api/minting-claims/minting-claim-actions.api.service';
import { MEMES_MINTING_CLAIM_ACTION_TYPES } from '@/minting-claims/minting-claim-actions';

function actionRow(
  action: string,
  overrides: Partial<MintingClaimActionRow> = {}
): MintingClaimActionRow {
  return {
    id: 'row-1',
    contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
    token_id: 123,
    action,
    completed: true,
    created_by_wallet: '0x1111111111111111111111111111111111111111',
    updated_by_wallet: '0x2222222222222222222222222222222222222222',
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  };
}

describe('buildMintingClaimActionsResponse', () => {
  it('fills in missing actions as incomplete in enum order', () => {
    const response = buildMintingClaimActionsResponse(
      '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
      123,
      [
        actionRow(MEMES_MINTING_CLAIM_ACTION_TYPES[1], {
          completed: 1
        }),
        actionRow(MEMES_MINTING_CLAIM_ACTION_TYPES[5], {
          completed: 0,
          updated_at: 3000
        })
      ]
    );

    expect(response.contract).toBe(
      '0x33fd426905f149f8376e227d0c9d3340aad17af1'
    );
    expect(response.token_id).toBe(123);
    expect(response.actions.map((action) => action.action)).toEqual(
      MEMES_MINTING_CLAIM_ACTION_TYPES
    );

    expect(response.actions[0]).toEqual({
      action: MEMES_MINTING_CLAIM_ACTION_TYPES[0],
      completed: false,
      created_at: undefined,
      updated_at: undefined,
      created_by_wallet: undefined,
      updated_by_wallet: undefined
    });

    expect(response.actions[1]).toEqual({
      action: MEMES_MINTING_CLAIM_ACTION_TYPES[1],
      completed: true,
      created_at: 1000,
      updated_at: 2000,
      created_by_wallet: '0x1111111111111111111111111111111111111111',
      updated_by_wallet: '0x2222222222222222222222222222222222222222'
    });

    expect(response.actions[5]?.completed).toBe(false);
    expect(response.actions[5]?.updated_at).toBe(3000);
  });
});

describe('getMintingClaimActionTypesResponse', () => {
  it('returns supported action types for MEMES', () => {
    const response = getMintingClaimActionTypesResponse(
      '0x33FD426905F149f8376e227d0C9D3340AaD17aF1'
    );

    expect(response).toEqual({
      contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
      action_types: [...MEMES_MINTING_CLAIM_ACTION_TYPES]
    });
  });
});
