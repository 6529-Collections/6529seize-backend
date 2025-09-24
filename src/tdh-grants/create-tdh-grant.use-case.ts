import { RequestContext } from '../request.context';
import {
  CreateTdhGrantCommand,
  TdhGrantModel
} from './create-tdh-grant.models';
import { BadRequestException } from '../exceptions';
import {
  nftIndexerClient,
  NftIndexerClient
} from '../api-serverless/src/nft-indexer-client/nft-indexer-client';
import { TdhGrantEntity, TdhGrantStatus } from '../entities/ITdhGrant';
import { randomUUID } from 'crypto';
import { Time } from '../time';
import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';

export class CreateTdhGrantUseCase {
  constructor(
    private readonly indexerClient: NftIndexerClient,
    private readonly tdhGrantsRepository: TdhGrantsRepository
  ) {}

  public async handle(
    command: CreateTdhGrantCommand,
    ctx: RequestContext
  ): Promise<TdhGrantModel> {
    ctx.timer?.start(`${this.constructor.name}->handle`);
    try {
      if (command.is_irrevocable) {
        throw new BadRequestException(
          `Irrevocable grants are not supported yet`
        );
      }
      const indexerState = await this.indexerClient.getStateOrStartIndexing({
        chain: command.target_chain,
        contract: command.target_contract
      });
      if (
        indexerState.status === 'ERROR_SNAPSHOTTING' ||
        indexerState.status === 'UNINDEXABLE' ||
        indexerState.status === 'NOT_INDEXED' ||
        (indexerState.status !== 'LIVE_TAILING' &&
          indexerState.status !== 'SNAPSHOTTING' &&
          indexerState.status !== 'WAITING_FOR_SNAPSHOTTING')
      ) {
        throw new BadRequestException(
          `There is a problem snapshotting given address. Please let the dev team know.`
        );
      }
      return await this.tdhGrantsRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const entity: TdhGrantEntity = {
            id: randomUUID(),
            grantor_id: command.grantor_id,
            target_chain: command.target_chain,
            target_contract: command.target_contract,
            target_tokens: command.target_tokens.length
              ? command.target_tokens.join(`,`)
              : null,
            created_at: Time.currentMillis(),
            valid_from: null,
            valid_to: command.valid_to.toMillis(),
            tdh_rate: command.tdh_rate,
            status: TdhGrantStatus.PENDING,
            error_details: null,
            is_irrevocable: command.is_irrevocable
          };
          await this.tdhGrantsRepository.insertGrant(entity, ctxWithConnection);
          return {
            id: entity.id,
            target_chain: entity.target_chain,
            target_contract: entity.target_contract,
            target_tokens:
              entity.target_tokens === null
                ? []
                : JSON.parse(entity.target_tokens),
            valid_from:
              entity.valid_from === null
                ? null
                : Time.millis(entity.valid_from),
            valid_to: Time.millis(entity.valid_to),
            created_at: Time.millis(entity.created_at),
            status: entity.status,
            error_details: entity.error_details,
            tdh_rate: entity.tdh_rate,
            is_irrevocable: entity.is_irrevocable,
            grantor_id: entity.grantor_id
          };
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }
}

export const createTdhGrantUseCase = new CreateTdhGrantUseCase(
  nftIndexerClient,
  tdhGrantsRepository
);
