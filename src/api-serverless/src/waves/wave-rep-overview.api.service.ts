import { collections } from '@/collections';
import { numbers } from '@/numbers';
import { NotFoundException } from '@/exceptions';
import { CountlessPage } from '@/api/page-request';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import { ApiWaveRepCategoriesPage } from '@/api/generated/models/ApiWaveRepCategoriesPage';
import { ApiWaveRepCategory } from '@/api/generated/models/ApiWaveRepCategory';
import { ApiWaveRepContributor } from '@/api/generated/models/ApiWaveRepContributor';
import { ApiWaveRepContributorsPage } from '@/api/generated/models/ApiWaveRepContributorsPage';
import { ApiWaveRepOverview } from '@/api/generated/models/ApiWaveRepOverview';
import { RequestContext } from '@/request.context';
import { WavesApiDb, wavesApiDb } from '@/api/waves/waves.api.db';
import { assertWaveAndParentVisibleOrThrow } from '@/api/waves/wave-access.helpers';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  WaveRepContributorAggregationRow,
  WaveRepOverviewDb,
  waveRepOverviewDb
} from '@/api/waves/wave-rep-overview.db';

export class WaveRepOverviewApiService {
  constructor(
    private readonly waveRepOverviewDb: WaveRepOverviewDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async getOverview(
    {
      waveId,
      page,
      page_size
    }: {
      readonly waveId: string;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveRepOverview> {
    await this.assertWaveVisible(waveId, ctx);
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const [overviewStats, contributorsPage] = await Promise.all([
      this.waveRepOverviewDb.getWaveRepOverviewStats({
        waveId,
        authenticatedProfileId
      }),
      this.waveRepOverviewDb.getWaveRepContributorsPage({
        waveId,
        page,
        page_size,
        category: null
      })
    ]);
    return {
      total_rep: numbers.parseIntOrNull(overviewStats.total_rep) ?? 0,
      positive_rep: numbers.parseIntOrNull(overviewStats.positive_rep) ?? 0,
      negative_rep: numbers.parseIntOrNull(overviewStats.negative_rep) ?? 0,
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
      waveId,
      page,
      page_size,
      top_contributors_limit
    }: {
      readonly waveId: string;
      readonly page: number;
      readonly page_size: number;
      readonly top_contributors_limit: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveRepCategoriesPage> {
    await this.assertWaveVisible(waveId, ctx);
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const categoriesPage =
      await this.waveRepOverviewDb.getWaveRepCategoriesPage({
        waveId,
        authenticatedProfileId,
        page,
        page_size
      });
    const categories = categoriesPage.data.map((it) => it.category);
    const topContributors =
      await this.waveRepOverviewDb.getTopWaveRepContributorsByCategories({
        waveId,
        categories,
        topContributorsLimit: top_contributors_limit
      });
    const topContributorsProfiles = await this.mapContributors(
      topContributors.map((it) => ({
        profile_id: it.profile_id,
        contribution: it.contribution
      })),
      ctx
    );
    const topContributorsByCategory = new Map<
      string,
      ApiWaveRepContributor[]
    >();
    topContributors.forEach((row, index) => {
      const existing = topContributorsByCategory.get(row.category) ?? [];
      existing.push(topContributorsProfiles[index]);
      topContributorsByCategory.set(row.category, existing);
    });
    return {
      page,
      next: categoriesPage.next,
      data: categoriesPage.data.map<ApiWaveRepCategory>((row) => ({
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
      waveId,
      category,
      page,
      page_size
    }: {
      readonly waveId: string;
      readonly category: string;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveRepContributorsPage> {
    await this.assertWaveVisible(waveId, ctx);
    const contributorsPage =
      await this.waveRepOverviewDb.getWaveRepContributorsPage({
        waveId,
        page,
        page_size,
        category
      });
    return this.mapContributorsPage(contributorsPage, ctx);
  }

  private async assertWaveVisible(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const eligibleGroups = authenticatedProfileId
      ? await this.userGroupsService.getGroupsUserIsEligibleFor(
          authenticatedProfileId,
          ctx.timer
        )
      : [];
    const wave = await this.wavesApiDb.findWaveById(waveId, ctx.connection);
    await assertWaveAndParentVisibleOrThrow({
      wave,
      groupsUserIsEligibleFor: eligibleGroups,
      message: `Wave ${waveId} not found`,
      wavesApiDb: this.wavesApiDb,
      ctx
    });
    if (!wave) {
      throw new NotFoundException(`Wave ${waveId} not found`);
    }
  }

  private async mapContributorsPage(
    contributorsPage: CountlessPage<WaveRepContributorAggregationRow>,
    ctx: RequestContext
  ): Promise<ApiWaveRepContributorsPage> {
    return {
      page: contributorsPage.page,
      next: contributorsPage.next,
      data: await this.mapContributors(contributorsPage.data, ctx)
    };
  }

  private async mapContributors(
    rows: WaveRepContributorAggregationRow[],
    ctx: RequestContext
  ): Promise<ApiWaveRepContributor[]> {
    if (!rows.length) {
      return [];
    }
    const profileIds = collections.distinct(rows.map((it) => it.profile_id));
    const profilesById = await this.identityFetcher.getOverviewsByIds(
      profileIds,
      ctx
    );
    return rows.map<ApiWaveRepContributor>((row) => {
      const profile = profilesById[row.profile_id];
      if (!profile) {
        throw new Error(
          `Profile overview not found for Wave REP contributor ${row.profile_id}`
        );
      }
      return {
        contribution: numbers.parseIntOrNull(row.contribution) ?? 0,
        profile
      };
    });
  }
}

export const waveRepOverviewApiService = new WaveRepOverviewApiService(
  waveRepOverviewDb,
  wavesApiDb,
  userGroupsService,
  identityFetcher
);
