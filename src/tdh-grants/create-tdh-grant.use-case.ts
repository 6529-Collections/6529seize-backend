import { RequestContext } from '../request.context';
import {
  CreateTdhGrantCommand,
  fromTdhGrantEntityToModel,
  TdhGrantModel
} from './tdh-grant.models';
import { BadRequestException } from '../exceptions';
import {
  TdhGrantEntity,
  TdhGrantStatus,
  TdhGrantTokenMode
} from '../entities/ITdhGrant';
import { randomUUID } from 'crypto';
import { Time } from '../time';
import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import {
  externalIndexingRepository,
  ExternalIndexingRepository
} from '../external-indexing/external-indexing.repository';
import { numbers } from '../numbers';
import { TdhGrantTokenEntity } from '../entities/ITdhGrantToken';

export class CreateTdhGrantUseCase {
  constructor(
    private readonly tdhGrantsRepository: TdhGrantsRepository,
    private readonly externalIndexingRepository: ExternalIndexingRepository
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
      const indexerState =
        await this.externalIndexingRepository.upsertOrSelectCollection(
          {
            chain: command.target_chain,
            contract: command.target_contract
          },
          ctx
        );
      if (
        indexerState.status === 'ERROR_SNAPSHOTTING' ||
        indexerState.status === 'UNINDEXABLE'
      ) {
        throw new BadRequestException(
          `There is a problem snapshotting given address. Please let the dev team know.`
        );
      }
      return await this.tdhGrantsRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const currentMillis = Time.currentMillis();
          const tokenMode = command.target_tokens.length
            ? TdhGrantTokenMode.INCLUDE
            : TdhGrantTokenMode.ALL;
          const grantId = randomUUID();
          const targetPartition = `${command.target_chain}:${command.target_contract}`;
          const tokenEntities = command.target_tokens
            .flatMap((tokenOrTokenSpan) => {
              if (tokenOrTokenSpan.includes('-')) {
                const [start, end] = tokenOrTokenSpan.split('-');
                return numbers
                  .range(
                    numbers.parseIntOrThrow(start),
                    numbers.parseIntOrThrow(end)
                  )
                  .map((it) => it.toString());
              } else {
                return [tokenOrTokenSpan];
              }
            })
            .map<TdhGrantTokenEntity>((token) => ({
              token_id: token,
              grant_id: grantId,
              target_partition: targetPartition
            }));
          const entity: TdhGrantEntity = {
            id: grantId,
            grantor_id: command.grantor_id,
            target_partition: targetPartition,
            target_chain: command.target_chain,
            target_contract: command.target_contract,
            token_mode: tokenMode,
            target_tokens: command.target_tokens.length
              ? command.target_tokens.join(`,`)
              : null,
            created_at: currentMillis,
            updated_at: currentMillis,
            valid_from: null,
            valid_to: command.valid_to?.toMillis() ?? null,
            tdh_rate: command.tdh_rate,
            status: TdhGrantStatus.PENDING,
            error_details: null,
            is_irrevocable: command.is_irrevocable
          };
          await this.tdhGrantsRepository.insertGrant(
            entity,
            tokenEntities,
            ctxWithConnection
          );
          return fromTdhGrantEntityToModel(entity);
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }
}

export const createTdhGrantUseCase = new CreateTdhGrantUseCase(
  tdhGrantsRepository,
  externalIndexingRepository
);
