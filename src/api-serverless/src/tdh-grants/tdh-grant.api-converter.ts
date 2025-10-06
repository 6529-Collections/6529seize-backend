import { ApiTdhGrantTargetChain } from '../generated/models/ApiTdhGrantTargetChain';
import { assertUnreachable } from '../../../assertions';
import { ApiCreateTdhGrant } from '../generated/models/ApiCreateTdhGrant';
import { Time } from '../../../time';
import {
  CreateTdhGrantCommand,
  TdhGrantModel
} from '../../../tdh-grants/create-tdh-grant.models';
import { ApiTdhGrant } from '../generated/models/ApiTdhGrant';
import { collections } from '../../../collections';
import {
  IdentityFetcher,
  identityFetcher
} from '../identities/identity.fetcher';
import { TdhGrantStatus } from '../../../entities/ITdhGrant';
import { ApiTdhGrantStatus } from '../generated/models/ApiTdhGrantStatus';
import { enums } from '../../../enums';
import { RequestContext } from '../../../request.context';
import { TdhGrantSearchRequestApiModel } from './tdh-grant-search-request.api-model';

export class TdhGrantApiConverter {
  constructor(private readonly identityFetcher: IdentityFetcher) {}

  public fromApiCreateTdhGrantToModel({
    apiCreateTdhGrant,
    grantorId
  }: {
    apiCreateTdhGrant: ApiCreateTdhGrant;
    grantorId: string;
  }): CreateTdhGrantCommand {
    return {
      grantor_id: grantorId,
      target_chain: this.resolveTargetChainFromApiValue(
        apiCreateTdhGrant.target_chain
      ),
      target_contract: apiCreateTdhGrant.target_contract,
      target_tokens: apiCreateTdhGrant.target_tokens,
      valid_to: apiCreateTdhGrant.valid_to
        ? Time.millis(apiCreateTdhGrant.valid_to)
        : null,
      tdh_rate: apiCreateTdhGrant.tdh_rate,
      is_irrevocable: apiCreateTdhGrant.is_irrevocable
    };
  }

  public async fromTdhGrantModelToApiTdhGrant(
    model: TdhGrantModel,
    ctx: RequestContext
  ): Promise<ApiTdhGrant> {
    const apiResponses = await this.fromTdhGrantModelsToApiTdhGrants(
      [model],
      ctx
    );
    const result = apiResponses.at(0);
    if (!result) {
      throw new Error(
        `Something is wrong. There was supposed to be a grant, but there is none. Model: ${JSON.stringify(
          model
        )}`
      );
    }
    return result;
  }

  public async fromTdhGrantModelsToApiTdhGrants(
    models: TdhGrantModel[],
    ctx: RequestContext
  ): Promise<ApiTdhGrant[]> {
    if (!models.length) {
      return [];
    }
    const grantorIds = collections.distinct(
      models.map((model) => model.grantor_id)
    );
    const grantorIdentities = await this.identityFetcher.getOverviewsByIds(
      grantorIds,
      ctx
    );
    return models.map<ApiTdhGrant>((model) => ({
      id: model.id,
      grantor: grantorIdentities[model.grantor_id]!,
      target_chain: this.resolveApiTargetChainFromModelValue({
        chainId: model.target_chain,
        grantId: model.id
      }),
      target_contract: model.target_contract,
      target_tokens: model.target_tokens,
      tdh_rate: model.tdh_rate,
      status: this.resolveApiStatusFromModelValue({
        grantId: model.id,
        status: model.status
      }),
      error_details: model.error_details,
      created_at: model.created_at.toMillis(),
      valid_from: model.valid_from?.toMillis() ?? null,
      valid_to: model.valid_to?.toMillis() ?? null,
      is_irrevocable: model.is_irrevocable
    }));
  }

  private resolveTargetChainFromApiValue(
    apiTargetChain: ApiTdhGrantTargetChain
  ): number {
    switch (apiTargetChain) {
      case ApiTdhGrantTargetChain.EthereumMainnet:
        return 1;
      default:
        throw assertUnreachable(apiTargetChain);
    }
  }

  private resolveApiTargetChainFromModelValue({
    grantId,
    chainId
  }: {
    grantId: string;
    chainId: number;
  }): ApiTdhGrantTargetChain {
    if (chainId === 1) {
      return ApiTdhGrantTargetChain.EthereumMainnet;
    }
    throw new Error(
      `Unknown TDH grant chain ID ${chainId} for grant ${grantId}`
    );
  }

  private resolveApiStatusFromModelValue({
    status,
    grantId
  }: {
    status: TdhGrantStatus;
    grantId: string;
  }): ApiTdhGrantStatus {
    const result = enums.resolve(ApiTdhGrantStatus, status);
    if (!result) {
      throw new Error(
        `Unknown TDH Grant status ${status} for grant ${grantId}`
      );
    }
    return result;
  }

  private resolveModelStatusFromApiValue(
    status: ApiTdhGrantStatus
  ): TdhGrantStatus {
    const result = enums.resolve(TdhGrantStatus, status);
    if (!result) {
      throw new Error(`Unknown TDH Grant status ${status}`);
    }
    return result;
  }

  public async prepApiSearchRequest(
    apiModel: TdhGrantSearchRequestApiModel,
    ctx: RequestContext
  ): Promise<{
    readonly grantor_id: string | null;
    readonly target_contract: string | null;
    readonly target_chain: number | null;
    readonly status: TdhGrantStatus | null;
    readonly sort_direction: 'ASC' | 'DESC' | null;
    readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'tdh_rate' | null;
    readonly page: number;
    readonly page_size: number;
  }> {
    const grantorId = apiModel.grantor
      ? await identityFetcher.getProfileIdByIdentityKeyOrThrow(
          {
            identityKey: apiModel.grantor
          },
          ctx
        )
      : null;
    const targetChain =
      apiModel.target_chain === null
        ? null
        : this.resolveTargetChainFromApiValue(apiModel.target_chain);
    const status =
      apiModel.status === null
        ? null
        : this.resolveModelStatusFromApiValue(apiModel.status);
    return {
      grantor_id: grantorId,
      target_contract: apiModel.target_contract,
      target_chain: targetChain,
      status: status,
      sort_direction: apiModel.sort_direction,
      sort: apiModel.sort,
      page: apiModel.page,
      page_size: apiModel.page_size
    };
  }
}

export const tdhGrantApiConverter = new TdhGrantApiConverter(identityFetcher);
