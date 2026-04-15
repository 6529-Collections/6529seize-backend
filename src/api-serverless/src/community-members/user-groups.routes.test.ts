jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import { getValidatedByJoiOrThrow } from '../validation';
import {
  SearchUserGroupsQuery,
  SearchUserGroupsQuerySchema
} from './user-groups.routes';

describe('user groups search query validation', () => {
  it('normalizes blank optional filters to their legacy defaults', () => {
    const result = getValidatedByJoiOrThrow<SearchUserGroupsQuery>(
      {
        group_name: '',
        author_identity: '',
        created_at_less_than: '',
        include_profile_groups: ''
      } as unknown as SearchUserGroupsQuery,
      SearchUserGroupsQuerySchema
    );

    expect(result).toEqual({
      group_name: null,
      author_identity: null,
      created_at_less_than: null,
      include_profile_groups: false
    });
  });
});
