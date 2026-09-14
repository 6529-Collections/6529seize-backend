import { TypedDataEncoder } from 'ethers';
import { isMarketCriteriaOffer } from '@/marketplace/seaport-criteria';
import { z } from 'zod';
import {
  MarketTradeIntent,
  MarketValidationError,
  SeaportOrderComponents,
  SeaportOfferItem,
  ValidatedMarketOrder,
  MarketFee
} from '@/marketplace/provider.types';
import {
  assertMarketProtocol,
  MARKET_ASSET_STANDARDS,
  MARKET_OPENSEA_ZONE,
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH,
  marketSpender
} from '@/marketplace/seaport.registry';
import {
  marketAddressSchema,
  marketHashSchema,
  marketUintSchema,
  marketOrderComponentsSchema,
  parseMarketValue,
  SEAPORT_ORDER_TYPES
} from '@/marketplace/seaport.schema';

const intentSchema = z
  .object({
    kind: z.enum(['BUY', 'LIST', 'OFFER', 'ACCEPT']),
    chainId: z.literal(1),
    wallet: marketAddressSchema,
    recipient: marketAddressSchema,
    asset: z
      .object({
        contract: marketAddressSchema,
        tokenId: marketUintSchema,
        standard: z.enum(['ERC721', 'ERC1155'])
      })
      .strict(),
    quantity: marketUintSchema,
    currency: marketAddressSchema,
    maxTotalWei: marketUintSchema,
    minNetWei: marketUintSchema,
    fees: z
      .array(
        z
          .object({
            recipient: marketAddressSchema,
            amountWei: marketUintSchema
          })
          .strict()
      )
      .max(15),
    includeOptionalCreatorFees: z.boolean(),
    order: z
      .object({
        protocolAddress: marketAddressSchema,
        orderHash: marketHashSchema
      })
      .strict()
      .optional(),
    startTime: marketUintSchema.optional(),
    endTime: marketUintSchema.optional()
  })
  .strict();

export function sameMarketAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function reject(message: string): never {
  throw new MarketValidationError('ORDER_MISMATCH', message);
}

export function assertMarketIntent(
  input: MarketTradeIntent
): MarketTradeIntent {
  const i = parseMarketValue(intentSchema, input);
  if (
    MARKET_ASSET_STANDARDS[i.asset.contract.toLowerCase()] !==
      i.asset.standard ||
    BigInt(i.quantity) <= BigInt(0) ||
    (i.asset.standard === 'ERC721' && i.quantity !== '1') ||
    sameMarketAddress(i.wallet, MARKET_ZERO_ADDRESS) ||
    sameMarketAddress(i.recipient, MARKET_ZERO_ADDRESS)
  )
    reject('Unsupported asset, wallet, recipient or quantity.');
  if (![MARKET_ZERO_ADDRESS, MARKET_WETH].includes(i.currency.toLowerCase()))
    reject('Only ETH and WETH are supported.');
  if (
    ['OFFER', 'ACCEPT'].includes(i.kind) &&
    !sameMarketAddress(i.currency, MARKET_WETH)
  )
    reject('Offers require WETH.');
  if (
    ['LIST', 'OFFER'].includes(i.kind) &&
    (!i.startTime || !i.endTime || BigInt(i.startTime) >= BigInt(i.endTime))
  )
    reject('New orders require explicit valid on-chain start and end times.');
  if (
    ['LIST', 'OFFER', 'ACCEPT'].includes(i.kind) &&
    !sameMarketAddress(i.recipient, i.wallet)
  )
    reject('This action requires its recipient to be the signing wallet.');
  if (i.order) assertMarketProtocol(i.order.protocolAddress);
  return i;
}

function isNft(item: SeaportOfferItem, i: MarketTradeIntent): boolean {
  return (
    isMarketCriteriaOffer(item, i) ||
    (item.itemType === (i.asset.standard === 'ERC721' ? 2 : 3) &&
      sameMarketAddress(item.token, i.asset.contract) &&
      item.identifierOrCriteria === i.asset.tokenId)
  );
}
function assertCurrency(item: SeaportOfferItem, i: MarketTradeIntent): void {
  if (
    item.itemType !==
      (sameMarketAddress(i.currency, MARKET_ZERO_ADDRESS) ? 0 : 1) ||
    !sameMarketAddress(item.token, i.currency) ||
    item.identifierOrCriteria !== '0'
  )
    reject('The order has an unexpected payment asset.');
}
function aggregateFees(fees: MarketFee[]): string {
  const result: Record<string, string> = {};
  for (const fee of fees) {
    const key = fee.recipient.toLowerCase();
    result[key] = (
      BigInt(result[key] ?? '0') + BigInt(fee.amountWei)
    ).toString();
  }
  return JSON.stringify(
    Object.keys(result)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, result[key]])
  );
}

/** Validates exact token flows; does not substitute chain state, simulation or ownership checks. */
export function validateMarketOrder(
  intent: MarketTradeIntent,
  input: unknown,
  protocolAddress = MARKET_SEAPORT
): ValidatedMarketOrder {
  const i = assertMarketIntent(intent);
  assertMarketProtocol(protocolAddress);
  const c: SeaportOrderComponents = parseMarketValue(
    marketOrderComponentsSchema,
    input
  );
  marketSpender(c.conduitKey);
  const restricted = c.orderType >= 2;
  if (
    restricted
      ? !sameMarketAddress(c.zone, MARKET_OPENSEA_ZONE)
      : !sameMarketAddress(c.zone, MARKET_ZERO_ADDRESS)
  )
    throw new MarketValidationError(
      'UNSUPPORTED_ZONE',
      'The order uses an unverified zone.'
    );
  if (!sameMarketAddress(c.zoneHash, MARKET_ZERO_HASH))
    reject('Non-zero zone commitments are not supported.');
  if (BigInt(c.startTime) >= BigInt(c.endTime))
    reject('Invalid on-chain validity interval.');
  const creating = i.kind === 'LIST' || i.kind === 'OFFER';
  if (
    creating &&
    (!sameMarketAddress(c.offerer, i.wallet) ||
      c.startTime !== i.startTime ||
      c.endTime !== i.endTime)
  )
    reject('The maker or on-chain validity interval changed.');
  for (const item of [...c.offer, ...c.consideration]) {
    if (
      item.startAmount !== item.endAmount ||
      BigInt(item.startAmount) <= BigInt(0)
    )
      reject('Dynamic or zero amount orders are not supported.');
  }
  const listing = i.kind === 'BUY' || i.kind === 'LIST';
  const nft = listing ? c.offer[0] : c.consideration[0];
  if (!isNft(nft, i))
    reject('The order does not transfer the exact requested NFT.');
  if (
    i.kind === 'OFFER' &&
    !sameMarketAddress(c.consideration[0].recipient, i.recipient)
  )
    reject('The signed offer NFT destination changed.');
  const requested = BigInt(i.quantity),
    original = BigInt(nft.startAmount);
  if (
    requested > original ||
    (creating && requested !== original) ||
    (requested !== original && c.orderType % 2 !== 1)
  )
    reject('The requested quantity cannot be filled by this order.');
  const scaled = (amount: string): bigint => {
    const product = BigInt(amount) * requested;
    if (product % original !== BigInt(0))
      reject('This ERC1155 fill would round an item or fee amount.');
    return product / original;
  };
  // Every item must divide, including fees, not only the NFT and headline price.
  for (const item of [...c.offer, ...c.consideration]) scaled(item.startAmount);
  let total: bigint, net: bigint;
  let fees: MarketFee[];
  if (listing) {
    c.consideration.forEach((item) => assertCurrency(item, i));
    if (!sameMarketAddress(c.consideration[0].recipient, c.offerer))
      reject('Seller proceeds are redirected.');
    net = scaled(c.consideration[0].startAmount);
    fees = c.consideration.slice(1).map((item) => ({
      recipient: item.recipient,
      amountWei: scaled(item.startAmount).toString()
    }));
    total =
      net + fees.reduce((sum, fee) => sum + BigInt(fee.amountWei), BigInt(0));
  } else {
    assertCurrency(c.offer[0], i);
    c.consideration.slice(1).forEach((item) => assertCurrency(item, i));
    total = scaled(c.offer[0].startAmount);
    fees = c.consideration.slice(1).map((item) => ({
      recipient: item.recipient,
      amountWei: scaled(item.startAmount).toString()
    }));
    net =
      total - fees.reduce((sum, fee) => sum + BigInt(fee.amountWei), BigInt(0));
  }
  if (
    net <= BigInt(0) ||
    total > BigInt(i.maxTotalWei) ||
    net < BigInt(i.minNetWei) ||
    aggregateFees(fees) !== aggregateFees(i.fees)
  )
    throw new MarketValidationError(
      'AMOUNT_MISMATCH',
      'The exact payment, proceeds or fee recipients changed.'
    );
  if (creating && total !== BigInt(i.maxTotalWei))
    reject('The new order price changed.');
  const typedData = {
    domain: {
      name: 'Seaport' as const,
      version: '1.6' as const,
      chainId: 1 as const,
      verifyingContract: MARKET_SEAPORT
    },
    primaryType: 'OrderComponents' as const,
    types: SEAPORT_ORDER_TYPES,
    message: c
  };
  const orderHash = TypedDataEncoder.hashStruct(
    'OrderComponents',
    SEAPORT_ORDER_TYPES,
    c
  );
  if (i.order && orderHash.toLowerCase() !== i.order.orderHash.toLowerCase())
    reject('The signed order hash changed.');
  return {
    protocolAddress: MARKET_SEAPORT,
    orderHash,
    digest: TypedDataEncoder.hash(typedData.domain, typedData.types, c),
    components: c,
    typedData,
    totalWei: total.toString(),
    netWei: net.toString(),
    fees
  };
}
