import {
  xTdhRepository,
  XTdhRepository
} from '../../../tdh-grants/xtdh.repository';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { RequestContext } from '../../../request.context';
import { ApiContract } from '../generated/models/ApiContract';
import { ApiXTdhTokenGrantor } from '../generated/models/ApiXTdhTokenGrantor';
import { ApiXTdhToken } from '../generated/models/ApiXTdhToken';
import { NotFoundException } from '../../../exceptions';

export class XTdhInfoService {
  constructor(
    private readonly xtdhRepository: XTdhRepository,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async getContractsBaseOnWhichIdentityHasXTdh(
    identity: string,
    ctx: RequestContext
  ): Promise<ApiContract[]> {
    const identityId = await this.identityFetcher
      .getProfileIdByIdentityKey(
        {
          identityKey: identity
        },
        ctx
      )
      .then((it) => {
        if (it === null) {
          throw new NotFoundException(`Identity ${identity} not found`);
        }
        return it;
      });
    const result = await this.xtdhRepository.getReceivedContractsByIdentity(
      identityId,
      ctx
    );
    return result.map((contract) => ({ contract }));
  }

  public async getTokenXTdhContributors(
    { contract, token }: { contract: string; token: string },
    ctx: RequestContext
  ): Promise<ApiXTdhTokenGrantor[]> {
    const result = await this.xtdhRepository.getTokenGrantors(
      { contract, token },
      ctx
    );
    const identities = await this.identityFetcher.getOverviewsByIds(
      result.map((it) => it.profile_id),
      ctx
    );
    return result.map((it) => ({
      xtdh: it.xtdh,
      xtdh_rate: it.xtdh_rate,
      grantor: identities[it.profile_id]!
    }));
  }

  public async getXTdhTokens(
    params: {
      grantee: string | null;
      contract: string | null;
      token: string | null;
      page: number;
      page_size: number;
    },
    ctx: RequestContext
  ): Promise<{ tokens: ApiXTdhToken[]; next: boolean }> {
    const identityId =
      params.grantee === null
        ? null
        : await this.identityFetcher
            .getProfileIdByIdentityKey(
              {
                identityKey: params.grantee
              },
              ctx
            )
            .then((it) => {
              if (it === null) {
                throw new NotFoundException(
                  `Identity ${params.grantee} not found`
                );
              }
              return it;
            });
    const filters: {
      identityId?: string | null;
      collection?: string | null;
      token?: string | null;
      offset?: number | null;
      limit?: number | null;
    } = {
      identityId,
      collection: params.contract?.toLowerCase(),
      token: params.token,
      limit: params.page_size + 1,
      offset: params.page_size * (params.page - 1)
    };
    const elements = await this.xtdhRepository.getXTdhTokens(filters, ctx);
    const next = elements.length === params.page_size + 1;
    return {
      next,
      tokens: elements.slice(0, params.page_size)
    };
  }
}

export const xtdhInfoService = new XTdhInfoService(
  xTdhRepository,
  identityFetcher
);
