import {
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { Logger } from '@/logging';

/**
 * How far notifications have moved to the view. Read on every call from the
 * process environment, which the API and loops load from their configuration
 * when an instance starts.
 *
 * - `off` (default): today. Nothing writes or reads notification_view.
 * - `shadow`: the deriver writes notification_view for comparison. Readers,
 *   badges and pushes use identity_notifications.
 * - `on`: readers and badges use notification_view. Mark-read changes go to
 *   both tables while NOTIFY_LEGACY_OUTPUT keeps identity_notifications
 *   current, so `shadow` is a one-step rollback.
 */
export type NotifyViewMode = 'off' | 'shadow' | 'on';

export function notifyViewMode(): NotifyViewMode {
  const value = (process.env.NOTIFY_VIEW_MODE ?? '').trim().toLowerCase();
  if (value === 'shadow' || value === 'on') return value;
  return 'off';
}

const CAUSES: ReadonlySet<string> = new Set(
  Object.values(IdentityNotificationCause)
);

const logger = Logger.get('NOTIFY_VIEW_FLAGS');
let reportedValue: string | undefined;

/**
 * The causes a production feed adapter derives. A cause joins with its
 * adapter; a derived cause outside this set has its old writer skipped and
 * nothing writing it, which is reported.
 */
export const CAUSES_WITH_FEEDS: ReadonlySet<IdentityNotificationCause> =
  new Set<IdentityNotificationCause>([]);

/**
 * NOTIFY_DERIVED_CAUSES: comma-separated `CAUSE@cutMs`. From its cut
 * (milliseconds since the epoch) a cause comes from the deriver and its old
 * writers are skipped; before it, the old writers' rows stand. Old writers
 * compare the cut with the time they write, the deriver with the event's
 * time, so each event is written by exactly one. The cut is required: a
 * cause whose old writer has written rows would otherwise be written twice
 * for the same events. Ignored while the mode is `off`, so `off` restores
 * every old writer. An item without a cut, with an unknown name or with a
 * malformed cut is ignored, so its old writer keeps writing, and reported
 * once per value.
 */
export function derivedCauseCuts(): ReadonlyMap<
  IdentityNotificationCause,
  number
> {
  const cuts = new Map<IdentityNotificationCause, number>();
  if (notifyViewMode() === 'off') return cuts;
  const value = process.env.NOTIFY_DERIVED_CAUSES ?? '';
  const rejected: string[] = [];
  for (const item of value.split(',')) {
    if (!item.trim()) continue;
    const [rawCause, rawCut, extra] = item.trim().split('@');
    const cause = rawCause.trim().toUpperCase();
    const cut = Number(rawCut?.trim() || NaN);
    if (
      extra === undefined &&
      CAUSES.has(cause) &&
      Number.isSafeInteger(cut) &&
      cut >= 0
    ) {
      cuts.set(cause as IdentityNotificationCause, cut);
    } else {
      rejected.push(item.trim());
    }
  }
  if (reportedValue !== value) {
    reportedValue = value;
    if (rejected.length) {
      logger.error(
        `[NOTIFY_DERIVED_CAUSES_IGNORED] ${rejected.join(', ')}: each item must be CAUSE@cutMs; their old writers keep writing`
      );
    }
    const feedless = Array.from(cuts.keys()).filter(
      (cause) => !CAUSES_WITH_FEEDS.has(cause)
    );
    if (feedless.length) {
      logger.error(
        `[NOTIFY_DERIVED_CAUSE_WITHOUT_FEED] ${feedless.join(', ')}: their old writers are skipped and no feed derives them`
      );
    }
  }
  return cuts;
}

export function derivedCauses(): ReadonlySet<IdentityNotificationCause> {
  return new Set(derivedCauseCuts().keys());
}

/** Whether the deriver owns this cause at this time (now, by default). */
export function isDerivedCause(
  cause: IdentityNotificationCause,
  atMs: number = Date.now()
): boolean {
  const cut = derivedCauseCuts().get(cause);
  return cut !== undefined && atMs >= cut;
}

/**
 * NOTIFY_LEGACY_OUTPUT (default on): the deriver also writes derived causes
 * into identity_notifications, so that table stays complete for the readers
 * in `shadow` and for a rollback from `on`. Set `false` only after the
 * rebuild check passes.
 */
export function legacyOutputEnabled(): boolean {
  return process.env.NOTIFY_LEGACY_OUTPUT !== 'false';
}

/** Whether the deriver writes identity_notifications for this row. */
export function writesLegacyCopy(
  cause: IdentityNotificationCause,
  createdAt: number
): boolean {
  const mode = notifyViewMode();
  if (mode === 'off' || !isDerivedCause(cause, createdAt)) return false;
  return mode === 'shadow' || legacyOutputEnabled();
}

/**
 * Whether the deriver writes notification_view for this row: every rule's
 * rows in `shadow`, for comparison; in `on`, only rows the deriver owns, as
 * copies of the old writers' rows stand for the rest.
 */
export function writesViewRow(
  cause: IdentityNotificationCause,
  createdAt: number
): boolean {
  const mode = notifyViewMode();
  if (mode === 'shadow') return true;
  return mode === 'on' && isDerivedCause(cause, createdAt);
}

/** The table notification readers, badges and mark-read use. */
export function notificationsReadTable(): string {
  return notifyViewMode() === 'on'
    ? NOTIFICATION_VIEW_TABLE
    : IDENTITY_NOTIFICATIONS_TABLE;
}
