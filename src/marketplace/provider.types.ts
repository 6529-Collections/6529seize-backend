export type MarketTradeKind = 'BUY' | 'LIST' | 'OFFER' | 'ACCEPT';

export interface MarketAsset {
  contract: string;
  tokenId: string;
  standard: 'ERC721' | 'ERC1155';
}

export interface MarketOrderIdentity {
  protocolAddress: string;
  orderHash: string;
}

/** Fee terms are supplied by the server's reviewed policy, never from user input. */
export interface MarketFee {
  recipient: string;
  amountWei: string;
}

/** All amounts, including fees, describe the explicitly requested fill quantity. */
export interface MarketTradeIntent {
  kind: MarketTradeKind;
  chainId: 1;
  wallet: string;
  recipient: string;
  asset: MarketAsset;
  quantity: string;
  currency: string;
  maxTotalWei: string;
  minNetWei: string;
  fees: MarketFee[];
  includeOptionalCreatorFees: boolean;
  order?: MarketOrderIdentity;
  /** Required for LIST/OFFER; epoch seconds, not an API quote TTL. */
  startTime?: string;
  endTime?: string;
}

export interface MarketCancelIntent {
  kind: 'CANCEL';
  chainId: 1;
  wallet: string;
  order: MarketOrderIdentity;
}

export interface MarketGasEstimate {
  gas_limit: string;
  max_fee_per_gas: string;
  gas_reserve_wei: string;
}

export interface MarketTransaction {
  kind: 'TRANSACTION';
  chainId: 1;
  from: string;
  to: string;
  value: string;
  data: string;
  purpose: 'APPROVE_NFT' | 'APPROVE_CURRENCY' | 'FULFILL' | 'CANCEL';
  approvalScope?: 'TOKEN' | 'COLLECTION' | 'CURRENCY_AMOUNT';
  gas?: MarketGasEstimate;
}

export interface SeaportOfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

export interface SeaportOrderComponents {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
}

export interface SeaportOrderParameters extends Omit<
  SeaportOrderComponents,
  'counter'
> {
  totalOriginalConsiderationItems: number;
}

export interface SeaportTypedData {
  domain: {
    name: 'Seaport';
    version: '1.6';
    chainId: 1;
    verifyingContract: string;
  };
  primaryType: 'OrderComponents';
  types: Record<string, Array<{ name: string; type: string }>>;
  message: SeaportOrderComponents;
}

export interface ValidatedMarketOrder {
  protocolAddress: string;
  orderHash: string;
  digest: string;
  components: SeaportOrderComponents;
  typedData: SeaportTypedData;
  totalWei: string;
  netWei: string;
  fees: MarketFee[];
}

export interface PreparedOrder {
  kind: 'SIGN_ORDER';
  chainId: 1;
  from: string;
  order: ValidatedMarketOrder;
}

/** Internal only: never return the provider's bearer signature in discovery DTOs. */
export interface MarketProviderOrder {
  identity: MarketOrderIdentity;
  components: SeaportOrderComponents;
  signature: string;
}

export interface MarketDiscoveredOrder {
  identity: MarketOrderIdentity;
  maker: string;
  /** Signed NFT destination for offers; seller proceeds address for listings. */
  recipient: string;
  asset: MarketAsset;
  side: 'LISTING' | 'OFFER';
  quantity: string;
  currency: string;
  totalWei: string;
  /** Present only when one exact unit can fill without rounding any signed item. */
  unitTotalWei?: string;
  /** Availability independent of the quoted amount's quantity, e.g. a unit-priced TDH result. */
  availableQuantity?: string;
  netWei: string;
  fees: MarketFee[];
  startTime: string;
  endTime: string;
}

export class MarketValidationError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INTENT'
      | 'UNSUPPORTED_PROTOCOL'
      | 'UNSUPPORTED_ACTION'
      | 'UNSUPPORTED_ZONE'
      | 'UNSUPPORTED_CONDUIT'
      | 'ORDER_MISMATCH'
      | 'AMOUNT_MISMATCH'
      | 'INVALID_SIGNATURE'
      | 'PROVIDER_UNAVAILABLE',
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, MarketValidationError.prototype);
  }
}
