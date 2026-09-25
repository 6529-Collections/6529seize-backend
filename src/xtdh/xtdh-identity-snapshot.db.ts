import { IDENTITIES_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { LazyDbAccessCompatibleService } from '@/sql-executor';

const WORK_TABLE = 'xtdh_identity_work';
type IdentityKey = { consolidation_key: string; profile_id: string | null };

export class XTdhIdentitySnapshotDb extends LazyDbAccessCompatibleService {
  async prepare(ctx: RequestContext): Promise<void> {
    if (!ctx.connection)
      throw new Error('xTDH snapshot requires a transaction');
    const timer = `${this.constructor.name}->prepare`;
    ctx.timer?.start(timer);
    try {
      await this.discard(ctx);
      await this.db.execute(
        `CREATE TEMPORARY TABLE ${WORK_TABLE} (PRIMARY KEY (consolidation_key))
         ENGINE=InnoDB AS SELECT consolidation_key, profile_id, produced_xtdh,
           granted_xtdh, xtdh, xtdh_rate FROM ${IDENTITIES_TABLE} WHERE 1 = 0`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      const rows = await this.db.execute<IdentityKey>(
        `SELECT consolidation_key, profile_id FROM ${IDENTITIES_TABLE}`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      await this.db.bulkInsert(
        WORK_TABLE,
        rows.map((row) => ({
          ...row,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh: 0,
          xtdh_rate: 0
        })),
        [
          'consolidation_key',
          'profile_id',
          'produced_xtdh',
          'granted_xtdh',
          'xtdh',
          'xtdh_rate'
        ],
        ctx
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async writeValues(
    rows: ({ consolidation_key: string } & Record<string, unknown>)[],
    column: 'produced_xtdh' | 'granted_xtdh' | 'xtdh' | 'xtdh_rate',
    ctx: RequestContext
  ): Promise<void> {
    const timer = `${this.constructor.name}->writeValues`;
    ctx.timer?.start(timer);
    try {
      await this.db.bulkUpsert(
        WORK_TABLE,
        rows.map((row) => ({
          profile_id: null,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh: 0,
          xtdh_rate: 0,
          ...row
        })),
        [
          'consolidation_key',
          'profile_id',
          'produced_xtdh',
          'granted_xtdh',
          'xtdh',
          'xtdh_rate'
        ],
        [column],
        ctx
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async publish(ctx: RequestContext): Promise<void> {
    const timer = `${this.constructor.name}->publish`;
    ctx.timer?.start(timer);
    try {
      // Lock current rows only once calculations are complete. A locking read
      // sees concurrent commits even in the calculation's REPEATABLE READ txn.
      const current = await this.db.execute<IdentityKey>(
        `SELECT consolidation_key, profile_id FROM ${IDENTITIES_TABLE}
         ORDER BY consolidation_key FOR UPDATE`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      const snapshot = await this.db.execute<IdentityKey>(
        `SELECT consolidation_key, profile_id FROM ${WORK_TABLE}`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      const profiles = new Map(
        current.map((row) => [row.consolidation_key, row.profile_id])
      );
      if (
        snapshot.some(
          (row) =>
            !profiles.has(row.consolidation_key) ||
            profiles.get(row.consolidation_key) !== row.profile_id
        )
      ) {
        throw new Error(
          'Identity consolidation changed during xTDH calculation; retry the universe'
        );
      }
      await this.db.execute(
        `UPDATE ${IDENTITIES_TABLE} i JOIN ${WORK_TABLE} w
           ON w.consolidation_key = i.consolidation_key
         SET i.produced_xtdh = w.produced_xtdh,
             i.granted_xtdh = w.granted_xtdh,
             i.xtdh = w.xtdh,
             i.xtdh_rate = w.xtdh_rate,
             i.level_raw = i.rep + i.tdh + w.xtdh`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async discard(ctx: RequestContext): Promise<void> {
    const timer = `${this.constructor.name}->discard`;
    ctx.timer?.start(timer);
    try {
      await this.db.execute(
        `DROP TEMPORARY TABLE IF EXISTS ${WORK_TABLE}`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
