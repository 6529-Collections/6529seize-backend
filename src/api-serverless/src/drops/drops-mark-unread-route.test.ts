const mockRoutes: { method: string; path: string; handler: any }[] = [];

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => {
    const register =
      (method: string) =>
      (path: string, ...handlers: any[]) => {
        mockRoutes.push({ method, path, handler: handlers.at(-1) });
      };
    return {
      get: register('get'),
      post: register('post'),
      put: register('put'),
      delete: register('delete'),
      use: jest.fn()
    };
  }
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser: () => jest.fn(),
  maybeAuthenticatedUser: () => jest.fn()
}));

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForReaderWave: jest
    .fn()
    .mockResolvedValue(undefined),
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { NotFoundException } from '@/exceptions';
import { dropsDb } from '@/drops/drops.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import './drops.routes';

const markUnread = () =>
  mockRoutes.find(
    (it) => it.method === 'post' && it.path === '/:drop_id/mark-unread'
  )!.handler;

describe('POST /drops/:drop_id/mark-unread', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('reader'));
    jest
      .spyOn(dropsDb, 'getDropsByIds')
      .mockResolvedValue([
        { id: 'drop-1', wave_id: 'wave-1', serial_no: 5, created_at: 100 }
      ] as any);
    jest
      .spyOn(wavesApiDb, 'setWaveReaderMetricLatestReadTimestamp')
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(wavesApiDb, 'findIdentityUnreadDropsSummaryByWaveId')
      .mockResolvedValue({
        'wave-1': { unread_drops_count: 1, first_unread_drop_serial_no: 5 }
      } as any);
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      visibility_group_id: 'parent-group',
      parent_wave_id: null
    } as any);
  });

  it.each([
    ['a missing wave', null],
    [
      'a private non-DM wave the reader cannot see',
      {
        id: 'wave-1',
        is_direct_message: false,
        visibility_group_id: 'group-1',
        parent_wave_id: null
      }
    ],
    [
      'a public subwave of a hidden parent',
      {
        id: 'wave-1',
        is_direct_message: false,
        visibility_group_id: null,
        parent_wave_id: 'parent'
      }
    ]
  ])('returns not found for %s before writing', async (_label, wave) => {
    jest.spyOn(wavesApiDb, 'findById').mockResolvedValue(wave as any);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue([]);

    await expect(
      markUnread()({ params: { drop_id: 'drop-1' } }, { send: jest.fn() })
    ).rejects.toThrow(new NotFoundException('Wave wave-1 not found.'));

    expect(
      wavesApiDb.setWaveReaderMetricLatestReadTimestamp
    ).not.toHaveBeenCalled();
  });

  it('marks a drop unread in a private wave the reader can see', async () => {
    jest.spyOn(wavesApiDb, 'findById').mockResolvedValue({
      id: 'wave-1',
      is_direct_message: false,
      visibility_group_id: 'group-1',
      parent_wave_id: null
    } as any);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue(['group-1']);
    const res = { send: jest.fn() };

    await markUnread()({ params: { drop_id: 'drop-1' } }, res);

    expect(
      wavesApiDb.setWaveReaderMetricLatestReadTimestamp
    ).toHaveBeenCalledWith('wave-1', 'reader', 99, expect.anything());
    expect(res.send).toHaveBeenCalledWith({
      your_unread_drops_count: 1,
      first_unread_drop_serial_no: 5,
      dm_unread_state: null
    });
  });

  it('does not load eligibility for a public root wave', async () => {
    jest.spyOn(wavesApiDb, 'findById').mockResolvedValue({
      id: 'wave-1',
      is_direct_message: false,
      visibility_group_id: null,
      parent_wave_id: null
    } as any);
    const eligibility = jest.spyOn(
      userGroupsService,
      'getGroupsUserIsEligibleFor'
    );

    await markUnread()({ params: { drop_id: 'drop-1' } }, { send: jest.fn() });

    expect(eligibility).not.toHaveBeenCalled();
    expect(
      wavesApiDb.setWaveReaderMetricLatestReadTimestamp
    ).toHaveBeenCalled();
  });
});
