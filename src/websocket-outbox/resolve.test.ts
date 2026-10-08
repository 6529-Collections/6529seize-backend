jest.mock('@/sql-executor', () => ({ dbSupplier: () => mockDb }));
jest.mock('@/api/ws/ws-connection.repository', () => ({
  wsConnectionRepository: {
    findWaveVisibilityGroupId: jest.fn(),
    getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast: jest.fn(),
    findNotificationConnectionIdsByIdentityIds: jest.fn(),
    findConnectionIdsByIdentityId: jest.fn(),
    findAllConnectionIds: jest.fn(),
    filterConnectionIdsByDeliveryMode: jest.fn()
  }
}));
jest.mock('@/attachments/attachments.db', () => ({
  attachmentsDb: {
    findAttachmentById: jest.fn(),
    findAttachmentWaveIds: jest.fn()
  }
}));
jest.mock('@/nft-links/nft-links.db', () => ({
  nftLinksDb: { findByCanonicalIdForNotification: jest.fn() }
}));
jest.mock('@/api/attachments/attachments.mappers', () => ({
  mapAttachmentToApiAttachment: (value: unknown) => value
}));
jest.mock('@/nft-links/nft-link-api.mapper', () => ({
  mapNftLinkEntityToApiLink: (value: unknown) => value
}));
jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: { findDmUnreadConversationStatesForIdentities: jest.fn() }
}));
import { resolveWebSocketEvent } from './resolve';
import { wsConnectionRepository as connections } from '@/api/ws/ws-connection.repository';
import { wavesApiDb } from '@/api/waves/waves.api.db';
const mockDb = { oneOrNull: jest.fn(), execute: jest.fn() };
const ctx = { connection: { connection: {} } };
beforeEach(() => jest.clearAllMocks());
it.each([undefined, 'POLL_RESPONSE', 'FUTURE_REASON'])(
  'turns current drop state into a canonical-fetch hint for reason %s',
  async (reason) => {
    mockDb.oneOrNull.mockResolvedValue({
      id: 'd',
      wave_id: 'w',
      author_id: 'a',
      serial_no: 9,
      title: 'private full content'
    });
    jest.mocked(connections.findWaveVisibilityGroupId).mockResolvedValue(null);
    jest
      .mocked(
        connections.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast
      )
      .mockResolvedValue([{ connectionId: 'c', profileId: 'p', wave_id: 'w' }]);
    const result = await resolveWebSocketEvent(
      { type: 'drop', dropId: 'd', updateType: 'DROP_UPDATE', reason },
      ctx
    );
    expect(result).toEqual([
      {
        type: 'delivery',
        connectionId: 'c',
        message: JSON.stringify({
          type: 'DROP_UPDATE_REF',
          data: {
            drop_id: 'd',
            wave_id: 'w',
            author_id: 'a',
            serial_no: 9,
            update_type: 'DROP_UPDATE',
            reason
          }
        })
      }
    ]);
    expect(mockDb.oneOrNull).toHaveBeenCalledWith(
      expect.any(String),
      { id: 'd' },
      { wrappedConnection: ctx.connection }
    );
  }
);
it('does not recreate a deleted resource from an old update intent', async () => {
  mockDb.oneOrNull.mockResolvedValue(null);
  expect(
    await resolveWebSocketEvent(
      { type: 'drop', dropId: 'gone', updateType: 'DROP_UPDATE' },
      ctx
    )
  ).toEqual([]);
});
it('keeps deletion routing even though the drop row has disappeared', async () => {
  jest.mocked(connections.findWaveVisibilityGroupId).mockResolvedValue(null);
  jest
    .mocked(
      connections.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast
    )
    .mockResolvedValue([{ connectionId: 'c', profileId: 'p', wave_id: 'w' }]);
  const result = await resolveWebSocketEvent(
    { type: 'drop-delete', dropId: 'gone', waveId: 'w', serialNo: 9 },
    ctx
  );
  expect(result).toEqual([
    {
      type: 'delivery',
      connectionId: 'c',
      message: JSON.stringify({
        type: 'DROP_DELETE',
        data: { drop_id: 'gone', wave_id: 'w', drop_serial: 9 }
      })
    }
  ]);
});
it('routes each DM state only to its current profile subscribers', async () => {
  jest
    .mocked(wavesApiDb.findDmUnreadConversationStatesForIdentities)
    .mockResolvedValue([
      { profile_id: 'p', wave_id: 'w', version: 2 }
    ] as never);
  jest
    .mocked(connections.findNotificationConnectionIdsByIdentityIds)
    .mockResolvedValue([
      { connectionId: 'allowed', identityId: 'p' },
      { connectionId: 'other', identityId: 'other' }
    ]);
  const result = await resolveWebSocketEvent(
    { type: 'dm', profileIds: ['p'], waveId: 'w' },
    ctx
  );
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ connectionId: 'allowed' });
  expect(
    connections.findNotificationConnectionIdsByIdentityIds
  ).toHaveBeenCalledWith(['p'], ctx);
});

it('keeps the notification profile from durable intent without rereading a deleted identity', async () => {
  mockDb.oneOrNull.mockResolvedValue(null);
  jest
    .mocked(connections.findNotificationConnectionIdsByIdentityIds)
    .mockResolvedValue([{ connectionId: 'c', identityId: 'p' }]);
  expect(
    await resolveWebSocketEvent({ type: 'identity', profileId: 'p' }, ctx)
  ).toEqual([
    {
      type: 'delivery',
      connectionId: 'c',
      message: JSON.stringify({
        type: 'IDENTITY_NOTIFICATIONS_CHANGED',
        data: { profile_id: 'p' }
      })
    }
  ]);
  expect(mockDb.oneOrNull).not.toHaveBeenCalled();
});

// Old and new sessions may belong to the same profile; route by connection, not profile.
it.each([
  { type: 'drop' as const, dropId: 'd', updateType: 'DROP_UPDATE' as const },
  { type: 'drop-delete' as const, dropId: 'd', waveId: 'w', serialNo: 9 },
  { type: 'identity' as const, profileId: 'p' },
  { type: 'dm' as const, profileIds: ['p'], waveId: 'w' },
  { type: 'attachment' as const, attachmentId: 'a' },
  { type: 'nft' as const, canonicalId: 'n' }
])(
  'routes new $type intents only to capable connections of a mixed audience',
  async (event) => {
    const ids = ['legacy', 'capable'];
    mockDb.oneOrNull.mockResolvedValue({
      id: 'd',
      wave_id: 'w',
      author_id: 'p',
      serial_no: 9
    });
    jest.mocked(connections.findWaveVisibilityGroupId).mockResolvedValue(null);
    jest
      .mocked(
        connections.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast
      )
      .mockResolvedValue(
        ids.map((connectionId) => ({
          connectionId,
          profileId: 'p',
          wave_id: 'w'
        }))
      );
    jest
      .mocked(connections.findNotificationConnectionIdsByIdentityIds)
      .mockResolvedValue(
        ids.map((connectionId) => ({ connectionId, identityId: 'p' }))
      );
    jest
      .mocked(connections.findConnectionIdsByIdentityId)
      .mockResolvedValue([...ids]);
    jest.mocked(connections.findAllConnectionIds).mockResolvedValue([...ids]);
    jest
      .mocked(connections.filterConnectionIdsByDeliveryMode)
      .mockResolvedValue(['capable']);
    jest
      .mocked(wavesApiDb.findDmUnreadConversationStatesForIdentities)
      .mockResolvedValue([
        { profile_id: 'p', wave_id: 'w', version: 2 }
      ] as never);
    const { attachmentsDb } = jest.requireMock('@/attachments/attachments.db');
    attachmentsDb.findAttachmentById.mockResolvedValue({
      owner_profile_id: 'p'
    });
    attachmentsDb.findAttachmentWaveIds.mockResolvedValue([]);
    const { nftLinksDb } = jest.requireMock('@/nft-links/nft-links.db');
    nftLinksDb.findByCanonicalIdForNotification.mockResolvedValue({
      canonical_id: 'n'
    });
    const result = await resolveWebSocketEvent(
      { ...event, deliveryCapability: 'durable_updates_v1' },
      ctx
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'delivery',
      connectionId: 'capable',
      deliveryCapability: 'durable_updates_v1'
    });
    expect(connections.filterConnectionIdsByDeliveryMode).toHaveBeenCalledWith(
      ids,
      true,
      ctx
    );
  }
);

it('carries capability through media expansion so historical and new intents do not change audience', async () => {
  mockDb.execute.mockResolvedValue([{ drop_id: 'd' }]);
  for (const deliveryCapability of [undefined, 'durable_updates_v1'] as const) {
    const children = await resolveWebSocketEvent(
      { type: 'media', uploadId: 'm', deliveryCapability },
      ctx
    );
    expect(children).toEqual([
      {
        type: 'drop',
        dropId: 'd',
        updateType: 'DROP_UPDATE',
        reason: 'MEDIA_STATUS',
        deliveryCapability
      }
    ]);
  }
});
