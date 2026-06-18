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
import { ApiGlobalRepCategorySuggestedCategory } from '@/api/generated/models/ApiGlobalRepCategorySuggestedCategory';
import { ApiGlobalRepCategoryWave } from '@/api/generated/models/ApiGlobalRepCategoryWave';
import { ApiGlobalRepCategoryWaveContributor } from '@/api/generated/models/ApiGlobalRepCategoryWaveContributor';
import { ApiGlobalRepCategoryWaveContributorsPage } from '@/api/generated/models/ApiGlobalRepCategoryWaveContributorsPage';
import { ApiGlobalRepCategoryWaveOverview } from '@/api/generated/models/ApiGlobalRepCategoryWaveOverview';
import { ApiGlobalRepCategoryWavesPage } from '@/api/generated/models/ApiGlobalRepCategoryWavesPage';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  GlobalRepCategoryDb,
  GlobalRepCategoryDbInteger,
  globalRepCategoryDb,
  GlobalRepCategoryGiverRow,
  GlobalRepCategoryPairOrderBy,
  GlobalRepCategoryProfileOrderBy,
  GlobalRepCategoryRatingRow,
  GlobalRepCategoryRecipientRow,
  GlobalRepCategoryTopCategoryRow,
  GlobalRepCategoryWaveContributorRow,
  GlobalRepCategoryWaveOrderBy,
  GlobalRepCategoryWaveRow
} from '@/api/rep-categories/global-rep-category.db';
import { REP_CATEGORY_PATTERN } from '@/entities/IAbusivenessDetectionResult';
import { RequestContext } from '@/request.context';

const OVERVIEW_LIMIT = 10;
const SUGGESTED_CATEGORIES_LIMIT = 12;
const SUGGESTED_CATEGORIES_QUERY_PAGE_SIZE = SUGGESTED_CATEGORIES_LIMIT * 3;
const WAVE_TOP_CONTRIBUTORS_LIMIT = 3;

export class GlobalRepCategoryApiService {
  constructor(
    private readonly globalRepCategoryDb: GlobalRepCategoryDb,
    private readonly identityFetcher: IdentityFetcher,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async getSuggestedCategories(
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategorySuggestedCategory[]> {
    const groupIdsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleFor(ctx);
    const rows: GlobalRepCategoryTopCategoryRow[] = [];
    let offset = 0;

    while (rows.length < SUGGESTED_CATEGORIES_LIMIT) {
      const pageRows = await this.globalRepCategoryDb.getSuggestedCategories(
        {
          limit: SUGGESTED_CATEGORIES_QUERY_PAGE_SIZE,
          offset,
          groupIdsUserIsEligibleFor
        },
        ctx
      );
      const validRows = pageRows.filter((row) =>
        REP_CATEGORY_PATTERN.test(row.category)
      );
      rows.push(
        ...validRows.slice(0, SUGGESTED_CATEGORIES_LIMIT - rows.length)
      );
      if (pageRows.length < SUGGESTED_CATEGORIES_QUERY_PAGE_SIZE) {
        break;
      }
      offset += SUGGESTED_CATEGORIES_QUERY_PAGE_SIZE;
    }

    return rows.map((row) => this.mapSuggestedCategory(row));
  }

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
      total_rep: this.parseDbInteger(stats.total_rep, 'total_rep'),
      pair_count: this.parseDbInteger(stats.pair_count, 'pair_count'),
      giver_count: this.parseDbInteger(stats.giver_count, 'giver_count'),
      recipient_count: this.parseDbInteger(
        stats.recipient_count,
        'recipient_count'
      ),
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

  public async getWaveOverview(
    { category }: { readonly category: string },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryWaveOverview> {
    const groupIdsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleFor(ctx);
    const [stats, wavesPage, contributorsPage] = await Promise.all([
      this.globalRepCategoryDb.getWaveOverviewStats(
        { category, groupIdsUserIsEligibleFor },
        ctx
      ),
      this.globalRepCategoryDb.getWavesPage(
        {
          category,
          page: 1,
          page_size: OVERVIEW_LIMIT,
          order: PageSortDirection.DESC,
          order_by: 'rep',
          groupIdsUserIsEligibleFor
        },
        ctx
      ),
      this.globalRepCategoryDb.getWaveContributorsPage(
        {
          category,
          page: 1,
          page_size: OVERVIEW_LIMIT,
          order: PageSortDirection.DESC,
          order_by: 'rep',
          groupIdsUserIsEligibleFor
        },
        ctx
      )
    ]);
    return {
      category,
      total_rep: this.parseDbInteger(stats.total_rep, 'wave_total_rep'),
      wave_count: this.parseDbInteger(stats.wave_count, 'wave_count'),
      contributor_count: this.parseDbInteger(
        stats.contributor_count,
        'wave_contributor_count'
      ),
      top_waves: await this.mapWaves(
        {
          category,
          rows: wavesPage.data,
          groupIdsUserIsEligibleFor
        },
        ctx
      ),
      top_contributors: await this.mapWaveContributors(
        contributorsPage.data,
        ctx
      )
    };
  }

  public async getWaves(
    {
      category,
      page,
      page_size,
      order,
      order_by
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryWaveOrderBy;
    },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryWavesPage> {
    const groupIdsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleFor(ctx);
    const pageResult = await this.globalRepCategoryDb.getWavesPage(
      {
        category,
        page,
        page_size,
        order,
        order_by,
        groupIdsUserIsEligibleFor
      },
      ctx
    );
    return {
      page: pageResult.page,
      next: pageResult.next,
      data: await this.mapWaves(
        {
          category,
          rows: pageResult.data,
          groupIdsUserIsEligibleFor
        },
        ctx
      )
    };
  }

  public async getWaveContributors(
    {
      category,
      page,
      page_size,
      order,
      order_by
    }: {
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
      readonly order: PageSortDirection;
      readonly order_by: GlobalRepCategoryWaveOrderBy;
    },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryWaveContributorsPage> {
    const groupIdsUserIsEligibleFor =
      await this.getGroupsUserIsEligibleFor(ctx);
    const pageResult = await this.globalRepCategoryDb.getWaveContributorsPage(
      {
        category,
        page,
        page_size,
        order,
        order_by,
        groupIdsUserIsEligibleFor
      },
      ctx
    );
    return {
      page: pageResult.page,
      next: pageResult.next,
      data: await this.mapWaveContributors(pageResult.data, ctx)
    };
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
      rep: this.parseDbInteger(row.rep, 'rep'),
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
      total_rep: this.parseDbInteger(row.total_rep, 'total_rep'),
      rater_count: this.parseDbInteger(row.rater_count, 'rater_count'),
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
      total_rep: this.parseDbInteger(row.total_rep, 'total_rep'),
      recipient_count: this.parseDbInteger(
        row.recipient_count,
        'recipient_count'
      ),
      last_modified: this.toApiDate(row.last_modified)
    }));
  }

  private async mapWaves(
    {
      category,
      rows,
      groupIdsUserIsEligibleFor
    }: {
      readonly category: string;
      readonly rows: GlobalRepCategoryWaveRow[];
      readonly groupIdsUserIsEligibleFor: string[];
    },
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryWave[]> {
    if (!rows.length) {
      return [];
    }
    const topContributorRows =
      await this.globalRepCategoryDb.getTopWaveContributorsByWaveIds(
        {
          category,
          waveIds: rows.map((row) => row.wave_id),
          topContributorsLimit: WAVE_TOP_CONTRIBUTORS_LIMIT,
          groupIdsUserIsEligibleFor
        },
        ctx
      );
    const mappedTopContributors = await this.mapWaveContributors(
      topContributorRows,
      ctx
    );
    const topContributorsByWaveId = new Map<
      string,
      ApiGlobalRepCategoryWaveContributor[]
    >();
    topContributorRows.forEach((row, index) => {
      const existing = topContributorsByWaveId.get(row.wave_id) ?? [];
      existing.push(mappedTopContributors[index]);
      topContributorsByWaveId.set(row.wave_id, existing);
    });
    return rows.map<ApiGlobalRepCategoryWave>((row) => ({
      wave: this.mapWaveRef(row),
      total_rep: this.parseDbInteger(row.total_rep, 'wave_total_rep'),
      contributor_count: this.parseDbInteger(
        row.contributor_count,
        'wave_contributor_count'
      ),
      last_modified: this.toApiDate(row.last_modified),
      top_contributors: topContributorsByWaveId.get(row.wave_id) ?? []
    }));
  }

  private async mapWaveContributors(
    rows: GlobalRepCategoryWaveContributorRow[],
    ctx: RequestContext
  ): Promise<ApiGlobalRepCategoryWaveContributor[]> {
    if (!rows.length) {
      return [];
    }
    const profilesById = await this.getProfilesByIds(
      rows.map((row) => row.profile_id),
      ctx
    );
    return rows.map<ApiGlobalRepCategoryWaveContributor>((row) => ({
      wave: this.mapWaveRef(row),
      profile: this.getProfileOrThrow(profilesById, row.profile_id),
      contribution: this.parseDbInteger(row.contribution, 'wave_contribution'),
      last_modified: this.toApiDate(row.last_modified)
    }));
  }

  private mapWaveRef(
    row: Pick<
      GlobalRepCategoryWaveRow,
      'wave_id' | 'wave_name' | 'wave_picture' | 'is_direct_message'
    >
  ) {
    return {
      id: row.wave_id,
      name: row.wave_name,
      pfp: row.wave_picture,
      is_direct_message:
        row.is_direct_message === true || row.is_direct_message === 1
    };
  }

  private mapSuggestedCategory(
    row: GlobalRepCategoryTopCategoryRow
  ): ApiGlobalRepCategorySuggestedCategory {
    return {
      category: row.category,
      total_rep: this.parseDbInteger(row.total_rep, 'suggested_total_rep'),
      profile_rep: this.parseDbInteger(
        row.profile_rep,
        'suggested_profile_rep'
      ),
      wave_rep: this.parseDbInteger(row.wave_rep, 'suggested_wave_rep'),
      rating_count: this.parseDbInteger(
        row.rating_count,
        'suggested_rating_count'
      ),
      last_modified: this.toApiDate(row.last_modified)
    };
  }

  private async getGroupsUserIsEligibleFor(
    ctx: RequestContext
  ): Promise<string[]> {
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    return authenticatedProfileId
      ? this.userGroupsService.getGroupsUserIsEligibleFor(
          authenticatedProfileId,
          ctx.timer
        )
      : [];
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

  private parseDbInteger(
    value: GlobalRepCategoryDbInteger,
    fieldName: string
  ): number {
    const parsed = numbers.parseIntOrNull(value);
    if (parsed === null || !Number.isSafeInteger(parsed)) {
      throw new Error(
        `Invalid integer value for global REP category field ${fieldName}`
      );
    }
    return parsed;
  }
}

export const globalRepCategoryApiService = new GlobalRepCategoryApiService(
  globalRepCategoryDb,
  identityFetcher,
  userGroupsService
);
