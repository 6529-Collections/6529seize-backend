import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { TdhGrantEntity } from '../entities/ITdhGrant';
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
}

export const tdhGrantsRepository = new TdhGrantsRepository(dbSupplier);
