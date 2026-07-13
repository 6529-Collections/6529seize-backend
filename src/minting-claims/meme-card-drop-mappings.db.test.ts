import {
  MEME_CARD_DROP_MAPPINGS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  memeCardDropMappingsDb,
  MemeCardDropMappingsDb
} from './meme-card-drop-mappings.db';

describe('MemeCardDropMappingsDb', () => {
  const ctx: RequestContext = { timer: undefined };

  it('returns mapped Meme card IDs by drop ID', async () => {
    const execute = jest.fn().mockResolvedValue([
      { drop_id: 'drop-1', meme_card_id: 520 },
      { drop_id: 'drop-2', meme_card_id: 521 }
    ]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    const result = await repo.findMemeCardIdsByDropIds(
      ['drop-1', 'drop-2'],
      ctx
    );

    expect(result).toEqual({ 'drop-1': 520, 'drop-2': 521 });
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`from ${MEME_CARD_DROP_MAPPINGS_TABLE}`);
    expect(params).toEqual({ dropIds: ['drop-1', 'drop-2'] });
  });

  it('inserts a mapping only for a configured Main Stage winner', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ drop_id: 'drop-1', meme_card_id: 521 }]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', ctx);

    const [insertSql, insertParams] = execute.mock.calls[0];
    expect(insertSql).toContain(`insert into ${MEME_CARD_DROP_MAPPINGS_TABLE}`);
    expect(insertSql).toContain(
      `from ${WAVES_DECISION_WINNER_DROPS_TABLE} winner`
    );
    expect(insertSql).toContain('winner.wave_id = :mainStageWaveId');
    expect(insertParams).toEqual({
      dropId: 'drop-1',
      memeCardId: 521,
      mainStageWaveId: 'main-stage-wave'
    });
  });

  it('rejects a conflicting Meme card for the same drop', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ drop_id: 'drop-1', meme_card_id: 520 }]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', ctx)
    ).rejects.toThrow(
      'Cannot assign Meme card 521 to drop drop-1: already assigned to Meme card 520'
    );
  });

  it('rejects a Meme card already mapped to another drop', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ drop_id: 'drop-2', meme_card_id: 521 }]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', ctx)
    ).rejects.toThrow(
      'Cannot assign Meme card 521 to drop drop-1: already assigned to drop drop-2'
    );
  });

  it('rejects a drop that is not a configured Main Stage winner', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', ctx)
    ).rejects.toThrow(
      'Cannot assign Meme card 521 to drop drop-1: Main Stage winner not found'
    );
  });
});

describeWithSeed(
  'MemeCardDropMappingsDb integration',
  {
    table: WAVES_DECISION_WINNER_DROPS_TABLE,
    rows: [
      {
        decision_time: 1,
        drop_id: 'main-stage-drop',
        ranking: 1,
        final_vote: 1,
        prizes: [],
        wave_id: 'main-stage-wave'
      }
    ]
  },
  () => {
    const ctx: RequestContext = { timer: undefined };

    it('persists an idempotent one-to-one Main Stage mapping', async () => {
      await memeCardDropMappingsDb.setMemeCardIdForDrop(
        'main-stage-drop',
        521,
        'main-stage-wave',
        ctx
      );
      await memeCardDropMappingsDb.setMemeCardIdForDrop(
        'main-stage-drop',
        521,
        'main-stage-wave',
        ctx
      );

      await expect(
        memeCardDropMappingsDb.findMemeCardIdsByDropIds(
          ['main-stage-drop'],
          ctx
        )
      ).resolves.toEqual({ 'main-stage-drop': 521 });
    });

    it('does not map a winner from another wave', async () => {
      await expect(
        memeCardDropMappingsDb.setMemeCardIdForDrop(
          'main-stage-drop',
          521,
          'other-wave',
          ctx
        )
      ).rejects.toThrow('Main Stage winner not found');
    });
  }
);
