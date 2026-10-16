import {
  DROP_FORGE_EVIDENCE_TABLE,
  DROP_FORGE_JOBS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE,
  DROP_FORGE_SIGNERS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';

// These tests mock the published source and use only the five Drop Forge
// tables. Leave unrelated domain tables to their owning suites.
export async function clearDropForgeTestTables(): Promise<void> {
  for (const table of [
    DROP_FORGE_EVIDENCE_TABLE,
    DROP_FORGE_JOBS_TABLE,
    DROP_FORGE_LAUNCHES_TABLE,
    DROP_FORGE_PREPARATIONS_TABLE,
    DROP_FORGE_SIGNERS_TABLE
  ]) {
    await sqlExecutor.execute(`DELETE FROM ${table}`);
  }
}
