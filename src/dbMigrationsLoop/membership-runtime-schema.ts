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
  membershipIndexExists
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
  source: DataSource = getDataSource()
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
  const runner = source.createQueryRunner('master');
  try {
    if (!(await runner.hasTable(MEMBERSHIP_REFRESH_RUNS_TABLE))) {
      throw new Error(
        'Apply the baseline membership schema before runtime control'
      );
    }
    const tableExists = await runner.hasTable(
      MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
    );
    const indexExists = await membershipIndexExists(
      runner,
      MEMBERSHIP_REFRESH_RUNS_TABLE,
      MEMBERSHIP_RUNTIME_INDEX
    );
    const builder = source.driver.createSchemaBuilder();
    const plan = await builder.log();
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
    ) {
      throw new Error(
        'Membership runtime schema contains unapproved or missing changes'
      );
    }
    for (const query of creates) await runner.query(query.query);
    if (!indexExists) {
      await executeMembershipOnlineIndex(
        runner,
        MEMBERSHIP_RUNTIME_INDEX_ONLINE
      );
    }
    if (
      !(await runner.hasTable(MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE)) ||
      !(await membershipIndexExists(
        runner,
        MEMBERSHIP_REFRESH_RUNS_TABLE,
        MEMBERSHIP_RUNTIME_INDEX
      )) ||
      (await builder.log()).upQueries.length
    ) {
      throw new Error('Membership runtime schema verification failed');
    }
    return {
      created_tables: creates.length,
      added_indexes: indexes.length,
      verified_tables: 2,
      verified_indexes: 1
    };
  } finally {
    await runner.release();
  }
}
