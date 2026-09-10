import BigNumber from 'bignumber.js';
import { createHash } from 'node:crypto';
import { ApiMarketCurrency } from '@/api/generated/models/ApiMarketCurrency';
import { ApiMarketCurrencyBook } from '@/api/generated/models/ApiMarketCurrencyBook';
import {
  ApiMarketDepth,
  ApiMarketDepthStatusEnum
} from '@/api/generated/models/ApiMarketDepth';
import { ApiMarketDepthLevel } from '@/api/generated/models/ApiMarketDepthLevel';
import {
  ApiMarketOrder,
  ApiMarketOrderApplicabilityEnum,
  ApiMarketOrderScopeEnum,
  ApiMarketOrderSideEnum
} from '@/api/generated/models/ApiMarketOrder';
import { BadRequestException } from '@/exceptions';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot,
  MarketDepthJsonValue
} from '@/market-depth/market-depth.types';
import {
  decodeMarketCursor,
  encodeMarketCursor
} from './market-depth.validation';

const QUOTED_DEPTH_NOTES = [
  'OpenSea quoted orders. Quantities can overlap or share the same wallet funding; execution is not guaranteed.',
  'Currencies are shown separately. Collection offers share one budget across eligible cards.',
  'Trait offers with unverified eligibility are listed separately and excluded from price levels.'
];

interface DepthCursor {
  v: 1;
  contract: string;
  token_id: string;
  fingerprint: string;
  offset: number;
  evaluated_at: number;
}

function asRecord(
  value: MarketDepthJsonValue | null
): Record<string, MarketDepthJsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** Check explicit token sets without expanding potentially enormous ranges. */
export function encodedTokenSetContains(
  encoded: string,
  tokenId: string
): boolean | null {
  if (encoded === '*') return true;
  const id = new BigNumber(tokenId);
  let matches = false;
  for (const part of encoded.split(',')) {
    const match = /^(\d+)(?::(\d+))?$/.exec(part.trim());
    if (!match) return null;
    const start = new BigNumber(match[1]);
    const end = new BigNumber(match[2] ?? match[1]);
    if (end.lt(start)) return null;
    if (id.gte(start) && id.lte(end)) matches = true;
  }
  return matches;
}

function applicability(
  order: CurrentMarketDepthOrder,
  tokenId: string
): ApiMarketOrderApplicabilityEnum | null {
  if (order.scope === 'token') {
    return order.token_id === tokenId
      ? ApiMarketOrderApplicabilityEnum.Token
      : null;
  }
  if (order.scope === 'collection')
    return ApiMarketOrderApplicabilityEnum.Collection;
  const criteria = asRecord(order.criteria);
  const encoded = criteria?.encoded_token_ids;
  if (typeof encoded === 'string') {
    const included = encodedTokenSetContains(encoded, tokenId);
    if (included === false) return null;
    if (included === true && encoded !== '*')
      return ApiMarketOrderApplicabilityEnum.Token;
  }
  return ApiMarketOrderApplicabilityEnum.CriteriaUnverified;
}

function currencyForOrder(
  order: CurrentMarketDepthOrder
): ApiMarketCurrency | null {
  if (
    !order.currency_contract ||
    !order.currency_symbol ||
    order.currency_decimals === null
  )
    return null;
  return {
    address: order.currency_contract,
    symbol: order.currency_symbol,
    decimals: order.currency_decimals
  };
}

function caveatsForOrder(order: CurrentMarketDepthOrder): string[] {
  const value = order.executable_caveats;
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function toApiOrder(
  order: CurrentMarketDepthOrder,
  tokenId: string,
  now: number
): ApiMarketOrder | null {
  if (order.is_private || order.status !== 'ACTIVE' || !order.maker)
    return null;
  if (order.start_at && order.start_at.getTime() > now) return null;
  if (order.end_at && order.end_at.getTime() <= now) return null;
  if (!new BigNumber(order.remaining_quantity).gt(0)) return null;
  const currency = currencyForOrder(order);
  const applies = applicability(order, tokenId);
  if (!currency || !applies) return null;
  const scope = {
    token: ApiMarketOrderScopeEnum.Token,
    collection: ApiMarketOrderScopeEnum.Collection,
    trait: ApiMarketOrderScopeEnum.Trait,
    unknown: ApiMarketOrderScopeEnum.Unknown
  }[order.scope];
  return {
    order_key: order.order_key,
    order_id: order.order_id,
    source: order.source,
    protocol: order.protocol,
    collection_slug: order.collection_slug,
    side:
      order.side === 'ask'
        ? ApiMarketOrderSideEnum.Ask
        : ApiMarketOrderSideEnum.Bid,
    scope,
    maker: order.maker,
    token_id: order.token_id,
    original_quantity: order.original_quantity,
    remaining_quantity: order.remaining_quantity,
    currency,
    total_price_raw: order.current_price_raw,
    unit_price: order.is_executable === false ? null : order.unit_price_decimal,
    starts_at: order.start_at,
    expires_at: order.end_at,
    observed_at: order.observed_at,
    applicability: applies,
    liquidity_group:
      order.side === 'ask'
        ? `${order.maker}:${order.contract}:${tokenId}`
        : `${order.maker}:${currency.address}`,
    caveats: caveatsForOrder(order)
  };
}

function priceLevels(
  orders: ApiMarketOrder[],
  side: ApiMarketOrderSideEnum
): ApiMarketDepthLevel[] {
  const levels = new Map<string, { quantity: BigNumber; count: number }>();
  for (const order of orders) {
    if (
      order.side !== side ||
      !order.unit_price ||
      !order.remaining_quantity ||
      order.applicability === ApiMarketOrderApplicabilityEnum.CriteriaUnverified
    )
      continue;
    const price = new BigNumber(order.unit_price);
    if (!price.isFinite() || !price.gt(0)) continue;
    const key = price.toFixed();
    const previous = levels.get(key) ?? {
      quantity: new BigNumber(0),
      count: 0
    };
    levels.set(key, {
      quantity: previous.quantity.plus(order.remaining_quantity),
      count: previous.count + 1
    });
  }
  let cumulative = new BigNumber(0);
  return Array.from(levels.entries())
    .sort(
      ([a], [b]) =>
        new BigNumber(a).comparedTo(b)! *
        (side === ApiMarketOrderSideEnum.Ask ? 1 : -1)
    )
    .map(([price, level]) => {
      cumulative = cumulative.plus(level.quantity);
      return {
        unit_price: price,
        quantity: level.quantity.toFixed(0),
        cumulative_quantity: cumulative.toFixed(0),
        order_count: level.count
      };
    });
}

export function buildCurrencyBooks(
  orders: ApiMarketOrder[]
): ApiMarketCurrencyBook[] {
  const groups = new Map<string, ApiMarketOrder[]>();
  for (const order of orders) {
    const key = `${order.currency.address}:${order.currency.decimals}`;
    const group = groups.get(key) ?? [];
    group.push(order);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .map((group) => {
      const asks = priceLevels(group, ApiMarketOrderSideEnum.Ask);
      const bids = priceLevels(group, ApiMarketOrderSideEnum.Bid);
      return {
        currency: group[0].currency,
        asks,
        bids,
        best_ask: asks[0]?.unit_price ?? null,
        best_bid: bids[0]?.unit_price ?? null,
        ask_order_count: group.filter(
          (order) => order.side === ApiMarketOrderSideEnum.Ask
        ).length,
        bid_order_count: group.filter(
          (order) => order.side === ApiMarketOrderSideEnum.Bid
        ).length
      };
    })
    .sort((a, b) => a.currency.address.localeCompare(b.currency.address));
}

function readDepthCursor(
  value: string | undefined,
  contract: string,
  tokenId: string,
  fingerprint: string,
  now: number
): DepthCursor {
  if (!value)
    return {
      v: 1,
      contract,
      token_id: tokenId,
      fingerprint,
      offset: 0,
      evaluated_at: now
    };
  const parsed = decodeMarketCursor<DepthCursor>(value);
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.contract !== contract ||
    parsed.token_id !== tokenId ||
    parsed.fingerprint !== fingerprint ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 ||
    !Number.isSafeInteger(parsed.evaluated_at) ||
    parsed.evaluated_at > now ||
    now - parsed.evaluated_at > 3_600_000
  ) {
    throw new BadRequestException(
      'The market book changed. Reload the first page.'
    );
  }
  return parsed;
}

export function buildMarketDepthResponse(
  contract: string,
  tokenId: string,
  snapshots: CurrentMarketDepthSnapshot[],
  pageSize: number,
  cursorValue?: string,
  now = Date.now()
): ApiMarketDepth {
  const snapshotIds = snapshots
    .map(({ snapshot }) => snapshot.id)
    .sort((a, b) => a.localeCompare(b));
  const fingerprint = createHash('sha256')
    .update(snapshotIds.join(':'))
    .update(
      snapshots
        .flatMap((book) =>
          book.orders.map(
            (order) =>
              `${order.order_key}:${order.status}:${order.remaining_quantity}`
          )
        )
        .sort((a, b) => a.localeCompare(b))
        .join('|')
    )
    .digest('hex');
  const cursor = readDepthCursor(
    cursorValue,
    contract,
    tokenId,
    fingerprint,
    now
  );
  const uniqueOrders = new Map<string, ApiMarketOrder>();
  for (const book of snapshots) {
    for (const order of book.orders) {
      const projected = toApiOrder(order, tokenId, cursor.evaluated_at);
      if (projected) uniqueOrders.set(projected.order_key, projected);
    }
  }
  const orders = Array.from(uniqueOrders.values()).sort((a, b) => {
    const side = a.side.localeCompare(b.side);
    const currency = a.currency.address.localeCompare(b.currency.address);
    if (side || currency) return side || currency;
    if (a.unit_price === null && b.unit_price !== null) return 1;
    if (a.unit_price !== null && b.unit_price === null) return -1;
    if (a.unit_price && b.unit_price) {
      const price = new BigNumber(a.unit_price).comparedTo(b.unit_price)!;
      if (price)
        return price * (a.side === ApiMarketOrderSideEnum.Ask ? 1 : -1);
    }
    return a.order_key.localeCompare(b.order_key);
  });
  const completedTimes = snapshots.map(({ snapshot }) =>
    snapshot.completed_at.getTime()
  );
  const asOf = completedTimes.length
    ? new Date(Math.min(...completedTimes))
    : null;
  const nextOffset = cursor.offset + pageSize;
  return {
    contract,
    token_id: tokenId,
    status:
      asOf === null
        ? ApiMarketDepthStatusEnum.Unavailable
        : now - asOf.getTime() > 3_600_000
          ? ApiMarketDepthStatusEnum.Stale
          : ApiMarketDepthStatusEnum.Fresh,
    as_of: asOf,
    snapshots: snapshots.map(({ snapshot }) => ({
      id: snapshot.id,
      source: snapshot.source,
      collection_slug: snapshot.collection_slug,
      started_at: snapshot.started_at,
      completed_at: snapshot.completed_at,
      order_count: snapshot.order_count,
      unsupported_count: snapshot.unsupported_count,
      schema_version: snapshot.schema_version,
      normalizer_version: snapshot.normalizer_version
    })),
    books: buildCurrencyBooks(orders),
    orders: orders.slice(cursor.offset, nextOffset),
    order_count: orders.length,
    next:
      nextOffset < orders.length
        ? encodeMarketCursor({ ...cursor, offset: nextOffset })
        : null,
    criteria_order_count: orders.filter(
      (order) =>
        order.applicability ===
        ApiMarketOrderApplicabilityEnum.CriteriaUnverified
    ).length,
    notes: [
      ...QUOTED_DEPTH_NOTES,
      'Cancelled, completed and expired orders remain excluded. Recent invalidations or partial fills can hide quotes until the next complete refresh.'
    ]
  };
}
