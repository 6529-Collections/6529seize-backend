import { formatEther, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { z } from 'zod';
import {
  MarketAsset,
  MarketDiscoveredOrder,
  MarketFee,
  MarketOrderIdentity,
  MarketProviderOrder,
  MarketTradeIntent,
  MarketTransaction,
  MarketValidationError,
  PreparedOrder,
  SeaportOrderComponents,
  ValidatedMarketOrder
} from '@/marketplace/provider.types';
import {
  MARKET_ASSET_STANDARDS,
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_SEAPORT,
  assertMarketProtocol
} from '@/marketplace/seaport.registry';
import {
  marketAddressSchema,
  marketBytesSchema,
  marketHashSchema,
  marketOrderComponentsSchema,
  marketOrderParametersSchema,
  marketUintSchema,
  parseMarketValue,
  parseMarketTimestampSeconds,
  SEAPORT_ORDER_TYPES
} from '@/marketplace/seaport.schema';
import {
  assertMarketIntent,
  sameMarketAddress,
  validateMarketOrder
} from '@/marketplace/quote-validation';
import {
  assertMarketEoaSignature,
  buildMarketFulfillment,
  validateMarketTypedData
} from '@/marketplace/seaport.builder';

export const OPENSEA_REQUEST_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 2000000;

async function readProviderJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    /^\d+$/.test(length) &&
    Number(length) > MAX_PROVIDER_RESPONSE_BYTES
  )
    throw new Error('response size');
  if (!response.body) throw new Error('provider body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('response size');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export interface MarketFeePolicy {
  fees: Array<{ recipient: string; basisPoints: number; required: boolean }>;
  version: string;
}

export interface MarketCollectionListingPage {
  listings: MarketDiscoveredOrder[];
  next: string | null;
  coverage: {
    source: 'OPENSEA_PRICE_ASCENDING';
    observedAt: string;
    receivedCount: number;
    acceptedCount: number;
    hasMore: boolean;
    exhaustive: false;
  };
}

/** Exact integer policy amounts for the complete requested quantity, rounded down per recipient. */
export function marketFeesForTotal(
  policy: MarketFeePolicy,
  totalWei: string,
  includeOptional: boolean
): MarketFee[] {
  parseMarketValue(marketUintSchema, totalWei);
  return policy.fees
    .filter((fee) => fee.required || includeOptional)
    .map((fee) => ({
      recipient: fee.recipient,
      amountWei: (
        (BigInt(totalWei) * BigInt(fee.basisPoints)) /
        BigInt(10000)
      ).toString()
    }))
    .filter((fee) => fee.amountWei !== '0');
}

const objectSchema = z.record(z.unknown());
function record(value: unknown): Record<string, unknown> {
  return parseMarketValue(objectSchema, value);
}
function originalConsiderationCount(value: unknown): number {
  if (typeof value === 'string' && /^(?:[1-9]|1[0-6])$/.test(value))
    return Number(value);
  return parseMarketValue(z.number().int().min(1).max(16), value);
}
function providerQuantity(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return parseMarketValue(marketUintSchema, value);
}
function normalizeComponents(value: unknown): SeaportOrderComponents {
  const raw = { ...record(value) };
  // OpenSea GET uses a hex salt; the signed amount domain remains canonical decimal.
  if (typeof raw.salt === 'string' && /^0x[\da-fA-F]{1,64}$/.test(raw.salt))
    raw.salt = BigInt(raw.salt).toString();
  if ('totalOriginalConsiderationItems' in raw) {
    const count = originalConsiderationCount(
      raw.totalOriginalConsiderationItems
    );
    if (!Array.isArray(raw.consideration) || count !== raw.consideration.length)
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'Unsigned additional consideration is not supported.'
      );
    delete raw.totalOriginalConsiderationItems;
  }
  return parseMarketValue(marketOrderComponentsSchema, raw);
}
function orderHash(c: SeaportOrderComponents): string {
  return TypedDataEncoder.hashStruct('OrderComponents', SEAPORT_ORDER_TYPES, c);
}
function parseProviderOrder(value: unknown): MarketProviderOrder {
  const raw = record(value),
    protocol = record(raw.protocol_data);
  const identity = {
    protocolAddress: parseMarketValue(
      marketAddressSchema,
      raw.protocol_address
    ),
    orderHash: parseMarketValue(marketHashSchema, raw.order_hash)
  };
  if (raw.chain !== 'ethereum')
    throw new MarketValidationError(
      'UNSUPPORTED_PROTOCOL',
      'The provider returned another chain.'
    );
  assertMarketProtocol(identity.protocolAddress);
  const components = normalizeComponents(protocol.parameters);
  if (orderHash(components).toLowerCase() !== identity.orderHash.toLowerCase())
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The provider order hash does not match its signed components.'
    );
  return {
    identity,
    components,
    signature:
      protocol.signature == null
        ? '0x'
        : parseMarketValue(marketBytesSchema, protocol.signature)
  };
}

/** Describe only the exact signed fees, scaled to an explicitly requested fill. */
export function describeMarketOrder(
  provider: MarketProviderOrder,
  asset: MarketAsset,
  side: 'LISTING' | 'OFFER',
  quantity?: string
): MarketDiscoveredOrder {
  const c = parseMarketValue(marketOrderComponentsSchema, provider.components);
  const startTime = parseMarketTimestampSeconds(c.startTime);
  const endTime = parseMarketTimestampSeconds(c.endTime);
  const listing = side === 'LISTING';
  const nft = listing ? c.offer[0] : c.consideration[0];
  const count = quantity ?? nft.startAmount;
  parseMarketValue(marketUintSchema, count);
  const original = BigInt(nft.startAmount),
    requested = BigInt(count);
  if (original <= BigInt(0) || requested <= BigInt(0))
    throw new MarketValidationError(
      'AMOUNT_MISMATCH',
      'An exact positive quantity is required.'
    );
  const scale = (amount: string): bigint => {
    const value = BigInt(amount) * requested;
    if (value % original !== BigInt(0))
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'This fill would round a payment or fee.'
      );
    return value / original;
  };
  const fees = c.consideration.slice(1).map((item) => ({
    recipient: item.recipient,
    amountWei: scale(item.startAmount).toString()
  }));
  const feeTotal = fees.reduce(
    (sum, fee) => sum + BigInt(fee.amountWei),
    BigInt(0)
  );
  const total = listing
    ? scale(c.consideration[0].startAmount) + feeTotal
    : scale(c.offer[0].startAmount);
  const currency = listing ? c.consideration[0].token : c.offer[0].token;
  const validated = validateMarketOrder(
    {
      kind: listing ? 'BUY' : 'ACCEPT',
      chainId: 1,
      wallet: c.offerer,
      recipient: c.offerer,
      asset,
      quantity: count,
      currency,
      maxTotalWei: total.toString(),
      minNetWei: (total - feeTotal).toString(),
      fees,
      includeOptionalCreatorFees: false,
      order: provider.identity
    },
    c
  );
  const singleUnitFillable =
    original === BigInt(1) ||
    (c.orderType % 2 === 1 &&
      [...c.offer, ...c.consideration].every(
        (item) => BigInt(item.startAmount) % original === BigInt(0)
      ));
  return {
    identity: provider.identity,
    maker: c.offerer,
    recipient: c.consideration[0].recipient,
    asset,
    side,
    quantity: count,
    currency,
    totalWei: validated.totalWei,
    ...(singleUnitFillable
      ? { unitTotalWei: (total / requested).toString() }
      : {}),
    netWei: validated.netWei,
    fees,
    startTime,
    endTime
  };
}

export class OpenSeaMarketplaceProvider {
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly options: {
      apiKey: string;
      fetch?: typeof fetch;
      signal?: AbortSignal;
    }
  ) {
    this.fetcher = options.fetch ?? fetch;
  }
  private async request(
    path: string,
    body?: unknown,
    allowNotFound = false
  ): Promise<unknown> {
    if (!this.options.apiKey)
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'The marketplace provider is not configured.'
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.options.signal?.addEventListener('abort', abort, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    const timeout = setTimeout(
      () => controller.abort(),
      OPENSEA_REQUEST_TIMEOUT_MS
    );
    try {
      const response = await this.fetcher(`https://api.opensea.io${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-api-key': this.options.apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      });
      if (allowNotFound && response.status === 404) return null;
      if (!response.ok) throw new Error('provider response');
      return await readProviderJson(response);
    } catch {
      // No transport cause, headers, bearer signatures or provider body enter application logs.
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'The marketplace provider could not complete the request.'
      );
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  private async collection(asset: MarketAsset): Promise<string> {
    if (MARKET_ASSET_STANDARDS[asset.contract.toLowerCase()] !== asset.standard)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Unsupported collection.'
      );
    parseMarketValue(marketUintSchema, asset.tokenId);
    const contract = record(
      await this.request(
        `/api/v2/chain/ethereum/contract/${asset.contract.toLowerCase()}`
      )
    );
    const slug = parseMarketValue(
      z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
      contract.collection
    );
    return slug;
  }
  async getFeePolicy(asset: MarketAsset): Promise<MarketFeePolicy> {
    const slug = await this.collection(asset);
    const collection = record(
      await this.request(`/api/v2/collections/${slug}`)
    );
    const raw = parseMarketValue(
      z
        .array(
          z
            .object({
              fee: z.number().finite().nonnegative().max(100),
              recipient: marketAddressSchema,
              required: z.boolean()
            })
            .strict()
        )
        .max(15),
      collection.fees
    );
    const fees = raw.map((fee) => {
      const decimal = String(fee.fee);
      if (!/^\d+(\.\d{1,2})?$/.test(decimal))
        throw new MarketValidationError(
          'UNSUPPORTED_ACTION',
          'Unsupported provider fee precision.'
        );
      const [whole, fraction = ''] = decimal.split('.');
      return {
        recipient: fee.recipient.toLowerCase(),
        basisPoints: Number(whole) * 100 + Number(fraction.padEnd(2, '0')),
        required: fee.required
      };
    });
    if (fees.reduce((sum, fee) => sum + fee.basisPoints, 0) >= 10000)
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'Collection fees consume all proceeds.'
      );
    return { fees, version: keccak256(toUtf8Bytes(JSON.stringify(fees))) };
  }
  async getOrder(identity: MarketOrderIdentity): Promise<MarketProviderOrder> {
    assertMarketProtocol(identity.protocolAddress);
    parseMarketValue(marketHashSchema, identity.orderHash);
    const response = record(
      await this.request(
        `/api/v2/orders/chain/ethereum/protocol/${MARKET_SEAPORT}/${identity.orderHash}`
      )
    );
    const order = parseProviderOrder(response.order);
    if (
      order.identity.orderHash.toLowerCase() !==
      identity.orderHash.toLowerCase()
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The provider returned another order.'
      );
    return order;
  }
  async discoverOrders(
    asset: MarketAsset,
    side: 'LISTING' | 'OFFER',
    limit = 20
  ): Promise<MarketDiscoveredOrder[]> {
    const slug = await this.collection(asset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Unsupported discovery limit.'
      );
    const response = await this.request(
      side === 'LISTING'
        ? `/api/v2/listings/collection/${slug}/nfts/${asset.tokenId}/best`
        : `/api/v2/offers/collection/${slug}/nfts/${asset.tokenId}?limit=${limit}`,
      undefined,
      side === 'LISTING'
    );
    if (response === null) return [];
    const raw =
      side === 'LISTING'
        ? [response]
        : parseMarketValue(
            z.array(z.unknown()).max(50),
            record(response).offers
          );
    const found: MarketDiscoveredOrder[] = [];
    for (const value of raw) {
      try {
        const provider = parseProviderOrder(value);
        const quantity = providerQuantity(record(value).remaining_quantity);
        found.push(describeMarketOrder(provider, asset, side, quantity));
      } catch (error) {
        if (!(error instanceof MarketValidationError)) throw error;
      }
    }
    return found;
  }
  /** The endpoint is price-ascending but can include multiple listings per token. */
  async discoverCollectionListings(
    contract: string,
    limit = 20,
    cursor?: string
  ): Promise<MarketCollectionListingPage> {
    parseMarketValue(marketAddressSchema, contract);
    const standard = MARKET_ASSET_STANDARDS[contract.toLowerCase()];
    if (!standard || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Unsupported collection listing request.'
      );
    if (cursor !== undefined)
      parseMarketValue(z.string().min(1).max(2048), cursor);
    const slug = await this.collection({ contract, tokenId: '0', standard });
    const page = record(
      await this.request(
        `/api/v2/listings/collection/${slug}/best?limit=${limit}&include_private_listings=false${cursor ? `&next=${encodeURIComponent(cursor)}` : ''}`
      )
    );
    const raw = parseMarketValue(z.array(z.unknown()).max(200), page.listings);
    const next =
      page.next == null
        ? null
        : parseMarketValue(z.string().min(1).max(2048), page.next);
    const listings: MarketDiscoveredOrder[] = [];
    for (const value of raw) {
      try {
        const provider = parseProviderOrder(value),
          nft = provider.components.offer[0];
        if (!sameMarketAddress(nft.token, contract)) continue;
        const asset = {
          contract: contract.toLowerCase(),
          tokenId: nft.identifierOrCriteria,
          standard
        };
        listings.push(
          describeMarketOrder(
            provider,
            asset,
            'LISTING',
            providerQuantity(record(value).remaining_quantity)
          )
        );
      } catch (error) {
        if (!(error instanceof MarketValidationError)) throw error;
      }
    }
    return {
      listings,
      next,
      coverage: {
        source: 'OPENSEA_PRICE_ASCENDING',
        observedAt: new Date().toISOString(),
        receivedCount: raw.length,
        acceptedCount: listings.length,
        hasMore: next !== null,
        exhaustive: false
      }
    };
  }
  async prepareOrder(intent: MarketTradeIntent): Promise<PreparedOrder> {
    const i = assertMarketIntent(intent);
    if (!['LIST', 'OFFER'].includes(i.kind))
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Only new orders require a signature.'
      );
    const timing = {
      start_time: new Date(
        Number(parseMarketTimestampSeconds(i.startTime)) * 1000
      ).toISOString(),
      end_time: new Date(
        Number(parseMarketTimestampSeconds(i.endTime)) * 1000
      ).toISOString()
    };
    const item = {
      chain: 'ethereum',
      contract: i.asset.contract,
      token_id: i.asset.tokenId
    };
    // OpenSea actions quote a per-copy price, while our reviewed intent is aggregate.
    if (BigInt(i.maxTotalWei) % BigInt(i.quantity) !== BigInt(0)) {
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'The aggregate price must have an exact whole-wei price per copy.'
      );
    }
    const price = {
      amount: formatEther(BigInt(i.maxTotalWei) / BigInt(i.quantity)),
      currency: i.currency
    };
    const body =
      i.kind === 'LIST'
        ? {
            address: i.wallet,
            items: [{ ...item, quantity: i.quantity, price, ...timing }],
            use_creator_fee: i.includeOptionalCreatorFees
          }
        : {
            address: i.wallet,
            item,
            quantity: i.quantity,
            price,
            ...timing,
            use_creator_fee: i.includeOptionalCreatorFees
          };
    const response = record(
      await this.request(
        i.kind === 'LIST'
          ? '/api/v2/listings/actions'
          : '/api/v2/offers/actions',
        body
      )
    );
    const steps = parseMarketValue(
      z.array(objectSchema).max(8),
      response.steps
    );
    const actionName =
      i.kind === 'LIST' ? 'createListingsAction' : 'createOfferAction';
    const signing = steps.filter((step) => actionName in step);
    if (signing.length !== 1)
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'The provider did not return one exact order signature.'
      );
    // Provider approvals and wrapping are intentionally not executable. The service builds reviewed approval transactions separately.
    const request = record(record(signing[0][actionName]).signatureRequest);
    const chain = record(request.chainIdentifier);
    if (chain.chainArch !== 'CHAIN_ARCH_EVM' || chain.chainId !== 1)
      throw new MarketValidationError(
        'UNSUPPORTED_PROTOCOL',
        'Incorrect signature chain.'
      );
    const message = parseMarketValue(z.string().max(40000), request.message);
    let typed: unknown;
    try {
      typed = JSON.parse(message);
    } catch {
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'Malformed typed data.'
      );
    }
    return validateMarketTypedData(i, typed);
  }
  async prepareFulfillment(
    intent: MarketTradeIntent,
    counter: string,
    knownOrder?: MarketProviderOrder
  ): Promise<MarketTransaction> {
    const i = assertMarketIntent(intent);
    if (!i.order || !['BUY', 'ACCEPT'].includes(i.kind))
      throw new MarketValidationError(
        'INVALID_INTENT',
        'An exact order is required.'
      );
    const provider = knownOrder ?? (await this.getOrder(i.order));
    if (
      !sameMarketAddress(
        provider.identity.protocolAddress,
        i.order.protocolAddress
      ) ||
      !sameMarketAddress(provider.identity.orderHash, i.order.orderHash)
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The fulfillment target changed.'
      );
    if (provider.components.counter !== counter)
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The maker counter changed.'
      );
    const validated = validateMarketOrder(i, provider.components);
    const id = {
      hash: i.order.orderHash,
      chain: 'ethereum',
      protocol_address: MARKET_SEAPORT
    };
    const body = {
      ...(i.kind === 'BUY'
        ? { listing: id, recipient: i.recipient }
        : {
            offer: id,
            consideration: {
              asset_contract_address: i.asset.contract,
              token_id: i.asset.tokenId
            }
          }),
      fulfiller: { address: i.wallet },
      units_to_fill: i.quantity,
      include_optional_creator_fees: i.includeOptionalCreatorFees
    };
    const response = record(
      await this.request(
        i.kind === 'BUY'
          ? '/api/v2/listings/fulfillment_data'
          : '/api/v2/offers/fulfillment_data',
        body
      )
    );
    const transaction = record(record(response.fulfillment_data).transaction);
    const fn = parseMarketValue(
      z.string().max(1000),
      transaction.function
    ).split('(')[0];
    if (transaction.chain !== 1 || typeof transaction.to !== 'string')
      throw new MarketValidationError(
        'UNSUPPORTED_PROTOCOL',
        'Incorrect fulfillment chain.'
      );
    assertMarketProtocol(transaction.to);
    const input = record(transaction.input_data);
    let signature: string,
      extraData = '0x',
      conduit = MARKET_OPENSEA_CONDUIT_KEY;
    if (fn === 'fulfillAdvancedOrder' || fn === 'fulfillOrder') {
      const order = record(
        input[fn === 'fulfillOrder' ? 'order' : 'advancedOrder']
      );
      const rawParameters = record(order.parameters);
      const parameters = parseMarketValue(marketOrderParametersSchema, {
        ...rawParameters,
        totalOriginalConsiderationItems: originalConsiderationCount(
          rawParameters.totalOriginalConsiderationItems
        )
      });
      const { totalOriginalConsiderationItems, ...c } = parameters;
      if (
        totalOriginalConsiderationItems !== c.consideration.length ||
        orderHash({ ...c, counter }) !== validated.orderHash
      )
        throw new MarketValidationError(
          'ORDER_MISMATCH',
          'Fulfillment changed the signed order.'
        );
      signature = parseMarketValue(marketBytesSchema, order.signature);
      conduit = parseMarketValue(marketHashSchema, input.fulfillerConduitKey);
      if (conduit.toLowerCase() !== MARKET_OPENSEA_CONDUIT_KEY) {
        throw new MarketValidationError(
          'UNSUPPORTED_CONDUIT',
          'The provider requires a different fulfiller approval operator.'
        );
      }
      if (fn === 'fulfillAdvancedOrder') {
        parseMarketValue(z.array(z.never()).length(0), input.criteriaResolvers);
        extraData = parseMarketValue(marketBytesSchema, order.extraData);
      }
    } else if (
      fn === 'fulfillBasicOrder' ||
      fn === 'fulfillBasicOrder_efficient_6GL6yc'
    ) {
      // Basic methods route NFTs to msg.sender. Rebuild the validated signed order as
      // fulfillAdvancedOrder so an explicit gift recipient is honored in the same transaction.
      if (i.kind !== 'BUY' || provider.components.orderType >= 2)
        throw new MarketValidationError(
          'UNSUPPORTED_ACTION',
          'This basic fulfillment is not supported.'
        );
      signature = parseMarketValue(
        marketBytesSchema,
        record(input.parameters).signature
      );
    } else {
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'The provider requires an unverified fulfillment method.'
      );
    }
    const tx = buildMarketFulfillment(
      i,
      validated,
      signature,
      extraData,
      conduit
    );
    if (parseMarketValue(marketUintSchema, transaction.value) !== tx.value)
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'The provider transaction value changed.'
      );
    return tx;
  }
  async publishOrder(
    intent: MarketTradeIntent,
    prepared: ValidatedMarketOrder,
    signature: string
  ): Promise<{ orderHash: string }> {
    if (!['LIST', 'OFFER'].includes(intent.kind))
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Only a new signed order can be published.'
      );
    const checked = validateMarketOrder(
      intent,
      prepared.components,
      prepared.protocolAddress
    );
    if (
      checked.orderHash !== prepared.orderHash ||
      checked.digest !== prepared.digest
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The prepared order changed.'
      );
    assertMarketEoaSignature(checked, signature);
    const response = record(
      await this.request(
        `/api/v2/orders/ethereum/seaport/${intent.kind === 'LIST' ? 'listings' : 'offers'}`,
        {
          parameters: {
            ...checked.components,
            totalOriginalConsiderationItems:
              checked.components.consideration.length
          },
          protocol_address: MARKET_SEAPORT,
          signature
        }
      )
    );
    const result = record(response.order ?? response);
    if (
      typeof result.order_hash !== 'string' ||
      result.order_hash.toLowerCase() !== checked.orderHash.toLowerCase()
    )
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'Publication could not be confirmed. Reconcile this order hash before retrying.'
      );
    return { orderHash: checked.orderHash };
  }
}
