import { mock } from 'ts-jest-mocker';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { NotFoundException } from '@/exceptions';
import { DeviceSigningDb } from './device-signing.db';
import fc from 'fast-check';
import {
  DROP_SIGNED_EVENTS_BATCH_EVENTS_PER_DROP,
  DropSignedEventsService
} from './drop-signed-events.service';

const GRANT_ID = `0x${'a'.repeat(64)}`;

function anEvent(
  overrides: Partial<DeviceSignedEventEntity> = {}
): DeviceSignedEventEntity {
  return {
    id: `0x${'1'.repeat(64)}`,
    kind: 1,
    kind_version: 1,
    wave_id: 'wave-1',
    drop_id: 'drop-1',
    author: `0x${'b'.repeat(40)}`,
    profile_id: 'profile-1',
    key_type: 2,
    device_key: `0x${'c'.repeat(64)}`,
    grant_id: GRANT_ID,
    seq: 7,
    anchor: 0,
    claimed_time: 100,
    refs: '["parent-drop"]',
    body: '{"a":1}',
    body_hash: `0x${'d'.repeat(64)}`,
    body_size: 7,
    signature: `0x${'e'.repeat(128)}`,
    created_at: 101,
    ...overrides
  };
}

const grant: DeviceGrantEntity = {
  id: GRANT_ID,
  wallet: `0x${'b'.repeat(40)}`,
  key_type: 'ed25519',
  device_key: `0x${'c'.repeat(64)}`,
  scopes: 'post,edit,delete,react',
  device_label: 'Browser',
  domain: '6529.io',
  message: 'signed message',
  wallet_signature: '0xsig',
  chain_id: 1,
  issued_at: 1,
  expires_at: 2,
  created_at: 3,
  revoked_at: null,
  last_used_at: 4
};

describe('DropSignedEventsService', () => {
  let db: DeviceSigningDb;
  const drops = {
    findDropByIdOrThrow: jest.fn(),
    findReadableDropsByIds: jest.fn()
  };
  const anonymity = { hiddenDropIds: jest.fn() };
  let service: DropSignedEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    db = mock(DeviceSigningDb);
    service = new DropSignedEventsService(db, drops, anonymity);
    anonymity.hiddenDropIds.mockResolvedValue(new Set());
    drops.findDropByIdOrThrow.mockResolvedValue({
      id: 'drop-1',
      moderation: { status: 'VISIBLE', can_view: true },
      author: { id: 'profile-1' }
    });
  });

  it('returns the events and public grant proofs without owner notice state', async () => {
    const edit = anEvent({
      id: `0x${'2'.repeat(64)}`,
      kind: 2,
      seq: 8,
      created_at: 200
    });
    jest.mocked(db.findEventsByDropId).mockResolvedValue([anEvent(), edit]);
    jest.mocked(db.findDropAuthorSignatureEventId).mockResolvedValue(edit.id);
    jest
      .mocked(db.findGrantsByIds)
      .mockResolvedValue([{ ...grant, notice_acknowledged: true }]);
    const ctx = { timer: undefined };

    const result = await service.findForDrop('drop-1', ctx);

    expect(drops.findDropByIdOrThrow).toHaveBeenCalledWith(
      { dropId: 'drop-1' },
      ctx
    );
    expect(db.findGrantsByIds).toHaveBeenCalledWith([GRANT_ID], ctx);
    expect(result.grants[0]).not.toHaveProperty('notice_acknowledged');
    expect(result).toEqual({
      drop_id: 'drop-1',
      current_event_id: edit.id,
      events: [
        {
          id: `0x${'1'.repeat(64)}`,
          kind: 1,
          kind_version: 1,
          wave: 'wave-1',
          author: `0x${'b'.repeat(40)}`,
          key_type: 2,
          device_key: `0x${'c'.repeat(64)}`,
          auth_ref: GRANT_ID,
          seq: 7,
          anchor: 0,
          claimed_time: 100,
          refs: ['parent-drop'],
          body: '{"a":1}',
          body_hash: `0x${'d'.repeat(64)}`,
          body_size: 7,
          signature: `0x${'e'.repeat(128)}`,
          created_at: 101
        },
        expect.objectContaining({ id: edit.id, kind: 2, seq: 8 })
      ],
      grants: [
        expect.objectContaining({
          id: GRANT_ID,
          message: 'signed message',
          wallet_signature: '0xsig',
          chain_id: 1,
          scopes: ['post', 'edit', 'delete', 'react']
        })
      ]
    });
  });

  it('returns an empty result for an unsigned drop', async () => {
    jest.mocked(db.findEventsByDropId).mockResolvedValue([]);
    jest.mocked(db.findDropAuthorSignatureEventId).mockResolvedValue(null);
    jest.mocked(db.findGrantsByIds).mockResolvedValue([]);

    await expect(service.findForDrop('drop-1', {})).resolves.toEqual({
      drop_id: 'drop-1',
      current_event_id: null,
      events: [],
      grants: []
    });
  });

  it.each([
    [
      'moderation hides its content from the caller',
      {
        id: 'drop-1',
        moderation: { status: 'HIDDEN', can_view: false },
        author: { id: 'profile-1' }
      }
    ],
    [
      'the drop has no moderation verdict',
      { id: 'drop-1', author: { id: 'profile-1' } }
    ],
    [
      'its author is anonymous to the caller',
      {
        id: 'drop-1',
        moderation: { status: 'VISIBLE', can_view: true },
        author: { id: 'anonymous-id', handle: 'Anonymous', is_anonymous: true }
      }
    ]
  ])(
    'returns the unsigned result without reading events when %s',
    async (_case, drop) => {
      drops.findDropByIdOrThrow.mockResolvedValue(drop);
      const ctx = { timer: undefined };

      await expect(service.findForDrop('drop-1', ctx)).resolves.toEqual({
        drop_id: 'drop-1',
        current_event_id: null,
        events: [],
        grants: []
      });
      expect(drops.findDropByIdOrThrow).toHaveBeenCalledWith(
        { dropId: 'drop-1' },
        ctx
      );
      expect(db.findEventsByDropId).not.toHaveBeenCalled();
      expect(db.findDropAuthorSignatureEventId).not.toHaveBeenCalled();
      expect(db.findGrantsByIds).not.toHaveBeenCalled();
    }
  );

  it('asks the anonymity rule directly, whatever the mapped author says', async () => {
    // A mapped author that lost its is_anonymous flag must still not leak the
    // wallet: the competition anonymity rule is checked for this caller too.
    anonymity.hiddenDropIds.mockResolvedValue(new Set(['drop-1']));
    const ctx = { timer: undefined };

    await expect(service.findForDrop('drop-1', ctx)).resolves.toEqual({
      drop_id: 'drop-1',
      current_event_id: null,
      events: [],
      grants: []
    });
    expect(anonymity.hiddenDropIds).toHaveBeenCalledWith(['drop-1'], ctx);
    expect(db.findEventsByDropId).not.toHaveBeenCalled();
    expect(db.findGrantsByIds).not.toHaveBeenCalled();
  });

  it('returns the events when the read path shows the caller the author and content', async () => {
    // For example the submitter reading their own anonymous competition
    // entry: the read path does not anonymize it for them, so neither does
    // this endpoint.
    drops.findDropByIdOrThrow.mockResolvedValue({
      id: 'drop-1',
      moderation: { status: 'VISIBLE', can_view: true },
      author: { id: 'profile-1', is_anonymous: false }
    });
    jest.mocked(db.findEventsByDropId).mockResolvedValue([anEvent()]);
    jest
      .mocked(db.findDropAuthorSignatureEventId)
      .mockResolvedValue(anEvent().id);
    jest.mocked(db.findGrantsByIds).mockResolvedValue([grant]);

    const result = await service.findForDrop('drop-1', {});

    expect(result.current_event_id).toBe(anEvent().id);
    expect(result.events).toHaveLength(1);
    expect(result.grants).toEqual([
      expect.objectContaining({ id: GRANT_ID, wallet: grant.wallet })
    ]);
  });

  it('404s without reading events when the caller cannot read the drop', async () => {
    drops.findDropByIdOrThrow.mockRejectedValue(
      new NotFoundException('Drop drop-1 not found')
    );

    await expect(service.findForDrop('drop-1', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(db.findEventsByDropId).not.toHaveBeenCalled();
  });
});

describe('DropSignedEventsService batch read', () => {
  type DropCase = 'readable' | 'unreadable' | 'hidden' | 'anonymous';

  const GRANT_2 = `0x${'f'.repeat(64)}`;

  function dropOf(id: string, kind: DropCase) {
    return {
      id,
      moderation:
        kind === 'hidden'
          ? { status: 'HIDDEN', can_view: false }
          : { status: 'VISIBLE', can_view: true },
      author:
        kind === 'anonymous'
          ? { id: 'anonymous-id', handle: 'Anonymous', is_anonymous: true }
          : { id: 'profile-1' }
    };
  }

  /**
   * One in-memory world behind both the single and the batch read, so each
   * drop's batch answer can be compared with its single-drop answer.
   */
  function world(
    cases: Record<string, DropCase>,
    events: DeviceSignedEventEntity[],
    current: Record<string, string>,
    anonymousIds: string[] = []
  ) {
    const db = mock(DeviceSigningDb);
    const readable = (id: string) =>
      cases[id] !== undefined && cases[id] !== 'unreadable';
    const drops = {
      findDropByIdOrThrow: jest.fn(async ({ dropId }: { dropId: string }) => {
        if (!readable(dropId)) {
          throw new NotFoundException(`Drop ${dropId} not found`);
        }
        return dropOf(dropId, cases[dropId]);
      }),
      findReadableDropsByIds: jest.fn(async (ids: string[]) =>
        ids.filter(readable).map((id) => dropOf(id, cases[id]))
      )
    };
    const anonymity = {
      hiddenDropIds: jest.fn(
        async (ids: string[]) =>
          new Set(ids.filter((id) => anonymousIds.includes(id)))
      )
    };
    jest
      .mocked(db.findEventsByDropId)
      .mockImplementation(async (dropId) =>
        events.filter((it) => it.drop_id === dropId)
      );
    jest
      .mocked(db.findDropAuthorSignatureEventId)
      .mockImplementation(async (dropId) => current[dropId] ?? null);
    jest
      .mocked(db.findContentEventsByDropIds)
      .mockImplementation(async (dropIds) => ({
        events: events.filter(
          (it) => dropIds.includes(it.drop_id!) && Number(it.kind) !== 4
        ),
        truncatedDropIds: new Set<string>()
      }));
    jest
      .mocked(db.findDropAuthorSignatureEventIds)
      .mockImplementation(
        async (dropIds) =>
          new Map(
            dropIds
              .filter((id) => current[id] !== undefined)
              .map((id): [string, string] => [id, current[id]])
          )
      );
    jest
      .mocked(db.findGrantsByIds)
      .mockImplementation(async (ids) =>
        [grant, { ...grant, id: GRANT_2 }].filter((it) => ids.includes(it.id))
      );
    return {
      db,
      drops,
      anonymity,
      service: new DropSignedEventsService(db, drops as any, anonymity)
    };
  }

  const post = (dropId: string, n: number, grantId = GRANT_ID) =>
    anEvent({
      id: `0x${n.toString(16).padStart(64, '0')}`,
      drop_id: dropId,
      seq: n,
      grant_id: grantId
    });

  it('answers readable drops in request order and lists the rest as unavailable', async () => {
    const events = [
      post('d1', 1),
      post('d2', 2, GRANT_2),
      { ...post('d1', 3), kind: 2 },
      post('hidden', 4),
      post('anon', 5),
      post('anon-by-rule', 6),
      post('unreadable', 7)
    ];
    const { service, db } = world(
      {
        d1: 'readable',
        d2: 'readable',
        unsigned: 'readable',
        hidden: 'hidden',
        anon: 'anonymous',
        'anon-by-rule': 'readable',
        unreadable: 'unreadable'
      },
      events,
      { d1: events[2].id, d2: events[1].id, hidden: events[3].id },
      ['anon-by-rule']
    );
    const ids = [
      'missing',
      'd2',
      'unreadable',
      'hidden',
      'd1',
      'anon',
      'unsigned',
      'anon-by-rule'
    ];

    const result = await service.findForDrops(ids, { timer: undefined });

    expect(result.drops.map((it) => it.drop_id)).toEqual([
      'd2',
      'hidden',
      'd1',
      'anon',
      'unsigned',
      'anon-by-rule'
    ]);
    expect(result.unavailable).toEqual(['missing', 'unreadable']);
    expect(result.truncated_drop_ids).toEqual([]);
    const byId = new Map(result.drops.map((it) => [it.drop_id, it]));
    expect(byId.get('d1')).toEqual({
      drop_id: 'd1',
      current_event_id: events[2].id,
      events: [
        expect.objectContaining({ id: events[0].id }),
        expect.objectContaining({ id: events[2].id })
      ],
      grants: []
    });
    for (const id of ['hidden', 'anon', 'anon-by-rule', 'unsigned']) {
      expect(byId.get(id)).toEqual({
        drop_id: id,
        current_event_id: null,
        events: [],
        grants: []
      });
    }
    expect(result.grants.map((it) => it.id)).toEqual(
      expect.arrayContaining([GRANT_2, GRANT_ID])
    );
    expect(result.grants).toHaveLength(2);
    // Hidden, anonymous and unreadable drops are never read for events.
    const read = jest.mocked(db.findContentEventsByDropIds).mock.calls[0][0];
    expect(new Set(read)).toEqual(new Set(['d2', 'd1', 'unsigned']));
  });

  it('lists each grant once and caps events per drop below the batch maximum', async () => {
    const { service, db } = world(
      { d1: 'readable', d2: 'readable' },
      [post('d1', 1), post('d2', 2)],
      {}
    );

    const result = await service.findForDrops(['d1', 'd2'], {});

    expect(result.grants.map((it) => it.id)).toEqual([GRANT_ID]);
    expect(db.findGrantsByIds).toHaveBeenCalledWith([GRANT_ID], {});
    expect(jest.mocked(db.findContentEventsByDropIds).mock.calls[0][1]).toBe(
      DROP_SIGNED_EVENTS_BATCH_EVENTS_PER_DROP - 2
    );
  });

  it('names drops whose history was cut', async () => {
    const { service, db } = world({ d1: 'readable' }, [post('d1', 1)], {});
    jest.mocked(db.findContentEventsByDropIds).mockResolvedValue({
      events: [post('d1', 1)],
      truncatedDropIds: new Set(['d1'])
    });

    const result = await service.findForDrops(['d1'], {});

    expect(result.truncated_drop_ids).toEqual(['d1']);
  });

  it('reads no events when no requested drop is readable', async () => {
    const { service, anonymity } = world({ x: 'unreadable' }, [], {});

    await expect(service.findForDrops(['x', 'y'], {})).resolves.toEqual({
      drops: [],
      grants: [],
      unavailable: ['x', 'y'],
      truncated_drop_ids: []
    });
    expect(anonymity.hiddenDropIds).not.toHaveBeenCalled();
  });

  it('gives every drop the answer of the single drop route, minus reactions and per-drop grants', async () => {
    const dropIdArb = fc.constantFrom('a', 'b', 'c', 'd', 'e');
    const dropCase = fc.constantFrom<DropCase>(
      'readable',
      'unreadable',
      'hidden',
      'anonymous'
    );
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(dropIdArb, dropCase),
        fc.array(
          fc.record({
            drop: dropIdArb,
            kind: fc.constantFrom(1, 2, 3, 4),
            grant: fc.constantFrom(GRANT_ID, GRANT_2)
          }),
          { maxLength: 12 }
        ),
        fc.subarray(['a', 'b', 'c', 'd', 'e', 'f']),
        async (cases, rawEvents, requested) => {
          const events = rawEvents.map((it, index) => ({
            ...post(it.drop, index + 1, it.grant),
            kind: it.kind
          }));
          const current: Record<string, string> = {};
          for (const event of events) {
            if (event.kind === 1 || event.kind === 2) {
              current[event.drop_id!] = event.id;
            }
          }
          const { service } = world(cases, events, current);

          const batch = await service.findForDrops(requested, {});

          const batchGrantIds = new Set(batch.grants.map((it) => it.id));
          for (const dropId of requested) {
            const single = await service
              .findForDrop(dropId, {})
              .catch((error: unknown) => error);
            if (single instanceof NotFoundException) {
              expect(batch.unavailable).toContain(dropId);
              expect(batch.drops.map((it) => it.drop_id)).not.toContain(dropId);
              continue;
            }
            const answer = single as Awaited<
              ReturnType<DropSignedEventsService['findForDrop']>
            >;
            const item = batch.drops.find((it) => it.drop_id === dropId);
            expect(item).toEqual({
              ...answer,
              events: answer.events.filter((it) => it.kind !== 4),
              grants: []
            });
            for (const event of item!.events) {
              expect(batchGrantIds.has(event.auth_ref)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
