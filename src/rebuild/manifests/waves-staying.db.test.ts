import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { insertRow as insert } from '@/tests/fixtures/rebuild-rows.fixture';
import {
  STAYING_METRICS_WHERE,
  STAYING_WHERE,
  stayingMetricsPlans,
  stayingWavesPlans
} from './waves-staying';

/** A moved wave the chain index holds by LegacyId (stored without dashes). */
const MOVED = '00000000-0000-4000-8000-00000000000a';
const MOVED_LEGACY = '0000000000004000800000000000000A';
/** A members-only wave with a private group, which the chain doesn't hold. */
const STAYING = '00000000-0000-4000-8000-00000000000b';
/** A wave made on the chain. */
const CHAIN_MADE = `0x${'c'.repeat(64)}`;

const GROUPS = {
  /** Public, the moved wave's admin group. */
  adminOfMoved: 'group-admin-of-moved',
  /** Private, the moved wave's read group (the chain holds it). */
  privateOfMoved: 'group-private-of-moved',
  /** Public, a moved wave's decision's submit group. */
  submitOfMoved: 'group-submit-of-moved',
  /** Public, named by nothing, but the mirror matched it to a chain group. */
  matched: 'group-matched',
  /** Private, the staying wave's read group. */
  privateOfStaying: 'group-private-of-staying',
  /** Public, named by nothing. */
  unnamed: 'group-unnamed',
  /** Made on the chain. */
  chainMade: `0x${'f'.repeat(64)}`
};

async function selected(table: string, column: string): Promise<string[]> {
  const where = STAYING_WHERE[table] ?? STAYING_METRICS_WHERE[table];
  const rows = await sqlExecutor.execute<Record<string, unknown>>(
    `select ${column} as v from ${table} where (${where})`
  );
  return rows.map((row) => String(row.v)).sort();
}

const COMPETITION_TABLES = [
  'competition_config_versions',
  'competition_capabilities',
  'competition_outcomes',
  'competition_outcome_distribution_items',
  'competition_lifecycle_events',
  'competition_entries',
  'competition_votes',
  'competition_entry_runtime',
  'competition_leaderboard_entries',
  'competition_decisions',
  'competition_decision_winners',
  'competition_winner_votes',
  'competition_outcome_awards',
  'competition_vote_history',
  'competition_score_history'
];

describeWithSeed('the staying waves plans', [], () => {
  beforeEach(async () => {
    // The mirror's match table, when its code isn't in this tree.
    await sqlExecutor.execute(
      `create table if not exists waves_chain_mirror_groups (
         chain_group_id varchar(100) not null primary key,
         group_id varchar(100) not null)`
    );
    await sqlExecutor.execute(`delete from waves_chain_mirror_groups`);
    await insert('chain_waves', {
      wave_id: `0x${'a'.repeat(64)}`,
      legacy_id: MOVED_LEGACY
    });
    await insert('chain_waves', { wave_id: CHAIN_MADE, legacy_id: null });
    await insert('waves', {
      id: MOVED,
      visibility_group_id: GROUPS.privateOfMoved,
      admin_group_id: GROUPS.adminOfMoved
    });
    await insert('waves', {
      id: STAYING,
      visibility_group_id: GROUPS.privateOfStaying
    });
    await insert('waves', { id: CHAIN_MADE });
    const group = (id: string, priv: boolean, lists: Record<string, string>) =>
      insert('community_groups', {
        id,
        visible: 1,
        is_private: priv ? 1 : 0,
        is_direct_message: 0,
        ...lists
      });
    await group(GROUPS.adminOfMoved, false, {
      profile_group_id: 'list-admin-of-moved'
    });
    await group(GROUPS.privateOfMoved, true, {});
    await group(GROUPS.submitOfMoved, false, {});
    await group(GROUPS.matched, false, {});
    await group(GROUPS.privateOfStaying, true, {
      profile_group_id: 'list-of-staying'
    });
    await group(GROUPS.unnamed, false, {
      excluded_profile_group_id: 'list-unnamed-out'
    });
    await group(GROUPS.chainMade, false, {});
    await insert('waves_chain_mirror_groups', {
      chain_group_id: `0x${'9'.repeat(64)}`,
      group_id: GROUPS.matched
    });
    for (const list of [
      'list-admin-of-moved',
      'list-of-staying',
      'list-unnamed-out'
    ]) {
      await insert('profile_groups', { profile_group_id: list });
    }
    await insert('competitions', {
      id: 'competition-moved',
      wave_id: MOVED,
      participation_config: JSON.stringify({ group_id: GROUPS.submitOfMoved }),
      voting_config: JSON.stringify({ group_id: null })
    });
    await insert('competitions', {
      id: 'competition-staying',
      wave_id: STAYING
    });
    await insert('competitions', {
      id: 'competition-chain',
      wave_id: CHAIN_MADE
    });
    for (const table of COMPETITION_TABLES) {
      for (const competition of [
        'competition-moved',
        'competition-staying',
        'competition-chain'
      ]) {
        await insert(table, { competition_id: competition });
      }
    }
    // Drop metrics: also a wave 6529.io deleted (no row, not on the chain),
    // which is the drop metrics' deleted-wave plan, not a staying one.
    for (const wave of [MOVED, STAYING, CHAIN_MADE, 'wave-deleted']) {
      await insert('wave_metrics', { wave_id: wave });
      await insert('wave_dropper_metrics', { wave_id: wave, dropper_id: 'p1' });
    }
    for (const wave of [MOVED, STAYING, CHAIN_MADE]) {
      await insert('waves_metadatas', { wave_id: wave });
      await insert('waves_archive', { id: wave });
      await insert('drops', { id: `drop-${wave}`, wave_id: wave });
      await insert('drops_parts', { drop_id: `drop-${wave}`, drop_part_id: 1 });
    }
  });

  it("select the staying wave's rows and none of a moved or chain-made wave's", async () => {
    expect(await selected('waves', 'id')).toEqual([STAYING]);
    expect(await selected('waves_metadatas', 'wave_id')).toEqual([STAYING]);
    expect(await selected('waves_archive', 'id')).toEqual([STAYING]);
    expect(await selected('drops', 'wave_id')).toEqual([STAYING]);
    expect(await selected('drops_parts', 'drop_id')).toEqual([
      `drop-${STAYING}`
    ]);
    expect(await selected('competitions', 'id')).toEqual([
      'competition-staying'
    ]);
    expect(await selected('wave_metrics', 'wave_id')).toEqual([STAYING]);
    expect(await selected('wave_dropper_metrics', 'wave_id')).toEqual([
      STAYING
    ]);
    for (const table of COMPETITION_TABLES) {
      expect([table, await selected(table, 'competition_id')]).toEqual([
        table,
        ['competition-staying']
      ]);
    }
  });

  it('select groups no moved wave or decision names, and none the chain holds', async () => {
    // The private group a moved wave reads with is held by the chain: never
    // excused. A group the mirror matched is never excused either.
    expect(await selected('community_groups', 'id')).toEqual(
      [GROUPS.privateOfStaying, GROUPS.unnamed].sort()
    );
    expect(await selected('profile_groups', 'profile_group_id')).toEqual(
      ['list-of-staying', 'list-unnamed-out'].sort()
    );
  });

  it("cover a staying wave's metrics only when the recount can't bring them back", async () => {
    // While the mirror doesn't write drops, the staying wave's live drop
    // stays through the rebuild, so its metrics are the recount's: no plan.
    for (const plan of stayingMetricsPlans({ dropsRebuilt: false })) {
      const rows = await sqlExecutor.execute(
        `select wave_id from ${plan.table} where (${plan.where})`
      );
      expect([plan.table, rows]).toEqual([plan.table, []]);
    }
    await sqlExecutor.execute(`delete from drops where wave_id = :id`, {
      id: STAYING
    });
    for (const plan of stayingMetricsPlans({ dropsRebuilt: false })) {
      const rows = await sqlExecutor.execute<{ wave_id: string }>(
        `select wave_id from ${plan.table} where (${plan.where})`
      );
      expect([plan.table, rows.map((r) => r.wave_id)]).toEqual([
        plan.table,
        [STAYING]
      ]);
    }
  });

  it('give every table the mirror writes that can hold staying rows a plan', () => {
    const plans = stayingWavesPlans(['waves', 'competitions', 'chain_docs']);
    expect(plans.map((plan) => plan.table)).toEqual(['waves', 'competitions']);
    expect(plans[0]).toMatchObject({
      until: '2026-12-15',
      change: 'private groups and waves on the 6529 chain'
    });
  });
});
