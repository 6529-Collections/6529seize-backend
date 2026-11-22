import 'reflect-metadata';
import { PERSONAL_RECORDS_STATE_TABLE } from '@/constants';
import { importOrderKey } from '@/signed-records/record-order';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  restorePersonalSwitchState,
  runPersonalRebuild
} from './personal-rebuild.step';
import { personalRecordsStateDb } from './personal-records-state.db';

const report = {
  importOrder: importOrderKey(1000, 5000),
  importEntries: 0,
  records: 0,
  beforeImport: 0,
  refused: []
};

describeWithSeed('the rebuild step and the switch state', [], () => {
  it("restores the import's order key into an emptied switch table with settings open", async () => {
    await sqlExecutor.execute(`delete from ${PERSONAL_RECORDS_STATE_TABLE}`);
    await runPersonalRebuild({
      read: { imports: [], records: [], rejected: {} },
      rebuild: async () => report,
      setImport: restorePersonalSwitchState
    });
    expect(await personalRecordsStateDb.read({ fresh: true })).toEqual({
      frozen: false,
      importOrder: importOrderKey(1000, 5000)
    });
  });

  it('leaves the freeze of a row that is already there as it is', async () => {
    await personalRecordsStateDb.setFrozen(true);
    await restorePersonalSwitchState(1001, 6000);
    expect(await personalRecordsStateDb.read({ fresh: true })).toEqual({
      frozen: true,
      importOrder: importOrderKey(1001, 6000)
    });
    await personalRecordsStateDb.setFrozen(false);
  });
});
