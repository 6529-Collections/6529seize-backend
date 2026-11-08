import 'reflect-metadata';
import {
  DROPS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { WavesApiDb } from './waves.api.db';

const MEMBER_GROUP = 'fs-member-group';
const viewer = anIdentity(
  {},
  {
    consolidation_key: 'fs-viewer',
    profile_id: 'fs-viewer',
    primary_address: 'fs-viewer-wallet',
    handle: 'fs-viewer'
  }
);
const poster = anIdentity(
  {},
  {
    consolidation_key: 'fs-poster',
    profile_id: 'fs-poster',
    primary_address: 'fs-poster-wallet',
    handle: 'fs-poster'
  }
);

const publicParent = aWave({}, { id: 'fs-public', serial_no: 1, name: 'P' });
const memberParent = aWave(
  { visibility_group_id: MEMBER_GROUP },
  { id: 'fs-member', serial_no: 2, name: 'M' }
);
const otherParent = aWave(
  { visibility_group_id: 'fs-other-group' },
  { id: 'fs-other', serial_no: 3, name: 'O' }
);
const children = [
  aWave(
    { parent_wave_id: publicParent.id },
    { id: 'fs-public-open', serial_no: 4, name: 'PO' }
  ),
  aWave(
    { parent_wave_id: publicParent.id, visibility_group_id: MEMBER_GROUP },
    { id: 'fs-public-members', serial_no: 5, name: 'PM' }
  ),
  aWave(
    { parent_wave_id: memberParent.id },
    { id: 'fs-member-open', serial_no: 6, name: 'MO' }
  ),
  aWave(
    { parent_wave_id: otherParent.id },
    { id: 'fs-other-open', serial_no: 7, name: 'OO' }
  )
];
const parents = [publicParent, memberParent, otherParent];

const viewerGroupSets = [
  [MEMBER_GROUP],
  ['fs-other-group'],
  [MEMBER_GROUP, 'fs-other-group'],
  ['fs-unrelated-group'],
  // Matching follows the column collation (case-insensitive), as the
  // inlined literal list does.
  [MEMBER_GROUP.toUpperCase()]
];

describeWithSeed(
  'WavesApiDb followed-subwave contexts with the shared viewer-group table',
  [
    withIdentities([viewer, poster]),
    withWaves([...parents, ...children]),
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: children.map((child) => ({
        subscriber_id: viewer.profile_id!,
        target_id: child.id,
        target_type: ActivityEventTargetType.WAVE,
        target_action: ActivityEventAction.DROP_CREATED,
        wave_id: child.id,
        subscribed_to_all_drops: false
      }))
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: children.map((child) => ({
        wave_id: child.id,
        reader_id: viewer.profile_id!,
        latest_read_timestamp: 100,
        muted: false
      }))
    },
    {
      table: DROPS_TABLE,
      rows: children.map((child, index) => ({
        id: `fs-unread-${child.id}`,
        serial_no: 100 + index,
        wave_id: child.id,
        author_id: poster.profile_id!,
        created_at: 200 + index,
        updated_at: null,
        title: null,
        parts_count: 1,
        reply_to_drop_id: null,
        reply_to_part_id: null,
        drop_type: DropType.CHAT,
        signature: null,
        hide_link_preview: false
      }))
    }
  ],
  () => {
    const repo = new WavesApiDb(() => sqlExecutor);
    // The repository keeps the executor it first saw, while each test
    // installs a new one; spy on the repository's own.
    const repoDb = () =>
      (repo as unknown as { readonly db: typeof sqlExecutor }).db;
    const ctx: RequestContext = { timer: undefined };
    const contexts = (eligibleGroups: string[]) =>
      repo.findFollowedSubwaveOverviewContextsByParentWaveId(
        {
          identityId: viewer.profile_id!,
          parentWaveIds: parents.map((it) => it.id),
          eligibleGroups
        },
        ctx
      );

    afterEach(() => resetViewerGroupsCteSupport());

    it('returns exactly what the inlined list does', async () => {
      for (const groups of viewerGroupSets) {
        resetViewerGroupsCteSupport(false);
        const inline = await contexts(groups);
        resetViewerGroupsCteSupport(true);
        expect({ groups, contexts: await contexts(groups) }).toEqual({
          groups,
          contexts: inline
        });
      }
      resetViewerGroupsCteSupport(true);
      const members = await contexts([MEMBER_GROUP]);
      // Members see both public-parent subwaves and the member parent's.
      expect(members[publicParent.id]?.followed_subwaves_count).toBe(2);
      expect(members[memberParent.id]?.followed_subwaves_count).toBe(1);
      expect(members[otherParent.id]).toBeUndefined();
      const outsiders = await contexts(['fs-unrelated-group']);
      expect(outsiders[publicParent.id]?.followed_subwaves_count).toBe(1);
      expect(outsiders[memberParent.id]).toBeUndefined();
    });

    it('reads the groups once per statement, not once per wave row', async () => {
      resetViewerGroupsCteSupport();
      const execute = jest.spyOn(repoDb(), 'execute');
      let statements: [string, Record<string, unknown>][] = [];
      try {
        await contexts([MEMBER_GROUP, 'fs-other-group']);
        statements = execute.mock.calls
          .filter(([sql]) => sql.includes('fs_viewer_groups as ('))
          .map(([sql, params]) => [sql, params ?? {}]);
      } finally {
        execute.mockRestore();
      }
      // The activity aggregate and the unread aggregate.
      expect(statements).toHaveLength(2);
      for (const [sql, params] of statements) {
        const [row] = await sqlExecutor.execute<Record<string, string>>(
          `explain format=tree ${sql}`,
          params
        );
        const plan = Object.values(row)[0];
        // One shared materialization of the JSON, reused by every reference.
        expect(plan.match(/Materialize table function/g)).toHaveLength(1);
        expect(plan).toContain('Materialize CTE fs_viewer_groups');
        // No reference turns into a correlated EXISTS over the groups.
        expect(plan).not.toMatch(/visibility_group_id,\s*<exists>/);
      }
    });
  }
);
