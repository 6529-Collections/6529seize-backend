import { z } from 'zod';
import { ApiMarketTradeOrder } from '@/api/generated/models/ApiMarketTradeOrder';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { marketChain } from '@/marketplace/market-chain';
import { marketCatalogAsset } from '@/marketplace/market-preparation';
import { describeMarketOrder } from '@/marketplace/provider.opensea';
import { MarketValidationError } from '@/marketplace/provider.types';
import { assertMarketProtocol } from '@/marketplace/seaport.registry';
import {
  marketAddressSchema,
  marketHashSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { marketplaceProvider } from './marketplace.service';
import { discoveredOrderDto } from './marketplace.dto';

export const marketOrderResolutionQuerySchema = z
  .object({
    asset_key: z.string().min(1).max(150),
    protocol_address: marketAddressSchema,
    side: z.enum(['LISTING', 'OFFER'])
  })
  .strict();

export const marketOrderResolutionSchema =
  marketOrderResolutionQuerySchema.extend({
    order_hash: marketHashSchema
  });

export type MarketOrderResolutionRequest = z.infer<
  typeof marketOrderResolutionSchema
>;

function unavailable(message: string): never {
  throw new MarketValidationError('ORDER_MISMATCH', message);
}

/** Seaport status is a filled fraction, not an NFT count. */
function remainingQuantity(
  original: bigint,
  status: { cancelled: boolean; filled: bigint; size: bigint }
): string {
  if (
    status.cancelled ||
    status.size < BigInt(0) ||
    status.filled < BigInt(0) ||
    (status.size === BigInt(0) && status.filled !== BigInt(0)) ||
    (status.size > BigInt(0) && status.filled >= status.size)
  )
    unavailable('This order is no longer available.');
  if (status.size === BigInt(0)) return original.toString();
  const remaining = original * (status.size - status.filled);
  if (remaining % status.size !== BigInt(0))
    unavailable('The remaining order quantity could not be verified.');
  return (remaining / status.size).toString();
}

/** Public discovery only: no operation, signature or fulfillment is created. */
export async function resolveMarketOrder(
  input: MarketOrderResolutionRequest,
  budget = new CollectingWorkBudget()
): Promise<ApiMarketTradeOrder> {
  const query = marketOrderResolutionSchema.parse(input);
  assertMarketProtocol(query.protocol_address);
  const asset = await budget.waitFor(() => marketCatalogAsset(query.asset_key));
  const identity = {
    protocolAddress: query.protocol_address,
    orderHash: query.order_hash
  };
  const selected = await budget.waitFor(() =>
    marketplaceProvider().getOrder(identity)
  );
  if (
    selected.identity.protocolAddress.toLowerCase() !==
      identity.protocolAddress.toLowerCase() ||
    selected.identity.orderHash.toLowerCase() !==
      identity.orderHash.toLowerCase()
  )
    unavailable('The provider returned another order.');
  const marketAsset = {
    contract: asset.contract,
    tokenId: asset.token_id,
    standard:
      asset.family === 'memes' ? ('ERC1155' as const) : ('ERC721' as const)
  };
  // Validate exact asset, side and signed economics before requesting chain data.
  const original = describeMarketOrder(selected, marketAsset, query.side);
  const chain = marketChain();
  const [snapshot, status, counter] = await budget.waitFor(() =>
    Promise.all([
      chain.snapshot(),
      chain.orderStatus(identity.orderHash),
      chain.counter(selected.components.offerer)
    ])
  );
  const now = BigInt(snapshot.block_timestamp);
  if (
    BigInt(original.startTime) > now ||
    BigInt(original.endTime) <= now ||
    marketUintSchema.parse(counter) !== selected.components.counter
  )
    unavailable('This order is no longer active.');
  const available = remainingQuantity(BigInt(original.quantity), status);
  // Reuse exact signed-payment scaling; never round fees or infer partial fills.
  const order = describeMarketOrder(
    selected,
    marketAsset,
    query.side,
    available
  );
  budget.assertAvailable();
  // The DTO deliberately excludes provider signatures and raw signed payloads.
  return discoveredOrderDto(order, asset.asset_key);
}
