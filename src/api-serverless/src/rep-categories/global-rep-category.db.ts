import { IDENTITIES_TABLE, RATINGS_TABLE } from '@/constants';
import { CountlessPage, PageSortDirection } from '@/api/page-request';
import { RateMatter } from '@/entities/IRating';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type GlobalRepCategoryPairOrderBy =
  | 'rep'
  | 'last_modified'
  | 'giver'
  | 'recipient';

export type GlobalRepCategoryProfileOrderBy =
  | 'rep'
  | 'last_modified'
  | 'profile';

export interface GlobalRepCategoryOverviewStatsRow {
  readonly total_rep: number;
  readonly pair_count: number;
  readonly giver_count: number;
  readonly recipient_count: number;
}

export interface GlobalRepCategoryRatingRow {
  readonly giver_profile_id: string;
  readonly recipient_profile_id: string;
  readonly rep: number;
  readonly last_modified: string | Date;
  readonly category: string;
}

export interface GlobalRepCategoryRecipientRow {
  readonly profile_id: string;
  readonly total_rep: number;
  readonly rater_count: number;
  readonly last_modified: string | Date;
}

export interface GlobalRepCategoryGiverRow {
  readonly profile_id: string;
  readonly total_rep: number;
  readonly recipient_count: number;
  readonly last_modified: string | Date;
}

export class GlobalRepCategoryDb extends LazyDbAccessCompatibleService {
  public async getOverviewStats(
    { category }: { readonly category: string },
    ctx: RequestContext
  ): Promise<GlobalRepCategoryOverviewStatsRow> {
    const timerName = `${this.constructor.name}->getOverviewStats`;
    try {
      ctx.timer?.start(timerName);
      const row = await this.db.oneOrNull<GlobalRepCategoryOverviewStatsRow>(
        `
        select
          coalesce(sum(r.rating), 0) as total_rep,
          count(*) as pair_count,
          count(distinct r.rater_profile_id) as giver_count,
          count(distinct r.matter_target_id) as recipient_count
        from ${RATINGS_TABLE} r
        where r.matter = :matter
          and r.matter_category = :category
          and r.rating <> 0
        `,
        { category, matter: RateMatter.REP },
        { wrappedConnection: ctx.connection }
      );
      return {
        total_rep: row?.total_rep ?? 0,
        pair_count: row?.pair_count ?? 0,
        giver_count: row?.giver_count ?? 0,
        recipient_count: row?.recipient_count ?? 0
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async getRatingsPage(
    {
      category,
      page,
      page_size,
      order,
      order_by,
      search
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryPairOrderBy;
      readonly search: string | null;
    },
    ctx: RequestContext
  ): Promise<CountlessPage<GlobalRepCategoryRatingRow>> {
    const timerName = `${this.constructor.name}->getRatingsPage`;
    try {
      ctx.timer?.start(timerName);
      const offset = (page - 1) * page_size;
      const limitPlusOne = page_size + 1;
      const params = this.getBaseParams({
        category,
        search,
        offset,
        limitPlusOne
      });
      const rows = await this.db.execute<GlobalRepCategoryRatingRow>(
        `
        select
          r.rater_profile_id as giver_profile_id,
          r.matter_target_id as recipient_profile_id,
          r.rating as rep,
          r.last_modified,
          r.matter_category as category
        from ${RATINGS_TABLE} r
        where r.matter = :matter
          and r.matter_category = :category
          and r.rating <> 0
          ${this.getPairSearchClause(search)}
        ${this.getPairOrderBySql(order_by, order)}
        limit :limitPlusOne offset :offset
        `,
        params,
        { wrappedConnection: ctx.connection }
      );
      return {
        page,
        next: rows.length > page_size,
        data: rows.slice(0, page_size)
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async getRecipientsPage(
    params: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryProfileOrderBy;
      readonly search: string | null;
    },
    ctx: RequestContext
  ): Promise<CountlessPage<GlobalRepCategoryRecipientRow>> {
    return this.getProfileAggregationPage(
      {
        ...params,
        profileColumn: 'matter_target_id',
        counterColumn: 'rater_profile_id',
        counterAlias: 'rater_count'
      },
      ctx
    );
  }

  public async getGiversPage(
    params: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryProfileOrderBy;
      readonly search: string | null;
    },
    ctx: RequestContext
  ): Promise<CountlessPage<GlobalRepCategoryGiverRow>> {
    return this.getProfileAggregationPage(
      {
        ...params,
        profileColumn: 'rater_profile_id',
        counterColumn: 'matter_target_id',
        counterAlias: 'recipient_count'
      },
      ctx
    );
  }

  private async getProfileAggregationPage<
    T extends GlobalRepCategoryRecipientRow | GlobalRepCategoryGiverRow
  >(
    {
      category,
      page,
      page_size,
      order,
      order_by,
      search,
      profileColumn,
      counterColumn,
      counterAlias
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryProfileOrderBy;
      readonly search: string | null;
      readonly profileColumn: 'matter_target_id' | 'rater_profile_id';
      readonly counterColumn: 'matter_target_id' | 'rater_profile_id';
      readonly counterAlias: 'rater_count' | 'recipient_count';
    },
    ctx: RequestContext
  ): Promise<CountlessPage<T>> {
    const timerName = `${this.constructor.name}->getProfileAggregationPage`;
    try {
      ctx.timer?.start(timerName);
      const offset = (page - 1) * page_size;
      const limitPlusOne = page_size + 1;
      const params = this.getBaseParams({
        category,
        search,
        offset,
        limitPlusOne
      });
      const rows = await this.db.execute<T>(
        `
        with grouped_profiles as (
          select
            r.${profileColumn} as profile_id,
            sum(r.rating) as total_rep,
            count(distinct r.${counterColumn}) as ${counterAlias},
            max(r.last_modified) as last_modified
          from ${RATINGS_TABLE} r
          where r.matter = :matter
            and r.matter_category = :category
            and r.rating <> 0
            ${this.getProfileSearchClause(search, profileColumn)}
          group by 1
        )
        select
          gp.*
        from grouped_profiles gp
        ${this.getProfileOrderBySql(order_by, order)}
        limit :limitPlusOne offset :offset
        `,
        params,
        { wrappedConnection: ctx.connection }
      );
      return {
        page,
        next: rows.length > page_size,
        data: rows.slice(0, page_size)
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private getBaseParams({
    category,
    search,
    offset,
    limitPlusOne
  }: {
    readonly category: string;
    readonly search: string | null;
    readonly offset: number;
    readonly limitPlusOne: number;
  }): Record<string, unknown> {
    return {
      category,
      matter: RateMatter.REP,
      offset,
      limitPlusOne,
      searchLike: search ? `%${search}%` : null
    };
  }

  private getPairSearchClause(search: string | null): string {
    if (!search) {
      return '';
    }
    return `
      and (
        r.rater_profile_id like :searchLike
        or r.matter_target_id like :searchLike
        or exists (
          select 1
          from ${IDENTITIES_TABLE} searched_identity
          where searched_identity.profile_id in (
            r.rater_profile_id,
            r.matter_target_id
          )
            and (
              searched_identity.handle like :searchLike
              or searched_identity.normalised_handle like :searchLike
              or searched_identity.primary_address like :searchLike
            )
        )
      )`;
  }

  private getProfileSearchClause(
    search: string | null,
    profileColumn: 'matter_target_id' | 'rater_profile_id'
  ): string {
    if (!search) {
      return '';
    }
    return `
      and (
        r.${profileColumn} like :searchLike
        or exists (
          select 1
          from ${IDENTITIES_TABLE} searched_identity
          where searched_identity.profile_id = r.${profileColumn}
            and (
              searched_identity.handle like :searchLike
              or searched_identity.normalised_handle like :searchLike
              or searched_identity.primary_address like :searchLike
            )
        )
      )`;
  }

  private getPairOrderBySql(
    orderBy: GlobalRepCategoryPairOrderBy,
    order: PageSortDirection
  ): string {
    const direction = this.toSqlSortDirection(order);
    const sortExpressionByOrder: Record<GlobalRepCategoryPairOrderBy, string> =
      {
        rep: 'r.rating',
        last_modified: 'r.last_modified',
        giver: this.getProfileSortExpression('r.rater_profile_id'),
        recipient: this.getProfileSortExpression('r.matter_target_id')
      };
    const tieBreaker =
      orderBy === 'last_modified' || orderBy === 'rep'
        ? 'r.last_modified desc, r.rater_profile_id asc, r.matter_target_id asc'
        : 'r.rater_profile_id asc, r.matter_target_id asc';
    return `order by ${sortExpressionByOrder[orderBy]} ${direction}, ${tieBreaker}`;
  }

  private getProfileOrderBySql(
    orderBy: GlobalRepCategoryProfileOrderBy,
    order: PageSortDirection
  ): string {
    const direction = this.toSqlSortDirection(order);
    const sortExpressionByOrder: Record<
      GlobalRepCategoryProfileOrderBy,
      string
    > = {
      rep: 'gp.total_rep',
      last_modified: 'gp.last_modified',
      profile: this.getProfileSortExpression('gp.profile_id')
    };
    const tieBreaker =
      orderBy === 'last_modified' || orderBy === 'rep'
        ? 'gp.last_modified desc, gp.profile_id asc'
        : 'gp.profile_id asc';
    return `order by ${sortExpressionByOrder[orderBy]} ${direction}, ${tieBreaker}`;
  }

  private getProfileSortExpression(profileIdExpression: string): string {
    return `coalesce(
      (
        select coalesce(
          min(sort_identity.normalised_handle),
          min(sort_identity.handle),
          min(sort_identity.primary_address)
        )
        from ${IDENTITIES_TABLE} sort_identity
        where sort_identity.profile_id = ${profileIdExpression}
      ),
      ${profileIdExpression}
    )`;
  }

  private toSqlSortDirection(order: PageSortDirection): 'asc' | 'desc' {
    return order === PageSortDirection.ASC ? 'asc' : 'desc';
  }
}

export const globalRepCategoryDb = new GlobalRepCategoryDb(dbSupplier);
