import { sqlExecutor } from '@/sql-executor';
import { DROP_FORGE_SETTINGS_TABLE } from '@/constants';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import {
  readForgeSettings,
  updateForgeSettings
} from '@/drop-forge/drop-forge.settings';
import { LaunchRevisionConflict } from '@/drop-forge/drop-forge.types';

beforeEach(clearDropForgeTestTables);

it('defaults both switches off for an unconfigured environment/creator', async () => {
  await sqlExecutor.execute(`DELETE FROM ${DROP_FORGE_SETTINGS_TABLE}`);
  expect(await readForgeSettings(testConfig)).toMatchObject({
    revision: 0,
    automation_enabled: false,
    pay_artist_enabled: false,
    updated_by: null
  });
});

it('persists revisioned settings and isolates creator scope', async () => {
  await updateForgeSettings(testConfig, testConfig.signer, {
    revision: 0,
    automation_enabled: false,
    pay_artist_enabled: true
  });
  expect(await readForgeSettings(testConfig)).toMatchObject({
    revision: 1,
    automation_enabled: false,
    pay_artist_enabled: true,
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
  await expect(
    updateForgeSettings(
      { ...testConfig, maxArtistPayment: undefined },
      testConfig.signer,
      { revision: 0, automation_enabled: true, pay_artist_enabled: true }
    )
  ).rejects.toThrow('payment limit');
  expect((await readForgeSettings(testConfig)).revision).toBe(0);
});
