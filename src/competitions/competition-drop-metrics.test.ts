import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_DROPPER_METRICS_TABLE
} from '@/constants';
import { DropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const primary = '10000000-0000-4000-8000-000000000001',
  sibling = '10000000-0000-4000-8000-000000000002';
const memberships = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    competition_id: primary,
    drop_id: 'primary-active',
    status: 'ACTIVE'
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    competition_id: primary,
    drop_id: 'primary-winner',
    status: 'WINNER'
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    competition_id: sibling,
    drop_id: 'sibling-active',
    status: 'ACTIVE'
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    competition_id: primary,
    drop_id: 'primary-withdrawn',
    status: 'WITHDRAWN'
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    competition_id: primary,
    drop_id: 'primary-disqualified',
    status: 'DISQUALIFIED'
  }
];
const sharedCategories = [
  { id: 'chat', drop_type: 'CHAT' },
  { id: 'primary-active', drop_type: 'WINNER' },
  { id: 'primary-winner', drop_type: 'PARTICIPATORY' },
  { id: 'sibling-active', drop_type: 'PARTICIPATORY' },
  { id: 'primary-withdrawn', drop_type: 'PARTICIPATORY' },
  { id: 'primary-disqualified', drop_type: 'WINNER' },
  { id: 'orphan-participatory', drop_type: 'PARTICIPATORY' },
  { id: 'orphan-winner', drop_type: 'WINNER' },
  { id: 'orphan-native-content', drop_type: 'COMPETITION' }
];
describeWithSeed(
  'wave compatibility metrics from native entry lifecycle',
  [
    {
      table: COMPETITIONS_TABLE,
      rows: [primary, sibling].map((id) => ({
        id,
        wave_id: 'hub',
        legacy_wave_id: id === primary ? 'hub' : null,
        storage_mode: 'NATIVE',
        execution_mode: 'ACTIVE',
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        title: id,
        participation_config: {},
        voting_config: {},
        decision_config: {},
        winner_config: {},
        outcome_config: [],
        created_at: 1,
        updated_at: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: memberships.map((entry) => ({
        ...entry,
        wave_id: 'hub',
        submitter_id: 'author',
        config_version: 1,
        submitted_at: 1
      }))
    },
    {
      table: DROPS_TABLE,
      rows: sharedCategories.map((category, index) => ({
        ...category,
        wave_id: 'hub',
        author_id: 'author',
        created_at: index + 1,
        parts_count: 1
      }))
    },
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        {
          wave_id: 'hub',
          drops_count: 99,
          subscribers_count: 0,
          participatory_drops_count: 99,
          latest_drop_timestamp: 99
        }
      ]
    },
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: 'hub',
          dropper_id: 'author',
          drops_count: 99,
          participatory_drops_count: 99,
          latest_drop_timestamp: 99
        }
      ]
    }
  ],
  () => {
    const repository = new DropsDb(() => sqlExecutor);
    it('retains orphan categories while native status overrides stale shared categories', async () => {
      await repository.resyncDropCountsForWaves(['hub'], {});
      const [metrics] = await sqlExecutor.execute(
        `select drops_count,participatory_drops_count,latest_drop_timestamp from ${WAVE_METRICS_TABLE} where wave_id='hub'`
      );
      expect(metrics).toEqual({
        drops_count: 1,
        participatory_drops_count: 2,
        latest_drop_timestamp: 9
      });
      const [dropper] = await sqlExecutor.execute(
        `select drops_count,participatory_drops_count from ${WAVE_DROPPER_METRICS_TABLE} where wave_id='hub'`
      );
      expect(dropper).toEqual({ drops_count: 1, participatory_drops_count: 2 });
    });
    it('releases the old participation counter when a native primary entry wins', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER' where id=:id`,
        { id: memberships[0].id }
      );
      await repository.resyncParticipatoryDropCountsForWaves(['hub'], {});
      const [row] = await sqlExecutor.execute(
        `select participatory_drops_count from ${WAVE_METRICS_TABLE} where wave_id='hub'`
      );
      expect(row.participatory_drops_count).toBe(1);
    });
    it('keeps orphan participation and winner deletion deltas consistent with full resync', async () => {
      await repository.resyncDropCountsForWaves(['hub'], {});
      for (const dropType of [DropType.PARTICIPATORY, DropType.WINNER]) {
        const dropId =
          dropType === DropType.PARTICIPATORY
            ? 'orphan-participatory'
            : 'orphan-winner';
        await repository.deleteDropEntity(dropId, {});
        await repository.applyDeletedDropMetricsDelta(
          {
            wave_id: 'hub',
            author_id: 'author',
            drop_type: dropType
          },
          {}
        );
        const before = await sqlExecutor.execute(
          `select drops_count,participatory_drops_count from ${WAVE_METRICS_TABLE} where wave_id='hub'`
        );
        await repository.resyncDropCountsForWaves(['hub'], {});
        const after = await sqlExecutor.execute(
          `select drops_count,participatory_drops_count from ${WAVE_METRICS_TABLE} where wave_id='hub'`
        );
        expect(before).toEqual([
          { drops_count: 1, participatory_drops_count: 1 }
        ]);
        expect(after).toEqual(before);
      }
    });
  }
);
