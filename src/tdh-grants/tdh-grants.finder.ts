import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import { RequestContext } from '../request.context';
import { fromTdhGrantEntityToModel, TdhGrantModel } from './tdh-grant.models';
import { TdhGrantStatus } from '../entities/ITdhGrant';
import { PageSortDirection } from '../api-serverless/src/page-request';

export class TdhGrantsFinder {
  constructor(private readonly tdhGrantsRepository: TdhGrantsRepository) {}

  public async searchForPage(
    {
      grantor_id,
      target_contract,
      target_chain,
      status,
      sort_direction,
      sort,
      page,
      page_size
    }: {
      readonly grantor_id: string | null;
      readonly target_contract: string | null;
      readonly target_chain: number | null;
      readonly status: TdhGrantStatus[];
      readonly sort_direction: 'ASC' | 'DESC' | null;
      readonly sort:
        | 'created_at'
        | 'valid_from'
        | 'valid_to'
        | 'tdh_rate'
        | null;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<{
    count: number;
    items: TdhGrantModel[];
    next: boolean;
    page: number;
  }> {
    try {
      ctx.timer?.start(`${this.constructor.name}->searchForPage`);
      const limit = page_size;
      const offset = page_size * (page - 1);
      const [items, count] = await Promise.all([
        this.tdhGrantsRepository
          .getPageItems(
            {
              grantor_id,
              target_contract,
              target_chain,
              status,
              sort_direction,
              sort,
              limit,
              offset
            },
            ctx
          )
          .then(async (dbResults) => {
            const tokenCounts =
              await this.tdhGrantsRepository.getGrantsTokenCounts(
                dbResults.map((it) => it.id),
                ctx
              );
            return dbResults.map((entity) =>
              fromTdhGrantEntityToModel({
                ...entity,
                target_token_count: tokenCounts[entity.id] ?? 0
              })
            );
          }),
        this.tdhGrantsRepository.countItems(
          {
            grantor_id,
            target_contract,
            target_chain,
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
        this.tdhGrantsRepository.getGrantTokensPage(
          {
            grant_id: searchModel.grant_id,
            sort_direction: searchModel.sort_direction,
            sort: searchModel.sort,
            limit,
            offset
          },
          ctx
        ),
        this.tdhGrantsRepository
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
}

export const tdhGrantsFinder = new TdhGrantsFinder(tdhGrantsRepository);
