import * as wake from '@/drop-forge/drop-forge.wake';
import {
  DROP_FORGE_EVIDENCE_TABLE,
  DROP_FORGE_JOBS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE,
  DROP_FORGE_SIGNERS_TABLE,
  DROP_FORGE_SETTINGS_TABLE,
  DROP_FORGE_FUNDING_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import { forgeSettingsId } from '@/drop-forge/drop-forge.settings';

// These tests mock the published source and use only the Drop Forge
// tables. Leave unrelated domain tables to their owning suites.
export async function clearDropForgeTestTables(): Promise<void> {
  jest.spyOn(wake, 'wakeDropForge').mockResolvedValue();
  for (const table of [
    DROP_FORGE_SETTINGS_TABLE,
    DROP_FORGE_FUNDING_TABLE,
    DROP_FORGE_EVIDENCE_TABLE,
    DROP_FORGE_JOBS_TABLE,
    DROP_FORGE_LAUNCHES_TABLE,
    DROP_FORGE_PREPARATIONS_TABLE,
    DROP_FORGE_SIGNERS_TABLE,
    DROP_FORGE_SETTINGS_TABLE,
    DROP_FORGE_FUNDING_TABLE
  ]) {
    await sqlExecutor.execute(`DELETE FROM ${table}`);
  }
  await sqlExecutor.execute(
    `INSERT INTO ${DROP_FORGE_SETTINGS_TABLE} (id, automation_enabled, pay_artist_enabled) VALUES (:id, true, true)`,
    { id: forgeSettingsId(testConfig) }
  );
}
