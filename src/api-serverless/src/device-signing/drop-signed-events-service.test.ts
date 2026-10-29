import { mock } from 'ts-jest-mocker';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { NotFoundException } from '@/exceptions';
import { DeviceSigningDb } from './device-signing.db';
import { DropSignedEventsService } from './drop-signed-events.service';
import { CompetitionAnonymityService } from '@/competitions/competition-anonymity';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { SqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';

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
  const anonymity = { hiddenDropIds: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    db = mock(DeviceSigningDb);
    anonymity.hiddenDropIds.mockReset().mockResolvedValue(new Set());
    service = new DropSignedEventsService(db, drops, anonymity);
    drops.findDropByIdOrThrow.mockResolvedValue({ id: 'drop-1' });
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

  it('404s without reading events when the caller cannot read the drop', async () => {
    drops.findDropByIdOrThrow.mockRejectedValue(
      new NotFoundException('Drop drop-1 not found')
    );

    await expect(service.findForDrop('drop-1', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(db.findEventsByDropId).not.toHaveBeenCalled();
    expect(db.findDropAuthorSignatureEventId).not.toHaveBeenCalled();
    expect(db.findGrantsByIds).not.toHaveBeenCalled();
    expect(anonymity.hiddenDropIds).not.toHaveBeenCalled();
  });

  it('fails closed without reading proofs when the privacy lookup fails', async () => {
    anonymity.hiddenDropIds.mockRejectedValue(new Error('policy unavailable'));
    await expect(service.findForDrop('drop-1', {})).rejects.toThrow(
      'policy unavailable'
    );
    expect(db.findEventsByDropId).not.toHaveBeenCalled();
    expect(db.findDropAuthorSignatureEventId).not.toHaveBeenCalled();
    expect(db.findGrantsByIds).not.toHaveBeenCalled();
  });

  it.each([
    {
      viewer: 'public',
      state: 'anonymous',
      privateOwnerId: null,
      hidden: true
    },
    {
      viewer: 'rate-only delegate',
      state: 'anonymous',
      action: ProfileProxyActionType.RATE_WAVE_DROP,
      privateOwnerId: null,
      hidden: true
    },
    {
      viewer: 'read delegate',
      state: 'anonymous',
      action: ProfileProxyActionType.READ_WAVE,
      privateOwnerId: 'profile-1',
      hidden: false
    },
    {
      viewer: 'owner',
      state: 'anonymous',
      privateOwnerId: 'profile-1',
      hidden: false
    },
    { viewer: 'public', state: 'winner', privateOwnerId: null, hidden: false },
    { viewer: 'public', state: 'ordinary', privateOwnerId: null, hidden: false }
  ])(
    'applies shared policy to $state proof metadata for $viewer',
    async ({ viewer, state, action, privateOwnerId, hidden }) => {
      const execute = jest.fn(async (_sql, params) =>
        state === 'anonymous' && params.viewer !== 'profile-1'
          ? [{ drop_id: 'drop-1' }]
          : []
      );
      const policy = new CompetitionAnonymityService(
        () => ({ execute }) as unknown as SqlExecutor
      );
      service = new DropSignedEventsService(db, drops, policy);
      const authenticationContext = action
        ? new AuthenticationContext({
            authenticatedWallet: null,
            authenticatedProfileId: 'delegate',
            roleProfileId: 'profile-1',
            activeProxyActions: [
              {
                id: 'action',
                type: action,
                credit_amount: null,
                credit_spent: null
              }
            ]
          })
        : viewer === 'owner'
          ? AuthenticationContext.fromProfileId('profile-1')
          : AuthenticationContext.notAuthenticated();
      const connection = { connection: {} };
      const ctx = { authenticationContext, connection };
      const event = anEvent();
      jest.mocked(db.findEventsByDropId).mockResolvedValue([event]);
      jest
        .mocked(db.findDropAuthorSignatureEventId)
        .mockResolvedValue(event.id);
      jest.mocked(db.findGrantsByIds).mockResolvedValue([grant]);

      const result = await service.findForDrop('drop-1', ctx);

      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining('e.won_at is null'),
        { ids: ['drop-1'], viewer: privateOwnerId },
        { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
      );
      if (hidden) {
        expect(result).toEqual({
          drop_id: 'drop-1',
          current_event_id: null,
          events: [],
          grants: []
        });
        expect(db.findEventsByDropId).not.toHaveBeenCalled();
        expect(db.findDropAuthorSignatureEventId).not.toHaveBeenCalled();
        expect(db.findGrantsByIds).not.toHaveBeenCalled();
      } else {
        expect(result.current_event_id).toBe(event.id);
        expect(result.events[0].author).toBe(event.author);
        expect(result.grants[0].wallet).toBe(grant.wallet);
        expect(db.findGrantsByIds).toHaveBeenCalledWith([GRANT_ID], ctx);
      }
    }
  );
});
