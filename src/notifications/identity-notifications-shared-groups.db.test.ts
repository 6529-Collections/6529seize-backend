import 'reflect-metadata';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { IdentityNotificationsDb } from './identity-notifications.db';

const MEMBER_GROUP = 'member-group';
const viewer = anIdentity(
  {},
  {
    consolidation_key: 'shared-groups-viewer',
    profile_id: 'shared-groups-viewer',
    primary_address: 'shared-groups-viewer-wallet',
    handle: 'shared-groups-viewer'
  }
);
const actor = anIdentity(
  {},
  {
    consolidation_key: 'shared-groups-actor',
    profile_id: 'shared-groups-actor',
    primary_address: 'shared-groups-actor-wallet',
    handle: 'shared-groups-actor'
  }
);
const publicWave = aWave(
  {},
  { id: 'shared-groups-public', serial_no: 1, name: 'Public' }
);
const memberWave = aWave(
  { visibility_group_id: MEMBER_GROUP },
  { id: 'shared-groups-member', serial_no: 2, name: 'Member' }
);
const memberSubwave = aWave(
  { parent_wave_id: memberWave.id },
  { id: 'shared-groups-member-sub', serial_no: 3, name: 'Member sub' }
);
const otherWave = aWave(
  { visibility_group_id: 'other-group' },
  { id: 'shared-groups-other', serial_no: 4, name: 'Other' }
);

const viewerGroupSets = [
  [MEMBER_GROUP],
  ['other-group'],
  [MEMBER_GROUP, 'other-group'],
  ['unrelated-group'],
  // Matching follows the column collation (case-insensitive), as the
  // inlined literal list does.
  [MEMBER_GROUP.toUpperCase()]
];

describeWithSeed(
  'IdentityNotificationsDb shared viewer-group table',
  [
    withIdentities([viewer, actor]),
    withWaves([publicWave, memberWave, memberSubwave, otherWave])
  ],
  () => {
    const repo = new IdentityNotificationsDb(() => sqlExecutor);
    // The repository keeps the executor it first saw, while each test
    // installs a new one; spy on the repository's own.
    const repoDb = () =>
      (repo as unknown as { readonly db: typeof sqlExecutor }).db;
    const originalNotifierActivated = process.env.USER_NOTIFIER_ACTIVATED;

    beforeEach(async () => {
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
      const notification = (
        wave_id: string | null,
        visibility_group_id: string | null
      ) => ({
        identity_id: viewer.profile_id!,
        additional_identity_id: actor.profile_id!,
        related_drop_id: null,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
        additional_data: {},
        visibility_group_id,
        wave_id
      });
      await repo.insertManyNotifications([
        notification(publicWave.id, null),
        notification(memberWave.id, MEMBER_GROUP),
        notification(memberSubwave.id, null),
        notification(otherWave.id, 'other-group'),
        notification(null, MEMBER_GROUP),
        notification(null, null)
      ]);
    });

    afterEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = originalNotifierActivated;
      resetViewerGroupsCteSupport();
    });

    const list = (eligible_group_ids: string[]) =>
      repo
        .findNotifications({
          identity_id: viewer.profile_id!,
          id_less_than: null,
          limit: 50,
          eligible_group_ids,
          cause: null,
          cause_exclude: null,
          unread_only: false
        })
        .then((rows) => rows.map((it) => it.id));
    const count = (eligibleGroupIds: string[]) =>
      repo.countUnreadNotificationsForIdentity(
        viewer.profile_id!,
        eligibleGroupIds
      );

    it('is used against the production collation', async () => {
      // oneOrNull reads through execute, so this sees both statements.
      const execute = jest.spyOn(repoDb(), 'execute');
      try {
        await list([MEMBER_GROUP]);
        await count([MEMBER_GROUP]);
        const statements = execute.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('identity_notifications'));
        expect(statements).toHaveLength(2);
        for (const sql of statements) {
          expect(sql).toContain('ntf_viewer_groups as (');
          expect(sql).not.toContain(':eligible');
        }
      } finally {
        execute.mockRestore();
      }
    });

    it('returns and counts exactly what the inlined list does', async () => {
      for (const groups of viewerGroupSets) {
        resetViewerGroupsCteSupport(false);
        const inlineList = await list(groups);
        const inlineCount = await count(groups);
        resetViewerGroupsCteSupport(true);
        expect({ groups, ids: await list(groups) }).toEqual({
          groups,
          ids: inlineList
        });
        expect({ groups, count: await count(groups) }).toEqual({
          groups,
          count: inlineCount
        });
      }
      // Members see the member wave, its subwave and the member-only row.
      resetViewerGroupsCteSupport(true);
      expect(await count([MEMBER_GROUP])).toBe(5);
      expect(await count(['unrelated-group'])).toBe(2);
    });

    it('reads the groups once per statement, not once per notification row', async () => {
      // oneOrNull reads through execute, so this sees both statements.
      const execute = jest.spyOn(repoDb(), 'execute');
      let statements: [string, Record<string, unknown>][] = [];
      try {
        await list([MEMBER_GROUP, 'other-group']);
        await count([MEMBER_GROUP, 'other-group']);
        statements = execute.mock.calls
          .filter(([sql]) => sql.includes('ntf_viewer_groups as ('))
          .map(([sql, params]) => [sql, params ?? {}]);
      } finally {
        execute.mockRestore();
      }
      expect(statements).toHaveLength(2);
      for (const [sql, params] of statements) {
        const [row] = await sqlExecutor.execute<Record<string, string>>(
          `explain format=tree ${sql}`,
          params
        );
        const plan = Object.values(row)[0];
        // One shared materialization of the JSON, reused by every reference.
        expect(plan.match(/Materialize table function/g)).toHaveLength(1);
        expect(plan).toContain('Materialize CTE ntf_viewer_groups');
        // No reference turns into a correlated EXISTS over the groups.
        expect(plan).not.toMatch(/visibility_group_id,\s*<exists>/);
      }
    });
  }
);
