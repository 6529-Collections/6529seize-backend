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
      expect(sql).toContain('like :member_search');
      expect(params).toMatchObject({
        group_param: 'group-value',
        member_search: '%alice%'
      });
    }
  });
});
