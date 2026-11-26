import { CrpAck } from './crp-client';
import {
  CandidateEvent,
  EVENT_KIND,
  eventBytes,
  isRetryableRejection,
  MAX_EVENT_BYTES,
  publishDecision,
  PublishableEvent,
  RelayConnection,
  RelayCursor,
  START_CURSOR,
  WaveRelayPublisher,
  WaveRelayPublisherOptions
} from './wave-relay-publisher';

const NOW = 1_000_000;

function event(
  n: number,
  { grant = 'g-1', kind = EVENT_KIND.POST as number, body = `{"n":${n}}` } = {}
): PublishableEvent {
  return {
    id: `0x${String(n).padStart(64, '0')}`,
    created_at: 1_000 + n,
    auth_ref: grant,
    kind,
    body
  };
}

function candidate(
  e: PublishableEvent,
  facts: Partial<Omit<CandidateEvent, 'event'>> = {}
): CandidateEvent {
  return {
    event: e,
    finalized: true,
    dropVisible: true,
    dropSigned: true,
    ...facts
  };
}

class FakeEvents {
  readonly beforeAsked: number[] = [];
  constructor(
    readonly candidates: CandidateEvent[],
    readonly grantIds = new Set(['g-1', 'g-2'])
  ) {}

  async candidatesAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number
  ) {
    this.beforeAsked.push(before);
    return this.candidates
      .filter(
        ({ event: e }) =>
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
  readonly received: any[] = [];
  closed = false;
  constructor(private readonly answer: (event: any) => CrpAck | Error) {}
  async publish(e: any): Promise<CrpAck> {
    this.received.push(e);
    const answer = this.answer(e);
    if (answer instanceof Error) throw answer;
    return answer;
  }
  close() {
    this.closed = true;
  }
}

const accept = (e: any): CrpAck => ({
  eventId: e.id,
  status: 'accepted',
  reason: null
});

const OPTIONS: WaveRelayPublisherOptions = {
  relays: ['wss://a.example'],
  budgetMs: 60_000,
  batchSize: 3,
  graceMs: 60_000,
  // The test events are older than any real cutoff: never abandoned here.
  abandonAfterMs: 10_000_000,
  window: 2,
  minIntervalMs: 0,
  grantRate: 1_000,
  grantBurst: 1_000,
  maxPerRelayRun: 1_000,
  maxStuckRuns: 3
};

function publisher(
  events: FakeEvents,
  cursors: FakeCursors,
  relays: Record<string, FakeRelay | Error>,
  clock: { now: number } = { now: NOW }
) {
  const log: string[] = [];
  const slept: number[] = [];
  const instance = new WaveRelayPublisher(
    events,
    cursors,
    async (relay) => {
      const connection = relays[relay];
      if (connection instanceof Error) throw connection;
      return connection;
    },
    (message) => log.push(message),
    () => clock.now,
    async (ms) => {
      slept.push(ms);
      clock.now += ms;
    }
  );
  return { instance, log, slept };
}

describe('publishDecision', () => {
  const at = (n: number) => event(n);
  it.each([
    ['a post of a visible, signed drop', candidate(at(1)), 'publish'],
    [
      'a post of a drop edited unsigned since',
      candidate(at(1), { dropSigned: false }),
      'skip'
    ],
    [
      'a post of a deleted or hidden drop',
      candidate(at(1), { dropVisible: false }),
      'skip'
    ],
    [
      'an edit of a visible, signed drop',
      candidate(event(1, { kind: EVENT_KIND.EDIT })),
      'publish'
    ],
    [
      'a reaction to a visible drop, signed or not',
      candidate(event(1, { kind: EVENT_KIND.REACT }), { dropSigned: false }),
      'publish'
    ],
    [
      'a reaction to a deleted drop',
      candidate(event(1, { kind: EVENT_KIND.REACT }), { dropVisible: false }),
      'skip'
    ],
    [
      'a delete, of a drop gone or not',
      candidate(event(1, { kind: EVENT_KIND.TOMBSTONE }), {
        dropVisible: false,
        dropSigned: false
      }),
      'publish'
    ],
    ['an unknown kind', candidate(event(1, { kind: 9 })), 'skip'],
    ['a write still in flight', candidate(at(1), { finalized: false }), 'wait']
  ])('%s: %s', (_, c, decision) => {
    expect(publishDecision(c, 1_002, 900_000)).toBe(decision);
  });

  it('passes over a write abandoned long ago', () => {
    expect(
      publishDecision(candidate(at(1), { finalized: false }), 901_001, 900_000)
    ).toBe('skip');
  });
});

describe('WaveRelayPublisher', () => {
  it('publishes in order, without created_at, and moves the cursor', async () => {
    const events = new FakeEvents([1, 2, 3, 4].map((n) => candidate(event(n))));
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toEqual({
      relay: 'wss://a.example',
      published: 4,
      duplicates: 0,
      rejected: 0,
      skipped: 0,
      stoppedBy: null
    });
    expect(relay.received.map((e) => e.id)).toEqual(
      [1, 2, 3, 4].map((n) => event(n).id)
    );
    expect(relay.received[0]).not.toHaveProperty('created_at');
    expect(cursors.saved['wss://a.example']).toEqual({
      ...START_CURSOR,
      createdAt: 1_004,
      eventId: event(4).id,
      published: 4
    });
    expect(relay.closed).toBe(true);
    expect(events.beforeAsked[0]).toBe(NOW - 60_000);
  });

  it('passes over what 6529.io does not show and settles every answer', async () => {
    const events = new FakeEvents([
      candidate(event(1), { dropSigned: false }),
      candidate(event(2)),
      candidate(event(3, { grant: 'g-9' })),
      candidate(event(4, { kind: EVENT_KIND.REACT }), { dropVisible: false }),
      candidate(event(5))
    ]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay((e) =>
      e.id === event(2).id
        ? { eventId: e.id, status: 'duplicate', reason: null }
        : {
            eventId: e.id,
            status: 'rejected',
            reason: 'rights: author 0x01 may not post in this wave'
          }
    );
    const { instance, log } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({
      published: 0,
      duplicates: 1,
      rejected: 2,
      skipped: 2,
      stoppedBy: null
    });
    expect(relay.received.map((e) => e.id)).toEqual([event(2).id, event(5).id]);
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(5).id,
      published: 1,
      rejected: 2,
      skipped: 2
    });
    expect(log.some((line) => line.includes('no grant proof stored'))).toBe(
      true
    );
  });

  it('holds the cursor at a write still in flight', async () => {
    const events = new FakeEvents([
      candidate(event(1)),
      candidate(event(2), { finalized: false }),
      candidate(event(3))
    ]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({ published: 1, stoppedBy: null });
    expect(cursors.saved['wss://a.example'].eventId).toBe(event(1).id);
    // Once it finished, the next run sends it and what came after.
    events.candidates[1] = candidate(event(2));
    const [next] = await instance.publishPending(OPTIONS);
    expect(next).toMatchObject({ published: 2 });
    expect(relay.received.map((e) => e.id)).toEqual(
      [1, 2, 3].map((n) => event(n).id)
    );
  });

  it('passes over an event too large for a relay', async () => {
    const big = event(1, { body: 'x'.repeat(MAX_EVENT_BYTES) });
    expect(eventBytes(big, {})).toBeGreaterThan(MAX_EVENT_BYTES);
    const events = new FakeEvents([candidate(big), candidate(event(2))]);
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance, log } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({ published: 1, rejected: 1 });
    expect(relay.received.map((e) => e.id)).toEqual([event(2).id]);
    expect(log.some((line) => line.includes('too large'))).toBe(true);
  });

  it.each([
    'publish rate limit',
    "the grant's publish rate limit",
    'rights: the chain could not be read (timeout)',
    'store: disk full'
  ])('stops at %p and sends that event again next run', async (reason) => {
    const events = new FakeEvents([1, 2, 3, 4].map((n) => candidate(event(n))));
    const cursors = new FakeCursors();
    let refusing = true;
    const relay = new FakeRelay((e) =>
      e.id === event(3).id && refusing
        ? { eventId: e.id, status: 'rejected', reason }
        : accept(e)
    );
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [first] = await instance.publishPending(OPTIONS);
    expect(first).toMatchObject({ published: 2, stoppedBy: reason });
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(2).id,
      lastError: reason,
      // "Not now" counts nothing toward passing the event over.
      stuckEventId: null,
      stuckCount: 0
    });
    refusing = false;
    const [second] = await instance.publishPending(OPTIONS);
    expect(second).toMatchObject({ published: 2, stoppedBy: null });
    expect(cursors.saved['wss://a.example']).toMatchObject({
      eventId: event(4).id,
      published: 4,
      lastError: null,
      stuckEventId: null,
      stuckCount: 0
    });
  });

  it.each([
    'no such wave',
    'publish rate limit',
    'rights: the chain could not be read (timeout)'
  ])(
    'never passes over an event a relay answers %p for 30 runs; all arrive once it takes them',
    async (reason) => {
      const events = new FakeEvents(
        [1, 2, 3, 4, 5].map((n) => candidate(event(n)))
      );
      const cursors = new FakeCursors();
      let refusing = true;
      const relay = new FakeRelay((e) =>
        refusing ? { eventId: e.id, status: 'rejected', reason } : accept(e)
      );
      const { instance, log } = publisher(events, cursors, {
        'wss://a.example': relay
      });
      for (let run = 1; run <= 30; run++) {
        const [result] = await instance.publishPending(OPTIONS);
        expect(result).toMatchObject({
          published: 0,
          rejected: 0,
          stoppedBy: reason
        });
      }
      expect(cursors.saved['wss://a.example']).toMatchObject({
        ...START_CURSOR,
        lastError: reason
      });
      refusing = false;
      relay.received.length = 0;
      const [last] = await instance.publishPending(OPTIONS);
      expect(last).toMatchObject({
        published: 5,
        rejected: 0,
        stoppedBy: null
      });
      expect(relay.received.map((e) => e.id)).toEqual(
        [1, 2, 3, 4, 5].map((n) => event(n).id)
      );
      expect(cursors.saved['wss://a.example']).toMatchObject({
        eventId: event(5).id,
        published: 5,
        rejected: 0,
        lastError: null,
        stuckCount: 0
      });
      expect(log.some((line) => line.includes('PASSED OVER'))).toBe(false);
    }
  );

  it('counts failures, not "not now" refusals, toward passing an event over', async () => {
    const events = new FakeEvents([1, 2].map((n) => candidate(event(n))));
    const cursors = new FakeCursors();
    let run = 0;
    // Runs 1-2 fail at event 1, runs 3-6 are told "not now", runs 7 on fail.
    const relay = new FakeRelay((e) =>
      e.id !== event(1).id
        ? accept(e)
        : run >= 3 && run <= 6
          ? { eventId: e.id, status: 'rejected', reason: 'no such wave' }
          : new Error('no ACK for rid 1')
    );
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const counts: number[] = [];
    for (run = 1; run <= 7; run++) {
      await instance.publishPending(OPTIONS);
      counts.push(cursors.saved['wss://a.example'].stuckCount);
    }
    expect(counts).toEqual([1, 2, 2, 2, 2, 2, 3]);
    // The next run passes it over (maxStuckRuns 3) and sends what follows.
    const [last] = await instance.publishPending(OPTIONS);
    expect(last).toMatchObject({ published: 1, rejected: 1, stoppedBy: null });
  });

  it('passes over an event runs keep stopping at', async () => {
    const events = new FakeEvents([1, 2].map((n) => candidate(event(n))));
    const cursors = new FakeCursors();
    const relay = new FakeRelay((e) =>
      e.id === event(1).id ? new Error('no ACK for rid 1') : accept(e)
    );
    const { instance, log } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    for (let run = 1; run <= OPTIONS.maxStuckRuns; run++) {
      const [result] = await instance.publishPending(OPTIONS);
      expect(result.stoppedBy).toBe('no ACK for rid 1');
      expect(cursors.saved['wss://a.example'].stuckCount).toBe(run);
    }
    const [last] = await instance.publishPending(OPTIONS);
    expect(last).toMatchObject({ published: 1, rejected: 1, stoppedBy: null });
    expect(log.some((line) => line.includes('runs in a row'))).toBe(true);
  });

  it('keeps each relay on its own cursor; one down does not stop another', async () => {
    const events = new FakeEvents([1, 2].map((n) => candidate(event(n))));
    const cursors = new FakeCursors();
    const { instance } = publisher(events, cursors, {
      'wss://a.example': new FakeRelay(accept),
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
      lastError: 'refused',
      // A relay that is down is no event's fault.
      stuckEventId: null,
      stuckCount: 0
    });
  });

  it('opens no connection when there is nothing to send', async () => {
    const events = new FakeEvents([
      candidate(event(1), { dropVisible: false })
    ]);
    const cursors = new FakeCursors();
    const { instance } = publisher(events, cursors, {
      'wss://a.example': new Error('must not connect')
    });
    const [result] = await instance.publishPending(OPTIONS);
    expect(result).toMatchObject({ skipped: 1, stoppedBy: null });
    expect(cursors.saved['wss://a.example'].eventId).toBe(event(1).id);
  });

  it("paces one grant under a relay's limit", async () => {
    const events = new FakeEvents(
      [1, 2, 3, 4, 5].map((n) => candidate(event(n)))
    );
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const clock = { now: NOW };
    const { instance, slept } = publisher(
      events,
      cursors,
      { 'wss://a.example': relay },
      clock
    );
    const [result] = await instance.publishPending({
      ...OPTIONS,
      grantRate: 2,
      grantBurst: 2
    });
    expect(result.published).toBe(5);
    // Two at once, then one each half second.
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_500);
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it('sends a relay at most maxPerRelayRun events a run, then goes on from its cursor', async () => {
    const events = new FakeEvents(
      [1, 2, 3, 4, 5, 6, 7].map((n) => candidate(event(n)))
    );
    const cursors = new FakeCursors();
    const a = new FakeRelay(accept);
    const b = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': a,
      'wss://b.example': b
    });
    const options = {
      ...OPTIONS,
      relays: ['wss://a.example', 'wss://b.example'],
      maxPerRelayRun: 4
    };
    const first = await instance.publishPending(options);
    // Both relays get their share of the backlog in the same run.
    expect(first.map((r) => r.published)).toEqual([4, 4]);
    expect(cursors.saved['wss://a.example'].eventId).toBe(event(4).id);
    const second = await instance.publishPending(options);
    expect(second.map((r) => r.published)).toEqual([3, 3]);
    expect(a.received.map((e) => e.id)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => event(n).id)
    );
    expect(b.received).toEqual(a.received);
  });

  it("gives each relay an equal share of the run's time, so a backlog on one can't starve the next", async () => {
    const events = new FakeEvents(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => candidate(event(n)))
    );
    const cursors = new FakeCursors();
    const { instance } = publisher(events, cursors, {
      'wss://a.example': new FakeRelay(accept),
      'wss://b.example': new FakeRelay(accept)
    });
    // One a second for the grant, four seconds of run. The first relay has
    // half of it (sends at 0 and 1 s); the second has what is left (1, 2
    // and 3 s). With the whole run for the first, it was 4 and 1.
    const results = await instance.publishPending({
      ...OPTIONS,
      relays: ['wss://a.example', 'wss://b.example'],
      budgetMs: 4_000,
      grantRate: 1,
      grantBurst: 1
    });
    expect(results.map((r) => r.published)).toEqual([2, 3]);
  });

  it('starts nothing that would be sent after the budget', async () => {
    const events = new FakeEvents(
      [1, 2, 3, 4, 5, 6].map((n) => candidate(event(n)))
    );
    const cursors = new FakeCursors();
    const relay = new FakeRelay(accept);
    const { instance } = publisher(events, cursors, {
      'wss://a.example': relay
    });
    const [result] = await instance.publishPending({
      ...OPTIONS,
      budgetMs: 1_000,
      grantRate: 1,
      grantBurst: 2
    });
    expect(result.published).toBe(2);
    expect(cursors.saved['wss://a.example'].published).toBe(2);
  });

  it.each([
    ['publish rate limit', true],
    ["the grant's publish rate limit", true],
    ['rights: the chain could not be read (x)', true],
    ['anchor: the chain could not be read (x)', true],
    ['rights: no such wave on the chain', true],
    ['store: io error', true],
    ['rights: author 0x01 may not post in this wave', false],
    ['bad signature', false],
    [null, false]
  ])('reads %p as retryable: %p', (reason, retryable) => {
    expect(isRetryableRejection(reason)).toBe(retryable);
  });
});
