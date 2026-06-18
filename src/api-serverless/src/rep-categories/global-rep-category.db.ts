import { IDENTITIES_TABLE, RATINGS_TABLE, WAVES_TABLE } from '@/constants';
import { CountlessPage, PageSortDirection } from '@/api/page-request';
import { RateMatter } from '@/entities/IRating';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const LIKE_ESCAPE_REPLACEMENT = String.raw`\$&`;

export type GlobalRepCategoryDbInteger = string | number | bigint;

export type GlobalRepCategoryPairOrderBy =
  | 'rep'
  | 'last_modified'
  | 'giver'
  | 'recipient';

export type GlobalRepCategoryProfileOrderBy =
  | 'rep'
  | 'last_modified'
  | 'profile';

export type GlobalRepCategoryWaveOrderBy = 'rep' | 'last_modified' | 'wave';

export interface GlobalRepCategoryOverviewStatsRow {
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly pair_count: GlobalRepCategoryDbInteger;
  readonly giver_count: GlobalRepCategoryDbInteger;
  readonly recipient_count: GlobalRepCategoryDbInteger;
}

export interface GlobalRepCategoryRatingRow {
  readonly giver_profile_id: string;
  readonly recipient_profile_id: string;
  readonly rep: GlobalRepCategoryDbInteger;
  readonly last_modified: string | Date;
  readonly category: string;
}

export interface GlobalRepCategoryRecipientRow {
  readonly profile_id: string;
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly rater_count: GlobalRepCategoryDbInteger;
  readonly last_modified: string | Date;
}

export interface GlobalRepCategoryGiverRow {
  readonly profile_id: string;
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly recipient_count: GlobalRepCategoryDbInteger;
  readonly last_modified: string | Date;
}

export interface GlobalRepCategoryWaveStatsRow {
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly wave_count: GlobalRepCategoryDbInteger;
  readonly contributor_count: GlobalRepCategoryDbInteger;
}

export interface GlobalRepCategoryWaveRow {
  readonly wave_id: string;
  readonly wave_name: string;
  readonly wave_picture: string | null;
  readonly is_direct_message: boolean | number | null;
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly contributor_count: GlobalRepCategoryDbInteger;
  readonly last_modified: string | Date;
}

export interface GlobalRepCategoryWaveContributorRow {
  readonly wave_id: string;
  readonly wave_name: string;
  readonly wave_picture: string | null;
  readonly is_direct_message: boolean | number | null;
  readonly profile_id: string;
  readonly contribution: GlobalRepCategoryDbInteger;
  readonly last_modified: string | Date;
}

export interface GlobalRepCategoryTopCategoryRow {
  readonly category: string;
  readonly total_rep: GlobalRepCategoryDbInteger;
  readonly profile_rep: GlobalRepCategoryDbInteger;
  readonly wave_rep: GlobalRepCategoryDbInteger;
  readonly rating_count: GlobalRepCategoryDbInteger;
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
        total_rep: row?.total_rep ?? '0',
        pair_count: row?.pair_count ?? '0',
        giver_count: row?.giver_count ?? '0',
        recipient_count: row?.recipient_count ?? '0'
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

  public async getSuggestedCategories(
    {
      limit,
      offset,
      groupIdsUserIsEligibleFor
    }: {
      readonly limit: number;
      readonly offset: number;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<GlobalRepCategoryTopCategoryRow[]> {
    const timerName = `${this.constructor.name}->getSuggestedCategories`;
    try {
      ctx.timer?.start(timerName);
      return this.db.execute<GlobalRepCategoryTopCategoryRow>(
        `
        with visible_rep as (
          select
            r.matter_category,
            r.rating,
            r.matter,
            r.last_modified
          from ${RATINGS_TABLE} r
          left join ${WAVES_TABLE} w
            on w.id = r.matter_target_id
            and r.matter = :waveMatter
          -- Join by parent wave id only, preserving one rating row per wave REP row.
          left join ${WAVES_TABLE} pw
            on pw.id = w.parent_wave_id
            and r.matter = :waveMatter
          where r.matter in (:profileMatter, :waveMatter)
            and r.rating <> 0
            and (
              r.matter = :profileMatter
              or (
                r.matter = :waveMatter
                and w.id is not null
                and ${this.getWaveAndParentVisibilityFilter(
                  groupIdsUserIsEligibleFor
                )}
              )
            )
        )
        select
          r.matter_category as category,
          sum(r.rating) as total_rep,
          sum(case when r.matter = :profileMatter then r.rating else 0 end) as profile_rep,
          sum(case when r.matter = :waveMatter then r.rating else 0 end) as wave_rep,
          count(*) as rating_count,
          max(r.last_modified) as last_modified
        from visible_rep r
        group by 1
        order by abs(total_rep) desc, total_rep desc, last_modified desc, category asc
        limit :limit
        offset :offset
        `,
        {
          limit,
          offset,
          profileMatter: RateMatter.REP,
          waveMatter: RateMatter.WAVE_REP,
          groupIdsUserIsEligibleFor
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async getWaveOverviewStats(
    {
      category,
      groupIdsUserIsEligibleFor
    }: {
      readonly category: string;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<GlobalRepCategoryWaveStatsRow> {
    const timerName = `${this.constructor.name}->getWaveOverviewStats`;
    try {
      ctx.timer?.start(timerName);
      const row = await this.db.oneOrNull<GlobalRepCategoryWaveStatsRow>(
        `
        select
          coalesce(sum(r.rating), 0) as total_rep,
          count(distinct r.matter_target_id) as wave_count,
          count(distinct r.rater_profile_id) as contributor_count
        from ${RATINGS_TABLE} r
        join ${WAVES_TABLE} w on w.id = r.matter_target_id
        left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
        where r.matter = :matter
          and r.matter_category = :category
          and r.rating <> 0
          and ${this.getWaveAndParentVisibilityFilter(
            groupIdsUserIsEligibleFor
          )}
        `,
        {
          category,
          matter: RateMatter.WAVE_REP,
          groupIdsUserIsEligibleFor
        },
        { wrappedConnection: ctx.connection }
      );
      return {
        total_rep: row?.total_rep ?? '0',
        wave_count: row?.wave_count ?? '0',
        contributor_count: row?.contributor_count ?? '0'
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async getWavesPage(
    {
      category,
      page,
      page_size,
      order,
      order_by,
      groupIdsUserIsEligibleFor
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryWaveOrderBy;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<CountlessPage<GlobalRepCategoryWaveRow>> {
    const timerName = `${this.constructor.name}->getWavesPage`;
    try {
      ctx.timer?.start(timerName);
      const offset = (page - 1) * page_size;
      const limitPlusOne = page_size + 1;
      const rows = await this.db.execute<GlobalRepCategoryWaveRow>(
        `
        with grouped_waves as (
          select
            r.matter_target_id as wave_id,
            w.name as wave_name,
            w.picture as wave_picture,
            coalesce(w.is_direct_message, 0) as is_direct_message,
            sum(r.rating) as total_rep,
            count(distinct r.rater_profile_id) as contributor_count,
            max(r.last_modified) as last_modified
          from ${RATINGS_TABLE} r
          join ${WAVES_TABLE} w on w.id = r.matter_target_id
          left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
          where r.matter = :matter
            and r.matter_category = :category
            and r.rating <> 0
            and ${this.getWaveAndParentVisibilityFilter(
              groupIdsUserIsEligibleFor
            )}
          group by 1, 2, 3, 4
        )
        select
          gw.*
        from grouped_waves gw
        ${this.getWaveOrderBySql(order_by, order)}
        limit :limitPlusOne offset :offset
        `,
        {
          category,
          matter: RateMatter.WAVE_REP,
          offset,
          limitPlusOne,
          groupIdsUserIsEligibleFor
        },
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

  public async getWaveContributorsPage(
    {
      category,
      page,
      page_size,
      order,
      order_by,
      groupIdsUserIsEligibleFor
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryWaveOrderBy;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<CountlessPage<GlobalRepCategoryWaveContributorRow>> {
    const timerName = `${this.constructor.name}->getWaveContributorsPage`;
    try {
      ctx.timer?.start(timerName);
      const offset = (page - 1) * page_size;
      const limitPlusOne = page_size + 1;
      const rows = await this.db.execute<GlobalRepCategoryWaveContributorRow>(
        `
        with grouped_contributors as (
          select
            r.matter_target_id as wave_id,
            w.name as wave_name,
            w.picture as wave_picture,
            coalesce(w.is_direct_message, 0) as is_direct_message,
            r.rater_profile_id as profile_id,
            sum(r.rating) as contribution,
            max(r.last_modified) as last_modified
          from ${RATINGS_TABLE} r
          join ${WAVES_TABLE} w on w.id = r.matter_target_id
          left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
          where r.matter = :matter
            and r.matter_category = :category
            and r.rating <> 0
            and ${this.getWaveAndParentVisibilityFilter(
              groupIdsUserIsEligibleFor
            )}
          group by 1, 2, 3, 4, 5
        )
        select
          gc.*
        from grouped_contributors gc
        ${this.getWaveContributorOrderBySql(order_by, order)}
        limit :limitPlusOne offset :offset
        `,
        {
          category,
          matter: RateMatter.WAVE_REP,
          offset,
          limitPlusOne,
          groupIdsUserIsEligibleFor
        },
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

  public async getTopWaveContributorsByWaveIds(
    {
      category,
      waveIds,
      topContributorsLimit,
      groupIdsUserIsEligibleFor
    }: {
      readonly category: string;
      readonly waveIds: string[];
      readonly topContributorsLimit: number;
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<GlobalRepCategoryWaveContributorRow[]> {
    if (!waveIds.length || topContributorsLimit <= 0) {
      return [];
    }
    return this.db.execute<GlobalRepCategoryWaveContributorRow>(
      `
      with grouped_contributors as (
        select
          r.matter_target_id as wave_id,
          w.name as wave_name,
          w.picture as wave_picture,
          coalesce(w.is_direct_message, 0) as is_direct_message,
          r.rater_profile_id as profile_id,
          sum(r.rating) as contribution,
          max(r.last_modified) as last_modified
        from ${RATINGS_TABLE} r
        join ${WAVES_TABLE} w on w.id = r.matter_target_id
        left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
        where r.matter = :matter
          and r.matter_category = :category
          and r.matter_target_id in (:waveIds)
          and r.rating <> 0
          and ${this.getWaveAndParentVisibilityFilter(
            groupIdsUserIsEligibleFor
          )}
        group by 1, 2, 3, 4, 5
      ),
      ranked_contributors as (
        select
          gc.*,
          row_number() over (
            partition by gc.wave_id
            order by abs(gc.contribution) desc, gc.contribution desc, gc.last_modified desc, gc.profile_id asc
          ) as wave_rank
        from grouped_contributors gc
      )
      select
        rc.wave_id,
        rc.wave_name,
        rc.wave_picture,
        rc.is_direct_message,
        rc.profile_id,
        rc.contribution,
        rc.last_modified
      from ranked_contributors rc
      where rc.wave_rank <= :topContributorsLimit
      order by rc.wave_id asc, rc.wave_rank asc
      `,
      {
        category,
        waveIds,
        topContributorsLimit,
        matter: RateMatter.WAVE_REP,
        groupIdsUserIsEligibleFor
      },
      { wrappedConnection: ctx.connection }
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
      searchLike: search ? this.toEscapedLikeContains(search) : null
    };
  }

  private getPairSearchClause(search: string | null): string {
    if (!search) {
      return '';
    }
    return String.raw`
      and (
        r.rater_profile_id like :searchLike escape '\\'
        or r.matter_target_id like :searchLike escape '\\'
        or exists (
          select 1
          from ${IDENTITIES_TABLE} searched_identity
          where searched_identity.profile_id in (
            r.rater_profile_id,
            r.matter_target_id
          )
            and (
              searched_identity.handle like :searchLike escape '\\'
              or searched_identity.normalised_handle like :searchLike escape '\\'
              or searched_identity.primary_address like :searchLike escape '\\'
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
    return String.raw`
      and (
        r.${profileColumn} like :searchLike escape '\\'
        or exists (
          select 1
          from ${IDENTITIES_TABLE} searched_identity
          where searched_identity.profile_id = r.${profileColumn}
            and (
              searched_identity.handle like :searchLike escape '\\'
              or searched_identity.normalised_handle like :searchLike escape '\\'
              or searched_identity.primary_address like :searchLike escape '\\'
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
        rep: 'abs(r.rating)',
        last_modified: 'r.last_modified',
        giver: this.getProfileSortExpression('r.rater_profile_id'),
        recipient: this.getProfileSortExpression('r.matter_target_id')
      };
    const tieBreaker = this.getPairTieBreaker(orderBy);
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
      rep: 'abs(gp.total_rep)',
      last_modified: 'gp.last_modified',
      profile: this.getProfileSortExpression('gp.profile_id')
    };
    const tieBreaker = this.getProfileTieBreaker(orderBy);
    return `order by ${sortExpressionByOrder[orderBy]} ${direction}, ${tieBreaker}`;
  }

  private getWaveOrderBySql(
    orderBy: GlobalRepCategoryWaveOrderBy,
    order: PageSortDirection
  ): string {
    const direction = this.toSqlSortDirection(order);
    const sortExpressionByOrder: Record<GlobalRepCategoryWaveOrderBy, string> =
      {
        rep: 'abs(gw.total_rep)',
        last_modified: 'gw.last_modified',
        wave: 'gw.wave_name'
      };
    const tieBreaker = this.getWaveTieBreaker(orderBy);
    return `order by ${sortExpressionByOrder[orderBy]} ${direction}, ${tieBreaker}`;
  }

  private getWaveContributorOrderBySql(
    orderBy: GlobalRepCategoryWaveOrderBy,
    order: PageSortDirection
  ): string {
    const direction = this.toSqlSortDirection(order);
    const sortExpressionByOrder: Record<GlobalRepCategoryWaveOrderBy, string> =
      {
        rep: 'abs(gc.contribution)',
        last_modified: 'gc.last_modified',
        wave: 'gc.wave_name'
      };
    const tieBreaker = this.getWaveContributorTieBreaker(orderBy);
    return `order by ${sortExpressionByOrder[orderBy]} ${direction}, ${tieBreaker}`;
  }

  private getPairTieBreaker(orderBy: GlobalRepCategoryPairOrderBy): string {
    switch (orderBy) {
      case 'last_modified':
        return 'r.last_modified desc, r.rater_profile_id asc, r.matter_target_id asc';
      case 'rep':
        return 'r.rating desc, r.last_modified desc, r.rater_profile_id asc, r.matter_target_id asc';
      case 'giver':
      case 'recipient':
        return 'r.rater_profile_id asc, r.matter_target_id asc';
    }
  }

  private getProfileTieBreaker(
    orderBy: GlobalRepCategoryProfileOrderBy
  ): string {
    switch (orderBy) {
      case 'last_modified':
        return 'gp.last_modified desc, gp.profile_id asc';
      case 'rep':
        return 'gp.total_rep desc, gp.last_modified desc, gp.profile_id asc';
      case 'profile':
        return 'gp.profile_id asc';
    }
  }

  private getWaveTieBreaker(orderBy: GlobalRepCategoryWaveOrderBy): string {
    switch (orderBy) {
      case 'last_modified':
        return 'gw.last_modified desc, gw.wave_name asc, gw.wave_id asc';
      case 'rep':
        return 'gw.total_rep desc, gw.last_modified desc, gw.wave_name asc, gw.wave_id asc';
      case 'wave':
        return 'gw.wave_id asc';
    }
  }

  private getWaveContributorTieBreaker(
    orderBy: GlobalRepCategoryWaveOrderBy
  ): string {
    switch (orderBy) {
      case 'last_modified':
        return 'gc.last_modified desc, gc.wave_name asc, gc.profile_id asc';
      case 'rep':
        return 'gc.contribution desc, gc.last_modified desc, gc.wave_name asc, gc.profile_id asc';
      case 'wave':
        return 'gc.wave_id asc, gc.profile_id asc';
    }
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

  private toEscapedLikeContains(value: string): string {
    return `%${value.replace(/[\\%_]/g, LIKE_ESCAPE_REPLACEMENT)}%`;
  }

  private getWaveAndParentVisibilityFilter(
    groupIdsUserIsEligibleFor: readonly string[]
  ): string {
    const waveVisibilityFilter = this.getSingleWaveVisibilityFilter(
      'w',
      groupIdsUserIsEligibleFor
    );
    const parentVisibilityFilter = this.getSingleWaveVisibilityFilter(
      'pw',
      groupIdsUserIsEligibleFor
    );
    return `
      ${waveVisibilityFilter}
      and (
        w.parent_wave_id is null
        or (
          pw.id is not null
          and pw.parent_wave_id is null
          and ${parentVisibilityFilter}
        )
      )`;
  }

  private getSingleWaveVisibilityFilter(
    waveAlias: 'w' | 'pw',
    groupIdsUserIsEligibleFor: readonly string[]
  ): string {
    const groupClause = groupIdsUserIsEligibleFor.length
      ? `or ${waveAlias}.visibility_group_id in (:groupIdsUserIsEligibleFor)`
      : '';
    return `(
      (${waveAlias}.visibility_group_id is null ${groupClause})
      and (
        coalesce(${waveAlias}.is_direct_message, 0) = 0
        ${groupClause}
      )
    )`;
  }
}

export const globalRepCategoryDb = new GlobalRepCategoryDb(dbSupplier);
