import { RATINGS_TABLE } from '@/constants';
import { CountlessPage } from '@/api/page-request';
import { RateMatter } from '@/entities/IRating';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface WaveRepOverviewStatsRow {
  readonly total_rep: number;
  readonly positive_rep: number;
  readonly negative_rep: number;
  readonly contributor_count: number;
  readonly authenticated_user_contribution: number | null;
}

export interface WaveRepContributorAggregationRow {
  readonly profile_id: string;
  readonly contribution: number;
}

export interface WaveRepCategoryAggregationRow {
  readonly category: string;
  readonly total_rep: number;
  readonly contributor_count: number;
  readonly authenticated_user_contribution: number | null;
}

export interface WaveRepCategoryTopContributorRow extends WaveRepContributorAggregationRow {
  readonly category: string;
}

export class WaveRepOverviewDb extends LazyDbAccessCompatibleService {
  public async getWaveRepOverviewStats({
    waveId,
    authenticatedProfileId
  }: {
    readonly waveId: string;
    readonly authenticatedProfileId: string | null;
  }): Promise<WaveRepOverviewStatsRow> {
    const params: Record<string, any> = {
      waveId,
      matter: RateMatter.WAVE_REP
    };
    const authenticatedContributionSql = authenticatedProfileId
      ? `coalesce(sum(case when r.rater_profile_id = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
      : `null as authenticated_user_contribution`;
    if (authenticatedProfileId) {
      params.authenticatedProfileId = authenticatedProfileId;
    }
    const row = await this.db.oneOrNull<WaveRepOverviewStatsRow>(
      `
      select
        coalesce(sum(r.rating), 0) as total_rep,
        coalesce(sum(case when r.rating > 0 then r.rating else 0 end), 0) as positive_rep,
        coalesce(sum(case when r.rating < 0 then r.rating else 0 end), 0) as negative_rep,
        count(distinct case when r.rating <> 0 then r.rater_profile_id end) as contributor_count,
        ${authenticatedContributionSql}
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.matter_target_id = :waveId
        and r.rating <> 0
      `,
      params
    );
    return {
      total_rep: row?.total_rep ?? 0,
      positive_rep: row?.positive_rep ?? 0,
      negative_rep: row?.negative_rep ?? 0,
      contributor_count: row?.contributor_count ?? 0,
      authenticated_user_contribution:
        row?.authenticated_user_contribution ??
        (authenticatedProfileId ? 0 : null)
    };
  }

  public async getWaveRepContributorsPage({
    waveId,
    page,
    page_size,
    category
  }: {
    readonly waveId: string;
    readonly page: number;
    readonly page_size: number;
    readonly category: string | null;
  }): Promise<CountlessPage<WaveRepContributorAggregationRow>> {
    const offset = (page - 1) * page_size;
    const limitPlusOne = page_size + 1;
    const params: Record<string, any> = {
      waveId,
      matter: RateMatter.WAVE_REP,
      offset,
      limitPlusOne
    };
    if (category) {
      params.category = category;
    }
    const rows = await this.db.execute<WaveRepContributorAggregationRow>(
      `
      select
        r.rater_profile_id as profile_id,
        sum(r.rating) as contribution
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.matter_target_id = :waveId
        and r.rating <> 0
        ${category ? `and r.matter_category = :category` : ``}
      group by 1
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

  public async getWaveRepCategoriesPage({
    waveId,
    authenticatedProfileId,
    page,
    page_size
  }: {
    readonly waveId: string;
    readonly authenticatedProfileId: string | null;
    readonly page: number;
    readonly page_size: number;
  }): Promise<CountlessPage<WaveRepCategoryAggregationRow>> {
    const offset = (page - 1) * page_size;
    const limitPlusOne = page_size + 1;
    const params: Record<string, any> = {
      waveId,
      matter: RateMatter.WAVE_REP,
      offset,
      limitPlusOne
    };
    const authenticatedContributionSql = authenticatedProfileId
      ? `coalesce(sum(case when r.rater_profile_id = :authenticatedProfileId then r.rating else 0 end), 0) as authenticated_user_contribution`
      : `null as authenticated_user_contribution`;
    if (authenticatedProfileId) {
      params.authenticatedProfileId = authenticatedProfileId;
    }
    const rows = await this.db.execute<WaveRepCategoryAggregationRow>(
      `
      select
        r.matter_category as category,
        sum(r.rating) as total_rep,
        count(distinct r.rater_profile_id) as contributor_count,
        ${authenticatedContributionSql}
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.matter_target_id = :waveId
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

  public async getTopWaveRepContributorsByCategories({
    waveId,
    categories,
    topContributorsLimit
  }: {
    readonly waveId: string;
    readonly categories: string[];
    readonly topContributorsLimit: number;
  }): Promise<WaveRepCategoryTopContributorRow[]> {
    if (!categories.length || topContributorsLimit <= 0) {
      return [];
    }
    const categoryRows = await Promise.all(
      categories.map((category) =>
        this.db.execute<WaveRepCategoryTopContributorRow>(
          `
          select
            r.matter_category as category,
            r.rater_profile_id as profile_id,
            r.rating as contribution
          from ${RATINGS_TABLE} r
          where r.matter = :matter
            and r.matter_target_id = :waveId
            and r.rating <> 0
            and r.matter_category = :category
          order by contribution desc, profile_id asc
          limit :topContributorsLimit
          `,
          {
            waveId,
            topContributorsLimit,
            category,
            matter: RateMatter.WAVE_REP
          }
        )
      )
    );
    return categoryRows.flat();
  }

  public async getWaveRepCategorySummaries({
    waveId,
    limit
  }: {
    readonly waveId: string;
    readonly limit: number;
  }): Promise<WaveRepCategoryAggregationRow[]> {
    return this.db.execute<WaveRepCategoryAggregationRow>(
      `
      select
        r.matter_category as category,
        sum(r.rating) as total_rep,
        count(distinct r.rater_profile_id) as contributor_count,
        null as authenticated_user_contribution
      from ${RATINGS_TABLE} r
      where r.matter = :matter
        and r.matter_target_id = :waveId
        and r.rating <> 0
      group by 1
      order by abs(total_rep) desc, total_rep desc, category asc
      limit :limit
      `,
      { waveId, limit, matter: RateMatter.WAVE_REP }
    );
  }
}

export const waveRepOverviewDb = new WaveRepOverviewDb(dbSupplier);
