import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { MembershipGenerationMemberEntity } from '@/entities/IMembershipGenerationMember';
import { MembershipGroupVersionEntity } from '@/entities/IMembershipGroupVersion';
import { MembershipPublicationEntity } from '@/entities/IMembershipPublication';
import { MembershipRefreshRunEntity } from '@/entities/IMembershipRefreshRun';
import { MembershipRefreshTargetEntity } from '@/entities/IMembershipRefreshTarget';
import { MembershipSourceJobEntity } from '@/entities/IMembershipSourceJob';
import { MembershipSourceStateEntity } from '@/entities/IMembershipSourceState';

export const membershipSchemaEntities = [
  MembershipGenerationMemberEntity,
  MembershipGroupVersionEntity,
  MembershipPublicationEntity,
  MembershipRefreshRunEntity,
  MembershipRefreshTargetEntity,
  MembershipSourceJobEntity,
  MembershipSourceStateEntity
];

/** Apply only reviewed CREATE TABLE statements; existing-schema drift fails closed. */
export async function applyMembershipSchema(db: DataSource = getDataSource()) {
  const expectedTables = membershipSchemaEntities.map(
    (entity) => db.getMetadata(entity).tableName
  );
  if (
    db.entityMetadatas.length !== expectedTables.length ||
    db.entityMetadatas.some(
      (entity) => !expectedTables.includes(entity.tableName)
    )
  ) {
    throw new Error('Membership schema requires its isolated entity scope');
  }
  const builder = db.driver.createSchemaBuilder();
  const plan = await builder.log();
  for (const query of plan.upQueries) {
    const table = /^CREATE TABLE `([a-z_]+)` /.exec(query.query)?.[1];
    if (!table || !expectedTables.includes(table)) {
      throw new Error('Membership schema drift requires explicit review');
    }
  }
  // Execute the inspected statements, not a newly computed synchronization plan.
  for (const query of plan.upQueries) {
    await db.query(query.query, query.parameters);
  }
  if ((await builder.log()).upQueries.length) {
    throw new Error(
      'Membership schema verification failed after synchronization'
    );
  }
  return {
    created_tables: plan.upQueries.length,
    verified_tables: expectedTables.length
  };
}
