import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { NotFoundException } from '@/exceptions';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import {
  ProfileRepOverviewDb,
  profileRepOverviewDb,
  RepContributorAggregationRow,
  RepDirection
} from '@/api/profiles/profile-rep-overview.db';
import { RequestContext } from '@/request.context';
import { CountlessPage } from '@/api/page-request';
import { ApiRepCategoriesPage } from '@/api/generated/models/ApiRepCategoriesPage';
import { ApiRepCategory } from '@/api/generated/models/ApiRepCategory';
import { ApiRepContributor } from '@/api/generated/models/ApiRepContributor';
import { ApiRepContributorsPage } from '@/api/generated/models/ApiRepContributorsPage';
import { ApiRepOverview } from '@/api/generated/models/ApiRepOverview';
import { collections } from '@/collections';
import { numbers } from '@/numbers';

export class ProfileRepOverviewApiService {
  constructor(
    private readonly profileRepOverviewDb: ProfileRepOverviewDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async getOverview(
    {
      identity,
      direction,
      page,
      page_size
    }: {
      readonly identity: string;
      readonly direction: RepDirection;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiRepOverview> {
    const contextProfileId = await this.resolveProfileIdOrThrow(identity, ctx);
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const [overviewStats, contributorsPage] = await Promise.all([
      this.profileRepOverviewDb.getRepOverviewStats({
        contextProfileId,
        direction,
        authenticatedProfileId
      }),
      this.profileRepOverviewDb.getRepContributorsPage({
        contextProfileId,
        direction,
        page,
        page_size,
        category: null
      })
    ]);
    return {
      total_rep: numbers.parseIntOrNull(overviewStats.total_rep) ?? 0,
      authenticated_user_contribution:
        overviewStats.authenticated_user_contribution === null
          ? null
          : (numbers.parseIntOrNull(
              overviewStats.authenticated_user_contribution
            ) ?? 0),
      contributor_count:
        numbers.parseIntOrNull(overviewStats.contributor_count) ?? 0,
      contributors: await this.mapContributorsPage(contributorsPage, ctx)
    };
  }

  public async getCategories(
    {
      identity,
      direction,
      page,
      page_size,
      top_contributors_limit
    }: {
      readonly identity: string;
      readonly direction: RepDirection;
      readonly page: number;
      readonly page_size: number;
      readonly top_contributors_limit: number;
    },
    ctx: RequestContext
  ): Promise<ApiRepCategoriesPage> {
    const contextProfileId = await this.resolveProfileIdOrThrow(identity, ctx);
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const categoriesPage = await this.profileRepOverviewDb.getRepCategoriesPage(
      {
        contextProfileId,
        direction,
        authenticatedProfileId,
        page,
        page_size
      }
    );
    const categories = categoriesPage.data.map((it) => it.category);
    const topContributors =
      await this.profileRepOverviewDb.getTopRepContributorsByCategories({
        contextProfileId,
        direction,
        categories,
        topContributorsLimit: top_contributors_limit
      });
    const topContributorsByCategory = new Map<string, ApiRepContributor[]>();
    const topContributorsProfiles = await this.mapContributors(
      topContributors.map((it) => ({
        profile_id: it.profile_id,
        contribution: it.contribution
      })),
      ctx
    );
    topContributors.forEach((row, index) => {
      const existing = topContributorsByCategory.get(row.category) ?? [];
      existing.push(topContributorsProfiles[index]);
      topContributorsByCategory.set(row.category, existing);
    });
    return {
      page,
      next: categoriesPage.next,
      data: categoriesPage.data.map<ApiRepCategory>((row) => ({
        category: row.category,
        total_rep: numbers.parseIntOrNull(row.total_rep) ?? 0,
        contributor_count: numbers.parseIntOrNull(row.contributor_count) ?? 0,
        authenticated_user_contribution:
          row.authenticated_user_contribution === null
            ? null
            : (numbers.parseIntOrNull(row.authenticated_user_contribution) ??
              0),
        top_contributors: topContributorsByCategory.get(row.category) ?? []
      }))
    };
  }

  public async getCategoryContributors(
    {
      identity,
      direction,
      category,
      page,
      page_size
    }: {
      readonly identity: string;
      readonly direction: RepDirection;
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiRepContributorsPage> {
    const contextProfileId = await this.resolveProfileIdOrThrow(identity, ctx);
    const contributorsPage =
      await this.profileRepOverviewDb.getRepContributorsPage({
        contextProfileId,
        direction,
        page,
        page_size,
        category
      });
    return this.mapContributorsPage(contributorsPage, ctx);
  }

  private async resolveProfileIdOrThrow(
    identity: string,
    ctx: RequestContext
  ): Promise<string> {
    const profileId = await this.identitiesDb.getProfileIdByIdentityKeyFast(
      { identityKey: identity },
      ctx
    );
    if (!profileId) {
      throw new NotFoundException(`Profile not found for identity ${identity}`);
    }
    return profileId;
  }

  private async mapContributorsPage(
    contributorsPage: CountlessPage<RepContributorAggregationRow>,
    ctx: RequestContext
  ): Promise<ApiRepContributorsPage> {
    return {
      page: contributorsPage.page,
      next: contributorsPage.next,
      data: await this.mapContributors(contributorsPage.data, ctx)
    };
  }

  private async mapContributors(
    rows: RepContributorAggregationRow[],
    ctx: RequestContext
  ): Promise<ApiRepContributor[]> {
    if (!rows.length) {
      return [];
    }
    const profileIds = collections.distinct(rows.map((it) => it.profile_id));
    const profilesById = await this.identityFetcher.getOverviewsByIds(
      profileIds,
      ctx
    );
    return rows.map<ApiRepContributor>((row) => {
      const profile = profilesById[row.profile_id];
      if (!profile) {
        throw new Error(
          `Profile overview not found for contributor ${row.profile_id}`
        );
      }
      return {
        contribution: numbers.parseIntOrNull(row.contribution) ?? 0,
        profile
      };
    });
  }
}

export const profileRepOverviewApiService = new ProfileRepOverviewApiService(
  profileRepOverviewDb,
  identitiesDb,
  identityFetcher
);
