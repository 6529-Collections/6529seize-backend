import { RATINGS_TABLE } from '@/constants';
import { CountlessPage } from '@/api/page-request';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type RepDirection = 'incoming' | 'outgoing';

export interface RepOverviewStatsRow {
  readonly total_rep: number;
  readonly contributor_count: number;
  readonly authenticated_user_contribution: number | null;
}

export interface RepContributorAggregationRow {
  readonly profile_id: string;
  readonly contribution: number;
}

export interface RepCategoryAggregationRow {
  readonly category: string;
  readonly total_rep: number;
  readonly contributor_count: number;
  readonly authenticated_user_contribution: number | null;
}

export interface RepCategoryTopContributorRow extends RepContributorAggregationRow {
  readonly category: string;
}

export class ProfileRepOverviewDb extends LazyDbAccessCompatibleService {
  private getDirectionColumns(direction: RepDirection): {
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

  public async getRepOverviewStats({
    contextProfileId,
    direction,
    authenticatedProfileId
  }: {
    readonly contextProfileId: string;
    readonly direction: RepDirection;
    readonly authenticatedProfileId: string | null;
  }): Promise<RepOverviewStatsRow> {
    if (direction === 'outgoing') {
      const params: Record<string, any> = {
        contextProfileId,
        matter: 'REP'
      };
      const authenticatedContributionSql = authenticatedProfileId
        ? `coalesce(sum(case when r.matter_target_id = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
        : `null as authenticated_user_contribution`;
      if (authenticatedProfileId) {
        params.authenticatedProfileId = authenticatedProfileId;
      }
      const [totalsRow, contributorCountRow] = await Promise.all([
        this.db.oneOrNull<{
          total_rep: number;
          authenticated_user_contribution: number | null;
        }>(
          `
          select
            coalesce(sum(r.rating), 0) as total_rep,
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
        total_rep: totalsRow?.total_rep ?? 0,
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
      matter: 'REP'
    };
    const authenticatedContributionSql = authenticatedProfileId
      ? `coalesce(sum(case when r.${contributorColumn} = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
      : `null as authenticated_user_contribution`;
    if (authenticatedProfileId) {
      params.authenticatedProfileId = authenticatedProfileId;
    }
    const row = await this.db.oneOrNull<RepOverviewStatsRow>(
      `
      select
        coalesce(sum(r.rating), 0) as total_rep,
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
      total_rep: row?.total_rep ?? 0,
      contributor_count: row?.contributor_count ?? 0,
      authenticated_user_contribution:
        row?.authenticated_user_contribution ??
        (authenticatedProfileId ? 0 : null)
    };
  }

  public async getRepContributorsPage({
    contextProfileId,
    direction,
    page,
    page_size,
    category
  }: {
    readonly contextProfileId: string;
    readonly direction: RepDirection;
    readonly page: number;
    readonly page_size: number;
    readonly category: string | null;
  }): Promise<CountlessPage<RepContributorAggregationRow>> {
    const { contextColumn, contributorColumn } =
      this.getDirectionColumns(direction);
    const offset = (page - 1) * page_size;
    const limitPlusOne = page_size + 1;
    const params: Record<string, any> = {
      contextProfileId,
      matter: 'REP',
      offset,
      limitPlusOne
    };
    if (category) {
      params.category = category;
    }
    if (category) {
      const rows = await this.db.execute<RepContributorAggregationRow>(
        `
        select
          r.${contributorColumn} as profile_id,
          r.rating as contribution
        from ${RATINGS_TABLE} r
        where r.matter = :matter
          and r.${contextColumn} = :contextProfileId
          and r.rating <> 0
          and r.matter_category = :category
        order by contribution desc, profile_id asc
        limit :limitPlusOne offset :offset
        `,
        params
      );
      return {
        page,
        next: rows.length > page_size,
        data: rows.slice(0, page_size)
      };
    }
    const rows = await this.db.execute<RepContributorAggregationRow>(
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
      params
    );
    return {
      page,
      next: rows.length > page_size,
      data: rows.slice(0, page_size)
    };
  }

  public async getRepCategoriesPage({
    contextProfileId,
    direction,
    authenticatedProfileId,
    page,
    page_size
  }: {
    readonly contextProfileId: string;
    readonly direction: RepDirection;
    readonly authenticatedProfileId: string | null;
    readonly page: number;
    readonly page_size: number;
  }): Promise<CountlessPage<RepCategoryAggregationRow>> {
    const { contextColumn, contributorColumn } =
      this.getDirectionColumns(direction);
    const offset = (page - 1) * page_size;
    const limitPlusOne = page_size + 1;
    const params: Record<string, any> = {
      contextProfileId,
      matter: 'REP',
      offset,
      limitPlusOne
    };
    const authenticatedContributionSql = authenticatedProfileId
      ? `coalesce(sum(case when r.${contributorColumn} = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
      : `null as authenticated_user_contribution`;
    if (authenticatedProfileId) {
      params.authenticatedProfileId = authenticatedProfileId;
    }
    const rows = await this.db.execute<RepCategoryAggregationRow>(
      `
      select
        r.matter_category as category,
        sum(r.rating) as total_rep,
        count(*) as contributor_count,
        ${authenticatedContributionSql}
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.${contextColumn} = :contextProfileId
        and r.rating <> 0
      group by 1
      order by total_rep desc, category asc
      limit :limitPlusOne offset :offset
      `,
      params
    );
    return {
      page,
      next: rows.length > page_size,
      data: rows.slice(0, page_size)
    };
  }

  public async getTopRepContributorsByCategories({
    contextProfileId,
    direction,
    categories,
    topContributorsLimit
  }: {
    readonly contextProfileId: string;
    readonly direction: RepDirection;
    readonly categories: string[];
    readonly topContributorsLimit: number;
  }): Promise<RepCategoryTopContributorRow[]> {
    if (!categories.length || topContributorsLimit <= 0) {
      return [];
    }
    const { contextColumn, contributorColumn } =
      this.getDirectionColumns(direction);
    const categoryRows = await Promise.all(
      categories.map((category) =>
        this.db.execute<RepCategoryTopContributorRow>(
          `
          select
            r.matter_category as category,
            r.${contributorColumn} as profile_id,
            r.rating as contribution
          from ${RATINGS_TABLE} r
          where r.matter = :matter
            and r.${contextColumn} = :contextProfileId
            and r.rating <> 0
            and r.matter_category = :category
          order by contribution desc, profile_id asc
          limit :topContributorsLimit
          `,
          {
            contextProfileId,
            topContributorsLimit,
            category,
            matter: 'REP'
          }
        )
      )
    );
    return categoryRows.flat();
  }
}

export const profileRepOverviewDb = new ProfileRepOverviewDb(dbSupplier);
