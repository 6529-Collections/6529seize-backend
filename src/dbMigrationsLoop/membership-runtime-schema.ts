import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import {
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { MembershipRefreshRunEntity } from '@/entities/IMembershipRefreshRun';
import { MembershipRuntimeCheckpointEntity } from '@/entities/IMembershipRuntimeCheckpoint';
import {
  executeMembershipOnlineIndex,
  membershipIndexExists,
  withMembershipSchemaInspection,
  MembershipSchemaInspectionOptions
} from './membership-additive-schema';

export const membershipRuntimeSchemaEntities = [
  MembershipRefreshRunEntity,
  MembershipRuntimeCheckpointEntity
];
export const MEMBERSHIP_RUNTIME_INDEX = {
  name: 'idx_mrun_status_updated_id',
  columns: ['status', 'updated_at_millis', 'id']
} as const;
const COLUMNS = MEMBERSHIP_RUNTIME_INDEX.columns
  .map((column) => `\`${column}\``)
  .join(', ');
export const MEMBERSHIP_RUNTIME_INDEX_PLAN = `CREATE INDEX \`${MEMBERSHIP_RUNTIME_INDEX.name}\` ON \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` (${COLUMNS})`;
export const MEMBERSHIP_RUNTIME_INDEX_ONLINE = `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` ADD INDEX \`${MEMBERSHIP_RUNTIME_INDEX.name}\` (${COLUMNS}), ALGORITHM=INPLACE, LOCK=NONE`;

/** The complete isolated plan must contain only the table and online index addition. */
export async function applyMembershipRuntimeSchema(
  source: DataSource = getDataSource(),
  inspectionOptions: MembershipSchemaInspectionOptions = {}
) {
  if (
    source.entityMetadatas.length !== membershipRuntimeSchemaEntities.length ||
    source.entityMetadatas.some(
      (metadata) =>
        !membershipRuntimeSchemaEntities.some(
          (entity) => metadata.target === entity
        )
    )
  ) {
    throw new Error(
      'Membership runtime schema requires its isolated entity scope'
    );
  }
  const additions = await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      if (!(await runner.hasTable(MEMBERSHIP_REFRESH_RUNS_TABLE)))
        throw new Error(
          'Apply the baseline membership schema before runtime control'
        );
      const tableExists = await runner.hasTable(
        MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
      );
      const indexExists = await membershipIndexExists(
        runner,
        MEMBERSHIP_REFRESH_RUNS_TABLE,
        MEMBERSHIP_RUNTIME_INDEX
      );
      const plan = await log();
      const creates = plan.upQueries.filter((query) =>
        query.query.startsWith(
          `CREATE TABLE \`${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}\` (`
        )
      );
      const indexes = plan.upQueries.filter(
        (query) => query.query === MEMBERSHIP_RUNTIME_INDEX_PLAN
      );
      if (
        creates.length !== (tableExists ? 0 : 1) ||
        indexes.length !== (indexExists ? 0 : 1) ||
        plan.upQueries.length !== creates.length + indexes.length ||
        plan.upQueries.some((query) => query.parameters?.length)
      )
        throw new Error(
          'Membership runtime schema contains unapproved or missing changes'
        );
      return {
        createStatements: creates.map((query) => query.query),
        addIndex: !indexExists
      };
    },
    inspectionOptions
  );
  // The same bounded DDL lease also covers this one approved CREATE TABLE.
  // It owns no existing rows; partial acknowledgement is reconciled by preflight.
  for (const statement of additions.createStatements)
    await executeAddition(source, statement, 3000);
  if (additions.addIndex)
    await executeAddition(source, MEMBERSHIP_RUNTIME_INDEX_ONLINE, 120000);
  await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      if (
        !(await runner.hasTable(MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE)) ||
        !(await membershipIndexExists(
          runner,
          MEMBERSHIP_REFRESH_RUNS_TABLE,
          MEMBERSHIP_RUNTIME_INDEX
        )) ||
        (await log()).upQueries.length
      )
        throw new Error('Membership runtime schema verification failed');
    },
    inspectionOptions
  );
  return {
    created_tables: additions.createStatements.length,
    added_indexes: additions.addIndex ? 1 : 0,
    verified_tables: 2,
    verified_indexes: 1
  };
}

async function executeAddition(
  source: DataSource,
  statement: string,
  deadlineMillis: number
): Promise<void> {
  const runner = source.createQueryRunner('master');
  try {
    await executeMembershipOnlineIndex(runner, statement, deadlineMillis);
  } finally {
    await runner.release();
  }
}
