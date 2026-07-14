import {
  MEME_CARD_DROP_MAPPINGS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Timer } from '@/time';
import fc from 'fast-check';
import {
  memeCardDropMappingsDb,
  MemeCardDropMappingsDb
} from './meme-card-drop-mappings.db';

describe('MemeCardDropMappingsDb', () => {
  const ctx: RequestContext = {
    timer: undefined,
    connection: {} as RequestContext['connection']
  };

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
    expect(sql).toContain(`from ${MEME_CARD_DROP_MAPPINGS_TABLE} mapping`);
    expect(sql).toContain(`join ${WAVES_DECISION_WINNER_DROPS_TABLE} winner`);
    expect(sql).toContain('having count(scope_winner.wave_id) = count(*)');
    expect(sql).toContain('count(distinct scope_winner.wave_id) = 1');
    expect(params).toEqual({ dropIds: ['drop-1', 'drop-2'] });
  });

  it('returns the drop mapping for a Meme card ID', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([{ drop_id: 'drop-1', meme_card_id: '521' }]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);
    const timer = new Timer('test');
    const timerStart = jest.spyOn(timer, 'start');
    const timerStop = jest.spyOn(timer, 'stop');

    await expect(repo.findByMemeCardId(521, { timer })).resolves.toEqual({
      drop_id: 'drop-1',
      meme_card_id: 521
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('where meme_card_id = :memeCardId'),
      { memeCardId: 521 },
      undefined
    );
    expect(timerStart).toHaveBeenCalledWith(
      'MemeCardDropMappingsDb->findByMemeCardId'
    );
    expect(timerStop).toHaveBeenCalledWith(
      'MemeCardDropMappingsDb->findByMemeCardId'
    );
  });

  it('returns null when a Meme card has no drop mapping', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.findByMemeCardId(1, { timer: undefined })
    ).resolves.toBeNull();
  });

  it('checks whether a drop is a winner in the configured Main Stage wave', async () => {
    const execute = jest.fn().mockResolvedValue([{ found: 1 }]);
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);
    const timer = new Timer('test');
    const timerStart = jest.spyOn(timer, 'start');
    const timerStop = jest.spyOn(timer, 'stop');
    const transactionalCtx: RequestContext = { ...ctx, timer };

    await expect(
      repo.isMainStageWinnerDrop('drop-1', 'main-stage-wave', transactionalCtx)
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('wave_id = :mainStageWaveId'),
      { dropId: 'drop-1', mainStageWaveId: 'main-stage-wave' },
      { wrappedConnection: transactionalCtx.connection }
    );
    expect(timerStart).toHaveBeenCalledWith(
      'MemeCardDropMappingsDb->isMainStageWinnerDrop'
    );
    expect(timerStop).toHaveBeenCalledWith(
      'MemeCardDropMappingsDb->isMainStageWinnerDrop'
    );
  });

  it('requires the Main Stage winner check to share the caller transaction', async () => {
    const execute = jest.fn();
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.isMainStageWinnerDrop('drop-1', 'main-stage-wave', {
        timer: undefined
      })
    ).rejects.toThrow('Meme card mappings can only be saved in a transaction');
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires runtime mapping writes to share the caller transaction', async () => {
    const execute = jest.fn();
    const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);

    await expect(
      repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', {
        timer: undefined
      })
    ).rejects.toThrow('Meme card mappings can only be saved in a transaction');
    expect(execute).not.toHaveBeenCalled();
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

  it('preserves mapping outcomes across generated IDs and conflict types', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom('exact', 'drop-conflict', 'card-conflict', 'missing'),
        async (dropId, memeCardId, outcome) => {
          const otherDropId = `${dropId}-other`;
          const existingMemeCardId = memeCardId + 1;
          const rows =
            outcome === 'exact'
              ? [{ drop_id: dropId, meme_card_id: memeCardId }]
              : outcome === 'drop-conflict'
                ? [{ drop_id: dropId, meme_card_id: existingMemeCardId }]
                : outcome === 'card-conflict'
                  ? [{ drop_id: otherDropId, meme_card_id: memeCardId }]
                  : [];
          const execute = jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(rows);
          const repo = new MemeCardDropMappingsDb(() => ({ execute }) as any);
          const promise = repo.setMemeCardIdForDrop(
            dropId,
            memeCardId,
            'main-stage-wave',
            ctx
          );

          if (outcome === 'exact') {
            await expect(promise).resolves.toBeUndefined();
          } else if (outcome === 'drop-conflict') {
            await expect(promise).rejects.toThrow(
              `already assigned to Meme card ${existingMemeCardId}`
            );
          } else if (outcome === 'card-conflict') {
            await expect(promise).rejects.toThrow(
              `already assigned to drop ${otherDropId}`
            );
          } else {
            await expect(promise).rejects.toThrow(
              'Main Stage winner not found'
            );
          }
        }
      ),
      { numRuns: 40 }
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
      },
      {
        decision_time: 2,
        drop_id: 'other-main-stage-drop',
        ranking: 1,
        final_vote: 1,
        prizes: [],
        wave_id: 'main-stage-wave'
      },
      {
        decision_time: 3,
        drop_id: 'other-wave-drop',
        ranking: 1,
        final_vote: 1,
        prizes: [],
        wave_id: 'other-wave'
      }
    ]
  },
  () => {
    it('persists an idempotent one-to-one Main Stage mapping', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { timer: undefined, connection };
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
        }
      );
    });

    it('does not map a winner from another wave', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await expect(
            memeCardDropMappingsDb.setMemeCardIdForDrop(
              'main-stage-drop',
              521,
              'other-wave',
              { timer: undefined, connection }
            )
          ).rejects.toThrow('Main Stage winner not found');
        }
      );
    });

    it('fails closed when the mapping table contains more than one wave', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { timer: undefined, connection };
          await memeCardDropMappingsDb.setMemeCardIdForDrop(
            'main-stage-drop',
            521,
            'main-stage-wave',
            ctx
          );
          await sqlExecutor.execute(
            `insert into ${MEME_CARD_DROP_MAPPINGS_TABLE} (meme_card_id, drop_id)
             values (:memeCardId, :dropId)`,
            { memeCardId: 522, dropId: 'other-wave-drop' },
            { wrappedConnection: connection }
          );

          await expect(
            memeCardDropMappingsDb.findMemeCardIdsByDropIds(
              ['main-stage-drop', 'other-wave-drop'],
              ctx
            )
          ).resolves.toEqual({});
          await expect(
            memeCardDropMappingsDb.findByMemeCardId(521, ctx)
          ).resolves.toBeNull();
        }
      );
    });

    it('translates a real drop-side unique conflict', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { timer: undefined, connection };
          await memeCardDropMappingsDb.setMemeCardIdForDrop(
            'main-stage-drop',
            520,
            'main-stage-wave',
            ctx
          );

          await expect(
            memeCardDropMappingsDb.setMemeCardIdForDrop(
              'main-stage-drop',
              521,
              'main-stage-wave',
              ctx
            )
          ).rejects.toThrow(
            'Cannot assign Meme card 521 to drop main-stage-drop: already assigned to Meme card 520'
          );
        }
      );
    });

    it('translates a double unique-key conflict', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { timer: undefined, connection };
          await memeCardDropMappingsDb.setMemeCardIdForDrop(
            'main-stage-drop',
            520,
            'main-stage-wave',
            ctx
          );
          await memeCardDropMappingsDb.setMemeCardIdForDrop(
            'other-main-stage-drop',
            521,
            'main-stage-wave',
            ctx
          );

          await expect(
            memeCardDropMappingsDb.setMemeCardIdForDrop(
              'other-main-stage-drop',
              520,
              'main-stage-wave',
              ctx
            )
          ).rejects.toThrow(
            'Cannot assign Meme card 520 to drop other-main-stage-drop: already assigned to Meme card 521'
          );
        }
      );
    });
  }
);
