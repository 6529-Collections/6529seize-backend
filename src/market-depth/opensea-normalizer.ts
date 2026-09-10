import BigNumber from 'bignumber.js';
import { createHash } from 'node:crypto';
import {
  MarketDepthEventInput,
  MarketDepthJsonValue,
  MarketDepthOrderScope,
  MarketDepthOrderStatus,
  NormalizedMarketDepthOrder
} from './market-depth.types';

export const OPENSEA_NORMALIZER_VERSION = 'opensea-v1';
export const OPENSEA_SOURCE = 'opensea';

type JsonRecord = Record<string, unknown>;

export interface NormalizeOrderOptions {
  readonly side: 'ask' | 'bid';
  readonly contract: string;
  readonly collectionSlug: string;
  readonly observedAt: Date;
}

export interface NormalizedOrderResult {
  readonly order: NormalizedMarketDepthOrder | null;
  readonly unsupported: boolean;
  readonly skipped: boolean;
  readonly reasons: readonly string[];
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function exactInteger(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function integer(value: unknown): number | null {
  const parsed = exactInteger(value);
  if (parsed === null) return null;
  const number = Number(parsed);
  return Number.isSafeInteger(number) ? number : null;
}

function currencyDecimals(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed <= 255 ? parsed : null;
}

function lower(value: unknown): string | null {
  return text(value)?.toLowerCase() ?? null;
}

function dateFromEpoch(value: unknown): Date | null {
  const seconds = exactInteger(value);
  if (seconds === null) return null;
  const milliseconds = new BigNumber(seconds).times(1000);
  if (!milliseconds.isFinite() || milliseconds.gt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const date = new Date(milliseconds.toNumber());
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value: unknown): Date | null {
  if (typeof value === 'number') return dateFromEpoch(value);
  const valueText = text(value);
  if (!valueText) return null;
  if (/^\d+$/.test(valueText)) return dateFromEpoch(valueText);
  const date = new Date(valueText);
  return Number.isNaN(date.getTime()) ? null : date;
}

function json(value: unknown): MarketDepthJsonValue | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as MarketDepthJsonValue;
  } catch {
    return null;
  }
}

function decimal(raw: string | null, decimals: number | null): string | null {
  if (raw === null || decimals === null || decimals < 0) return null;
  return new BigNumber(raw).shiftedBy(-decimals).toFixed();
}

function unitDecimal(
  raw: string | null,
  decimals: number | null,
  quantity: string
): string | null {
  if (raw === null || decimals === null || quantity === '0') return null;
  const value = new BigNumber(raw);
  const divisor = new BigNumber(quantity);
  if (
    !value.isInteger() ||
    !divisor.isInteger() ||
    !value.modulo(divisor).isZero()
  ) {
    return null;
  }
  return value.dividedBy(divisor).shiftedBy(-decimals).toFixed();
}

function status(value: unknown): MarketDepthOrderStatus {
  const normalized = text(value)?.toUpperCase();
  switch (normalized) {
    case 'ACTIVE':
    case 'INACTIVE':
    case 'FULFILLED':
    case 'EXPIRED':
    case 'CANCELLED':
      return normalized;
    default:
      return 'UNKNOWN';
  }
}

function isZeroAddress(value: string | null): boolean {
  return value === null || /^0x0{40}$/i.test(value);
}

function detectPrivate(order: JsonRecord, parameters: JsonRecord): boolean {
  if (order.is_private === true || order.private === true) return true;
  if (lower(order.type)?.includes('private')) return true;
  const taker = lower(order.taker) ?? lower(parameters.taker);
  return taker !== null && !isZeroAddress(taker);
}

function itemType(item: unknown): number | null {
  return integer(record(item).itemType);
}

function itemToken(item: unknown): string | null {
  return lower(record(item).token);
}

function nftItems(items: unknown[], contract: string): JsonRecord[] {
  return items.map(record).filter((item) => {
    const type = itemType(item);
    return (
      type !== null && type >= 2 && type <= 5 && itemToken(item) === contract
    );
  });
}

function allNftItems(items: unknown[]): JsonRecord[] {
  return items.map(record).filter((item) => {
    const type = itemType(item);
    return type !== null && type >= 2 && type <= 5;
  });
}

function paymentItems(items: unknown[]): JsonRecord[] {
  return items.map(record).filter((item) => {
    const type = itemType(item);
    return type === 0 || type === 1;
  });
}

function scopeFor(
  nft: JsonRecord,
  criteria: JsonRecord
): MarketDepthOrderScope {
  const type = itemType(nft);
  if (type === 2 || type === 3) return 'token';
  if (type !== 4 && type !== 5) return 'unknown';
  if (
    array(criteria.traits).length > 0 ||
    array(criteria.numeric_traits).length > 0
  ) {
    return 'trait';
  }
  const encoded = text(criteria.encoded_token_ids);
  if (encoded && encoded !== '*') return 'trait';
  return 'collection';
}

function orderPrice(order: JsonRecord, side: 'ask' | 'bid'): JsonRecord {
  const price = record(order.price);
  return side === 'ask' ? record(price.current) : price;
}

function currencyToken(payments: JsonRecord[]): string | null {
  const tokens = new Set(
    payments.map((item) => itemToken(item)).filter(Boolean)
  );
  if (tokens.size !== 1) return null;
  return Array.from(tokens)[0] ?? null;
}

function canonicalHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function canonicalEventKind(value: unknown): string {
  const kind = text(value)?.toLowerCase() ?? 'unknown';
  const aliases: Record<string, string> = {
    item_listed: 'listing',
    item_received_bid: 'offer',
    item_sold: 'sale',
    item_transferred: 'transfer',
    item_minted: 'mint',
    item_cancelled: 'cancel',
    order_invalidate: 'invalidate',
    order_revalidate: 'revalidate'
  };
  return aliases[kind] ?? kind;
}

export function openSeaLifecycleEventId(input: {
  readonly kind: string;
  readonly collectionSlug: string;
  readonly orderId?: string | null;
  readonly transactionHash?: string | null;
  readonly tokenId?: string | null;
  readonly providerAt?: Date | null;
  readonly maker?: string | null;
  readonly taker?: string | null;
  readonly quantity?: string | null;
  readonly protocolAddress?: string | null;
  readonly eventVersion?: string | null;
}): string {
  const kind = canonicalEventKind(input.kind);
  if (
    input.orderId &&
    [
      'listing',
      'offer',
      'collection_offer',
      'trait_offer',
      'cancel',
      'fulfilled',
      'expiration'
    ].includes(kind)
  ) {
    return canonicalHash([
      OPENSEA_SOURCE,
      'ethereum',
      input.collectionSlug.toLowerCase(),
      input.orderId.toLowerCase(),
      kind
    ]);
  }
  if (input.transactionHash) {
    return canonicalHash([
      OPENSEA_SOURCE,
      'ethereum',
      input.transactionHash.toLowerCase(),
      kind,
      input.tokenId ?? '',
      input.maker?.toLowerCase() ?? '',
      input.taker?.toLowerCase() ?? '',
      input.quantity ?? ''
    ]);
  }
  return canonicalHash([
    OPENSEA_SOURCE,
    input.collectionSlug.toLowerCase(),
    kind,
    input.orderId?.toLowerCase() ?? '',
    input.transactionHash?.toLowerCase() ?? '',
    input.tokenId ?? '',
    input.providerAt?.toISOString() ?? '',
    input.maker?.toLowerCase() ?? '',
    input.taker?.toLowerCase() ?? '',
    input.quantity ?? '',
    kind === 'inactive' || kind === 'invalidate' || kind === 'revalidate'
      ? (input.eventVersion ?? input.providerAt?.toISOString() ?? '')
      : ''
  ]);
}

function caveatJson(reasons: readonly string[]): MarketDepthJsonValue | null {
  return reasons.length > 0 ? [...reasons] : null;
}

export function normalizeOpenSeaOrder(
  raw: unknown,
  options: NormalizeOrderOptions
): NormalizedOrderResult {
  const order = record(raw);
  const orderId = text(order.order_hash);
  const protocol = lower(order.protocol_address);
  if (!orderId || !protocol) {
    return {
      order: null,
      unsupported: false,
      skipped: true,
      reasons: ['missing_order_identity']
    };
  }

  const contract = options.contract.toLowerCase();
  const protocolData = record(order.protocol_data);
  const parameters = record(protocolData.parameters);
  const offered = array(parameters.offer);
  const considered = array(parameters.consideration);
  const candidates = nftItems(
    options.side === 'ask' ? offered : considered,
    contract
  );
  const offeredPayments = paymentItems(offered);
  const consideredPayments = paymentItems(considered);
  const payments = [...offeredPayments, ...consideredPayments];
  const reasons: string[] = [];
  if (candidates.length !== 1) reasons.push('unsupported_nft_item_count');
  if (allNftItems([...offered, ...considered]).length !== 1) {
    reasons.push('bundled_nft_items');
  }
  const expectedOfferItems =
    options.side === 'ask' ? candidates.length : offeredPayments.length;
  const expectedConsiderationItems =
    options.side === 'ask'
      ? consideredPayments.length
      : candidates.length + consideredPayments.length;
  if (
    offered.length !== expectedOfferItems ||
    considered.length !== expectedConsiderationItems
  ) {
    reasons.push('unsupported_non_payment_items');
  }
  if (payments.length === 0) reasons.push('missing_payment_item');
  if (payments.some((item) => itemToken(item) === null)) {
    reasons.push('missing_currency_contract');
  }
  if (new Set(payments.map((item) => itemToken(item) ?? 'native')).size > 1) {
    reasons.push('mixed_payment_currencies');
  }

  const nft = candidates[0] ?? {};
  const criteria = record(order.criteria);
  const originalQuantity = exactInteger(nft.startAmount) ?? '0';
  const remainingQuantity =
    exactInteger(order.remaining_quantity) ?? originalQuantity;
  if (originalQuantity === '0') reasons.push('invalid_original_quantity');
  if (exactInteger(order.remaining_quantity) === null) {
    reasons.push('missing_remaining_quantity');
  }
  if (new BigNumber(remainingQuantity).gt(originalQuantity)) {
    reasons.push('remaining_exceeds_original');
  }

  const price = orderPrice(order, options.side);
  const rawPrice = exactInteger(price.value);
  const decimals = currencyDecimals(price.decimals);
  if (rawPrice === null) reasons.push('missing_exact_price');
  if (decimals === null) reasons.push('missing_currency_decimals');
  if (text(price.currency) === null) reasons.push('missing_currency_symbol');
  if (lower(order.chain) !== 'ethereum') reasons.push('unexpected_chain');
  const orderType = integer(parameters.orderType);
  if (orderType === null || orderType > 3)
    reasons.push('unsupported_order_type');
  const dynamicItem = [...offered, ...considered].some((value) => {
    const item = record(value);
    const start = exactInteger(item.startAmount);
    const end = exactInteger(item.endAmount) ?? start;
    return start === null || end === null || start !== end;
  });
  if (dynamicItem) reasons.push('dynamic_amount_order');

  const orderStatus = status(order.status);
  const isPrivate = detectPrivate(order, parameters);
  const startAt =
    dateFromEpoch(parameters.startTime) ?? dateValue(order.order_created_at);
  const endAt = dateFromEpoch(parameters.endTime);
  const now = options.observedAt.getTime();
  const outsideTime =
    (startAt !== null && startAt.getTime() > now) ||
    (endAt !== null && endAt.getTime() <= now);
  if (orderStatus !== 'ACTIVE')
    reasons.push(`status_${orderStatus.toLowerCase()}`);
  if (isPrivate) reasons.push('private_order');
  if (outsideTime) reasons.push('outside_order_time');
  if (remainingQuantity === '0') reasons.push('no_remaining_quantity');

  const unsupportedReasons = reasons.filter((reason) =>
    [
      'unsupported_nft_item_count',
      'missing_payment_item',
      'missing_currency_contract',
      'mixed_payment_currencies',
      'bundled_nft_items',
      'unsupported_non_payment_items',
      'dynamic_amount_order',
      'invalid_original_quantity',
      'missing_remaining_quantity',
      'remaining_exceeds_original',
      'missing_exact_price',
      'missing_currency_decimals',
      'missing_currency_symbol',
      'unexpected_chain',
      'unsupported_order_type'
    ].includes(reason)
  );
  const normalizedScope = scopeFor(nft, criteria);
  const tokenId =
    normalizedScope === 'token' ? exactInteger(nft.identifierOrCriteria) : null;
  if (normalizedScope === 'token' && tokenId === null) {
    unsupportedReasons.push('invalid_token_id');
    reasons.push('invalid_token_id');
  }

  const currencyContract = currencyToken(payments);
  const currentPriceDecimal = decimal(rawPrice, decimals);
  const perUnit = unitDecimal(rawPrice, decimals, originalQuantity);
  if (rawPrice !== null && perUnit === null)
    reasons.push('non_integral_unit_price');
  const sourceUrl = tokenId
    ? `https://opensea.io/assets/ethereum/${contract}/${tokenId}`
    : `https://opensea.io/collection/${encodeURIComponent(options.collectionSlug)}`;
  const unsupported = unsupportedReasons.length > 0;

  return {
    order: {
      order_key: canonicalHash([OPENSEA_SOURCE, protocol, orderId]),
      order_id: orderId,
      source: OPENSEA_SOURCE,
      protocol,
      contract,
      collection_slug: options.collectionSlug.toLowerCase(),
      token_id: tokenId,
      side: options.side,
      status: orderStatus,
      is_private: isPrivate,
      scope: normalizedScope,
      maker: lower(parameters.offerer),
      original_quantity: originalQuantity,
      remaining_quantity: remainingQuantity,
      currency_contract: currencyContract,
      currency_symbol: text(price.currency),
      currency_decimals: decimals,
      current_price_raw: rawPrice,
      current_price_decimal: currentPriceDecimal,
      unit_price_decimal: perUnit,
      start_at: startAt,
      end_at: endAt,
      observed_at: options.observedAt,
      source_url: sourceUrl,
      criteria: json(order.criteria),
      protocol_data: json(order.protocol_data),
      source_data: json(raw),
      is_executable:
        unsupported ||
        orderStatus !== 'ACTIVE' ||
        isPrivate ||
        outsideTime ||
        remainingQuantity === '0'
          ? false
          : true,
      executable_caveats: caveatJson(reasons)
    },
    unsupported,
    skipped: false,
    reasons
  };
}

export function normalizeOpenSeaEvent(
  raw: unknown,
  contract: string,
  collectionSlug: string,
  observedAt: Date
): MarketDepthEventInput {
  const event = record(raw);
  const nft = Object.keys(record(event.nft)).length
    ? record(event.nft)
    : record(event.asset);
  const payment = record(event.payment);
  const quantity = exactInteger(event.quantity);
  const priceRaw = exactInteger(payment.quantity);
  const decimals = currencyDecimals(payment.decimals);
  const providerAt = dateValue(event.event_timestamp);
  const kind = canonicalEventKind(event.event_type);
  const orderId = text(event.order_hash);
  const transactionHash = text(event.transaction);
  const tokenId = exactInteger(nft.identifier) ?? exactInteger(event.token_id);
  const maker =
    lower(event.maker) ?? lower(event.seller) ?? lower(event.from_address);
  const taker =
    lower(event.taker) ?? lower(event.buyer) ?? lower(event.to_address);
  const eventId = openSeaLifecycleEventId({
    kind,
    collectionSlug,
    orderId,
    transactionHash,
    tokenId,
    providerAt,
    maker,
    taker,
    quantity,
    protocolAddress: text(event.protocol_address),
    eventVersion: text(event.version)
  });
  return {
    event_id: eventId,
    kind,
    source: OPENSEA_SOURCE,
    source_evidence: 'provider_event',
    provider_at: providerAt,
    observed_at: observedAt,
    order_id: orderId,
    contract: contract.toLowerCase(),
    collection_slug: collectionSlug.toLowerCase(),
    token_id: tokenId,
    maker,
    taker,
    quantity,
    currency_contract: lower(payment.token_address) ?? lower(payment.address),
    currency_symbol: text(payment.symbol),
    currency_decimals: decimals,
    price_raw: priceRaw,
    price_decimal: decimal(priceRaw, decimals),
    transaction_hash: transactionHash,
    raw: json(raw) ?? {}
  };
}
