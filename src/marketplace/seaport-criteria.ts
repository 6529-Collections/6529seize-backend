import { concat, keccak256, toBeHex } from 'ethers';
import { z } from 'zod';
import {
  MarketTradeIntent,
  MarketValidationError,
  SeaportOrderComponents,
  SeaportOfferItem
} from '@/marketplace/provider.types';
import {
  marketHashSchema,
  marketUintSchema,
  parseMarketValue
} from '@/marketplace/seaport.schema';

const indexSchema = z.union([
  marketUintSchema,
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
]);
const resolverSchema = z
  .object({
    orderIndex: indexSchema,
    side: z.literal(1),
    index: indexSchema,
    identifier: indexSchema,
    criteriaProof: z.array(marketHashSchema).max(32)
  })
  .strict();
export interface MarketCriteriaResolver {
  orderIndex: string;
  side: 1;
  index: string;
  identifier: string;
  criteriaProof: string[];
}

/** Criteria are accepted only for an existing offer's single NFT consideration.
 * The original signed root remains unchanged; fulfillment must prove the page NFT. */
export function isMarketCriteriaOffer(
  item: SeaportOfferItem,
  intent: MarketTradeIntent
): boolean {
  return (
    intent.kind === 'ACCEPT' &&
    item.itemType === (intent.asset.standard === 'ERC721' ? 4 : 5) &&
    item.token.toLowerCase() === intent.asset.contract.toLowerCase()
  );
}

function mismatch(): never {
  throw new MarketValidationError(
    'ORDER_MISMATCH',
    'The offer criteria do not authorize the selected NFT.'
  );
}

/** Seaport hashes a 32-byte token ID, then sorted pairs (not a double-hashed leaf). */
export function validateMarketCriteria(
  intent: MarketTradeIntent,
  components: SeaportOrderComponents,
  input: unknown
): MarketCriteriaResolver[] {
  const nft = components.consideration[0];
  if (!nft || !isMarketCriteriaOffer(nft, intent)) {
    return parseMarketValue(z.array(z.never()).length(0), input);
  }
  const resolvers: MarketCriteriaResolver[] = parseMarketValue(
    z.array(resolverSchema).length(1),
    input
  ).map((value) => ({
    ...value,
    orderIndex: String(value.orderIndex),
    index: String(value.index),
    identifier: String(value.identifier)
  }));
  const resolver = resolvers[0];
  if (
    resolver.orderIndex !== '0' ||
    resolver.index !== '0' ||
    resolver.identifier !== intent.asset.tokenId
  )
    mismatch();
  const root = BigInt(nft.identifierOrCriteria);
  if (root === BigInt(0)) {
    if (resolver.criteriaProof.length !== 0) mismatch();
  } else {
    let hash = keccak256(toBeHex(BigInt(resolver.identifier), 32));
    for (const sibling of resolver.criteriaProof) {
      hash = keccak256(
        concat(
          BigInt(hash) <= BigInt(sibling) ? [hash, sibling] : [sibling, hash]
        )
      );
    }
    if (BigInt(hash) !== root) mismatch();
  }
  return resolvers;
}
