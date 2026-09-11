import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import {
  MarketBatchFulfillmentMaterial,
  MarketBatchIntent,
  MarketBatchMirrorTerms
} from '@/marketplace/market-batch.types';
import {
  MarketTradeIntent,
  SeaportOrderComponents
} from '@/marketplace/provider.types';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import {
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';

export const BATCH_BUYER = '0x1111111111111111111111111111111111111111';
export const BATCH_OWN = '0x2222222222222222222222222222222222222222';
export const BATCH_FREN = '0x3333333333333333333333333333333333333333';
export const BATCH_SELLER = '0x4444444444444444444444444444444444444444';
export const BATCH_FEE = '0x5555555555555555555555555555555555555555';

export function marketBatchFixture(count = 2): {
  intent: MarketBatchIntent;
  materials: MarketBatchFulfillmentMaterial[];
  terms: MarketBatchMirrorTerms;
} {
  const intent: MarketBatchIntent = {
    kind: 'BUY_BATCH',
    chainId: 1,
    wallet: BATCH_BUYER,
    currency: MARKET_ZERO_ADDRESS,
    executionPolicy: 'ALL_OR_REVERT',
    totalWei: (BigInt(100) + BigInt(count - 1) * BigInt(200)).toString(),
    items: []
  };
  const materials: MarketBatchFulfillmentMaterial[] = [];
  for (let index = 0; index < count; index++) {
    const is721 = index === 0;
    const asset = {
      contract: is721 ? GRADIENT_CONTRACT : MEMES_CONTRACT,
      tokenId: String(index + 1),
      standard: is721 ? ('ERC721' as const) : ('ERC1155' as const)
    };
    const buy: MarketTradeIntent = {
      kind: 'BUY',
      chainId: 1,
      wallet: BATCH_BUYER,
      recipient: BATCH_OWN,
      asset,
      quantity: is721 ? '1' : '2',
      currency: MARKET_ZERO_ADDRESS,
      maxTotalWei: is721 ? '100' : '200',
      minNetWei: is721 ? '90' : '180',
      fees: [{ recipient: BATCH_FEE, amountWei: is721 ? '10' : '20' }],
      includeOptionalCreatorFees: false
    };
    const components: SeaportOrderComponents = {
      offerer: BATCH_SELLER,
      zone: MARKET_ZERO_ADDRESS,
      offer: [
        {
          itemType: is721 ? 2 : 3,
          token: asset.contract,
          identifierOrCriteria: asset.tokenId,
          startAmount: is721 ? '1' : '3',
          endAmount: is721 ? '1' : '3'
        }
      ],
      consideration: [
        {
          itemType: 0,
          token: MARKET_ZERO_ADDRESS,
          identifierOrCriteria: '0',
          startAmount: is721 ? '90' : '270',
          endAmount: is721 ? '90' : '270',
          recipient: BATCH_SELLER
        },
        {
          itemType: 0,
          token: MARKET_ZERO_ADDRESS,
          identifierOrCriteria: '0',
          startAmount: is721 ? '10' : '30',
          endAmount: is721 ? '10' : '30',
          recipient: BATCH_FEE
        }
      ],
      orderType: is721 ? 0 : 1,
      startTime: '1000',
      endTime: '3000',
      salt: String(index + 1),
      zoneHash: MARKET_ZERO_HASH,
      conduitKey: MARKET_OPENSEA_CONDUIT_KEY,
      counter: '0'
    };
    const order = validateMarketOrder(buy, components);
    buy.order = { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash };
    intent.items.push({
      assetKey: `1:${asset.contract.toLowerCase()}:${asset.tokenId}`,
      intent: buy,
      allocations: [
        {
          recipient: BATCH_OWN,
          quantity: '1',
          recipientInProfile: true,
          acknowledgeExternalRecipient: false
        },
        ...(is721
          ? []
          : [
              {
                recipient: BATCH_FREN,
                quantity: '1',
                recipientInProfile: false,
                acknowledgeExternalRecipient: true
              }
            ])
      ]
    });
    materials.push({
      order,
      signature: '0x1122',
      extraData: '0x',
      fulfillerConduitKey: MARKET_OPENSEA_CONDUIT_KEY
    });
  }
  return {
    intent,
    materials,
    terms: { startTime: '1500', endTime: '2000', salt: '999' }
  };
}
