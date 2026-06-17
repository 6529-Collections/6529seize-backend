import { collections } from '@/collections';
import { numbers } from '@/numbers';
import { CountlessPage, PageSortDirection } from '@/api/page-request';
import { ApiGlobalRepCategoryGiver } from '@/api/generated/models/ApiGlobalRepCategoryGiver';
import { ApiGlobalRepCategoryGiversPage } from '@/api/generated/models/ApiGlobalRepCategoryGiversPage';
import { ApiGlobalRepCategoryOverview } from '@/api/generated/models/ApiGlobalRepCategoryOverview';
import { ApiGlobalRepCategoryRating } from '@/api/generated/models/ApiGlobalRepCategoryRating';
import { ApiGlobalRepCategoryRatingsPage } from '@/api/generated/models/ApiGlobalRepCategoryRatingsPage';
import { ApiGlobalRepCategoryRecipient } from '@/api/generated/models/ApiGlobalRepCategoryRecipient';
import { ApiGlobalRepCategoryRecipientsPage } from '@/api/generated/models/ApiGlobalRepCategoryRecipientsPage';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import {
  GlobalRepCategoryDb,
  globalRepCategoryDb,
  GlobalRepCategoryGiverRow,
  GlobalRepCategoryPairOrderBy,
  GlobalRepCategoryProfileOrderBy,
  GlobalRepCategoryRatingRow,
  GlobalRepCategoryRecipientRow
} from '@/api/rep-categories/global-rep-category.db';
import { RequestContext } from '@/request.context';

const OVERVIEW_LIMIT = 10;

export class GlobalRepCategoryApiService {
  constructor(
    private readonly globalRepCategoryDb: GlobalRepCategoryDb,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async getOverview(
    { category }: { readonly category: string },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryOverview> {
    const [stats, topRecipients, topGivers, recentlyUpdated] =
      await Promise.all([
        this.globalRepCategoryDb.getOverviewStats({ category }, ctx),
        this.globalRepCategoryDb.getRecipientsPage(
          {
            category,
            page: 1,
            page_size: OVERVIEW_LIMIT,
            order: PageSortDirection.DESC,
            order_by: 'rep',
            search: null
          },
          ctx
        ),
        this.globalRepCategoryDb.getGiversPage(
          {
            category,
            page: 1,
            page_size: OVERVIEW_LIMIT,
            order: PageSortDirection.DESC,
            order_by: 'rep',
            search: null
          },
          ctx
        ),
        this.globalRepCategoryDb.getRatingsPage(
          {
            category,
            page: 1,
            page_size: OVERVIEW_LIMIT,
            order: PageSortDirection.DESC,
            order_by: 'last_modified',
            search: null
          },
          ctx
        )
      ]);

    return {
      category,
      total_rep: numbers.parseIntOrNull(stats.total_rep) ?? 0,
      pair_count: numbers.parseIntOrNull(stats.pair_count) ?? 0,
      giver_count: numbers.parseIntOrNull(stats.giver_count) ?? 0,
      recipient_count: numbers.parseIntOrNull(stats.recipient_count) ?? 0,
      top_recipients: await this.mapRecipients(topRecipients.data, ctx),
      top_givers: await this.mapGivers(topGivers.data, ctx),
      recently_updated: await this.mapRatings(recentlyUpdated.data, ctx)
    };
  }

  public async getRatings(
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
  ): Promise<ApiGlobalRepCategoryRatingsPage> {
    const pageResult = await this.globalRepCategoryDb.getRatingsPage(
      { category, page, page_size, order, order_by, search },
      ctx
    );
    return {
      page: pageResult.page,
      next: pageResult.next,
      data: await this.mapRatings(pageResult.data, ctx)
    };
  }

  public async getRecipients(
    request: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryProfileOrderBy;
      readonly search: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryRecipientsPage> {
    const pageResult = await this.globalRepCategoryDb.getRecipientsPage(
      request,
      ctx
    );
    return this.mapRecipientsPage(pageResult, ctx);
  }

  public async getGivers(
    request: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryProfileOrderBy;
      readonly search: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryGiversPage> {
    const pageResult = await this.globalRepCategoryDb.getGiversPage(
      request,
      ctx
    );
    return this.mapGiversPage(pageResult, ctx);
  }

  private async mapRecipientsPage(
    pageResult: CountlessPage<GlobalRepCategoryRecipientRow>,
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryRecipientsPage> {
    return {
      page: pageResult.page,
      next: pageResult.next,
      data: await this.mapRecipients(pageResult.data, ctx)
    };
  }

  private async mapGiversPage(
    pageResult: CountlessPage<GlobalRepCategoryGiverRow>,
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryGiversPage> {
    return {
      page: pageResult.page,
      next: pageResult.next,
      data: await this.mapGivers(pageResult.data, ctx)
    };
  }

  private async mapRatings(
    rows: GlobalRepCategoryRatingRow[],
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryRating[]> {
    if (!rows.length) {
      return [];
    }
    const profilesById = await this.getProfilesByIds(
      rows.flatMap((row) => [row.giver_profile_id, row.recipient_profile_id]),
      ctx
    );
    return rows.map<ApiGlobalRepCategoryRating>((row) => ({
      category: row.category,
      giver: this.getProfileOrThrow(profilesById, row.giver_profile_id),
      recipient: this.getProfileOrThrow(profilesById, row.recipient_profile_id),
      rep: numbers.parseIntOrNull(row.rep) ?? 0,
      last_modified: this.toApiDate(row.last_modified)
    }));
  }

  private async mapRecipients(
    rows: GlobalRepCategoryRecipientRow[],
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryRecipient[]> {
    if (!rows.length) {
      return [];
    }
    const profilesById = await this.getProfilesByIds(
      rows.map((row) => row.profile_id),
      ctx
    );
    return rows.map<ApiGlobalRepCategoryRecipient>((row) => ({
      profile: this.getProfileOrThrow(profilesById, row.profile_id),
      total_rep: numbers.parseIntOrNull(row.total_rep) ?? 0,
      rater_count: numbers.parseIntOrNull(row.rater_count) ?? 0,
      last_modified: this.toApiDate(row.last_modified)
    }));
  }

  private async mapGivers(
    rows: GlobalRepCategoryGiverRow[],
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryGiver[]> {
    if (!rows.length) {
      return [];
    }
    const profilesById = await this.getProfilesByIds(
      rows.map((row) => row.profile_id),
      ctx
    );
    return rows.map<ApiGlobalRepCategoryGiver>((row) => ({
      profile: this.getProfileOrThrow(profilesById, row.profile_id),
      total_rep: numbers.parseIntOrNull(row.total_rep) ?? 0,
      recipient_count: numbers.parseIntOrNull(row.recipient_count) ?? 0,
      last_modified: this.toApiDate(row.last_modified)
    }));
  }

  private async getProfilesByIds(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, ApiProfileMin>> {
    const distinctProfileIds = collections.distinct(profileIds);
    return this.identityFetcher.getOverviewsByIds(distinctProfileIds, ctx);
  }

  private getProfileOrThrow(
    profilesById: Record<string, ApiProfileMin>,
    profileId: string
  ): ApiProfileMin {
    const profile = profilesById[profileId];
    if (!profile) {
      throw new Error(
        `Profile overview not found for REP profile ${profileId}`
      );
    }
    return profile;
  }

  private toApiDate(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }
}

export const globalRepCategoryApiService = new GlobalRepCategoryApiService(
  globalRepCategoryDb,
  identityFetcher
);
