import type { DataSource } from 'typeorm';
import { RequestContext } from '@/request.context';

export class XTdhStatsDb {
  constructor(
    // API consumers also import XTdhRepository, but only xTdhLoop owns the
    // TypeORM data source. Do not load the loop DB module at import time.
    private readonly dataSource: () =>
      | DataSource
      | Promise<DataSource> = async () => (await import('@/db')).getDataSource()
  ) {}

  async insertFromSelect(
    sql: string,
    params: Record<string, number>,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->insertFromSelect`;
    try {
      ctx.timer?.start(timerName);
      const db = await this.dataSource();
      const [statement, values] = db.driver.escapeQueryWithParameters(
        sql,
        params,
        {}
      );
      // Scope isolation to this insert, after the caller's TRUNCATE. Under
      // REPEATABLE READ, INSERT ... SELECT locks source rows and can wait on
      // the ownership indexer or grant writers. READ COMMITTED uses a
      // nonlocking source snapshot. TypeORM rolls back errors and releases
      // the connection without changing its session isolation default.
      await db.transaction('READ COMMITTED', async (manager) => {
        await manager.query(statement, values);
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const xTdhStatsDb = new XTdhStatsDb();
