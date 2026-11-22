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
  dropIdOfEvent,
  MAX_SINCE
} from './drop-index.subscriber';
import { relayWaveKey } from './relay-wave-key';

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

type Frame = (
  | { t: 'EV'; wave: string; epoch?: number; item: CrpItem }
  | { t: 'EOSE'; wave: string; rseq: number }
  | { t: 'RESYNC'; wave: string }
) & { sid?: number };

/**
 * A relay that plays `frames` to the subscription they name (sid 1, the
 * `*` one, by default) when it is made, and serves HIST pages.
 */
class FakeRelay implements DropIndexConnection {
  readonly welcomeInfo: CrpWelcome;
  readonly subs: {
    sid: number;
    waves: string[];
    since: CrpCursor[];
    fromStart: boolean;
  }[] = [];
  readonly asked: (number | null)[] = [];
  closed = false;
  authed = 0;
  authFails = false;

  constructor(
    relayId: string,
    private readonly frames: Frame[],
    private readonly log: Record<string, CrpItem[]> = {},
    private readonly roles: string[] = [],
    private readonly histEpoch = 2,
    logEpoch = 1
  ) {
    this.welcomeInfo = { relayId, net: 'net-1', logEpoch };
  }

  get subscribed() {
    const first = this.subs[0];
    return first
      ? { waves: first.waves, since: first.since, fromStart: first.fromStart }
      : null;
  }

  subscribe(
    sid: number,
    waves: string[],
    since: CrpCursor[],
    fromStart: boolean,
    handlers: CrpSubscriptionHandlers
  ) {
    this.subs.push({ sid, waves, since, fromStart });
    for (const frame of this.frames.filter((f) => (f.sid ?? 1) === sid)) {
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
    this.asked.push(after);
    const items = (this.log[wave] ?? []).filter(
      (item) => item.rseq > (after ?? 0)
    );
    return {
      logEpoch: this.histEpoch,
      items: items.slice(0, limit),
      more: items.length > limit
    };
  }

  async authenticate(): Promise<CrpAuthed> {
    this.authed++;
    if (this.authFails) throw new Error('grant expired');
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
          wave_key: null,
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
          grant_check: 'signature',
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

  it('keeps events that fail a check as rejected, hands none to listeners, and moves past them', async () => {
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
    // Kept with why, for a later check; readers never get them.
    expect(store.rows.map((r) => [r.status, r.status_reason])).toEqual([
      ['logged', null],
      ['rejected', 'event id does not match'],
      ['rejected', 'event of another wave']
    ]);
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

  it("takes the relay's key for a 6529.io wave under the every-wave subscription", async () => {
    const store = new FakeStore();
    const uuid = '8fe93d73-c2b4-4160-8417-dbe9d5cce669';
    const key = relayWaveKey(uuid) as string;
    const post = testSignedEvent({ wave: uuid });
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: key, item: item(4, post) }
    ]);
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report).toMatchObject({ stored: 1, rejected: 0 });
    expect(store.rows[0]).toMatchObject({ wave: uuid, wave_key: key });
    expect(store.cursorsOf.get('r-1')!.get(key)).toEqual({
      wave: key,
      logEpoch: 1,
      rseq: 4
    });
  });

  it('pages a resynced wave from its cursor in the same epoch, and holds its live events', async () => {
    const store = new FakeStore();
    store.cursorsOf.set(
      'r-1',
      new Map([['wave-1', { wave: 'wave-1', logEpoch: 1, rseq: 2 }]])
    );
    const events = [1, 2, 3, 4].map((seq) => testSignedEvent({ seq }));
    const later = testSignedEvent({ seq: 9 });
    const relay = new FakeRelay(
      'r-1',
      [
        { t: 'RESYNC', wave: 'wave-1' },
        // Live, while the wave waits for its pages: left for the next run.
        { t: 'EV', wave: 'wave-1', item: item(9, later) }
      ],
      { 'wave-1': events.map((e, i) => item(i + 1, e)) },
      [],
      1
    );
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(relay.asked).toEqual([2]);
    expect(report.stored).toBe(2);
    expect(store.rows.map((r) => r.event_id)).toEqual([
      events[2].id,
      events[3].id
    ]);
    expect(store.cursorsOf.get('r-1')!.get('wave-1')).toEqual({
      wave: 'wave-1',
      logEpoch: 1,
      rseq: 4
    });
  });

  it('subscribes to many known waves in parts, and pages a wave first seen live from its start', async () => {
    const store = new FakeStore();
    const many = new Map<string, CrpCursor>();
    for (let n = 0; n < MAX_SINCE + 1; n++) {
      const wave = `wave-${String(n).padStart(4, '0')}`;
      many.set(wave, { wave, logEpoch: 1, rseq: 1 });
    }
    store.cursorsOf.set('r-1', many);
    const fresh = testSignedEvent({ wave: 'wave-new', seq: 1 });
    const known = testSignedEvent({ wave: 'wave-0000', seq: 2 });
    const relay = new FakeRelay(
      'r-1',
      [
        { t: 'EV', wave: 'wave-new', item: item(5, fresh) },
        { t: 'EV', wave: 'wave-0000', item: item(2, known), sid: 2 }
      ],
      { 'wave-new': [item(1, fresh)] }
    );
    const { subscriber } = aSubscriber(store, { 'wss://a.example': relay });
    await subscriber.run({ ...RUN, relays: ['wss://a.example'] });
    expect(
      relay.subs.map((sub) => [sub.sid, sub.waves.length, sub.fromStart])
    ).toEqual([
      [2, MAX_SINCE, false],
      [3, 1, false],
      [1, 1, false]
    ]);
    expect(relay.subs[2].waves).toEqual(['*']);
    expect(relay.asked).toEqual([0]);
    expect(store.rows.map((r) => r.event_id).sort()).toEqual(
      [String(fresh.id), String(known.id)].sort()
    );
  });

  it('reads open waves when its AUTH fails', async () => {
    const store = new FakeStore();
    const relay = new FakeRelay('r-1', [
      { t: 'EV', wave: 'wave-1', item: item(1, testSignedEvent()) }
    ]);
    relay.authFails = true;
    const { subscriber } = aSubscriber(
      store,
      { 'wss://a.example': relay },
      { reader: true }
    );
    const [report] = await subscriber.run({
      ...RUN,
      relays: ['wss://a.example']
    });
    expect(report).toMatchObject({
      authError: 'grant expired',
      readsMembersOnly: false,
      stored: 1,
      error: null
    });
  });
});
