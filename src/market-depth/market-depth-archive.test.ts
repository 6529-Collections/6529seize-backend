import { gunzipSync, gzipSync } from 'node:zlib';
import {
  archiveMarketDepthHistory,
  MarketDepthArchivedEvent,
  MarketDepthArchiveDb,
  MarketDepthArchiveKind,
  MarketDepthArchiveStore,
  readArchivedThrough
} from './market-depth-archive';
import { MarketDepthSnapshotMetadata } from './market-depth.types';

const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const NOW = new Date('2026-11-22T12:05:00.000Z');
const HOUR = 3_600_000;

function event(id: string, observedAt: string): MarketDepthArchivedEvent {
  return {
    event_id: id,
    kind: 'offer',
    source: 'opensea_stream',
    source_evidence: 'stream',
    chain: 'ethereum',
    chain_id: '1',
    provider_at: new Date(observedAt),
    observed_at: new Date(observedAt),
    occurred_at: new Date(observedAt),
    order_id: `order-${id}`,
    contract: CONTRACT,
    collection_slug: 'thememes6529',
    token_id: '1',
    maker: null,
    taker: null,
    quantity: '1',
    currency_contract: null,
    currency_symbol: 'WETH',
    currency_decimals: 18,
    price_raw: '1',
    price_decimal: '0.000000000000000001',
    transaction_hash: null,
    raw: JSON.stringify({ payload: { id } }) as never
  };
}

function snapshot(
  id: string,
  completedAt: string
): MarketDepthSnapshotMetadata {
  return {
    id,
    chain: 'ethereum',
    chain_id: '1',
    contract: CONTRACT,
    collection_slug: 'thememes6529',
    collection_id: null,
    source: 'opensea',
    schema_version: 1,
    normalizer_version: 'v1',
    started_at: new Date(completedAt),
    completed_at: new Date(completedAt),
    raw_order_count: 1,
    order_count: 1,
    ask_count: 1,
    bid_count: 0,
    unsupported_count: 0,
    skipped_count: 0,
    event_count: 0
  };
}

function fakeDb(
  events: MarketDepthArchivedEvent[],
  snapshots: MarketDepthSnapshotMetadata[],
  missingArchives: string[] = []
): jest.Mocked<MarketDepthArchiveDb> {
  const timeOf = (kind: MarketDepthArchiveKind) =>
    kind === 'events'
      ? events.map((row) => row.observed_at)
      : snapshots.map((row) => row.completed_at);
  return {
    getFirstArchivableAtOrAfter: jest.fn(async ({ kind, from }) => {
      const times = timeOf(kind)
        .filter((at) => at >= from)
        .sort((a, b) => a.getTime() - b.getTime());
      return times[0] ?? null;
    }),
    getEventsObservedBetween: jest.fn(async ({ from, to, after, limit }) =>
      events
        .filter((row) => row.observed_at >= from && row.observed_at < to)
        .filter(
          (row) =>
            !after ||
            row.observed_at > after.observed_at ||
            (row.observed_at.getTime() === after.observed_at.getTime() &&
              row.event_id > after.event_id)
        )
        .slice(0, limit)
    ),
    getSnapshotsCompletedBetween: jest.fn(async ({ from, to }) =>
      snapshots.filter(
        (row) => row.completed_at >= from && row.completed_at < to
      )
    ),
    getSnapshotArchive: jest.fn(async (id) =>
      missingArchives.includes(id)
        ? null
        : {
            snapshot_id: id,
            raw_archive_gzip: gzipSync(`raw-${id}`),
            normalized_archive_gzip: gzipSync(`normalized-${id}`)
          }
    )
  };
}

function memoryStore(
  initial: Partial<Record<MarketDepthArchiveKind, Date>> = {}
) {
  const objects = new Map<string, Buffer>();
  const state = new Map<MarketDepthArchiveKind, Date>(
    Object.entries(initial) as [MarketDepthArchiveKind, Date][]
  );
  const store: jest.Mocked<MarketDepthArchiveStore> = {
    getArchivedThrough: jest.fn(
      async (kind: MarketDepthArchiveKind, _contract: string) =>
        state.get(kind) ?? null
    ),
    setArchivedThrough: jest.fn(async (kind, _contract, at) => {
      state.set(kind, at);
    }),
    putObject: jest.fn(async ({ key, body }) => {
      objects.set(key, body);
    })
  };
  return { store, objects, state };
}

function lines(body: Buffer | undefined): Record<string, unknown>[] {
  return gunzipSync(body!)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function run(db: MarketDepthArchiveDb, store: MarketDepthArchiveStore) {
  return archiveMarketDepthHistory({
    contract: CONTRACT.toUpperCase().replace('0X', '0x'),
    db,
    store,
    deadlineMs: NOW.getTime() + 60_000,
    now: () => NOW
  });
}

describe('market-depth archive', () => {
  it('archives settled hours, skips empty stretches and leaves the open hour', async () => {
    const db = fakeDb(
      [
        event('a', '2026-11-22T08:10:00.000Z'),
        event('b', '2026-11-22T08:50:00.000Z'),
        event('c', '2026-11-22T10:15:00.000Z'),
        // The current hour has not settled yet.
        event('d', '2026-11-22T12:01:00.000Z')
      ],
      []
    );
    const { store, objects, state } = memoryStore();

    const result = await run(db, store);

    expect(
      Array.from(objects.keys()).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      `market-depth/v1/events/contract=${CONTRACT}/date=2026-11-22/hour=08.jsonl.gz`,
      `market-depth/v1/events/contract=${CONTRACT}/date=2026-11-22/hour=10.jsonl.gz`
    ]);
    const hour8 = lines(
      objects.get(
        `market-depth/v1/events/contract=${CONTRACT}/date=2026-11-22/hour=08.jsonl.gz`
      )
    );
    expect(hour8.map((row) => row.event_id)).toEqual(['a', 'b']);
    expect(hour8[0]).toMatchObject({
      observed_at: '2026-11-22T08:10:00.000Z',
      raw: { payload: { id: 'a' } }
    });
    // Hour 09 had no rows: one jump, no empty file.
    expect(result.events).toMatchObject({ hours: 2, rows: 3, complete: true });
    expect(state.get('events')).toEqual(new Date('2026-11-22T11:00:00.000Z'));
    expect(state.get('snapshots')).toEqual(
      new Date('2026-11-22T11:00:00.000Z')
    );
  });

  it('resumes after its watermark without re-uploading archived hours', async () => {
    const db = fakeDb(
      [
        event('a', '2026-11-22T08:10:00.000Z'),
        event('c', '2026-11-22T10:15:00.000Z')
      ],
      []
    );
    const { store, objects } = memoryStore({
      events: new Date('2026-11-22T09:00:00.000Z')
    });
    await run(db, store);
    expect(Array.from(objects.keys())).toEqual([
      `market-depth/v1/events/contract=${CONTRACT}/date=2026-11-22/hour=10.jsonl.gz`
    ]);
  });

  it('pages through a busy hour into one file', async () => {
    const busy = Array.from({ length: 4_500 }, (_, index) =>
      event(`e${String(index).padStart(5, '0')}`, '2026-11-22T08:30:00.000Z')
    );
    const db = fakeDb(busy, []);
    const { store, objects } = memoryStore();
    await run(db, store);
    expect(db.getEventsObservedBetween).toHaveBeenCalledTimes(3);
    const rows = lines(
      objects.get(
        `market-depth/v1/events/contract=${CONTRACT}/date=2026-11-22/hour=08.jsonl.gz`
      )
    );
    expect(rows).toHaveLength(4_500);
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(4_500);
  });

  it('caps hours per run and records progress after each hour', async () => {
    const start = Date.parse('2026-11-19T00:00:00.000Z');
    const db = fakeDb(
      Array.from({ length: 60 }, (_, hour) =>
        event(`h${hour}`, new Date(start + hour * HOUR + 60_000).toISOString())
      ),
      []
    );
    const { store, state } = memoryStore();
    const result = await run(db, store);
    expect(result.events).toMatchObject({ hours: 48, complete: false });
    expect(state.get('events')).toEqual(new Date(start + 48 * HOUR));
    expect(store.setArchivedThrough).toHaveBeenCalledTimes(48 + 1);
  });

  it('stops at the deadline between hours', async () => {
    let clock = NOW.getTime();
    const db = fakeDb(
      [
        event('a', '2026-11-22T06:10:00.000Z'),
        event('b', '2026-11-22T07:10:00.000Z'),
        event('c', '2026-11-22T08:10:00.000Z')
      ],
      []
    );
    const { store, state } = memoryStore();
    store.putObject.mockImplementation(async () => {
      clock += 40_000;
    });
    const result = await archiveMarketDepthHistory({
      contract: CONTRACT,
      db,
      store,
      deadlineMs: NOW.getTime() + 60_000,
      now: () => new Date(clock)
    });
    expect(result.events).toMatchObject({ hours: 2, complete: false });
    expect(state.get('events')).toEqual(new Date('2026-11-22T08:00:00.000Z'));
  });

  it('uploads each snapshot archive with an hourly manifest', async () => {
    const db = fakeDb(
      [],
      [
        snapshot('s1', '2026-11-22T08:05:00.123Z'),
        snapshot('s2', '2026-11-22T08:15:00.000Z')
      ],
      ['s2']
    );
    const { store, objects, state } = memoryStore();
    const result = await run(db, store);

    const prefix = `market-depth/v1/snapshots/contract=${CONTRACT}/date=2026-11-22/hour=08`;
    expect(
      Array.from(objects.keys()).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      `${prefix}/20261122T080500123Z_s1.normalized.json.gz`,
      `${prefix}/20261122T080500123Z_s1.raw.json.gz`,
      `${prefix}/manifest.jsonl.gz`
    ]);
    expect(
      gunzipSync(
        objects.get(`${prefix}/20261122T080500123Z_s1.raw.json.gz`)!
      ).toString()
    ).toBe('raw-s1');
    const manifest = lines(objects.get(`${prefix}/manifest.jsonl.gz`));
    expect(manifest.map((row) => [row.id, row.archives])).toEqual([
      [
        's1',
        {
          raw: `${prefix}/20261122T080500123Z_s1.raw.json.gz`,
          normalized: `${prefix}/20261122T080500123Z_s1.normalized.json.gz`
        }
      ],
      ['s2', null]
    ]);
    expect(result.snapshots).toMatchObject({ hours: 1, rows: 2 });
    expect(state.get('snapshots')).toEqual(
      new Date('2026-11-22T11:00:00.000Z')
    );
  });

  it('does not advance the watermark past an hour whose upload failed', async () => {
    const db = fakeDb(
      [
        event('a', '2026-11-22T08:10:00.000Z'),
        event('b', '2026-11-22T09:10:00.000Z')
      ],
      []
    );
    const { store, state } = memoryStore();
    store.putObject
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error('S3 unavailable'));
    await expect(run(db, store)).rejects.toThrow('S3 unavailable');
    expect(state.get('events')).toEqual(new Date('2026-11-22T09:00:00.000Z'));
  });

  it('reads both watermarks for the lowercased contract', async () => {
    const { store } = memoryStore({
      snapshots: new Date('2026-11-22T10:00:00.000Z')
    });
    await expect(
      readArchivedThrough(store, CONTRACT.toUpperCase().replace('0X', '0x'))
    ).resolves.toEqual({
      snapshots: new Date('2026-11-22T10:00:00.000Z'),
      events: null
    });
    expect(store.getArchivedThrough).toHaveBeenCalledWith('events', CONTRACT);
  });
});
