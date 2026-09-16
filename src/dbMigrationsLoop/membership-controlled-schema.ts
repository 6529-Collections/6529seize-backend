import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { membershipSchemaEntities } from './membership-schema';
import {
  membershipIndexExists,
  withMembershipSchemaInspection
} from './membership-additive-schema';
import { MEMBERSHIP_EVALUATOR_INDEX } from './membership-evaluator-schema';
import { MEMBERSHIP_REFRESH_RUNS_TABLE, USER_GROUPS_TABLE } from '@/constants';
import { MembershipRuntimeCheckpointEntity } from '@/entities/IMembershipRuntimeCheckpoint';
import { MEMBERSHIP_RUNTIME_INDEX } from './membership-runtime-schema';

/** Manual full sync may not bypass separately reviewed membership schema scopes. */
export async function applyFullSchemaWithMembershipGuard(
  source: DataSource = getDataSource()
): Promise<void> {
  const controlled = new DataSource({
    ...source.options,
    entities: [
      ...membershipSchemaEntities,
      UserGroupEntity,
      MembershipRuntimeCheckpointEntity
    ],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false
  });
  try {
    await controlled.initialize();
    await withMembershipSchemaInspection(
      controlled,
      async ({ runner, log }) => {
        if ((await log()).upQueries.length)
          throw new Error(
            'Apply the explicit membership schema scopes before full synchronization'
          );
        if (
          !(await membershipIndexExists(
            runner,
            USER_GROUPS_TABLE,
            MEMBERSHIP_EVALUATOR_INDEX
          ))
        )
          throw new Error(
            'Membership evaluator index must exist before full synchronization'
          );
        if (
          !(await membershipIndexExists(
            runner,
            MEMBERSHIP_REFRESH_RUNS_TABLE,
            MEMBERSHIP_RUNTIME_INDEX
          ))
        )
          throw new Error(
            'Membership runtime index must exist before full synchronization'
          );
      }
    );
  } finally {
    if (controlled.isInitialized) await controlled.destroy();
  }
  // Preserve the existing manual behavior for other entities only after the guard.
  // dbMigrationsLoop has reserved concurrency 1, serializing its schema invocations.
  await source.synchronize();
}
