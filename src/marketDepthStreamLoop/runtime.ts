import {
  EventType,
  LogLevel,
  OpenSeaStreamClient,
  type BaseStreamMessage
} from '@opensea/sdk/stream';
import { Logger } from '@/logging';
import { marketDepthDb } from '@/market-depth/market-depth.db';
import type {
  AppendMarketDepthEventsInput,
  MarketDepthEventInput
} from '@/market-depth/market-depth.types';
import { normalizeOpenSeaEvent } from '@/market-depth/opensea-normalizer';

const SOURCE = 'opensea_stream';
const BATCH_SIZE = 50;
const MAX_BUFFERED_EVENTS = 1000;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_EVENT_IDS = 4000;
const FLUSH_INTERVAL_MS = 1000;
// A 10-minute schedule with concurrency 2 overlaps capture by about 35 seconds.
const DEFAULT_RUN_MS = 650_000;
const RESERVED_FLUSH_MS = 15_000;
const LAMBDA_TEARDOWN_MS = 5000;
const OPERATION_TIMEOUT_MS = 5000;
const DISCONNECT_TIMEOUT_MS = 2000;
const PERSIST_ATTEMPTS = 3;
const logger = Logger.get('OPENSEA_MARKET_DEPTH_STREAM');

export interface StreamCollection {
  readonly slug: string;
  readonly contract: string;
}

export interface StreamDatabase {
  appendEvents(input: AppendMarketDepthEventsInput): Promise<void>;
}

export interface StreamClient {
  onEvents(
    slug: string,
    eventTypes: EventType[],
    callback: (event: BaseStreamMessage<unknown>) => void
  ): () => void;
  disconnect(callback?: () => void): void;
}

export interface StreamRuntimeOptions {
  readonly collections: readonly StreamCollection[];
  readonly apiKey: string;
  readonly db?: StreamDatabase;
  readonly createClient?: (
    apiKey: string,
    onError: (error: unknown) => void
  ) => StreamClient;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Total capture and shutdown budget, bounded by the Lambda's remaining time. */
  readonly runMs?: number;
  readonly remainingTimeMs?: () => number;
  readonly log?: Pick<typeof logger, 'info' | 'warn'>;
}

const EVENT_TYPES = [
  EventType.ITEM_LISTED,
  EventType.ITEM_RECEIVED_BID,
  EventType.COLLECTION_OFFER,
  EventType.TRAIT_OFFER,
  EventType.ITEM_CANCELLED,
  EventType.ORDER_INVALIDATE,
  EventType.ORDER_REVALIDATE,
  EventType.ITEM_SOLD
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function streamEventInput(
  event: BaseStreamMessage<unknown>,
  collection: StreamCollection,
  observedAt: Date
): MarketDepthEventInput {
  const payload = asRecord(event.payload);
  const item = asRecord(payload.item);
  const payment = asRecord(payload.payment_token);
  const tokenId =
    stringValue(payload.token_id) ??
    stringValue(item.nft_id)?.split('/').pop() ??
    null;
  const normalized = normalizeOpenSeaEvent(
    {
      ...payload,
      event_type: event.event_type,
      version: String(event.version),
      event_timestamp: stringValue(payload.event_timestamp) ?? event.sent_at,
      order_hash:
        stringValue(payload.order_hash) ?? stringValue(payload.order_id),
      maker: stringValue(asRecord(payload.maker).address),
      taker: stringValue(asRecord(payload.taker).address),
      transaction:
        stringValue(asRecord(payload.transaction).hash) ??
        stringValue(payload.transaction_hash),
      nft: { identifier: tokenId },
      payment: {
        quantity:
          stringValue(payload.base_price) ?? stringValue(payload.sale_price),
        address: stringValue(payment.address),
        symbol: stringValue(payment.symbol),
        decimals: payment.decimals
      }
    },
    collection.contract,
    collection.slug,
    observedAt
  );
  return {
    ...normalized,
    source: SOURCE,
    source_evidence: 'stream',
    raw: event as unknown as MarketDepthEventInput['raw']
  };
}

class StreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    // The ES5 test target otherwise loses Error subclass identity.
    Object.setPrototypeOf(this, StreamTimeoutError.prototype);
  }
}

/** A timeout does not cancel a SQL write; callers must not retry it concurrently. */
async function bounded<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  if (timeoutMs <= 0) throw new StreamTimeoutError(message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StreamTimeoutError(message)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface BufferedEvent {
  readonly event: MarketDepthEventInput;
  readonly bytes: number;
}

class EventBuffer {
  private readonly pending: BufferedEvent[] = [];
  private readonly recentIds = new Set<string>();
  private bytes = 0;
  accepted = 0;
  persisted = 0;
  duplicates = 0;

  get length(): number {
    return this.pending.length;
  }

  enqueue(
    event: BaseStreamMessage<unknown>,
    collection: StreamCollection,
    now: Date
  ) {
    const input = streamEventInput(event, collection, now);
    if (this.recentIds.has(input.event_id)) {
      this.duplicates++;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (
      this.pending.length >= MAX_BUFFERED_EVENTS ||
      this.bytes + bytes > MAX_BUFFERED_BYTES
    ) {
      throw new Error('OpenSea Stream buffer capacity exceeded');
    }
    this.pending.push({ event: input, bytes });
    this.bytes += bytes;
    this.accepted++;
    this.recentIds.add(input.event_id);
    if (this.recentIds.size > MAX_RECENT_EVENT_IDS) {
      const oldest = this.recentIds.values().next().value;
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
  }

  batch(): BufferedEvent[] {
    const first = this.pending[0]?.event;
    if (!first) return [];
    return this.pending
      .filter(
        ({ event }) =>
          event.contract === first.contract &&
          event.collection_slug === first.collection_slug
      )
      .slice(0, BATCH_SIZE);
  }

  acknowledge(batch: BufferedEvent[]): void {
    const acknowledged = new Set(batch);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (acknowledged.has(this.pending[i])) {
        this.bytes -= this.pending[i].bytes;
        this.pending.splice(i, 1);
        this.persisted++;
      }
    }
  }
}

async function persistBatch(
  db: StreamDatabase,
  batch: BufferedEvent[],
  observedAt: Date
): Promise<void> {
  const events = batch.map(({ event }) => event);
  const first = events[0];
  const newest = events.reduce<Date | null>(
    (latest, event) =>
      event.provider_at && (!latest || event.provider_at > latest)
        ? event.provider_at
        : latest,
    null
  );
  await db.appendEvents({
    source: SOURCE,
    contract: first.contract,
    collection_slug: first.collection_slug,
    // Stream delivery has no replay cursor or completeness watermark. Keeping
    // these null lets overlapping workers append under the same transaction lock;
    // the shared lifecycle event ID makes replays idempotent in the database.
    expected_cursor: null,
    expected_watermark: null,
    next_cursor: null,
    provider_watermark: null,
    provider_at: newest,
    observed_at: observedAt,
    events
  });
}

async function flushBatch(
  buffer: EventBuffer,
  db: StreamDatabase,
  now: () => Date,
  budgetMs: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const batch = buffer.batch();
  if (!batch.length) return;
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      await bounded(
        () => persistBatch(db, batch, now()),
        Math.min(OPERATION_TIMEOUT_MS, budgetMs()),
        'OpenSea Stream persistence timed out'
      );
      buffer.acknowledge(batch);
      return;
    } catch (error) {
      if (error instanceof StreamTimeoutError) throw error;
      if (attempt === PERSIST_ATTEMPTS) {
        throw new Error('OpenSea Stream persistence failed after 3 attempts');
      }
      await sleep(Math.max(0, Math.min(attempt * 100, budgetMs())));
    }
  }
}

const defaultCreateClient = (
  apiKey: string,
  onError: (error: unknown) => void
): StreamClient =>
  new OpenSeaStreamClient({ apiKey, onError, logLevel: LogLevel.ERROR });

async function stopSubscriptions(
  unsubscribe: readonly (() => void)[],
  client: StreamClient | undefined,
  budgetMs: () => number
): Promise<Error | null> {
  let failure: Error | null = null;
  for (const remove of unsubscribe) {
    try {
      remove();
    } catch {
      failure ??= new Error('OpenSea Stream unsubscribe failed');
    }
  }
  if (client) {
    try {
      await bounded(
        () => new Promise<void>((resolve) => client.disconnect(resolve)),
        Math.min(DISCONNECT_TIMEOUT_MS, budgetMs()),
        'OpenSea Stream disconnect timed out'
      );
    } catch {
      failure ??= new Error('OpenSea Stream disconnect failed');
    }
  }
  return failure;
}

async function drainAcceptedEvents(
  buffer: EventBuffer,
  flush: () => Promise<void>,
  persistenceTimedOut: boolean
): Promise<Error | null> {
  // Even subscription/callback/shutdown failures must drain accepted events.
  // A timed-out write is the exception: its outcome is still unknown.
  if (persistenceTimedOut) return null;
  try {
    while (buffer.length) await flush();
    return null;
  } catch {
    return new Error('OpenSea Stream final persistence failed');
  }
}

export async function runMarketDepthStream(
  options: StreamRuntimeOptions
): Promise<void> {
  if (!options.apiKey || !options.collections.length) {
    throw new Error(
      'OpenSea Stream requires an API key and discovered collections'
    );
  }
  const db = options.db ?? marketDepthDb;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? logger;
  const runMs = Math.min(
    options.runMs ?? DEFAULT_RUN_MS,
    (options.remainingTimeMs?.() ?? Infinity) - LAMBDA_TEARDOWN_MS
  );
  if (runMs <= 0) throw new Error('Insufficient OpenSea Stream runtime budget');
  const deadline = now().getTime() + runMs;
  const shutdownMs = Math.min(RESERVED_FLUSH_MS, runMs / 2);
  const captureDeadline = deadline - shutdownMs;
  const budgetMs = () =>
    Math.min(
      deadline - now().getTime(),
      (options.remainingTimeMs?.() ?? Infinity) - LAMBDA_TEARDOWN_MS
    );
  const buffer = new EventBuffer();
  const unsubscribe: Array<() => void> = [];
  let client: StreamClient | undefined;
  let failure: Error | null = null;
  let persistenceTimedOut = false;
  let accepting = true;
  let transportErrors = 0;
  const flush = async () => {
    try {
      await flushBatch(buffer, db, now, budgetMs, sleep);
    } catch (error) {
      persistenceTimedOut = error instanceof StreamTimeoutError;
      throw error;
    }
  };

  try {
    client = (options.createClient ?? defaultCreateClient)(
      options.apiKey,
      () => {
        // The SDK owns socket reconnects and channel rejoins. Never log its error
        // object: WebSocket errors can contain the authenticated endpoint URL.
        transportErrors++;
        if (transportErrors === 1)
          log.warn(
            'OpenSea Stream transport error; SDK recovery remains active'
          );
      }
    );
    for (const collection of options.collections) {
      unsubscribe.push(
        client.onEvents(collection.slug, EVENT_TYPES, (event) => {
          if (!accepting || failure) return;
          try {
            buffer.enqueue(event, collection, now());
          } catch {
            failure = new Error('OpenSea Stream event could not be buffered');
          }
        })
      );
    }
    while (
      now().getTime() < captureDeadline &&
      budgetMs() > shutdownMs &&
      !failure
    ) {
      if (buffer.length) await flush();
      else
        await sleep(
          Math.min(FLUSH_INTERVAL_MS, captureDeadline - now().getTime())
        );
    }
  } catch (error) {
    failure =
      error instanceof StreamTimeoutError
        ? error
        : new Error('OpenSea Stream capture or persistence failed');
  } finally {
    accepting = false;
    const shutdownFailure = await stopSubscriptions(
      unsubscribe,
      client,
      budgetMs
    );
    const drainFailure = await drainAcceptedEvents(
      buffer,
      flush,
      persistenceTimedOut
    );
    failure ??= shutdownFailure ?? drainFailure;
    log.info(
      `[STREAM accepted=${buffer.accepted} persisted=${buffer.persisted} duplicates=${buffer.duplicates} pending=${buffer.length} transport_errors=${transportErrors}]`
    );
  }
  if (failure || buffer.length) {
    throw new Error(
      `${failure?.message ?? 'OpenSea Stream persistence incomplete'}; ${buffer.length} events remain unconfirmed`
    );
  }
}

export const handler = async (
  _event: unknown,
  context: {
    getRemainingTimeInMillis?: () => number;
    collections: readonly StreamCollection[];
  }
) => {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) throw new Error('OPENSEA_API_KEY is required');
  await runMarketDepthStream({
    apiKey,
    collections: context.collections,
    remainingTimeMs: context.getRemainingTimeInMillis
  });
};
