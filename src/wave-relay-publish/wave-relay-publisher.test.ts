import { CrpAck } from './crp-client';
import {
  isRetryableRejection,
  PublishableEvent,
  RelayConnection,
  RelayCursor,
  START_CURSOR,
  WaveRelayPublisher,
  WaveRelayPublisherOptions
} from './wave-relay-publisher';

function event(n: number, grant = 'g-1'): PublishableEvent {
  return {
    id: `0x${String(n).padStart(64, '0')}`,
    created_at: 1_000 + n,
    auth_ref: grant,
    kind: 1,
    body: `{"n":${n}}`
  };
}

class FakeEvents {
  readonly beforeAsked: number[] = [];
  constructor(
    readonly events: PublishableEvent[],
    readonly grantIds = new Set(['g-1', 'g-2'])
  ) {}

  async eventsAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number
  ) {
    this.beforeAsked.push(before);
    return this.events
      .filter(
        (e) =>
          e.created_at < before &&
          (e.created_at > cursor.createdAt ||
            (e.created_at === cursor.createdAt && e.id > cursor.eventId))
      )
      .slice(0, limit);
  }

  async grants(ids: string[]) {
    return new Map(
      ids
        .filter((id) => this.grantIds.has(id))
        .map((id) => [id, { id, wallet: '0x01' }] as [string, unknown])
    );
  }
}

class FakeCursors {
  readonly saved: Record<string, RelayCursor> = {};
  async load(relay: string) {
    return this.saved[relay] ?? START_CURSOR;
  }
  async save(relay: string, cursor: RelayCursor) {
    this.saved[relay] = cursor;
  }
}

class FakeRelay implements RelayConnection {
  readonly received: unknown[] = [];
  closed = false;
  constructor(private readonly answer: (event: any) => CrpAck | Error) {}
  async publish(event: any): Promise<CrpAck> {
    this.received.push(event);
    const answer = this.answer(event);
    if (answer instanceof Error) throw answer;
    return answer;
  }
  close() {
    this.closed = true;
  }
}

const accept = (event: any): CrpAck => ({
  eventId: event.id,
  status: 'accepted',
  reason: null
});

const OPTIONS: WaveRelayPublisherOptions = {
  relays: ['wss://a.example'],
  budgetMs: 60_000,
  batchSize: 2,
  graceMs: 60_000,
  window: 2,
  minIntervalMs: 0
};

function publisher(
  events: FakeEvents,
  cursors: FakeCursors,
  relays: Record<string, FakeRelay | Error>,
  now = () => 1_000_000
) {
  const log: string[] = [];
  const instance = new WaveRelayPublisher(
    events,
    cursors,
    async (relay) => {
      const connection = relays[relay];
      if (connection instanceof Error) throw connection;
      return connection;
    },
    (message) => log.push(message),
    now,
    async () => undefined
  );
  return { instance, log };
}

describe('WaveRelayPublisher', () => {
  it('publishes every event in order, without created_at, and moves the cursor', async () => {
    const events = new FakeEvents([event(1), event(2), event(3)]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toEqual({
      relay: 'wss://a.example',
      published: 3,
      duplicates: 0,
      rejected: 0,
      stoppedBy: null
    });
    expect(relay.received.map((e: any) => e.id)).toEqual(
      [1, 2, 3].map((n) => event(n).id)
    );
    expect(relay.received[0]).not.toHaveProperty('created_at');
    expect(cursors.saved['wss://a.example']).toEqual({
      createdAt: 1_003,
      eventId: event(3).id,
      published: 3,
      rejected: 0,
      lastError: null
    });
    expect(relay.closed).toBe(true);
    // Only events past the grace period.
    expect(events.beforeAsked[0]).toBe(1_000_000 - 60_000);
  });

  it('counts a duplicate as published and a lasting refusal as settled', async () => {
    const events = new FakeEvents([event(1), event(2), event(3, 'g-9')]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay((e) =>
      e.id === event(1).id
        ? { eventId: e.id, status: 'duplicate', reason: null }
        : { eventId: e.id, status: 'rejected', reason: 'not in the post group' }
    );
    const { instance, log } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({ published: 0, duplicates: 1, rejected: 2 });
    // The event whose grant is not stored is never sent.
    expect(relay.received).toHaveLength(2);
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(3).id,
      published: 1,
      rejected: 2
    });
    expect(log.some((line) => line.includes('no grant proof stored'))).toBe(
      true
    );
  });

  it('stops at a rate limit and keeps that event for the next run', async () => {
    const events = new FakeEvents([event(1), event(2), event(3), event(4)]);
    const cursors = new FakeCursors();
    let limited = true;
    const relay = new FakeRelay((e) =>
      e.id === event(3).id && limited
        ? { eventId: e.id, status: 'rejected', reason: 'publish rate limit' }
        : accept(e)
    );
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [first] = await instance.publishPending(OPTIONS);
    expect(first).toMatchObject({
      published: 2,
      stoppedBy: 'publish rate limit'
    });
    expect(cursors.saved['wss://a.example'].eventId).toBe(event(2).id);
    limited = false;
    const [second] = await instance.publishPending(OPTIONS);
    expect(second).toMatchObject({ published: 2, stoppedBy: null });
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(4).id,
      published: 4
    });
  });

  it('keeps the cursor before an event whose publish failed', async () => {
    const events = new FakeEvents([event(1), event(2), event(3)]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay((e) =>
      e.id === event(2).id ? new Error('connection lost') : accept(e)
    );
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({
      published: 1,
      stoppedBy: 'connection lost'
    });
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(1).id,
      lastError: 'connection lost'
    });
  });

  it('keeps each relay on its own cursor; one down does not stop another', async () => {
    const events = new FakeEvents([event(1), event(2)]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay,
      'wss://b.example': new Error('refused')
    });
    const results = await instance.publishPending({
      ...OPTIONS,
      relays: ['wss://a.example', 'wss://b.example']
    });
    expect(results.map((r) => [r.relay, r.published, r.stoppedBy])).toEqual([
      ['wss://a.example', 2, null],
      ['wss://b.example', 0, 'refused']
    ]);
    expect(cursors.saved['wss://b.example']).toMatchObject({
      createdAt: 0,
      eventId: '',
      lastError: 'refused'
    });
  });

  it('opens no connection when there is nothing to publish', async () => {
    const { instance } = publisher(new FakeEvents([]), new FakeCursors(), {
      'wss://a.example': new Error('must not connect')
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({ published: 0, stoppedBy: null });
  });

  it('starts no new batch once the budget is spent', async () => {
    let clock = 1_000_000;
    const events = new FakeEvents([1, 2, 3, 4, 5, 6].map((n) => event(n)));
    const cursors = new FakeCursors();
    const relay = new FakeRelay((e) => {
      clock += 400;
      return accept(e);
    });
    const { instance } = publisher(
      events,
      cursors,
      { 'wss://a.example': relay },
      () => clock
    );
    const [result] = await instance.publishPending({
      ...OPTIONS,
      budgetMs: 1_000
    });
    expect(result.published).toBeLessThan(6);
    expect(cursors.saved['wss://a.example'].published).toBe(result.published);
  });

  it.each([
    ['publish rate limit', true],
    ["the grant's publish rate limit", true],
    ['not in the post group', false],
    [null, false]
  ])('reads %p as retryable: %p', (reason, retryable) => {
    expect(isRetryableRejection(reason)).toBe(retryable);
  });
});
