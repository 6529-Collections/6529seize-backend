import {
  MEMBERSHIP_MATERIALIZATION_STATES_TABLE,
  MEMBERSHIP_REFRESH_REQUESTS_TABLE,
  MEMBERSHIP_WATERMARKS_TABLE,
  USER_GROUP_MEMBERS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { MembershipRefreshScope } from '@/entities/IMembershipRefreshRequest';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  ELIGIBILITY_SPEC_VERSION,
  MEMBERSHIP_FULL_BACKFILL_WATERMARK
} from './membership.constants';

export type EligibilityReadMode = 'legacy' | 'shadow' | 'materialized';

interface MaterializedEligibilityRow {
  readonly ready: number | string;
  readonly group_id: string | null;
}

export class MembershipMaterializedReader extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public getReadMode(): EligibilityReadMode {
    const configured = process.env.ELIGIBILITY_READ_MODE?.trim().toLowerCase();
    if (
      configured === 'legacy' ||
      configured === 'shadow' ||
      configured === 'materialized'
    ) {
      return configured;
    }
    return 'legacy';
  }

  /**
   * Returns null until the materialized view is authoritative. An empty array
   * is an authoritative "eligible for no groups" result.
   */
  public async getEligibleGroupIdsIfReady(
    profileId: string,
    ctx: RequestContext = {}
  ): Promise<string[] | null> {
    if (this.getReadMode() === 'legacy') {
      return null;
    }
    ctx.timer?.start(`${this.constructor.name}->getEligibleGroupIdsIfReady`);
    try {
      const rows = await this.db.execute<MaterializedEligibilityRow>(
        `
        with readiness as (
          select (
            exists (
              select 1
              from ${MEMBERSHIP_WATERMARKS_TABLE}
              where dimension = :fullBackfillWatermark
            )
            and exists (
              select 1
              from ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE}
              where scope = :profileScope
                and target_id = :profileId
                and spec_version = :specVersion
            )
            and not exists (
              select 1
              from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
              where scope = :profileScope and target_id = :profileId
            )
            and not exists (
              select 1
              from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
              where scope = :groupScope
            )
          ) as ready
        )
        select readiness.ready, members.group_id
        from readiness
        left join ${USER_GROUP_MEMBERS_TABLE} members
          on readiness.ready = 1
          and members.profile_id = :profileId
          and members.spec_version = :specVersion
        order by members.group_id asc
        `,
        {
          fullBackfillWatermark: MEMBERSHIP_FULL_BACKFILL_WATERMARK,
          profileScope: MembershipRefreshScope.PROFILE,
          groupScope: MembershipRefreshScope.GROUP,
          profileId,
          specVersion: ELIGIBILITY_SPEC_VERSION
        },
        {
          wrappedConnection: ctx.connection,
          forcePool: DbPoolName.WRITE
        }
      );
      if (!rows.length || Number(rows[0].ready) !== 1) {
        return null;
      }
      return rows
        .map((row) => row.group_id)
        .filter((groupId): groupId is string => groupId !== null);
    } catch (error) {
      this.logger.error(
        `Materialized eligibility read failed; falling back to legacy`,
        { profileId, error }
      );
      return null;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getEligibleGroupIdsIfReady`);
    }
  }
}

export const membershipMaterializedReader = new MembershipMaterializedReader(
  dbSupplier
);
