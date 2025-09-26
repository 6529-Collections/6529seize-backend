import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import { RequestContext } from '../request.context';
import { fromTdhGrantEntityToModel, TdhGrantModel } from './tdh-grant.models';
import { TdhGrantStatus } from '../entities/ITdhGrant';

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
      readonly status: TdhGrantStatus | null;
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
          .then((dbResults) =>
            dbResults.map((entity) => fromTdhGrantEntityToModel(entity))
          ),
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
}

export const tdhGrantsFinder = new TdhGrantsFinder(tdhGrantsRepository);
