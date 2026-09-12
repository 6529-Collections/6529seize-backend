import {
  MarketTradeIntent,
  MarketGasEstimate,
  MarketTransaction,
  MarketOrderIdentity,
  SeaportOrderParameters,
  ValidatedMarketOrder
} from '@/marketplace/provider.types';

export interface MarketBatchAllocation {
  recipient: string;
  quantity: string;
  recipientInProfile: boolean;
  acknowledgeExternalRecipient: boolean;
}

export interface MarketBatchLine {
  assetKey: string;
  /** The exact selected seller's fill economics; recipient is its first allocation. */
  intent: MarketTradeIntent;
  allocations: MarketBatchAllocation[];
}

export interface MarketBatchIntent {
  kind: 'BUY_BATCH';
  chainId: 1;
  wallet: string;
  currency: string;
  executionPolicy: 'ALL_OR_REVERT';
  totalWei: string;
  items: MarketBatchLine[];
}

/** Internal authorization material. Never expose in listing discovery or logs. */
export interface MarketBatchFulfillmentMaterial {
  order: ValidatedMarketOrder;
  signature: string;
  extraData: string;
  fulfillerConduitKey: string;
}

/** Persist with the reviewed transaction; do not regenerate during send/recovery. */
export interface MarketBatchMirrorTerms {
  startTime: string;
  endTime: string;
  salt: string;
}

export interface MarketAdvancedOrder {
  parameters: SeaportOrderParameters;
  numerator: string;
  denominator: string;
  signature: string;
  extraData: string;
}

export interface MarketFulfillmentComponent {
  orderIndex: number;
  itemIndex: number;
}

export interface MarketBatchFulfillment {
  offerComponents: MarketFulfillmentComponent[];
  considerationComponents: MarketFulfillmentComponent[];
}

export interface MarketBatchPrepared {
  intent: MarketBatchIntent;
  approvalTransactions: [];
  transaction: MarketTransaction;
  gas: MarketGasEstimate;
  snapshot: {
    block_number: number;
    block_hash: string;
    block_timestamp: number;
  };
  feePolicyVersion: string;
  mirrorTerms: MarketBatchMirrorTerms;
  reviewOrders: Array<
    Pick<
      ValidatedMarketOrder,
      'protocolAddress' | 'orderHash' | 'digest' | 'components'
    >
  >;
  /** Unix milliseconds; also bounded by every authorization and seller expiry. */
  validUntil: number;
  settlement?: MarketBatchSettlement;
}

export interface MarketBatchSettlement {
  outcome: 'ALL_SELECTED';
  items: Array<{
    assetKey: string;
    order: MarketOrderIdentity;
    filledQuantity: string;
    allocations: MarketBatchAllocation[];
  }>;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  safeBlockNumber?: number;
}
