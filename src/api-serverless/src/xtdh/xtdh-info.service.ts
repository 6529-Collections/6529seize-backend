import {
  xTdhRepository,
  XTdhRepository
} from '../../../tdh-grants/xtdh.repository';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { RequestContext } from '../../../request.context';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { ApiXTdhCollectionsPage } from '../generated/models/ApiXTdhCollectionsPage';
import { ApiXTdhContributionsPage } from '../generated/models/ApiXTdhContributionsPage';
import { ApiXTdhCollection } from '../generated/models/ApiXTdhCollection';
import { ApiXTdhTokensPage } from '../generated/models/ApiXTdhTokensPage';
import { ApiXTdhContribution } from '../generated/models/ApiXTdhContribution';
import { collections } from '../../../collections';
import {
  tdhGrantApiConverter,
  TdhGrantApiConverter
} from '../tdh-grants/tdh-grant.api-converter';
import {
  tdhGrantsFinder,
  TdhGrantsFinder
} from '../../../tdh-grants/tdh-grants.finder';
import { ApiTdhGrant } from '../generated/models/ApiTdhGrant';
import { ApiXTdhToken } from '../generated/models/ApiXTdhToken';
import { ApiXTdhGranteesPage } from '../generated/models/ApiXTdhGranteesPage';
import { ApiXTdhGrantee } from '../generated/models/ApiXTdhGrantee';

export interface XTdhCollectionsQueryParams {
  identity: string | null;
  page: number;
  page_size: number;
  sort: 'xtdh' | 'xtdh_rate';
  order: ApiPageSortDirection;
}

export interface XTdhTokensQueryParams {
  identity: string | null;
  contract: string | null;
  token: number | null;
  page: number;
  page_size: number;
  sort: 'xtdh' | 'xtdh_rate';
  order: ApiPageSortDirection;
}

export interface XTdhContributorsQueryParams {
  group_by: 'grant' | 'grantor';
  contract: string;
  token: number;
  page: number;
  page_size: number;
  sort: 'xtdh' | 'xtdh_rate';
  order: ApiPageSortDirection;
}

export interface XTdhGranteesQueryParams {
  contract: string | null;
  page: number;
  page_size: number;
  sort: 'xtdh' | 'xtdh_rate';
  order: ApiPageSortDirection;
}

export class XTdhInfoService {
  constructor(
    private readonly xtdhRepository: XTdhRepository,
    private readonly identityFetcher: IdentityFetcher,
    private readonly tdhGrantsFinder: TdhGrantsFinder,
    private readonly tdhGrantApiConverter: TdhGrantApiConverter
  ) {}

  public async getXTdhCollections(
    { identity, page, page_size, sort, order }: XTdhCollectionsQueryParams,
    ctx: RequestContext
  ): Promise<ApiXTdhCollectionsPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhCollections`);
      const limit = page_size + 1;
      const offset = page_size * (page - 1);
      let identityId: string | null = null;
      if (identity) {
        identityId = await this.identityFetcher.getProfileIdByIdentityKey(
          {
            identityKey: identity
          },
          ctx
        );
        if (!identityId) {
          throw new NotFoundException(`Identity ${identity} not found`);
        }
      }
      const collectionEntities = await this.xtdhRepository.getXTdhCollections(
        {
          identityId,
          limit,
          offset,
          order,
          sort
        },
        ctx
      );
      return {
        page,
        next: collectionEntities.length === limit,
        data: collectionEntities
          .map<ApiXTdhCollection>((it) => ({
            contract: it.contract,
            total_contributor_count: it.total_contributors_count,
            active_contributor_count: it.active_contributors_count,
            total_token_count: it.total_token_count,
            active_token_count: it.active_token_count,
            xtdh: it.xtdh,
            xtdh_rate: it.xtdh_rate
          }))
          .slice(0, limit - 1)
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhCollections`);
    }
  }

  public async getXTdhTokens(
    {
      identity,
      contract,
      token,
      page,
      page_size,
      sort,
      order
    }: XTdhTokensQueryParams,
    ctx: RequestContext
  ): Promise<ApiXTdhTokensPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhTokens`);
      if (token !== null && contract === null) {
        throw new BadRequestException(
          `You have to specify contract when you specify a token`
        );
      }
      const limit = page_size + 1;
      const offset = page_size * (page - 1);
      let identityId: string | null = null;
      if (identity) {
        identityId = await this.identityFetcher.getProfileIdByIdentityKey(
          {
            identityKey: identity
          },
          ctx
        );
        if (!identityId) {
          throw new NotFoundException(`Identity ${identity} not found`);
        }
      }
      const tokenEntities = await this.xtdhRepository.getXTdhTokens(
        {
          identityId,
          contract,
          limit,
          offset,
          tokenId: token,
          order,
          sort
        },
        ctx
      );
      const relatedOwnerIds = collections.distinct(
        tokenEntities.map((it) => it.owner_id)
      );
      const ownerProfiles = await this.identityFetcher.getOverviewsByIds(
        relatedOwnerIds,
        ctx
      );

      return {
        page,
        next: tokenEntities.length === limit,
        data: tokenEntities
          .map<ApiXTdhToken>((it) => ({
            contract: it.contract,
            token: it.token_id,
            owner: ownerProfiles[it.owner_id]!,
            total_contributor_count: it.total_contributor_count,
            active_contributor_count: it.active_contributor_count,
            xtdh: it.xtdh,
            xtdh_rate: it.xtdh_rate
          }))
          .slice(0, limit - 1)
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhTokens`);
    }
  }

  public async getXTdhContributors(
    {
      contract,
      group_by,
      token,
      page,
      page_size,
      sort,
      order
    }: XTdhContributorsQueryParams,
    ctx: RequestContext
  ): Promise<ApiXTdhContributionsPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhContributors`);
      if (token !== null && contract === null) {
        throw new BadRequestException(
          `You have to specify contract when you specify a token`
        );
      }
      const limit = page_size + 1;
      const offset = page_size * (page - 1);
      const contributorEntities =
        await this.xtdhRepository.getTokenContributors(
          {
            contract,
            groupBy: group_by,
            limit,
            offset,
            token,
            order,
            sort
          },
          ctx
        );
      const relatedGrantorIds = collections.distinct(
        contributorEntities
          .map((it) => it.grantor_id)
          .filter((it) => !!it) as string[]
      );
      const relatedGrantIds = collections.distinct(
        contributorEntities
          .map((it) => it.grant_id)
          .filter((it) => !!it) as string[]
      );
      const relatedGrantModels = await this.tdhGrantsFinder.getGrantsByIds(
        relatedGrantIds,
        ctx
      );
      const relatedGrantApiModels = await this.tdhGrantApiConverter
        .fromTdhGrantModelsToApiTdhGrants(relatedGrantModels, ctx)
        .then((res) =>
          res.reduce(
            (acc, it) => {
              acc[it.id] = it;
              return acc;
            },
            {} as Record<string, ApiTdhGrant>
          )
        );
      const grantorProfiles = await this.identityFetcher.getOverviewsByIds(
        relatedGrantorIds,
        ctx
      );
      return {
        page,
        next: contributorEntities.length === limit,
        data: contributorEntities
          .map<ApiXTdhContribution>((it) => ({
            grantor:
              it.grantor_id && !it.grant_id
                ? grantorProfiles[it.grantor_id]
                : undefined,
            grant: it.grant_id ? relatedGrantApiModels[it.grant_id] : undefined,
            grant_count: it.grant_count,
            xtdh: it.xtdh,
            xtdh_rate: it.xtdh_rate
          }))
          .slice(0, limit - 1)
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhContributors`);
    }
  }

  public async getXTdhGrantees(
    { contract, page, page_size, sort, order }: XTdhGranteesQueryParams,
    ctx: RequestContext
  ): Promise<ApiXTdhGranteesPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhGrantees`);
      const limit = page_size + 1;
      const offset = page_size * (page - 1);
      const granteeEntities = await this.xtdhRepository.getXTdhTopGrantees(
        {
          contract,
          limit,
          offset,
          order,
          sort
        },
        ctx
      );
      const relatedGranteeIds = collections.distinct(
        granteeEntities.map((it) => it.grantee_id).filter((it) => !!it)
      );
      const granteeProfiles = await this.identityFetcher.getOverviewsByIds(
        relatedGranteeIds,
        ctx
      );
      return {
        page,
        next: granteeEntities.length === limit,
        data: granteeEntities
          .map<ApiXTdhGrantee>((it) => ({
            grantee: granteeProfiles[it.grantee_id]!,
            collections_count: it.collections_count,
            tokens_count: it.tokens_count,
            xtdh: it.xtdh,
            xtdh_rate: it.xtdh_rate
          }))
          .slice(0, limit - 1)
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhGrantees`);
    }
  }
}

export const xtdhInfoService = new XTdhInfoService(
  xTdhRepository,
  identityFetcher,
  tdhGrantsFinder,
  tdhGrantApiConverter
);
