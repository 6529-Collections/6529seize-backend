import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { anonymousCompetitionEntrySql } from '@/competitions/competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DbPoolName } from '@/db-query.options';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';

export interface AnonymousNotificationActorReference {
  readonly cause?: string;
  readonly related_drop_id?: string | null;
  readonly additional_identity_id: string | null;
}

export interface NotificationActorWriteOptions {
  /** Trusted writer-only: membership is inserted later in the same transaction. */
  readonly allowPendingCompetitionEntry?: boolean;
}

export const ANONYMOUS_COMPETITION_AUTHOR_CAUSES: readonly string[] = [
  IdentityNotificationCause.IDENTITY_MENTIONED,
  IdentityNotificationCause.DROP_QUOTED,
  IdentityNotificationCause.DROP_REPLIED,
  IdentityNotificationCause.ALL_DROPS,
  IdentityNotificationCause.PRIORITY_ALERT
];

export function anonymousNotificationActorDropId(notification: {
  readonly cause?: string;
  readonly related_drop_id?: string | null;
}): string | null {
  return notification.cause &&
    ANONYMOUS_COMPETITION_AUTHOR_CAUSES.includes(notification.cause)
    ? (notification.related_drop_id ?? null)
    : null;
}

/** Actor must actually be the unrevealed submitter, never a voter or reactor. */
export function anonymousNotificationActorSql(
  notificationAlias: string
): string {
  return `(${notificationAlias}.cause in (${ANONYMOUS_COMPETITION_AUTHOR_CAUSES.map((cause) => `'${cause}'`).join(',')})
    and exists (
      select 1 from ${COMPETITION_ENTRIES_TABLE} anonymous_notification_entry
      join ${COMPETITIONS_TABLE} anonymous_notification_competition
        on anonymous_notification_competition.id = anonymous_notification_entry.competition_id
      where anonymous_notification_entry.drop_id = ${notificationAlias}.related_drop_id
        and anonymous_notification_entry.submitter_id = ${notificationAlias}.additional_identity_id
        and ${anonymousCompetitionEntrySql('anonymous_notification_entry', 'anonymous_notification_competition')}
    ))`;
}

export async function findAnonymousNotificationActorPairs(
  notifications: readonly AnonymousNotificationActorReference[],
  db: SqlExecutor,
  connection?: ConnectionWrapper<unknown>,
  options: NotificationActorWriteOptions = {}
): Promise<Set<string>> {
  const dropIds = Array.from(
    new Set(
      notifications.flatMap((notification) => {
        const dropId = anonymousNotificationActorDropId(notification);
        return dropId ? [dropId] : [];
      })
    )
  );
  if (!dropIds.length) return new Set();
  const pending =
    connection && options.allowPendingCompetitionEntry
      ? `union all select d.id as drop_id, d.author_id as submitter_id
       from ${DROPS_TABLE} d where d.id in (:dropIds) and d.drop_type = 'COMPETITION'
       and not exists (select 1 from ${COMPETITION_ENTRIES_TABLE} existing where existing.drop_id = d.id)`
      : '';
  const rows = await db.execute<{ drop_id: string; submitter_id: string }>(
    `select entry.drop_id, entry.submitter_id from ${COMPETITION_ENTRIES_TABLE} entry
     join ${COMPETITIONS_TABLE} competition on competition.id = entry.competition_id
     where entry.drop_id in (:dropIds) and ${anonymousCompetitionEntrySql('entry', 'competition')}
     ${pending}`,
    { dropIds },
    { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
  );
  return new Set(rows.map((row) => `${row.drop_id}:${row.submitter_id}`));
}
