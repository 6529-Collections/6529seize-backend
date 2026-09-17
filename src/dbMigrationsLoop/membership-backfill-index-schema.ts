import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { MembershipRefreshTargetEntity } from '@/entities/IMembershipRefreshTarget';
import { MembershipSourceStateEntity } from '@/entities/IMembershipSourceState';
import {
  executeMembershipOnlineIndex,
  membershipIndexExists,
  withMembershipSchemaInspection,
  MembershipSchemaInspectionOptions
} from './membership-additive-schema';

export const membershipBackfillIndexEntities = [
  MembershipSourceStateEntity,
  MembershipRefreshTargetEntity
];

export const MEMBERSHIP_BACKFILL_INDEXES = [
  {
    table: MEMBERSHIP_SOURCE_STATES_TABLE,
    name: 'idx_mss_scope_updated_target',
    columns: ['scope', 'updated_at_millis', 'target_id']
  },
  {
    table: MEMBERSHIP_SOURCE_STATES_TABLE,
    name: 'idx_mss_scope_active_target',
    columns: ['scope', 'active_jobs', 'target_id']
  },
  {
    table: MEMBERSHIP_REFRESH_TARGETS_TABLE,
    name: 'idx_mrt_scope_updated_target',
    columns: ['scope', 'updated_at_millis', 'target_id']
  }
] as const;

function columns(index: (typeof MEMBERSHIP_BACKFILL_INDEXES)[number]): string {
  return index.columns.map((column) => `\`${column}\``).join(', ');
}

export function membershipBackfillIndexPlan(
  index: (typeof MEMBERSHIP_BACKFILL_INDEXES)[number]
): string {
  return `CREATE INDEX \`${index.name}\` ON \`${index.table}\` (${columns(index)})`;
}

export function membershipBackfillIndexOnline(
  index: (typeof MEMBERSHIP_BACKFILL_INDEXES)[number]
): string {
  return `ALTER TABLE \`${index.table}\` ADD INDEX \`${index.name}\` (${columns(index)}), ALGORITHM=INPLACE, LOCK=NONE`;
}

/** Inspect the exact isolated plan before each independently retryable online DDL. */
export async function applyMembershipBackfillIndexSchema(
  source: DataSource = getDataSource(),
  inspectionOptions: MembershipSchemaInspectionOptions = {}
) {
  if (
    source.entityMetadatas.length !== membershipBackfillIndexEntities.length ||
    source.entityMetadatas.some(
      (metadata) =>
        !membershipBackfillIndexEntities.some(
          (entity) => metadata.target === entity
        )
    )
  )
    throw new Error('Membership backfill indexes require isolated entities');

  const missing = await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      for (const table of [
        MEMBERSHIP_SOURCE_STATES_TABLE,
        MEMBERSHIP_REFRESH_TARGETS_TABLE
      ])
        if (!(await runner.hasTable(table)))
          throw new Error(
            'Apply baseline membership schema before backfill indexes'
          );
      const absent = [];
      for (const index of MEMBERSHIP_BACKFILL_INDEXES)
        if (!(await membershipIndexExists(runner, index.table, index)))
          absent.push(index);
      const expected = new Set(absent.map(membershipBackfillIndexPlan));
      const plan = await log();
      if (
        plan.upQueries.length !== expected.size ||
        plan.upQueries.some(
          (query) => !expected.delete(query.query) || query.parameters?.length
        ) ||
        expected.size
      )
        throw new Error(
          'Membership backfill index schema contains unapproved or missing changes'
        );
      return absent;
    },
    inspectionOptions
  );

  for (const index of missing) {
    const runner = source.createQueryRunner('master');
    try {
      await executeMembershipOnlineIndex(
        runner,
        membershipBackfillIndexOnline(index)
      );
    } finally {
      await runner.release();
    }
  }

  await withMembershipSchemaInspection(
    source,
    async ({ runner, log }) => {
      for (const index of MEMBERSHIP_BACKFILL_INDEXES)
        if (!(await membershipIndexExists(runner, index.table, index)))
          throw new Error('Membership backfill index verification failed');
      if ((await log()).upQueries.length)
        throw new Error('Membership backfill index verification failed');
    },
    inspectionOptions
  );
  return {
    added_indexes: missing.length,
    verified_indexes: MEMBERSHIP_BACKFILL_INDEXES.length
  };
}
