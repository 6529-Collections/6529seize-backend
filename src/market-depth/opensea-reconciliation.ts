import {
  MarketDepthCursor,
  MarketDepthEventInput,
  MarketDepthReconciliation,
  MarketDepthReconciliationInput,
  MarketDepthReconciliationResolveInput,
  MarketDepthReconciliationRetryInput,
  NormalizedMarketDepthOrder
} from './market-depth.types';
import { OpenSeaClient, OpenSeaHttpError } from './opensea-client';
import {
  normalizeOpenSeaOrder,
  openSeaLifecycleEventId,
  OPENSEA_SOURCE
} from './opensea-normalizer';

const RECONCILIATION_BATCH_SIZE = 25;
const MIN_REQUEST_BUDGET_MS = 2_000;
const BASE_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

export interface OpenSeaReconciliationDb {
  enqueueReconciliations(
    inputs: MarketDepthReconciliationInput[]
  ): Promise<void>;
  getDueReconciliations(
    source: string,
    contract: string,
    collectionSlug: string,
    now: Date,
    limit?: number
  ): Promise<MarketDepthReconciliation[]>;
  markReconciliationRetry(
    input: MarketDepthReconciliationRetryInput
  ): Promise<boolean>;
  resolveReconciliation(
    input: MarketDepthReconciliationResolveInput
  ): Promise<boolean>;
  getCursor(
    source: string,
    contract: string,
    collectionSlug: string
  ): Promise<MarketDepthCursor | null>;
  appendEvents(input: {
    source: string;
    contract: string;
    collection_slug: string;
    expected_cursor: string | null;
    expected_watermark: string | null;
    next_cursor: string | null;
    provider_watermark: string | null;
    provider_at: Date | null;
    observed_at: Date;
    events: MarketDepthEventInput[];
  }): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryAt(item: MarketDepthReconciliation, attemptedAt: Date): Date {
  const exponent = Math.min(item.attempt_count, 6);
  const backoffAt = new Date(
    attemptedAt.getTime() +
      Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exponent)
  );
  const expiry = item.prior_order.end_at;
  return expiry &&
    expiry.getTime() > attemptedAt.getTime() &&
    expiry < backoffAt
    ? expiry
    : backoffAt;
}

function safeError(error: unknown): string {
  if (error instanceof OpenSeaHttpError && error.status === 404) {
    return 'provider_order_404_unknown';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/token=[^&\s]+/gi, 'token=[redacted]').slice(0, 1000);
}

function lifecycleEvent(
  item: MarketDepthReconciliation,
  kind: string,
  evidence: string,
  providerAt: Date,
  raw: unknown
): MarketDepthEventInput {
  const order = item.prior_order;
  const remainingTotal =
    order.unit_price_decimal !== null && order.currency_decimals !== null
      ? new BigNumber(order.unit_price_decimal)
          .times(order.remaining_quantity)
          .shiftedBy(order.currency_decimals)
      : null;
  const remainingPriceRaw =
    remainingTotal?.isFinite() && remainingTotal.isInteger()
      ? remainingTotal.toFixed(0)
      : null;
  const remainingPriceDecimal =
    remainingPriceRaw !== null && order.currency_decimals !== null
      ? new BigNumber(remainingPriceRaw)
          .shiftedBy(-order.currency_decimals)
          .toFixed()
      : null;
  return {
    event_id: openSeaLifecycleEventId({
      kind,
      collectionSlug: item.collection_slug,
      orderId: order.order_id,
      protocolAddress: order.protocol,
      // INACTIVE is reversible. Retries of one absence episode share an ID,
      // while a later disappearance after an ACTIVE refresh records new evidence.
      providerAt: kind === 'inactive' ? item.first_missing_at : undefined,
      eventVersion: kind === 'inactive' ? item.id : undefined
    }),
    kind,
    source: OPENSEA_SOURCE,
    source_evidence: evidence,
    provider_at: providerAt,
    observed_at: new Date(),
    order_id: order.order_id,
    contract: item.contract,
    collection_slug: item.collection_slug,
    token_id: order.token_id,
    maker: order.maker,
    taker: null,
    quantity: order.remaining_quantity,
    currency_contract: order.currency_contract,
    currency_symbol: order.currency_symbol,
    currency_decimals: order.currency_decimals,
    price_raw: remainingPriceRaw,
    price_decimal: remainingPriceDecimal,
    transaction_hash: null,
    raw: JSON.parse(JSON.stringify(raw)) as MarketDepthEventInput['raw']
  };
}

async function retry(
  db: OpenSeaReconciliationDb,
  item: MarketDepthReconciliation,
  attemptedAt: Date,
  error: unknown
): Promise<void> {
  await db.markReconciliationRetry({
    id: item.id,
    expected_attempt_count: item.attempt_count,
    attempted_at: attemptedAt,
    next_attempt_at: retryAt(item, attemptedAt),
    last_error: safeError(error)
  });
}

export function missingOrders(
  previous: readonly NormalizedMarketDepthOrder[],
  current: readonly NormalizedMarketDepthOrder[]
): NormalizedMarketDepthOrder[] {
  const currentKeys = new Set(current.map((order) => order.order_key));
  return previous.filter(
    (order) => order.status === 'ACTIVE' && !currentKeys.has(order.order_key)
  );
}

export async function reconcileOpenSeaOrders(input: {
  readonly target: { contract: string; collection_slug: string };
  readonly client: OpenSeaClient;
  readonly db: OpenSeaReconciliationDb;
  readonly deadlineMs: number;
  readonly now?: () => Date;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  const due = await input.db.getDueReconciliations(
    OPENSEA_SOURCE,
    input.target.contract,
    input.target.collection_slug,
    now(),
    RECONCILIATION_BATCH_SIZE
  );
  const resolved: Array<{
    item: MarketDepthReconciliation;
    event: MarketDepthEventInput;
  }> = [];

  for (const item of due) {
    const attemptedAt = now();
    const expiry = item.prior_order.end_at;
    if (expiry && expiry.getTime() <= attemptedAt.getTime()) {
      resolved.push({
        item,
        event: lifecycleEvent(item, 'expiration', 'elapsed_expiry', expiry, {
          prior_order: item.prior_order
        })
      });
      continue;
    }
    if (Date.now() + MIN_REQUEST_BUDGET_MS >= input.deadlineMs) break;

    try {
      const response = await input.client.getOrder(
        'ethereum',
        item.protocol,
        item.order_id,
        input.deadlineMs
      );
      const rawOrder = record(response).order;
      const normalized = normalizeOpenSeaOrder(rawOrder, {
        side: item.side,
        contract: item.contract,
        collectionSlug: item.collection_slug,
        observedAt: attemptedAt
      });
      const status = normalized.order?.status ?? 'UNKNOWN';
      const kinds: Record<string, string> = {
        CANCELLED: 'cancel',
        FULFILLED: 'fulfilled',
        INACTIVE: 'inactive',
        EXPIRED: 'expiration'
      };
      const kind = kinds[status];
      if (!kind) {
        await retry(
          input.db,
          item,
          attemptedAt,
          status === 'ACTIVE'
            ? new Error('provider_order_still_active_after_absence')
            : new Error('provider_order_status_unknown')
        );
        continue;
      }
      resolved.push({
        item,
        event: lifecycleEvent(
          item,
          kind,
          'provider_order_status',
          attemptedAt,
          response
        )
      });
    } catch (error) {
      await retry(input.db, item, attemptedAt, error);
    }
  }

  if (resolved.length === 0) return 0;
  const cursor = await input.db.getCursor(
    OPENSEA_SOURCE,
    input.target.contract,
    input.target.collection_slug
  );
  const observedAt = now();
  await input.db.appendEvents({
    source: OPENSEA_SOURCE,
    contract: input.target.contract,
    collection_slug: input.target.collection_slug,
    expected_cursor: cursor?.provider_cursor ?? null,
    expected_watermark: cursor?.provider_watermark ?? null,
    next_cursor: cursor?.provider_cursor ?? null,
    provider_watermark: cursor?.provider_watermark ?? null,
    provider_at: cursor?.provider_at ?? null,
    observed_at: observedAt,
    events: resolved.map(({ event }) => ({ ...event, observed_at: observedAt }))
  });
  for (const { item } of resolved) {
    await input.db.resolveReconciliation({
      id: item.id,
      expected_attempt_count: item.attempt_count,
      resolved_at: observedAt
    });
  }
  return resolved.length;
}
import BigNumber from 'bignumber.js';
