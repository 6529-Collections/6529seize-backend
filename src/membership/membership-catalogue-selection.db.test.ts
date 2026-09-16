import {
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  membershipWaveGroupIds,
  recordMembershipWaveSelection,
  withMembershipCatalogueSelection
} from './membership-catalogue-selection';
import { withMembershipPrimaryTransaction } from './membership-primary';
import * as policy from './membership-producer-policy';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb
} from './membership-source-states.db';

describe('wave membership catalogue selection', () => {
  it('collects every wave group role and batches a large parent deletion', async () => {
    expect(
      membershipWaveGroupIds({
        visibility_group_id: 'visible',
        admin_group_id: 'admin',
        chat_group_id: 'chat',
        participation_group_id: 'participate',
        voting_group_id: 'vote'
      })
    ).toEqual(['visible', 'admin', 'chat', 'participate', 'vote']);
    const batches: string[][] = [];
    await recordMembershipWaveSelection(
      async (changes) => {
        batches.push(changes.map((change) => change.group_id));
      },
      [
        ...Array.from(
          { length: 130 },
          (_, i) => `g${String(i).padStart(3, '0')}`
        ),
        'g001',
        null
      ],
      'parent-wave-deleted'
    );
    expect(batches.map((batch) => batch.length)).toEqual([128, 2]);
    expect(new Set(batches.flat()).size).toBe(130);
  });
});

describeWithSeed('wave membership catalogue mutation', [], () => {
  beforeEach(async () => {
    await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) =>
      new MembershipSourceStatesDb(() => sqlExecutor).provision(
        [MEMBERSHIP_CATALOG_KEY],
        { bootstrap_id: 'm67-wave-selection', coverage_revision: 'm67-test' },
        ctx
      )
    );
  });

  it('commits changed group versions and requests with the caller transaction', async () => {
    const active = jest
      .spyOn(policy, 'isMembershipSourceTrackingActive')
      .mockReturnValue(true);
    try {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withMembershipCatalogueSelection(connection, async (record) => {
          await recordMembershipWaveSelection(
            record,
            ['g1', 'g2'],
            'wave-updated'
          );
        })
      );
      expect(
        await sqlExecutor.execute(
          `SELECT CAST(version AS CHAR) version FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} WHERE dimension='GROUP_CATALOG'`
        )
      ).toEqual([{ version: '1' }]);
      expect(
        await sqlExecutor.execute(
          `SELECT group_id, CAST(catalog_version AS CHAR) catalog_version, is_deleted FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE} ORDER BY group_id`
        )
      ).toEqual([
        { group_id: 'g1', catalog_version: '1', is_deleted: true },
        { group_id: 'g2', catalog_version: '1', is_deleted: true }
      ]);
      expect(
        await sqlExecutor.execute(
          `SELECT target_id FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} WHERE scope='GROUP' ORDER BY target_id`
        )
      ).toEqual([{ target_id: 'g1' }, { target_id: 'g2' }]);
    } finally {
      active.mockRestore();
    }
  });

  it('rolls group versions and requests back after a later wave failure', async () => {
    const active = jest
      .spyOn(policy, 'isMembershipSourceTrackingActive')
      .mockReturnValue(true);
    try {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withMembershipCatalogueSelection(connection, async (record) => {
            await recordMembershipWaveSelection(record, ['g1'], 'wave-deleted');
            throw new Error('wave write failed');
          })
        )
      ).rejects.toThrow('wave write failed');
      expect(
        await sqlExecutor.execute(
          `SELECT CAST(version AS CHAR) version FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} WHERE dimension='GROUP_CATALOG'`
        )
      ).toEqual([{ version: '0' }]);
      expect(
        await sqlExecutor.execute(
          `SELECT group_id FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `SELECT target_id FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}`
        )
      ).toEqual([]);
    } finally {
      active.mockRestore();
    }
  });
});
