import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { UserGroupsDb } from './user-groups.db';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';

const pureProfileGroup = aUserGroup(
  {
    profile_group_id: randomUUID(),
    is_direct_message: false
  },
  {
    id: 'pure-profile-group',
    name: 'Search Group Profile'
  }
);

const criteriaGroup = aUserGroup(
  {
    tdh_min: 1,
    is_direct_message: false
  },
  {
    id: 'criteria-group',
    name: 'Search Group Criteria'
  }
);

const unrelatedGroup = aUserGroup(
  {
    is_direct_message: false
  },
  {
    id: 'unrelated-group',
    name: 'Another Group'
  }
);

describeWithSeed(
  'UserGroupsDb searchByNameOrAuthor',
  withUserGroups([pureProfileGroup, criteriaGroup, unrelatedGroup]),
  () => {
    const repo = new UserGroupsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('excludes pure profile groups when includeProfileGroups is false', async () => {
      const results = await repo.searchByNameOrAuthor(
        'Search Group',
        null,
        null,
        false,
        null,
        [],
        ctx
      );

      expect(results.map((group) => group.id).sort()).toEqual([
        criteriaGroup.id
      ]);
    });

    it('includes pure profile groups when includeProfileGroups is true', async () => {
      const results = await repo.searchByNameOrAuthor(
        'Search Group',
        null,
        null,
        true,
        null,
        [],
        ctx
      );

      expect(results.map((group) => group.id).sort()).toEqual(
        [criteriaGroup.id, pureProfileGroup.id].sort()
      );
    });
  }
);
