import { WAVES_WORLD_IDS } from '@/rebuild/world/waves/world-ids';
import { DropType } from '@/entities/IDrop';
import {
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
      ...Object.keys(mainStageWinnerRows())
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
