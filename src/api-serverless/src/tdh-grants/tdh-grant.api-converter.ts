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
      valid_to: Time.millis(apiCreateTdhGrant.valid_to),
      tdh_rate: apiCreateTdhGrant.tdh_rate,
      is_irrevocable: apiCreateTdhGrant.is_irrevocable
    };
  }

  public async fromTdhGrantModelToApiTdhGrant(
    model: TdhGrantModel
  ): Promise<ApiTdhGrant> {
    const apiResponses = await this.fromTdhGrantModelsToApiTdhGrants([model]);
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
    models: TdhGrantModel[]
  ): Promise<ApiTdhGrant[]> {
    if (!models.length) {
      return [];
    }
    const grantorIds = collections.distinct(
      models.map((model) => model.grantor_id)
    );
    const grantorIdentities = await this.identityFetcher.getOverviewsByIds(
      grantorIds,
      {}
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
      valid_to: model.valid_to.toMillis(),
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
}

export const tdhGrantApiConverter = new TdhGrantApiConverter(identityFetcher);
