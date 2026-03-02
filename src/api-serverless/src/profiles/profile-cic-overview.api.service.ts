import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { NotFoundException } from '@/exceptions';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import {
  CicContributorAggregationRow,
  CicDirection,
  ProfileCicOverviewDb,
  profileCicOverviewDb
} from '@/api/profiles/profile-cic-overview.db';
import { RequestContext } from '@/request.context';
import { CountlessPage } from '@/api/page-request';
import { ApiCicContributor } from '@/api/generated/models/ApiCicContributor';
import { ApiCicContributorsPage } from '@/api/generated/models/ApiCicContributorsPage';
import { ApiCicOverview } from '@/api/generated/models/ApiCicOverview';
import { collections } from '@/collections';
import { numbers } from '@/numbers';

export class ProfileCicOverviewApiService {
  constructor(
    private readonly profileCicOverviewDb: ProfileCicOverviewDb,
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
      readonly direction: CicDirection;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiCicOverview> {
    const contextProfileId = await this.resolveProfileIdOrThrow(identity, ctx);
    const authenticatedProfileId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const [overviewStats, contributorsPage] = await Promise.all([
      this.profileCicOverviewDb.getCicOverviewStats({
        contextProfileId,
        direction,
        authenticatedProfileId
      }),
      this.profileCicOverviewDb.getCicContributorsPage({
        contextProfileId,
        direction,
        page,
        page_size
      })
    ]);
    return {
      total_cic: numbers.parseIntOrNull(overviewStats.total_cic) ?? 0,
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

  public async getContributors(
    {
      identity,
      direction,
      page,
      page_size
    }: {
      readonly identity: string;
      readonly direction: CicDirection;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiCicContributorsPage> {
    const contextProfileId = await this.resolveProfileIdOrThrow(identity, ctx);
    const contributorsPage =
      await this.profileCicOverviewDb.getCicContributorsPage({
        contextProfileId,
        direction,
        page,
        page_size
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
    contributorsPage: CountlessPage<CicContributorAggregationRow>,
    ctx: RequestContext
  ): Promise<ApiCicContributorsPage> {
    return {
      page: contributorsPage.page,
      next: contributorsPage.next,
      data: await this.mapContributors(contributorsPage.data, ctx)
    };
  }

  private async mapContributors(
    rows: CicContributorAggregationRow[],
    ctx: RequestContext
  ): Promise<ApiCicContributor[]> {
    if (!rows.length) {
      return [];
    }
    const profileIds = collections.distinct(rows.map((it) => it.profile_id));
    const profilesById = await this.identityFetcher.getOverviewsByIds(
      profileIds,
      ctx
    );
    return rows.map<ApiCicContributor>((row) => {
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

export const profileCicOverviewApiService = new ProfileCicOverviewApiService(
  profileCicOverviewDb,
  identitiesDb,
  identityFetcher
);
