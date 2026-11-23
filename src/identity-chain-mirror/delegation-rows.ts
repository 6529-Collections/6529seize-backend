import { MAX_STORABLE_DELEGATION_TOKEN_ID } from '@/delegation-row';
import { ChainDelegation } from '@/chain-gateway/chain-gateway.types';
import { CHAIN_BLOCK_BASE, NEVER_EXPIRES } from './identity-plan';

/** A row of 6529.io's delegations table, as the chain's records give it. */
export interface DelegationRowWrite {
  readonly block: number;
  readonly from_address: string;
  readonly to_address: string;
  readonly collection: string;
  readonly use_case: number;
  readonly expiry: number;
  readonly all_tokens: boolean;
  readonly token_id: number;
}

/**
 * A chain delegation record as the delegations row of one wallet: imported
 * records keep their Ethereum block, records set on the chain sit above
 * CHAIN_BLOCK_BASE; "never" (0) expires at 6529.io's never date. Null for a
 * token id the column can't hold.
 */
export function toDelegationRow(
  wallet: string,
  record: ChainDelegation
): DelegationRowWrite | null {
  let tokenId = 0;
  if (!record.allTokens) {
    try {
      const big = BigInt(record.tokenId);
      if (big > MAX_STORABLE_DELEGATION_TOKEN_ID) return null;
      tokenId = Number(big);
    } catch {
      return null;
    }
  }
  // Expiry 0 means never, as on NFTDelegation.
  let expiry = NEVER_EXPIRES;
  try {
    const big = BigInt(record.expiry);
    expiry =
      big > BigInt(0) && big < BigInt(NEVER_EXPIRES)
        ? Number(big)
        : NEVER_EXPIRES;
  } catch {
    expiry = NEVER_EXPIRES;
  }
  const block =
    record.source === 'imported' && record.ethBlock
      ? Number(record.ethBlock)
      : CHAIN_BLOCK_BASE + Number(record.setHeight);
  return {
    block,
    from_address: wallet.toLowerCase(),
    to_address: record.delegate.toLowerCase(),
    collection: record.collection.toLowerCase(),
    use_case: Number(record.useCase),
    expiry,
    all_tokens: !!record.allTokens,
    token_id: tokenId
  };
}
