import { WS_CONNECTIONS_TABLE } from '@/constants/db-tables';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';

export interface NftLinkNotificationRecipient {
  readonly connection_id: string;
  readonly jwt_expiry: number;
}

export class NftLinkRefreshNotifierDb extends LazyDbAccessCompatibleService {
  async findActiveRecipients(
    ctx: RequestContext
  ): Promise<NftLinkNotificationRecipient[]> {
    const timerName = `${this.constructor.name}->findActiveRecipients`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.execute<NftLinkNotificationRecipient>(
        `select /*+ MAX_EXECUTION_TIME(3000) */ connection_id, max(jwt_expiry) as jwt_expiry
         from ${WS_CONNECTIONS_TABLE} where jwt_expiry > unix_timestamp()
         group by connection_id`,
        {},
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const nftLinkRefreshNotifierDb = new NftLinkRefreshNotifierDb(
  dbSupplier
);
