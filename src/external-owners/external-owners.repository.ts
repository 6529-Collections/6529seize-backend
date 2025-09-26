import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { RequestContext } from '../request.context';
import { ExternalTokenOwnerEntity } from '../entities/IExternalTokenOwner';
import { EXTERNAL_TOKEN_OWNERS_TABLE } from '../constants';

const mysql = require('mysql');

export class ExternalOwnersRepository extends LazyDbAccessCompatibleService {
  async insertBatch(entities: ExternalTokenOwnerEntity[], ctx: RequestContext) {
    ctx?.timer?.start(`${this.constructor.name}->insertBatch`);
    try {
      if (!entities.length) {
        return;
      }
      const sql = `
          insert into ${EXTERNAL_TOKEN_OWNERS_TABLE} (
            id,
            chain,
            contract,
            token,
            owner,
            owned_since_block,
            owned_since_time,
            amount,
            is_tombstone
          )
          values ${entities
            .map(
              (entity) =>
                `(
                ${mysql.escape(entity.id)}, 
                ${mysql.escape(entity.chain)},
                ${mysql.escape(entity.contract)},
                ${mysql.escape(entity.token)},
                ${mysql.escape(entity.owner)},
                ${mysql.escape(entity.owned_since_block)},
                ${mysql.escape(entity.owned_since_time)},
                ${mysql.escape(entity.amount)},
                ${mysql.escape(entity.is_tombstone)},
                )`
            )
            .join(', ')}
      `;
      await this.db.execute(sql, undefined, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx?.timer?.stop(`${this.constructor.name}->insertBatch`);
    }
  }
}

export const externalOwnersRepository = new ExternalOwnersRepository(
  dbSupplier
);
