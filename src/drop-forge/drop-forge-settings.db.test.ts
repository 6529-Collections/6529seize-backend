import { sqlExecutor } from '@/sql-executor';
import { DROP_FORGE_JOBS_TABLE, DROP_FORGE_SETTINGS_TABLE } from '@/constants';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import {
  readForgeSettings,
  updateForgeSettings
} from '@/drop-forge/drop-forge.settings';
import { wakeDropForge } from '@/drop-forge/drop-forge.wake';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { LaunchRevisionConflict } from '@/drop-forge/drop-forge.types';

beforeEach(clearDropForgeTestTables);

it('defaults all switches off and leaves the cap unset for an unconfigured environment/creator', async () => {
  await sqlExecutor.execute(`DELETE FROM ${DROP_FORGE_SETTINGS_TABLE}`);
  expect(await readForgeSettings(testConfig)).toMatchObject({
    revision: 0,
    automation_enabled: false,
    pay_artist_enabled: false,
    preparation_enabled: false,
    max_artist_payment_wei: null,
    updated_by: null
  });
});

it('persists revisioned settings and isolates creator scope', async () => {
  await updateForgeSettings(testConfig, testConfig.signer, {
    revision: 0,
    automation_enabled: false,
    pay_artist_enabled: true,
    max_artist_payment_eth: '0.25'
  });
  expect(await readForgeSettings(testConfig)).toMatchObject({
    revision: 1,
    automation_enabled: false,
    pay_artist_enabled: true,
    max_artist_payment_wei: '250000000000000000',
    updated_by: testConfig.signer
  });
  expect(
    (await readForgeSettings({ ...testConfig, chainId: 1 })).automation_enabled
  ).toBe(false);
  await expect(
    updateForgeSettings(testConfig, testConfig.signer, {
      revision: 0,
      automation_enabled: true,
      pay_artist_enabled: true
    })
  ).rejects.toBeInstanceOf(LaunchRevisionConflict);
});

it('serializes simultaneous settings edits instead of losing one update', async () => {
  const edits = await Promise.allSettled([
    updateForgeSettings(testConfig, testConfig.signer, {
      revision: 0,
      automation_enabled: false,
      pay_artist_enabled: false
    }),
    updateForgeSettings(testConfig, testConfig.signer, {
      revision: 0,
      automation_enabled: true,
      pay_artist_enabled: true
    })
  ]);
  expect(edits.filter((edit) => edit.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter((edit) => edit.status === 'rejected')).toHaveLength(1);
  expect((await readForgeSettings(testConfig)).revision).toBe(1);
});

it('requires a positive payment cap before enabling payments', async () => {
  await sqlExecutor.execute(`DELETE FROM ${DROP_FORGE_SETTINGS_TABLE}`);
  await expect(
    updateForgeSettings(testConfig, testConfig.signer, {
      revision: 0,
      automation_enabled: true,
      pay_artist_enabled: true
    })
  ).rejects.toThrow('payment limit');
  expect((await readForgeSettings(testConfig)).revision).toBe(0);
});

it('wakes pending EMMA jobs at their saved checkpoint when preparation is re-enabled', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  await sqlExecutor.execute(
    `INSERT INTO ${DROP_FORGE_JOBS_TABLE} (id, dispatch_revision, contract, claim_id, kind, status, step, updated_at) VALUES (:id, 1, :contract, 1, 'PROCESS_ALL', 'PENDING', 2, 0)`,
    { id, contract: testConfig.creator }
  );
  await updateForgeSettings(testConfig, testConfig.signer, {
    revision: 0,
    preparation_enabled: true
  });
  expect(wakeDropForge).toHaveBeenCalledWith(
    { id, revision: 1, preparation_revision: 1 },
    true
  );
  expect(await dropForgeJobsRepository.find(id, {})).toMatchObject({
    dispatch_revision: 1,
    step: 2,
    status: 'PENDING'
  });
});
