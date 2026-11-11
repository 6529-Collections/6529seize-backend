import { COMPETITION_WORKER_CURSORS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const WARNING_INTERVAL_MS = 10 * 60_000;

function isMissingTable(error: unknown): boolean {
  const candidates = [error, (error as { driverError?: unknown })?.driverError];
  return candidates.some(
    (candidate) =>
      (candidate as { code?: unknown } | null)?.code === 'ER_NO_SUCH_TABLE'
  );
}

/**
 * Resume points of competition workers, kept in
 * `competition_worker_cursors` and mirrored in memory. A cursor is advisory:
 * when it cannot be read or saved (for example before `dbMigrationsLoop` has
 * created the table) the worker keeps rotating with the in-memory copy, so
 * cursor storage never stops a pass.
 */
export class CompetitionWorkerCursorStore extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);
  private readonly memory = new Map<string, string>();
  /** While the table is missing, retried only after this time. */
  private tableMissingUntil = 0;
  private lastWarningAt: number | null = null;

  private useTable(): boolean {
    return Date.now() >= this.tableMissingUntil;
  }

  async read(worker: string): Promise<string> {
    if (this.useTable()) {
      try {
        const row = await this.db.oneOrNull<{ after_id: string }>(
          `select after_id from ${COMPETITION_WORKER_CURSORS_TABLE} where worker = :worker`,
          { worker }
        );
        if (row) this.memory.set(worker, row.after_id);
      } catch (error) {
        this.warn('read', error);
      }
    }
    return this.memory.get(worker) ?? '';
  }

  async save(worker: string, afterId: string, now: number): Promise<void> {
    this.memory.set(worker, afterId);
    if (!this.useTable()) return;
    try {
      await this.db.execute(
        `insert into ${COMPETITION_WORKER_CURSORS_TABLE} (worker, after_id, updated_at)
         values (:worker, :afterId, :now)
         on duplicate key update after_id = :afterId, updated_at = :now`,
        { worker, afterId, now }
      );
    } catch (error) {
      this.warn('save', error);
    }
  }

  private warn(operation: 'read' | 'save', error: unknown) {
    const now = Date.now();
    const tableMissing = isMissingTable(error);
    if (tableMissing) this.tableMissingUntil = now + WARNING_INTERVAL_MS;
    if (
      this.lastWarningAt !== null &&
      now - this.lastWarningAt < WARNING_INTERVAL_MS
    )
      return;
    this.lastWarningAt = now;
    this.logger.warn('competition_worker_cursor_unavailable', {
      operation,
      table_missing: tableMissing
    });
  }
}

export const competitionWorkerCursorStore = new CompetitionWorkerCursorStore(
  dbSupplier
);
