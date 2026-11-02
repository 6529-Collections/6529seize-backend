import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { DropBookmarksApiService } from './drop-bookmarks.api.service';
import { DropBookmarksDb } from './drop-bookmarks.db';
import { DropsDb } from '@/drops/drops.db';
import { DropsMappers } from './drops.mappers';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';

jest.mock('../api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn()
}));

function fixture(roleProfileId: string | null = 'proxy') {
  const authenticationContext = new AuthenticationContext({
    authenticatedWallet: 'wallet',
    authenticatedProfileId: 'owner',
    roleProfileId,
    activeProxyActions: []
  });
  const ctx = { authenticationContext };
  const bookmarks = {
    insertBookmark: jest.fn(),
    deleteBookmark: jest.fn(),
    countBookmarkedDropsForIdentity: jest.fn().mockResolvedValue(3),
    findBookmarkedDropsForIdentity: jest
      .fn()
      .mockResolvedValue({ drop_ids: [], count: 0 }),
    isDropBookmarkedByIdentity: jest.fn().mockResolvedValue(true)
  };
  const drops = {
    findDropByIdWithEligibilityCheck: jest
      .fn()
      .mockResolvedValue({ id: 'drop' }),
    executeNativeQueriesInTransaction: jest.fn(
      async (fn: (connection: unknown) => Promise<unknown>) => fn(undefined)
    )
  };
  const mappers = {
    convertToDropFulls: jest.fn().mockResolvedValue([{ id: 'drop' }])
  };
  const groups = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['owner-group'])
  };
  const service = new DropBookmarksApiService(
    bookmarks as unknown as DropBookmarksDb,
    drops as unknown as DropsDb,
    mappers as unknown as DropsMappers,
    groups as unknown as UserGroupsService
  );
  return { service, ctx, bookmarks, drops, mappers, groups };
}

describe('private bookmark ownership', () => {
  it.each([null, 'proxy'])(
    'uses the signed-in owner with role %s',
    async (role) => {
      const { service, ctx, bookmarks, groups } = fixture(role);
      await expect(service.getBookmarkStatus(ctx, 'drop')).resolves.toEqual({
        count: 3,
        bookmarked: true
      });
      expect(groups.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
        'owner',
        undefined
      );
      expect(bookmarks.isDropBookmarkedByIdentity).toHaveBeenCalledWith(
        { identity_id: 'owner', drop_id: 'drop' },
        undefined
      );
      expect(bookmarks.countBookmarkedDropsForIdentity).toHaveBeenCalledWith(
        {
          identity_id: 'owner',
          wave_id: null,
          group_ids_user_is_eligible_for: ['owner-group']
        },
        undefined
      );
    }
  );
  it.each(['bookmarkDrop', 'unbookmarkDrop'] as const)(
    'keeps %s private even under proxy access',
    async (method) => {
      const { service, ctx, bookmarks, mappers } = fixture();
      await service[method]('drop', ctx);
      const change =
        method === 'bookmarkDrop'
          ? bookmarks.insertBookmark
          : bookmarks.deleteBookmark;
      expect(change).toHaveBeenCalledWith(
        { identity_id: 'owner', drop_id: 'drop' },
        undefined
      );
      expect(
        mappers.convertToDropFulls.mock.calls[0][0].authenticationContext.getActingAsId()
      ).toBe('owner');
    }
  );
  it('does not treat proxy-only wave access as owner access', async () => {
    const { service, ctx, drops, bookmarks } = fixture();
    drops.findDropByIdWithEligibilityCheck.mockResolvedValue(null);
    await expect(
      service.bookmarkDrop('private-drop', ctx)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.getBookmarkStatus(ctx, 'private-drop')
    ).resolves.toEqual({ count: 3, bookmarked: false });
    expect(bookmarks.insertBookmark).not.toHaveBeenCalled();
    expect(bookmarks.isDropBookmarkedByIdentity).not.toHaveBeenCalled();
  });
  it('scopes list and its count to the owner eligibility', async () => {
    const { service, ctx, bookmarks } = fixture();
    await service.getBookmarkedDrops(
      {
        wave_id: null,
        page_size: 25,
        page: 1,
        sort_direction: ApiPageSortDirection.Desc
      },
      ctx
    );
    expect(bookmarks.findBookmarkedDropsForIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_id: 'owner',
        group_ids_user_is_eligible_for: ['owner-group']
      }),
      undefined
    );
  });
  it('rejects unauthenticated bookmark reads and writes', async () => {
    const { service } = fixture();
    const ctx = {
      authenticationContext: AuthenticationContext.notAuthenticated()
    };
    await expect(service.getBookmarkStatus(ctx)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.bookmarkDrop('drop', ctx)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.unbookmarkDrop('drop', ctx)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      service.getBookmarkedDrops(
        {
          wave_id: null,
          page_size: 25,
          page: 1,
          sort_direction: ApiPageSortDirection.Desc
        },
        ctx
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
