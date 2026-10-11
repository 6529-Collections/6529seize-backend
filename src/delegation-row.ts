import { Delegation, DelegationEvent } from '@/entities/IDelegation';

/** Largest token id the delegations.token_id column (signed INT) can hold. */
export const MAX_STORABLE_DELEGATION_TOKEN_ID = BigInt(2_147_483_647);

/**
 * Builds the stored row for a delegation registration. Values the event does
 * not carry are left unset so the column defaults apply (never expires, all
 * tokens, token 0). A token-specific registration keeps all_tokens = false
 * and its token id.
 */
export function toDelegationRow(registration: DelegationEvent): Delegation {
  const row = new Delegation();
  row.block = registration.block;
  row.from_address = registration.wallet1;
  row.to_address = registration.wallet2;
  row.collection = registration.collection;
  row.use_case = registration.use_case;
  if (registration.expiry !== undefined) {
    row.expiry = registration.expiry;
  }
  if (registration.all_tokens !== undefined) {
    row.all_tokens = registration.all_tokens;
  }
  if (registration.token_id !== undefined) {
    row.token_id = registration.token_id;
  }
  return row;
}
