import { DeviceEventKind } from '@/api/device-signing/device-event';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import {
  TEST_GRANT_ID,
  TEST_WALLET,
  testGrantProof,
  testSignedEvent
} from '@/tests/fixtures/relay-events.fixture';
import { IngestedEvent } from './drop-index.db';
import { dropIdOfEvent } from './drop-index.subscriber';
import {
  MAX_APPLY_ATTEMPTS,
  POST_WAIT_MS,
  WAIT_RETRY_MS,
  RelayApplyStore,
  RelayDropApplier,
  RelayDropWrites,
  recordsWaveIdOf,
  STAYS_ON_SITE_REASON,
  WaveOnChain
} from './relay-drop-applier';

let nextSeq = 1;

function anEvent(
  kind: DeviceEventKind,
  body: unknown,
  refs: string[] = [],
  overrides: Partial<IngestedEvent> = {}
): IngestedEvent {
  const event = testSignedEvent({
    kind,
    body,
    refs,
    seq: nextSeq,
    wave: 'wave-1'
  });
  return {
    ingest_seq: nextSeq++,
    event_id: String(event.id),
    relay_id: 'r-1',
    wave: 'wave-1',
    wave_key: null,
    drop_id: refs[0] ?? null,
    kind,
    author: TEST_WALLET,
    device_key: String(event.device_key),
    auth_ref: TEST_GRANT_ID,
    seq: Number(event.seq),
    claimed_time: Number(event.claimed_time),
    event,
    grant_proof: testGrantProof(),
    origin: 'relay',
    event_origin: 'OPERATION',
    status: 'logged',
    status_reason: null,
    grant_check: 'signature',
    grant_revoked_at: null,
    received_at: Number(event.claimed_time) + 1000,
    apply_attempts: 0,
    ...overrides
  };
}

class FakeStore implements RelayApplyStore {
  readonly marks: [number, string, string | null, string | null][] = [];
  readonly released: string[] = [];
  // `${dropId} ${author}`
  tombstones = new Set<string>();
  reservations = new Set<string>();
  // Whether the chain holds each wave; a wave not listed has moved.
  onChain = new Map<string, WaveOnChain>();
  readonly wavesAsked: string[] = [];
  constructor(private readonly events: IngestedEvent[]) {}

  async waveOnChain(wave: string) {
    this.wavesAsked.push(wave);
    return this.onChain.get(wave) ?? 'moved';
  }

  async hasTombstone(dropId: string, author: string) {
    return this.tombstones.has(`${dropId} ${author.toLowerCase()}`);
  }

  async hasPendingReservation(eventId: string) {
    return this.reservations.has(eventId);
  }

  async releaseStaleReservation(eventId: string) {
    this.released.push(eventId);
  }

  readonly asked: number[] = [];
  readonly waits: [number, number | null][] = [];

  async pendingRelayEvents(limit: number, now: number) {
    this.asked.push(now);
    return this.events.slice(0, limit);
  }

  async markApplied(
    ingestSeq: number,
    status: string,
    reason: string | null,
    dropId: string | null,
    nextTryAt: number | null = null
  ) {
    this.marks.push([ingestSeq, status, reason, dropId]);
    if (status === 'waiting') this.waits.push([ingestSeq, nextTryAt]);
  }
}

function aWrites(overrides: Partial<RelayDropWrites> = {}) {
  const calls: unknown[][] = [];
  const writes: RelayDropWrites = {
    profileIdOfWallet: async () => 'profile-1',
    ensureGrant: async (grant) => {
      calls.push(['grant', grant.id]);
    },
    createDrop: async (input, dropId, request) => {
      calls.push([
        'create',
        input.profileId,
        input.envelope,
        request.wave_id,
        dropId
      ]);
      return dropId;
    },
    updateDrop: async (_input, dropId, request) => {
      calls.push(['update', dropId, request]);
    },
    deleteDrop: async (_input, dropId) => {
      calls.push(['delete', dropId]);
    },
    react: async (_input, dropId, reaction) => {
      calls.push(['react', dropId, reaction]);
    },
    ...overrides
  };
  return { writes, calls };
}

const RUN = { limit: 100, deadline: Number.MAX_SAFE_INTEGER };
const POST = {
  wave_id: 'wave-1',
  drop_type: 'CHAT',
  parts: [{ content: 'gm', media: [] }]
};

describe('RelayDropApplier', () => {
  it("writes each kind as the author, with the event's own signature", async () => {
    const post = anEvent(DeviceEventKind.POST, POST);
    const edit = anEvent(
      DeviceEventKind.EDIT,
      { parts: [{ content: 'gm all', media: [] }] },
      ['drop-1']
    );
    const del = anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-2']);
    const on = anEvent(
      DeviceEventKind.REACT,
      { on: true, reaction: ':fire:' },
      ['drop-3']
    );
    const off = anEvent(DeviceEventKind.REACT, { on: false }, ['drop-3']);
    const store = new FakeStore([post, edit, del, on, off]);
    const { writes, calls } = aWrites();
    const report = await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(report).toMatchObject({ applied: 5, refused: 0, retry: 0 });
    expect(calls[0]).toEqual(['grant', TEST_GRANT_ID]);
    expect(calls[1]).toEqual([
      'create',
      'profile-1',
      {
        grant_id: TEST_GRANT_ID,
        seq: post.seq,
        claimed_time: post.claimed_time,
        signature: String(post.event.signature)
      },
      'wave-1',
      dropIdOfEvent(post.event_id)
    ]);
    expect(
      calls.filter((c) => c[0] !== 'grant').map((c) => c.slice(0, 3))
    ).toEqual([
      ['create', 'profile-1', expect.anything()],
      ['update', 'drop-1', { parts: [{ content: 'gm all', media: [] }] }],
      ['delete', 'drop-2'],
      ['react', 'drop-3', ':fire:'],
      ['react', 'drop-3', null]
    ]);
    expect(store.marks.map((m) => [m[1], m[3]])).toEqual([
      ['applied', dropIdOfEvent(post.event_id)],
      ['applied', 'drop-1'],
      ['applied', 'drop-2'],
      ['applied', 'drop-3'],
      ['applied', 'drop-3']
    ]);
  });

  it("refuses what 6529.io's rules refuse, and goes on", async () => {
    const events = [
      anEvent(DeviceEventKind.POST, { ...POST, drop_type: 'PARTICIPATORY' }),
      anEvent(DeviceEventKind.POST, { ...POST, wave_id: 'wave-9' }),
      anEvent(DeviceEventKind.EDIT, { parts: [] }, []),
      anEvent(DeviceEventKind.REACT, { on: true }, ['drop-1']),
      anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-1']),
      anEvent(DeviceEventKind.POST, POST)
    ];
    const store = new FakeStore(events);
    let creates = 0;
    const { writes } = aWrites({
      deleteDrop: async () => {
        throw new ForbiddenException('not your drop');
      },
      createDrop: async () => {
        creates++;
        if (creates === 1) throw new BadRequestException('wave closed');
        return 'x';
      }
    });
    const report = await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(report).toMatchObject({ applied: 0, refused: 6, retry: 0 });
    expect(store.marks.map((m) => [m[1], m[2]])).toEqual([
      [
        'refused',
        "only chat drops are written from the relays; entries are the chain's"
      ],
      ['refused', 'the body names another wave than the event'],
      ['refused', 'an edit names no drop'],
      ['refused', 'a reaction without its reaction'],
      ['refused', 'not your drop'],
      ['refused', 'wave closed']
    ]);
  });

  it('refuses an author without a profile', async () => {
    const store = new FakeStore([anEvent(DeviceEventKind.POST, POST)]);
    const { writes, calls } = aWrites({ profileIdOfWallet: async () => null });
    await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(store.marks[0].slice(1, 3)).toEqual([
      'refused',
      'the author has no 6529.io profile'
    ]);
    expect(calls).toEqual([]);
  });

  it("holds a drop's events after a failure that may pass, goes on with others, and gives up after the last try", async () => {
    const first = anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-1']);
    const second = anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-2']);
    const third = anEvent(DeviceEventKind.REACT, { on: false }, ['drop-1']);
    const { writes, calls } = aWrites({
      deleteDrop: async (_input, dropId) => {
        if (dropId === 'drop-1') throw new Error('database down');
        calls.push(['delete', dropId]);
      }
    });
    const store = new FakeStore([first, second, third]);
    const report = await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(report).toMatchObject({ retry: 1, applied: 1 });
    expect(store.marks).toEqual([
      [first.ingest_seq, 'logged', 'database down', null],
      [second.ingest_seq, 'applied', null, 'drop-2']
    ]);
    const last = new FakeStore([
      { ...first, apply_attempts: MAX_APPLY_ATTEMPTS - 1 }
    ]);
    const after = await new RelayDropApplier(last, writes).applyPending(RUN);
    expect(after).toMatchObject({ failed: 1 });
  });

  it("waits for an edit's or a reaction's post, without counting tries, for an hour", async () => {
    const edit = anEvent(DeviceEventKind.EDIT, { parts: [] }, ['drop-9']);
    const react = anEvent(DeviceEventKind.REACT, { on: false }, ['drop-9']);
    const { writes } = aWrites({
      updateDrop: async () => {
        throw new NotFoundException('Drop drop-9 not found');
      },
      react: async () => {
        throw new NotFoundException('Drop drop-9 not found');
      }
    });
    const store = new FakeStore([edit, react]);
    const soon = () => edit.received_at + POST_WAIT_MS - 1;
    const report = await new RelayDropApplier(store, writes, soon).applyPending(
      RUN
    );
    // The reaction waits behind the edit of the same drop.
    expect(report).toMatchObject({ retry: 1, refused: 0, failed: 0 });
    expect(store.marks).toEqual([
      [edit.ingest_seq, 'waiting', 'Drop drop-9 not found', null]
    ]);
    // Out of the batches for a while, so waiting events never fill them.
    expect(store.asked).toEqual([soon()]);
    expect(store.waits).toEqual([[edit.ingest_seq, soon() + WAIT_RETRY_MS]]);
    const tired = new FakeStore([
      { ...edit, apply_attempts: MAX_APPLY_ATTEMPTS - 1 }
    ]);
    await new RelayDropApplier(tired, writes, soon).applyPending(RUN);
    expect(tired.marks[0][1]).toBe('waiting');
    const late = new FakeStore([edit]);
    const later = () => edit.received_at + POST_WAIT_MS;
    await new RelayDropApplier(late, writes, later).applyPending(RUN);
    expect(late.marks[0].slice(1, 3)).toEqual([
      'refused',
      'Drop drop-9 not found'
    ]);
  });

  it('waits for an event an earlier try reserved and never finished', async () => {
    const post = anEvent(DeviceEventKind.POST, POST);
    const { writes } = aWrites({
      createDrop: async () => {
        throw new BadRequestException(
          'Invalid device signature: event or sequence number was already used'
        );
      }
    });
    const reserved = new FakeStore([post]);
    reserved.reservations.add(post.event_id);
    const report = await new RelayDropApplier(reserved, writes).applyPending(
      RUN
    );
    expect(report).toMatchObject({ retry: 1, refused: 0 });
    expect(reserved.marks[0].slice(1, 3)).toEqual([
      'waiting',
      'an earlier try left it reserved'
    ]);
    // Used by another event (a reused seq): refused.
    const used = new FakeStore([post]);
    await new RelayDropApplier(used, writes).applyPending(RUN);
    expect(used.marks[0][1]).toBe('refused');
  });

  it("never writes under a grant 6529.io couldn't verify, nor a post deleted first", async () => {
    const unverifiable = anEvent(DeviceEventKind.POST, POST, [], {
      grant_check: 'unverifiable'
    });
    const deleted = anEvent(DeviceEventKind.POST, POST);
    const store = new FakeStore([unverifiable, deleted]);
    store.tombstones.add(
      `${dropIdOfEvent(deleted.event_id)} ${TEST_WALLET.toLowerCase()}`
    );
    const { writes, calls } = aWrites();
    await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(store.marks.map((m) => [m[1], m[2]])).toEqual([
      ['refused', "the event's grant could not be verified here"],
      ['refused', 'the drop was deleted before it was written']
    ]);
    expect(calls.filter((c) => c[0] === 'create')).toEqual([]);
  });

  it("writes with the event's own times, anchor and lowercase signature, after releasing a stale reservation", async () => {
    const post = anEvent(DeviceEventKind.POST, POST);
    const store = new FakeStore([post]);
    let seen: unknown = null;
    const { writes } = aWrites({
      createDrop: async (input, dropId) => {
        seen = { envelope: input.envelope, times: input.times };
        return dropId;
      }
    });
    await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(store.released).toEqual([post.event_id]);
    expect(seen).toEqual({
      envelope: {
        grant_id: TEST_GRANT_ID,
        seq: post.seq,
        claimed_time: post.claimed_time,
        signature: String(post.event.signature).toLowerCase()
      },
      times: {
        signedAt: post.claimed_time,
        seenAt: post.received_at,
        anchor: 0
      }
    });
  });

  it('writes history with no notifications, and live events with them', async () => {
    const history = { event_origin: 'IMPORT' as const };
    const events = [
      anEvent(DeviceEventKind.POST, POST, [], history),
      anEvent(
        DeviceEventKind.REACT,
        { on: true, reaction: ':fire:' },
        ['d-1'],
        {
          ...history
        }
      ),
      anEvent(DeviceEventKind.EDIT, { parts: [] }, ['d-1'], history),
      anEvent(DeviceEventKind.POST, POST),
      anEvent(DeviceEventKind.REACT, { on: true, reaction: ':fire:' }, ['d-2'])
    ];
    const notified: [string, boolean][] = [];
    const { writes } = aWrites({
      createDrop: async (input, dropId) => {
        notified.push(['create', input.notify]);
        return dropId;
      },
      updateDrop: async (input) => {
        notified.push(['update', input.notify]);
      },
      react: async (input) => {
        notified.push(['react', input.notify]);
      }
    });
    const report = await new RelayDropApplier(
      new FakeStore(events),
      writes
    ).applyPending(RUN);
    expect(report.applied).toBe(5);
    expect(notified).toEqual([
      ['create', false],
      ['react', false],
      ['update', false],
      ['create', true],
      ['react', true]
    ]);
  });

  it('treats a delete of a drop not found as a refusal', async () => {
    const store = new FakeStore([
      anEvent(DeviceEventKind.TOMBSTONE, null, ['gone'])
    ]);
    const { writes } = aWrites({
      deleteDrop: async () => {
        throw new NotFoundException('Drop gone not found');
      }
    });
    await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(store.marks[0][1]).toBe('refused');
  });

  it('stops at its deadline', async () => {
    let t = 0;
    const store = new FakeStore([
      anEvent(DeviceEventKind.TOMBSTONE, null, ['a']),
      anEvent(DeviceEventKind.TOMBSTONE, null, ['b'])
    ]);
    const { writes } = aWrites({
      deleteDrop: async () => {
        t += 10;
      }
    });
    const report = await new RelayDropApplier(
      store,
      writes,
      () => t
    ).applyPending({
      limit: 10,
      deadline: 5
    });
    expect(report.applied).toBe(1);
  });

  it("writes a post another wallet's delete names", async () => {
    const post = anEvent(DeviceEventKind.POST, POST);
    const store = new FakeStore([post]);
    store.tombstones.add(`${dropIdOfEvent(post.event_id)} 0x${'b'.repeat(40)}`);
    const { writes, calls } = aWrites();
    const report = await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(report.applied).toBe(1);
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });
});

describe('RelayDropApplier and waves that stay on 6529.io', () => {
  const kinds = () => [
    anEvent(DeviceEventKind.POST, POST),
    anEvent(DeviceEventKind.EDIT, { parts: [] }, ['drop-1']),
    anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-2']),
    anEvent(DeviceEventKind.REACT, { on: true, reaction: ':fire:' }, ['drop-3'])
  ];

  it('writes nothing of any kind into a wave the chain does not hold', async () => {
    const events = kinds();
    const store = new FakeStore(events);
    store.onChain.set('wave-1', 'stays');
    const { writes, calls } = aWrites();
    const late = () => events[events.length - 1].received_at + POST_WAIT_MS;
    const report = await new RelayDropApplier(
      store,
      writes,
      late,
      null
    ).applyPending(RUN);
    expect(report).toMatchObject({ applied: 0, refused: 4, retry: 0 });
    expect(store.marks.map((m) => [m[1], m[2], m[3]])).toEqual(
      events.map(() => ['refused', STAYS_ON_SITE_REASON, null])
    );
    // Not even the grant or a stale reservation is touched.
    expect(calls).toEqual([]);
    expect(store.released).toEqual([]);
  });

  it('waits, without counting a try, while the chain index has not finished a full read', async () => {
    const events = kinds();
    const store = new FakeStore(events);
    store.onChain.set('wave-1', 'unknown');
    const { writes, calls } = aWrites();
    const late = () => events[events.length - 1].received_at + POST_WAIT_MS;
    const report = await new RelayDropApplier(
      store,
      writes,
      late,
      null
    ).applyPending(RUN);
    expect(report).toMatchObject({ applied: 0, refused: 0, retry: 4 });
    expect(store.marks.map((m) => [m[1], m[2]])).toEqual(
      events.map(() => [
        'waiting',
        'the chain index has not finished reading the chain'
      ])
    );
    expect(store.waits.map((w) => w[1])).toEqual(
      events.map(() => late() + WAIT_RETRY_MS)
    );
    expect(calls).toEqual([]);
  });

  it('waits for a wave the index does not hold yet for an hour from when the event was first seen, then refuses it', async () => {
    const post = anEvent(DeviceEventKind.POST, POST);
    const { writes, calls } = aWrites();
    const early = new FakeStore([post]);
    early.onChain.set('wave-1', 'stays');
    const soon = () => post.received_at + POST_WAIT_MS - 1;
    await new RelayDropApplier(early, writes, soon, null).applyPending(RUN);
    expect(early.marks[0].slice(1, 3)).toEqual([
      'waiting',
      'the chain index does not hold the wave yet'
    ]);
    const after = new FakeStore([post]);
    after.onChain.set('wave-1', 'stays');
    const later = () => post.received_at + POST_WAIT_MS;
    await new RelayDropApplier(after, writes, later, null).applyPending(RUN);
    expect(after.marks[0].slice(1, 3)).toEqual([
      'refused',
      STAYS_ON_SITE_REASON
    ]);
    expect(calls).toEqual([]);
  });

  it("refuses 6529.io's records wave even where the chain holds it", async () => {
    const events = kinds();
    const store = new FakeStore(events);
    const { writes, calls } = aWrites();
    const report = await new RelayDropApplier(
      store,
      writes,
      () => Date.now(),
      recordsWaveIdOf({ SIGNED_RECORDS_WAVE_ID: ' WAVE-1 ' })
    ).applyPending(RUN);
    expect(report).toMatchObject({ applied: 0, refused: 4 });
    expect(new Set(store.marks.map((m) => m[2]))).toEqual(
      new Set(["the wave stays on 6529.io: it is 6529.io's records wave"])
    );
    expect(store.wavesAsked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('asks about the wave the event names, in lowercase, and writes into a wave the chain holds', async () => {
    const edit = anEvent(DeviceEventKind.EDIT, { parts: [] }, ['drop-1'], {
      wave: 'Wave-1'
    });
    const store = new FakeStore([edit]);
    const { writes, calls } = aWrites();
    const report = await new RelayDropApplier(
      store,
      writes,
      () => Date.now(),
      'records-wave'
    ).applyPending(RUN);
    expect(report.applied).toBe(1);
    expect(store.wavesAsked).toEqual(['wave-1']);
    expect(calls.map((c) => c[0])).toEqual(['grant', 'update']);
  });

  it('reads the records wave from SIGNED_RECORDS_WAVE_ID', () => {
    expect(recordsWaveIdOf({})).toBeNull();
    expect(recordsWaveIdOf({ SIGNED_RECORDS_WAVE_ID: '  ' })).toBeNull();
    expect(recordsWaveIdOf({ SIGNED_RECORDS_WAVE_ID: ' AB-Cd ' })).toBe(
      'ab-cd'
    );
  });
});
