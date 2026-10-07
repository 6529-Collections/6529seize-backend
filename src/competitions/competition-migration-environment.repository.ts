import { randomUUID } from 'node:crypto';
import { COMPETITION_MIGRATION_ENVIRONMENTS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MigrationAcceptance,
  MigrationEnvironment
} from './competition-migration-policy';

export class CompetitionMigrationEnvironmentRepository extends LazyDbAccessCompatibleService {
  public async latest(
    environment: MigrationEnvironment,
    ctx: RequestContext
  ): Promise<MigrationAcceptance | null> {
    const timer = `${this.constructor.name}->latest`;
    ctx.timer?.start(timer);
    try {
      const row = await this.db.oneOrNull<{
        acceptance: MigrationAcceptance | string;
      }>(
        `select acceptance from ${COMPETITION_MIGRATION_ENVIRONMENTS_TABLE}
         where environment=:environment order by created_at desc,id desc limit 1`,
        { environment },
        { wrappedConnection: ctx.connection }
      );
      return row
        ? typeof row.acceptance === 'string'
          ? JSON.parse(row.acceptance)
          : row.acceptance
        : null;
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  public async record(
    environment: MigrationEnvironment,
    operator: { actor: string; reason: string },
    acceptance: MigrationAcceptance,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const timer = `${this.constructor.name}->record`;
    ctx.timer?.start(timer);
    try {
      await this.db.execute(
        `insert into ${COMPETITION_MIGRATION_ENVIRONMENTS_TABLE}
         (id,environment,operator,reason,acceptance,created_at)
         values (:id,:environment,:operator,:reason,:acceptance,:now)`,
        {
          id: randomUUID(),
          environment,
          operator: operator.actor,
          reason: operator.reason,
          acceptance: JSON.stringify(acceptance),
          now
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
