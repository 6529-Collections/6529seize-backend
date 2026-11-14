import { Logger } from '@/logging';
import {
  MarketDepthBulkDeferInput,
  MarketDepthBulkResolveInput,
  MarketDepthCursor,
  MarketDepthEventInput,
  MarketDepthOrderStatusEvidence,
  MarketDepthReconciliation,
  MarketDepthReconciliationInput,
  MarketDepthReconciliationKey,
  MarketDepthReconciliationRetryInput,
  NormalizedMarketDepthOrder
} from './market-depth.types';
import { OpenSeaClient, OpenSeaHttpError } from './opensea-client';
import {
  normalizeOpenSeaOrder,
  openSeaLifecycleEventId,
  OPENSEA_SOURCE
} from './opensea-normalizer';

const logger = Logger.get('OPENSEA_RECONCILIATION');

// Most disappeared orders need no provider request: they had expired, or a
// recorded stream event already explains them. Those resolve locally in
// pages; provider requests stay at the previous per-run budget.
const RECONCILIATION_PAGE_SIZE = 500;
const MAX_RECONCILIATIONS_PER_RUN = 5_000;
const PROVIDER_LOOKUPS_PER_RUN = 25;
// Rows over the provider budget move behind newer work instead of staying at
// the front of the due order; their expiry may also elapse meanwhile.
const PROVIDER_DEFER_MS = 6 * 60 * 60_000;
const RECONCILIATION_WORK_MS = 60_000;
const MIN_REQUEST_BUDGET_MS = 2_000;
const STREAM_SOURCE = 'opensea_stream';
// Irreversible outcomes explain a disappearance whenever they were recorded.
// Sales are excluded: a partial fill leaves the order active.
const TERMINAL_EVIDENCE_KINDS = [
  'cancel',
  'cancelled',
  'item_cancelled',
  'fulfilled'
];
// Invalidation is reversible, so only the latest of these counts.
const INACTIVE_EVIDENCE_KINDS = ['invalidate', 'order_invalidate', 'inactive'];
const REVALIDATION_KINDS = ['revalidate', 'order_revalidate'];
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
    limit?: number,
    after?: MarketDepthReconciliationKey | null
  ): Promise<MarketDepthReconciliation[]>;
  getOrderStatusEvidence(input: {
    contract: string;
    sources: readonly string[];
    orderIds: readonly string[];
    kinds: readonly string[];
  }): Promise<MarketDepthOrderStatusEvidence[]>;
  markReconciliationRetry(
    input: MarketDepthReconciliationRetryInput
  ): Promise<boolean>;
  resolveReconciliations(input: MarketDepthBulkResolveInput): Promise<number>;
  deferReconciliations(input: MarketDepthBulkDeferInput): Promise<number>;
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

export function explainedByRecordedEvent(
  item: MarketDepthReconciliation,
  evidence: readonly MarketDepthOrderStatusEvidence[]
): boolean {
  const kinds = evidence.map((event) => event.kind.toLowerCase());
  if (kinds.some((kind) => TERMINAL_EVIDENCE_KINDS.includes(kind))) return true;
  let latest: MarketDepthOrderStatusEvidence | null = null;
  for (const event of evidence) {
    const kind = event.kind.toLowerCase();
    if (
      (INACTIVE_EVIDENCE_KINDS.includes(kind) ||
        REVALIDATION_KINDS.includes(kind)) &&
      (latest === null || event.occurred_at > latest.occurred_at)
    ) {
      latest = event;
    }
  }
  // An invalidation explains this absence only if it followed the snapshot
  // that last showed the order active and was not revalidated since.
  return (
    latest !== null &&
    INACTIVE_EVIDENCE_KINDS.includes(latest.kind.toLowerCase()) &&
    latest.occurred_at.getTime() >= item.prior_order.observed_at.getTime()
  );
}

interface ReconciliationInput {
  readonly target: { contract: string; collection_slug: string };
  readonly client: OpenSeaClient;
  readonly db: OpenSeaReconciliationDb;
  readonly deadlineMs: number;
  readonly now?: () => Date;
}

interface Resolution {
  readonly item: MarketDepthReconciliation;
  readonly event: MarketDepthEventInput | null;
}

async function evidenceByOrder(
  input: ReconciliationInput,
  due: readonly MarketDepthReconciliation[]
): Promise<Map<string, MarketDepthOrderStatusEvidence[]>> {
  const evidence = await input.db.getOrderStatusEvidence({
    contract: input.target.contract,
    sources: [OPENSEA_SOURCE, STREAM_SOURCE],
    orderIds: Array.from(new Set(due.map((item) => item.order_id))),
    kinds: [
      ...TERMINAL_EVIDENCE_KINDS,
      ...INACTIVE_EVIDENCE_KINDS,
      ...REVALIDATION_KINDS
    ]
  });
  const byOrder = new Map<string, MarketDepthOrderStatusEvidence[]>();
  for (const event of evidence) {
    const key = event.order_id.toLowerCase();
    byOrder.set(key, [...(byOrder.get(key) ?? []), event]);
  }
  return byOrder;
}

async function lookUpProviderStatus(
  input: ReconciliationInput,
  item: MarketDepthReconciliation,
  attemptedAt: Date
): Promise<MarketDepthEventInput | null> {
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
      return null;
    }
    return lifecycleEvent(
      item,
      kind,
      'provider_order_status',
      attemptedAt,
      response
    );
  } catch (error) {
    await retry(input.db, item, attemptedAt, error);
    return null;
  }
}

async function persistResolutions(
  input: ReconciliationInput,
  resolutions: readonly Resolution[],
  now: () => Date
): Promise<number> {
  if (resolutions.length === 0) return 0;
  const observedAt = now();
  const events = resolutions.flatMap(({ event }) =>
    event ? [{ ...event, observed_at: observedAt }] : []
  );
  // Record lifecycle events before resolving, so a failed append leaves the
  // rows due; event IDs make the retry idempotent.
  if (events.length > 0) {
    const cursor = await input.db.getCursor(
      OPENSEA_SOURCE,
      input.target.contract,
      input.target.collection_slug
    );
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
      events
    });
  }
  return input.db.resolveReconciliations({
    items: resolutions.map(({ item }) => ({
      id: item.id,
      expected_attempt_count: item.attempt_count
    })),
    resolved_at: observedAt
  });
}

function canRequestProvider(
  providerLookups: number,
  attemptedAt: Date,
  workDeadlineMs: number
): boolean {
  return (
    providerLookups < PROVIDER_LOOKUPS_PER_RUN &&
    attemptedAt.getTime() + MIN_REQUEST_BUDGET_MS < workDeadlineMs
  );
}

export async function reconcileOpenSeaOrders(
  input: ReconciliationInput
): Promise<number> {
  const now = input.now ?? (() => new Date());
  const workDeadlineMs = Math.min(
    input.deadlineMs,
    now().getTime() + RECONCILIATION_WORK_MS
  );
  const stats = {
    examined: 0,
    explained: 0,
    expired: 0,
    provider: 0,
    deferred: 0
  };
  let resolved = 0;
  let after: MarketDepthReconciliationKey | null = null;
  while (
    stats.examined < MAX_RECONCILIATIONS_PER_RUN &&
    now().getTime() < workDeadlineMs
  ) {
    const due = await input.db.getDueReconciliations(
      OPENSEA_SOURCE,
      input.target.contract,
      input.target.collection_slug,
      now(),
      RECONCILIATION_PAGE_SIZE,
      after
    );
    const last = due.at(-1);
    if (!last) break;
    stats.examined += due.length;
    const evidence = await evidenceByOrder(input, due);
    const resolutions: Resolution[] = [];
    const deferred: MarketDepthReconciliation[] = [];
    for (const item of due) {
      const attemptedAt = now();
      const expiry = item.prior_order.end_at;
      if (
        explainedByRecordedEvent(
          item,
          evidence.get(item.order_id.toLowerCase()) ?? []
        )
      ) {
        stats.explained++;
        resolutions.push({ item, event: null });
      } else if (expiry && expiry.getTime() <= attemptedAt.getTime()) {
        stats.expired++;
        resolutions.push({
          item,
          event: lifecycleEvent(item, 'expiration', 'elapsed_expiry', expiry, {
            prior_order: item.prior_order
          })
        });
      } else if (
        canRequestProvider(stats.provider, attemptedAt, workDeadlineMs)
      ) {
        stats.provider++;
        const event = await lookUpProviderStatus(input, item, attemptedAt);
        if (event) resolutions.push({ item, event });
      } else {
        deferred.push(item);
      }
    }
    resolved += await persistResolutions(input, resolutions, now);
    if (deferred.length > 0) {
      stats.deferred += await input.db.deferReconciliations({
        items: deferred.map((item) => ({
          id: item.id,
          expected_attempt_count: item.attempt_count
        })),
        next_attempt_at: new Date(now().getTime() + PROVIDER_DEFER_MS)
      });
    }
    if (due.length < RECONCILIATION_PAGE_SIZE) break;
    after = { next_attempt_at: last.next_attempt_at, id: last.id };
  }
  if (stats.examined > 0) {
    logger.info(
      `[COLLECTION ${input.target.collection_slug}] OpenSea reconciliation ${JSON.stringify(
        { ...stats, resolved }
      )}`
    );
  }
  return resolved;
}
import BigNumber from 'bignumber.js';
