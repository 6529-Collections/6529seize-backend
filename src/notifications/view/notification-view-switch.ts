import {
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { NotificationViewOrigin } from '@/entities/INotificationView';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  notificationViewCursorsDb,
  NotificationViewCursorsDb
} from '@/notifications/view/notification-view-cursors.db';
import { NOTIFICATION_SOURCE_KEY_DOMAIN } from '@/notifications/view/notification-view-ids';
import { CARRIED_FAMILY } from '@/notifications/view/notification-view.db';
import {
  derivedCauseWindows,
  notifyViewMode
} from '@/notifications/view/notify-view-flags';

/**
 * The cursor of the copy of old rows: the identity_notifications id the next
 * pass reads after. A run leaves it up to `OLD_ROWS_TAIL_IDS` below the
 * newest row.
 */
export const OLD_ROWS_CURSOR = 'switch:identity-notifications';

const DEFAULT_BATCH_SIZE = 2000;

/**
 * How far below the newest row the copy leaves its cursor at the end of a
 * run. An insert takes its id before it commits, so a pass can read past a
 * row that commits a moment later; the next run reads these ids again.
 */
export const OLD_ROWS_TAIL_IDS = 10_000;

export interface SwitchStepResult {
  readonly rows: number;
  /** Whether the step reached the end; run it again until it has. */
  readonly done: boolean;
}

/**
 * The switch to `on`, as two resumable steps, both safe to run again:
 *
 * 1. `pruneUnownedDerivedRows`: drops the rows the deriver wrote in
 *    `shadow` for comparison but does not own: causes not derived, or
 *    events outside their cause's windows. Their identity_notifications
 *    rows stand instead.
 * 2. `copyOldRows`: copies every identity_notifications row the view has no
 *    row for into it as CARRIED, keeping its id and read state. Rows the
 *    deriver wrote (their view row holds the id) are skipped. Run it before
 *    setting `on` and once more after, for rows written in between. A run
 *    ends with its cursor within `OLD_ROWS_TAIL_IDS` of the newest row, so
 *    the next run also copies a row that committed after this one read past
 *    it. A transaction open longer than that can still be passed over, so
 *    the last run, once no service writes in `shadow`, reads every row
 *    (`copyOldRowsRun({ full: true })`).
 */
export class NotificationViewSwitch {
  constructor(
    private readonly db: () => SqlExecutor,
    private readonly cursors: NotificationViewCursorsDb
  ) {}

  async pruneUnownedDerivedRows(
    batchSize = DEFAULT_BATCH_SIZE
  ): Promise<SwitchStepResult> {
    this.requireViewMode();
    const params: Record<string, string | number> = {
      origin: NotificationViewOrigin.DERIVED,
      batchSize
    };
    const owned = Array.from(derivedCauseWindows().entries()).flatMap(
      ([cause, windows], causeIndex) =>
        windows.map((window, index) => {
          const key = `${causeIndex}_${index}`;
          params[`cause_${key}`] = cause;
          params[`start_${key}`] = window.start;
          if (window.end === null) {
            return `(cause = :cause_${key} and created_at >= :start_${key})`;
          }
          params[`end_${key}`] = window.end;
          return `(cause = :cause_${key} and created_at >= :start_${key} and created_at < :end_${key})`;
        })
    );
    if (!owned.length && notifyViewMode() === 'on') {
      // People read the view in `on`. With no windows in this process's
      // NOTIFY_DERIVED_CAUSES (a run without the services' configuration),
      // every derived row would go.
      const derived = await this.db().oneOrNull<{ n: number }>(
        `select count(*) as n from (
           select 1 from ${NOTIFICATION_VIEW_TABLE}
           where origin = :origin limit 1
         ) derived`,
        params
      );
      if (Number(derived?.n ?? 0) > 0) {
        throw new Error(
          "NOTIFY_DERIVED_CAUSES is empty here, so the prune would delete every derived row people read in `on`. Run with the services' NOTIFY_DERIVED_CAUSES."
        );
      }
      return { rows: 0, done: true };
    }
    const keep = owned.length ? ` and not (${owned.join(' or ')})` : '';
    const result = await this.db().execute(
      `delete from ${NOTIFICATION_VIEW_TABLE}
       where origin = :origin${keep}
       limit ${Math.floor(batchSize)}`,
      params
    );
    const rows = this.db().getAffectedRows(result);
    return { rows, done: rows < batchSize };
  }

  /**
   * One run of the operator step `copy-old-rows`: prunes the rows the
   * deriver does not own (it may have written more since the last run),
   * then copies until done. `full` reads from the first row.
   */
  async copyOldRowsRun({
    full = false,
    batchSize = DEFAULT_BATCH_SIZE,
    tailIds = OLD_ROWS_TAIL_IDS
  }: {
    full?: boolean;
    batchSize?: number;
    tailIds?: number;
  } = {}): Promise<{ pruned: number; copied: number }> {
    this.requireViewMode();
    let pruned = 0;
    for (;;) {
      const step = await this.pruneUnownedDerivedRows(batchSize);
      pruned += step.rows;
      if (step.done) break;
    }
    if (full || (await this.cursors.get(OLD_ROWS_CURSOR)) === null) {
      // From the first row. The prune above has run, so the first pass
      // doesn't prune again.
      await this.db().executeNativeQueriesInTransaction((connection) =>
        this.cursors.set(OLD_ROWS_CURSOR, '0', connection)
      );
    }
    let copied = 0;
    for (;;) {
      const step = await this.copyOldRows(batchSize, tailIds);
      copied += step.rows;
      if (step.done) break;
    }
    return { pruned, copied };
  }

  async copyOldRows(
    batchSize = DEFAULT_BATCH_SIZE,
    tailIds = OLD_ROWS_TAIL_IDS
  ): Promise<SwitchStepResult> {
    this.requireViewMode();
    // The first pass prunes first: a row the deriver does not own still
    // names its old copy, which the copy would otherwise skip for good.
    if ((await this.cursors.get(OLD_ROWS_CURSOR)) === null) {
      while (!(await this.pruneUnownedDerivedRows(batchSize)).done) {
        // Each pass deletes one batch.
      }
    }
    return this.db().executeNativeQueriesInTransaction(async (connection) => {
      const after = Number(
        (await this.cursors.get(OLD_ROWS_CURSOR, connection)) ?? '0'
      );
      const options = { wrappedConnection: connection };
      const last = await this.db().oneOrNull<{
        id: number | null;
        rows: number;
      }>(
        `select max(id) as id, count(*) as \`rows\` from (
           select id from ${IDENTITY_NOTIFICATIONS_TABLE}
           where id > :after order by id limit ${Math.floor(batchSize)}
         ) batch`,
        { after },
        options
      );
      // Read after the batch (in the same snapshot under REPEATABLE READ,
      // so never below the batch's last id).
      const newest = Number(
        (
          await this.db().oneOrNull<{ id: number | null }>(
            `select max(id) as id from ${IDENTITY_NOTIFICATIONS_TABLE}`,
            undefined,
            options
          )
        )?.id ?? 0
      );
      const tail = Math.max(0, newest - tailIds);
      if (!last?.id) {
        // Nothing above the cursor. A cursor still above the tail (left there
        // by an older run, or the rows above it were deleted) moves back to
        // it, and the run goes on from there.
        if (after > tail) {
          await this.cursors.set(OLD_ROWS_CURSOR, String(tail), connection);
          return { rows: 0, done: false };
        }
        return { rows: 0, done: true };
      }
      const upTo = Number(last.id);
      // A batch that reaches the newest row is the run's last, even when it
      // is full: that saves an empty pass.
      const done = Number(last.rows) < batchSize || upTo >= newest;
      // source_key is notificationSourceKey(CARRIED_FAMILY, id, identity_id),
      // computed in SQL so a batch is one statement.
      const result = await this.db().execute(
        `insert ignore into ${NOTIFICATION_VIEW_TABLE} (
           identity_id, source_key, id, source_family, source_ref, origin,
           legacy_id, additional_identity_id, related_drop_id,
           related_drop_part_no, related_drop_2_id, related_drop_2_part_no,
           cause, additional_data, created_at, read_at,
           visibility_group_id, wave_id, sealed
         )
         select n.identity_id,
           sha2(concat_ws(char(0 using utf8mb4), :domain, :family,
             cast(n.id as char), n.identity_id), 256),
           n.id, :family, cast(n.id as char), :origin,
           n.id, n.additional_identity_id, n.related_drop_id,
           n.related_drop_part_no, n.related_drop_2_id, n.related_drop_2_part_no,
           n.cause, n.additional_data, n.created_at, n.read_at,
           n.visibility_group_id, n.wave_id, false
         from ${IDENTITY_NOTIFICATIONS_TABLE} n
         left join ${NOTIFICATION_VIEW_TABLE} v on v.legacy_id = n.id
         where n.id > :after and n.id <= :upTo and v.identity_id is null`,
        {
          after,
          upTo,
          domain: NOTIFICATION_SOURCE_KEY_DOMAIN,
          family: CARRIED_FAMILY,
          origin: NotificationViewOrigin.CARRIED
        },
        options
      );
      // The run's last pass leaves the cursor at the tail, so the next run
      // reads the newest ids again; rows the view has are skipped.
      await this.cursors.set(
        OLD_ROWS_CURSOR,
        String(done ? Math.min(upTo, tail) : upTo),
        connection
      );
      return { rows: this.db().getAffectedRows(result), done };
    });
  }

  private requireViewMode() {
    if (notifyViewMode() === 'off') {
      throw new Error('Set NOTIFY_VIEW_MODE to shadow or on before the switch');
    }
  }
}

export const notificationViewSwitch = new NotificationViewSwitch(
  dbSupplier,
  notificationViewCursorsDb
);
