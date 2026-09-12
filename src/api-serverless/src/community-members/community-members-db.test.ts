import { SqlExecutor } from '@/sql-executor';
import { ApiCommunityMembersSortOption } from '../generated/models/ApiCommunityMembersSortOption';
import { PageSortDirection } from '../page-request';
import { CommunityMembersDb } from './community-members.db';

describe('CommunityMembersDb search', () => {
  it('applies the same parameterized identity search to list and count', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const userGroupsService = {
      getSqlAndParamsByGroupId: jest.fn().mockResolvedValue({
        sql: 'with user_groups_view as (select 1)',
        params: { group_param: 'group-value' }
      })
    };
    const db = new CommunityMembersDb(
      () => ({ execute }) as unknown as SqlExecutor,
      userGroupsService as never
    );
    const query = {
      page: 1,
      page_size: 20,
      sort: ApiCommunityMembersSortOption.Display,
      sort_direction: PageSortDirection.ASC,
      group_id: 'group-1',
      param: ' Alice '
    };

    await db.getCommunityMembers(query, {});
    execute.mockResolvedValueOnce([{ cnt: 0 }]);
    await db.countCommunityMembers(query, {});

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain('order by display ASC');
    expect(execute.mock.calls[0][0]).not.toContain('order by cm.display');
    for (const [sql, params] of execute.mock.calls) {
      expect(sql).toContain('instr(lower(cm.primary_address), :member_search)');
      expect(params).toMatchObject({
        group_param: 'group-value',
        member_search: 'alice'
      });
    }
  });

  it('returns zero when a count query unexpectedly returns no row', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const userGroupsService = {
      getSqlAndParamsByGroupId: jest.fn().mockResolvedValue({
        sql: 'with user_groups_view as (select 1)',
        params: {}
      })
    };
    const db = new CommunityMembersDb(
      () => ({ execute }) as unknown as SqlExecutor,
      userGroupsService as never
    );

    await expect(
      db.countCommunityMembers(
        {
          page: 1,
          page_size: 20,
          sort: ApiCommunityMembersSortOption.Display,
          sort_direction: PageSortDirection.ASC,
          group_id: 'group-1',
          param: null
        },
        {}
      )
    ).resolves.toBe(0);
  });

  it('searches identity-only preview rows projected from identities', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const userGroupsService = {
      getSqlAndParamsForPreview: jest.fn().mockResolvedValue({
        sql: `with included_profile_ids as (
          select profile_id from identities
        ), user_groups_view as (
          select i.* from identities i
          join included_profile_ids on i.profile_id = included_profile_ids.profile_id
        )`,
        params: { preview_included_addresses: ['0x1'] }
      })
    };
    const db = new CommunityMembersDb(
      () => ({ execute }) as unknown as SqlExecutor,
      userGroupsService as never
    );

    await db.getCommunityMembers(
      {
        page: 1,
        page_size: 20,
        sort: ApiCommunityMembersSortOption.Display,
        sort_direction: PageSortDirection.ASC,
        group_id: null,
        param: 'alice'
      },
      {},
      {} as never
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('select i.* from identities i'),
      expect.objectContaining({ member_search: 'alice' })
    );
    expect(execute.mock.calls[0][0]).toContain(
      'from user_groups_view cm where (instr(lower(ifnull(cm.handle, cm.primary_address))'
    );
  });
});
