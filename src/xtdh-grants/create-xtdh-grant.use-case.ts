import { RequestContext } from '../request.context';
import {
  CreateXTdhGrantCommand,
  fromXTdhGrantEntityToModel,
  XTdhGrantModel
} from './xtdh-grant.models';
import { BadRequestException } from '../exceptions';
import {
  XTdhGrantEntity,
  XTdhGrantStatus,
  XTdhGrantTokenMode
} from '../entities/IXTdhGrant';
import { randomUUID } from 'node:crypto';
import { Time } from '../time';
import {
  xTdhGrantsRepository,
  XTdhGrantsRepository
} from './xtdh-grants.repository';
import {
  externalIndexingRepository,
  ExternalIndexingRepository
} from '../external-indexing/external-indexing.repository';
import { numbers } from '../numbers';
import { TdhGrantTokenEntity } from '../entities/ITdhGrantToken';

export class CreateXTdhGrantUseCase {
  constructor(
    private readonly xTdhGrantsRepository: XTdhGrantsRepository,
    private readonly externalIndexingRepository: ExternalIndexingRepository
  ) {}

  public async handle(
    command: CreateXTdhGrantCommand,
    ctx: RequestContext
  ): Promise<XTdhGrantModel> {
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
      return await this.xTdhGrantsRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const currentMillis = Time.currentMillis();
          const tokenMode = command.target_tokens.length
            ? XTdhGrantTokenMode.INCLUDE
            : XTdhGrantTokenMode.ALL;
          const grantId = randomUUID();
          const targetPartition = `${command.target_chain}:${command.target_contract}`;
          const tokensetId = randomUUID();
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
              tokenset_id: tokensetId,
              target_partition: targetPartition
            }));
          const entity: XTdhGrantEntity = {
            id: grantId,
            tokenset_id: tokensetId,
            replaced_grant_id: null,
            grantor_id: command.grantor_id,
            target_partition: targetPartition,
            target_chain: command.target_chain,
            target_contract: command.target_contract,
            token_mode: tokenMode,
            created_at: currentMillis,
            updated_at: currentMillis,
            valid_from: null,
            valid_to: command.valid_to?.toMillis() ?? null,
            tdh_rate: command.rate,
            status: XTdhGrantStatus.PENDING,
            error_details: null,
            is_irrevocable: command.is_irrevocable
          };
          await this.xTdhGrantsRepository.insertGrant(
            entity,
            tokenEntities,
            ctxWithConnection
          );
          const targetTokenCounts =
            await this.xTdhGrantsRepository.getGrantsTokenCounts(
              [entity.id],
              ctx
            );
          const targetCollectionNames =
            await this.xTdhGrantsRepository.getCollectionNames(
              [entity.id],
              ctx
            );
          const targetTokenCount = targetTokenCounts[entity.id] ?? 0;
          const targetCollectionName = targetCollectionNames[entity.id] ?? null;
          return fromXTdhGrantEntityToModel(entity, {
            target_token_count: targetTokenCount,
            target_collection_name: targetCollectionName,
            total_granted: 0
          });
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }
}

export const createXTdhGrantUseCase = new CreateXTdhGrantUseCase(
  xTdhGrantsRepository,
  externalIndexingRepository
);
