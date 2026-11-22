import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { CHAIN_DAY_STEPS, TdhChainDaysDb } from './tdh-chain-days.db';

describeWithSeed(
  'TdhChainDaysDb',
  [
    {
      table: 'tdh_blocks',
      rows: [
        { block_number: 500, timestamp: '2026-10-10 23:59:59', merkle_root: null },
        { block_number: 700, timestamp: '2026-10-11 23:59:59', merkle_root: null }
      ]
    },
    { table: 'uploads', rows: [{ date: '20261011', block: 500, tdh: 'u', timestamp: 0 }] }
  ],
  () => {
    const db = new TdhChainDaysDb(() => sqlExecutor);
    const day = chainDayFixture();
    const save = (
      cycleDay: number,
      mode: 'SHADOW' | 'CHAIN',
      status: 'FAILED' | 'SKIPPED' | 'WRITTEN' | 'INGESTED',
      deferredKeys: string[] = []
    ) =>
      db.save({
        day: { ...day, header: { ...day.header, cycleDay } },
        mode,
        status,
        verdict: status === 'FAILED' ? null : 'MATCH',
        summary: { status },
        deferredKeys,
        now: cycleDay
      });

    it('has no day before the first ingest', async () => {
      expect(await db.latest()).toBeNull();
      expect(await db.latestWritten()).toBeNull();
    });

    it('saves, overwrites and returns the newest day and the newest written', async () => {
      await save(20737, 'CHAIN', 'WRITTEN', ['k1']);
      await save(20736, 'SHADOW', 'FAILED');
      await save(20738, 'CHAIN', 'FAILED');
      expect(await db.latest()).toMatchObject({
        cycleDay: 20738,
        mode: 'CHAIN',
        status: 'FAILED',
        stepsDone: []
      });
      expect(await db.latestWritten()).toMatchObject({
        cycleDay: 20737,
        status: 'WRITTEN',
        deferredKeys: ['k1'],
        boundary: 20737 * 86400,
        block: day.header.cutoffNumber
      });
    });

    it('marks steps done and ends the day INGESTED with the last one', async () => {
      await save(20737, 'CHAIN', 'WRITTEN');
      expect(await db.markStepDone(20737, 'history', 1)).toEqual(['history']);
      expect(await db.markStepDone(20737, 'nfts', 2)).toEqual(['nfts', 'history']);
      for (const step of CHAIN_DAY_STEPS) await db.markStepDone(20737, step, 3);
      expect(await db.latest()).toMatchObject({
        status: 'INGESTED',
        stepsDone: [...CHAIN_DAY_STEPS]
      });
      await save(20737, 'CHAIN', 'WRITTEN');
      expect((await db.latest())!.stepsDone).toEqual([]);
    });

    it('records and finds the day files', async () => {
      await save(20737, 'CHAIN', 'WRITTEN');
      expect(await db.dayFilesPublished(20737)).toBe(false);
      await db.saveDayFiles(20737, {
        walletsUrl: 'https://arweave.net/w',
        walletsSha256: 'a'.repeat(64),
        tokensUrl: null,
        tokensSha256: null
      });
      expect(await db.dayFilesPublished(20737)).toBe(true);
    });

    it('reads the newest TDH block, the uploads and the narrowest key column', async () => {
      expect(await db.latestTdhBlock()).toBe(700);
      expect(await db.uploadExists(false, '20261011', 500)).toBe(true);
      expect(await db.uploadExists(true, '20261011', 500)).toBe(false);
      expect(await db.uploadExists(false, '20261012', 700)).toBe(false);
      expect(await db.consolidationKeyWidth()).toBe(200);
    });
  }
);
