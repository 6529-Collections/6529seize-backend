import { EventType, type BaseStreamMessage } from '@opensea/sdk/stream';
import { normalizeOpenSeaEvent } from '@/market-depth/opensea-normalizer';
import type { AppendMarketDepthEventsInput } from '@/market-depth/market-depth.types';
import {
  runMarketDepthStream,
  streamEventInput,
  type StreamClient,
  type StreamRuntimeOptions
} from './runtime';

const collection = { slug: 'memes', contract: '0xcontract' };
const timestamp = '2026-09-10T00:00:01Z';

function makeEvent(order = '0xorder'): BaseStreamMessage<unknown> {
  return {
    event_type: EventType.ITEM_LISTED,
    version: 1,
    sent_at: timestamp,
    payload: {
      event_timestamp: timestamp,
      order_hash: order,
      item: { nft_id: 'ethereum/0xcontract/1' },
      maker: { address: '0xmaker' },
      taker: { address: '0xtaker' },
      quantity: 1,
      base_price: '100',
      payment_token: { address: '0xcurrency', symbol: 'ETH', decimals: 18 }
    }
  };
}

function fixture() {
  let elapsed = 0;
  let onTransportError: (error: unknown) => void = () => undefined;
  let onSubscribe: (slug: string) => void = () => undefined;
  let onSleep: () => void = () => undefined;
  const callbacks = new Map<
    string,
    (event: BaseStreamMessage<unknown>) => void
  >();
  const unsubscribe = jest.fn();
  const disconnect = jest.fn((callback?: () => void) => callback?.());
  const client: StreamClient = {
    onEvents: (slug, _eventTypes, callback) => {
      callbacks.set(slug, callback);
      onSubscribe(slug);
      return unsubscribe;
    },
    disconnect
  };
  const appendEvents = jest.fn(
    async (_input: AppendMarketDepthEventsInput) => undefined
  );
  const log = { info: jest.fn(), warn: jest.fn() };
  const options: StreamRuntimeOptions = {
    apiKey: 'secret-api-key',
    collections: [collection],
    db: { appendEvents },
    createClient: (_key, onError) => {
      onTransportError = onError;
      return client;
    },
    runMs: 60_000,
    now: () => new Date(Date.parse(timestamp) + elapsed),
    sleep: async (ms) => {
      onSleep();
      elapsed += ms;
    },
    log
  };
  return {
    options,
    appendEvents,
    log,
    disconnect,
    unsubscribe,
    elapsed: () => elapsed,
    subscribe: (callback: typeof onSubscribe) => {
      onSubscribe = callback;
    },
    sleep: (callback: typeof onSleep) => {
      onSleep = callback;
    },
    transportError: (error: unknown) => onTransportError(error),
    emit: (event: BaseStreamMessage<unknown>, slug = collection.slug) =>
      callbacks.get(slug)?.(event)
  };
}

describe('OpenSea stream event adaptation', () => {
  it('matches REST listing identities and preserves the full stream envelope', () => {
    const event = makeEvent();
    const result = streamEventInput(event, collection, new Date(timestamp));
    const rest = normalizeOpenSeaEvent(
      {
        event_type: 'listing',
        order_hash: '0xorder',
        event_timestamp: timestamp,
        nft: { identifier: '1' }
      },
      collection.contract,
      collection.slug,
      new Date(timestamp)
    );
    expect(result.event_id).toBe(rest.event_id);
    expect(result).toMatchObject({
      source: 'opensea_stream',
      source_evidence: 'stream',
      raw: event,
      token_id: '1',
      maker: '0xmaker',
      quantity: '1',
      price_raw: '100',
      currency_contract: '0xcurrency',
      currency_decimals: 18
    });
  });

  it('uses the SDK nested sale transaction and matches REST sale identities', () => {
    const event = makeEvent();
    event.event_type = EventType.ITEM_SOLD;
    event.payload = {
      ...(event.payload as Record<string, unknown>),
      transaction: { hash: '0xtx', timestamp },
      base_price: undefined,
      sale_price: '250'
    };
    const result = streamEventInput(event, collection, new Date(timestamp));
    const rest = normalizeOpenSeaEvent(
      {
        event_type: 'sale',
        transaction: '0xtx',
        nft: { identifier: '1' },
        maker: '0xmaker',
        taker: '0xtaker',
        quantity: 1
      },
      collection.contract,
      collection.slug,
      new Date(timestamp)
    );
    expect(result.event_id).toBe(rest.event_id);
    expect(result).toMatchObject({
      transaction_hash: '0xtx',
      price_raw: '250'
    });
  });

  it('retains distinct invalidation and revalidation observations and versions', () => {
    const event = makeEvent();
    event.event_type = EventType.ORDER_INVALIDATE;
    const first = streamEventInput(event, collection, new Date(timestamp));
    const nextVersion = streamEventInput(
      { ...event, version: 2 },
      collection,
      new Date(timestamp)
    );
    const revalidation = streamEventInput(
      { ...event, event_type: EventType.ORDER_REVALIDATE },
      collection,
      new Date(timestamp)
    );
    expect(
      new Set([first.event_id, nextVersion.event_id, revalidation.event_id])
        .size
    ).toBe(3);
  });
});

describe('market depth stream runtime', () => {
  afterEach(() => jest.useRealTimers());

  it('flushes at shutdown, preserves out-of-order evidence and deduplicates replays', async () => {
    const f = fixture();
    f.sleep(() => {
      f.emit(makeEvent('later'));
      const older = makeEvent('older');
      older.payload = {
        ...(older.payload as Record<string, unknown>),
        event_timestamp: '2026-09-09T23:59:59Z'
      };
      f.emit(older);
      f.emit(makeEvent('later'));
    });
    await runMarketDepthStream(f.options);
    expect(f.appendEvents).toHaveBeenCalledTimes(1);
    expect(f.appendEvents.mock.calls[0][0].events).toHaveLength(2);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it('allows SDK recovery after transport errors without logging credentials', async () => {
    const f = fixture();
    f.sleep(() => {
      f.transportError(
        new Error('wss://example/socket?api_key=secret-api-key')
      );
      f.emit(makeEvent());
    });
    await runMarketDepthStream(f.options);
    expect(f.appendEvents).toHaveBeenCalledTimes(1);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'secret-api-key'
    );
  });

  it('retries completed failures without removing accepted events', async () => {
    const f = fixture();
    f.subscribe(() => f.emit(makeEvent()));
    f.appendEvents
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'));
    await runMarketDepthStream(f.options);
    expect(f.appendEvents).toHaveBeenCalledTimes(3);
    expect(f.log.info).toHaveBeenCalledWith(
      expect.stringContaining('pending=0')
    );
  });

  it('attempts a final flush on persistent failure and reports unconfirmed events', async () => {
    const f = fixture();
    f.subscribe(() => f.emit(makeEvent()));
    f.appendEvents.mockRejectedValue(new Error('database secret-api-key'));
    await expect(runMarketDepthStream(f.options)).rejects.toThrow(
      '1 events remain unconfirmed'
    );
    expect(f.appendEvents).toHaveBeenCalledTimes(6);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it('cleans up partial subscriptions and persists events accepted before a subscribe failure', async () => {
    const f = fixture();
    f.subscribe((slug) => {
      if (slug === 'other') throw new Error('subscribe failed secret-api-key');
      f.emit(makeEvent());
    });
    await expect(
      runMarketDepthStream({
        ...f.options,
        collections: [collection, { ...collection, slug: 'other' }]
      })
    ).rejects.toThrow('0 events remain unconfirmed');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.appendEvents).toHaveBeenCalledTimes(1);
  });

  it('catches callback failures and flushes previously accepted events', async () => {
    const f = fixture();
    f.subscribe(() => {
      f.emit(makeEvent());
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() =>
        f.emit({ ...makeEvent('bad'), payload: circular })
      ).not.toThrow();
    });
    await expect(runMarketDepthStream(f.options)).rejects.toThrow(
      'event could not be buffered'
    );
    expect(f.appendEvents.mock.calls[0][0].events).toHaveLength(1);
  });

  it('bounds backpressure and flushes the accepted queue before failing visibly', async () => {
    const f = fixture();
    f.subscribe(() => {
      for (let i = 0; i < 1001; i++) f.emit(makeEvent(`order-${i}`));
    });
    await expect(runMarketDepthStream(f.options)).rejects.toThrow(
      'event could not be buffered'
    );
    expect(
      f.appendEvents.mock.calls.flatMap(([input]) => input.events)
    ).toHaveLength(1000);
  });

  it('overlapping workers keep cursor preconditions null and submit identical lifecycle IDs', async () => {
    const a = fixture();
    const b = fixture();
    a.subscribe(() => a.emit(makeEvent()));
    b.subscribe(() => b.emit(makeEvent()));
    const persistedIds = new Set<string>();
    const appendEvents = jest.fn(
      async (input: AppendMarketDepthEventsInput) => {
        expect(input).toMatchObject({
          source: 'opensea_stream',
          expected_cursor: null,
          expected_watermark: null,
          next_cursor: null,
          provider_watermark: null
        });
        // Mirror the DB's global lifecycle uniqueness contract for concurrent deliveries.
        input.events.forEach((event) => persistedIds.add(event.event_id));
      }
    );
    await Promise.all([
      runMarketDepthStream({ ...a.options, db: { appendEvents } }),
      runMarketDepthStream({ ...b.options, db: { appendEvents } })
    ]);
    expect(appendEvents).toHaveBeenCalledTimes(2);
    expect(persistedIds.size).toBe(1);
    expect(appendEvents.mock.calls[0][0].events[0].raw).toEqual(makeEvent());
  });

  it('bounds a stalled disconnect and still drains accepted events', async () => {
    jest.useFakeTimers();
    const f = fixture();
    f.subscribe(() => {
      f.emit(makeEvent());
      throw new Error('subscribe failed');
    });
    f.disconnect.mockImplementation(() => undefined);
    const checked = expect(runMarketDepthStream(f.options)).rejects.toThrow(
      '0 events remain unconfirmed'
    );
    await jest.advanceTimersByTimeAsync(2000);
    await checked;
    expect(f.appendEvents).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled write without starting a concurrent uncertain retry', async () => {
    jest.useFakeTimers();
    const f = fixture();
    f.subscribe(() => f.emit(makeEvent()));
    f.appendEvents.mockImplementation(() => new Promise(() => undefined));
    const checked = expect(runMarketDepthStream(f.options)).rejects.toThrow(
      'persistence timed out; 1 events remain unconfirmed'
    );
    await jest.advanceTimersByTimeAsync(5000);
    await checked;
    expect(f.appendEvents).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects insufficient Lambda time before opening a socket', async () => {
    const f = fixture();
    await expect(
      runMarketDepthStream({ ...f.options, remainingTimeMs: () => 4000 })
    ).rejects.toThrow('Insufficient');
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it('captures for 635 seconds by default so successive 600-second invocations overlap', async () => {
    const f = fixture();
    await runMarketDepthStream({ ...f.options, runMs: undefined });
    expect(f.elapsed()).toBe(635_000);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });
});
