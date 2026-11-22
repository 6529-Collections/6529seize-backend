import { DeviceEventKind } from '@/api/device-signing/device-event';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import {
  TEST_GRANT_ID,
  testGrantEntity,
  testGrantProof,
  testSignedEvent
} from '@/tests/fixtures/relay-events.fixture';
import {
  CrpAuthed,
  CrpCursor,
  CrpHistoryPage,
  CrpItem,
  CrpSubscriptionHandlers,
  CrpWelcome
} from '@/wave-relay-publish/crp-client';
import { IngestedEvent, IngestRow } from './drop-index.db';
import {
  DropIndexConnection,
  DropIndexStore,
  DropIndexSubscriber,
  dropIdOfEvent
} from './drop-index.subscriber';

class FakeStore implements DropIndexStore {
  readonly rows: IngestedEvent[] = [];
  readonly cursorsOf = new Map<string, Map<string, CrpCursor>>();
  grants = new Map<string, DeviceGrantEntity>();
  site = new Map<string, string | null>();
  failIngest = false;

  async cursors(relayId: string) {
    return Array.from(this.cursorsOf.get(relayId)?.values() ?? []);
  }

  async knownGrants(ids: readonly string[]) {
    return new Map(
      Array.from(this.grants.entries()).filter(([id]) => ids.includes(id))
    );
  }

  async siteEvents(ids: readonly string[]) {
    return new Map(
      Array.from(this.site.entries()).filter(([id]) => ids.includes(id))
    );
  }

  async ingest(
    rows: readonly IngestRow[],
    relayId: string,
    cursors: readonly CrpCursor[]
  ) {
    if (this.failIngest) throw new Error('database down');
    const added: IngestedEvent[] = [];
    for (const row of rows) {
      if (this.rows.some((r) => r.event_id === row.event_id)) continue;
      const stored = { ...row, ingest_seq: this.rows.length + 1 };
      this.rows.push(stored);
      added.push(stored);
    }
    const relay = this.cursorsOf.get(relayId) ?? new Map();
    for (const cursor of cursors) {
      const at = relay.get(cursor.wave);
      if (!at || at.logEpoch !== cursor.logEpoch || cursor.rseq > at.rseq) {
        relay.set(cursor.wave, cursor);
      }
    }
    this.cursorsOf.set(relayId, relay);
    return added;
  }
}

type Frame =
  | { t: 'EV'; wave: string; epoch?: number; item: CrpItem }
  | { t: 'EOSE'; wave: string; rseq: number }
  | { t: 'RESYNC'; wave: string };

/** A relay that plays `frames` once subscribed, and serves HIST pages. */
class FakeRelay implements DropIndexConnection {
  readonly welcomeInfo: CrpWelcome;
  subscribed: {
    waves: string[];
    since: CrpCursor[];
    fromStart: boolean;
  } | null = null;
  closed = false;
  authed = 0;

  constructor(
    relayId: string,
    private readonly frames: Frame[],
    private readonly log: Record<string, CrpItem[]> = {},
    private readonly roles: string[] = []
  ) {
    this.welcomeInfo = { relayId, net: 'net-1', logEpoch: 1 };
  }

  subscribe(
    _sid: number,
    waves: string[],
    since: CrpCursor[],
    fromStart: boolean,
    handlers: CrpSubscriptionHandlers
  ) {
    this.subscribed = { waves, since, fromStart };
    for (const frame of this.frames) {
      if (frame.t === 'EV') {
        handlers.onEvent(frame.wave, frame.epoch ?? 1, frame.item);
      } else if (frame.t === 'EOSE') {
        handlers.onEose(frame.wave, frame.rseq);
      } else {
        handlers.onResync(frame.wave);
      }
    }
  }

  async history(
    wave: string,
    after: number | null,
    limit: number
  ): Promise<CrpHistoryPage> {
    const items = (this.log[wave] ?? []).filter(
      (item) => item.rseq > (after ?? 0)
    );
    return {
      logEpoch: 2,
      items: items.slice(0, limit),
      more: items.length > limit
    };
  }

  async authenticate(): Promise<CrpAuthed> {
    this.authed++;
    return { wallet: '0xaa', principal: null, roles: this.roles };
  }

  close() {
    this.closed = true;
  }
}

function item(rseq: number, event: Record<string, unknown>): CrpItem {
  return { rseq, event, grant: testGrantProof() };
}

function aSubscriber(
  store: FakeStore,
  relays: Record<string, FakeRelay>,
  {
    listeners = [],
    reader = false
  }: {
    listeners?: ((events: readonly IngestedEvent[]) => void)[];
    reader?: boolean;
  } = {}
) {
  let t = 0;
  const logs: string[] = [];
  const subscriber = new DropIndexSubscriber(
    store,
    async (relay) => {
      const fake = relays[relay];
      if (!fake) throw new Error(`no relay ${relay}`);
      return fake;
    },
    () => listeners,
    (message) => logs.push(message),
    reader ? () => ({ grant: { id: 'g' }, sig: '0x01' }) : null,
    () => t,
    async (ms) => {
      t += ms;
    }
  );
  return { subscriber, logs };
}

const RUN = { budgetMs: 10_000, quietMs: 1_000, flushMs: 250, pageSize: 2 };

describe('DropIndexSubscriber', () => {
  it('stores checked events once, in order, and moves each wave cursor', async () => {
    const store = new FakeStore();
    const post = testSignedEvent({ seq: 1 });
    const react = testSignedEvent({
      kind: DeviceEventKind.REACT,
      seq: 2,
      refs: ['drop-1'],
      body: { reaction: ':+1:' }
    });
    const other = testSignedEvent({ wave: 'wave-2', seq: 3 });
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, post) },
      { t: 'EV', wave: 'wave-1', item: item(2, react) },
      // The same event again (another wave's replay, a reconnect).
      { t: 'EV', wave: 'wave-1', item: item(2, react) },
      { t: 'EV', wave: 'wave-2', item: item(7, other) },
      { t: 'EOSE', wave: 'wave-1', rseq: 2 }
    ]);
    const heard: string[][] = [];
    const { subscriber } = aSubscriber(
      store,
      { 'wss://a.example': relay },
      { listeners: [(events) => heard.push(events.map((e) => e.event_id))] }
    );
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report).toMatchObject({
      relayId: 'r-1',
      received: 4,
      stored: 3,
      rejected: 0,
      error: null
    });
    expect(relay.subscribed).toEqual({
      waves: ['*'],
      since: [],
      fromStart: true
    });
    expect(relay.closed).toBe(true);
    expect(
      store.rows.map((r) => [r.event_id, r.kind, r.drop_id, r.origin])
    ).toEqual([
      [post.id, DeviceEventKind.POST, dropIdOfEvent(String(post.id)), 'relay'],
      [react.id, DeviceEventKind.REACT, 'drop-1', 'relay'],
      [other.id, DeviceEventKind.POST, dropIdOfEvent(String(other.id)), 'relay']
    ]);
    expect(Array.from(store.cursorsOf.get('r-1')!.values())).toEqual([
      { wave: 'wave-1', logEpoch: 1, rseq: 2 },
      { wave: 'wave-2', logEpoch: 1, rseq: 7 }
    ]);
    expect(heard.flat()).toEqual([post.id, react.id, other.id]);
  });

  it('resumes from its cursors and passes over what it holds', async () => {
    const store = new FakeStore();
    const post = testSignedEvent();
    store.cursorsOf.set(
      'r-1',
      new Map([['wave-1', { wave: 'wave-1', logEpoch: 1, rseq: 1 }]])
    );
    await store.ingest(
      [
        {
          event_id: String(post.id),
          relay_id: 'r-1',
          wave: 'wave-1',
          drop_id: null,
          kind: 1,
          author: 'a',
          device_key: 'k',
          auth_ref: 'g',
          seq: 1,
          claimed_time: 1,
          event: post,
          grant_proof: {},
          origin: 'relay',
          status: 'logged',
          status_reason: null,
          received_at: 0
        }
      ],
      'r-1',
      []
    );
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, post) }
    ]);
    const heard: unknown[] = [];
    const { subscriber } = aSubscriber(
      store,
      { 'wss://a.example': relay },
      { listeners: [(events) => heard.push(events)] }
    );
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(relay.subscribed?.since).toEqual([
      { wave: 'wave-1', logEpoch: 1, rseq: 1 }
    ]);
    expect(report).toMatchObject({ stored: 0, held: 1 });
    expect(heard).toEqual([]);
  });

  it('knows events written through 6529.io and the drops they wrote', async () => {
    const store = new FakeStore();
    const post = testSignedEvent();
    const pending = testSignedEvent({ seq: 2 });
    store.site.set(String(post.id), 'site-drop-1');
    store.site.set(String(pending.id), null);
    store.grants.set(TEST_GRANT_ID, testGrantEntity());
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, post) },
      { t: 'EV', wave: 'wave-1', item: item(2, pending) }
    ]);
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    await subscriber.run({ ...RUN, relays: ['wss://a.example'] });
    expect(
      store.rows.map((r) => [r.drop_id, r.origin, r.status_reason])
    ).toEqual([
      ['site-drop-1', 'site', null],
      [null, 'site', null]
    ]);
  });

  it('counts events that fail a check, stores none of them, and moves past them', async () => {
    const store = new FakeStore();
    const good = testSignedEvent({ seq: 1 });
    const forged = { ...testSignedEvent({ seq: 2 }), seq: 3 };
    const elsewhere = testSignedEvent({ wave: 'wave-9', seq: 4 });
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, good) },
      { t: 'EV', wave: 'wave-1', item: item(2, forged) },
      { t: 'EV', wave: 'wave-1', item: item(3, elsewhere) }
    ]);
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report).toMatchObject({
      stored: 1,
      rejected: 2,
      reasons: { 'event id does not match': 1, 'event of another wave': 1 }
    });
    expect(store.cursorsOf.get('r-1')!.get('wave-1')).toEqual({
      wave: 'wave-1',
      logEpoch: 1,
      rseq: 3
    });
  });

  it('pages a wave the relay can no longer replay from its start', async () => {
    const store = new FakeStore();
    const events = [1, 2, 3].map((seq) => testSignedEvent({ seq }));
    const relay = new FakeRelay('r-1', [{ t: 'RESYNC', wave: 'wave-1' }], {
      'wave-1': events.map((e, i) => item(i + 1, e))
    });
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report).toMatchObject({ resyncs: 1, stored: 3 });
    expect(store.cursorsOf.get('r-1')!.get('wave-1')).toEqual({
      wave: 'wave-1',
      logEpoch: 2,
      rseq: 3
    });
  });

  it('reads members-only waves as a site reader when it has the key', async () => {
    const store = new FakeStore();
    const relay = new FakeRelay('r-1', [], {}, ['site-reader']);
    const { subscriber } = aSubscriber(
      store,
      { 'wss://a.example': relay },
      { reader: true }
    );
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(relay.authed).toBe(1);
    expect(report.readsMembersOnly).toBe(true);
  });

  it('reports a relay it could not read and goes on to the next', async () => {
    const store = new FakeStore();
    const relay = new FakeRelay('r-2', [
      { t: 'EV', wave: 'wave-1', item: item(1, testSignedEvent()) }
    ]);
    const { subscriber, logs } = aSubscriber(store, {
      'wss://b.example': relay
    });
    const reports = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example', 'wss://b.example']
    });
    expect(reports.map((r) => [r.relay, r.error, r.stored])).toEqual([
      ['wss://a.example', 'no relay wss://a.example', 0],
      ['wss://b.example', null, 1]
    ]);
    expect(logs).toEqual([
      '[DROP INDEX] wss://a.example: no relay wss://a.example'
    ]);
  });

  it('keeps cursors where they were when storing fails, and listeners never break a run', async () => {
    const store = new FakeStore();
    store.failIngest = true;
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, testSignedEvent()) }
    ]);
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report.error).toBe('database down');
    expect(store.cursorsOf.size).toBe(0);
    expect(relay.closed).toBe(true);

    const ok = new FakeStore();
    const { subscriber: again, logs } = aSubscriber(
      ok,
      {
        'wss://a.example': new FakeRelay('r-1', [
          { t: 'EV', wave: 'wave-1', item: item(1, testSignedEvent()) }
        ])
      },
      {
        listeners: [
          () => {
            throw new Error('listener broke');
          }
        ]
      }
    );
    const [fine] = await again.run({ ...RUN, relays: ['wss://a.example'] });
    expect(fine).toMatchObject({ stored: 1, error: null });
    expect(logs).toEqual([
      '[DROP INDEX LISTENER FAILED] Error: listener broke'
    ]);
  });

  it("names a relay-only post's drop after its event id", () => {
    expect(dropIdOfEvent(`0x${'0123456789ABCDEF'.repeat(4)}`)).toBe(
      '01234567-89ab-cdef-0123-456789abcdef'
    );
  });
});
