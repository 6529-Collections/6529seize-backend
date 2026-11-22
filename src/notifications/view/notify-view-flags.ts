import {
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';

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

/**
 * NOTIFY_DERIVED_CAUSES: comma-separated causes the deriver produces. Their
 * old writers are skipped. Ignored while the mode is `off`, so turning the
 * mode off always restores every old writer. Unknown names are ignored.
 */
export function derivedCauses(): ReadonlySet<IdentityNotificationCause> {
  if (notifyViewMode() === 'off') return new Set();
  const raw = process.env.NOTIFY_DERIVED_CAUSES ?? '';
  return new Set(
    raw
      .split(',')
      .map((cause) => cause.trim().toUpperCase())
      .filter((cause): cause is IdentityNotificationCause => CAUSES.has(cause))
  );
}

export function isDerivedCause(cause: IdentityNotificationCause): boolean {
  return derivedCauses().has(cause);
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

/** Whether the deriver writes identity_notifications for this cause now. */
export function writesLegacyCopy(cause: IdentityNotificationCause): boolean {
  const mode = notifyViewMode();
  if (mode === 'off' || !isDerivedCause(cause)) return false;
  return mode === 'shadow' || legacyOutputEnabled();
}

/** The table notification readers, badges and mark-read use. */
export function notificationsReadTable(): string {
  return notifyViewMode() === 'on'
    ? NOTIFICATION_VIEW_TABLE
    : IDENTITY_NOTIFICATIONS_TABLE;
}
