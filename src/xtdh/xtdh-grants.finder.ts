import { RequestContext } from '../request.context';
import {
  fromXTdhGrantEntityToModel,
  XTdhGrantModel
} from './xtdh-grant.models';
import { XTdhGrantStatus } from '../entities/IXTdhGrant';
import { PageSortDirection } from '../api-serverless/src/page-request';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../exceptions';
import { Time } from '../time';
import { randomUUID } from 'node:crypto';
import { xTdhRepository, XTdhRepository } from './xtdh.repository';

export class XTdhGrantsFinder {
  constructor(private readonly xTdhRepository: XTdhRepository) {}

  public async searchForPage(
    {
      grantor_id,
      target_contracts,
      target_chain,
      valid_from_lt,
      valid_from_gt,
      valid_to_lt,
      valid_to_gt,
      status,
      sort_direction,
      sort,
      page,
      page_size,
      conflictingRequest
    }: {
      readonly grantor_id: string | null;
      readonly target_contracts: string[];
      readonly target_chain: number | null;
      readonly valid_from_lt: number | null;
      readonly valid_from_gt: number | null;
      readonly valid_to_lt: number | null;
      readonly valid_to_gt: number | null;
      readonly status: XTdhGrantStatus[];
      readonly sort_direction: 'ASC' | 'DESC' | null;
      readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'rate' | null;
      readonly page: number;
      readonly page_size: number;
      readonly conflictingRequest: boolean;
    },
    ctx: RequestContext
  ): Promise<{
    count: number;
    items: XTdhGrantModel[];
    next: boolean;
    page: number;
  }> {
    try {
      ctx.timer?.start(`${this.constructor.name}->searchForPage`);
      const limit = page_size;
      const offset = page_size * (page - 1);
      if (conflictingRequest) {
        return {
          count: 0,
          items: [],
          next: false,
          page
        };
      }
      const [items, count] = await Promise.all([
        this.xTdhRepository
          .getPageItems(
            {
              grantor_id,
              target_contracts,
              target_chain,
              valid_from_lt,
              valid_from_gt,
              valid_to_lt,
              valid_to_gt,
              status,
              sort_direction,
              sort,
              limit,
              offset
            },
            ctx
          )
          .then(async (dbResults) => {
            const grantIds = dbResults.map((it) => it.id);
            const [tokenCounts, collectionNames, totalGranteds] =
              await Promise.all([
                this.xTdhRepository.getGrantsTokenCounts(grantIds, ctx),
                this.xTdhRepository.getCollectionNames(grantIds, ctx),
                this.xTdhRepository.getXTdhGrantedByGrantIds(grantIds, ctx)
              ]);
            return dbResults.map((entity) =>
              fromXTdhGrantEntityToModel(entity, {
                target_token_count: tokenCounts[entity.id] ?? 0,
                target_collection_name: collectionNames[entity.id] ?? null,
                total_granted: totalGranteds[entity.id] ?? 0
              })
            );
          }),
        this.xTdhRepository.countItems(
          {
            grantor_id,
            target_contracts,
            target_chain,
            valid_from_lt,
            valid_from_gt,
            valid_to_lt,
            valid_to_gt,
            status
          },
          ctx
        )
      ]);
      return {
        items,
        count,
        page,
        next: count > page_size * page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->searchForPage`);
    }
  }

  async searchForTokens(
    searchModel: {
      grant_id: string;
      readonly sort_direction: PageSortDirection;
      readonly sort: 'token';
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->searchForTokens`);
      const page = searchModel.page;
      const pageSize = searchModel.page_size;
      const limit = pageSize;
      const offset = pageSize * (page - 1);
      const [items, count] = await Promise.all([
        this.xTdhRepository.getGrantTokensPage(
          {
            grant_id: searchModel.grant_id,
            sort_direction: searchModel.sort_direction,
            sort: searchModel.sort,
            limit,
            offset
          },
          ctx
        ),
        this.xTdhRepository
          .getGrantsTokenCounts([searchModel.grant_id], ctx)
          .then((tokenCounts) => tokenCounts[searchModel.grant_id] ?? 0)
      ]);
      return {
        items,
        count,
        page,
        next: count > pageSize * page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->searchForTokens`);
    }
  }

  public async getGrantByIdOrThrow(
    grantId: string,
    ctx: RequestContext
  ): Promise<XTdhGrantModel> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantByIdOrThrow`);
      const models = await this.getGrantsByIds([grantId], ctx);
      const model = models[0];
      if (!model) {
        throw new NotFoundException(`Grant ${grantId} not found`);
      }
      return model;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantByIdOrThrow`);
    }
  }

  public async getGrantsByIds(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<XTdhGrantModel[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantsByIds`);
      if (!grantIds.length) {
        return [];
      }
      const [entities, tokenCounts, collectionNames, xTdhGranteds] =
        await Promise.all([
          this.xTdhRepository.getGrantsByIds(grantIds, ctx),
          this.xTdhRepository.getGrantsTokenCounts(grantIds, ctx),
          this.xTdhRepository.getCollectionNames(grantIds, ctx),
          this.xTdhRepository.getXTdhGrantedByGrantIds(grantIds, ctx)
        ]);
      return entities.map((it) =>
        fromXTdhGrantEntityToModel(it, {
          target_token_count: tokenCounts[it.id] ?? 0,
          target_collection_name: collectionNames[it.id] ?? null,
          total_granted: xTdhGranteds[it.id] ?? 0
        })
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantsByIds`);
    }
  }

  async updateXTdhGrant(
    {
      grantId,
      proposedValidTo
    }: { grantId: string; proposedValidTo: Time | null },
    ctx: RequestContext
  ): Promise<XTdhGrantModel> {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateTdhGrant`);
      return await this.xTdhRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const grantBeforeUpdate = await this.xTdhRepository.lockGrantById(
            grantId,
            ctxWithConnection
          );
          if (!grantBeforeUpdate) {
            throw new NotFoundException(`Grant ${grantId} not found`);
          }
          if (
            grantBeforeUpdate.grantor_id !==
            ctxWithConnection.authenticationContext?.getLoggedInUsersProfileId()
          ) {
            throw new ForbiddenException(
              `Only grantor itself can change its grants`
            );
          }

          const status = grantBeforeUpdate.status;
          if (
            [XTdhGrantStatus.FAILED, XTdhGrantStatus.DISABLED].includes(status)
          ) {
            throw new BadRequestException(
              `Grant ${grantId} is in status ${status}. Only grants with following statuses can be updated: ${[XTdhGrantStatus.PENDING, XTdhGrantStatus.GRANTED].join(`, `)}.`
            );
          }
          const validToBeforeUpdate = grantBeforeUpdate.valid_to
            ? Time.millis(grantBeforeUpdate.valid_to)
            : null;
          if (validToBeforeUpdate) {
            if (
              validToBeforeUpdate.isInPast() &&
              (proposedValidTo === null ||
                proposedValidTo.gt(validToBeforeUpdate))
            ) {
              throw new BadRequestException(
                `Extending validity of an expired grant is not allowed`
              );
            }
          }
          let newFinalId = grantBeforeUpdate.id;
          const validFrom =
            grantBeforeUpdate.valid_from !== null
              ? Time.millis(grantBeforeUpdate.valid_from)
              : null;
          const replacementGrantNeeded =
            proposedValidTo === null ||
            (validFrom === null &&
              proposedValidTo.minus(Time.now()).gt(Time.days(1))) ||
            (validFrom !== null &&
              proposedValidTo.minus(validFrom).gt(Time.days(1)));
          await this.xTdhRepository.updateStatus(
            {
              grantId,
              status: XTdhGrantStatus.DISABLED,
              error: replacementGrantNeeded
                ? 'User updated the grant validity'
                : `User disabled the grant`
            },
            ctxWithConnection
          );
          if (replacementGrantNeeded) {
            const replacementGrantId = randomUUID();
            await this.xTdhRepository.insertGrant(
              {
                ...grantBeforeUpdate,
                id: replacementGrantId,
                created_at: Time.currentMillis(),
                updated_at: Time.currentMillis(),
                valid_to: proposedValidTo?.toMillis() ?? null,
                replaced_grant_id: grantId
              },
              [],
              ctxWithConnection
            );
            newFinalId = replacementGrantId;
          }
          return this.getGrantByIdOrThrow(newFinalId, ctxWithConnection);
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateTdhGrant`);
    }
  }
}

export const xTdhGrantsFinder = new XTdhGrantsFinder(xTdhRepository);
