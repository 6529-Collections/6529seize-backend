import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { WSConnectionEntity } from '../../../entities/IWSConnectionEntity';
import { WS_CONNECTIONS_TABLE } from '../../../constants';
import { RequestContext } from '../../../request.context';

export class WsConnectionRepository extends LazyDbAccessCompatibleService {
  public async save(entity: WSConnectionEntity, ctx: RequestContext) {
    await this.db.execute(
      `insert into ${WS_CONNECTIONS_TABLE} (connection_id, jwt_expiry, identity_id) values (:connection_id, :jwt_expiry, :identity_id)`,
      entity,
      { wrappedConnection: ctx.connection }
    );
  }

  public async deleteByConnectionId(connectionId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${WS_CONNECTIONS_TABLE} where connection_id = :connectionId`,
      { connectionId },
      { wrappedConnection: ctx.connection }
    );
  }

  public async getByConnectionId(
    connectionId: string,
    ctx: RequestContext
  ): Promise<WSConnectionEntity | null> {
    return this.db.oneOrNull<WSConnectionEntity>(
      `select * from ${WS_CONNECTIONS_TABLE} where connection_id = :connectionId`,
      { connectionId },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const wsConnectionRepository = new WsConnectionRepository(dbSupplier);
