import type { MarketChain } from '@/marketplace/market-chain';
import {
  MarketTransaction,
  MarketValidationError
} from '@/marketplace/provider.types';

// Ethereum mainnet EIP-7825: https://eips.ethereum.org/EIPS/eip-7825
export const MARKET_BATCH_MAX_TRANSACTION_GAS = BigInt(16777216);

/** A resource-count bound is not evidence that the complete selection fits one transaction. */
export async function simulateMarketBatch(
  chain: MarketChain,
  transaction: MarketTransaction
) {
  const gas = await chain.simulate(transaction);
  const block = await chain.rpc.getBlock('latest');
  if (!block?.hash || block.timestamp * 1000 < Date.now() - 120000)
    throw new MarketValidationError(
      'PROVIDER_UNAVAILABLE',
      'The chain snapshot is stale. Refresh the complete selection.'
    );
  if (
    BigInt(gas.gas_limit) > MARKET_BATCH_MAX_TRANSACTION_GAS ||
    BigInt(gas.gas_limit) > block.gasLimit
  )
    throw new MarketValidationError(
      'UNSUPPORTED_ACTION',
      'The complete selection exceeds the transaction gas limit. Reduce the selection before reviewing again.'
    );
  return gas;
}
