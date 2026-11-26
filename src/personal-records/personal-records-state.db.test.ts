import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { importOrderKey } from '@/signed-records/record-order';
import { PersonalRecordsStateDb } from './personal-records-state.db';

describeWithSeed('PersonalRecordsStateDb', [], () => {
  it('starts open with no import, freezes, records the import, and unfreezes', async () => {
    const db = new PersonalRecordsStateDb(() => sqlExecutor);
    expect(await db.read({ fresh: true })).toEqual({
      frozen: false,
      importOrder: null
    });
    await db.setFrozen(true);
    expect(await db.read()).toEqual({ frozen: true, importOrder: null });
    await db.executeNativeQueriesInTransaction(async (connection) => {
      await db.setImport(1000, 5000, { connection });
    });
    expect(await db.read()).toEqual({
      frozen: true,
      importOrder: importOrderKey(1000, 5000)
    });
    await db.setFrozen(false);
    expect(await db.read()).toEqual({
      frozen: false,
      importOrder: importOrderKey(1000, 5000)
    });
  });

  it('serves a cached state for a few seconds, and a fresh one on request', async () => {
    const reader = new PersonalRecordsStateDb(() => sqlExecutor);
    const writer = new PersonalRecordsStateDb(() => sqlExecutor);
    expect((await reader.read({ fresh: true })).frozen).toBe(false);
    await writer.setFrozen(true);
    expect((await reader.read()).frozen).toBe(false);
    expect((await reader.read({ fresh: true })).frozen).toBe(true);
  });
});
