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
  RelayApplyStore,
  RelayDropApplier,
  RelayDropWrites
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
    status: 'logged',
    status_reason: null,
    received_at: 1,
    apply_attempts: 0,
    ...overrides
  };
}

class FakeStore implements RelayApplyStore {
  readonly marks: [number, string, string | null, string | null][] = [];
  constructor(private readonly events: IngestedEvent[]) {}

  async pendingRelayEvents(limit: number) {
    return this.events.slice(0, limit);
  }

  async markApplied(
    ingestSeq: number,
    status: string,
    reason: string | null,
    dropId: string | null
  ) {
    this.marks.push([ingestSeq, status, reason, dropId]);
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

  it('stops at a failure that may pass, and gives up after the last try', async () => {
    const first = anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-1']);
    const second = anEvent(DeviceEventKind.TOMBSTONE, null, ['drop-2']);
    const { writes } = aWrites({
      deleteDrop: async () => {
        throw new Error('database down');
      }
    });
    const store = new FakeStore([first, second]);
    const report = await new RelayDropApplier(store, writes).applyPending(RUN);
    expect(report).toMatchObject({ retry: 1, applied: 0 });
    expect(store.marks).toEqual([
      [first.ingest_seq, 'logged', 'database down', null]
    ]);
    const last = new FakeStore([
      { ...first, apply_attempts: MAX_APPLY_ATTEMPTS - 1 },
      second
    ]);
    const after = await new RelayDropApplier(last, writes).applyPending(RUN);
    expect(after).toMatchObject({ failed: 1, retry: 1 });
    expect(last.marks.map((m) => m[1])).toEqual(['failed', 'logged']);
  });

  it('treats not-found and bad requests as refusals', async () => {
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
});
