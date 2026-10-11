import { USE_CASE_MINTING, USE_CASE_SUB_DELEGATION } from '@/constants';
import { toDelegationRow } from '@/delegation-row';
import { DelegationEvent, EventType } from '@/entities/IDelegation';

function registration(overrides: Partial<DelegationEvent>): DelegationEvent {
  return {
    block: 10,
    type: EventType.REGISTER,
    wallet1: '0xcold',
    wallet2: '0xhot',
    collection: '0xcollection',
    use_case: USE_CASE_MINTING,
    ...overrides
  };
}

describe('toDelegationRow', () => {
  it('keeps a token-specific delegation scoped to its token', () => {
    const row = toDelegationRow(
      registration({ expiry: 1_900_000_000, all_tokens: false, token_id: 42 })
    );
    expect(row).toMatchObject({
      block: 10,
      from_address: '0xcold',
      to_address: '0xhot',
      collection: '0xcollection',
      use_case: USE_CASE_MINTING,
      expiry: 1_900_000_000,
      all_tokens: false,
      token_id: 42
    });
  });

  it('keeps a token-specific delegation for token 0', () => {
    const row = toDelegationRow(
      registration({ expiry: 1, all_tokens: false, token_id: 0 })
    );
    expect(row.all_tokens).toBe(false);
    expect(row.token_id).toBe(0);
  });

  it('stores an all-tokens delegation', () => {
    const row = toDelegationRow(
      registration({ expiry: 1_900_000_000, all_tokens: true, token_id: 0 })
    );
    expect(row.all_tokens).toBe(true);
    expect(row.token_id).toBe(0);
  });

  it('leaves values the event does not carry to the column defaults', () => {
    const row = toDelegationRow(
      registration({ use_case: USE_CASE_SUB_DELEGATION })
    );
    expect(row).not.toHaveProperty('expiry');
    expect(row).not.toHaveProperty('all_tokens');
    expect(row).not.toHaveProperty('token_id');
  });
});
