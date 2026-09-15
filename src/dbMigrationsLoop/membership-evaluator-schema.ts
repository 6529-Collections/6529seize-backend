import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { USER_GROUPS_TABLE } from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import {
  executeMembershipOnlineIndex,
  membershipIndexExists,
  withMembershipSchemaInspection,
  MembershipSchemaInspectionOptions
} from './membership-additive-schema';

export const membershipEvaluatorSchemaEntities = [UserGroupEntity];
export const MEMBERSHIP_EVALUATOR_INDEX = {
  name: 'idx_user_groups_pure_visible_id',
  columns: ['is_pure_profile_group', 'visible', 'id']
} as const;
const COLUMNS = MEMBERSHIP_EVALUATOR_INDEX.columns
  .map((column) => `\`${column}\``)
  .join(', ');
export const MEMBERSHIP_EVALUATOR_INDEX_PLAN = `CREATE INDEX \`${MEMBERSHIP_EVALUATOR_INDEX.name}\` ON \`${USER_GROUPS_TABLE}\` (${COLUMNS})`;
export const MEMBERSHIP_EVALUATOR_INDEX_ONLINE = `ALTER TABLE \`${USER_GROUPS_TABLE}\` ADD INDEX \`${MEMBERSHIP_EVALUATOR_INDEX.name}\` (${COLUMNS}), ALGORITHM=INPLACE, LOCK=NONE`;

/** Inspect the whole isolated plan before this one explicit online addition. */
export async function applyMembershipEvaluatorSchema(
  source: DataSource = getDataSource(),
  inspectionOptions: MembershipSchemaInspectionOptions = {}
) {
  if (
    source.entityMetadatas.length !== 1 ||
    source.entityMetadatas[0].target !== UserGroupEntity
  ) {
    throw new Error(
      'Membership evaluator schema requires its isolated entity scope'
    );
  }
  const exists = await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      if (!(await runner.hasTable(USER_GROUPS_TABLE)))
        throw new Error(
          'Membership evaluator schema requires an existing group table'
        );
      const present = await membershipIndexExists(
        runner,
        USER_GROUPS_TABLE,
        MEMBERSHIP_EVALUATOR_INDEX
      );
      const plan = await log();
      if (
        plan.upQueries.length !== (present ? 0 : 1) ||
        plan.upQueries.some(
          (query) =>
            query.query !== MEMBERSHIP_EVALUATOR_INDEX_PLAN ||
            query.parameters?.length
        )
      )
        throw new Error(
          'Membership evaluator schema contains unapproved or missing changes'
        );
      return present;
    },
    inspectionOptions
  );
  if (!exists) {
    const runner = source.createQueryRunner('master');
    try {
      await executeMembershipOnlineIndex(
        runner,
        MEMBERSHIP_EVALUATOR_INDEX_ONLINE
      );
    } finally {
      await runner.release();
    }
  }
  await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      if (
        !(await membershipIndexExists(
          runner,
          USER_GROUPS_TABLE,
          MEMBERSHIP_EVALUATOR_INDEX
        )) ||
        (await log()).upQueries.length
      )
        throw new Error('Membership evaluator schema verification failed');
    },
    inspectionOptions
  );
  return { added_indexes: exists ? 0 : 1, verified_indexes: 1 };
}
