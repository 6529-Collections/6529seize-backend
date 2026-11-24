import { WAVES_WORLD_IDS } from '@/rebuild/world/waves/world-ids';
import { DropType } from '@/entities/IDrop';
import {
  legacyDropMetricsRows,
  mainStageWinnerRows,
  wavesLegacyRows,
  WAVES_LEGACY_TABLES
} from './waves-legacy.steps';

describe('the waves legacy seed rows', () => {
  it('are the same on every call: fixed ids, times and authors', () => {
    expect(JSON.stringify(wavesLegacyRows())).toEqual(
      JSON.stringify(wavesLegacyRows())
    );
  });

  it('write only tables the seed step declares', () => {
    const written = [
      ...Object.keys(wavesLegacyRows()),
      ...Object.keys(mainStageWinnerRows()),
      ...Object.keys(legacyDropMetricsRows([]))
    ];
    for (const table of written) {
      expect(WAVES_LEGACY_TABLES).toContain(table);
    }
  });

  it("hold the world's waves with their description drops", () => {
    const rows = wavesLegacyRows();
    const waves = rows.waves.map((w) => [w.id, w.description_drop_id]);
    expect(waves).toEqual([
      [WAVES_WORLD_IDS.publicWave, WAVES_WORLD_IDS.publicDescription],
      [WAVES_WORLD_IDS.membersWave, WAVES_WORLD_IDS.membersDescription],
      [WAVES_WORLD_IDS.rankWave, WAVES_WORLD_IDS.rankDescription]
    ]);
    const dropIds = new Set(rows.drops.map((d) => d.id));
    for (const [, description] of waves) {
      expect(dropIds.has(description as string)).toBe(true);
    }
    expect(rows.drops_parts).toHaveLength(rows.drops.length);
    expect(rows.community_groups.map((g) => g.id)).toEqual([
      WAVES_WORLD_IDS.group
    ]);
    expect(rows.community_groups[0]).not.toHaveProperty(
      'is_pure_profile_group'
    );
  });

  it('make the rank wave a Main Stage with one decided winner drop', () => {
    const rows = wavesLegacyRows();
    const winner = mainStageWinnerRows();
    const drop = rows.drops.find(
      (d) => d.id === WAVES_WORLD_IDS.rankWinnerDrop
    );
    expect(drop).toMatchObject({
      wave_id: WAVES_WORLD_IDS.rankWave,
      drop_type: DropType.WINNER
    });
    expect(winner.competition_capabilities).toEqual([
      expect.objectContaining({
        wave_id: WAVES_WORLD_IDS.rankWave,
        capability: 'MAIN_STAGE'
      })
    ]);
    const [entry] = winner.competition_entries;
    const [decision] = winner.competition_decisions;
    expect(entry).toMatchObject({
      drop_id: WAVES_WORLD_IDS.rankWinnerDrop,
      status: 'WINNER',
      decision_id: decision.id
    });
    expect(decision).toMatchObject({ status: 'COMPLETED' });
    expect(winner.competition_decision_winners).toEqual([
      expect.objectContaining({
        entry_id: entry.id,
        decision_id: decision.id,
        competition_id: entry.competition_id,
        rank: 1
      })
    ]);
    expect(JSON.stringify(mainStageWinnerRows())).toEqual(
      JSON.stringify(winner)
    );
  });
});

describe('the waves legacy seed drop metrics', () => {
  const drop = (
    wave_id: string,
    author_id: string,
    drop_type: DropType,
    created_at: number
  ) => ({ wave_id, author_id, drop_type, created_at });

  it("count chat and participatory drops as 6529.io's inserts do, and keep the latest", () => {
    const metrics = legacyDropMetricsRows([
      drop('w1', 'a', DropType.CHAT, 10),
      drop('w1', 'b', DropType.CHAT, 30),
      drop('w1', 'a', DropType.PARTICIPATORY, 20),
      drop('w1', 'b', DropType.WINNER, 40),
      drop('w2', 'a', DropType.CHAT, 5)
    ]);
    expect(metrics.wave_metrics).toEqual([
      {
        wave_id: 'w1',
        drops_count: 2,
        participatory_drops_count: 1,
        latest_drop_timestamp: 40
      },
      {
        wave_id: 'w2',
        drops_count: 1,
        participatory_drops_count: 0,
        latest_drop_timestamp: 5
      }
    ]);
    expect(metrics.wave_dropper_metrics).toEqual([
      {
        wave_id: 'w1',
        dropper_id: 'a',
        drops_count: 1,
        participatory_drops_count: 1,
        latest_drop_timestamp: 20
      },
      {
        wave_id: 'w1',
        dropper_id: 'b',
        drops_count: 1,
        participatory_drops_count: 0,
        latest_drop_timestamp: 40
      },
      {
        wave_id: 'w2',
        dropper_id: 'a',
        drops_count: 1,
        participatory_drops_count: 0,
        latest_drop_timestamp: 5
      }
    ]);
  });

  it('give every wave with a seeded drop a row', () => {
    const rows = wavesLegacyRows();
    const metrics = legacyDropMetricsRows(
      rows.drops.map((d) => ({
        wave_id: String(d.wave_id),
        author_id: String(d.author_id),
        drop_type: String(d.drop_type),
        created_at: Number(d.created_at)
      }))
    );
    expect(metrics.wave_metrics.map((row) => row.wave_id).sort()).toEqual(
      Array.from(new Set(rows.drops.map((d) => String(d.wave_id)))).sort()
    );
  });
});
