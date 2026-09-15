import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { membershipSchemaEntities } from './membership-schema';
import { membershipIndexExists } from './membership-additive-schema';
import { MEMBERSHIP_EVALUATOR_INDEX } from './membership-evaluator-schema';
import { USER_GROUPS_TABLE } from '@/constants';

/** Manual full sync may not bypass separately reviewed membership schema scopes. */
export async function applyFullSchemaWithMembershipGuard(
  source: DataSource = getDataSource()
): Promise<void> {
  const controlled = new DataSource({
    ...source.options,
    entities: [...membershipSchemaEntities, UserGroupEntity],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false
  });
  try {
    await controlled.initialize();
    if (
      (await controlled.driver.createSchemaBuilder().log()).upQueries.length
    ) {
      throw new Error(
        'Apply the explicit membership schema scopes before full synchronization'
      );
    }
    const runner = controlled.createQueryRunner('master');
    try {
      if (
        !(await membershipIndexExists(
          runner,
          USER_GROUPS_TABLE,
          MEMBERSHIP_EVALUATOR_INDEX
        ))
      ) {
        throw new Error(
          'Membership evaluator index must exist before full synchronization'
        );
      }
    } finally {
      await runner.release();
    }
  } finally {
    if (controlled.isInitialized) await controlled.destroy();
  }
  // Preserve the existing manual behavior for other entities only after the guard.
  // dbMigrationsLoop has reserved concurrency 1, serializing its schema invocations.
  await source.synchronize();
}
