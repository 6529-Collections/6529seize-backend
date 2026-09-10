import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mainnet } from '@wagmi/chains';
import { NEXTGEN_CORE } from '@/api/nextgen/abis';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { getDataSource } from '@/db';
import { Logger } from '@/logging';
import { marketDepthDb } from './market-depth.db';
import {
  AppendMarketDepthEventsInput,
  CurrentMarketDepthSnapshot,
  MarketDepthCursor,
  MarketDepthSnapshotMetadata,
  NormalizedMarketDepthOrder,
  PublishMarketDepthSnapshotInput
} from './market-depth.types';
import {
  fetchNextGenCollections,
  fetchNextgenTokens
} from '@/nextgen/nextgen.db';
import { OpenSeaClient } from './opensea-client';
import {
  normalizeOpenSeaEvent,
  normalizeOpenSeaOrder,
  OPENSEA_NORMALIZER_VERSION,
  OPENSEA_SOURCE
} from './opensea-normalizer';
import {
  missingOrders,
  OpenSeaReconciliationDb,
  reconcileOpenSeaOrders
} from './opensea-reconciliation';

const gzipAsync = promisify(gzip);
const logger = Logger.get('OPENSEA_MARKET_DEPTH');
const EVENT_SAFETY_LAG_SECONDS = 120;
const EVENT_OVERLAP_SECONDS = 300;
const INITIAL_EVENT_LOOKBACK_SECONDS = 24 * 60 * 60;

export interface OpenSeaCollectionTarget {
  readonly contract: string;
  readonly collection_slug: string;
  readonly collection_id: number | null;
}

export interface MarketDepthPersistence extends OpenSeaReconciliationDb {
  publishCompletedSnapshot(
    input: PublishMarketDepthSnapshotInput
  ): Promise<MarketDepthSnapshotMetadata>;
  getCursor(
    source: string,
    contract: string,
    collectionSlug: string
  ): Promise<MarketDepthCursor | null>;
  appendEvents(input: AppendMarketDepthEventsInput): Promise<void>;
  getLatestCompletedSnapshot(
    source: string,
    contract: string,
    collectionSlug: string
  ): Promise<CurrentMarketDepthSnapshot | null>;
}

export interface OpenSeaPollOptions {
  readonly client?: OpenSeaClient;
  readonly db?: MarketDepthPersistence;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

const STATIC_COLLECTIONS: readonly OpenSeaCollectionTarget[] = [
  {
    contract: MEMES_CONTRACT.toLowerCase(),
    collection_slug: 'thememes6529',
    collection_id: null
  },
  {
    contract: MEMELAB_CONTRACT.toLowerCase(),
    collection_slug: 'memelab6529',
    collection_id: null
  },
  {
    contract: GRADIENT_CONTRACT.toLowerCase(),
    collection_slug: '6529-gradient',
    collection_id: null
  }
];

function slugFromOpenSeaLink(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.hostname !== 'opensea.io' && !url.hostname.endsWith('.opensea.io'))
      return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const collectionIndex = segments.indexOf('collection');
    return collectionIndex >= 0 && segments[collectionIndex + 1]
      ? decodeURIComponent(segments[collectionIndex + 1]).toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export async function discoverOpenSeaCollections(
  client = new OpenSeaClient(),
  deadlineMs?: number
): Promise<OpenSeaCollectionTarget[]> {
  const manager = getDataSource().manager;
  const [collections, tokens] = await Promise.all([
    fetchNextGenCollections(manager),
    fetchNextgenTokens(manager)
  ]);
  const tokenByCollection = new Map<number, string>();
  for (const token of tokens) {
    if (!tokenByCollection.has(token.collection_id)) {
      tokenByCollection.set(token.collection_id, String(token.id));
    }
  }

  const nextgenContract = NEXTGEN_CORE[mainnet.id].toLowerCase();
  const nextgenTargets: OpenSeaCollectionTarget[] = [];
  for (const collection of collections.sort((a, b) => a.id - b.id)) {
    let slug = slugFromOpenSeaLink(collection.opensea_link);
    if (!slug) {
      const representativeToken = tokenByCollection.get(collection.id);
      if (!representativeToken) {
        logger.warn(
          `[NEXTGEN COLLECTION ${collection.id}] No token available for OpenSea discovery`
        );
        continue;
      }
      try {
        slug = (
          deadlineMs === undefined
            ? await client.getNftCollection(
                nextgenContract,
                representativeToken
              )
            : await client.getNftCollection(
                nextgenContract,
                representativeToken,
                deadlineMs
              )
        ).toLowerCase();
      } catch {
        // A newly minted project may not be indexed yet. Retry on the next run
        // without preventing subscriptions to the other collections.
        logger.warn(
          `[NEXTGEN COLLECTION ${collection.id}] OpenSea discovery lookup failed; will retry next scheduled run`
        );
        continue;
      }
    }
    nextgenTargets.push({
      contract: nextgenContract,
      collection_slug: slug,
      collection_id: collection.id
    });
  }
  return [...STATIC_COLLECTIONS, ...nextgenTargets];
}

function watermarkSeconds(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

export async function pollOpenSeaEvents(
  target: OpenSeaCollectionTarget,
  options: OpenSeaPollOptions = {}
): Promise<number> {
  const client = options.client ?? new OpenSeaClient();
  const db = options.db ?? marketDepthDb;
  const now = options.now ?? (() => new Date());
  const deadlineMs = options.deadlineMs ?? now().getTime() + 10 * 60_000;
  const stored = await db.getCursor(
    OPENSEA_SOURCE,
    target.contract,
    target.collection_slug
  );
  const completedWatermark = watermarkSeconds(
    stored?.provider_watermark ?? null
  );
  const isResuming = Boolean(stored?.provider_cursor);
  const closedBefore = isResuming
    ? Math.floor((stored?.provider_at?.getTime() ?? 0) / 1000)
    : Math.floor(now().getTime() / 1000) - EVENT_SAFETY_LAG_SECONDS;
  if (closedBefore <= 0)
    throw new Error('Invalid OpenSea event window boundary');
  const after = Math.max(
    0,
    (completedWatermark ?? closedBefore - INITIAL_EVENT_LOOKBACK_SECONDS) -
      EVENT_OVERLAP_SECONDS
  );
  let cursor = stored?.provider_cursor ?? null;
  let expectedWatermark = stored?.provider_watermark ?? null;
  const seenCursors = new Set<string>();
  let eventCount = 0;

  do {
    const page = await client.getEventsPage(
      target.collection_slug,
      after,
      closedBefore,
      cursor,
      deadlineMs
    );
    const observedAt = now();
    const events = page.entries.map((entry) =>
      normalizeOpenSeaEvent(
        entry,
        target.contract,
        target.collection_slug,
        observedAt
      )
    );
    const nextCursor = page.next;
    if (nextCursor) {
      if (seenCursors.has(nextCursor))
        throw new Error('Repeated OpenSea event cursor');
      seenCursors.add(nextCursor);
    }
    const nextWatermark = nextCursor ? expectedWatermark : String(closedBefore);
    await db.appendEvents({
      source: OPENSEA_SOURCE,
      contract: target.contract,
      collection_slug: target.collection_slug,
      expected_cursor: cursor,
      expected_watermark: expectedWatermark,
      next_cursor: nextCursor,
      provider_watermark: nextWatermark,
      provider_at: new Date(closedBefore * 1000),
      observed_at: observedAt,
      events
    });
    eventCount += events.length;
    cursor = nextCursor;
    expectedWatermark = nextWatermark;
  } while (cursor);

  return eventCount;
}

function excludeConflictingOrder(order: NormalizedMarketDepthOrder): void {
  // Live pages can overlap a fill or cancellation. Retain the first
  // observation and both raw payloads, but do not count uncertain depth.
  order.is_executable = false;
  const caveats = Array.isArray(order.executable_caveats)
    ? order.executable_caveats
    : [];
  order.executable_caveats = Array.from(
    new Set([...caveats, 'conflicting_provider_observations'])
  );
}

export async function pollOpenSeaCollection(
  target: OpenSeaCollectionTarget,
  options: OpenSeaPollOptions = {}
): Promise<MarketDepthSnapshotMetadata> {
  const client = options.client ?? new OpenSeaClient();
  const db = options.db ?? marketDepthDb;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const deadlineMs = options.deadlineMs ?? startedAt.getTime() + 10 * 60_000;
  const previous = await db.getLatestCompletedSnapshot(
    OPENSEA_SOURCE,
    target.contract,
    target.collection_slug
  );
  const listings = await client.getAllListings(
    target.collection_slug,
    deadlineMs
  );
  const offers = await client.getAllOffers(target.collection_slug, deadlineMs);
  const observedAt = now();
  const results = [
    ...listings.map((entry) =>
      normalizeOpenSeaOrder(entry, {
        side: 'ask',
        contract: target.contract,
        collectionSlug: target.collection_slug,
        observedAt
      })
    ),
    ...offers.map((entry) =>
      normalizeOpenSeaOrder(entry, {
        side: 'bid',
        contract: target.contract,
        collectionSlug: target.collection_slug,
        observedAt
      })
    )
  ];
  type NormalizedOrder = NonNullable<(typeof results)[number]['order']>;
  const ordersByKey = new Map<string, NormalizedOrder>();
  for (const result of results) {
    if (!result.order) continue;
    const existing = ordersByKey.get(result.order.order_key);
    if (existing) {
      const comparable = (order: NormalizedOrder) =>
        JSON.stringify({ ...order, source_data: null });
      if (comparable(existing) !== comparable(result.order)) {
        excludeConflictingOrder(existing);
      }
      continue;
    }
    ordersByKey.set(result.order.order_key, result.order);
  }
  const orders = Array.from(ordersByKey.values());
  const completedAt = now();
  const rawArchive = {
    source: OPENSEA_SOURCE,
    contract: target.contract,
    collection_slug: target.collection_slug,
    collection_id: target.collection_id,
    observed_at: observedAt.toISOString(),
    listings,
    offers
  };
  const normalizedArchive = {
    normalizer_version: OPENSEA_NORMALIZER_VERSION,
    orders,
    results: results.map((result) => ({
      order_key: result.order?.order_key ?? null,
      unsupported: result.unsupported,
      skipped: result.skipped,
      reasons: result.reasons
    }))
  };
  const reconciliations = previous
    ? missingOrders(previous.orders, orders).map((order) => ({
        prior_snapshot_id: previous.snapshot.id,
        source: OPENSEA_SOURCE,
        contract: target.contract,
        collection_slug: target.collection_slug,
        missing_at: completedAt,
        order
      }))
    : [];
  const snapshot = await db.publishCompletedSnapshot({
    id: randomUUID(),
    source: OPENSEA_SOURCE,
    contract: target.contract,
    collection_slug: target.collection_slug,
    collection_id: target.collection_id,
    started_at: startedAt,
    completed_at: completedAt,
    normalizer_version: OPENSEA_NORMALIZER_VERSION,
    raw_order_count: listings.length + offers.length,
    unsupported_count: results.filter((result) => result.unsupported).length,
    skipped_count: results.filter((result) => result.skipped).length,
    event_count: 0,
    raw_archive_gzip: await gzipAsync(Buffer.from(JSON.stringify(rawArchive))),
    normalized_archive_gzip: await gzipAsync(
      Buffer.from(JSON.stringify(normalizedArchive))
    ),
    orders,
    reconciliations
  });
  const postPublicationFailures: unknown[] = [];
  try {
    await pollOpenSeaEvents(target, { client, db, now, deadlineMs });
  } catch (error) {
    postPublicationFailures.push(error);
    logger.error(
      `[COLLECTION ${target.collection_slug}] OpenSea event catch-up failed after order-book publication`,
      error
    );
  }
  try {
    await reconcileOpenSeaOrders({ target, client, db, deadlineMs, now });
  } catch (error) {
    postPublicationFailures.push(error);
    logger.error(
      `[COLLECTION ${target.collection_slug}] OpenSea order reconciliation failed after order-book publication`,
      error
    );
  }
  if (postPublicationFailures.length > 0) {
    throw new Error(
      `OpenSea order book published but ${postPublicationFailures.length} lifecycle task(s) failed: ${postPublicationFailures
        .map((error) =>
          error instanceof Error ? error.message : String(error)
        )
        .join('; ')}`
    );
  }
  return snapshot;
}

export async function pollOpenSeaMarketDepthForContract(
  contract: string,
  options: OpenSeaPollOptions = {}
): Promise<MarketDepthSnapshotMetadata[]> {
  const client = options.client ?? new OpenSeaClient();
  const deadlineMs = options.deadlineMs ?? Date.now() + 10 * 60_000;
  const normalizedContract = contract.toLowerCase();
  const targets =
    normalizedContract === 'nextgen'
      ? (await discoverOpenSeaCollections(client, deadlineMs)).filter(
          (target) => target.collection_id !== null
        )
      : STATIC_COLLECTIONS.filter(
          (target) => target.contract === normalizedContract
        );
  if (targets.length === 0)
    throw new Error(`No OpenSea market-depth target for ${contract}`);
  const snapshots: MarketDepthSnapshotMetadata[] = [];
  const failures: unknown[] = [];
  for (const target of targets) {
    try {
      snapshots.push(
        await pollOpenSeaCollection(target, { ...options, client, deadlineMs })
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} OpenSea market-depth collection poll(s) failed: ${failures
        .map((error) =>
          error instanceof Error ? error.message : String(error)
        )
        .join('; ')}`
    );
  }
  return snapshots;
}
