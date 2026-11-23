import 'reflect-metadata';
import { CONSOLIDATION_KEY_LENGTH } from '@/constants';
import { fetchBlocks } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { TdhChainDaysDb } from './tdh-chain-days.db';

describeWithSeed(
  'TdhChainDaysDb',
  [
    {
      table: 'tdh_blocks',
      rows: [
        {
          block_number: 500,
          timestamp: '2026-10-10 23:59:59',
          merkle_root: null
        },
        {
          block_number: 700,
          timestamp: '2026-10-11 23:59:59',
          merkle_root: null
        }
      ]
    },
    {
      table: 'uploads',
      rows: [
        { date: '20261011', block: 500, tdh: 'u', timestamp: 0 },
        { date: '20261010', block: 400, tdh: 'v', timestamp: 0 }
      ]
    }
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
      expect(await db.pendingDays()).toEqual([]);
    });

    it('saves, overwrites and lists the days whose steps are due, oldest first', async () => {
      await save(20737, 'CHAIN', 'WRITTEN', ['k1']);
      await save(20736, 'SHADOW', 'FAILED');
      await save(20738, 'CHAIN', 'FAILED');
      await save(20735, 'CHAIN', 'WRITTEN');
      expect(await db.latest()).toMatchObject({
        cycleDay: 20738,
        mode: 'CHAIN',
        status: 'FAILED',
        stepsDone: [],
        superseded: false,
        redoFailed: false
      });
      expect(await db.get(20737)).toMatchObject({
        cycleDay: 20737,
        status: 'WRITTEN'
      });
      expect(await db.get(20739)).toBeNull();
      expect((await db.pendingDays()).map((r) => r.cycleDay)).toEqual([
        20735, 20737
      ]);
      expect((await db.pendingDays())[1]).toMatchObject({
        status: 'WRITTEN',
        deferredKeys: ['k1'],
        boundary: 20737 * 86400,
        block: day.header.cutoffNumber
      });
    });

    it('keeps the record of a written day when a later attempt at it fails or is skipped', async () => {
      await save(20737, 'CHAIN', 'INGESTED', ['k1']);
      expect(await save(20737, 'CHAIN', 'FAILED')).toBe(false);
      expect(await db.latest()).toMatchObject({
        status: 'INGESTED',
        deferredKeys: ['k1'],
        redoFailed: true
      });
      expect(await save(20737, 'CHAIN', 'SKIPPED')).toBe(false);
      expect(await db.latest()).toMatchObject({
        status: 'INGESTED',
        redoFailed: false
      });
      // A new write of the day replaces it and clears the note.
      expect(await save(20737, 'CHAIN', 'WRITTEN')).toBe(true);
      expect(await db.latest()).toMatchObject({
        status: 'WRITTEN',
        deferredKeys: [],
        redoFailed: false
      });
      // A failed SHADOW day is replaced as before.
      await save(20739, 'SHADOW', 'INGESTED');
      expect(await save(20739, 'SHADOW', 'FAILED')).toBe(true);
      expect(await db.latest()).toMatchObject({ status: 'FAILED' });
    });

    it('marks steps done or given up and ends the day INGESTED once each is one or the other', async () => {
      await save(20737, 'CHAIN', 'WRITTEN');
      expect(await db.markStepDone(20737, 'history', 1)).toEqual({
        done: ['history'],
        givenUp: []
      });
      expect(await db.recordStepFailure(20737, 'uploads', 2)).toBe(1);
      expect(await db.recordStepFailure(20737, 'uploads', 3)).toBe(2);
      expect(await db.giveUpSteps(20737, ['uploads'], 4)).toEqual({
        done: ['history'],
        givenUp: ['uploads']
      });
      for (const step of ['nfts', 'metrics', 'dayFiles'] as const) {
        await db.markStepDone(20737, step, 5);
      }
      expect(await db.latest()).toMatchObject({
        status: 'INGESTED',
        stepsDone: ['nfts', 'history', 'metrics', 'dayFiles'],
        stepsGivenUp: ['uploads']
      });
      expect(await db.pendingDays()).toEqual([]);
      await save(20737, 'CHAIN', 'WRITTEN');
      expect(await db.latest()).toMatchObject({
        stepsDone: [],
        stepsGivenUp: []
      });
      expect(await db.recordStepFailure(20737, 'uploads', 6)).toBe(1);
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
      expect(await db.latestTdhDay()).toEqual({
        block: 700,
        timestampMs: Date.parse('2026-10-11T23:59:59Z')
      });
      expect(await db.uploadExists(false, '20261011', 500)).toBe(true);
      expect(await db.uploadExists(true, '20261011', 500)).toBe(false);
      expect(await db.uploadExists(false, '20261012', 700)).toBe(false);
      // The narrowest consolidation_key column of the TDH tables, at the
      // schema's width.
      expect(await db.consolidationKeyWidth()).toBe(CONSOLIDATION_KEY_LENGTH);
    });

    it('forgets the uploads of a block inside a write, and no other', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((c) =>
        db.forgetUploads('20261011', 500, c)
      );
      expect(await db.uploadExists(false, '20261011', 500)).toBe(false);
      expect(await db.uploadExists(false, '20261010', 400)).toBe(true);
    });

    it('gives the blocks the chain wrote their day and root, and no other', async () => {
      const at = (cycleDay: number, cutoffNumber: number) => ({
        ...day,
        header: { ...day.header, cycleDay, cutoffNumber }
      });
      const record = {
        verdict: 'MATCH' as const,
        summary: {},
        deferredKeys: [],
        now: 1
      };
      await db.save({
        ...record,
        day: at(20737, 700),
        mode: 'CHAIN',
        status: 'INGESTED'
      });
      await db.save({
        ...record,
        day: at(20736, 500),
        mode: 'SHADOW',
        status: 'INGESTED'
      });
      const page = await fetchBlocks(10, 1);
      expect(page.count).toBe(2);
      expect(
        page.data.map((b) => [
          b.block_number,
          b.chain_cycle_day === null ? null : Number(b.chain_cycle_day),
          b.chain_wallet_root
        ])
      ).toEqual([
        [700, 20737, day.header.walletRoot],
        [500, null, null]
      ]);
    });
  }
);
