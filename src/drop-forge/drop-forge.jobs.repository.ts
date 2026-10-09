import { DROP_FORGE_JOBS_TABLE } from '@/constants';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { NotFoundException } from '@/exceptions';
import { DbPoolName } from '@/db-query.options';

export class DropForgeJobsRepository {
  async reportOne(
    report: (
      job: DropForgeJobEntity,
      ctx: RequestContext
    ) => Promise<{ drop_id: string; pending_push_notification_ids: number[] }>,
    ctx: RequestContext
  ): Promise<number[]> {
    const timer = 'DropForgeJobsRepository->reportOne';
    ctx.timer?.start(timer);
    try {
      return await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const job = await sqlExecutor.oneOrNull<DropForgeJobEntity>(
            `SELECT * FROM ${DROP_FORGE_JOBS_TABLE} WHERE status <> 'PENDING' AND drop_id IS NULL ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            {},
            { wrappedConnection: connection }
          );
          if (!job) return [];
          const result = await report(job, { ...ctx, connection });
          await sqlExecutor.execute(
            `UPDATE ${DROP_FORGE_JOBS_TABLE} SET drop_id = :drop_id WHERE id = :id`,
            { id: job.id, drop_id: result.drop_id },
            { wrappedConnection: connection }
          );
          return result.pending_push_notification_ids;
        }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async find(id: string, ctx: RequestContext): Promise<DropForgeJobEntity> {
    const timer = 'DropForgeJobsRepository->find';
    ctx.timer?.start(timer);
    try {
      const row = await sqlExecutor.oneOrNull<DropForgeJobEntity>(
        `SELECT * FROM ${DROP_FORGE_JOBS_TABLE} WHERE id = :id`,
        { id },
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      if (!row) throw new NotFoundException('Distribution job not found');
      return row;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async create(
    job: DropForgeJobEntity,
    ctx: RequestContext
  ): Promise<DropForgeJobEntity> {
    const timer = 'DropForgeJobsRepository->create';
    ctx.timer?.start(timer);
    try {
      await sqlExecutor.execute(
        `INSERT IGNORE INTO ${DROP_FORGE_JOBS_TABLE} (id,contract,claim_id,kind,plan_id,phase_id,status,updated_at) VALUES (:id,:contract,:claim_id,:kind,:plan_id,:phase_id,'PENDING',:updated_at)`,
        { ...job },
        { wrappedConnection: ctx.connection }
      );
      const saved = await this.find(job.id, ctx);
      if (
        saved.contract !== job.contract ||
        Number(saved.claim_id) !== job.claim_id ||
        saved.kind !== job.kind ||
        saved.plan_id !== job.plan_id ||
        saved.phase_id !== job.phase_id
      )
        throw new LaunchSafetyError(
          'Request ID already belongs to a different preparation job'
        );
      return saved;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async processOne(
    process: (job: DropForgeJobEntity, ctx: RequestContext) => Promise<object>,
    ctx: RequestContext
  ): Promise<void> {
    const timer = 'DropForgeJobsRepository->processOne';
    ctx.timer?.start(timer);
    try {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          const job = await sqlExecutor.oneOrNull<DropForgeJobEntity>(
            `SELECT * FROM ${DROP_FORGE_JOBS_TABLE} WHERE status = 'PENDING' ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            {},
            { wrappedConnection: connection }
          );
          if (!job) return;
          await sqlExecutor.execute('SAVEPOINT drop_forge_job', undefined, {
            wrappedConnection: connection
          });
          let status = 'COMPLETED';
          let error: string | null = null;
          let result: object | null = null;
          try {
            result = await process(job, txCtx);
          } catch (error_) {
            await sqlExecutor.execute(
              'ROLLBACK TO SAVEPOINT drop_forge_job',
              undefined,
              { wrappedConnection: connection }
            );
            status = 'FAILED';
            error =
              error_ instanceof LaunchSafetyError
                ? error_.message
                : 'Preparation failed or timed out; retry with a new request ID after checking EMMA and source data';
          }
          await sqlExecutor.execute(
            `UPDATE ${DROP_FORGE_JOBS_TABLE} SET status = :status, error = :error, result = :result, updated_at = :updated_at WHERE id = :id`,
            {
              id: job.id,
              status,
              error,
              result: result ? JSON.stringify(result) : null,
              updated_at: Date.now()
            },
            { wrappedConnection: connection }
          );
        }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
export const dropForgeJobsRepository = new DropForgeJobsRepository();
