const migration = require('../../migrations/20260713150000-backfill-meme-card-drop-mappings');

describe('Meme card drop mappings backfill migration', () => {
  const originalMainStageWaveId = process.env.MAIN_STAGE_WAVE_ID;

  afterEach(() => {
    if (originalMainStageWaveId === undefined) {
      delete process.env.MAIN_STAGE_WAVE_ID;
    } else {
      process.env.MAIN_STAGE_WAVE_ID = originalMainStageWaveId;
    }
  });

  it('does nothing when the Main Stage wave is not configured', async () => {
    delete process.env.MAIN_STAGE_WAVE_ID;
    const db = { runSql: jest.fn() };

    await migration.up(db);

    expect(db.runSql).not.toHaveBeenCalled();
  });

  it('builds a sequential mapping backward and forward from claim anchors', async () => {
    process.env.MAIN_STAGE_WAVE_ID = 'main-stage-wave';
    const mappings = new Map<number, string>();
    const winners = [
      { drop_id: 'drop-1', decision_time: 1, ranking: 1 },
      { drop_id: 'drop-2', decision_time: 2, ranking: 1 },
      { drop_id: 'drop-3', decision_time: 3, ranking: 1 }
    ];
    const runSql = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('join minting_claims')) {
        return [{ drop_id: 'drop-2', claim_id: 521 }];
      }
      if (sql.includes('select drop_id, decision_time, ranking')) {
        return winners;
      }
      if (sql.includes('insert into meme_card_drop_mappings')) {
        mappings.set(Number(params?.[0]), String(params?.[1]));
        return [];
      }
      if (sql.includes('from meme_card_drop_mappings')) {
        const memeCardId = Number(params?.[0]);
        const dropId = String(params?.[1]);
        return Array.from(mappings, ([id, mappedDropId]) => ({
          meme_card_id: id,
          drop_id: mappedDropId
        })).filter(
          (mapping) =>
            mapping.meme_card_id === memeCardId || mapping.drop_id === dropId
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await migration.up({ runSql });

    expect(Object.fromEntries(mappings)).toEqual({
      520: 'drop-1',
      521: 'drop-2',
      522: 'drop-3'
    });
  });

  it('fails before writing when claim anchors imply different sequences', async () => {
    process.env.MAIN_STAGE_WAVE_ID = 'main-stage-wave';
    const runSql = jest
      .fn()
      .mockResolvedValueOnce([
        { drop_id: 'drop-1', claim_id: 520 },
        { drop_id: 'drop-3', claim_id: 525 }
      ])
      .mockResolvedValueOnce([
        { drop_id: 'drop-1', decision_time: 1, ranking: 1 },
        { drop_id: 'drop-2', decision_time: 2, ranking: 1 },
        { drop_id: 'drop-3', decision_time: 3, ranking: 1 }
      ]);

    await expect(migration.up({ runSql })).rejects.toThrow(
      'Minting claim anchors do not form one sequential Main Stage mapping'
    );
    expect(runSql).toHaveBeenCalledTimes(2);
  });
});
