import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { TdhGrantEntity, TdhGrantStatus } from '../entities/ITdhGrant';
import { RequestContext } from '../request.context';
import { TDH_GRANTS_TABLE } from '../constants';

export class TdhGrantsRepository extends LazyDbAccessCompatibleService {
  public async insertGrant(
    tdhGrantEntity: TdhGrantEntity,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertGrant`);
    await this.db.execute(
      `
      insert into ${TDH_GRANTS_TABLE}
      (
       id,
       grantor_id,
       target_chain,
       target_contract,
       target_tokens,
       created_at,
       valid_from,
       valid_to,
       tdh_rate,
       status,
       error_details,
       is_irrevocable
      ) values (
       :id,
       :grantor_id,
       :target_chain,
       :target_contract,
       :target_tokens,
       :created_at,
       :valid_from,
       :valid_to,
       :tdh_rate,
       :status,
       :error_details,
       :is_irrevocable         
      )
    `,
      tdhGrantEntity,
      {
        wrappedConnection: ctx.connection
      }
    );
    ctx.timer?.stop(`${this.constructor.name}->insertGrant`);
  }

  public async getPageItems(
    {
      grantor_id,
      target_contract,
      target_chain,
      status,
      sort_direction,
      sort,
      limit,
      offset
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
      readonly limit: number;
      readonly offset: number;
    },
    ctx: RequestContext
  ): Promise<TdhGrantEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getPageItems`);
      const select = `SELECT t.* FROM ${TDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contract,
        target_chain,
        status
      );
      const ordering = `order by t.${sort ?? 'created_at'} ${sort_direction ?? ''} limit :limit offset :offset`;
      params.limit = limit;
      params.offset = offset;
      const sql = `${select} ${whereAnds.length ? ` where ` : ``} ${whereAnds.join(' and ')} ${ordering}`;
      return await this.db.execute<TdhGrantEntity>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getPageItems`);
    }
  }

  public async countItems(
    {
      grantor_id,
      target_contract,
      target_chain,
      status
    }: {
      readonly grantor_id: string | null;
      readonly target_contract: string | null;
      readonly target_chain: number | null;
      readonly status: TdhGrantStatus | null;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countItems`);
      const select = `SELECT count(*) as cnt FROM ${TDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contract,
        target_chain,
        status
      );
      const sql = `${select} ${whereAnds.length ? ` where ` : ``} ${whereAnds.join(' and ')}`;
      return await this.db
        .oneOrNull<{ cnt: number }>(sql, params, {
          wrappedConnection: ctx.connection
        })
        .then((it) => it?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countItems`);
    }
  }

  private getSearchWhereAnds(
    grantor_id: string | null,
    target_contract: string | null,
    target_chain: number | null,
    status:
      | TdhGrantStatus
      | null
      | TdhGrantStatus.PENDING
      | TdhGrantStatus.FAILED
      | TdhGrantStatus.GRANTED
  ) {
    const whereAnds: string[] = [];
    const params: Record<string, any> = {};
    if (grantor_id) {
      whereAnds.push(`t.grantor_id = :grantor_id`);
      params['grantor_id'] = grantor_id;
    }
    if (target_contract) {
      whereAnds.push(`t.target_contract = :target_contract`);
      params['target_contract'] = target_contract;
    }
    if (target_chain) {
      whereAnds.push(`t.target_chain = :target_chain`);
      params['target_chain'] = target_chain;
    }
    if (status) {
      whereAnds.push(`t.status = :status`);
      params['status'] = status;
    }
    return { whereAnds, params };
  }
}

export const tdhGrantsRepository = new TdhGrantsRepository(dbSupplier);
