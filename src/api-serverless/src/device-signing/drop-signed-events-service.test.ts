import { mock } from 'ts-jest-mocker';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { NotFoundException } from '@/exceptions';
import { DeviceSigningDb } from './device-signing.db';
import { DropSignedEventsService } from './drop-signed-events.service';

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
  const drops = { findDropByIdOrThrow: jest.fn() };
  let service: DropSignedEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    db = mock(DeviceSigningDb);
    service = new DropSignedEventsService(db, drops);
    drops.findDropByIdOrThrow.mockResolvedValue({
      id: 'drop-1',
      moderation: { status: 'VISIBLE', can_view: true },
      author: { id: 'profile-1' }
    });
  });

  it('returns events, the grants they reference and the current event', async () => {
    const edit = anEvent({
      id: `0x${'2'.repeat(64)}`,
      kind: 2,
      seq: 8,
      created_at: 200
    });
    jest.mocked(db.findEventsByDropId).mockResolvedValue([anEvent(), edit]);
    jest.mocked(db.findDropAuthorSignatureEventId).mockResolvedValue(edit.id);
    jest.mocked(db.findGrantsByIds).mockResolvedValue([grant]);
    const ctx = { timer: undefined };

    const result = await service.findForDrop('drop-1', ctx);

    expect(drops.findDropByIdOrThrow).toHaveBeenCalledWith(
      { dropId: 'drop-1' },
      ctx
    );
    expect(db.findGrantsByIds).toHaveBeenCalledWith([GRANT_ID], ctx);
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
