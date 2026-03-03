import { RATINGS_TABLE } from '@/constants';
import { CountlessPage } from '@/api/page-request';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type CicDirection = 'incoming' | 'outgoing';

export interface CicOverviewStatsRow {
  readonly total_cic: number;
  readonly contributor_count: number;
  readonly authenticated_user_contribution: number | null;
}

export interface CicContributorAggregationRow {
  readonly profile_id: string;
  readonly contribution: number;
}

export class ProfileCicOverviewDb extends LazyDbAccessCompatibleService {
  private getDirectionColumns(direction: CicDirection): {
    contextColumn: 'matter_target_id' | 'rater_profile_id';
    contributorColumn: 'rater_profile_id' | 'matter_target_id';
  } {
    return direction === 'incoming'
      ? {
          contextColumn: 'matter_target_id',
          contributorColumn: 'rater_profile_id'
        }
      : {
          contextColumn: 'rater_profile_id',
          contributorColumn: 'matter_target_id'
        };
  }

  public async getCicOverviewStats({
    contextProfileId,
    direction,
    authenticatedProfileId
  }: {
    readonly contextProfileId: string;
    readonly direction: CicDirection;
    readonly authenticatedProfileId: string | null;
  }): Promise<CicOverviewStatsRow> {
    if (direction === 'outgoing') {
      const params: Record<string, any> = {
        contextProfileId,
        matter: 'CIC'
      };
      const authenticatedContributionSql = authenticatedProfileId
        ? `coalesce(sum(case when r.matter_target_id = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
        : `null as authenticated_user_contribution`;
      if (authenticatedProfileId) {
        params.authenticatedProfileId = authenticatedProfileId;
      }
      const [totalsRow, contributorCountRow] = await Promise.all([
        this.db.oneOrNull<{
          total_cic: number;
          authenticated_user_contribution: number | null;
        }>(
          `
          select
            coalesce(sum(r.rating), 0) as total_cic,
            ${authenticatedContributionSql}
          from ${RATINGS_TABLE} r
          where r.matter = :matter
            and r.rater_profile_id = :contextProfileId
            and r.rating <> 0
          `,
          params
        ),
        this.db.oneOrNull<{ contributor_count: number }>(
          `
          select count(distinct r.matter_target_id) as contributor_count
          from ${RATINGS_TABLE} r force index (PRIMARY)
          where r.rater_profile_id = :contextProfileId
            and r.matter = :matter
            and r.rating <> 0
          `,
          params
        )
      ]);
      return {
        total_cic: totalsRow?.total_cic ?? 0,
        contributor_count: contributorCountRow?.contributor_count ?? 0,
        authenticated_user_contribution:
          totalsRow?.authenticated_user_contribution ??
          (authenticatedProfileId ? 0 : null)
      };
    }
    const { contextColumn, contributorColumn } =
      this.getDirectionColumns(direction);
    const params: Record<string, any> = {
      contextProfileId,
      matter: 'CIC'
    };
    const authenticatedContributionSql = authenticatedProfileId
      ? `coalesce(sum(case when r.${contributorColumn} = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
      : `null as authenticated_user_contribution`;
    if (authenticatedProfileId) {
      params.authenticatedProfileId = authenticatedProfileId;
    }
    const row = await this.db.oneOrNull<CicOverviewStatsRow>(
      `
      select
        coalesce(sum(r.rating), 0) as total_cic,
        count(distinct r.${contributorColumn}) as contributor_count,
        ${authenticatedContributionSql}
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.${contextColumn} = :contextProfileId
        and r.rating <> 0
      `,
      params
    );
    return {
      total_cic: row?.total_cic ?? 0,
      contributor_count: row?.contributor_count ?? 0,
      authenticated_user_contribution:
        row?.authenticated_user_contribution ??
        (authenticatedProfileId ? 0 : null)
    };
  }

  public async getCicContributorsPage({
    contextProfileId,
    direction,
    page,
    page_size
  }: {
    readonly contextProfileId: string;
    readonly direction: CicDirection;
    readonly page: number;
    readonly page_size: number;
  }): Promise<CountlessPage<CicContributorAggregationRow>> {
    const { contextColumn, contributorColumn } =
      this.getDirectionColumns(direction);
    const offset = (page - 1) * page_size;
    const limitPlusOne = page_size + 1;
    const rows = await this.db.execute<CicContributorAggregationRow>(
      `
      with grouped_contributions as (
        select
          r.${contributorColumn} as profile_id,
          sum(r.rating) as contribution
        from ${RATINGS_TABLE} r
        where r.matter = :matter
          and r.${contextColumn} = :contextProfileId
          and r.rating <> 0
        group by 1
      )
      select profile_id, contribution
      from grouped_contributions
      order by contribution desc, profile_id asc
      limit :limitPlusOne offset :offset
      `,
      {
        contextProfileId,
        matter: 'CIC',
        offset,
        limitPlusOne
      }
    );
    return {
      page,
      next: rows.length > page_size,
      data: rows.slice(0, page_size)
    };
  }
}

export const profileCicOverviewDb = new ProfileCicOverviewDb(dbSupplier);
