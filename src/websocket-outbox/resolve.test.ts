jest.mock('@/sql-executor', () => ({ dbSupplier: () => mockDb }));
jest.mock('@/api/ws/ws-connection.repository', () => ({
  wsConnectionRepository: {
    findWaveVisibilityGroupId: jest.fn(),
    getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast: jest.fn(),
    findNotificationConnectionIdsByIdentityIds: jest.fn(),
    findConnectionIdsByIdentityId: jest.fn(),
    findAllConnectionIds: jest.fn()
  }
}));
jest.mock('@/attachments/attachments.db', () => ({ attachmentsDb: {} }));
jest.mock('@/nft-links/nft-links.db', () => ({ nftLinksDb: {} }));
jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: { findDmUnreadConversationStatesForIdentities: jest.fn() }
}));
import { resolveWebSocketEvent } from './resolve';
import { wsConnectionRepository as connections } from '@/api/ws/ws-connection.repository';
import { wavesApiDb } from '@/api/waves/waves.api.db';
const mockDb = { oneOrNull: jest.fn(), execute: jest.fn() };
const ctx = { connection: { connection: {} } };
beforeEach(() => jest.clearAllMocks());
it('turns current drop state into compact canonical-fetch hints, never stale embedded content', async () => {
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
    { type: 'drop', dropId: 'd', updateType: 'DROP_UPDATE' },
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
          update_type: 'DROP_UPDATE'
        }
      })
    }
  ]);
  expect(mockDb.oneOrNull).toHaveBeenCalledWith(
    expect.any(String),
    { id: 'd' },
    { wrappedConnection: ctx.connection }
  );
});
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
