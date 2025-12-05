import { assertUnreachable } from '../../../../assertions';
import { Time } from '../../../../time';
import {
  CreateXTdhGrantCommand,
  XTdhGrantModel
} from '../../../../xtdh/xtdh-grant.models';
import { collections } from '../../../../collections';
import {
  IdentityFetcher,
  identityFetcher
} from '../../identities/identity.fetcher';
import { XTdhGrantStatus } from '../../../../entities/IXTdhGrant';
import { enums } from '../../../../enums';
import { RequestContext } from '../../../../request.context';
import { XTdhGrantSearchRequestApiModel } from './xtdh-grant-search-request.api-model';
import { BadRequestException } from '../../../../exceptions';
import { ApiXTdhCreateGrant } from '../../generated/models/ApiXTdhCreateGrant';
import { ApiXTdhGrant } from '../../generated/models/ApiXTdhGrant';
import { ApiXTdhGrantTargetChain } from '../../generated/models/ApiXTdhGrantTargetChain';
import { ApiXTdhGrantStatus } from '../../generated/models/ApiXTdhGrantStatus';
import {
  xTdhRepository,
  XTdhRepository
} from '../../../../xtdh/xtdh.repository';

export class XTdhGrantApiConverter {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly xTdhRepository: XTdhRepository
  ) {}

  public fromApiCreateXTdhGrantToModel({
    apiCreateXTdhGrant,
    grantorId
  }: {
    apiCreateXTdhGrant: ApiXTdhCreateGrant;
    grantorId: string;
  }): CreateXTdhGrantCommand {
    return {
      grantor_id: grantorId,
      target_chain: this.resolveTargetChainFromApiValue(
        apiCreateXTdhGrant.target_chain
      ),
      target_contract: apiCreateXTdhGrant.target_contract,
      target_tokens: apiCreateXTdhGrant.target_tokens,
      valid_to: apiCreateXTdhGrant.valid_to
        ? Time.millis(apiCreateXTdhGrant.valid_to)
        : null,
      rate: apiCreateXTdhGrant.rate,
      is_irrevocable: apiCreateXTdhGrant.is_irrevocable
    };
  }

  public async fromXTdhGrantModelToApiXTdhGrant(
    model: XTdhGrantModel,
    ctx: RequestContext
  ): Promise<ApiXTdhGrant> {
    const apiResponses = await this.fromXTdhGrantModelsToApiXTdhGrants(
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

  public async fromXTdhGrantModelsToApiXTdhGrants(
    models: XTdhGrantModel[],
    ctx: RequestContext
  ): Promise<ApiXTdhGrant[]> {
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
    return models.map<ApiXTdhGrant>((model) => ({
      id: model.id,
      grantor: grantorIdentities[model.grantor_id],
      target_chain: this.resolveApiTargetChainFromModelValue({
        chainId: model.target_chain,
        grantId: model.id
      }),
      target_contract: model.target_contract,
      target_tokens_count: model.target_token_count,

      rate: model.rate,
      status: this.resolveApiStatusFromModelValue({
        grantId: model.id,
        status: model.status
      }),
      target_collection_name: model.target_collection_name,
      error_details: model.error_details,
      created_at: model.created_at.toMillis(),
      updated_at: model.updated_at.toMillis(),
      valid_from: model.valid_from?.toMillis() ?? null,
      valid_to: model.valid_to?.toMillis() ?? null,
      is_irrevocable: model.is_irrevocable,
      total_granted: model.total_granted
    }));
  }

  private resolveTargetChainFromApiValue(
    apiTargetChain: ApiXTdhGrantTargetChain
  ): number {
    switch (apiTargetChain) {
      case ApiXTdhGrantTargetChain.EthereumMainnet:
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
  }): ApiXTdhGrantTargetChain {
    if (chainId === 1) {
      return ApiXTdhGrantTargetChain.EthereumMainnet;
    }
    throw new Error(
      `Unknown xTDH grant chain ID ${chainId} for grant ${grantId}`
    );
  }

  private resolveApiStatusFromModelValue({
    status,
    grantId
  }: {
    status: XTdhGrantStatus;
    grantId: string;
  }): ApiXTdhGrantStatus {
    const result = enums.resolve(ApiXTdhGrantStatus, status);
    if (!result) {
      throw new BadRequestException(
        `Unknown xTDH Grant status ${status} for grant ${grantId}`
      );
    }
    return result;
  }

  private resolveModelStatusFromApiValue(status: string): XTdhGrantStatus {
    const result = enums.resolve(XTdhGrantStatus, status);
    if (!result) {
      throw new BadRequestException(`Unknown xTDH Grant status ${status}`);
    }
    return result;
  }

  public async prepApiSearchRequest(
    apiModel: XTdhGrantSearchRequestApiModel,
    ctx: RequestContext
  ): Promise<{
    readonly grantor_id: string | null;
    readonly target_contracts: string[];
    readonly target_chain: number | null;
    readonly status: XTdhGrantStatus[];
    readonly valid_from_lt: number | null;
    readonly valid_from_gt: number | null;
    readonly valid_to_lt: number | null;
    readonly valid_to_gt: number | null;
    readonly sort_direction: 'ASC' | 'DESC' | null;
    readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'rate' | null;
    readonly page: number;
    readonly page_size: number;
    readonly conflictingRequest: boolean;
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
      apiModel.status
        ?.split(',')
        ?.map((it) => this.resolveModelStatusFromApiValue(it)) ?? [];
    const targetCollectionName = apiModel.target_collection_name;
    let targetContracts: string[] = [];
    const targetContract = apiModel.target_contract;
    let conflictingRequest = false;
    if (targetCollectionName?.length) {
      const targets =
        await this.xTdhRepository.getContractsOfExternalAddressesWhereNameLike(
          targetCollectionName,
          ctx
        );
      if (!targets.length) {
        conflictingRequest = true;
      }
      if (targetContract) {
        if (!targets.includes(targetContract)) {
          conflictingRequest = true;
        } else {
          targetContracts = [targetContract];
        }
      } else {
        targetContracts = targets;
      }
    }
    return {
      grantor_id: grantorId,
      target_contracts: targetContracts,
      target_chain: targetChain,
      valid_from_lt: apiModel.valid_from_lt,
      valid_from_gt: apiModel.valid_from_gt,
      valid_to_lt: apiModel.valid_to_lt,
      valid_to_gt: apiModel.valid_to_gt,
      status: status,
      sort_direction: apiModel.sort_direction,
      sort: apiModel.sort,
      page: apiModel.page,
      page_size: apiModel.page_size,
      conflictingRequest
    };
  }
}

export const xTdhGrantApiConverter = new XTdhGrantApiConverter(
  identityFetcher,
  xTdhRepository
);
