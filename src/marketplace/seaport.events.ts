import { Interface } from 'ethers';
import { assertMarketProtocol } from '@/marketplace/seaport.registry';
import { MarketValidationError } from '@/marketplace/provider.types';

export const MARKET_SEAPORT_EVENTS = new Interface([
  'event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)',
  'event OrderCancelled(bytes32 orderHash,address indexed offerer,address indexed zone)'
]);

export interface MarketFulfilledItem {
  itemType: number;
  token: string;
  tokenId: string;
  amount: string;
  recipient?: string;
}
export interface MarketFulfillmentEvent {
  orderHash: string;
  offerer: string;
  zone: string;
  recipient: string;
  offer: MarketFulfilledItem[];
  consideration: MarketFulfilledItem[];
}

/** Caller must bind the log to the canonical finalized receipt of the reviewed tx. */
export function decodeMarketOrderFulfilled(log: {
  address: string;
  topics: readonly string[];
  data: string;
}): MarketFulfillmentEvent {
  assertMarketProtocol(log.address);
  try {
    const event = MARKET_SEAPORT_EVENTS.decodeEventLog(
      'OrderFulfilled',
      log.data,
      [...log.topics]
    );
    const item = (
      value: unknown,
      consideration: boolean
    ): MarketFulfilledItem => {
      const parts = value as {
        itemType: bigint;
        token: string;
        identifier: bigint;
        amount: bigint;
        recipient?: string;
      };
      return {
        itemType: Number(parts.itemType),
        token: parts.token.toLowerCase(),
        tokenId: parts.identifier.toString(),
        amount: parts.amount.toString(),
        ...(consideration ? { recipient: parts.recipient!.toLowerCase() } : {})
      };
    };
    return {
      orderHash: String(event.orderHash).toLowerCase(),
      offerer: String(event.offerer).toLowerCase(),
      zone: String(event.zone).toLowerCase(),
      recipient: String(event.recipient).toLowerCase(),
      offer: Array.from(event.offer as unknown[]).map((value) =>
        item(value, false)
      ),
      consideration: Array.from(event.consideration as unknown[]).map((value) =>
        item(value, true)
      )
    };
  } catch {
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The receipt did not contain a valid Seaport fulfillment event.'
    );
  }
}
