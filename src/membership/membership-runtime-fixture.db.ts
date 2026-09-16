import type { SqlExecutor } from '@/sql-executor';
import {
  membershipQueryOptions,
  type MembershipPrimaryContext
} from './membership-primary';
import {
  MEMBERSHIP_FIXTURE_CONTROL_TABLE,
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_OWNER
} from './membership-runtime-policy';

/** This marker exists only in the fixed isolated drill database, never the app schema. */
export class MembershipRuntimeFixtureDb {
  constructor(private readonly db: SqlExecutor) {}

  async assertOwnedDatabase(ctx: MembershipPrimaryContext): Promise<void> {
    const timerName = 'MembershipRuntimeFixtureDb->assertOwnedDatabase';
    ctx.timer?.start(timerName);
    try {
      const options = membershipQueryOptions(ctx);
      const database = await this.db.execute<{
        selected_database: string | null;
      }>('SELECT DATABASE() AS selected_database', undefined, options);
      if (
        database.length !== 1 ||
        database[0].selected_database !== MEMBERSHIP_FIXTURE_DATABASE
      ) {
        throw new Error('Membership fixture database selection mismatch');
      }
      const rows = await this.db.execute<{
        id: string;
        protocol_version: number | string;
      }>(
        `SELECT id, protocol_version FROM ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} WHERE id = :id LIMIT 2`,
        { id: MEMBERSHIP_FIXTURE_OWNER },
        options
      );
      if (
        rows.length !== 1 ||
        rows[0].id !== MEMBERSHIP_FIXTURE_OWNER ||
        String(rows[0].protocol_version) !== '1'
      ) {
        throw new Error(
          'Membership fixture ownership marker is absent or incompatible'
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}
